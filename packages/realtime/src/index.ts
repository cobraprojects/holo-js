import type { ValidationSchema } from '@holo-js/validation'
import type { SerializeModels } from '@holo-js/db'
import {
  hasConfiguredRealtimeClientRuntime,
  hasConfiguredRealtimeClientTransport,
  useRealtimeMutation,
  useRealtimeQuery,
} from './client'
import {
  isRealtimeDefinition,
  nextDefinitionName,
  markDefinition,
} from './definition'
import type {
  RealtimeAccess,
  RealtimeArgsFor,
  RealtimeArgsForSchema,
  RealtimeExecutionResult,
  RealtimeMutationDefinition,
  RealtimeMutationInput,
  RealtimeQueryDefinition,
  RealtimeQueryInput,
  RealtimeResultFor,
  RealtimeSubscribeOptions,
  RealtimeSubscription,
} from './contracts'
import type {
  executeRealtimeMutation,
  executeRealtimeQuery,
  subscribeRealtimeQuery,
} from './runtime'

export {
  configureRealtimeClientRuntime,
  configureRealtimeClientTransport,
  createBroadcastRealtimeTransport,
  getRealtimeQueryStore,
  hasConfiguredRealtimeClientRuntime,
  hasConfiguredRealtimeClientTransport,
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
  RealtimeAuthorizationContext,
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
  isRealtimeDefinition,
} from './definition'

export function defineRealtimeQuery<
  const TSchema extends ValidationSchema | undefined = undefined,
  const TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>> = RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
  TResult = unknown,
  const TName extends string | undefined = undefined,
>(
  input: RealtimeQueryInput<TName, TSchema, TAccess, TResult>,
): RealtimeQueryDefinition<TName, TSchema, TAccess, SerializeModels<Awaited<TResult>>> {
  const definition = ((args?: RealtimeArgsForSchema<TSchema>) => {
    const normalizedArgs = (args ?? {}) as RealtimeArgsFor<RealtimeQueryDefinition<TName, TSchema, TAccess, SerializeModels<Awaited<TResult>>>>
    if (shouldExecuteOnServer()) {
      return importRealtimeRuntime()
        .then(({ executeRealtimeQuery }) => executeRealtimeQuery(
          definition as unknown as RealtimeQueryDefinition<TName, TSchema, TAccess, SerializeModels<Awaited<TResult>>>,
          normalizedArgs,
        ))
        .then(result => result.data) as RealtimeResultFor<RealtimeQueryDefinition<TName, TSchema, TAccess, SerializeModels<Awaited<TResult>>>>
    }

    return useRealtimeQuery(
      definition as unknown as RealtimeQueryDefinition,
      normalizedArgs,
    ) as RealtimeResultFor<RealtimeQueryDefinition<TName, TSchema, TAccess, SerializeModels<Awaited<TResult>>>>
  }) as unknown as RealtimeQueryDefinition<TName, TSchema, TAccess, SerializeModels<Awaited<TResult>>>

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
      value: undefined as unknown as RealtimeQueryDefinition<TName, TSchema, TAccess, SerializeModels<Awaited<TResult>>>['$types'],
      enumerable: true,
    },
  })

  const shapedDefinition = definition as unknown as RealtimeQueryDefinition<TName, TSchema, TAccess, SerializeModels<Awaited<TResult>>>

  return markDefinition(shapedDefinition)
}

export function defineRealtimeMutation<
  const TSchema extends ValidationSchema | undefined = undefined,
  const TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>> = RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
  TResult = unknown,
  const TName extends string | undefined = undefined,
>(
  input: RealtimeMutationInput<TName, TSchema, TAccess, TResult>,
): RealtimeMutationDefinition<TName, TSchema, TAccess, SerializeModels<Awaited<TResult>>> {
  const definition = ((args?: RealtimeArgsForSchema<TSchema>) => {
    const normalizedArgs = (args ?? {}) as RealtimeArgsFor<RealtimeMutationDefinition<TName, TSchema, TAccess, SerializeModels<Awaited<TResult>>>>
    if (shouldExecuteOnServer()) {
      return importRealtimeRuntime()
        .then(({ executeRealtimeMutation }) => executeRealtimeMutation(
          definition as unknown as RealtimeMutationDefinition<TName, TSchema, TAccess, SerializeModels<Awaited<TResult>>>,
          normalizedArgs,
        ))
        .then(result => result.data)
    }

    return useRealtimeMutation(
      definition as unknown as RealtimeMutationDefinition,
      normalizedArgs,
    ) as Promise<RealtimeResultFor<RealtimeMutationDefinition<TName, TSchema, TAccess, SerializeModels<Awaited<TResult>>>>>
  }) as unknown as RealtimeMutationDefinition<TName, TSchema, TAccess, SerializeModels<Awaited<TResult>>>

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
      value: undefined as unknown as RealtimeMutationDefinition<TName, TSchema, TAccess, SerializeModels<Awaited<TResult>>>['$types'],
      enumerable: true,
    },
  })

  const shapedDefinition = definition as unknown as RealtimeMutationDefinition<TName, TSchema, TAccess, SerializeModels<Awaited<TResult>>>

  return markDefinition(shapedDefinition)
}

export const query = defineRealtimeQuery
export const mutation = defineRealtimeMutation

const realtimeRuntimeSpecifier = '@holo-js/realtime/server'

interface RealtimeRuntimeModule {
  executeRealtimeMutation: typeof executeRealtimeMutation
  executeRealtimeQuery: typeof executeRealtimeQuery
  subscribeRealtimeQuery: typeof subscribeRealtimeQuery
}

function isBrowserRuntime(): boolean {
  return 'window' in globalThis
}

function shouldExecuteOnServer(): boolean {
  return !isBrowserRuntime()
    && !hasConfiguredRealtimeClientRuntime()
    && !hasConfiguredRealtimeClientTransport()
}

async function importRealtimeRuntime(): Promise<RealtimeRuntimeModule> {
  return await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ /* @vite-ignore */ realtimeRuntimeSpecifier)
}

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
    ): Promise<RealtimeExecutionResult<TResult>> {
      return importRealtimeRuntime().then(({ executeRealtimeQuery }) => executeRealtimeQuery(definition, args))
    },
    mutate<
      const TName extends string | undefined,
      const TSchema extends ValidationSchema | undefined,
      const TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
      TResult,
    >(
      definition: RealtimeMutationDefinition<TName, TSchema, TAccess, TResult>,
      args: RealtimeArgsForSchema<TSchema>,
    ): Promise<RealtimeExecutionResult<TResult>> {
      return importRealtimeRuntime().then(({ executeRealtimeMutation }) => executeRealtimeMutation(definition, args))
    },
    subscribe<
      const TName extends string | undefined,
      const TSchema extends ValidationSchema | undefined,
      const TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
      TResult,
    >(
      definition: RealtimeQueryDefinition<TName, TSchema, TAccess, TResult>,
      args: RealtimeArgsForSchema<TSchema>,
      options?: RealtimeSubscribeOptions<TResult>,
    ): Promise<RealtimeSubscription<TResult>> {
      return importRealtimeRuntime().then(({ subscribeRealtimeQuery }) => subscribeRealtimeQuery(definition, args, options))
    },
  })
}

const realtime = Object.freeze({
  createRealtimeClient,
  defineRealtimeMutation,
  defineRealtimeQuery,
  isRealtimeDefinition,
  mutation,
  query,
})

export default realtime
