import { createHash } from 'node:crypto'
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

export interface NormalizedQueryCacheConfig {
  readonly ttl?: QueryCacheTtlInput
  readonly key?: string
  readonly driver?: string
  readonly flexible?: QueryCacheFlexibleTtlInput
  readonly invalidate?: readonly string[]
}

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

function getQueryCacheBridgeState(): {
  bridge?: DatabaseQueryCacheBridge
} {
  const runtime = globalThis as typeof globalThis & {
    __holoDbQueryCacheBridge__?: {
      bridge?: DatabaseQueryCacheBridge
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

  return Object.freeze([
    createTableCacheDependency(connectionName, plan.source.tableName),
  ])
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
  const bridge = getDatabaseQueryCacheBridge()
  if (!bridge || dependencies.length === 0) {
    return
  }

  if (connection.getScope().kind === 'root') {
    await bridge.invalidateDependencies(dependencies)
    return
  }

  connection.afterCommit(async () => {
    await bridge.invalidateDependencies(dependencies)
  })
}

export const queryCacheInternals = {
  configureDatabaseQueryCacheBridge,
  createDeterministicQueryCacheKey,
  createTableCacheDependency,
  getQueryCacheBridgeState,
  inferAutomaticQueryCacheDependencies,
  normalizeQueryCacheConfig,
  normalizeQueryCacheDependencies,
  resolveQueryCacheDependencies,
  resolveQueryCacheKey,
  supportsAutomaticPredicateInvalidation,
  supportsAutomaticQueryCacheInvalidation,
}
