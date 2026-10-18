import { onDatabaseDependencyInvalidated, queryCacheInternals } from '@holo-js/db'
import {
  EMPTY_TABLE_DEPENDENCIES,
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
      entry.executionOptions,
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
    const event = batch.events[0]
    if (batch.events.length === 1 && event) {
      await handleDatabaseInvalidation(event)
    } else {
      await handleDatabaseInvalidation({
        connectionName: '',
        dependencies: EMPTY_TABLE_DEPENDENCIES,
      }, batch.events)
    }
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
