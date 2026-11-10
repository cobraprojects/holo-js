import {
  queryCacheInternals,
  serializeModels,
} from '@holo-js/db'
import type { ValidationSchema } from '@holo-js/validation'
import type {
  RealtimeAccess,
  RealtimeArgsFor,
  RealtimeArgsForSchema,
  RealtimeDatabaseContext,
  RealtimeExecutionOptions,
  RealtimeExecutionResult,
  RealtimeMutationDefinition,
  RealtimeMutationDefinitionMetadata,
  RealtimeQueryDefinition,
  RealtimeQueryDefinitionMetadata,
  RealtimeResultFor,
} from '../contracts'
import {
  collectReadPredicateDependencies,
  collectTableDependencies,
} from './dependencies'
import {
  authorize,
  getDatabaseContext as createRuntimeDatabaseContext,
  resolveArgs,
  runWithExecutionOptions,
} from './execution'
import { createResultHash } from './result-hash'
import {
  getRuntimeState,
  type DatabaseDependencyCollectionWithQueries,
  type InitialQueryResult,
  type InternalRealtimeExecutionResult,
} from './state'
import type { DatabaseQueryObservation, DatabaseQueryRead } from './query-state'

export function getRealtimeDatabaseContext(): RealtimeDatabaseContext {
  return createRuntimeDatabaseContext(getRuntimeState().bindings)
}

function projectDatabaseQueryObservation(query: DatabaseQueryRead): DatabaseQueryObservation {
  return Object.freeze({
    connectionName: query.connectionName,
    dependencies: query.dependencies,
    predicates: Object.freeze(query.predicates.map(predicate => Object.freeze({
      column: predicate.column,
      operator: predicate.operator,
      value: predicate.value,
    }))),
    primaryKey: query.primaryKey,
    tableName: query.tableName,
  })
}

export async function executeRealtimeQueryInternal<TDefinition extends RealtimeQueryDefinitionMetadata>(
  definition: TDefinition,
  input = {} as RealtimeArgsFor<TDefinition>,
  options?: RealtimeExecutionOptions,
  beforeHandler?: () => void,
): Promise<InternalRealtimeExecutionResult<RealtimeResultFor<TDefinition>> & { readonly contexts: ReadonlyMap<string, ReadonlySet<number>> }> {
  return await runWithExecutionOptions(getRuntimeState().bindings, options, async () => {
    const db = getRealtimeDatabaseContext()
    const args = await resolveArgs(definition, input)
    const auth = await authorize(getRuntimeState().bindings, definition.access, args, db)
    beforeHandler?.()
    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await definition.handler({
        args,
        auth: auth as never,
        db,
        name: definition.name,
      })
    }) as DatabaseDependencyCollectionWithQueries<unknown>

    const data = serializeModels(result.value) as RealtimeResultFor<TDefinition>
    return Object.freeze({
      name: definition.name,
      data,
      dependencies: result.dependencies,
      queries: Object.freeze(result.queries.map(projectDatabaseQueryObservation)),
      contexts: result.contexts,
    })
  })
}

export async function executeInitialQuery<TDefinition extends RealtimeQueryDefinitionMetadata>(
  definition: TDefinition,
  args: RealtimeArgsFor<TDefinition>,
  executionOptions: RealtimeExecutionOptions | undefined,
): Promise<InitialQueryResult<TDefinition>> {
  const result = await executeRealtimeQueryInternal(definition, args, executionOptions)
  const snapshot = Object.freeze({
    name: result.name,
    data: result.data,
    dependencies: result.dependencies,
    version: 1,
  })

  return {
    contexts: result.contexts,
    predicateDependencies: collectReadPredicateDependencies(result.dependencies, result.queries),
    result,
    resultHash: createResultHash(result.data),
    snapshot,
    tableDependencies: collectTableDependencies(result.dependencies),
  }
}

export async function executeRealtimeQuery<
  const TName extends string | undefined,
  const TSchema extends ValidationSchema | undefined,
  const TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
  TResult,
>(
  definition: RealtimeQueryDefinition<TName, TSchema, TAccess, TResult>,
  input?: RealtimeArgsForSchema<TSchema>,
  options?: RealtimeExecutionOptions,
): Promise<RealtimeExecutionResult<TResult>>
export async function executeRealtimeQuery<TDefinition extends RealtimeQueryDefinitionMetadata>(
  definition: TDefinition,
  input?: RealtimeArgsFor<TDefinition>,
  options?: RealtimeExecutionOptions,
): Promise<RealtimeExecutionResult<RealtimeResultFor<TDefinition>>>
export async function executeRealtimeQuery<TDefinition extends RealtimeQueryDefinitionMetadata>(
  definition: TDefinition,
  input = {} as RealtimeArgsFor<TDefinition>,
  options?: RealtimeExecutionOptions,
): Promise<RealtimeExecutionResult<RealtimeResultFor<TDefinition>>> {
  const result = await executeRealtimeQueryInternal(definition, input, options)
  return Object.freeze({
    name: result.name,
    data: result.data,
    dependencies: result.dependencies,
  })
}

export async function executeRealtimeMutation<
  const TName extends string | undefined,
  const TSchema extends ValidationSchema | undefined,
  const TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
  TResult,
>(
  definition: RealtimeMutationDefinition<TName, TSchema, TAccess, TResult>,
  input?: RealtimeArgsForSchema<TSchema>,
  options?: RealtimeExecutionOptions,
): Promise<RealtimeExecutionResult<TResult>>
export async function executeRealtimeMutation<TDefinition extends RealtimeMutationDefinitionMetadata>(
  definition: TDefinition,
  input?: RealtimeArgsFor<TDefinition>,
  options?: RealtimeExecutionOptions,
): Promise<RealtimeExecutionResult<RealtimeResultFor<TDefinition>>>
export async function executeRealtimeMutation<TDefinition extends RealtimeMutationDefinitionMetadata>(
  definition: TDefinition,
  input = {} as RealtimeArgsFor<TDefinition>,
  options?: RealtimeExecutionOptions,
): Promise<RealtimeExecutionResult<RealtimeResultFor<TDefinition>>> {
  return await runWithExecutionOptions(getRuntimeState().bindings, options, async () => {
    const db = getRealtimeDatabaseContext()
    const args = await resolveArgs(definition, input)
    const auth = await authorize(getRuntimeState().bindings, definition.access, args, db)
    const data = await definition.handler({
      args,
      auth: auth as never,
      db,
      name: definition.name,
    })

    return Object.freeze({
      name: definition.name,
      data: serializeModels(data) as RealtimeResultFor<TDefinition>,
      dependencies: Object.freeze([]),
    })
  })
}
