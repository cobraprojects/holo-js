import { reportError } from '@holo-js/kernel/error-reporting'
import { onDatabaseDependencyInvalidated, queryCacheInternals } from '@holo-js/db'
import {
  EMPTY_TABLE_DEPENDENCIES,
  parseDatabaseDependency,
  readDatabaseDependencyInvalidationMetadata,
  createMutationIndex,
  createSingleEventMutationIndex,
  parseInvalidationEvent,
  type DatabaseDependencyInvalidationEventWithMutations,
  type DatabaseMutationEvent,
  type ParsedInvalidationEvent,
  type PredicateDependencyIndex,
} from './dependencies'
import {
  deliverRefreshData,
  deliverRefreshError,
} from './delivery'
import { tryPatchQueryEntry } from './patch-delivery'
import { executeRealtimeQueryInternal } from './query-execution'
import { createResultHash } from './result-hash'
import {
  createDeferred,
  getRuntimeState,
  type ActiveQueryEntry,
  type ActiveRefresh,
  type ActiveSubscription,
  type BackfillCache,
  type PendingInvalidationBatch,
  type RefreshDelivery,
} from './state'
import {
  collectQueryEntriesForParsedInvalidations,
} from './subscription-index'
import type {
  RealtimeQueryDefinitionMetadata,
} from '../contracts'

export function ensureDatabaseSubscription(): void {
  const state = getRuntimeState()
  if (state.unsubscribeFromDatabase) return
  state.unsubscribeFromDatabase = onDatabaseDependencyInvalidated(handleBatchedDatabaseInvalidation)
  queryCacheInternals.setMutationPreviousRowsRequirement(handleBatchedDatabaseInvalidation, requiresMutationPreviousRows)
}

function requiresMutationPreviousRows(connectionName: string, tableName: string, columns: readonly string[]): boolean {
  const state = getRuntimeState()
  const tableKey = queryCacheInternals.createTableCacheDependency(connectionName, tableName)
  const entries = new Set(state.tableBroadSubscribers.get(tableKey))
  for (const keys of state.tablePredicateColumnSubscribers.get(tableKey)?.values() ?? []) {
    for (const key of keys) entries.add(key)
  }
  for (const key of entries) {
    for (const query of state.queryEntries.get(key)?.queries ?? []) {
      if (query.connectionName !== connectionName || query.tableName !== tableName || (!query.aggregate && !query.groupedAggregate)) continue
      const aggregateColumn = query.aggregate?.column ?? query.groupedAggregate?.aggregateColumn
      if (columns.some(column => column === aggregateColumn || column === query.groupedAggregate?.groupColumn || query.predicates.some(predicate => predicate.column === column))) return true
    }
  }
  return false
}

function readExactPredicatesForPatching(event: ParsedInvalidationEvent): PredicateDependencyIndex | undefined {
  return event.hasMutationDependency || event.exactPredicates.size === 0
    ? undefined
    : event.exactPredicates
}

function addExactPredicateDependencies(
  merged: PredicateDependencyIndex,
  predicates: PredicateDependencyIndex,
): void {
  for (const [tableKey, tablePredicates] of predicates) {
    const mergedTablePredicates = merged.get(tableKey) ?? new Map<string, Set<string>>()
    for (const [columnName, values] of tablePredicates) {
      const mergedValues = mergedTablePredicates.get(columnName) ?? new Set<string>()
      for (const value of values) {
        mergedValues.add(value)
      }
      mergedTablePredicates.set(columnName, mergedValues)
    }
    merged.set(tableKey, mergedTablePredicates)
  }
}

function createBatchedExactPredicatesForPatching(
  events: readonly ParsedInvalidationEvent[],
): PredicateDependencyIndex | undefined {
  const merged: PredicateDependencyIndex = new Map()
  for (const event of events) {
    const exactPredicates = readExactPredicatesForPatching(event)
    if (!exactPredicates) {
      return undefined
    }

    addExactPredicateDependencies(merged, exactPredicates)
  }

  return merged
}

function createMutationExactPredicatesForPatching(
  events: readonly ParsedInvalidationEvent[],
): WeakMap<DatabaseMutationEvent, PredicateDependencyIndex> | undefined {
  let predicatesByMutation: WeakMap<DatabaseMutationEvent, PredicateDependencyIndex> | undefined
  for (const event of events) {
    const exactPredicates = readExactPredicatesForPatching(event)
    if (!exactPredicates) {
      continue
    }

    for (const mutation of event.mutations) {
      predicatesByMutation ??= new WeakMap()
      predicatesByMutation.set(mutation, exactPredicates)
    }
  }

  return predicatesByMutation
}

async function refreshQueryEntry(refreshKey: string): Promise<void> {
  const entry = getRuntimeState().queryEntries.get(refreshKey)
  if (!entry) {
    return
  }

  try {
    const result = await entry.runWithContext(async () => await executeRealtimeQueryInternal(
      entry.definition,
      entry.args,
    ))
    entry.contexts = new Map(result.contexts)
    const delivery = {
      result,
      resultHash: createResultHash(result.data),
    } satisfies RefreshDelivery<typeof entry.definition>
    await deliverRefreshData(entry, delivery)
  } catch (error) {
    await deliverRefreshError(entry, error)
  }
}

async function drainRefresh(refreshKey: string, refresh: ActiveRefresh): Promise<void> {
  try {
    do {
      refresh.pending = false
      await refreshQueryEntry(refreshKey)
    } while (refresh.pending)
  } finally {
    refresh.running = undefined
    if (!refresh.pending) {
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
    return refresh.running
  }

  refresh.running = drainRefresh(refreshKey, refresh)
  return refresh.running
}

export function scheduleSubscriptionRefresh(
  subscription: ActiveSubscription<RealtimeQueryDefinitionMetadata>,
): Promise<void> {
  return scheduleRefreshKey(subscription.refreshKey)
}

async function refreshInvalidatedQueryEntry(
  entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
  backfills: BackfillCache,
): Promise<void> {
  if (await entry.runWithContext(async () => await tryPatchQueryEntry(entry, backfills))) {
    return
  }

  await scheduleRefreshKey(entry.refreshKey)
}

async function refreshInvalidatedQueryEntries(
  firstEntry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
  remainingEntries: readonly ActiveQueryEntry<RealtimeQueryDefinitionMetadata>[],
  backfills: BackfillCache,
): Promise<void> {
  const firstRefresh = refreshInvalidatedQueryEntry(firstEntry, backfills)
  let refreshes: Promise<void>[] | undefined
  for (const entry of remainingEntries) {
    const refresh = refreshInvalidatedQueryEntry(entry, backfills)
    refreshes ??= [firstRefresh]
    refreshes.push(refresh)
  }

  if (refreshes) {
    await Promise.all(refreshes)
    return
  }

  await firstRefresh
}

function createInvalidationBackfills(
  events: readonly ParsedInvalidationEvent[],
  entries: readonly ActiveQueryEntry<RealtimeQueryDefinitionMetadata>[],
): BackfillCache {
  const event = events.length === 1 ? events[0] : undefined
  return {
    aggregates: new Map(),
    aggregateGroupedSql: new Map(),
    aggregateSql: new Map(),
    entries,
    exactPredicates: event ? readExactPredicatesForPatching(event) : createBatchedExactPredicatesForPatching(events),
    groupedAggregateValueCounts: new Map(),
    groupedAggregateValues: new Map(),
    mutationExactPredicates: createMutationExactPredicatesForPatching(events),
    mutationMetadata: new WeakMap(),
    mutations: event ? createSingleEventMutationIndex(event) : createMutationIndex(events),
    paginationGroupedCounts: new Map(),
    paginationCounts: new Map(),
    rowGroups: new Map(),
    rows: new Map(),
  }
}

async function refreshParsedInvalidations(events: readonly ParsedInvalidationEvent[]): Promise<void> {
  const entries = collectQueryEntriesForParsedInvalidations(events)
  const databases = new Map<number, ActiveQueryEntry<RealtimeQueryDefinitionMetadata>[]>()
  const reruns: Promise<void>[] = []
  for (const entry of entries) {
    if ([...entry.contexts.values()].some(contexts => contexts.size !== 1 || !contexts.has(entry.contextId))) {
      reruns.push(scheduleRefreshKey(entry.refreshKey))
      continue
    }
    const group = databases.get(entry.contextId) ?? []
    group.push(entry)
    databases.set(entry.contextId, group)
  }
  await Promise.all([...reruns, ...[...databases.values()].map(async (group) => {
    const first = group[0]
    if (!first) return
    await refreshInvalidatedQueryEntries(first, group.slice(1), createInvalidationBackfills(events, group))
  })])
}

const REMOTE_REFRESH_CONCURRENCY = 4
const REMOTE_REFRESH_MIN_INTERVAL_MS = 100
let activeRemoteRefreshes = 0
let remoteRefreshGeneration = 0
const remoteRefreshWaiters: Array<(acquired: boolean) => void> = []
const queuedRemoteRefreshKeys = new Set<string>()
const remoteRefreshLastRunAt = new Map<string, number>()
const remoteRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function resetRemoteRefreshSchedule(): void {
  remoteRefreshGeneration += 1
  activeRemoteRefreshes = 0
  for (const waiter of remoteRefreshWaiters.splice(0)) {
    waiter(false)
  }
  for (const timer of remoteRefreshTimers.values()) {
    clearTimeout(timer)
  }
  remoteRefreshTimers.clear()
  remoteRefreshLastRunAt.clear()
  queuedRemoteRefreshKeys.clear()
}

function acquireRemoteRefreshSlot(): Promise<boolean> {
  if (activeRemoteRefreshes < REMOTE_REFRESH_CONCURRENCY) {
    activeRemoteRefreshes += 1
    return Promise.resolve(true)
  }

  return new Promise<boolean>(resolve => remoteRefreshWaiters.push(resolve))
}

function releaseRemoteRefreshSlot(generation: number): void {
  if (generation !== remoteRefreshGeneration) {
    return
  }

  const next = remoteRefreshWaiters.shift()
  if (next) {
    next(true)
    return
  }

  activeRemoteRefreshes -= 1
}

async function refreshRemoteEntry(refreshKey: string): Promise<void> {
  const running = getRuntimeState().refreshes.get(refreshKey)
  if (running?.running) {
    running.pending = true
    queuedRemoteRefreshKeys.delete(refreshKey)
    return
  }

  const generation = remoteRefreshGeneration
  const acquired = await acquireRemoteRefreshSlot()
  if (!acquired) {
    return
  }

  if (generation === remoteRefreshGeneration) {
    queuedRemoteRefreshKeys.delete(refreshKey)
  }
  if (!getRuntimeState().queryEntries.has(refreshKey)) {
    remoteRefreshLastRunAt.delete(refreshKey)
    releaseRemoteRefreshSlot(generation)
    return
  }

  remoteRefreshLastRunAt.set(refreshKey, Date.now())
  try {
    await scheduleRefreshKey(refreshKey)
  } finally {
    releaseRemoteRefreshSlot(generation)
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

  const refreshes: Promise<void>[] = []
  for (const refreshKey of refreshKeys) {
    if (remoteRefreshTimers.has(refreshKey)) {
      continue
    }

    const now = Date.now()
    const lastRunAt = remoteRefreshLastRunAt.get(refreshKey)
    if (lastRunAt !== undefined && now - lastRunAt < REMOTE_REFRESH_MIN_INTERVAL_MS) {
      scheduleDeferredRemoteRefresh(refreshKey, lastRunAt + REMOTE_REFRESH_MIN_INTERVAL_MS - now)
      continue
    }

    if (queuedRemoteRefreshKeys.has(refreshKey)) {
      continue
    }

    queuedRemoteRefreshKeys.add(refreshKey)
    refreshes.push(refreshRemoteEntry(refreshKey))
  }

  await Promise.all(refreshes)
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

export async function handleBatchedDatabaseInvalidation(
  event: DatabaseDependencyInvalidationEventWithMutations,
): Promise<void> {
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
