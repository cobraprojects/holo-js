import { reportError } from '@holo-js/kernel/error-reporting'
import { getRootDatabaseContext } from './core/contextOwnership'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ConfigurationError } from './core/errors'
import type { DatabaseContext } from './core/DatabaseContext'
import type { CompiledStatement } from './core/types'
import { getConnectionGeneratedTableDefinition } from './schema/generated'
import { coerceBoolean, isStoredBoolean, readsAsInteger } from './schema/normalization'
import { failsIntegerRead, readCanonicalInteger } from './query/resultColumns'
import { listTablePrimaryKeyColumns } from './schema/tablePrimaryKey'
import type { CaseInsensitiveColumns, TextColumnCollations } from './schema/caseInsensitiveColumns'
import type { QueryOperator, QueryPredicateNode, QuerySelection, QuerySource, SelectQueryPlan } from './query/ast'
import type { TableDefinition } from './schema/types'
import { canonicalTableName } from './schema/tableIdentityRegistry'

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
  invalidateDependencyTables?(
    tables: readonly string[],
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

export interface RemoteDatabaseDependencyInvalidation {
  readonly id: string
  readonly connectionName: string
  readonly dependencies: readonly string[]
}

type DatabaseDependencyInvalidationPublisherCandidate = {
  readonly publisher: DatabaseDependencyInvalidationPublisher
}

type DatabaseDependencyInvalidationPublisher = (
  invalidation: RemoteDatabaseDependencyInvalidation,
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
  readonly absoluteSum?: number
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
  readonly groupColumn: string
  readonly groupResultKey: string
  readonly integerColumn?: true
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
  readonly rowCount: number | null
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
  readonly rowCountKnown?: boolean
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
  readonly cursorRowCountKnown?: boolean
  readonly cursorRows?: readonly Readonly<Record<string, unknown>>[]
  readonly tableName: string
  readonly table?: TableDefinition
  readonly dependencies: readonly string[]
  readonly emptyRecordValue?: null
  readonly groupedAggregate?: DatabaseQueryGroupedAggregateObservation
  readonly limit?: number
  readonly offset?: number
  readonly orderBy: readonly DatabaseQueryOrderObservation[]
  readonly patchable: boolean
  readonly pagination?: DatabaseQueryPaginationObservation
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
  readonly primaryKey?: string
  readonly relation?: DatabaseQueryRelationObservation
  readonly result?: unknown
  readonly resultPath?: readonly DatabaseQueryResultPathSegment[]
  readonly observedResult?: DatabaseQueryObservedResult
  readonly serializedSources?: readonly unknown[]
  readonly scalarColumn?: string
  readonly scalarListColumn?: string
  readonly scalarListRows?: readonly Readonly<Record<string, unknown>>[]
  readonly relatedHydrations?: readonly DatabaseQueryRelatedHydrationObservation[]
  readonly selections: readonly DatabaseQuerySelectionObservation[]
  readonly serialized?: boolean
}

export interface DatabaseQueryObservedResult {
  readonly list: boolean
  readonly values: readonly unknown[]
  readonly fields: readonly (Readonly<Record<string, unknown>> | undefined)[]
}

export interface DatabaseQueryBelongsToHydrationObservation {
  readonly foreignKey: string
  readonly ownerKey: string
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
  readonly primaryKey?: string
  readonly relationKey: string
  readonly relatedConnectionName: string
  readonly relatedTableName: string
  readonly relatedTable?: TableDefinition
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
  readonly relatedTable?: TableDefinition
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
  readonly relatedTable?: TableDefinition
}

export interface DatabaseQueryBelongsToParentKeyRelationObservation {
  readonly foreignKey: string
  readonly kind: 'belongsToParentKey'
  readonly ownerKey: string
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
  readonly relationKey: string
  readonly relatedConnectionName: string
  readonly relatedTableName: string
  readonly relatedTable?: TableDefinition
}

export interface DatabaseMutationEvent {
  readonly connectionName: string
  readonly tableName: string
  readonly kind: 'insert' | 'update' | 'delete' | 'upsert'
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
  readonly previousRows?: readonly Readonly<Record<string, unknown>>[]
  readonly primaryKey?: string
  readonly rows?: readonly Readonly<Record<string, unknown>>[]
  readonly values?: Readonly<Record<string, unknown>>
  readonly convertedColumns?: readonly string[]
}

type DatabaseDependencyPredicateMetadata = {
  readonly tableKey: string
  readonly columnName: string
  readonly encodedValue: string
}

type DatabaseDependencyInvalidationMetadata = {
  readonly contextId?: number
  readonly directDependencies: readonly string[]
  readonly exactPredicates: readonly DatabaseDependencyPredicateMetadata[]
  readonly hasMutationDependency: boolean
  readonly predicates: readonly DatabaseDependencyPredicateMetadata[]
  readonly publicationStartedAt?: number
  readonly tableDependencies: readonly string[]
  readonly unordered?: true
}

type MutationPublicationRecord = {
  readonly identities?: ReadonlySet<string>
  readonly publishedAt: number
  readonly tableKey: string
}

type MutationPublicationState = {
  prunedThrough: number
  readonly records: MutationPublicationRecord[]
  sequence: number
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
  readonly contexts: ReadonlyMap<string, ReadonlySet<number>>
  readonly queries: readonly DatabaseQueryObservation[]
}

type DatabaseDependencyInvalidationPlan = {
  readonly dependencies: readonly string[]
  readonly metadata?: DatabaseDependencyInvalidationMetadata
}

type LiteralExpansion = (column: string, value: unknown) => readonly unknown[]

export type QueryTextMatching = boolean | TextColumnCollations

type DatabaseDependencyPredicateEntry = {
  readonly dependency: string
  readonly metadata: DatabaseDependencyPredicateMetadata
}

type DatabaseDependencyCollectorState = {
  readonly contexts: Map<string, Set<number>>
  readonly dependencies: Set<string>
  readonly queries: DatabaseQueryObservation[]
  readonly observedResults: WeakMap<object, DatabaseQueryObservedResult>
  readonly serializedResults: WeakMap<object, unknown>
  readonly refreshQueries: DatabaseQueryObservation[]
  readonly refreshTables: Map<string, DatabaseQueryObservation | undefined>
  readonly arraySnapshots: Map<readonly unknown[], readonly unknown[]>
  serializationOverridden: boolean
}

const DATABASE_DEPENDENCY_PREFIX = 'db:'
const DATABASE_DEPENDENCY_METADATA_KEY = '__holoDatabaseDependencyMetadata__'
const MUTATION_DEPENDENCY_SUFFIX = 'mutation'
const WHERE_DEPENDENCY_PREFIX = 'where:'
const WHERE_EXACT_DEPENDENCY_PREFIX = 'where-exact:'
const EMPTY_COLUMNS: ReadonlySet<string> = new Set<string>()
const MUTATION_PUBLICATION_RETENTION = 1024
const MUTATION_PUBLICATION_IDENTITY_LIMIT = 1024
const PREDICATE_WILDCARD_VALUE = '*'
const IDENTITY_EXPANSION: LiteralExpansion = (_column, value) => [value]
const SQLITE_ROWID_ALIASES: ReadonlySet<string> = new Set(['rowid', '_rowid_', 'oid'])
const NUMERIC_TEXT_PATTERN = /^\s*[+-]?(?:(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:e[+-]?\d[\d_]*)?|0x[\da-f_]+|0o[0-7_]+|0b[01_]+|nan|inf(?:inity)?)\s*$/i

const databaseDependencyCollector = new AsyncLocalStorage<DatabaseDependencyCollectorState>()
const refreshOnlyObservationIndexes = new AsyncLocalStorage<Set<number>>()
const refreshOnlyObservations = new WeakSet<DatabaseQueryObservation>()
const refreshOnlyTables = new AsyncLocalStorage<Set<string>>()

type MutationPreviousRowsRequirement = (connectionName: string, tableName: string, columns: readonly string[]) => boolean

function getQueryCacheBridgeState(): {
  bridge?: DatabaseQueryCacheBridge
  dependencyInvalidationListeners?: Set<DatabaseDependencyInvalidationListenerInternal>
  dependencyInvalidationPublishers?: DatabaseDependencyInvalidationPublisherCandidate[]
  mutationPreviousRowsRequirements?: Map<DatabaseDependencyInvalidationListenerInternal, MutationPreviousRowsRequirement>
  mutationPublications?: MutationPublicationState
  recentDatabaseInvalidationIds?: Map<string, number>
} {
  const runtime = globalThis as typeof globalThis & {
    __holoDbQueryCacheBridge__?: {
      bridge?: DatabaseQueryCacheBridge
      dependencyInvalidationListeners?: Set<DatabaseDependencyInvalidationListenerInternal>
      dependencyInvalidationPublishers?: DatabaseDependencyInvalidationPublisherCandidate[]
      mutationPreviousRowsRequirements?: Map<DatabaseDependencyInvalidationListenerInternal, MutationPreviousRowsRequirement>
      mutationPublications?: MutationPublicationState
      recentDatabaseInvalidationIds?: Map<string, number>
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
  if (state.dependencyInvalidationListeners.size === 0) {
    startMutationPublicationEpoch()
  }
  state.dependencyInvalidationListeners.add(internalListener)

  return () => {
    state.dependencyInvalidationListeners?.delete(internalListener)
    state.mutationPreviousRowsRequirements?.delete(internalListener)
  }
}

function onDatabaseDependencyInvalidationPublished(publisher: DatabaseDependencyInvalidationPublisher): () => void {
  const state = getQueryCacheBridgeState()
  const candidate: DatabaseDependencyInvalidationPublisherCandidate = { publisher }
  state.dependencyInvalidationPublishers = [...(state.dependencyInvalidationPublishers ?? []), candidate]

  return () => {
    state.dependencyInvalidationPublishers = state.dependencyInvalidationPublishers?.filter(entry => entry !== candidate)
  }
}

export function resetDatabaseDependencyInvalidationListeners(): void {
  getQueryCacheBridgeState().dependencyInvalidationListeners = undefined
  getQueryCacheBridgeState().mutationPreviousRowsRequirements = undefined
}

function getMutationPublicationState(): MutationPublicationState {
  return getQueryCacheBridgeState().mutationPublications ??= { prunedThrough: 0, records: [], sequence: 0 }
}

function markMutationPublicationBoundary(): number {
  const state = getMutationPublicationState()
  state.sequence += 1
  return state.sequence
}

function startMutationPublicationEpoch(): void {
  const state = getMutationPublicationState()
  state.sequence += 1
  state.prunedThrough = state.sequence
}

function beginMutationPublication(): number | undefined {
  return hasDatabaseDependencyInvalidationListeners()
    ? getQueryCacheBridgeState().mutationPublications?.sequence ?? 0
    : undefined
}

function createMutationPublicationTableKey(tableKey: string): string {
  const tableStart = tableKey.indexOf(':', DATABASE_DEPENDENCY_PREFIX.length) + 1
  const tableName = tableKey.slice(tableStart)
  return tableKey.slice(0, tableStart) + tableName.slice(tableName.lastIndexOf('.') + 1).toLowerCase()
}

function normalizeMutationPublicationIdentity(value: unknown): string | undefined {
  if (typeof value === 'number' || typeof value === 'bigint') return String(Number(value))
  if (typeof value !== 'string') {
    return JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item) ?? String(value)
  }
  if (!NUMERIC_TEXT_PATTERN.test(value)) return value.trimEnd().toLowerCase()
  const numeric = Number(value.trim())
  return Number.isNaN(numeric) ? undefined : String(numeric)
}

function readMutationPublicationIdentities(mutation: DatabaseMutationEvent): ReadonlySet<string> | undefined {
  const primaryKey = mutation.primaryKey
  const rows = [...(mutation.rows ?? []), ...(mutation.previousRows ?? [])]
  if (
    !primaryKey
    || rows.length === 0
    || rows.length > MUTATION_PUBLICATION_IDENTITY_LIMIT
    || (mutation.values && Object.prototype.hasOwnProperty.call(mutation.values, primaryKey))
  ) {
    return undefined
  }

  const identities = new Set<string>()
  for (const row of rows) {
    const value = row[primaryKey]
    const identity = value === undefined || value === null ? undefined : normalizeMutationPublicationIdentity(value)
    if (identity === undefined) return undefined
    identities.add(identity)
  }
  return identities
}

function mutationPublicationsOverlap(left: ReadonlySet<string> | undefined, right: ReadonlySet<string> | undefined): boolean {
  if (!left || !right) return true
  for (const identity of left) {
    if (right.has(identity)) return true
  }
  return false
}

function hasOverlappingMutationPublication(
  published: readonly MutationPublicationRecord[],
  records: readonly Omit<MutationPublicationRecord, 'publishedAt'>[],
  startedAt: number,
): boolean {
  for (let index = published.length - 1; index >= 0; index -= 1) {
    const candidate = published[index]
    if (!candidate || candidate.publishedAt <= startedAt) return false
    if (records.some(record => record.tableKey === candidate.tableKey && mutationPublicationsOverlap(record.identities, candidate.identities))) {
      return true
    }
  }
  return false
}

function recordMutationPublications(records: readonly Omit<MutationPublicationRecord, 'publishedAt'>[], startedAt: number | undefined): boolean {
  const state = getMutationPublicationState()
  const ordered = startedAt !== undefined
    && startedAt >= state.prunedThrough
    && !hasOverlappingMutationPublication(state.records, records, startedAt)

  for (const record of records) {
    state.sequence += 1
    state.records.push({ ...record, publishedAt: state.sequence })
  }
  const overflow = state.records.length - MUTATION_PUBLICATION_RETENTION
  if (overflow > 0) {
    const pruned = state.records.splice(0, overflow)
    state.prunedThrough = Math.max(state.prunedThrough, pruned[pruned.length - 1]?.publishedAt ?? 0)
  }
  return ordered
}

function recordDatabaseMutationPublication(mutations: readonly DatabaseMutationEvent[], startedAt: number | undefined): boolean {
  return recordMutationPublications(mutations.map(mutation => ({
    identities: readMutationPublicationIdentities(mutation),
    tableKey: createMutationPublicationTableKey(createTableCacheDependency(mutation.connectionName, mutation.tableName)),
  })), startedAt)
}

function recordRemoteMutationPublication(dependencies: readonly string[]): void {
  const records: Omit<MutationPublicationRecord, 'publishedAt'>[] = []
  for (const dependency of dependencies) {
    const tableKey = parseDatabaseDependency(dependency)?.tableKey
    if (tableKey !== undefined) records.push({ tableKey: createMutationPublicationTableKey(tableKey) })
  }
  if (records.length > 0) {
    recordMutationPublications(records, undefined)
  }
}

function setMutationPreviousRowsRequirement(listener: DatabaseDependencyInvalidationListener, requirement: MutationPreviousRowsRequirement): void {
  const state = getQueryCacheBridgeState()
  state.mutationPreviousRowsRequirements ??= new Map()
  state.mutationPreviousRowsRequirements.set(listener as DatabaseDependencyInvalidationListenerInternal, requirement)
}

function requiresMutationPreviousRows(connectionName: string, tableName: string, columns: readonly string[]): boolean {
  const requirements = getQueryCacheBridgeState().mutationPreviousRowsRequirements
  if (!requirements) return false
  const canonicalName = canonicalTableName(connectionName, tableName)
  for (const requirement of requirements.values()) {
    if (requirement(connectionName, canonicalName, columns)) return true
  }
  return false
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
    contexts: new Map(),
    dependencies: new Set<string>(),
    queries: [],
    observedResults: new WeakMap(),
    serializedResults: new WeakMap(),
    refreshQueries: [],
    refreshTables: new Map(),
    arraySnapshots: new Map(),
    serializationOverridden: false,
  }
  const value = await databaseDependencyCollector.run(state, callback)
  if (hasChangedArraySnapshot(state)) {
    databaseDependencyCollector.run(state, markDatabaseQueryObservationsSerialized)
  }

  return Object.freeze({
    value,
    contexts: state.contexts,
    dependencies: Object.freeze([...state.dependencies]),
    queries: Object.freeze([...state.queries.map(query => withObservedResult(state, query)), ...state.refreshQueries]),
  })
}

function rememberObservedResult(state: DatabaseDependencyCollectorState, query: DatabaseQueryObservation | undefined): void {
  const result = query?.result
  if (result && typeof result === 'object' && state.observedResults.has(result)) {
    return
  }

  if (Array.isArray(result)) {
    state.observedResults.set(result, observeResultValues(true, [...result]))
  } else if (readObservedFields(result)) {
    state.observedResults.set(result as object, observeResultValues(false, [result]))
  }
}

function observeResultValues(list: boolean, values: readonly unknown[]): DatabaseQueryObservedResult {
  return Object.freeze({
    list,
    values: Object.freeze(values),
    fields: Object.freeze(values.map(value => {
      const fields = readObservedFields(value)
      return fields ? Object.freeze({ ...fields }) : undefined
    })),
  })
}

function readObservedFields(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (isPlainResultRecord(value)) {
    return value
  }

  return isAttributeRecord(value) ? value.toAttributes() : undefined
}

function isAttributeRecord(value: unknown): value is { toAttributes(): Readonly<Record<string, unknown>> } {
  return Boolean(value) && typeof value === 'object' && typeof (value as { toAttributes?: unknown }).toAttributes === 'function'
}

function isPlainResultRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasObservedResultChanged(observed: DatabaseQueryObservedResult, result: unknown): boolean {
  const values = observed.list ? result : [result]
  if (!Array.isArray(values) || values.length !== observed.values.length) {
    return true
  }

  return observed.values.some((value, index) => !Object.is(value, values[index]) || hasObservedFieldsChanged(observed.fields[index], value))
}

function hasObservedFieldsChanged(fields: Readonly<Record<string, unknown>> | undefined, value: unknown): boolean {
  const current = fields ? readObservedFields(value) : undefined
  if (!fields || !current) {
    return false
  }

  const keys = Object.keys(fields)
  return keys.length !== Object.keys(current).length
    || keys.some(key => !Object.hasOwn(current, key) || !Object.is(fields[key], current[key]))
}

function withObservedResult(state: DatabaseDependencyCollectorState, query: DatabaseQueryObservation): DatabaseQueryObservation {
  const observedResult = query.result && typeof query.result === 'object' ? state.observedResults.get(query.result) : undefined
  return observedResult ? Object.freeze({ ...query, observedResult }) : query
}

export function hasActiveDatabaseDependencyCollector(): boolean {
  return typeof databaseDependencyCollector.getStore() !== 'undefined'
}

type QueryCacheSource = <TSource>(source: () => TSource | Promise<TSource>) => TSource | Promise<TSource>

export function runQueryCacheOperation<TValue>(
  operation: (runSource: QueryCacheSource) => TValue | Promise<TValue>,
): TValue | Promise<TValue> {
  const collector = databaseDependencyCollector.getStore()
  const runSource: QueryCacheSource = source => (
    collector ? databaseDependencyCollector.run(collector, source) : source()
  )
  return databaseDependencyCollector.exit(() => operation(runSource))
}

export function recordDatabaseQueryDependencies(dependencies: readonly string[] | undefined): void {
  if (!dependencies || dependencies.length === 0) {
    return
  }

  const state = databaseDependencyCollector.getStore()
  if (!state) {
    return
  }

  const tables = refreshOnlyTables.getStore()
  for (const dependency of dependencies) {
    state.dependencies.add(dependency)
    const tableKey = tables ? parseDatabaseDependency(dependency)?.tableKey : undefined
    if (tableKey) tables!.add(tableKey)
  }
}

export function recordDatabaseQueryRefreshTables(dependencies: readonly string[], connectionName: string, tableName: string): void {
  const state = databaseDependencyCollector.getStore()
  if (!state) {
    return
  }

  const ownTable = createTableCacheDependency(connectionName, tableName)
  for (const dependency of dependencies) {
    const tableKey = parseDatabaseDependency(dependency)?.tableKey
    if (!tableKey || tableKey === ownTable || (state.refreshTables.has(tableKey) && hasTableRefreshObservation(state, tableKey))) {
      continue
    }

    const observation = tableRefreshObservation(state, tableKey)
    state.refreshTables.set(tableKey, observation)
    pushDatabaseQueryObservation(state, observation)
  }
}

function hasTableRefreshObservation(state: DatabaseDependencyCollectorState, tableKey: string): boolean {
  const observation = state.refreshTables.get(tableKey)
  return !observation || state.queries.includes(observation)
}

function tableRefreshObservation(state: DatabaseDependencyCollectorState, tableKey: string): DatabaseQueryObservation {
  state.dependencies.add(`${tableKey}:${WHERE_DEPENDENCY_PREFIX}${PREDICATE_WILDCARD_VALUE}:${PREDICATE_WILDCARD_VALUE}`)
  const connectionEnd = tableKey.indexOf(':', DATABASE_DEPENDENCY_PREFIX.length)
  return Object.freeze({
    connectionName: tableKey.slice(DATABASE_DEPENDENCY_PREFIX.length, connectionEnd),
    dependencies: Object.freeze([tableKey]),
    orderBy: Object.freeze([]),
    patchable: false,
    predicates: Object.freeze([]),
    selections: Object.freeze([]),
    serialized: true,
    tableName: tableKey.slice(connectionEnd + 1),
  })
}

export function recordDatabaseQueryContext(connection: DatabaseContext): void {
  const state = databaseDependencyCollector.getStore()
  if (!state) return
  const name = connection.getConnectionName()
  const contexts = state.contexts.get(name) ?? new Set<number>()
  contexts.add(connection.getContextId())
  state.contexts.set(name, contexts)
}

export function recordDatabaseQueryObservation(observation: DatabaseQueryObservation | undefined): void {
  if (!observation) {
    return
  }

  const state = databaseDependencyCollector.getStore()
  if (!state) {
    return
  }

  pushDatabaseQueryObservation(state, state.serializationOverridden ? serializedQueryObservation(observation) : observation)
}

function pushDatabaseQueryObservation(state: DatabaseDependencyCollectorState, observation: DatabaseQueryObservation): void {
  state.queries.push(observation)
  rememberObservedResult(state, observation)
  refreshOnlyObservationIndexes.getStore()?.add(state.queries.length - 1)
}

function serializedQueryObservation(observation: DatabaseQueryObservation): DatabaseQueryObservation {
  return Object.freeze({
    ...observation,
    patchable: false,
    serialized: true,
  })
}

export function readDatabaseQueryObservationCount(): number {
  return databaseDependencyCollector.getStore()?.queries.length ?? 0
}

export async function runRequiringDatabaseQueryRefresh<TValue>(load: () => Promise<TValue>): Promise<TValue> {
  const state = databaseDependencyCollector.getStore()
  if (!state) {
    return await load()
  }

  const indexes = new Set<number>()
  const tables = new Set<string>()
  const value = await refreshOnlyTables.run(tables, () => refreshOnlyObservationIndexes.run(indexes, load))
  for (const index of indexes) {
    const query = state.queries[index]
    if (query) {
      replaceDatabaseQueryObservation(state, index, refreshOnlyQueryObservation(query))
    }
  }
  for (const tableKey of tables) {
    if (state.refreshTables.has(tableKey) && !state.refreshTables.get(tableKey)) {
      continue
    }

    state.refreshTables.set(tableKey, undefined)
    state.refreshQueries.push(tableRefreshObservation(state, tableKey))
  }

  return value
}

function refreshQueryObservation(observation: DatabaseQueryObservation): DatabaseQueryObservation {
  return Object.freeze({
    connectionName: observation.connectionName,
    dependencies: observation.dependencies,
    orderBy: observation.orderBy,
    patchable: false,
    predicates: observation.predicates,
    selections: observation.selections,
    serialized: true,
    tableName: observation.tableName,
    ...(observation.table ? { table: observation.table } : {}),
  })
}

function replaceDatabaseQueryObservation(state: DatabaseDependencyCollectorState, index: number, next: DatabaseQueryObservation): void {
  const current = state.queries[index]
  if (current && refreshOnlyObservations.has(current)) {
    refreshOnlyObservations.add(next)
  }
  state.queries[index] = next
  rememberObservedResult(state, next)
}

function refreshOnlyQueryObservation(observation: DatabaseQueryObservation): DatabaseQueryObservation {
  const refreshOnly = serializedQueryObservation(observation)
  refreshOnlyObservations.add(refreshOnly)
  return refreshOnly
}

export function truncateDatabaseQueryObservations(count: number): void {
  const state = databaseDependencyCollector.getStore()
  if (!state || count >= state.queries.length) {
    return
  }

  const length = Math.max(0, count)
  const indexes = refreshOnlyObservationIndexes.getStore()
  for (let index = length; index < state.queries.length; index += 1) {
    const query = state.queries[index]!
    if (refreshOnlyObservations.has(query) || indexes?.has(index)) {
      state.refreshQueries.push(refreshQueryObservation(query))
    }
  }
  state.queries.length = length
  if (indexes) {
    for (const index of indexes) {
      if (index >= length) {
        indexes.delete(index)
      }
    }
  }
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

    replaceDatabaseQueryObservation(state, index, Object.freeze({
      aggregate: undefined,
      belongsToHydrations: belongsToHydrations ?? query.belongsToHydrations,
      connectionName: query.connectionName,
      tableName: query.tableName,
      table: query.table,
      dependencies: query.dependencies,
      limit: pagination.perPage,
      offset,
      orderBy: query.orderBy,
      patchable: query.patchable,
      pagination: undefined,
      predicates: query.predicates,
      primaryKey: query.primaryKey,
      relation: query.relation,
      result: data,
      resultPath: query.resultPath,
      relatedHydrations: relatedHydrations ?? query.relatedHydrations,
      scalarColumn: undefined,
      scalarListColumn: undefined,
      scalarListRows: undefined,
      selections: query.selections,
      serialized: query.serialized,
    }))
    pushDatabaseQueryObservation(state, Object.freeze({
      aggregate: undefined,
      belongsToHydrations: undefined,
      connectionName: query.connectionName,
      tableName: query.tableName,
      table: query.table,
      dependencies: query.dependencies,
      limit: undefined,
      offset: undefined,
      orderBy: query.orderBy,
      patchable: query.patchable,
      pagination,
      predicates: query.predicates,
      primaryKey: query.primaryKey,
      relation: query.relation,
      result: meta,
      resultPath: undefined,
      relatedHydrations: undefined,
      scalarColumn: undefined,
      scalarListColumn: undefined,
      scalarListRows: undefined,
      selections: query.selections,
      serialized: query.serialized,
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

    replaceDatabaseQueryObservation(state, index, Object.freeze({
      aggregate: undefined,
      belongsToHydrations: belongsToHydrations ?? query.belongsToHydrations,
      connectionName: query.connectionName,
      tableName: query.tableName,
      table: query.table,
      cursorRowCount: pagination.rowCount,
      cursorRowCountKnown: pagination.rowCountKnown,
      cursorRows: pagination.rows,
      dependencies: query.dependencies,
      limit: pagination.perPage,
      offset: undefined,
      orderBy: query.orderBy,
      patchable: query.patchable,
      pagination: undefined,
      predicates: query.predicates,
      primaryKey: query.primaryKey,
      relation: query.relation,
      result: data,
      resultPath: query.resultPath,
      relatedHydrations: relatedHydrations ?? query.relatedHydrations,
      scalarColumn: undefined,
      scalarListColumn: undefined,
      scalarListRows: undefined,
      selections: query.selections,
      serialized: query.serialized,
    }))
    pushDatabaseQueryObservation(state, Object.freeze({
      aggregate: undefined,
      belongsToHydrations: undefined,
      connectionName: query.connectionName,
      tableName: query.tableName,
      table: query.table,
      dependencies: query.dependencies,
      limit: undefined,
      offset: undefined,
      orderBy: query.orderBy,
      patchable: query.patchable,
      pagination,
      predicates: query.predicates,
      primaryKey: query.primaryKey,
      relation: query.relation,
      result: meta.nextCursor,
      resultPath: Object.freeze(['nextCursor']),
      relatedHydrations: undefined,
      scalarColumn: undefined,
      scalarListColumn: undefined,
      scalarListRows: undefined,
      selections: query.selections,
      serialized: query.serialized,
    }))
    return
  }
}

export function disableDatabaseQueryObservationPatching(
  source: unknown,
  options: { readonly serialized?: boolean } = {},
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

    replaceDatabaseQueryObservation(state, index, Object.freeze({
      aggregate: query.aggregate,
      belongsToHydrations: query.belongsToHydrations,
      connectionName: query.connectionName,
      tableName: query.tableName,
      table: query.table,
      dependencies: query.dependencies,
      limit: query.limit,
      offset: query.offset,
      orderBy: query.orderBy,
      patchable: false,
      pagination: query.pagination,
      predicates: query.predicates,
      primaryKey: query.primaryKey,
      relation: query.relation,
      result: query.result,
      resultPath: query.resultPath,
      relatedHydrations: query.relatedHydrations,
      scalarColumn: query.scalarColumn,
      scalarListColumn: query.scalarListColumn,
      scalarListRows: query.scalarListRows,
      selections: query.selections,
      serialized: options.serialized || query.serialized,
    }))
    return
  }
}

function holdsLoadedRows(query: DatabaseQueryObservation, loadedRows: ReadonlySet<unknown>): boolean {
  return loadedRows.has(query.result) || (Array.isArray(query.result) && query.result.some(row => loadedRows.has(row)))
}

export function requireDatabaseQueryRefreshForRows(rows: readonly unknown[]): void {
  const state = databaseDependencyCollector.getStore()
  if (!state || rows.length === 0) {
    return
  }

  const loadedRows = new Set(rows)
  for (let index = 0; index < state.queries.length; index += 1) {
    const query = state.queries[index]
    if (!query || query.serialized || !holdsLoadedRows(query, loadedRows)) {
      continue
    }

    replaceDatabaseQueryObservation(state, index, refreshOnlyQueryObservation(query))
  }
}

export function rebindDatabaseQueryObservationSerializedResult(source: unknown, result: unknown): void {
  const state = databaseDependencyCollector.getStore()
  if (!state || !source || typeof source !== 'object') {
    return
  }

  const earlierResult = state.serializedResults.get(source)
  state.serializedResults.set(source, result)
  const observed = state.observedResults.get(source)
  const sourceChanged = observed ? hasObservedResultChanged(observed, source) : false
  for (let index = 0; index < state.queries.length; index += 1) {
    const query = state.queries[index]
    if (!query) {
      continue
    }

    if (earlierResult !== undefined && query.result === earlierResult && !query.serialized) {
      replaceDatabaseQueryObservation(state, index, refreshOnlyQueryObservation(query))
      continue
    }

    if (query.result === source && !sourceChanged) {
      replaceDatabaseQueryObservation(state, index, Object.freeze({ ...query, result, serializedSources: Object.freeze(Array.isArray(source) ? [source, ...source] : [source]) }))
    }
  }
}

export function markDatabaseQueryObservationsSerialized(): void {
  const state = databaseDependencyCollector.getStore()
  if (!state) {
    return
  }

  state.serializationOverridden = true
  for (let index = 0; index < state.queries.length; index += 1) {
    const query = state.queries[index]
    if (!query || query.serialized) {
      continue
    }

    replaceDatabaseQueryObservation(state, index, serializedQueryObservation(query))
  }
}

const ARRAY_WRITE_METHODS = ['copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift'] as const
const arrayWriteCollectors = new WeakMap<object, WeakSet<DatabaseDependencyCollectorState>>()

function markSerializedOnCollectedArrayWrite(array: object): void {
  const state = databaseDependencyCollector.getStore()
  if (state && arrayWriteCollectors.get(array)?.has(state)) {
    markDatabaseQueryObservationsSerialized()
  }
}

const arrayWriteMethods = Object.fromEntries(ARRAY_WRITE_METHODS.map((name) => {
  const write = Array.prototype[name] as (this: unknown[], ...args: unknown[]) => unknown
  const method = {
    [name](this: unknown[], ...args: unknown[]) {
      markSerializedOnCollectedArrayWrite(this)
      return write.apply(this, args)
    },
  }[name]!
  Object.defineProperty(method, 'length', { value: write.length })
  return [name, method]
})) as Readonly<Record<typeof ARRAY_WRITE_METHODS[number], (this: unknown[], ...args: unknown[]) => unknown>>

function snapshotArray(array: readonly unknown[]): readonly unknown[] {
  const values: unknown[] = []
  values.length = array.length
  for (let index = 0; index < array.length; index += 1) {
    if (Object.hasOwn(array, index)) {
      values[index] = array[index]
    }
  }

  return Object.freeze(values)
}

function hasChangedArraySnapshot(state: DatabaseDependencyCollectorState): boolean {
  for (const [array, values] of state.arraySnapshots) {
    if (array.length !== values.length) {
      return true
    }

    for (let index = 0; index < values.length; index += 1) {
      if (Object.hasOwn(values, index) !== Object.hasOwn(array, index) || !Object.is(values[index], array[index])) {
        return true
      }
    }
  }

  return false
}

export function serializeDatabaseQueryObservationsOnArrayWrites(array: unknown): void {
  const state = databaseDependencyCollector.getStore()
  if (!state || !Array.isArray(array) || Object.isFrozen(array)) {
    return
  }

  if (!state.arraySnapshots.has(array)) {
    state.arraySnapshots.set(array, snapshotArray(array))
  }

  if (!Object.isExtensible(array) || Object.getPrototypeOf(array) !== Array.prototype) {
    return
  }

  const collectors = arrayWriteCollectors.get(array)
  if (collectors) {
    collectors.add(state)
    return
  }

  if (ARRAY_WRITE_METHODS.some(name => Object.hasOwn(array, name))) {
    return
  }

  arrayWriteCollectors.set(array, new WeakSet([state]))
  for (const name of ARRAY_WRITE_METHODS) {
    Object.defineProperty(array, name, { configurable: true, enumerable: false, value: arrayWriteMethods[name], writable: true })
  }
}

export function createAverageAggregateObservation(
  column: string,
  values: readonly number[],
): DatabaseQueryAggregateObservation {
  let sum = 0
  let absoluteSum = 0
  for (const value of values) {
    sum += value
    absoluteSum += Math.abs(value)
    if (!Number.isSafeInteger(value) || !Number.isSafeInteger(absoluteSum)) {
      return Object.freeze({ column, kind: 'avg' })
    }
  }

  return Object.freeze({ absoluteSum, column, count: values.length, kind: 'avg', sum })
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

    replaceDatabaseQueryObservation(state, index, Object.freeze({
      aggregate,
      belongsToHydrations,
      connectionName: query.connectionName,
      tableName: query.tableName,
      table: query.table,
      dependencies: query.dependencies,
      limit: query.limit,
      offset: query.offset,
      orderBy: query.orderBy,
      patchable: query.patchable && !(aggregate?.column !== undefined && isBooleanColumn(query.table, aggregate.column)),
      pagination: query.pagination,
      predicates: query.predicates,
      primaryKey: query.primaryKey,
      relation: query.relation,
      result,
      resultPath: query.resultPath,
      relatedHydrations,
      scalarColumn,
      scalarListColumn,
      scalarListRows,
      selections: query.selections,
      serialized: query.serialized,
    }))
    return
  }
}

export function hasDatabaseDependencyInvalidationListeners(): boolean {
  const listeners = getQueryCacheBridgeState().dependencyInvalidationListeners
  return typeof listeners !== 'undefined' && listeners.size > 0
}

export function hasDatabaseDependencyInvalidationPublisher(): boolean {
  return (getQueryCacheBridgeState().dependencyInvalidationPublishers?.length ?? 0) > 0
}

const DATABASE_INVALIDATION_ID_TTL_MS = 60_000
const DATABASE_INVALIDATION_ID_LIMIT = 10_000

function rememberDatabaseInvalidationId(id: string): boolean {
  const state = getQueryCacheBridgeState()
  state.recentDatabaseInvalidationIds ??= new Map<string, number>()
  const recent = state.recentDatabaseInvalidationIds
  const now = Date.now()
  const seenAt = recent.get(id)
  if (seenAt !== undefined && now - seenAt < DATABASE_INVALIDATION_ID_TTL_MS) {
    return false
  }

  recent.delete(id)
  recent.set(id, now)
  for (const [recentId, recordedAt] of recent) {
    if (recent.size <= DATABASE_INVALIDATION_ID_LIMIT && now - recordedAt < DATABASE_INVALIDATION_ID_TTL_MS) {
      break
    }
    recent.delete(recentId)
  }
  return true
}

function publishDatabaseDependencyInvalidation(
  publisher: DatabaseDependencyInvalidationPublisher,
  invalidation: RemoteDatabaseDependencyInvalidation,
): void {
  void Promise.resolve()
    .then(() => publisher(invalidation))
    .catch((error: unknown) => {
      reportError(error, { capability: 'db', operation: 'cache.invalidationPublisher' })
    })
}

function serializeDatabaseDependencyInvalidation(
  event: DatabaseDependencyInvalidationEventInternal,
): RemoteDatabaseDependencyInvalidation {
  const tableDependencies = new Set<string>()
  for (const dependency of event.dependencies) {
    const tableKey = parseDatabaseDependency(dependency)?.tableKey
    if (tableKey !== undefined) {
      tableDependencies.add(tableKey)
    }
  }

  return Object.freeze({
    id: randomUUID(),
    connectionName: event.connectionName,
    dependencies: Object.freeze([...tableDependencies]),
  })
}

async function receiveRemoteDatabaseDependencyInvalidation(
  invalidation: RemoteDatabaseDependencyInvalidation,
): Promise<void> {
  if (invalidation.dependencies.length === 0 || !rememberDatabaseInvalidationId(invalidation.id)) {
    return
  }

  if (hasDatabaseDependencyInvalidationListeners()) {
    recordRemoteMutationPublication(invalidation.dependencies)
  }

  await evictThenNotify(
    () => getDatabaseQueryCacheBridge()?.invalidateDependencyTables?.(invalidation.dependencies),
    () => notifyDatabaseDependencyInvalidationListeners(Object.freeze({
      connectionName: invalidation.connectionName,
      dependencies: invalidation.dependencies,
      mutations: [],
    })),
  )
}

async function evictThenNotify(
  evict: () => Promise<void> | void,
  notify: () => Promise<void> | void,
): Promise<void> {
  try {
    await evict()
  } catch (error) {
    reportError(error, { capability: 'db', operation: 'cache.invalidateDependencies' })
  }
  await notify()
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
      reportError(error, { capability: 'db', operation: 'cache.invalidationListener' })
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
  const digest = createHash('sha256').update(stringifyQueryCacheKey({
    connectionName,
    sql: statement.sql,
    bindings: statement.bindings ?? [],
  })!).digest('hex')

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
  return `db:${connectionName}:${canonicalTableName(connectionName, tableName)}`
}

const INTEGER_MARKER = `integer:${randomUUID()}:`
const INTEGER_MARKER_PATTERN = new RegExp(`"${INTEGER_MARKER}(-?\\d+)(n?)"`, 'g')

function stringifyIntegers(value: unknown, exactNumbers: boolean): string | undefined {
  return JSON.stringify(value, (_key, element: unknown) => {
    if (typeof element === 'bigint') return `${INTEGER_MARKER}${element}n`
    return exactNumbers && typeof element === 'number' && Number.isInteger(element) && !Number.isSafeInteger(element)
      ? `${INTEGER_MARKER}${BigInt(element)}`
      : element
  })?.replace(INTEGER_MARKER_PATTERN, (_marker, digits: string, bigint: string) => exactNumbers ? digits : `${digits}${bigint}`)
}

function stringifyQueryCacheKey(value: unknown): string | undefined {
  return stringifyIntegers(value, false)
}

function encodeDependencyValue(value: unknown): string {
  return encodeURIComponent(stringifyIntegers(value, true)!)
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

  return `${createTableCacheDependency(connectionName, tableName)}:row:${columnName}:${encodeDependencyValue(value)}`
}

export function createTableRowWildcardCacheDependency(
  connectionName: string,
  tableName: string,
): string {
  return `${createTableCacheDependency(connectionName, tableName)}:row:*`
}

export function createTablePredicateCacheDependency(
  connectionName: string,
  tableName: string,
  columnName: string,
  value: unknown,
  textMatching: QueryTextMatching = false,
): string | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  return queryTextMayMatchOtherValues(getColumnName(columnName), value, textMatching)
    ? createTablePredicateWildcardCacheDependency(connectionName, tableName, columnName)
    : createPredicateDependencyEntry(connectionName, tableName, columnName, value)?.dependency
}

function createTablePredicateWildcardCacheDependency(
  connectionName: string,
  tableName: string,
  columnName: string,
): string {
  return `${createTableCacheDependency(connectionName, tableName)}:${WHERE_DEPENDENCY_PREFIX}${getColumnName(columnName)}:${PREDICATE_WILDCARD_VALUE}`
}

function createTableMutationCacheDependency(
  connectionName: string,
  tableName: string,
): string {
  return `${createTableCacheDependency(connectionName, tableName)}:mutation`
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
  connection: DatabaseContext,
  dependencies: readonly string[],
  mutations: readonly DatabaseMutationEvent[],
  metadata?: DatabaseDependencyInvalidationMetadata,
  publication: { readonly startedAt?: number, readonly unordered: boolean } = { unordered: false },
): DatabaseDependencyInvalidationEventInternal {
  const event: DatabaseDependencyInvalidationEventInternal = {
    connectionName: connection.getConnectionName(),
    dependencies,
    mutations,
  }

  Object.defineProperty(event, DATABASE_DEPENDENCY_METADATA_KEY, {
    configurable: false,
    enumerable: false,
    value: Object.freeze({
      ...(metadata ?? createDatabaseDependencyInvalidationMetadata(dependencies, mutations)),
      contextId: connection.getContextId(),
      ...(publication.startedAt === undefined ? {} : { publicationStartedAt: publication.startedAt }),
      ...(publication.unordered ? { unordered: true } : {}),
    }),
    writable: false,
  })

  return Object.freeze(event)
}

function replacedTableIdentityDependencies(connection: DatabaseContext, identity: string): readonly string[] {
  const tableKey = `${DATABASE_DEPENDENCY_PREFIX}${connection.getConnectionName()}:${identity}`
  return [tableKey, `${tableKey}:row:*`]
}

export async function evictReplacedTableIdentity(
  connection: DatabaseContext,
  identity: string,
): Promise<void> {
  const bridge = getDatabaseQueryCacheBridge()
  if (!bridge) return
  try {
    await runQueryCacheOperation(() => bridge.invalidateDependencies(replacedTableIdentityDependencies(connection, identity)))
  } catch (error) {
    reportError(error, { capability: 'db', operation: 'cache.invalidateDependencies' })
  }
}

export async function invalidateReplacedTableIdentity(
  connection: DatabaseContext,
  identity: string,
): Promise<void> {
  if (!getDatabaseQueryCacheBridge() && !hasDatabaseDependencyInvalidationListeners() && !hasDatabaseDependencyInvalidationPublisher()) {
    return
  }

  await invalidateQueryCacheDependencies(connection, replacedTableIdentityDependencies(connection, identity))
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
    case 'integer-in':
    case 'column':
    case 'null':
    case 'like':
    case 'between-columns':
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
  return column.split('.').at(-1)!
}

function resolveObservedRowKey(source: Pick<QuerySource, 'tableName' | 'table' | 'primaryKey'>, connectionName: string): string | undefined {
  return source.primaryKey ?? resolveRowDependencyKey(source, connectionName)
}

function resolveRowDependencyKey(source: Pick<QuerySource, 'tableName' | 'table'>, connectionName: string): string | undefined {
  const table = source.table ?? getConnectionGeneratedTableDefinition(source.tableName, connectionName)
  if (!table) return 'id'
  const [primaryKey, ...otherPrimaryKeys] = listTablePrimaryKeyColumns(table)
  return otherPrimaryKeys.length === 0 ? primaryKey : undefined
}

export function resolveInsertIdKey(source: Pick<QuerySource, 'tableName' | 'table'>, connectionName: string): string | undefined {
  const primaryKey = resolveRowDependencyKey(source, connectionName)
  return primaryKey === 'id' || (primaryKey !== undefined && hasAutoIncrementKey(source, connectionName, primaryKey))
    ? primaryKey
    : undefined
}

function hasAutoIncrementKey(source: Pick<QuerySource, 'tableName' | 'table'>, connectionName: string, primaryKey: string): boolean {
  const table = source.table ?? getConnectionGeneratedTableDefinition(source.tableName, connectionName)
  return Object.values(table?.columns ?? {}).some(column => column.name === primaryKey && column.idStrategy === 'autoIncrement')
}

function createExactPrimaryKeyRowDependency(plan: SelectQueryPlan, connectionName: string, textMatching: QueryTextMatching): string | undefined {
  const primaryKey = resolveRowDependencyKey(plan.source, connectionName)
  if (primaryKey === undefined) {
    return undefined
  }

  const value = findExactPrimaryKeyValue(plan.predicates, primaryKey)
  return queryTextMayMatchOtherValues(primaryKey, value, textMatching)
    ? undefined
    : createTableRowCacheDependency(connectionName, plan.source.tableName, primaryKey, value)
}

function assignsPrimaryKey(column: string, primaryKey: string | undefined): boolean {
  const name = getColumnName(column).toLowerCase()
  return primaryKey === undefined || name === primaryKey.toLowerCase() || SQLITE_ROWID_ALIASES.has(name)
}

function isNumericText(value: unknown): boolean {
  return typeof value === 'string' && NUMERIC_TEXT_PATTERN.test(value)
}

function isUnsafeInteger(value: unknown): boolean {
  return (typeof value === 'bigint' && !Number.isSafeInteger(Number(value)))
    || (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value))
}

function mayEqualOtherLiteral(column: string, value: unknown, caseInsensitiveColumns: CaseInsensitiveColumns): boolean {
  return typeof readLiteralDependencyValues(column, value, caseInsensitiveColumns) === 'undefined'
}

function createLiteralExpansion(caseInsensitiveColumns: CaseInsensitiveColumns): LiteralExpansion {
  return (column, value) => readLiteralDependencyValues(column, value, caseInsensitiveColumns) ?? [value]
}

function comparesLoosely(column: string, value: unknown, caseInsensitiveColumns: CaseInsensitiveColumns): boolean {
  if (caseInsensitiveColumns === 'all') {
    return typeof value === 'string'
  }

  if (!('findTextColumn' in caseInsensitiveColumns)) {
    return typeof value === 'string' && caseInsensitiveColumns.has(column)
  }

  const textColumn = caseInsensitiveColumns.findTextColumn(column)
  if (typeof value === 'string') {
    return textColumn === undefined || !textColumn.exact || (textColumn.padSpace && value.endsWith(' '))
  }

  return value !== null && textColumn !== undefined && caseInsensitiveColumns.numbersMatchText
}

function readLiteralDependencyValues(
  column: string,
  value: unknown,
  caseInsensitiveColumns: CaseInsensitiveColumns,
): readonly unknown[] | undefined {
  if (Array.isArray(value)) {
    return value.some(element => Array.isArray(element)
      ? typeof readLiteralDependencyValues(column, element, caseInsensitiveColumns) === 'undefined'
      : comparesLoosely(column, element, caseInsensitiveColumns) || isNumericText(element) || isUnsafeInteger(element))
      ? undefined
      : [value]
  }

  if (comparesLoosely(column, value, caseInsensitiveColumns) || isUnsafeInteger(value)) {
    return undefined
  }

  if (typeof value !== 'string' || !isNumericText(value)) {
    return [value]
  }

  const number = Number(value)
  return Number.isFinite(number) && String(number) === value && (!Number.isInteger(number) || Number.isSafeInteger(number))
    ? [value, number]
    : undefined
}

function createRowDependencies(
  connectionName: string,
  tableName: string,
  primaryKey: string,
  value: unknown,
  caseInsensitiveColumns: CaseInsensitiveColumns,
): readonly string[] | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  return readLiteralDependencyValues(primaryKey, value, caseInsensitiveColumns)
    ?.map(rowValue => createTableRowCacheDependency(connectionName, tableName, primaryKey, rowValue)!)
}

function collectLooseColumns(
  predicates: readonly QueryPredicateNode[],
  records: readonly Readonly<Record<string, unknown>>[],
  isLoose: (column: string, value: unknown) => boolean,
  columns = new Set<string>(),
): ReadonlySet<string> {
  for (const predicate of predicates) {
    if (predicate.kind === 'comparison') {
      const column = getColumnName(predicate.column)
      if (readExactPredicateValues(predicate).some(value => isLoose(column, value))) {
        columns.add(column)
      }
      continue
    }

    if (predicate.kind === 'group' && !predicate.negated && predicate.boolean !== 'or') {
      collectLooseColumns(predicate.predicates, [], isLoose, columns)
    }
  }

  for (const record of records) {
    for (const [columnName, value] of Object.entries(record)) {
      const column = getColumnName(columnName)
      if (isLoose(column, value)) {
        columns.add(column)
      }
    }
  }

  return columns
}

function collectMutationLooseColumns(
  predicates: readonly QueryPredicateNode[],
  records: readonly Readonly<Record<string, unknown>>[],
  caseInsensitiveColumns: CaseInsensitiveColumns,
): ReadonlySet<string> {
  return collectLooseColumns(predicates, records, (column, value) => mayEqualOtherLiteral(column, value, caseInsensitiveColumns))
}

function queryTextMayMatchOtherValues(column: string, value: unknown, textMatching: QueryTextMatching): boolean {
  if (Array.isArray(value)) {
    return value.some(element => queryTextMayMatchOtherValues(column, element, textMatching))
  }

  if (isUnsafeInteger(value)) {
    return true
  }

  if (typeof textMatching === 'boolean') {
    return typeof value === 'string' && (textMatching || isNumericText(value))
  }

  return comparesLoosely(column, value, textMatching) || (!textMatching.numbersMatchText && isNumericText(value))
}

function containsText(value: unknown): boolean {
  return typeof value === 'string' || (Array.isArray(value) && value.some(element => containsText(element)))
}

function collectNumberLikeColumns(predicates: readonly QueryPredicateNode[], textMatching: QueryTextMatching): ReadonlySet<string> {
  return collectLooseColumns(predicates, [], (column, value) => queryTextMayMatchOtherValues(column, value, textMatching))
}

export function writesTextLiterals(
  predicates: readonly QueryPredicateNode[],
  records: readonly Readonly<Record<string, unknown>>[],
): boolean {
  return collectLooseColumns(predicates, records, (_column, value) => containsText(value)).size > 0
}

function createMutationRowDependencies(
  plan: SelectQueryPlan,
  connectionName: string,
  values: Readonly<Record<string, unknown>>,
  caseInsensitiveColumns: CaseInsensitiveColumns,
): readonly string[] {
  const wildcard = createTableRowWildcardCacheDependency(connectionName, plan.source.tableName)
  const primaryKey = resolveRowDependencyKey(plan.source, connectionName)
  if (primaryKey === undefined) {
    return [wildcard]
  }

  const createRowDependency = (value: unknown) => createRowDependencies(connectionName, plan.source.tableName, primaryKey, value, caseInsensitiveColumns)
  const current = createRowDependency(findExactPrimaryKeyValue(plan.predicates, primaryKey))
  const assignedKeys = Object.entries(values).filter(([column]) => assignsPrimaryKey(column, primaryKey))
  if (assignedKeys.length === 0) {
    return current ?? [wildcard]
  }

  if (current === undefined || assignedKeys.some(([, value]) => typeof value === 'object' && value !== null)) {
    return [wildcard]
  }

  const dependencies = new Set(current)
  for (const [, value] of assignedKeys) {
    for (const dependency of createRowDependency(value) ?? [wildcard]) {
      dependencies.add(dependency)
    }
  }

  return [...dependencies]
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
  excludedColumns: ReadonlySet<string> = EMPTY_COLUMNS,
  expandValue: LiteralExpansion = IDENTITY_EXPANSION,
): readonly string[] {
  const dependencies = new Set<string>()
  for (const predicate of predicates) {
    const values = readExactPredicateValues(predicate)
    if (values.length > 0 && predicate.kind === 'comparison') {
      if (excludedColumns.has(getColumnName(predicate.column))) {
        continue
      }

      for (const value of values.flatMap(value => expandValue(getColumnName(predicate.column), value))) {
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
      for (const dependency of collectExactPredicateDependencies(predicate.predicates, connectionName, tableName, exact, excludedColumns, expandValue)) {
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
  excludedColumns: ReadonlySet<string> = EMPTY_COLUMNS,
  expandValue: LiteralExpansion = IDENTITY_EXPANSION,
): void {
  for (const predicate of predicates) {
    const values = readExactPredicateValues(predicate)
    if (values.length > 0 && predicate.kind === 'comparison') {
      if (excludedColumns.has(getColumnName(predicate.column))) {
        continue
      }

      for (const value of values.flatMap(value => expandValue(getColumnName(predicate.column), value))) {
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
      appendExactPredicateDependencyEntries(target, predicate.predicates, connectionName, tableName, exact, excludedColumns, expandValue)
    }
  }
}

function collectRecordPredicateDependencies(
  connectionName: string,
  tableName: string,
  record: Readonly<Record<string, unknown>>,
  exact = false,
  excludedColumns: ReadonlySet<string> = EMPTY_COLUMNS,
  expandValue: LiteralExpansion = IDENTITY_EXPANSION,
): readonly string[] {
  const dependencies = new Set<string>()
  for (const [columnName, recordValue] of Object.entries(record)) {
    const column = getColumnName(columnName)
    if (excludedColumns.has(column)) {
      continue
    }

    for (const value of expandValue(column, recordValue)) {
      const dependency = exact
        ? createTableExactPredicateCacheDependency(connectionName, tableName, column, value)
        : createTablePredicateCacheDependency(connectionName, tableName, column, value)
      if (dependency) {
        dependencies.add(dependency)
      }
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
  excludedColumns: ReadonlySet<string> = EMPTY_COLUMNS,
  expandValue: LiteralExpansion = IDENTITY_EXPANSION,
): void {
  for (const [columnName, recordValue] of Object.entries(record)) {
    const column = getColumnName(columnName)
    if (excludedColumns.has(column)) {
      continue
    }

    for (const value of expandValue(column, recordValue)) {
      const entry = createPredicateDependencyEntry(connectionName, tableName, column, value, exact)
      if (entry) {
        target.set(entry.dependency, entry)
      }
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

function hasRequiredProjectionSelection(
  selections: readonly DatabaseQuerySelectionObservation[],
  column: string,
): boolean {
  return selections.some(selection => selection.column === column && selection.resultKey === column)
}

function isExactPrimaryKeySingleResultProjection(plan: SelectQueryPlan, primaryKey: string): boolean {
  return plan.limit === 1
    && typeof findExactPrimaryKeyValue(plan.predicates, primaryKey) !== 'undefined'
}

function isPatchableProjectionObservation(
  plan: SelectQueryPlan,
  primaryKey: string,
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

  const needsProjectedPrimaryKey = !isExactPrimaryKeySingleResultProjection(plan, primaryKey)
  const requiredColumns = new Set<string>([
    ...orderBy.map(order => order.column),
  ])
  if (needsProjectedPrimaryKey) {
    requiredColumns.add(primaryKey)
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
    || plan.offset === 0
    || (
      typeof plan.limit === 'number'
      && plan.offset > 0
      && orderBy.length > 0
    )
}

function readsSourceIntegerColumn(plan: SelectQueryPlan, column: string): boolean {
  const separator = column.lastIndexOf('.')
  if (separator >= 0 && column.slice(0, separator) !== (plan.source.alias ?? plan.source.tableName)) {
    return false
  }

  const kind = plan.source.table?.columns[column.slice(separator + 1)]?.kind
  return kind === 'integer' || kind === 'bigInteger'
}

function findGroupedAggregateObservation(
  plan: SelectQueryPlan,
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
    groupColumn,
    groupResultKey: groupSelection.alias ?? groupColumn,
    having,
    ...(aggregateKind === 'avg' && readsSourceIntegerColumn(plan, aggregateSelection.column) ? { integerColumn: true as const } : {}),
    kind: aggregateKind,
  } satisfies DatabaseQueryGroupedAggregateObservation

  return Object.freeze(groupedAggregate)
}

function isSupportedGroupedCountHaving(plan: SelectQueryPlan): boolean {
  if (plan.having.length === 0) {
    return true
  }

  return typeof readGroupedCountHavingClause(plan) !== 'undefined'
}

function readGroupedCountHavingClause(
  plan: SelectQueryPlan,
): DatabaseQueryGroupedAggregateHavingObservation | undefined {
  if (plan.groupBy.length === 0 || plan.having.length !== 1) {
    return undefined
  }

  const clause = plan.having[0]
  if (
    !clause
    || clause.kind !== 'comparison'
    || clause.expression.replace(/\s+/g, '').toLowerCase() !== 'count(*)'
    || typeof clause.value !== 'number'
    || !Number.isFinite(clause.value)
    || !isGroupedCountHavingOperator(clause.operator)
  ) {
    return undefined
  }

  return Object.freeze({
    operator: clause.operator,
    value: clause.value,
  })
}

function readGroupedCountHavingObservation(
  plan: SelectQueryPlan,
): DatabaseQueryGroupedAggregateHavingObservation | undefined {
  if (hasOnlyRedundantGroupedCountHaving(plan)) {
    return undefined
  }

  return readGroupedCountHavingClause(plan)
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
    && clause.kind === 'comparison'
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

function isPatchableQueryObservation(plan: SelectQueryPlan, primaryKey: string | undefined): boolean {
  if (primaryKey === undefined) {
    return false
  }

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
    && isPatchableProjectionObservation(plan, primaryKey, selections, predicates, orderBy)
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
  patchable?: boolean,
  groupedAggregateStates?: readonly DatabaseQueryGroupedAggregateStateObservation[],
): DatabaseQueryObservation | undefined {
  const primaryKey = resolveObservedRowKey(plan.source, connectionName)
  return Object.freeze({
    connectionName,
    belongsToHydrations: undefined,
    relatedHydrations: undefined,
    tableName: plan.source.tableName,
    table: plan.source.table,
    dependencies: Object.freeze([...dependencies]),
    groupedAggregate: findGroupedAggregateObservation(plan, groupedAggregateStates),
    limit: plan.limit,
    offset: plan.offset,
    orderBy: collectQueryOrderObservations(plan),
    patchable: patchable ?? isPatchableQueryObservation(plan, primaryKey),
    pagination: undefined,
    predicates: collectQueryPredicateObservations(plan.predicates),
    primaryKey,
    result,
    selections: collectQuerySelectionObservations(plan),
  })
}

export function createDatabaseQueryObservation(
  plan: SelectQueryPlan,
  connectionName: string,
  dependencies: readonly string[],
  result?: unknown,
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
  source: Pick<QuerySource, 'tableName' | 'table' | 'primaryKey'>,
  predicates: readonly QueryPredicateNode[] = [],
  values?: Readonly<Record<string, unknown>>,
  rows?: readonly Readonly<Record<string, unknown>>[],
  previousRows?: readonly Readonly<Record<string, unknown>>[],
): DatabaseMutationEvent {
  const table = source.table ?? getConnectionGeneratedTableDefinition(source.tableName, connectionName)
  const convertedColumns = convertedBooleanColumns(table, [...rows ?? [], ...previousRows ?? [], ...values ? [values] : []])
  return Object.freeze({
    connectionName,
    tableName: canonicalTableName(connectionName, source.tableName),
    kind,
    predicates: collectQueryPredicateObservations(predicates),
    previousRows: previousRows ? readMutationRows(table, previousRows) : undefined,
    primaryKey: resolveObservedRowKey(source, connectionName),
    rows: rows ? readMutationRows(table, rows) : undefined,
    values: values ? readStoredBooleans(table, values) : values,
    ...convertedColumns.length > 0 ? { convertedColumns } : {},
  })
}

function isDriverScalar(value: unknown): boolean {
  return typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string'
}

function isBooleanColumn(table: TableDefinition | undefined, column: string): boolean {
  return table !== undefined && Object.hasOwn(table.columns, column) && table.columns[column]?.kind === 'boolean'
}

function convertedBooleanColumns(table: TableDefinition | undefined, records: readonly Readonly<Record<string, unknown>>[]): readonly string[] {
  if (!table) return []
  return Object.freeze(Object.keys(table.columns).filter(column => isBooleanColumn(table, column)
    && records.some(record => Object.hasOwn(record, column) && isDriverScalar(record[column]))))
}

function hasUnreadBoolean(table: TableDefinition | undefined, row: Readonly<Record<string, unknown>>): boolean {
  return table !== undefined && Object.keys(row).some(key => isBooleanColumn(table, key) && isDriverScalar(row[key]) && !isStoredBoolean(row[key]))
}

function resultKeys(
  table: TableDefinition | undefined,
  row: Readonly<Record<string, unknown>>,
  selections: readonly DatabaseQuerySelectionObservation[],
  readsColumn: (table: TableDefinition, column: string) => boolean,
  reads: (value: unknown) => boolean,
): readonly string[] {
  if (!table) return []
  return Object.keys(row).filter((key) => {
    const selection = [...selections].reverse().find(candidate => candidate.resultKey === key)
    return reads(row[key]) && readsColumn(table, selection ? selection.column : key)
  })
}

function isIntegerColumn(table: TableDefinition, column: string): boolean {
  return Object.hasOwn(table.columns, column) && readsAsInteger(table.columns[column]!)
}

function booleanResultKeys(
  table: TableDefinition | undefined,
  row: Readonly<Record<string, unknown>>,
  selections: readonly DatabaseQuerySelectionObservation[],
  reads: (value: unknown) => boolean,
): readonly string[] {
  return resultKeys(table, row, selections, isBooleanColumn, reads)
}

function hasUnstoredFetchedBoolean(
  table: TableDefinition | undefined,
  row: Readonly<Record<string, unknown>>,
  selections: readonly DatabaseQuerySelectionObservation[] = [],
): boolean {
  return booleanResultKeys(table, row, selections, value => isDriverScalar(value) && !isStoredBoolean(value)).length > 0
}

function readBooleanColumns(
  table: TableDefinition | undefined,
  row: Readonly<Record<string, unknown>>,
  selections: readonly DatabaseQuerySelectionObservation[],
  reads: (value: unknown) => boolean,
): Readonly<Record<string, unknown>> {
  const booleanKeys = booleanResultKeys(table, row, selections, reads)
  if (booleanKeys.length === 0) return row
  return Object.freeze({ ...row, ...Object.fromEntries(booleanKeys.map(key => [key, coerceBoolean(row[key])])) })
}

function integerResultKeys(
  table: TableDefinition | undefined,
  row: Readonly<Record<string, unknown>>,
  selections: readonly DatabaseQuerySelectionObservation[],
  reads: (value: unknown) => boolean,
): readonly string[] {
  return resultKeys(table, row, selections, isIntegerColumn, reads)
}

function hasUnreadInteger(table: TableDefinition | undefined, row: Readonly<Record<string, unknown>>): boolean {
  return resultKeys(table, row, [], isIntegerColumn, value => (typeof value === 'string' || typeof value === 'bigint' || typeof value === 'number')
    && !Number.isSafeInteger(readCanonicalInteger(value))).length > 0
}

function hasUnreadableFetchedInteger(
  table: TableDefinition | undefined,
  row: Readonly<Record<string, unknown>>,
  selections: readonly DatabaseQuerySelectionObservation[] = [],
): boolean {
  return integerResultKeys(table, row, selections, failsIntegerRead).length > 0
}

function readIntegerColumns(
  table: TableDefinition | undefined,
  row: Readonly<Record<string, unknown>>,
  selections: readonly DatabaseQuerySelectionObservation[],
): Readonly<Record<string, unknown>> {
  const integerKeys = integerResultKeys(table, row, selections, value => readCanonicalInteger(value) !== value)
  if (integerKeys.length === 0) return row
  return Object.freeze({ ...row, ...Object.fromEntries(integerKeys.map(key => [key, readCanonicalInteger(row[key])])) })
}

function readStoredBooleans(
  table: TableDefinition | undefined,
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return readBooleanColumns(table, row, [], isStoredBoolean)
}

function readMutationRow(
  table: TableDefinition | undefined,
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return readIntegerColumns(table, readStoredBooleans(table, row), [])
}

function readFetchedRow(
  table: TableDefinition | undefined,
  row: Readonly<Record<string, unknown>>,
  selections: readonly DatabaseQuerySelectionObservation[] = [],
): Readonly<Record<string, unknown>> {
  return readIntegerColumns(table, readBooleanColumns(table, row, selections, isDriverScalar), selections)
}

function readMutationRows(
  table: TableDefinition | undefined,
  rows: readonly Readonly<Record<string, unknown>>[],
): readonly Readonly<Record<string, unknown>>[] {
  return Object.freeze(rows.map(row => readStoredBooleans(table, row)))
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
  textMatching: QueryTextMatching = false,
): readonly string[] | undefined {
  if (!supportsAutomaticQueryCacheInvalidation(plan)) {
    return undefined
  }

  if (!hasDisjunctivePredicate(plan.predicates)) {
    const primaryKeyDependency = createExactPrimaryKeyRowDependency(plan, connectionName, textMatching)
    if (primaryKeyDependency) {
      return Object.freeze([
        primaryKeyDependency,
        createTableRowWildcardCacheDependency(connectionName, plan.source.tableName),
      ])
    }
  }

  if (!hasDisjunctivePredicate(plan.predicates)) {
    const numberLikeColumns = collectNumberLikeColumns(plan.predicates, textMatching)
    const predicateDependencies = [
      ...collectExactPredicateDependencies(
        plan.predicates,
        connectionName,
        plan.source.tableName,
        false,
        numberLikeColumns,
      ),
      ...[...numberLikeColumns].map(column => createTablePredicateWildcardCacheDependency(connectionName, plan.source.tableName, column)),
    ]
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
  caseInsensitiveColumns: CaseInsensitiveColumns = EMPTY_COLUMNS,
): readonly string[] {
  return inferAutomaticQueryCacheInvalidationPlan(plan, connectionName, values, false, caseInsensitiveColumns).dependencies
}

export function inferAutomaticQueryCacheInvalidationPlan(
  plan: SelectQueryPlan,
  connectionName: string,
  values: Readonly<Record<string, unknown>> = {},
  includeMetadata = false,
  caseInsensitiveColumns: CaseInsensitiveColumns = EMPTY_COLUMNS,
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
  const rowDependencies = createMutationRowDependencies(plan, connectionName, values, caseInsensitiveColumns)
  dependencies.push(...rowDependencies)
  directDependencies.push(...rowDependencies)
  const looseColumns = collectMutationLooseColumns(plan.predicates, [values], caseInsensitiveColumns)
  const literalExpansion = createLiteralExpansion(caseInsensitiveColumns)

  if (includeMetadata) {
    const predicateEntries = new Map<string, DatabaseDependencyPredicateEntry>()
    appendExactPredicateDependencyEntries(predicateEntries, plan.predicates, connectionName, plan.source.tableName)
    for (const entry of predicateEntries.values()) {
      dependencies.push(entry.dependency)
      directDependencies.push(entry.dependency)
      predicates.push(entry.metadata)
    }

    const exactPredicateEntries = new Map<string, DatabaseDependencyPredicateEntry>()
    appendExactPredicateDependencyEntries(exactPredicateEntries, plan.predicates, connectionName, plan.source.tableName, true, looseColumns, literalExpansion)
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
    appendRecordPredicateDependencyEntries(exactRecordPredicateEntries, connectionName, plan.source.tableName, values, true, looseColumns, literalExpansion)
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
  dependencies.push(...collectExactPredicateDependencies(plan.predicates, connectionName, plan.source.tableName, true, looseColumns, literalExpansion))
  dependencies.push(...collectRecordPredicateDependencies(connectionName, plan.source.tableName, values))
  dependencies.push(...collectRecordPredicateDependencies(connectionName, plan.source.tableName, values, true, looseColumns, literalExpansion))
  return Object.freeze({
    dependencies: Object.freeze(dependencies),
  })
}

export function inferAutomaticInsertCacheInvalidationDependencies(
  connectionName: string,
  source: Pick<QuerySource, 'tableName' | 'table'>,
  rows: readonly Readonly<Record<string, unknown>>[],
  lastInsertId?: number | string,
  caseInsensitiveColumns: CaseInsensitiveColumns = EMPTY_COLUMNS,
): readonly string[] {
  return inferAutomaticInsertCacheInvalidationPlan(connectionName, source, rows, lastInsertId, false, caseInsensitiveColumns).dependencies
}

export function inferAutomaticInsertCacheInvalidationPlan(
  connectionName: string,
  source: Pick<QuerySource, 'tableName' | 'table'>,
  rows: readonly Readonly<Record<string, unknown>>[],
  lastInsertId?: number | string,
  includeMetadata = false,
  caseInsensitiveColumns: CaseInsensitiveColumns = EMPTY_COLUMNS,
  conflictColumns?: readonly string[] | 'any',
  updatedColumns: readonly string[] = [],
): DatabaseDependencyInvalidationPlan {
  const { tableName } = source
  const primaryKey = resolveRowDependencyKey(source, connectionName)
  const conflictsBeyondPrimaryKey = conflictColumns === 'any'
    || (conflictColumns !== undefined && (primaryKey === undefined || conflictColumns.some(column => getColumnName(column) !== primaryKey)))
    || updatedColumns.some(column => assignsPrimaryKey(column, primaryKey))
  const looseColumns = collectMutationLooseColumns([], rows, caseInsensitiveColumns)
  const literalExpansion = createLiteralExpansion(caseInsensitiveColumns)
  const createRowDependency = (value: unknown) => primaryKey === undefined
    ? undefined
    : createRowDependencies(connectionName, tableName, primaryKey, value, caseInsensitiveColumns)
  const tableKey = createTableCacheDependency(connectionName, tableName)
  const dependencies = new Set<string>([
    tableKey,
  ])
  const directDependencies = new Set<string>()
  const exactPredicates = new Map<string, DatabaseDependencyPredicateEntry>()
  const predicates = new Map<string, DatabaseDependencyPredicateEntry>()
  let hasUnknownRowKey = primaryKey === undefined
  for (const row of rows) {
    const rowDependencies = primaryKey === undefined ? undefined : createRowDependency(row[primaryKey])
    if (rowDependencies) {
      for (const dependency of rowDependencies) {
        dependencies.add(dependency)
        directDependencies.add(dependency)
      }
    } else {
      hasUnknownRowKey = true
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
      appendRecordPredicateDependencyEntries(rowExactPredicateEntries, connectionName, tableName, row, true, looseColumns, literalExpansion)
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
    for (const dependency of collectRecordPredicateDependencies(connectionName, tableName, row, true, looseColumns, literalExpansion)) {
      dependencies.add(dependency)
    }
  }
  const lastInsertDependencies = rows.length === 1 && primaryKey !== undefined && hasAutoIncrementKey(source, connectionName, primaryKey)
    ? createRowDependency(lastInsertId)
    : undefined
  for (const dependency of lastInsertDependencies ?? []) {
    dependencies.add(dependency)
    directDependencies.add(dependency)
  }

  if ((hasUnknownRowKey && !lastInsertDependencies) || conflictsBeyondPrimaryKey) {
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
  textMatching: QueryTextMatching = false,
): readonly string[] | undefined {
  if (explicit && explicit.length > 0) {
    return normalizeQueryCacheDependencies(connectionName, explicit)
  }

  return inferAutomaticQueryCacheDependencies(plan, connectionName, textMatching)
}

export async function invalidateQueryCacheDependencies(
  connection: DatabaseContext,
  dependencies: readonly string[],
  mutations: readonly DatabaseMutationEvent[] = [],
  plan?: { readonly metadata?: DatabaseDependencyInvalidationMetadata },
  publicationStartedAt?: number,
): Promise<void> {
  if (dependencies.length === 0) {
    return
  }

  const invalidate = async () => {
    const bridge = getDatabaseQueryCacheBridge()
    await evictThenNotify(
      () => runQueryCacheOperation(() => bridge?.invalidateDependencies(dependencies)),
      async () => {
        const candidates = getQueryCacheBridgeState().dependencyInvalidationPublishers ?? []
        const hasLocalListeners = hasDatabaseDependencyInvalidationListeners()
        if (candidates.length === 0 && !hasLocalListeners) {
          return
        }

        const unordered = hasLocalListeners && mutations.length > 0 && !recordDatabaseMutationPublication(mutations, publicationStartedAt)
        const event = createDatabaseDependencyInvalidationEvent(connection, dependencies, mutations, plan?.metadata, { startedAt: publicationStartedAt, unordered })
        const remote = serializeDatabaseDependencyInvalidation(event)
        if (candidates.length > 0 && remote.dependencies.length > 0) {
          rememberDatabaseInvalidationId(remote.id)
          for (const candidate of candidates) {
            publishDatabaseDependencyInvalidation(candidate.publisher, remote)
          }
        }
        if (hasLocalListeners) {
          await notifyDatabaseDependencyInvalidationListeners(event)
        }
      },
    )
  }

  if (connection.getScope().kind === 'root') {
    await invalidate()
    return
  }

  connection.afterCommit(invalidate)
}

export const queryCacheInternals = {
  hasObservedResultChanged,
  beginMutationPublication,
  getRootDatabaseContext,
  markMutationPublicationBoundary,
  hasUnreadBoolean,
  hasUnreadableFetchedInteger,
  hasUnreadInteger,
  hasUnstoredFetchedBoolean,
  readFetchedRow,
  readMutationRow,
  setMutationPreviousRowsRequirement,
  requiresMutationPreviousRows,
  collectDatabaseQueryDependencies: collectDatabaseQueryDependenciesInternal,
  configureDatabaseQueryCacheBridge,
  createDatabaseMutationEvent,
  createDatabaseQueryObservation,
  canonicalTableName,
  createDeterministicQueryCacheKey,
  createTablePredicateCacheDependency,
  createTableCacheDependency,
  createTableRowCacheDependency,
  createTableRowWildcardCacheDependency,
  getQueryCacheBridgeState,
  hasActiveDatabaseDependencyCollector,
  hasDatabaseDependencyInvalidationListeners,
  hasDatabaseDependencyInvalidationPublisher,
  inferAutomaticInsertCacheInvalidationDependencies,
  inferAutomaticInsertCacheInvalidationPlan,
  inferAutomaticQueryCacheDependencies,
  inferAutomaticQueryCacheInvalidationDependencies,
  inferAutomaticQueryCacheInvalidationPlan,
  normalizeQueryCacheConfig,
  normalizeQueryCacheDependencies,
  notifyDatabaseDependencyInvalidationListeners,
  onDatabaseDependencyInvalidationPublished,
  receiveRemoteDatabaseDependencyInvalidation,
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
