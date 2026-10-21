import { forgetRemoteRefreshSchedule } from './invalidation'
import { captureAuthContext, getDatabaseContext } from './execution'
import { createExecutionContext } from './execution-context'
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
  type InternalRealtimeSubscribeOptions,
} from './state'
import {
  addQueryEntryDependencies,
  addQueryEntryInvalidationIndexes,
  removeQueryEntryDependencies,
  removeQueryEntryInvalidationIndexes,
} from './subscription-index'

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

export async function createQueryEntry<TDefinition extends RealtimeQueryDefinitionMetadata>(
  definition: TDefinition,
  args: RealtimeArgsFor<TDefinition>,
  refreshKey: string,
  options: InternalRealtimeSubscribeOptions<RealtimeResultFor<TDefinition>>,
): Promise<InitializedActiveQueryEntry<TDefinition>> {
  const state = getRuntimeState()
  const database = getDatabaseContext(state.bindings).connection
  const entry: ActiveQueryEntry<TDefinition> = {
    runWithContext: createExecutionContext(database),
    contextId: database.getContextId(),
    contexts: new Map(),
    refreshKey,
    definition,
    args,
    options,
    dependencies: Object.freeze([]),
    patchTargets: [],
    predicateDependencies: new Map<string, Map<string, Set<string>>>(),
    queries: [],
    resultHash: '',
    resultHashDirty: false,
    tableDependencies: EMPTY_TABLE_DEPENDENCIES,
    version: 0,
  }
  state.queryEntries.set(refreshKey, entry as ActiveQueryEntry<RealtimeQueryDefinitionMetadata>)

  try {
    const result = await executeInitialQuery(definition, args, undefined)
    const auth = await captureAuthContext(state.bindings)
    entry.runWithContext = createExecutionContext(database, auth)
    entry.contexts = new Map(result.contexts)
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
    addQueryEntryDependencies(entry as ActiveQueryEntry<RealtimeQueryDefinitionMetadata>)
    addQueryEntryInvalidationIndexes(entry as ActiveQueryEntry<RealtimeQueryDefinitionMetadata>)
    return entry as InitializedActiveQueryEntry<TDefinition>
  } catch (error) {
    state.queryEntries.delete(refreshKey)
    throw error
  }
}

export function deleteSubscription(subscriptionId: string): void {
  const state = getRuntimeState()
  const subscription = state.subscriptions.get(subscriptionId)
  if (!subscription) {
    return
  }

  state.subscriptions.delete(subscriptionId)
  forgetRemoteRefreshSchedule(subscription.refreshKey)
  const entry = state.queryEntries.get(subscription.refreshKey)
  if (entry?.current) {
    subscription.current = entry.current
  }
  if (entry) {
    removeQueryEntryDependencies(entry)
    removeQueryEntryInvalidationIndexes(entry)
    state.queryEntries.delete(entry.refreshKey)
    state.refreshes.delete(entry.refreshKey)
  }
  detachDatabaseSubscriptionIfIdle()
}
