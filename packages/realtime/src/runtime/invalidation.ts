import { onDatabaseDependencyInvalidated } from '@holo-js/db'
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
  collectQueryEntriesForParsedInvalidation,
  collectQueryEntriesForParsedInvalidations,
} from './subscription-index'
import type {
  RealtimeQueryDefinitionMetadata,
} from '../contracts'

export function ensureDatabaseSubscription(): void {
  const state = getRuntimeState()
  state.unsubscribeFromDatabase ??= onDatabaseDependencyInvalidated(handleBatchedDatabaseInvalidation)
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
    const result = await executeRealtimeQueryInternal(
      entry.definition,
      entry.args,
      entry.executionOptions,
    )
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
  if (await tryPatchQueryEntry(entry, backfills)) {
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

export async function handleDatabaseInvalidation(
  event: DatabaseDependencyInvalidationEventWithMutations,
  events?: readonly DatabaseDependencyInvalidationEventWithMutations[],
): Promise<void> {
  if (getRuntimeState().queryEntries.size === 0) {
    return
  }

  if (!events) {
    const parsedEvent = parseInvalidationEvent(event)
    const entries = collectQueryEntriesForParsedInvalidation(parsedEvent)
    const firstEntry = entries[0]
    if (!firstEntry) {
      return
    }

    const backfills: BackfillCache = {
      aggregates: new Map(),
      aggregateGroupedSql: new Map(),
      aggregateSql: new Map(),
      entries,
      exactPredicates: readExactPredicatesForPatching(parsedEvent),
      groupedAggregateValueCounts: new Map(),
      groupedAggregateValues: new Map(),
      mutationExactPredicates: createMutationExactPredicatesForPatching([parsedEvent]),
      mutationMetadata: new WeakMap(),
      mutations: createSingleEventMutationIndex(parsedEvent),
      paginationGroupedCounts: new Map(),
      paginationCounts: new Map(),
      rowGroups: new Map(),
      rows: new Map(),
    }

    await refreshInvalidatedQueryEntries(firstEntry, entries.slice(1), backfills)
    return
  }

  const parsedEvents: ParsedInvalidationEvent[] = []
  for (const invalidationEvent of events) {
    parsedEvents.push(parseInvalidationEvent(invalidationEvent))
  }

  const entries = collectQueryEntriesForParsedInvalidations(parsedEvents)
  const firstEntry = entries[0]
  if (!firstEntry) {
    return
  }

  const parsedEvent = parsedEvents.length === 1 ? parsedEvents[0] : undefined
  const backfills: BackfillCache = {
    aggregates: new Map(),
    aggregateGroupedSql: new Map(),
    aggregateSql: new Map(),
    entries,
    exactPredicates: parsedEvent
      ? readExactPredicatesForPatching(parsedEvent)
      : createBatchedExactPredicatesForPatching(parsedEvents),
    groupedAggregateValueCounts: new Map(),
    groupedAggregateValues: new Map(),
    mutationExactPredicates: createMutationExactPredicatesForPatching(parsedEvents),
    mutationMetadata: new WeakMap(),
    mutations: parsedEvent ? createSingleEventMutationIndex(parsedEvent) : createMutationIndex(parsedEvents),
    paginationGroupedCounts: new Map(),
    paginationCounts: new Map(),
    rowGroups: new Map(),
    rows: new Map(),
  }

  await refreshInvalidatedQueryEntries(firstEntry, entries.slice(1), backfills)
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
