import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ConfigurationError } from './core/errors'
import type { DatabaseContext } from './core/DatabaseContext'
import type { CompiledStatement } from './core/types'
import type { QueryPredicateNode, SelectQueryPlan } from './query/ast'

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

const databaseDependencyCollector = new AsyncLocalStorage<Set<string>>()

function getQueryCacheBridgeState(): {
  bridge?: DatabaseQueryCacheBridge
  dependencyInvalidationListeners?: Set<DatabaseDependencyInvalidationListener>
} {
  const runtime = globalThis as typeof globalThis & {
    __holoDbQueryCacheBridge__?: {
      bridge?: DatabaseQueryCacheBridge
      dependencyInvalidationListeners?: Set<DatabaseDependencyInvalidationListener>
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
  state.dependencyInvalidationListeners ??= new Set<DatabaseDependencyInvalidationListener>()
  state.dependencyInvalidationListeners.add(listener)

  return () => {
    state.dependencyInvalidationListeners?.delete(listener)
  }
}

export function resetDatabaseDependencyInvalidationListeners(): void {
  getQueryCacheBridgeState().dependencyInvalidationListeners = undefined
}

export async function collectDatabaseQueryDependencies<TValue>(
  callback: () => TValue | Promise<TValue>,
): Promise<DatabaseDependencyCollectionResult<TValue>> {
  const dependencies = new Set<string>()
  const value = await databaseDependencyCollector.run(dependencies, callback)

  return Object.freeze({
    value,
    dependencies: Object.freeze([...dependencies]),
  })
}

export function hasActiveDatabaseDependencyCollector(): boolean {
  return typeof databaseDependencyCollector.getStore() !== 'undefined'
}

export function recordDatabaseQueryDependencies(dependencies: readonly string[] | undefined): void {
  if (!dependencies || dependencies.length === 0) {
    return
  }

  const active = databaseDependencyCollector.getStore()
  if (!active) {
    return
  }

  for (const dependency of dependencies) {
    active.add(dependency)
  }
}

export function hasDatabaseDependencyInvalidationListeners(): boolean {
  const listeners = getQueryCacheBridgeState().dependencyInvalidationListeners
  return typeof listeners !== 'undefined' && listeners.size > 0
}

async function notifyDatabaseDependencyInvalidationListeners(
  event: DatabaseDependencyInvalidationEvent,
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

export function createTableRowCacheDependency(
  connectionName: string,
  tableName: string,
  columnName: string,
  value: unknown,
): string | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  return `db:${connectionName}:${tableName}:row:${columnName}:${encodeURIComponent(JSON.stringify(value))}`
}

export function createTableRowWildcardCacheDependency(
  connectionName: string,
  tableName: string,
): string {
  return `db:${connectionName}:${tableName}:row:*`
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

export function supportsAutomaticQueryCacheInvalidation(plan: SelectQueryPlan): boolean {
  if (plan.joins.length > 0 || plan.unions.length > 0 || plan.having.length > 0) {
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

  return Object.freeze([
    createTableCacheDependency(connectionName, plan.source.tableName),
  ])
}

export function inferAutomaticQueryCacheInvalidationDependencies(
  plan: SelectQueryPlan,
  connectionName: string,
): readonly string[] {
  const dependencies = [
    createTableCacheDependency(connectionName, plan.source.tableName),
  ]
  if (hasDisjunctivePredicate(plan.predicates)) {
    dependencies.push(createTableRowWildcardCacheDependency(connectionName, plan.source.tableName))
    return Object.freeze(dependencies)
  }

  const primaryKeyColumn = getPrimaryKeyColumn(plan)
  const primaryKeyValue = findExactPrimaryKeyValue(plan.predicates, primaryKeyColumn)
  const primaryKeyDependency = createTableRowCacheDependency(
    connectionName,
    plan.source.tableName,
    primaryKeyColumn,
    primaryKeyValue,
  )
  dependencies.push(primaryKeyDependency ?? createTableRowWildcardCacheDependency(connectionName, plan.source.tableName))
  return Object.freeze(dependencies)
}

export function inferAutomaticInsertCacheInvalidationDependencies(
  connectionName: string,
  tableName: string,
  rows: readonly Readonly<Record<string, unknown>>[],
  lastInsertId?: number | string,
): readonly string[] {
  const dependencies = new Set<string>([
    createTableCacheDependency(connectionName, tableName),
  ])
  for (const row of rows) {
    const dependency = createTableRowCacheDependency(connectionName, tableName, 'id', row.id)
    if (dependency) {
      dependencies.add(dependency)
    }
  }
  const lastInsertDependency = createTableRowCacheDependency(connectionName, tableName, 'id', lastInsertId)
  if (lastInsertDependency) {
    dependencies.add(lastInsertDependency)
  }

  if (dependencies.size === 1) {
    dependencies.add(createTableRowWildcardCacheDependency(connectionName, tableName))
  }

  return Object.freeze([...dependencies])
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
): Promise<void> {
  if (dependencies.length === 0) {
    return
  }

  const invalidate = async () => {
    const bridge = getDatabaseQueryCacheBridge()
    await bridge?.invalidateDependencies(dependencies)
    await notifyDatabaseDependencyInvalidationListeners({
      connectionName: connection.getConnectionName(),
      dependencies,
    })
  }

  if (connection.getScope().kind === 'root') {
    await invalidate()
    return
  }

  connection.afterCommit(invalidate)
}

export const queryCacheInternals = {
  collectDatabaseQueryDependencies,
  configureDatabaseQueryCacheBridge,
  createDeterministicQueryCacheKey,
  createTableCacheDependency,
  createTableRowCacheDependency,
  createTableRowWildcardCacheDependency,
  getQueryCacheBridgeState,
  hasActiveDatabaseDependencyCollector,
  hasDatabaseDependencyInvalidationListeners,
  inferAutomaticInsertCacheInvalidationDependencies,
  inferAutomaticQueryCacheDependencies,
  inferAutomaticQueryCacheInvalidationDependencies,
  normalizeQueryCacheConfig,
  normalizeQueryCacheDependencies,
  notifyDatabaseDependencyInvalidationListeners,
  onDatabaseDependencyInvalidated,
  recordDatabaseQueryDependencies,
  resolveQueryCacheDependencies,
  resolveQueryCacheKey,
  resetDatabaseDependencyInvalidationListeners,
  supportsAutomaticPredicateInvalidation,
  supportsAutomaticQueryCacheInvalidation,
}
