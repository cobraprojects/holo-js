import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ConfigurationError } from './core/errors'
import type { DatabaseContext } from './core/DatabaseContext'
import type { CompiledStatement } from './core/types'
import type { QueryOperator, QueryPredicateNode, QuerySelection, SelectQueryPlan } from './query/ast'

export type QueryCacheTtlInput = number | Date
export type QueryCacheFlexibleTtlInput
  = readonly [fresh: number, stale: number]
  | {
      readonly fresh: number
      readonly stale: number
    }

export interface QueryCacheConfig {
  readonly ttl?: QueryCacheTtlInput
  readonly key?: string
  readonly driver?: string
  readonly flexible?: QueryCacheFlexibleTtlInput
  readonly invalidate?: readonly string[]
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- preserve the exported interface shape while deriving from QueryCacheConfig.
export interface NormalizedQueryCacheConfig extends QueryCacheConfig {}

export interface DatabaseQueryCacheBridge {
  get<TValue>(key: string, options?: { readonly driver?: string }): Promise<TValue | null>
  put<TValue>(
    key: string,
    value: TValue,
    options: {
      readonly driver?: string
      readonly ttl?: QueryCacheTtlInput
      readonly dependencies?: readonly string[]
    },
  ): Promise<void>
  flexible<TValue>(
    key: string,
    ttl: QueryCacheFlexibleTtlInput,
    callback: () => TValue | Promise<TValue>,
    options?: {
      readonly driver?: string
      readonly dependencies?: readonly string[]
    },
  ): Promise<TValue>
  forget(key: string, options?: { readonly driver?: string }): Promise<boolean>
  invalidateDependencies(
    dependencies: readonly string[],
    options?: { readonly driver?: string },
  ): Promise<void>
}

export interface DatabaseDependencyInvalidationEvent {
  readonly connectionName: string
  readonly dependencies: readonly string[]
}

export type DatabaseDependencyInvalidationListener = (
  event: DatabaseDependencyInvalidationEvent,
) => void | Promise<void>

export interface DatabaseDependencyCollectionResult<TValue> {
  readonly value: TValue
  readonly dependencies: readonly string[]
}

export interface DatabaseQueryPredicateObservation {
  readonly column: string
  readonly operator: QueryOperator
  readonly value: unknown
}

export interface DatabaseQueryOrderObservation {
  readonly column: string
  readonly direction: 'asc' | 'desc'
}

export interface DatabaseQueryAggregateObservation {
  readonly column?: string
  readonly count?: number
  readonly currentValueCount?: number
  readonly kind: 'avg' | 'count' | 'max' | 'min' | 'sum'
  readonly output?: 'boolean' | 'inverseBoolean'
  readonly sum?: number
  readonly valueCounts?: readonly DatabaseQueryAggregateValueCountObservation[]
}

export interface DatabaseQueryAggregateValueCountObservation {
  readonly count: number
  readonly value: number
}

export interface DatabaseQuerySelectionObservation {
  readonly column: string
  readonly resultKey: string
}

export interface DatabaseQueryGroupedAggregateObservation {
  readonly aggregateColumn?: string
  readonly aggregateResultKey: string
  readonly aggregateStates?: readonly DatabaseQueryGroupedAggregateStateObservation[]
  readonly averageStates?: readonly DatabaseQueryGroupedAverageStateObservation[]
  readonly groupColumn: string
  readonly groupResultKey: string
  readonly having?: DatabaseQueryGroupedAggregateHavingObservation
  readonly kind: 'avg' | 'count' | 'max' | 'min' | 'sum'
}

export interface DatabaseQueryGroupedAggregateStateObservation {
  readonly aggregateValue: number
  readonly groupValue: unknown
  readonly rowCount: number
  readonly valueCounts?: readonly DatabaseQueryGroupedAggregateValueCountObservation[]
}

export interface DatabaseQueryGroupedAggregateValueCountObservation {
  readonly count: number
  readonly value: number
}

export interface DatabaseQueryGroupedAverageStateObservation {
  readonly count: number
  readonly groupValue: unknown
  readonly rowCount: number
  readonly sum: number
}

export interface DatabaseQueryGroupedAggregateHavingObservation {
  readonly operator: Extract<QueryOperator, '<' | '<=' | '=' | '>' | '>='>
  readonly value: number
}

export type DatabaseQueryPaginationObservation =
  | DatabaseQueryStandardPaginationObservation
  | DatabaseQuerySimplePaginationObservation
  | DatabaseQueryCursorPaginationObservation

export interface DatabaseQueryStandardPaginationObservation {
  readonly currentPage: number
  readonly kind: 'standard'
  readonly pageName: string
  readonly perPage: number
  readonly total: number
}

export interface DatabaseQuerySimplePaginationObservation {
  readonly currentPage: number
  readonly hasMorePages: boolean
  readonly kind: 'simple'
  readonly pageName: string
  readonly perPage: number
  readonly rowCount: number
}

export interface DatabaseQueryCursorPaginationObservation {
  readonly cursorName: string
  readonly hasMorePages: boolean
  readonly kind: 'cursor'
  readonly nextCursor: string | null
  readonly perPage: number
  readonly prevCursor: string | null
  readonly rows: readonly Readonly<Record<string, unknown>>[]
  readonly rowCount: number
}

type DatabaseQueryPaginationMetaObservation =
  | DatabaseQueryStandardPaginationMetaObservation
  | DatabaseQuerySimplePaginationMetaObservation

interface DatabaseQueryStandardPaginationMetaObservation {
  readonly currentPage: number
  readonly from: number | null
  readonly hasMorePages: boolean
  readonly lastPage: number
  readonly pageName: string
  readonly perPage: number
  readonly to: number | null
  readonly total: number
}

interface DatabaseQuerySimplePaginationMetaObservation {
  readonly currentPage: number
  readonly from: number | null
  readonly hasMorePages: boolean
  readonly pageName: string
  readonly perPage: number
  readonly to: number | null
}

interface DatabaseQueryCursorPaginationMetaObservation {
  readonly cursorName: string
  readonly nextCursor: string | null
  readonly perPage: number
  readonly prevCursor: string | null
}

export type DatabaseQueryResultPathSegment = string | number

export interface DatabaseQueryObservation {
  readonly aggregate?: DatabaseQueryAggregateObservation
  readonly belongsToHydrations?: readonly DatabaseQueryBelongsToHydrationObservation[]
  readonly connectionName: string
  readonly cursorRowCount?: number
  readonly cursorRows?: readonly Readonly<Record<string, unknown>>[]
  readonly tableName: string
  readonly dependencies: readonly string[]
  readonly emptyRecordValue?: null
  readonly groupedAggregate?: DatabaseQueryGroupedAggregateObservation
  readonly limit?: number
  readonly offset?: number
  readonly orderBy: readonly DatabaseQueryOrderObservation[]
  readonly patchable: boolean
  readonly pagination?: DatabaseQueryPaginationObservation
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
  readonly relation?: DatabaseQueryRelationObservation
  readonly result?: unknown
  readonly resultPath?: readonly DatabaseQueryResultPathSegment[]
  readonly scalarColumn?: string
  readonly scalarListColumn?: string
  readonly scalarListRows?: readonly Readonly<Record<string, unknown>>[]
  readonly relatedHydrations?: readonly DatabaseQueryRelatedHydrationObservation[]
  readonly selections: readonly DatabaseQuerySelectionObservation[]
}

export interface DatabaseQueryBelongsToHydrationObservation {
  readonly foreignKey: string
  readonly ownerKey: string
  readonly relationKey: string
  readonly relatedConnectionName: string
  readonly relatedTableName: string
}

export interface DatabaseQueryRelatedHydrationObservation {
  readonly foreignKey: string
  readonly kind: 'hasMany' | 'hasOne'
  readonly localKey: string
  readonly orderBy: readonly DatabaseQueryOrderObservation[]
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
  readonly relationKey: string
  readonly relatedConnectionName: string
  readonly relatedTableName: string
}

export type DatabaseQueryRelationObservation =
  | DatabaseQueryBelongsToManyRelationObservation
  | DatabaseQueryBelongsToParentKeyRelationObservation

export interface DatabaseQueryBelongsToManyRelationObservation {
  readonly foreignPivotKey: string
  readonly kind: 'belongsToMany'
  readonly pivotAccessor: string
  readonly pivotColumns: readonly string[]
  readonly pivotOrderBy: readonly DatabaseQueryOrderObservation[]
  readonly relatedConnectionName: string
  readonly relatedKey: string
  readonly relatedPivotKey: string
  readonly relatedTableName: string
}

export interface DatabaseQueryBelongsToParentKeyRelationObservation {
  readonly foreignKey: string
  readonly kind: 'belongsToParentKey'
  readonly ownerKey: string
  readonly relationKey: string
  readonly relatedConnectionName: string
  readonly relatedTableName: string
}

export interface DatabaseMutationEvent {
  readonly connectionName: string
  readonly tableName: string
  readonly kind: 'insert' | 'update' | 'delete' | 'upsert'
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
  readonly previousRows?: readonly Readonly<Record<string, unknown>>[]
  readonly rows?: readonly Readonly<Record<string, unknown>>[]
  readonly values?: Readonly<Record<string, unknown>>
}

type DatabaseDependencyPredicateMetadata = {
  readonly tableKey: string
  readonly columnName: string
  readonly encodedValue: string
}

type DatabaseDependencyInvalidationMetadata = {
  readonly directDependencies: readonly string[]
  readonly exactPredicates: readonly DatabaseDependencyPredicateMetadata[]
  readonly hasMutationDependency: boolean
  readonly predicates: readonly DatabaseDependencyPredicateMetadata[]
  readonly tableDependencies: readonly string[]
}

type DatabaseDependencyInvalidationEventWithMutations = DatabaseDependencyInvalidationEvent & {
  readonly mutations?: readonly DatabaseMutationEvent[]
}

type DatabaseDependencyInvalidationEventInternal = DatabaseDependencyInvalidationEventWithMutations & {
  readonly __holoDatabaseDependencyMetadata__?: DatabaseDependencyInvalidationMetadata
}

type DatabaseDependencyInvalidationListenerInternal = (
  event: DatabaseDependencyInvalidationEventInternal,
) => void | Promise<void>

type DatabaseDependencyCollectionResultInternal<TValue> = DatabaseDependencyCollectionResult<TValue> & {
  readonly queries: readonly DatabaseQueryObservation[]
}

type DatabaseDependencyInvalidationPlan = {
  readonly dependencies: readonly string[]
  readonly metadata?: DatabaseDependencyInvalidationMetadata
}

type DatabaseDependencyPredicateEntry = {
  readonly dependency: string
  readonly metadata: DatabaseDependencyPredicateMetadata
}

type DatabaseDependencyCollectorState = {
  readonly dependencies: Set<string>
  readonly queries: DatabaseQueryObservation[]
}

const DATABASE_DEPENDENCY_PREFIX = 'db:'
const DATABASE_DEPENDENCY_METADATA_KEY = '__holoDatabaseDependencyMetadata__'
const MUTATION_DEPENDENCY_SUFFIX = 'mutation'
const WHERE_DEPENDENCY_PREFIX = 'where:'
const WHERE_EXACT_DEPENDENCY_PREFIX = 'where-exact:'

const databaseDependencyCollector = new AsyncLocalStorage<DatabaseDependencyCollectorState>()

function getQueryCacheBridgeState(): {
  bridge?: DatabaseQueryCacheBridge
  dependencyInvalidationListeners?: Set<DatabaseDependencyInvalidationListenerInternal>
} {
  const runtime = globalThis as typeof globalThis & {
    __holoDbQueryCacheBridge__?: {
      bridge?: DatabaseQueryCacheBridge
      dependencyInvalidationListeners?: Set<DatabaseDependencyInvalidationListenerInternal>
    }
  }

  runtime.__holoDbQueryCacheBridge__ ??= {}
  return runtime.__holoDbQueryCacheBridge__
}

export function configureDatabaseQueryCacheBridge(bridge?: DatabaseQueryCacheBridge): void {
  getQueryCacheBridgeState().bridge = bridge
}

export function getDatabaseQueryCacheBridge(): DatabaseQueryCacheBridge | undefined {
  return getQueryCacheBridgeState().bridge
}

export function resetDatabaseQueryCacheBridge(): void {
  getQueryCacheBridgeState().bridge = undefined
}

export function onDatabaseDependencyInvalidated(
  listener: DatabaseDependencyInvalidationListener,
): () => void {
  const state = getQueryCacheBridgeState()
  state.dependencyInvalidationListeners ??= new Set<DatabaseDependencyInvalidationListenerInternal>()
  const internalListener = listener as DatabaseDependencyInvalidationListenerInternal
  state.dependencyInvalidationListeners.add(internalListener)

  return () => {
    state.dependencyInvalidationListeners?.delete(internalListener)
  }
}

export function resetDatabaseDependencyInvalidationListeners(): void {
  getQueryCacheBridgeState().dependencyInvalidationListeners = undefined
}

export async function collectDatabaseQueryDependencies<TValue>(
  callback: () => TValue | Promise<TValue>,
): Promise<DatabaseDependencyCollectionResult<TValue>> {
  const result = await collectDatabaseQueryDependenciesInternal(callback)

  return Object.freeze({
    value: result.value,
    dependencies: result.dependencies,
  })
}

async function collectDatabaseQueryDependenciesInternal<TValue>(
  callback: () => TValue | Promise<TValue>,
): Promise<DatabaseDependencyCollectionResultInternal<TValue>> {
  const state: DatabaseDependencyCollectorState = {
    dependencies: new Set<string>(),
    queries: [],
  }
  const value = await databaseDependencyCollector.run(state, callback)

  return Object.freeze({
    value,
    dependencies: Object.freeze([...state.dependencies]),
    queries: Object.freeze([...state.queries]),
  })
}

export function hasActiveDatabaseDependencyCollector(): boolean {
  return typeof databaseDependencyCollector.getStore() !== 'undefined'
}

export function recordDatabaseQueryDependencies(dependencies: readonly string[] | undefined): void {
  if (!dependencies || dependencies.length === 0) {
    return
  }

  const state = databaseDependencyCollector.getStore()
  if (!state) {
    return
  }

  for (const dependency of dependencies) {
    state.dependencies.add(dependency)
  }
}

export function recordDatabaseQueryObservation(observation: DatabaseQueryObservation | undefined): void {
  if (!observation) {
    return
  }

  const state = databaseDependencyCollector.getStore()
  if (!state) {
    return
  }

  state.queries.push(observation)
}

export function readDatabaseQueryObservationCount(): number {
  return databaseDependencyCollector.getStore()?.queries.length ?? 0
}

export function truncateDatabaseQueryObservations(count: number): void {
  const state = databaseDependencyCollector.getStore()
  if (!state || count >= state.queries.length) {
    return
  }

  state.queries.length = Math.max(0, count)
}

export function rebindDatabaseQueryObservationResult(source: unknown, result: unknown): void {
  rebindDatabaseQueryObservation(source, result)
}

export function rebindDatabaseQueryObservationHydratedResult(
  source: unknown,
  result: unknown,
  belongsToHydrations: readonly DatabaseQueryBelongsToHydrationObservation[],
  relatedHydrations?: readonly DatabaseQueryRelatedHydrationObservation[],
): void {
  rebindDatabaseQueryObservation(source, result, undefined, undefined, undefined, undefined, belongsToHydrations, relatedHydrations)
}

export function rebindDatabaseQueryObservationPagination(
  source: unknown,
  data: unknown,
  meta: DatabaseQueryPaginationMetaObservation,
  pagination: DatabaseQueryPaginationObservation,
  offset: number,
  belongsToHydrations?: readonly DatabaseQueryBelongsToHydrationObservation[],
  relatedHydrations?: readonly DatabaseQueryRelatedHydrationObservation[],
): void {
  const state = databaseDependencyCollector.getStore()
  if (!state) {
    return
  }

  for (let index = state.queries.length - 1; index >= 0; index -= 1) {
    const query = state.queries[index]
    if (!query || query.result !== source) {
      continue
    }

    state.queries[index] = Object.freeze({
      aggregate: undefined,
      belongsToHydrations: belongsToHydrations ?? query.belongsToHydrations,
      connectionName: query.connectionName,
      tableName: query.tableName,
      dependencies: query.dependencies,
      limit: pagination.perPage,
      offset,
      orderBy: query.orderBy,
      patchable: query.patchable,
      pagination: undefined,
      predicates: query.predicates,
      relation: query.relation,
      result: data,
      resultPath: query.resultPath,
      relatedHydrations: relatedHydrations ?? query.relatedHydrations,
      scalarColumn: undefined,
      scalarListColumn: undefined,
      scalarListRows: undefined,
      selections: query.selections,
    })
    state.queries.push(Object.freeze({
      aggregate: undefined,
      belongsToHydrations: undefined,
      connectionName: query.connectionName,
      tableName: query.tableName,
      dependencies: query.dependencies,
      limit: undefined,
      offset: undefined,
      orderBy: query.orderBy,
      patchable: query.patchable,
      pagination,
      predicates: query.predicates,
      relation: query.relation,
      result: meta,
      resultPath: undefined,
      relatedHydrations: undefined,
      scalarColumn: undefined,
      scalarListColumn: undefined,
      scalarListRows: undefined,
      selections: query.selections,
    }))
    return
  }
}

export function rebindDatabaseQueryObservationCursorPagination(
  source: unknown,
  data: unknown,
  meta: DatabaseQueryCursorPaginationMetaObservation,
  pagination: DatabaseQueryCursorPaginationObservation,
  belongsToHydrations?: readonly DatabaseQueryBelongsToHydrationObservation[],
  relatedHydrations?: readonly DatabaseQueryRelatedHydrationObservation[],
): void {
  const state = databaseDependencyCollector.getStore()
  if (!state) {
    return
  }

  for (let index = state.queries.length - 1; index >= 0; index -= 1) {
    const query = state.queries[index]
    if (!query || query.result !== source) {
      continue
    }

    state.queries[index] = Object.freeze({
      aggregate: undefined,
      belongsToHydrations: belongsToHydrations ?? query.belongsToHydrations,
      connectionName: query.connectionName,
      tableName: query.tableName,
      cursorRowCount: pagination.rowCount,
      cursorRows: pagination.rows,
      dependencies: query.dependencies,
      limit: pagination.perPage,
      offset: undefined,
      orderBy: query.orderBy,
      patchable: query.patchable,
      pagination: undefined,
      predicates: query.predicates,
      relation: query.relation,
      result: data,
      resultPath: query.resultPath,
      relatedHydrations: relatedHydrations ?? query.relatedHydrations,
      scalarColumn: undefined,
      scalarListColumn: undefined,
      scalarListRows: undefined,
      selections: query.selections,
    })
    state.queries.push(Object.freeze({
      aggregate: undefined,
      belongsToHydrations: undefined,
      connectionName: query.connectionName,
      tableName: query.tableName,
      dependencies: query.dependencies,
      limit: undefined,
      offset: undefined,
      orderBy: query.orderBy,
      patchable: query.patchable,
      pagination,
      predicates: query.predicates,
      relation: query.relation,
      result: meta.nextCursor,
      resultPath: Object.freeze(['nextCursor']),
      relatedHydrations: undefined,
      scalarColumn: undefined,
      scalarListColumn: undefined,
      scalarListRows: undefined,
      selections: query.selections,
    }))
    return
  }
}

export function disableDatabaseQueryObservationPatching(source: unknown): void {
  const state = databaseDependencyCollector.getStore()
  if (!state) {
    return
  }

  for (let index = state.queries.length - 1; index >= 0; index -= 1) {
    const query = state.queries[index]
    if (!query || query.result !== source) {
      continue
    }

    state.queries[index] = Object.freeze({
      aggregate: query.aggregate,
      belongsToHydrations: query.belongsToHydrations,
      connectionName: query.connectionName,
      tableName: query.tableName,
      dependencies: query.dependencies,
      limit: query.limit,
      offset: query.offset,
      orderBy: query.orderBy,
      patchable: false,
      pagination: query.pagination,
      predicates: query.predicates,
      relation: query.relation,
      result: query.result,
      resultPath: query.resultPath,
      relatedHydrations: query.relatedHydrations,
      scalarColumn: query.scalarColumn,
      scalarListColumn: query.scalarListColumn,
      scalarListRows: query.scalarListRows,
      selections: query.selections,
    })
    return
  }
}

export function rebindDatabaseQueryObservationAggregate(
  source: unknown,
  result: unknown,
  aggregate: DatabaseQueryAggregateObservation,
): void {
  rebindDatabaseQueryObservation(source, result, aggregate)
}

export function rebindDatabaseQueryObservationScalar(
  source: unknown,
  result: unknown,
  column: string,
): void {
  rebindDatabaseQueryObservation(source, result, undefined, column)
}

export function rebindDatabaseQueryObservationScalarList(
  rows: readonly Readonly<Record<string, unknown>>[],
  result: readonly unknown[],
  column: string,
): void {
  rebindDatabaseQueryObservation(rows, result, undefined, undefined, column, rows)
}

function rebindDatabaseQueryObservation(
  source: unknown,
  result: unknown,
  aggregate?: DatabaseQueryAggregateObservation,
  scalarColumn?: string,
  scalarListColumn?: string,
  scalarListRows?: readonly Readonly<Record<string, unknown>>[],
  belongsToHydrations?: readonly DatabaseQueryBelongsToHydrationObservation[],
  relatedHydrations?: readonly DatabaseQueryRelatedHydrationObservation[],
): void {
  const state = databaseDependencyCollector.getStore()
  if (!state) {
    return
  }

  for (let index = state.queries.length - 1; index >= 0; index -= 1) {
    const query = state.queries[index]
    if (!query || query.result !== source) {
      continue
    }

    state.queries[index] = Object.freeze({
      aggregate,
      belongsToHydrations,
      connectionName: query.connectionName,
      tableName: query.tableName,
      dependencies: query.dependencies,
      limit: query.limit,
      offset: query.offset,
      orderBy: query.orderBy,
      patchable: query.patchable,
      pagination: query.pagination,
      predicates: query.predicates,
      relation: query.relation,
      result,
      resultPath: query.resultPath,
      relatedHydrations,
      scalarColumn,
      scalarListColumn,
      scalarListRows,
      selections: query.selections,
    })
    return
  }
}

export function hasDatabaseDependencyInvalidationListeners(): boolean {
  const listeners = getQueryCacheBridgeState().dependencyInvalidationListeners
  return typeof listeners !== 'undefined' && listeners.size > 0
}

async function notifyDatabaseDependencyInvalidationListeners(
  event: DatabaseDependencyInvalidationEventInternal,
): Promise<void> {
  const listeners = getQueryCacheBridgeState().dependencyInvalidationListeners
  if (!listeners || listeners.size === 0) {
    return
  }

  await Promise.all([...listeners].map(async (listener) => {
    try {
      await listener(event)
    } catch (error) {
      console.error('[@holo-js/db] Database dependency invalidation listener failed.', error)
    }
  }))
}

export function normalizeQueryCacheConfig(
  input: QueryCacheTtlInput | QueryCacheConfig,
): NormalizedQueryCacheConfig {
  if (typeof input === 'number' || input instanceof Date) {
    return Object.freeze({
      ttl: input,
    })
  }

  const ttl = input.ttl
  const flexible = input.flexible
  if (typeof ttl === 'undefined' && typeof flexible === 'undefined') {
    throw new ConfigurationError('[@holo-js/db] Query cache config requires "ttl" or "flexible".')
  }

  if (typeof ttl !== 'undefined' && typeof flexible !== 'undefined') {
    throw new ConfigurationError('[@holo-js/db] Query cache config cannot define both "ttl" and "flexible".')
  }

  const key = input.key?.trim()
  if (typeof input.key !== 'undefined' && !key) {
    throw new ConfigurationError('[@holo-js/db] Query cache keys must be non-empty strings.')
  }

  const driver = input.driver?.trim()
  if (typeof input.driver !== 'undefined' && !driver) {
    throw new ConfigurationError('[@holo-js/db] Query cache driver names must be non-empty strings.')
  }

  const invalidate = input.invalidate
    ? Object.freeze(input.invalidate.map((dependency) => {
        const normalized = dependency.trim()
        if (!normalized) {
          throw new ConfigurationError('[@holo-js/db] Query cache invalidation dependencies must be non-empty strings.')
        }
        return normalized
      }))
    : undefined

  return Object.freeze({
    ttl,
    key,
    driver,
    flexible,
    invalidate,
  })
}

export function createDeterministicQueryCacheKey(
  statement: CompiledStatement,
  connectionName: string,
): string {
  const digest = createHash('sha256').update(JSON.stringify({
    connectionName,
    sql: statement.sql,
    bindings: statement.bindings ?? [],
  })).digest('hex')

  return `db:query:${digest}`
}

export function resolveQueryCacheKey(
  statement: CompiledStatement,
  connectionName: string,
  config: NormalizedQueryCacheConfig,
): string {
  return config.key ?? createDeterministicQueryCacheKey(statement, connectionName)
}

export function createTableCacheDependency(
  connectionName: string,
  tableName: string,
): string {
  return `db:${connectionName}:${tableName}`
}

function encodeDependencyValue(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value))
}

function createPredicateMetadata(
  connectionName: string,
  tableName: string,
  columnName: string,
  value: unknown,
): DatabaseDependencyPredicateMetadata | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  return Object.freeze({
    tableKey: createTableCacheDependency(connectionName, tableName),
    columnName: getColumnName(columnName),
    encodedValue: encodeDependencyValue(value),
  })
}

function createPredicateDependencyFromMetadata(
  metadata: DatabaseDependencyPredicateMetadata,
  exact: boolean,
): string {
  return `${metadata.tableKey}:${exact ? WHERE_EXACT_DEPENDENCY_PREFIX : WHERE_DEPENDENCY_PREFIX}${metadata.columnName}:${metadata.encodedValue}`
}

function createPredicateDependencyEntry(
  connectionName: string,
  tableName: string,
  columnName: string,
  value: unknown,
  exact = false,
): DatabaseDependencyPredicateEntry | undefined {
  const metadata = createPredicateMetadata(connectionName, tableName, columnName, value)
  if (!metadata) {
    return undefined
  }

  return {
    dependency: createPredicateDependencyFromMetadata(metadata, exact),
    metadata,
  }
}

function readExactPredicateValues(predicate: QueryPredicateNode): readonly unknown[] {
  if (predicate.kind !== 'comparison') {
    return Object.freeze([])
  }

  if (predicate.operator === '=') {
    return Object.freeze([predicate.value])
  }

  if (predicate.operator === 'in' && Array.isArray(predicate.value)) {
    return Object.freeze([...predicate.value])
  }

  return Object.freeze([])
}

export function createTableRowCacheDependency(
  connectionName: string,
  tableName: string,
  columnName: string,
  value: unknown,
): string | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  return `db:${connectionName}:${tableName}:row:${columnName}:${encodeDependencyValue(value)}`
}

export function createTableRowWildcardCacheDependency(
  connectionName: string,
  tableName: string,
): string {
  return `db:${connectionName}:${tableName}:row:*`
}

export function createTablePredicateCacheDependency(
  connectionName: string,
  tableName: string,
  columnName: string,
  value: unknown,
): string | undefined {
  return createPredicateDependencyEntry(connectionName, tableName, columnName, value)?.dependency
}

function createTableMutationCacheDependency(
  connectionName: string,
  tableName: string,
): string {
  return `db:${connectionName}:${tableName}:mutation`
}

function createTableExactPredicateCacheDependency(
  connectionName: string,
  tableName: string,
  columnName: string,
  value: unknown,
): string | undefined {
  return createPredicateDependencyEntry(connectionName, tableName, columnName, value, true)?.dependency
}

function parseDatabaseDependency(dependency: string): { readonly suffix?: string, readonly tableKey: string } | undefined {
  if (!dependency.startsWith(DATABASE_DEPENDENCY_PREFIX)) {
    return undefined
  }

  const connectionEnd = dependency.indexOf(':', DATABASE_DEPENDENCY_PREFIX.length)
  if (connectionEnd <= DATABASE_DEPENDENCY_PREFIX.length) {
    return undefined
  }

  const tableStart = connectionEnd + 1
  const tableEnd = dependency.indexOf(':', tableStart)
  if (tableEnd < 0) {
    return tableStart === dependency.length
      ? undefined
      : { tableKey: dependency }
  }

  if (tableEnd === tableStart) {
    return undefined
  }

  const suffixStart = tableEnd + 1
  return {
    suffix: suffixStart === dependency.length ? '' : dependency.slice(suffixStart),
    tableKey: dependency.slice(0, tableEnd),
  }
}

function parsePredicateDependencySuffix(
  tableKey: string,
  suffix: string,
  prefix: string,
): DatabaseDependencyPredicateMetadata | undefined {
  if (!suffix.startsWith(prefix)) {
    return undefined
  }

  const columnStart = prefix.length
  const valueSeparator = suffix.indexOf(':', columnStart)
  if (valueSeparator <= columnStart || valueSeparator === suffix.length - 1) {
    return undefined
  }

  return Object.freeze({
    tableKey,
    columnName: suffix.slice(columnStart, valueSeparator),
    encodedValue: suffix.slice(valueSeparator + 1),
  })
}

function createDatabaseDependencyInvalidationMetadata(
  dependencies: readonly string[],
  mutations: readonly DatabaseMutationEvent[],
): DatabaseDependencyInvalidationMetadata {
  const directDependencies: string[] = []
  const exactPredicates: DatabaseDependencyPredicateMetadata[] = []
  const predicates: DatabaseDependencyPredicateMetadata[] = []
  const tableDependencyCandidates: string[] = []
  let hasMutationDependency = mutations.some(mutation => mutation.kind === 'upsert')
  for (const dependency of dependencies) {
    const parsed = parseDatabaseDependency(dependency)
    if (!parsed) {
      directDependencies.push(dependency)
      continue
    }

    if (parsed.suffix === undefined) {
      tableDependencyCandidates.push(parsed.tableKey)
      continue
    }

    if (parsed.suffix === MUTATION_DEPENDENCY_SUFFIX) {
      hasMutationDependency = true
      directDependencies.push(dependency)
      continue
    }

    const exactPredicate = parsePredicateDependencySuffix(
      parsed.tableKey,
      parsed.suffix,
      WHERE_EXACT_DEPENDENCY_PREFIX,
    )
    if (exactPredicate) {
      exactPredicates.push(exactPredicate)
      directDependencies.push(dependency)
      continue
    }

    const predicate = parsePredicateDependencySuffix(
      parsed.tableKey,
      parsed.suffix,
      WHERE_DEPENDENCY_PREFIX,
    )
    if (predicate) {
      predicates.push(predicate)
      directDependencies.push(dependency)
      continue
    }

    directDependencies.push(dependency)
  }

  const exactPredicateTables = new Set(exactPredicates.map(predicate => predicate.tableKey))
  const tableDependencies: string[] = []
  for (const tableKey of tableDependencyCandidates) {
    if (exactPredicateTables.has(tableKey)) {
      tableDependencies.push(tableKey)
      continue
    }

    directDependencies.push(tableKey)
  }

  return Object.freeze({
    directDependencies: Object.freeze(directDependencies),
    exactPredicates: Object.freeze(exactPredicates),
    hasMutationDependency,
    predicates: Object.freeze(predicates),
    tableDependencies: Object.freeze(tableDependencies),
  })
}

function createDatabaseDependencyInvalidationEvent(
  connectionName: string,
  dependencies: readonly string[],
  mutations: readonly DatabaseMutationEvent[],
  metadata?: DatabaseDependencyInvalidationMetadata,
): DatabaseDependencyInvalidationEventInternal {
  const event: DatabaseDependencyInvalidationEventInternal = {
    connectionName,
    dependencies,
    mutations,
  }

  Object.defineProperty(event, DATABASE_DEPENDENCY_METADATA_KEY, {
    configurable: false,
    enumerable: false,
    value: metadata ?? createDatabaseDependencyInvalidationMetadata(dependencies, mutations),
    writable: false,
  })

  return Object.freeze(event)
}

export function normalizeQueryCacheDependencies(
  connectionName: string,
  dependencies: readonly string[],
): readonly string[] {
  return Object.freeze(dependencies.map((dependency) => {
    return dependency.startsWith('db:')
      ? dependency
      : createTableCacheDependency(connectionName, dependency)
  }))
}

function supportsAutomaticPredicateInvalidation(predicate: QueryPredicateNode): boolean {
  switch (predicate.kind) {
    case 'comparison':
    case 'column':
    case 'null':
    case 'date':
    case 'json':
    case 'fulltext':
    case 'vector':
      return true
    case 'group':
      return predicate.predicates.every(child => supportsAutomaticPredicateInvalidation(child))
    case 'exists':
    case 'subquery':
    case 'raw':
      return false
    default:
      return false
  }
}

function getColumnName(column: string): string {
  const segments = column.split('.')
  return segments[segments.length - 1] ?? column
}

function getPrimaryKeyColumn(plan: SelectQueryPlan): string {
  const columns = plan.source.table?.columns
  if (!columns) {
    return 'id'
  }

  return Object.values(columns).find(column => column.primaryKey)?.name ?? 'id'
}

function hasDisjunctivePredicate(predicates: readonly QueryPredicateNode[]): boolean {
  return predicates.some((predicate) => {
    if (predicate.boolean === 'or') {
      return true
    }

    if (predicate.kind !== 'group') {
      return false
    }

    return predicate.negated === true || hasDisjunctivePredicate(predicate.predicates)
  })
}

function findExactPrimaryKeyValue(
  predicates: readonly QueryPredicateNode[],
  primaryKeyColumn: string,
): unknown | undefined {
  for (const predicate of predicates) {
    if (predicate.kind === 'comparison' && predicate.operator === '=' && getColumnName(predicate.column) === primaryKeyColumn) {
      return predicate.value
    }

    if (predicate.kind === 'group' && !predicate.negated && predicate.boolean !== 'or') {
      const value = findExactPrimaryKeyValue(predicate.predicates, primaryKeyColumn)
      if (typeof value !== 'undefined') {
        return value
      }
    }
  }

  return undefined
}

function collectExactPredicateDependencies(
  predicates: readonly QueryPredicateNode[],
  connectionName: string,
  tableName: string,
  exact = false,
): readonly string[] {
  const dependencies = new Set<string>()
  for (const predicate of predicates) {
    const values = readExactPredicateValues(predicate)
    if (values.length > 0 && predicate.kind === 'comparison') {
      for (const value of values) {
        const dependency = exact
          ? createTableExactPredicateCacheDependency(
              connectionName,
              tableName,
              getColumnName(predicate.column),
              value,
            )
          : createTablePredicateCacheDependency(
              connectionName,
              tableName,
              getColumnName(predicate.column),
              value,
            )
        if (dependency) {
          dependencies.add(dependency)
        }
      }
      continue
    }

    if (predicate.kind === 'group' && !predicate.negated && predicate.boolean !== 'or') {
      for (const dependency of collectExactPredicateDependencies(predicate.predicates, connectionName, tableName, exact)) {
        dependencies.add(dependency)
      }
    }
  }

  return Object.freeze([...dependencies])
}

function appendExactPredicateDependencyEntries(
  target: Map<string, DatabaseDependencyPredicateEntry>,
  predicates: readonly QueryPredicateNode[],
  connectionName: string,
  tableName: string,
  exact = false,
): void {
  for (const predicate of predicates) {
    const values = readExactPredicateValues(predicate)
    if (values.length > 0 && predicate.kind === 'comparison') {
      for (const value of values) {
        const entry = createPredicateDependencyEntry(
          connectionName,
          tableName,
          getColumnName(predicate.column),
          value,
          exact,
        )
        if (entry) {
          target.set(entry.dependency, entry)
        }
      }
      continue
    }

    if (predicate.kind === 'group' && !predicate.negated && predicate.boolean !== 'or') {
      appendExactPredicateDependencyEntries(target, predicate.predicates, connectionName, tableName, exact)
    }
  }
}

function collectRecordPredicateDependencies(
  connectionName: string,
  tableName: string,
  record: Readonly<Record<string, unknown>>,
  exact = false,
): readonly string[] {
  const dependencies = new Set<string>()
  for (const [columnName, value] of Object.entries(record)) {
    const dependency = exact
      ? createTableExactPredicateCacheDependency(connectionName, tableName, getColumnName(columnName), value)
      : createTablePredicateCacheDependency(connectionName, tableName, getColumnName(columnName), value)
    if (dependency) {
      dependencies.add(dependency)
    }
  }

  return Object.freeze([...dependencies])
}

function appendRecordPredicateDependencyEntries(
  target: Map<string, DatabaseDependencyPredicateEntry>,
  connectionName: string,
  tableName: string,
  record: Readonly<Record<string, unknown>>,
  exact = false,
): void {
  for (const [columnName, value] of Object.entries(record)) {
    const entry = createPredicateDependencyEntry(connectionName, tableName, getColumnName(columnName), value, exact)
    if (entry) {
      target.set(entry.dependency, entry)
    }
  }
}

function createInvalidationMetadataFromParts(
  directDependencies: readonly string[],
  exactPredicates: readonly DatabaseDependencyPredicateMetadata[],
  predicates: readonly DatabaseDependencyPredicateMetadata[],
  tableDependencyCandidates: readonly string[],
  hasMutationDependency: boolean,
): DatabaseDependencyInvalidationMetadata {
  const exactPredicateTables = new Set(exactPredicates.map(predicate => predicate.tableKey))
  const nextDirectDependencies = [...directDependencies]
  const tableDependencies: string[] = []
  for (const tableKey of tableDependencyCandidates) {
    if (exactPredicateTables.has(tableKey)) {
      tableDependencies.push(tableKey)
      continue
    }

    nextDirectDependencies.push(tableKey)
  }

  return Object.freeze({
    directDependencies: Object.freeze(nextDirectDependencies),
    exactPredicates: Object.freeze([...exactPredicates]),
    hasMutationDependency,
    predicates: Object.freeze([...predicates]),
    tableDependencies: Object.freeze(tableDependencies),
  })
}

function collectQueryPredicateObservations(predicates: readonly QueryPredicateNode[]): readonly DatabaseQueryPredicateObservation[] {
  const observations: DatabaseQueryPredicateObservation[] = []
  for (const predicate of predicates) {
    if (predicate.kind === 'comparison') {
      observations.push(Object.freeze({
        column: getColumnName(predicate.column),
        operator: predicate.operator,
        value: predicate.value,
      }))
      continue
    }

    if (predicate.kind === 'group' && !predicate.negated && predicate.boolean !== 'or') {
      observations.push(...collectQueryPredicateObservations(predicate.predicates))
    }
  }

  return Object.freeze(observations)
}

function collectQueryOrderObservations(plan: SelectQueryPlan): readonly DatabaseQueryOrderObservation[] {
  return Object.freeze(plan.orderBy.flatMap((order) => {
    if (order.kind !== 'column') {
      return []
    }

    return [Object.freeze({
      column: getColumnName(order.column),
      direction: order.direction,
    })]
  }))
}

function collectQuerySelectionObservations(plan: SelectQueryPlan): readonly DatabaseQuerySelectionObservation[] {
  return Object.freeze(plan.selections.flatMap((selection) => {
    if (selection.kind !== 'column') {
      return []
    }

    const column = getColumnName(selection.column)
    return [Object.freeze({
      column,
      resultKey: selection.alias ?? column,
    })]
  }))
}

function isPatchablePredicateObservation(predicate: QueryPredicateNode): boolean {
  if (predicate.kind === 'comparison' && predicate.boolean !== 'or') {
    return true
  }

  if (predicate.kind !== 'group' || predicate.negated || predicate.boolean === 'or') {
    return false
  }

  return predicate.predicates.every(child => isPatchablePredicateObservation(child))
}

function isColumnSelection(selection: QuerySelection): selection is Extract<QuerySelection, { readonly kind: 'column' }> {
  return selection.kind === 'column'
}

function hasRequiredProjectionSelection(
  selections: readonly DatabaseQuerySelectionObservation[],
  column: string,
): boolean {
  return selections.some(selection => selection.column === column && selection.resultKey === column)
}

function isExactPrimaryKeySingleResultProjection(plan: SelectQueryPlan): boolean {
  return plan.limit === 1
    && typeof findExactPrimaryKeyValue(plan.predicates, getPrimaryKeyColumn(plan)) !== 'undefined'
}

function isPatchableProjectionObservation(
  plan: SelectQueryPlan,
  selections: readonly DatabaseQuerySelectionObservation[],
  predicates: readonly DatabaseQueryPredicateObservation[],
  orderBy: readonly DatabaseQueryOrderObservation[],
): boolean {
  if (plan.selections.length === 0) {
    return true
  }

  if (plan.selections.every(selection => selection.kind === 'aggregate')) {
    return true
  }

  if (!plan.selections.every(selection => isColumnSelection(selection))) {
    return false
  }

  const needsProjectedPrimaryKey = !isExactPrimaryKeySingleResultProjection(plan)
  const requiredColumns = new Set<string>([
    ...orderBy.map(order => order.column),
  ])
  if (needsProjectedPrimaryKey) {
    requiredColumns.add(getPrimaryKeyColumn(plan))
  }

  for (const column of requiredColumns) {
    if (!hasRequiredProjectionSelection(selections, column)) {
      return false
    }
  }

  return true
}

function isPatchableOffsetObservation(
  plan: SelectQueryPlan,
  orderBy: readonly DatabaseQueryOrderObservation[],
): boolean {
  return typeof plan.offset === 'undefined'
    || (
      typeof plan.limit === 'number'
      && plan.offset > 0
      && orderBy.length > 0
    )
}

function findGroupedAggregateObservation(
  plan: SelectQueryPlan,
  averageStates?: readonly DatabaseQueryGroupedAverageStateObservation[],
  aggregateStates?: readonly DatabaseQueryGroupedAggregateStateObservation[],
): DatabaseQueryGroupedAggregateObservation | undefined {
  if (
    plan.groupBy.length !== 1
    || plan.selections.length !== 2
  ) {
    return undefined
  }

  const groupColumn = getColumnName(plan.groupBy[0]!)
  const groupSelection = plan.selections.find((selection): selection is Extract<QuerySelection, { readonly kind: 'column' }> => {
    return selection.kind === 'column' && getColumnName(selection.column) === groupColumn
  })
  const aggregateSelection = plan.selections.find((selection): selection is Extract<QuerySelection, { readonly kind: 'aggregate' }> => {
    return selection.kind === 'aggregate'
      && (
        (selection.aggregate === 'count' && selection.column === '*')
        || (selection.aggregate === 'avg' && selection.column !== '*')
        || (selection.aggregate === 'sum' && selection.column !== '*')
        || (selection.aggregate === 'min' && selection.column !== '*')
        || (selection.aggregate === 'max' && selection.column !== '*')
      )
  })
  if (!groupSelection || !aggregateSelection) {
    return undefined
  }

  const orderBy = collectQueryOrderObservations(plan)
  if (orderBy.some(order => order.column !== groupColumn)) {
    return undefined
  }

  const aggregateKind = aggregateSelection.aggregate === 'count'
    ? 'count'
    : aggregateSelection.aggregate
  const having = readGroupedCountHavingObservation(plan)
  if (plan.having.length > 0 && !isSupportedGroupedCountHaving(plan)) {
    return undefined
  }

  const groupedAggregate = {
    aggregateColumn: aggregateKind === 'count' ? undefined : getColumnName(aggregateSelection.column),
    aggregateResultKey: aggregateSelection.alias,
    ...((aggregateKind === 'count' || aggregateKind === 'sum' || aggregateKind === 'min' || aggregateKind === 'max') && aggregateStates
      ? { aggregateStates: Object.freeze([...aggregateStates]) }
      : {}),
    ...(aggregateKind === 'avg' && averageStates ? { averageStates: Object.freeze([...averageStates]) } : {}),
    groupColumn,
    groupResultKey: groupSelection.alias ?? groupColumn,
    having,
    kind: aggregateKind,
  } satisfies DatabaseQueryGroupedAggregateObservation

  return Object.freeze(groupedAggregate)
}

function isSupportedGroupedCountHaving(plan: SelectQueryPlan): boolean {
  if (plan.having.length === 0) {
    return true
  }

  if (plan.groupBy.length === 0 || plan.having.length !== 1) {
    return false
  }

  const clause = plan.having[0]
  return typeof clause !== 'undefined'
    && clause.expression.replace(/\s+/g, '').toLowerCase() === 'count(*)'
    && typeof clause.value === 'number'
    && Number.isFinite(clause.value)
    && isGroupedCountHavingOperator(clause.operator)
}

function readGroupedCountHavingObservation(
  plan: SelectQueryPlan,
): DatabaseQueryGroupedAggregateHavingObservation | undefined {
  if (!isSupportedGroupedCountHaving(plan) || hasOnlyRedundantGroupedCountHaving(plan)) {
    return undefined
  }

  const clause = plan.having[0]
  if (
    !clause
    || !isGroupedCountHavingOperator(clause.operator)
    || typeof clause.value !== 'number'
    || !Number.isFinite(clause.value)
  ) {
    return undefined
  }

  return Object.freeze({
    operator: clause.operator,
    value: clause.value,
  })
}

function isGroupedCountHavingOperator(
  operator: QueryOperator,
): operator is Extract<QueryOperator, '<' | '<=' | '=' | '>' | '>='> {
  return operator === '<'
    || operator === '<='
    || operator === '='
    || operator === '>'
    || operator === '>='
}

function hasOnlyRedundantGroupedCountHaving(plan: SelectQueryPlan): boolean {
  if (plan.having.length === 0) {
    return true
  }

  if (plan.groupBy.length === 0 || plan.having.length !== 1) {
    return false
  }

  const clause = plan.having[0]
  return typeof clause !== 'undefined'
    && clause.expression.replace(/\s+/g, '').toLowerCase() === 'count(*)'
    && clause.operator === '>='
    && clause.value === 1
}

function isPatchableGroupedAggregateObservation(plan: SelectQueryPlan): boolean {
  return supportsAutomaticQueryCacheInvalidation(plan)
    && Boolean(findGroupedAggregateObservation(plan))
    && !plan.distinct
    && !plan.lockMode
    && !plan.source.alias
    && plan.joins.length === 0
    && typeof plan.limit === 'undefined'
    && typeof plan.offset === 'undefined'
    && plan.unions.length === 0
    && plan.orderBy.every(order => order.kind === 'column')
    && plan.predicates.every(predicate => isPatchablePredicateObservation(predicate))
}

function isPatchableQueryObservation(plan: SelectQueryPlan): boolean {
  const predicates = collectQueryPredicateObservations(plan.predicates)
  const orderBy = collectQueryOrderObservations(plan)
  const selections = collectQuerySelectionObservations(plan)

  return isPatchableGroupedAggregateObservation(plan)
    || (supportsAutomaticQueryCacheInvalidation(plan)
    && !plan.distinct
    && !plan.lockMode
    && !plan.source.alias
    && plan.groupBy.length === 0
    && plan.having.length === 0
    && plan.joins.length === 0
    && isPatchableOffsetObservation(plan, orderBy)
    && isPatchableProjectionObservation(plan, selections, predicates, orderBy)
    && plan.unions.length === 0
    && plan.orderBy.every(order => order.kind === 'column')
    && plan.predicates.every(predicate => isPatchablePredicateObservation(predicate)))
}

function appendObservableQueryDependencies(
  plan: SelectQueryPlan,
  connectionName: string,
  dependencies: Set<string>,
  seen: Set<SelectQueryPlan>,
): void {
  if (seen.has(plan)) {
    return
  }

  seen.add(plan)
  dependencies.add(createTableCacheDependency(connectionName, plan.source.tableName))
  for (const join of plan.joins) {
    if (join.table) {
      dependencies.add(createTableCacheDependency(connectionName, join.table))
    }
    if (join.subquery) {
      appendObservableQueryDependencies(join.subquery, connectionName, dependencies, seen)
    }
  }

  for (const union of plan.unions) {
    appendObservableQueryDependencies(union.query, connectionName, dependencies, seen)
  }

  for (const selection of plan.selections) {
    if (selection.kind === 'subquery') {
      appendObservableQueryDependencies(selection.query, connectionName, dependencies, seen)
    }
  }

  for (const predicate of plan.predicates) {
    appendObservablePredicateDependencies(predicate, connectionName, dependencies, seen)
  }
}

function appendObservablePredicateDependencies(
  predicate: QueryPredicateNode,
  connectionName: string,
  dependencies: Set<string>,
  seen: Set<SelectQueryPlan>,
): void {
  if (predicate.kind === 'group') {
    for (const child of predicate.predicates) {
      appendObservablePredicateDependencies(child, connectionName, dependencies, seen)
    }
    return
  }

  if (predicate.kind === 'exists' || predicate.kind === 'subquery') {
    appendObservableQueryDependencies(predicate.subquery, connectionName, dependencies, seen)
  }
}

function hasObservationDependencyFallbackPredicate(predicate: QueryPredicateNode): boolean {
  if (predicate.kind === 'group') {
    return predicate.predicates.some(child => hasObservationDependencyFallbackPredicate(child))
  }

  return predicate.kind === 'exists'
    || predicate.kind === 'subquery'
    || predicate.kind === 'raw'
    || predicate.kind === 'vector'
    || predicate.kind === 'fulltext'
}

function hasObservationDependencyFallbackShape(plan: SelectQueryPlan): boolean {
  return plan.joins.length > 0
    || plan.unions.length > 0
    || !isSupportedGroupedCountHaving(plan)
    || plan.selections.some(selection => selection.kind === 'raw' || selection.kind === 'subquery')
    || plan.orderBy.some(order => order.kind === 'raw')
    || plan.predicates.some(predicate => hasObservationDependencyFallbackPredicate(predicate))
}

export function inferDatabaseQueryObservationDependencies(
  plan: SelectQueryPlan,
  connectionName: string,
): readonly string[] | undefined {
  if (!hasObservationDependencyFallbackShape(plan)) {
    return undefined
  }

  const dependencies = new Set<string>()
  appendObservableQueryDependencies(plan, connectionName, dependencies, new Set())
  return Object.freeze([...dependencies])
}

function createDatabaseQueryObservationFromPlan(
  plan: SelectQueryPlan,
  connectionName: string,
  dependencies: readonly string[],
  result?: unknown,
  patchable = isPatchableQueryObservation(plan),
  groupedAverageStates?: readonly DatabaseQueryGroupedAverageStateObservation[],
  groupedAggregateStates?: readonly DatabaseQueryGroupedAggregateStateObservation[],
): DatabaseQueryObservation | undefined {
  return Object.freeze({
    connectionName,
    belongsToHydrations: undefined,
    relatedHydrations: undefined,
    tableName: plan.source.tableName,
    dependencies: Object.freeze([...dependencies]),
    groupedAggregate: findGroupedAggregateObservation(plan, groupedAverageStates, groupedAggregateStates),
    limit: plan.limit,
    offset: plan.offset,
    orderBy: collectQueryOrderObservations(plan),
    patchable,
    pagination: undefined,
    predicates: collectQueryPredicateObservations(plan.predicates),
    result,
    selections: collectQuerySelectionObservations(plan),
  })
}

export function createDatabaseQueryObservation(
  plan: SelectQueryPlan,
  connectionName: string,
  dependencies: readonly string[],
  result?: unknown,
  groupedAverageStates?: readonly DatabaseQueryGroupedAverageStateObservation[],
  groupedAggregateStates?: readonly DatabaseQueryGroupedAggregateStateObservation[],
): DatabaseQueryObservation | undefined {
  if (!supportsAutomaticQueryCacheInvalidation(plan)) {
    return undefined
  }

  return createDatabaseQueryObservationFromPlan(
    plan,
    connectionName,
    dependencies,
    result,
    undefined,
    groupedAverageStates,
    groupedAggregateStates,
  )
}

export function createDatabaseQueryFallbackObservation(
  plan: SelectQueryPlan,
  connectionName: string,
  dependencies: readonly string[],
  result?: unknown,
): DatabaseQueryObservation | undefined {
  if (dependencies.length === 0) {
    return undefined
  }

  return createDatabaseQueryObservationFromPlan(plan, connectionName, dependencies, result, false)
}

export function createDatabaseMutationEvent(
  kind: DatabaseMutationEvent['kind'],
  connectionName: string,
  tableName: string,
  predicates: readonly QueryPredicateNode[] = [],
  values?: Readonly<Record<string, unknown>>,
  rows?: readonly Readonly<Record<string, unknown>>[],
  previousRows?: readonly Readonly<Record<string, unknown>>[],
): DatabaseMutationEvent {
  return Object.freeze({
    connectionName,
    tableName,
    kind,
    predicates: collectQueryPredicateObservations(predicates),
    previousRows: previousRows ? Object.freeze([...previousRows]) : undefined,
    rows: rows ? Object.freeze([...rows]) : undefined,
    values,
  })
}

export function supportsAutomaticQueryCacheInvalidation(plan: SelectQueryPlan): boolean {
  if (plan.joins.length > 0 || plan.unions.length > 0 || !isSupportedGroupedCountHaving(plan)) {
    return false
  }

  if (plan.selections.some(selection => selection.kind === 'raw' || selection.kind === 'subquery')) {
    return false
  }

  if (plan.orderBy.some(order => order.kind === 'raw')) {
    return false
  }

  return plan.predicates.every(predicate => supportsAutomaticPredicateInvalidation(predicate))
}

export function inferAutomaticQueryCacheDependencies(
  plan: SelectQueryPlan,
  connectionName: string,
): readonly string[] | undefined {
  if (!supportsAutomaticQueryCacheInvalidation(plan)) {
    return undefined
  }

  if (!hasDisjunctivePredicate(plan.predicates)) {
    const primaryKeyColumn = getPrimaryKeyColumn(plan)
    const primaryKeyValue = findExactPrimaryKeyValue(plan.predicates, primaryKeyColumn)
    const primaryKeyDependency = createTableRowCacheDependency(
      connectionName,
      plan.source.tableName,
      primaryKeyColumn,
      primaryKeyValue,
    )
    if (primaryKeyDependency) {
      return Object.freeze([
        primaryKeyDependency,
        createTableRowWildcardCacheDependency(connectionName, plan.source.tableName),
      ])
    }
  }

  if (!hasDisjunctivePredicate(plan.predicates)) {
    const predicateDependencies = collectExactPredicateDependencies(
      plan.predicates,
      connectionName,
      plan.source.tableName,
    )
    if (predicateDependencies.length > 0) {
      return Object.freeze([
        createTableCacheDependency(connectionName, plan.source.tableName),
        ...predicateDependencies,
      ])
    }
  }

  return Object.freeze([
    createTableCacheDependency(connectionName, plan.source.tableName),
  ])
}

export function inferAutomaticQueryCacheInvalidationDependencies(
  plan: SelectQueryPlan,
  connectionName: string,
  values: Readonly<Record<string, unknown>> = {},
): readonly string[] {
  return inferAutomaticQueryCacheInvalidationPlan(plan, connectionName, values).dependencies
}

export function inferAutomaticQueryCacheInvalidationPlan(
  plan: SelectQueryPlan,
  connectionName: string,
  values: Readonly<Record<string, unknown>> = {},
  includeMetadata = false,
): DatabaseDependencyInvalidationPlan {
  const tableKey = createTableCacheDependency(connectionName, plan.source.tableName)
  const dependencies = [tableKey]
  if (hasDisjunctivePredicate(plan.predicates)) {
    dependencies.push(createTableRowWildcardCacheDependency(connectionName, plan.source.tableName))
    return Object.freeze({
      dependencies: Object.freeze(dependencies),
      metadata: includeMetadata
        ? createInvalidationMetadataFromParts(
            dependencies,
            Object.freeze([]),
            Object.freeze([]),
            Object.freeze([]),
            false,
          )
        : undefined,
    })
  }

  const directDependencies: string[] = []
  const exactPredicates: DatabaseDependencyPredicateMetadata[] = []
  const predicates: DatabaseDependencyPredicateMetadata[] = []
  const mutationDependency = createTableMutationCacheDependency(connectionName, plan.source.tableName)
  dependencies.push(mutationDependency)
  directDependencies.push(mutationDependency)
  const primaryKeyColumn = getPrimaryKeyColumn(plan)
  const primaryKeyValue = findExactPrimaryKeyValue(plan.predicates, primaryKeyColumn)
  const primaryKeyDependency = createTableRowCacheDependency(
    connectionName,
    plan.source.tableName,
    primaryKeyColumn,
    primaryKeyValue,
  )
  const rowDependency = primaryKeyDependency ?? createTableRowWildcardCacheDependency(connectionName, plan.source.tableName)
  dependencies.push(rowDependency)
  directDependencies.push(rowDependency)

  if (includeMetadata) {
    const predicateEntries = new Map<string, DatabaseDependencyPredicateEntry>()
    appendExactPredicateDependencyEntries(predicateEntries, plan.predicates, connectionName, plan.source.tableName)
    for (const entry of predicateEntries.values()) {
      dependencies.push(entry.dependency)
      directDependencies.push(entry.dependency)
      predicates.push(entry.metadata)
    }

    const exactPredicateEntries = new Map<string, DatabaseDependencyPredicateEntry>()
    appendExactPredicateDependencyEntries(exactPredicateEntries, plan.predicates, connectionName, plan.source.tableName, true)
    for (const entry of exactPredicateEntries.values()) {
      dependencies.push(entry.dependency)
      directDependencies.push(entry.dependency)
      exactPredicates.push(entry.metadata)
    }

    const recordPredicateEntries = new Map<string, DatabaseDependencyPredicateEntry>()
    appendRecordPredicateDependencyEntries(recordPredicateEntries, connectionName, plan.source.tableName, values)
    for (const entry of recordPredicateEntries.values()) {
      dependencies.push(entry.dependency)
      directDependencies.push(entry.dependency)
      predicates.push(entry.metadata)
    }

    const exactRecordPredicateEntries = new Map<string, DatabaseDependencyPredicateEntry>()
    appendRecordPredicateDependencyEntries(exactRecordPredicateEntries, connectionName, plan.source.tableName, values, true)
    for (const entry of exactRecordPredicateEntries.values()) {
      dependencies.push(entry.dependency)
      directDependencies.push(entry.dependency)
      exactPredicates.push(entry.metadata)
    }

    return Object.freeze({
      dependencies: Object.freeze(dependencies),
      metadata: createInvalidationMetadataFromParts(
        directDependencies,
        exactPredicates,
        predicates,
        Object.freeze([tableKey]),
        true,
      ),
    })
  }

  dependencies.push(...collectExactPredicateDependencies(plan.predicates, connectionName, plan.source.tableName))
  dependencies.push(...collectExactPredicateDependencies(plan.predicates, connectionName, plan.source.tableName, true))
  dependencies.push(...collectRecordPredicateDependencies(connectionName, plan.source.tableName, values))
  dependencies.push(...collectRecordPredicateDependencies(connectionName, plan.source.tableName, values, true))
  return Object.freeze({
    dependencies: Object.freeze(dependencies),
  })
}

export function inferAutomaticInsertCacheInvalidationDependencies(
  connectionName: string,
  tableName: string,
  rows: readonly Readonly<Record<string, unknown>>[],
  lastInsertId?: number | string,
): readonly string[] {
  return inferAutomaticInsertCacheInvalidationPlan(connectionName, tableName, rows, lastInsertId).dependencies
}

export function inferAutomaticInsertCacheInvalidationPlan(
  connectionName: string,
  tableName: string,
  rows: readonly Readonly<Record<string, unknown>>[],
  lastInsertId?: number | string,
  includeMetadata = false,
): DatabaseDependencyInvalidationPlan {
  const tableKey = createTableCacheDependency(connectionName, tableName)
  const dependencies = new Set<string>([
    tableKey,
  ])
  const directDependencies = new Set<string>()
  const exactPredicates = new Map<string, DatabaseDependencyPredicateEntry>()
  const predicates = new Map<string, DatabaseDependencyPredicateEntry>()
  for (const row of rows) {
    const dependency = createTableRowCacheDependency(connectionName, tableName, 'id', row.id)
    if (dependency) {
      dependencies.add(dependency)
      directDependencies.add(dependency)
    }

    if (includeMetadata) {
      const rowPredicateEntries = new Map<string, DatabaseDependencyPredicateEntry>()
      appendRecordPredicateDependencyEntries(rowPredicateEntries, connectionName, tableName, row)
      for (const entry of rowPredicateEntries.values()) {
        dependencies.add(entry.dependency)
        directDependencies.add(entry.dependency)
        predicates.set(entry.dependency, entry)
      }

      const rowExactPredicateEntries = new Map<string, DatabaseDependencyPredicateEntry>()
      appendRecordPredicateDependencyEntries(rowExactPredicateEntries, connectionName, tableName, row, true)
      for (const entry of rowExactPredicateEntries.values()) {
        dependencies.add(entry.dependency)
        directDependencies.add(entry.dependency)
        exactPredicates.set(entry.dependency, entry)
      }
      continue
    }

    for (const dependency of collectRecordPredicateDependencies(connectionName, tableName, row)) {
      dependencies.add(dependency)
    }
    for (const dependency of collectRecordPredicateDependencies(connectionName, tableName, row, true)) {
      dependencies.add(dependency)
    }
  }
  const lastInsertDependency = createTableRowCacheDependency(connectionName, tableName, 'id', lastInsertId)
  if (lastInsertDependency) {
    dependencies.add(lastInsertDependency)
    directDependencies.add(lastInsertDependency)
  }

  if (dependencies.size === 1) {
    const rowWildcardDependency = createTableRowWildcardCacheDependency(connectionName, tableName)
    dependencies.add(rowWildcardDependency)
    directDependencies.add(rowWildcardDependency)
  }

  return Object.freeze({
    dependencies: Object.freeze([...dependencies]),
    metadata: includeMetadata
      ? createInvalidationMetadataFromParts(
          [...directDependencies],
          [...exactPredicates.values()].map(entry => entry.metadata),
          [...predicates.values()].map(entry => entry.metadata),
          Object.freeze([tableKey]),
          false,
        )
      : undefined,
  })
}

export function resolveQueryCacheDependencies(
  plan: SelectQueryPlan,
  connectionName: string,
  explicit?: readonly string[],
): readonly string[] | undefined {
  if (explicit && explicit.length > 0) {
    return normalizeQueryCacheDependencies(connectionName, explicit)
  }

  return inferAutomaticQueryCacheDependencies(plan, connectionName)
}

export async function invalidateQueryCacheDependencies(
  connection: DatabaseContext,
  dependencies: readonly string[],
  mutations: readonly DatabaseMutationEvent[] = [],
  plan?: { readonly metadata?: DatabaseDependencyInvalidationMetadata },
): Promise<void> {
  if (dependencies.length === 0) {
    return
  }

  const invalidate = async () => {
    const bridge = getDatabaseQueryCacheBridge()
    await bridge?.invalidateDependencies(dependencies)
    if (hasDatabaseDependencyInvalidationListeners()) {
      await notifyDatabaseDependencyInvalidationListeners(
        createDatabaseDependencyInvalidationEvent(connection.getConnectionName(), dependencies, mutations, plan?.metadata),
      )
    }
  }

  if (connection.getScope().kind === 'root') {
    await invalidate()
    return
  }

  connection.afterCommit(invalidate)
}

export const queryCacheInternals = {
  collectDatabaseQueryDependencies: collectDatabaseQueryDependenciesInternal,
  configureDatabaseQueryCacheBridge,
  createDatabaseMutationEvent,
  createDatabaseQueryObservation,
  createDeterministicQueryCacheKey,
  createTablePredicateCacheDependency,
  createTableCacheDependency,
  createTableRowCacheDependency,
  createTableRowWildcardCacheDependency,
  getQueryCacheBridgeState,
  hasActiveDatabaseDependencyCollector,
  hasDatabaseDependencyInvalidationListeners,
  inferAutomaticInsertCacheInvalidationDependencies,
  inferAutomaticInsertCacheInvalidationPlan,
  inferAutomaticQueryCacheDependencies,
  inferAutomaticQueryCacheInvalidationDependencies,
  inferAutomaticQueryCacheInvalidationPlan,
  normalizeQueryCacheConfig,
  normalizeQueryCacheDependencies,
  notifyDatabaseDependencyInvalidationListeners,
  disableDatabaseQueryObservationPatching,
  rebindDatabaseQueryObservationResult,
  rebindDatabaseQueryObservationScalar,
  rebindDatabaseQueryObservationScalarList,
  onDatabaseDependencyInvalidated,
  recordDatabaseQueryDependencies,
  recordDatabaseQueryObservation,
  resolveQueryCacheDependencies,
  resolveQueryCacheKey,
  resetDatabaseDependencyInvalidationListeners,
  supportsAutomaticPredicateInvalidation,
  supportsAutomaticQueryCacheInvalidation,
}
