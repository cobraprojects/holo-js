import type {
  RealtimeQueryDefinitionMetadata,
  RealtimeArgsFor,
  RealtimeResultFor,
  RealtimeSubscriptionSnapshot,
} from '../contracts'
import { EMPTY_TABLE_DEPENDENCIES } from './dependencies'
import { executeInitialQuery } from './query-execution'
import {
  updateQueryEntryObservedQueries,
} from './query-patching'
import {
  getRuntimeState,
  type ActiveQueryEntry,
  type ActiveSubscription,
} from './state'
import {
  addQueryEntryDependencies,
  addQueryEntryInvalidationIndexes,
  removeQueryEntryDependencies,
  removeQueryEntryInvalidationIndexes,
} from './subscription-index'
import type { RealtimeExecutionOptions } from '../contracts'

export type InitializedActiveQueryEntry<TDefinition extends RealtimeQueryDefinitionMetadata> = ActiveQueryEntry<TDefinition> & {
  current: RealtimeSubscriptionSnapshot<RealtimeResultFor<TDefinition>>
}

export function detachDatabaseSubscriptionIfIdle(): void {
  const state = getRuntimeState()
  if (state.subscriptions.size > 0 || state.queryEntries.size > 0) {
    return
  }

  state.unsubscribeFromDatabase?.()
  state.unsubscribeFromDatabase = undefined
}

export async function resolveQueryEntry<TDefinition extends RealtimeQueryDefinitionMetadata>(
  definition: TDefinition,
  args: RealtimeArgsFor<TDefinition>,
  executionOptions: RealtimeExecutionOptions | undefined,
  refreshKey: string,
): Promise<InitializedActiveQueryEntry<TDefinition>> {
  const state = getRuntimeState()
  const existing = state.queryEntries.get(refreshKey) as ActiveQueryEntry<TDefinition> | undefined
  if (existing) {
    if (existing.initialQuery) {
      await existing.initialQuery
    }

    return existing as InitializedActiveQueryEntry<TDefinition>
  }

  const entry: ActiveQueryEntry<TDefinition> = {
    refreshKey,
    definition,
    args,
    executionOptions,
    patchFallbackSubscriberRefs: new Set<ActiveSubscription<TDefinition>>(),
    patchSubscriberRefs: new Set<ActiveSubscription<TDefinition>>(),
    snapshotSubscriberRefs: new Set<ActiveSubscription<TDefinition>>(),
    subscriberRefs: new Set<ActiveSubscription<TDefinition>>(),
    subscribers: new Set<string>(),
    dependencies: Object.freeze([]),
    patchTargets: [],
    predicateDependencies: new Map<string, Map<string, Set<string>>>(),
    queries: [],
    resultHash: '',
    resultHashDirty: false,
    tableDependencies: EMPTY_TABLE_DEPENDENCIES,
    version: 0,
  }
  const initialQuery = executeInitialQuery(definition, args, executionOptions)
  entry.initialQuery = initialQuery
  state.queryEntries.set(refreshKey, entry as ActiveQueryEntry<RealtimeQueryDefinitionMetadata>)

  try {
    const result = await initialQuery
    entry.dependencies = result.result.dependencies
    entry.predicateDependencies = result.predicateDependencies
    entry.resultHash = result.resultHash
    entry.resultHashDirty = false
    entry.tableDependencies = result.tableDependencies
    entry.version = 1
    entry.current = result.snapshot
    updateQueryEntryObservedQueries(
      entry as ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
      result.result.queries,
      result.snapshot.data,
    )
    entry.initialQuery = undefined
    addQueryEntryDependencies(entry as ActiveQueryEntry<RealtimeQueryDefinitionMetadata>)
    addQueryEntryInvalidationIndexes(entry as ActiveQueryEntry<RealtimeQueryDefinitionMetadata>)
    return entry as InitializedActiveQueryEntry<TDefinition>
  } finally {
    if (entry.initialQuery === initialQuery) {
      state.queryEntries.delete(refreshKey)
    }
  }
}

export function deleteSubscription(subscriptionId: string): void {
  const state = getRuntimeState()
  const subscription = state.subscriptions.get(subscriptionId)
  if (!subscription) {
    return
  }

  state.subscriptions.delete(subscriptionId)
  const entry = state.queryEntries.get(subscription.refreshKey)
  if (entry?.current) {
    subscription.current = entry.current
  }
  entry?.subscribers.delete(subscriptionId)
  entry?.subscriberRefs.delete(subscription)
  entry?.patchSubscriberRefs.delete(subscription)
  entry?.snapshotSubscriberRefs.delete(subscription)
  entry?.patchFallbackSubscriberRefs.delete(subscription)
  if (entry && entry.subscribers.size === 0) {
    removeQueryEntryDependencies(entry)
    removeQueryEntryInvalidationIndexes(entry)
    state.queryEntries.delete(entry.refreshKey)
    state.refreshes.delete(entry.refreshKey)
  }
  detachDatabaseSubscriptionIfIdle()
}
