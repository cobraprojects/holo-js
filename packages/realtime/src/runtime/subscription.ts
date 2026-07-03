import type { ValidationSchema } from '@holo-js/validation'
import type {
  RealtimeAccess,
  RealtimeArgsFor,
  RealtimeArgsForSchema,
  RealtimeExecutionOptions,
  RealtimeQueryDefinition,
  RealtimeQueryDefinitionMetadata,
  RealtimeResultFor,
  RealtimeSubscribeOptions,
  RealtimeSubscription,
} from '../contracts'
import { resolveArgs } from './execution'
import { ensureDatabaseSubscription } from './invalidation'
import { deleteSubscription, detachDatabaseSubscriptionIfIdle, resolveQueryEntry } from './query-entry'
import { createRefreshKey } from './refresh-key'
import {
  getRuntimeState,
  type ActiveQueryEntry,
  type ActiveSubscription,
  type InternalRealtimeSubscribeOptions,
} from './state'

export async function subscribeRealtimeQuery<
  const TName extends string | undefined,
  const TSchema extends ValidationSchema | undefined,
  const TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
  TResult,
>(
  definition: RealtimeQueryDefinition<TName, TSchema, TAccess, TResult>,
  input?: RealtimeArgsForSchema<TSchema>,
  options?: RealtimeSubscribeOptions<TResult>,
  executionOptions?: RealtimeExecutionOptions,
): Promise<RealtimeSubscription<TResult>>
export async function subscribeRealtimeQuery<TDefinition extends RealtimeQueryDefinitionMetadata>(
  definition: TDefinition,
  input?: RealtimeArgsFor<TDefinition>,
  options?: RealtimeSubscribeOptions<RealtimeResultFor<TDefinition>>,
  executionOptions?: RealtimeExecutionOptions,
): Promise<RealtimeSubscription<RealtimeResultFor<TDefinition>>>
export async function subscribeRealtimeQuery<TDefinition extends RealtimeQueryDefinitionMetadata>(
  definition: TDefinition,
  input = {} as RealtimeArgsFor<TDefinition>,
  options: RealtimeSubscribeOptions<RealtimeResultFor<TDefinition>> = {},
  executionOptions?: RealtimeExecutionOptions,
): Promise<RealtimeSubscription<RealtimeResultFor<TDefinition>>> {
  ensureDatabaseSubscription()
  try {
    const state = getRuntimeState()
    state.nextSubscriptionId += 1
    const subscriptionId = state.nextSubscriptionId
    const args = await resolveArgs(definition, input)
    const id = `subscription.${subscriptionId}`
    const refreshKey = createRefreshKey(
      definition,
      args as Record<string, unknown>,
      id,
      executionOptions,
    )
    const entry = await resolveQueryEntry(definition, args, executionOptions, refreshKey)
    const subscriptionOptions = options as InternalRealtimeSubscribeOptions<RealtimeResultFor<TDefinition>>
    const subscription: ActiveSubscription<TDefinition> = {
      id,
      refreshKey,
      options: subscriptionOptions,
      current: entry.current,
    }
    state.subscriptions.set(subscription.id, subscription as ActiveSubscription<RealtimeQueryDefinitionMetadata>)
    entry.subscribers.add(subscription.id)
    entry.subscriberRefs.add(subscription)
    if (subscriptionOptions.onPatch) {
      entry.patchSubscriberRefs.add(subscription)
    }
    if (subscriptionOptions.onData) {
      entry.snapshotSubscriberRefs.add(subscription)
      if (!subscriptionOptions.onPatch) {
        entry.patchFallbackSubscriberRefs.add(subscription)
      }
    }
    try {
      await subscriptionOptions.onData?.(entry.current)
    } catch (error) {
      deleteSubscription(subscription.id)
      throw error
    }

    return Object.freeze({
      id: subscription.id,
      name: definition.name,
      get current() {
        const currentEntry = getRuntimeState().queryEntries.get(subscription.refreshKey) as ActiveQueryEntry<TDefinition> | undefined
        return currentEntry?.current ?? subscription.current
      },
      unsubscribe() {
        deleteSubscription(subscription.id)
      },
    })
  } catch (error) {
    detachDatabaseSubscriptionIfIdle()
    throw error
  }
}
