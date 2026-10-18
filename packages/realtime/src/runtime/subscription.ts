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
import { resolveArgs, runWithExecutionOptions } from './execution'
import { ensureDatabaseSubscription } from './invalidation'
import { deleteSubscription, detachDatabaseSubscriptionIfIdle, createQueryEntry } from './query-entry'
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
    const refreshKey = id
    const subscriptionOptions = options as InternalRealtimeSubscribeOptions<RealtimeResultFor<TDefinition>>
    const entry = await runWithExecutionOptions(state.bindings, executionOptions, async () => await createQueryEntry(definition, args, refreshKey, subscriptionOptions))
    const subscription: ActiveSubscription<TDefinition> = {
      id,
      refreshKey,
      options: subscriptionOptions,
      current: entry.current,
    }
    state.subscriptions.set(subscription.id, subscription as ActiveSubscription<RealtimeQueryDefinitionMetadata>)
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
