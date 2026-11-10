import type { DriverAdapter } from './core/types'
import { currentRootTransaction } from './core/openTransactions'
import { advanceSchemaGeneration, currentSchemaGeneration, hasPendingSchemaChanges, isSessionUncertain } from './core/schemaGeneration'
import { capturePooledDatabaseSessions, deferPooledDatabaseSessionRefresh, databaseSessionCacheEligibleKey } from './drivers/PooledTransactionClients'
import { driverConnection } from './core/transactionScope'
import { reportError } from '@holo-js/kernel/error-reporting'
import { getRootDatabaseContext } from './core/contextOwnership'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ConfigurationError } from './core/errors'
import { createAfterCommitPublication } from './core/afterCommitPublications'
import type { DatabaseContext } from './core/DatabaseContext'
import type { CompiledStatement } from './core/types'
import { getConnectionGeneratedTableDefinition } from './schema/generated'
import { coerceBoolean, isStoredBoolean, readsAsInteger } from './schema/normalization'
import { listTablePrimaryKeyColumns } from './schema/tablePrimaryKey'
import type { CaseInsensitiveColumns, TextColumnCollations } from './schema/caseInsensitiveColumns'
import type { QueryOperator, QueryPredicateNode, QuerySource, SelectQueryPlan } from './query/ast'
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

export interface DatabaseQueryObservation {
  readonly connectionName: string
  readonly tableName: string
  readonly dependencies: readonly string[]
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
  readonly primaryKey?: string
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
  readonly refreshTables: Set<string>
}

const DATABASE_DEPENDENCY_PREFIX = 'db:'
const DATABASE_DEPENDENCY_METADATA_KEY = '__holoDatabaseDependencyMetadata__'
const MUTATION_DEPENDENCY_SUFFIX = 'mutation'
const WHERE_DEPENDENCY_PREFIX = 'where:'
const WHERE_EXACT_DEPENDENCY_PREFIX = 'where-exact:'
const EMPTY_COLUMNS: ReadonlySet<string> = new Set<string>()
const PREDICATE_WILDCARD_VALUE = '*'
const IDENTITY_EXPANSION: LiteralExpansion = (_column, value) => [value]
const SQLITE_ROWID_ALIASES: ReadonlySet<string> = new Set(['rowid', '_rowid_', 'oid'])
const NUMERIC_TEXT_PATTERN = /^\s*[+-]?(?:(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:e[+-]?\d[\d_]*)?|0x[\da-f_]+|0o[0-7_]+|0b[01_]+|nan|inf(?:inity)?)\s*$/i

const databaseDependencyCollector = new AsyncLocalStorage<DatabaseDependencyCollectorState>()

export function getQueryCacheBridgeState(): {
  bridge?: DatabaseQueryCacheBridge
  dependencyInvalidationListeners?: Set<DatabaseDependencyInvalidationListenerInternal>
  dependencyInvalidationPublishers?: DatabaseDependencyInvalidationPublisherCandidate[]
  recentDatabaseInvalidationIds?: Map<string, number>
} {
  const runtime = globalThis as typeof globalThis & {
    __holoDbQueryCacheBridge__?: {
      bridge?: DatabaseQueryCacheBridge
      dependencyInvalidationListeners?: Set<DatabaseDependencyInvalidationListenerInternal>
      dependencyInvalidationPublishers?: DatabaseDependencyInvalidationPublisherCandidate[]
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
  state.dependencyInvalidationListeners.add(internalListener)

  return () => {
    state.dependencyInvalidationListeners?.delete(internalListener)
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
    refreshTables: new Set(),
  }
  const value = await databaseDependencyCollector.run(state, callback)

  return Object.freeze({
    value,
    contexts: state.contexts,
    dependencies: Object.freeze([...state.dependencies]),
    queries: Object.freeze([...state.queries]),
  })
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

  for (const dependency of dependencies) {
    state.dependencies.add(dependency)
  }
}

export function recordDatabaseQueryRefreshTables(dependencies: readonly string[], connectionName: string, tableName: string): void {
  const state = databaseDependencyCollector.getStore()
  if (!state) return
  const ownTable = createTableCacheDependency(connectionName, tableName)
  for (const dependency of dependencies) {
    const tableKey = parseDatabaseDependency(dependency)?.tableKey
    if (!tableKey || tableKey === ownTable || state.refreshTables.has(tableKey)) continue
    state.refreshTables.add(tableKey)
    state.dependencies.add(`${tableKey}:${WHERE_DEPENDENCY_PREFIX}${PREDICATE_WILDCARD_VALUE}:${PREDICATE_WILDCARD_VALUE}`)
    const connectionEnd = tableKey.indexOf(':', DATABASE_DEPENDENCY_PREFIX.length)
    state.queries.push(Object.freeze({
      connectionName: tableKey.slice(DATABASE_DEPENDENCY_PREFIX.length, connectionEnd),
      dependencies: Object.freeze([tableKey]),
      predicates: Object.freeze([]),
      tableName: tableKey.slice(connectionEnd + 1),
    }))
  }
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

  state.queries.push(observation)
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

function publishDatabaseInvalidationEvent(event: DatabaseDependencyInvalidationEventInternal): void {
  const candidates = getQueryCacheBridgeState().dependencyInvalidationPublishers ?? []
  if (candidates.length === 0) return
  const remote = serializeDatabaseDependencyInvalidation(event)
  if (remote.dependencies.length === 0) return
  rememberDatabaseInvalidationId(remote.id)
  for (const candidate of candidates) publishDatabaseDependencyInvalidation(candidate.publisher, remote)
}

function serializeDatabaseDependencyInvalidation(
  event: DatabaseDependencyInvalidationEventInternal,
): RemoteDatabaseDependencyInvalidation {
  const tableDependencies = new Set<string>()
  for (const dependency of event.dependencies) {
    const tableKey = dependency === databaseSchemaDependency ? dependency : parseDatabaseDependency(dependency)?.tableKey
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

  if (invalidation.dependencies.includes(databaseSchemaDependency)) advanceSchemaGeneration()

  await evictThenNotify(
    () => invalidation.dependencies.includes(databaseSchemaDependency)
      ? getDatabaseQueryCacheBridge()?.invalidateDependencies([databaseSchemaDependency])
      : getDatabaseQueryCacheBridge()?.invalidateDependencyTables?.(invalidation.dependencies),
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

  if (comparesLoosely(column, value, caseInsensitiveColumns) || isUnsafeInteger(value) || (typeof value === 'number' && !Number.isFinite(value))) {
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
  if (predicates.some(predicate => predicate.boolean === 'or')) {
    return Object.freeze([])
  }

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

function isSupportedGroupedCountHaving(plan: SelectQueryPlan): boolean {
  if (plan.having.length === 0) {
    return true
  }

  return typeof readGroupedCountHavingClause(plan) !== 'undefined'
}

function readGroupedCountHavingClause(
  plan: SelectQueryPlan,
): { readonly operator: QueryOperator, readonly value: number } | undefined {
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

function isGroupedCountHavingOperator(
  operator: QueryOperator,
): operator is Extract<QueryOperator, '<' | '<=' | '=' | '>' | '>='> {
  return operator === '<'
    || operator === '<='
    || operator === '='
    || operator === '>'
    || operator === '>='
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

function readsRowsBeyondSourcePredicates(plan: SelectQueryPlan): boolean {
  return hasObservationDependencyFallbackShape(plan)
    || plan.having.length > 0
    || plan.orderBy.some(order => order.kind === 'vector')
}

function hasDatabaseCoercedPredicate(plan: SelectQueryPlan, connectionName: string): boolean {
  const table = plan.source.table ?? getConnectionGeneratedTableDefinition(plan.source.tableName, connectionName)
  const coerced = (predicate: QueryPredicateNode): boolean => {
    if (predicate.kind === 'group') return predicate.predicates.some(coerced)
    if (!('column' in predicate)) return false
    const column = table?.columns[getColumnName(predicate.column)]
    if (column?.kind === 'real') return true
    if (predicate.kind !== 'comparison') return false
    const unsafeNumber = (value: unknown): boolean => Array.isArray(value)
      ? value.some(unsafeNumber)
      : typeof value === 'number' && (!Number.isSafeInteger(value)
        || (column !== undefined && !readsAsInteger(column) && column.kind !== 'boolean'))
    return unsafeNumber(predicate.value)
  }
  return plan.predicates.some(coerced)
}

function createDatabaseQueryObservationFromPlan(
  plan: SelectQueryPlan,
  connectionName: string,
  dependencies: readonly string[],
): DatabaseQueryObservation {
  const conservative = readsRowsBeyondSourcePredicates(plan) || hasDatabaseCoercedPredicate(plan, connectionName)
  return Object.freeze({
    connectionName,
    tableName: plan.source.tableName,
    dependencies: Object.freeze([...dependencies]),
    predicates: conservative ? Object.freeze([]) : collectQueryPredicateObservations(plan.predicates),
    primaryKey: resolveObservedRowKey(plan.source, connectionName),
  })
}

export function createDatabaseQueryObservation(
  plan: SelectQueryPlan,
  connectionName: string,
  dependencies: readonly string[],
): DatabaseQueryObservation | undefined {
  if (!supportsAutomaticQueryCacheInvalidation(plan)) return undefined
  return createDatabaseQueryObservationFromPlan(plan, connectionName, dependencies)
}

export function createDatabaseQueryFallbackObservation(
  plan: SelectQueryPlan,
  connectionName: string,
  dependencies: readonly string[],
): DatabaseQueryObservation | undefined {
  if (dependencies.length === 0) return undefined
  return createDatabaseQueryObservationFromPlan(plan, connectionName, dependencies)
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

function readStoredBooleans(
  table: TableDefinition | undefined,
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!table) return row
  const keys = Object.keys(row).filter(key => isBooleanColumn(table, key) && isStoredBoolean(row[key]))
  if (keys.length === 0) return row
  return Object.freeze({ ...row, ...Object.fromEntries(keys.map(key => [key, coerceBoolean(row[key])])) })
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

  if (readsRowsBeyondSourcePredicates(plan) || hasDatabaseCoercedPredicate(plan, connectionName)) {
    return Object.freeze([createTableCacheDependency(connectionName, plan.source.tableName)])
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

export const databaseSchemaDependency = '__holo_database_schema__'

export function canUseQueryCache(connection: DatabaseContext): boolean {
  if (hasPendingSchemaChanges(getRootDatabaseContext(connection).getContextId()) || isSessionUncertain(getRootDatabaseContext(connection)) || connection.isInTransaction()) return false
  const adapter = driverConnection(connection.getAdapter()) as DriverAdapter & { readonly [databaseSessionCacheEligibleKey]?: boolean }
  return adapter[databaseSessionCacheEligibleKey] !== false
}

export function needsFullQueryRefresh(connection: DatabaseContext): boolean {
  return hasPendingSchemaChanges(getRootDatabaseContext(connection).getContextId()) || isSessionUncertain(getRootDatabaseContext(connection))
    || (!currentRootTransaction(connection) && !canUseQueryCache(connection))
}

export async function invalidateDatabaseSchema(connection: DatabaseContext): Promise<void> {
  const bridge = getDatabaseQueryCacheBridge()
  const event = createDatabaseDependencyInvalidationEvent(connection, [databaseSchemaDependency], [])
  await evictThenNotify(
    () => runQueryCacheOperation(() => bridge?.invalidateDependencies([databaseSchemaDependency])),
    async () => {
      publishDatabaseInvalidationEvent(event)
      await notifyDatabaseDependencyInvalidationListeners(event)
    },
  )
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

  const invalidate = createAfterCommitPublication(async () => {
    const fullRefresh = needsFullQueryRefresh(connection)
    const localDependencies = fullRefresh ? [databaseSchemaDependency] : dependencies
    const bridge = getDatabaseQueryCacheBridge()
    try {
      await runQueryCacheOperation(() => bridge?.invalidateDependencies(localDependencies))
    } catch (error) {
      reportError(error, { capability: 'db', operation: 'cache.invalidateDependencies' })
    }

    return async () => {
      const candidates = getQueryCacheBridgeState().dependencyInvalidationPublishers ?? []
      const hasLocalListeners = hasDatabaseDependencyInvalidationListeners()
      if (candidates.length === 0 && !hasLocalListeners) {
        return
      }

      const event = createDatabaseDependencyInvalidationEvent(connection, dependencies, mutations, plan?.metadata)
      publishDatabaseInvalidationEvent(event)
      if (hasLocalListeners) {
        await notifyDatabaseDependencyInvalidationListeners(fullRefresh
          ? createDatabaseDependencyInvalidationEvent(connection, localDependencies, [])
          : event)
      }
    }
  })
  if (connection.getScope().kind === 'root') {
    await invalidate()
    return
  }

  connection.afterCommit(invalidate)
}

export const queryCacheInternals = {
  deferPooledDatabaseSessionRefresh,
  capturePooledDatabaseSessions,
  currentSchemaGeneration,
  hasPendingSchemaChanges,
  databaseSchemaDependency,
  getRootDatabaseContext,
  collectDatabaseQueryDependencies: collectDatabaseQueryDependenciesInternal,
  createTableCacheDependency,
  onDatabaseDependencyInvalidationPublished,
  receiveRemoteDatabaseDependencyInvalidation,
}
