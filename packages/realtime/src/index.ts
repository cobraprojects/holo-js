import type { ValidationSchema } from '@holo-js/validation'
import { useRealtimeMutation, useRealtimeQuery } from './client'
import {
  configureRealtimeRuntime,
  executeRealtimeMutation,
  executeRealtimeQuery,
  isRealtimeDefinition,
  markDefinition,
  nextDefinitionName,
  resetRealtimeRuntime,
  subscribeRealtimeQuery,
} from './runtime'
import type {
  RealtimeAccess,
  RealtimeArgsFor,
  RealtimeArgsForSchema,
  RealtimeExecutionResult,
  RealtimeMutationDefinition,
  RealtimeMutationInput,
  RealtimeQueryDefinition,
  RealtimeQueryInput,
  RealtimeSubscribeOptions,
  RealtimeSubscription,
} from './contracts'

export {
  configureRealtimeClientRuntime,
  configureRealtimeClientTransport,
  getRealtimeQueryStore,
  hydrateRealtimeQuery,
  realtimeClientInternals,
  resetRealtimeClientRuntime,
  useRealtimeMutation,
  useRealtimeQuery,
} from './client'

export type {
  RealtimeClientTransport,
  RealtimeFrameworkRuntime,
  RealtimeQueryStore,
} from './client'

export type {
  RealtimeAccess,
  RealtimeAccessAuthorize,
  RealtimeAccessObject,
  RealtimeAccessRequirement,
  RealtimeArgsFor,
  RealtimeArgsForSchema,
  RealtimeAuthForAccess,
  RealtimeAuthModule,
  RealtimeAuthRuntime,
  RealtimeAuthState,
  RealtimeDatabaseContext,
  RealtimeExecutionResult,
  RealtimeHandlerContext,
  RealtimeMutationDefinition,
  RealtimeMutationDefinitionMetadata,
  RealtimeMutationInput,
  RealtimePublicAccessContext,
  RealtimeAuthenticatedAccessContext,
  RealtimeQueryDefinition,
  RealtimeQueryDefinitionMetadata,
  RealtimeQueryInput,
  RealtimeResultFor,
  RealtimeRuntimeBindings,
  RealtimeSubscribeOptions,
  RealtimeSubscription,
  RealtimeSubscriptionSnapshot,
} from './contracts'

export {
  configureRealtimeRuntime,
  executeRealtimeMutation,
  executeRealtimeQuery,
  isRealtimeDefinition,
  realtimeRuntimeInternals,
  resetRealtimeRuntime,
  RealtimeAuthUnavailableError,
  RealtimeError,
  RealtimeUnauthorizedError,
  subscribeRealtimeQuery,
} from './runtime'

export function defineRealtimeQuery<
  const TSchema extends ValidationSchema | undefined = undefined,
  const TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>> = RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
  TResult = unknown,
  const TName extends string | undefined = undefined,
>(
  input: RealtimeQueryInput<TName, TSchema, TAccess, TResult>,
): RealtimeQueryDefinition<TName, TSchema, TAccess, Awaited<TResult>> {
  const definition = ((args?: RealtimeArgsForSchema<TSchema>) => {
    return useRealtimeQuery(
      definition as unknown as RealtimeQueryDefinition,
      (args ?? {}) as RealtimeArgsFor<RealtimeQueryDefinition<TName, TSchema, TAccess, Awaited<TResult>>>,
    ) as Awaited<TResult>
  }) as unknown as RealtimeQueryDefinition<TName, TSchema, TAccess, Awaited<TResult>>

  Object.defineProperties(definition, {
    kind: {
      value: 'query',
      enumerable: true,
    },
    name: {
      value: input.name ?? nextDefinitionName('query'),
      enumerable: true,
      configurable: true,
    },
    ...(input.args
      ? {
          args: {
            value: input.args,
            enumerable: true,
          },
        }
      : {}),
    access: {
      value: input.access,
      enumerable: true,
    },
    handler: {
      value: input.handler,
      enumerable: true,
    },
    $types: {
      value: undefined as unknown as RealtimeQueryDefinition<TName, TSchema, TAccess, Awaited<TResult>>['$types'],
      enumerable: true,
    },
  })

  const shapedDefinition = definition as unknown as RealtimeQueryDefinition<TName, TSchema, TAccess, Awaited<TResult>>

  return markDefinition(shapedDefinition)
}

export function defineRealtimeMutation<
  const TSchema extends ValidationSchema | undefined = undefined,
  const TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>> = RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
  TResult = unknown,
  const TName extends string | undefined = undefined,
>(
  input: RealtimeMutationInput<TName, TSchema, TAccess, TResult>,
): RealtimeMutationDefinition<TName, TSchema, TAccess, Awaited<TResult>> {
  const definition = ((args?: RealtimeArgsForSchema<TSchema>) => {
    return useRealtimeMutation(
      definition as unknown as RealtimeMutationDefinition,
      (args ?? {}) as RealtimeArgsFor<RealtimeMutationDefinition<TName, TSchema, TAccess, Awaited<TResult>>>,
    ) as Promise<Awaited<TResult>>
  }) as unknown as RealtimeMutationDefinition<TName, TSchema, TAccess, Awaited<TResult>>

  Object.defineProperties(definition, {
    kind: {
      value: 'mutation',
      enumerable: true,
    },
    name: {
      value: input.name ?? nextDefinitionName('mutation'),
      enumerable: true,
      configurable: true,
    },
    ...(input.args
      ? {
          args: {
            value: input.args,
            enumerable: true,
          },
        }
      : {}),
    access: {
      value: input.access,
      enumerable: true,
    },
    handler: {
      value: input.handler,
      enumerable: true,
    },
    $types: {
      value: undefined as unknown as RealtimeMutationDefinition<TName, TSchema, TAccess, Awaited<TResult>>['$types'],
      enumerable: true,
    },
  })

  const shapedDefinition = definition as unknown as RealtimeMutationDefinition<TName, TSchema, TAccess, Awaited<TResult>>

  return markDefinition(shapedDefinition)
}

export const query = defineRealtimeQuery
export const mutation = defineRealtimeMutation

export function createRealtimeClient() {
  return Object.freeze({
    query<
      const TName extends string | undefined,
      const TSchema extends ValidationSchema | undefined,
      const TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
      TResult,
    >(
      definition: RealtimeQueryDefinition<TName, TSchema, TAccess, TResult>,
      args: RealtimeArgsForSchema<TSchema>,
    ): Promise<RealtimeExecutionResult<Awaited<TResult>>> {
      return executeRealtimeQuery(definition, args)
    },
    mutate<
      const TName extends string | undefined,
      const TSchema extends ValidationSchema | undefined,
      const TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
      TResult,
    >(
      definition: RealtimeMutationDefinition<TName, TSchema, TAccess, TResult>,
      args: RealtimeArgsForSchema<TSchema>,
    ): Promise<RealtimeExecutionResult<Awaited<TResult>>> {
      return executeRealtimeMutation(definition, args)
    },
    subscribe<
      const TName extends string | undefined,
      const TSchema extends ValidationSchema | undefined,
      const TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
      TResult,
    >(
      definition: RealtimeQueryDefinition<TName, TSchema, TAccess, TResult>,
      args: RealtimeArgsForSchema<TSchema>,
      options?: RealtimeSubscribeOptions<Awaited<TResult>>,
    ): Promise<RealtimeSubscription<Awaited<TResult>>> {
      return subscribeRealtimeQuery(definition, args, options)
    },
  })
}

const realtime = Object.freeze({
  configureRealtimeRuntime,
  createRealtimeClient,
  defineRealtimeMutation,
  defineRealtimeQuery,
  executeRealtimeMutation,
  executeRealtimeQuery,
  isRealtimeDefinition,
  mutation,
  query,
  resetRealtimeRuntime,
  subscribeRealtimeQuery,
})

export default realtime
