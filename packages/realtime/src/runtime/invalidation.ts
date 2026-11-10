import { AsyncLocalStorage } from 'node:async_hooks'
import { reportError } from '@holo-js/kernel/error-reporting'
import { onDatabaseDependencyInvalidated, queryCacheInternals } from '@holo-js/db'
import {
  EMPTY_TABLE_DEPENDENCIES,
  parseDatabaseDependency,
  readDatabaseDependencyInvalidationMetadata,
  parseInvalidationEvent,
  type DatabaseDependencyInvalidationEventWithMutations,
  type ParsedInvalidationEvent,
} from './dependencies'
import {
  deliverRefreshData,
  deliverRefreshError,
} from './delivery'
import { createReplacePatchOperations } from './patch-operations'
import { applyWireSnapshotPatch, parseWireSnapshotPatch } from '../client/patching'
import { executeRealtimeQueryInternal } from './query-execution'
import { createResultHash } from './result-hash'
import {
  createDeferred,
  getRuntimeState,
  hasPendingQuerySchemaChanges,
  type ActiveQueryEntry,
  type ActiveRefresh,
  type ActiveSubscription,
  type PendingInvalidationBatch,
  type RefreshDelivery,
} from './state'
import {
  collectQueryEntriesForParsedInvalidations,
} from './subscription-index'
import type {
  RealtimeQueryDefinitionMetadata,
} from '../contracts'

const MAX_REFRESH_PATCH_OPERATIONS = 64

export function ensureDatabaseSubscription(): void {
  const state = getRuntimeState()
  if (state.unsubscribeFromDatabase) return
  state.unsubscribeFromDatabase = onDatabaseDependencyInvalidated(handleBatchedDatabaseInvalidation)
}

async function refreshQueryEntry(refreshKey: string): Promise<void> {
  const entry = getRuntimeState().queryEntries.get(refreshKey)
  if (!entry) {
    return
  }

  if (hasPendingQuerySchemaChanges(entry)) return
  const schemaGeneration = queryCacheInternals.currentSchemaGeneration()
  const generation = refreshGeneration
  const isCurrent = () => generation === refreshGeneration && getRuntimeState().queryEntries.get(refreshKey) === entry
  const fail = async (error: unknown) => {
    if (!isCurrent()) return
    entry.refreshFailed = true
    await deliverRefreshError(entry, error)
  }
  try {
    if (deferRefreshUntilSessionRelease(entry)) return
    await entry.runWithContext(async () => {
      try {
        if (!isCurrent()) return
        if (!await acquireRefreshSlot()) return
        let result: Awaited<ReturnType<typeof executeRealtimeQueryInternal>>
        const execution = { generation, active: true }
        try {
          if (!isCurrent()) return
          if (queuedRemoteRefreshKeys.delete(refreshKey)) remoteRefreshLastRunAt.set(refreshKey, Date.now())
          result = await refreshExecution.run(execution, async () => await executeRealtimeQueryInternal(
            entry.definition,
            entry.args,
            undefined,
            () => { if (!isCurrent()) throw new Error('Realtime refresh is no longer active.') },
          ))
        } finally {
          execution.active = false
          releaseRefreshSlot(generation)
        }
        if (!isCurrent()) return
        if (schemaGeneration !== queryCacheInternals.currentSchemaGeneration() || hasPendingQuerySchemaChanges(entry)) {
          const refresh = getRuntimeState().refreshes.get(refreshKey)
          if (refresh && !hasPendingQuerySchemaChanges(entry)) refresh.pending = true
          return
        }
        entry.schemaGeneration = schemaGeneration
        entry.contexts = new Map(result.contexts)
        const resultHash = createResultHash(result.data)
        let delivery: RefreshDelivery<typeof entry.definition> = { result, resultHash }
        try {
          const current = entry.current
          const patchOperations = current
            ? createReplacePatchOperations([], current.data, result.data, entry.queries[0]?.primaryKey ?? 'id', true)
            : undefined
          const patch = (patchOperations?.length ?? 0) > MAX_REFRESH_PATCH_OPERATIONS || patchOperations?.some(operation => 'valueKind' in operation && operation.path.length > 0)
            ? undefined
            : parseWireSnapshotPatch({ operations: patchOperations, version: entry.version + 1 })
          const data = current && patch ? applyWireSnapshotPatch(current, patch).data : result.data
          if (patch && createResultHash(data) === resultHash) {
            delivery = { patchOperations, result: { ...result, data }, resultHash }
          }
        } catch {
          delivery = { result, resultHash }
        }
        entry.refreshFailed = false
        await deliverRefreshData(entry, delivery)
      } catch (error) {
        await fail(error)
      }
    })
  } catch (error) {
    await entry.runWithContext.runWithAuth(() => fail(error))
  }
}

async function drainRefresh(refreshKey: string, refresh: ActiveRefresh): Promise<void> {
  try {
    do {
      refresh.pending = false
      await refreshQueryEntry(refreshKey)
    } while (refresh.pending && getRuntimeState().refreshes.get(refreshKey) === refresh)
  } finally {
    refresh.running = undefined
    if (!refresh.pending && getRuntimeState().refreshes.get(refreshKey) === refresh) {
      getRuntimeState().refreshes.delete(refreshKey)
    }
  }
}

function scheduleRefreshKey(refreshKey: string): Promise<void> {
  const state = getRuntimeState()
  const refresh = state.refreshes.get(refreshKey) ?? {
    pending: false,
  }
  state.refreshes.set(refreshKey, refresh)

  if (refresh.running) {
    refresh.pending = true
    return Promise.resolve()
  }

  refresh.running = refreshExecution.exit(() => drainRefresh(refreshKey, refresh))
  return refresh.running
}

export function scheduleSubscriptionRefresh(
  subscription: ActiveSubscription<RealtimeQueryDefinitionMetadata>,
): Promise<void> {
  return scheduleRefreshKey(subscription.refreshKey)
}

function deferRefreshUntilSessionRelease(entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>): boolean {
  return queryCacheInternals.deferPooledDatabaseSessionRefresh(entry.runWithContext, async () => {
    try {
      await scheduleRefreshKey(entry.refreshKey)
    } catch (error) {
      reportError(error, { capability: 'realtime', operation: 'subscription.refresh' })
    }
  })
}

async function refreshParsedInvalidations(events: readonly ParsedInvalidationEvent[]): Promise<void> {
  await Promise.all(collectQueryEntriesForParsedInvalidations(events).map(entry => scheduleRefreshKey(entry.refreshKey)))
}

const refreshExecution = new AsyncLocalStorage<{ readonly generation: number, active: boolean }>()
const REFRESH_CONCURRENCY = 4
const REMOTE_REFRESH_MIN_INTERVAL_MS = 100
let activeRefreshes = 0
let refreshGeneration = 0
const refreshWaiters: Array<(acquired: boolean) => void> = []
const queuedRemoteRefreshKeys = new Set<string>()
const remoteRefreshLastRunAt = new Map<string, number>()
const remoteRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
const tableInvalidationGenerations = new Map<string, number>()
const initialRefreshRequests = new Set<string>()

export function snapshotTableInvalidationGenerations(): ReadonlyMap<string, number> {
  return new Map(tableInvalidationGenerations)
}

export function hasTableInvalidationSince(
  snapshot: ReadonlyMap<string, number>,
  dependencies: readonly string[],
): boolean {
  return dependencies.some(dependency => {
    const tableKey = parseDatabaseDependency(dependency)?.tableKey
    return tableKey !== undefined && (tableInvalidationGenerations.get(tableKey) ?? 0) !== (snapshot.get(tableKey) ?? 0)
  })
}

export function requestInitialRefresh(refreshKey: string): void {
  initialRefreshRequests.add(refreshKey)
}

export function takeInitialRefreshRequest(refreshKey: string): boolean {
  return initialRefreshRequests.delete(refreshKey)
}

export function forgetRemoteRefreshSchedule(refreshKey: string): void {
  const timer = remoteRefreshTimers.get(refreshKey)
  if (timer !== undefined) {
    clearTimeout(timer)
    remoteRefreshTimers.delete(refreshKey)
  }
  remoteRefreshLastRunAt.delete(refreshKey)
  queuedRemoteRefreshKeys.delete(refreshKey)
}

export function resetRemoteRefreshSchedule(): void {
  tableInvalidationGenerations.clear()
  initialRefreshRequests.clear()
  refreshGeneration += 1
  activeRefreshes = 0
  for (const waiter of refreshWaiters.splice(0)) {
    waiter(false)
  }
  for (const timer of remoteRefreshTimers.values()) {
    clearTimeout(timer)
  }
  remoteRefreshTimers.clear()
  remoteRefreshLastRunAt.clear()
  queuedRemoteRefreshKeys.clear()
}

function acquireRefreshSlot(): Promise<boolean> {
  if (activeRefreshes < REFRESH_CONCURRENCY) {
    activeRefreshes += 1
    return Promise.resolve(true)
  }

  return new Promise<boolean>(resolve => refreshWaiters.push(resolve))
}

function releaseRefreshSlot(generation: number): void {
  if (generation !== refreshGeneration) {
    return
  }

  const next = refreshWaiters.shift()
  if (next) {
    next(true)
    return
  }

  activeRefreshes -= 1
}

async function refreshRemoteEntry(refreshKey: string): Promise<void> {
  const generation = refreshGeneration
  const running = getRuntimeState().refreshes.get(refreshKey)?.running
  if (running) {
    await Promise.allSettled([running])
    if (generation !== refreshGeneration) {
      return
    }

    queuedRemoteRefreshKeys.delete(refreshKey)
    await requestRemoteRefresh(refreshKey)
    return
  }

  if (!getRuntimeState().queryEntries.has(refreshKey)) {
    queuedRemoteRefreshKeys.delete(refreshKey)
    remoteRefreshLastRunAt.delete(refreshKey)
    return
  }

  try {
    await scheduleRefreshKey(refreshKey)
  } finally {
    if (generation === refreshGeneration) queuedRemoteRefreshKeys.delete(refreshKey)
  }
}

function scheduleDeferredRemoteRefresh(refreshKey: string, delayMs: number): void {
  const timer = setTimeout(() => {
    remoteRefreshTimers.delete(refreshKey)
    if (queuedRemoteRefreshKeys.has(refreshKey)) {
      return
    }

    queuedRemoteRefreshKeys.add(refreshKey)
    refreshRemoteEntry(refreshKey).catch((error: unknown) => {
      reportError(error, { capability: 'realtime', operation: 'subscription.remoteRefresh' })
    })
  }, delayMs)
  remoteRefreshTimers.set(refreshKey, timer)
}

async function refreshSubscriptionsForRemoteTables(tableDependencies: readonly string[]): Promise<void> {
  const state = getRuntimeState()
  if (state.queryEntries.size === 0) {
    return
  }

  const tableKeys = new Set(tableDependencies)
  const refreshKeys = new Set<string>()
  for (const [dependency, entryKeys] of state.dependencySubscribers) {
    const tableKey = parseDatabaseDependency(dependency)?.tableKey
    if (tableKey === undefined || !tableKeys.has(tableKey)) {
      continue
    }

    for (const entryKey of entryKeys) {
      const entry = state.queryEntries.get(entryKey)
      if (entry) {
        refreshKeys.add(entry.refreshKey)
      }
    }
  }

  await Promise.all([...refreshKeys].map(requestRemoteRefresh))
}

async function requestRemoteRefresh(refreshKey: string): Promise<void> {
  if (remoteRefreshTimers.has(refreshKey)) {
    return
  }

  const now = Date.now()
  const lastRunAt = remoteRefreshLastRunAt.get(refreshKey)
  if (lastRunAt !== undefined && now - lastRunAt < REMOTE_REFRESH_MIN_INTERVAL_MS) {
    scheduleDeferredRemoteRefresh(refreshKey, lastRunAt + REMOTE_REFRESH_MIN_INTERVAL_MS - now)
    return
  }

  if (queuedRemoteRefreshKeys.has(refreshKey)) {
    return
  }

  queuedRemoteRefreshKeys.add(refreshKey)
  await refreshRemoteEntry(refreshKey)
}

export async function handleDatabaseInvalidation(
  event: DatabaseDependencyInvalidationEventWithMutations,
  events?: readonly DatabaseDependencyInvalidationEventWithMutations[],
): Promise<void> {
  if (getRuntimeState().queryEntries.size === 0) return
  if (!events || events.length === 1) {
    await refreshParsedInvalidations([parseInvalidationEvent(events?.[0] ?? event)])
    return
  }
  const databases = new Map<number | undefined, ParsedInvalidationEvent[]>()
  for (const invalidation of events) {
    const parsed = parseInvalidationEvent(invalidation)
    const group = databases.get(parsed.contextId) ?? []
    group.push(parsed)
    databases.set(parsed.contextId, group)
  }
  await Promise.all([...databases.values()].map(refreshParsedInvalidations))
}

async function flushInvalidationBatch(batch: PendingInvalidationBatch): Promise<void> {
  const state = getRuntimeState()
  if (state.invalidationBatch === batch) {
    state.invalidationBatch = undefined
  }

  try {
    const remoteEvents = batch.events.filter(event => readDatabaseDependencyInvalidationMetadata(event) === undefined)
    const localEvents = batch.events.filter(event => readDatabaseDependencyInvalidationMetadata(event) !== undefined)
    const localEvent = localEvents[0]
    await Promise.all([
      localEvents.length === 1 && localEvent
        ? handleDatabaseInvalidation(localEvent)
        : localEvents.length > 0
          ? handleDatabaseInvalidation({
              connectionName: '',
              dependencies: EMPTY_TABLE_DEPENDENCIES,
            }, localEvents)
          : undefined,
      remoteEvents.length > 0
        ? refreshSubscriptionsForRemoteTables(remoteEvents.flatMap(event => event.dependencies))
        : undefined,
    ])
    batch.deferred.resolve(undefined)
  } catch (error) {
    batch.deferred.reject(error)
  }
}

export function handleBatchedDatabaseInvalidation(
  event: DatabaseDependencyInvalidationEventWithMutations,
): Promise<void> {
  const execution = refreshExecution.getStore()
  const reentrant = execution?.active && execution.generation === refreshGeneration && activeRefreshes === REFRESH_CONCURRENCY
  return refreshExecution.exit(() => {
    const pending = enqueueDatabaseInvalidation(event)
    if (!reentrant) return pending
    void pending.catch((error: unknown) => {
      reportError(error, { capability: 'realtime', operation: 'subscription.refresh' })
    })
    return Promise.resolve()
  })
}

async function enqueueDatabaseInvalidation(
  event: DatabaseDependencyInvalidationEventWithMutations,
): Promise<void> {
  if (event.dependencies.includes(queryCacheInternals.databaseSchemaDependency)) {
    await Promise.all([...getRuntimeState().queryEntries.values()].map(entry => {
      if (!entry.current) { entry.refreshAfterInitialRead = true; return }
      return hasPendingQuerySchemaChanges(entry) ? undefined : scheduleRefreshKey(entry.refreshKey)
    }))
    return
  }
  for (const dependency of event.dependencies) {
    const tableKey = parseDatabaseDependency(dependency)?.tableKey
    if (tableKey !== undefined) {
      tableInvalidationGenerations.set(tableKey, (tableInvalidationGenerations.get(tableKey) ?? 0) + 1)
    }
  }
  const state = getRuntimeState()
  if (state.queryEntries.size === 0) {
    return
  }

  const batch = state.invalidationBatch
  if (batch) {
    batch.events.push(event)

    return await batch.deferred.promise
  }

  const deferred = createDeferred<void>()
  const nextBatch: PendingInvalidationBatch = {
    deferred,
    events: [event],
    timer: setTimeout(() => {
      void flushInvalidationBatch(nextBatch)
    }, 10),
  }
  state.invalidationBatch = nextBatch
  return await deferred.promise
}
