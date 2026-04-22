import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  column,
  configureDB,
  configureDatabaseQueryCacheBridge,
  createConnectionManager,
  DB,
  queryCacheInternals,
  resetDB,
  resetDatabaseQueryCacheBridge,
  TableQueryBuilder,
  type DatabaseQueryCacheBridge,
  type Dialect,
  type DriverAdapter,
  type DriverExecutionResult,
  type DriverQueryResult,
  type SelectQueryPlan,
} from '../src'
import { defineModelFromTable, defineTable } from './support/internal'

class QueryCacheAdapter implements DriverAdapter {
  connected = false
  queryRows: Record<string, unknown>[] = []
  queryCount = 0
  executionCount = 0
  affectedRows?: number = 1

  async initialize(): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(): Promise<DriverQueryResult<TRow>> {
    this.queryCount += 1
    return {
      rows: this.queryRows as TRow[],
      rowCount: this.queryRows.length,
    }
  }

  async execute(): Promise<DriverExecutionResult> {
    this.executionCount += 1
    return {
      affectedRows: this.affectedRows,
    }
  }

  async beginTransaction(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
}

class MemoryQueryCacheBridge implements DatabaseQueryCacheBridge {
  readonly values = new Map<string, unknown>()
  readonly keyDependencies = new Map<string, readonly string[]>()
  readonly dependencyKeys = new Map<string, Set<string>>()
  readonly getCalls: string[] = []
  readonly putCalls: Array<{ key: string, driver?: string }> = []
  readonly flexibleCalls: Array<{ key: string, driver?: string }> = []
  readonly invalidatedDependencies: string[][] = []

  private buildKey(key: string, driver?: string): string {
    return `${driver ?? '__default__'}\u0000${key}`
  }

  private registerDependencies(cacheKey: string, dependencies: readonly string[] = []): void {
    const previous = this.keyDependencies.get(cacheKey) ?? []
    for (const dependency of previous) {
      const keys = this.dependencyKeys.get(dependency)
      if (!keys) {
        continue
      }

      keys.delete(cacheKey)
      if (keys.size === 0) {
        this.dependencyKeys.delete(dependency)
      }
    }

    if (dependencies.length === 0) {
      this.keyDependencies.delete(cacheKey)
      return
    }

    this.keyDependencies.set(cacheKey, Object.freeze([...dependencies]))
    for (const dependency of dependencies) {
      const keys = this.dependencyKeys.get(dependency) ?? new Set<string>()
      keys.add(cacheKey)
      this.dependencyKeys.set(dependency, keys)
    }
  }

  async get<TValue>(key: string, options?: { readonly driver?: string }): Promise<TValue | null> {
    const cacheKey = this.buildKey(key, options?.driver)
    this.getCalls.push(cacheKey)
    return (this.values.get(cacheKey) as TValue | undefined) ?? null
  }

  async put<TValue>(
    key: string,
    value: TValue,
    options: {
      readonly driver?: string
      readonly ttl?: number | Date
      readonly dependencies?: readonly string[]
    },
  ): Promise<void> {
    void options.ttl
    const cacheKey = this.buildKey(key, options.driver)
    this.values.set(cacheKey, value)
    this.putCalls.push({ key, driver: options.driver })
    this.registerDependencies(cacheKey, options.dependencies)
  }

  async flexible<TValue>(
    key: string,
    _ttl: readonly [number, number] | { readonly fresh: number, readonly stale: number },
    callback: () => TValue | Promise<TValue>,
    options?: {
      readonly driver?: string
      readonly dependencies?: readonly string[]
    },
  ): Promise<TValue> {
    const cacheKey = this.buildKey(key, options?.driver)
    const cached = this.values.get(cacheKey) as TValue | undefined
    if (typeof cached !== 'undefined') {
      return cached
    }

    const value = await callback()
    this.values.set(cacheKey, value)
    this.flexibleCalls.push({ key, driver: options?.driver })
    this.registerDependencies(cacheKey, options?.dependencies)
    return value
  }

  async forget(key: string, options?: { readonly driver?: string }): Promise<boolean> {
    const cacheKey = this.buildKey(key, options?.driver)
    this.values.delete(cacheKey)
    this.registerDependencies(cacheKey)
    return true
  }

  async invalidateDependencies(
    dependencies: readonly string[],
    _options?: { readonly driver?: string },
  ): Promise<void> {
    this.invalidatedDependencies.push([...dependencies])
    for (const dependency of dependencies) {
      const keys = this.dependencyKeys.get(dependency) ?? new Set<string>()
      for (const key of keys) {
        this.values.delete(key)
        this.registerDependencies(key)
      }
    }
  }
}

function createDialect(): Dialect {
  return {
    name: 'sqlite',
    capabilities: {
      returning: false,
      savepoints: true,
      concurrentQueries: true,
      workerThreadExecution: false,
      lockForUpdate: false,
      sharedLock: false,
      jsonValueQuery: true,
      jsonContains: false,
      jsonLength: false,
      schemaQualifiedIdentifiers: false,
      nativeUpsert: true,
      ddlAlterSupport: false,
      introspection: true,
    },
    quoteIdentifier(identifier: string) {
      return `"${identifier}"`
    },
    createPlaceholder(index: number) {
      return `?${index}`
    },
  }
}

describe('@holo-js/db query cache integration', () => {
  let adapter: QueryCacheAdapter
  let bridge: MemoryQueryCacheBridge

  beforeEach(() => {
    adapter = new QueryCacheAdapter()
    bridge = new MemoryQueryCacheBridge()
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: {
          adapter,
          dialect: createDialect(),
          driver: 'sqlite',
        },
      },
    }))
    configureDatabaseQueryCacheBridge(bridge)
  })

  afterEach(() => {
    resetDatabaseQueryCacheBridge()
    resetDB()
  })

  it('supports ttl query caching with deterministic keys, explicit keys, drivers, and Date payloads', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      created_at: column.timestamp(),
    })
    adapter.queryRows = [{
      id: 1,
      name: 'Ava',
      created_at: new Date('2024-01-01T00:00:00.000Z'),
    }]

    const first = await DB.table(users).where('id', 1).cache(300).get()
    adapter.queryRows = [{
      id: 1,
      name: 'Changed',
      created_at: new Date('2025-01-01T00:00:00.000Z'),
    }]
    const second = await DB.table(users).where('id', 1).cache(300).get()
    const explicit = await DB.table(users).cache({
      key: 'users.explicit',
      ttl: 300,
      driver: 'redis',
    }).get()

    expect(first).toEqual(second)
    expect(first[0]?.created_at).toBeInstanceOf(Date)
    expect(adapter.queryCount).toBe(2)
    expect(bridge.putCalls[0]?.key).toMatch(/^db:query:/)
    expect(bridge.putCalls[1]).toEqual({
      key: 'users.explicit',
      driver: 'redis',
    })
    expect(explicit[0]?.name).toBe('Changed')
  })

  it('supports flexible query caching and model-query cache passthrough without changing result behavior', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })
    const User = defineModelFromTable(users, {})

    adapter.queryRows = [{ id: 1, name: 'Ava' }]

    const firstRows = await DB.table(users).cache({ flexible: [60, 300] }).get()
    adapter.queryRows = [{ id: 1, name: 'Changed' }]
    const secondRows = await DB.table(users).cache({ flexible: [60, 300] }).get()
    const firstModels = await User.query().cache(300).get()
    const secondModels = await User.query().cache(300).get()

    expect(firstRows).toEqual(secondRows)
    expect(bridge.flexibleCalls).toHaveLength(1)
    expect(firstModels[0]?.get('name')).toBe('Ava')
    expect(secondModels[0]?.get('name')).toBe('Ava')
  })

  it('supports query caching from string table sources', async () => {
    adapter.queryRows = [{ id: 1, name: 'Ava' }]

    const first = await DB.table('users').cache(300).get()
    adapter.queryRows = [{ id: 2, name: 'Changed' }]
    const second = await DB.table('users').cache(300).get()

    expect(first).toEqual(second)
  })

  it('preserves cache config across from() and invalidates when affectedRows is omitted', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })

    adapter.queryRows = [{ id: 1, name: 'Ava' }]
    const first = await DB.table(users).cache(300).from('users').get()
    adapter.queryRows = [{ id: 1, name: 'Changed' }]
    const second = await DB.table(users).cache(300).from('users').get()

    adapter.affectedRows = undefined
    await DB.table(users).update({ name: 'Updated' })
    adapter.queryRows = [{ id: 1, name: 'Refreshed' }]
    const third = await DB.table(users).cache(300).get()

    expect(first).toEqual(second)
    expect(third[0]?.name).toBe('Refreshed')
  })

  it('throws a clear error when query caching is requested without a configured cache bridge', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })

    resetDatabaseQueryCacheBridge()

    await expect(DB.table(users).cache(300).get()).rejects.toThrow(
      'Query caching requires @holo-js/cache to be installed and configured',
    )
  })

  it('automatically invalidates supported single-table queries after writes and skips unsupported shapes', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineTable('posts', {
      id: column.id(),
      user_id: column.integer(),
      title: column.string(),
    })

    adapter.queryRows = [{ id: 1, name: 'Ava' }]
    await DB.table(users).where('id', 1).cache(300).get()
    adapter.queryRows = [{ id: 1, name: 'Stale' }]
    await DB.table(users).where('id', 1).update({ name: 'Updated' })
    const refreshed = await DB.table(users).where('id', 1).cache(300).get()

    adapter.queryRows = [{ id: 1, name: 'Joined' }]
    await DB.table(users)
      .join('posts', 'posts.user_id', '=', 'users.id')
      .cache(300)
      .get()
    adapter.queryRows = [{ id: 1, name: 'Still cached' }]
    await DB.table(users).update({ name: 'Updated again' })
    const unsupported = await DB.table(users)
      .join('posts', 'posts.user_id', '=', 'users.id')
      .cache(300)
      .get()

    expect(bridge.invalidatedDependencies).toContainEqual(['db:main:users'])
    expect(refreshed[0]?.name).toBe('Stale')
    expect(unsupported[0]?.name).toBe('Joined')
  })

  it('defers automatic invalidation until the surrounding transaction commits', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })

    adapter.queryRows = [{ id: 1, name: 'Ava' }]
    await DB.table(users).cache(300).get()

    await DB.transaction(async (tx) => {
      await new TableQueryBuilder(users, tx)
        .where('id', 1)
        .update({ name: 'Updated' })
      expect(bridge.invalidatedDependencies).toHaveLength(0)
    })

    expect(bridge.invalidatedDependencies).toContainEqual(['db:main:users'])
  })

  it('normalizes explicit invalidation dependencies and disables automatic invalidation for raw order clauses', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })

    const orderedQuery = new TableQueryBuilder(users, DB.connection()).unsafeOrderBy('RANDOM()', [])
    const orderedPlan = (orderedQuery as unknown as { readonly plan: SelectQueryPlan }).plan

    expect(queryCacheInternals.supportsAutomaticQueryCacheInvalidation(orderedPlan)).toBe(false)
    expect(queryCacheInternals.resolveQueryCacheDependencies(orderedPlan, 'main', ['users', 'db:main:posts'])).toEqual([
      'db:main:users',
      'db:main:posts',
    ])
  })

  it('rejects unsupported predicate and selection shapes for automatic invalidation helpers', () => {
    const rawSelectionPlan = {
      kind: 'select',
      source: {
        kind: 'table',
        tableName: 'users',
      },
      distinct: false,
      selections: [{
        kind: 'raw',
        sql: 'COUNT(*)',
        bindings: [],
      }],
      joins: [],
      unions: [],
      predicates: [],
      groupBy: [],
      having: [],
      orderBy: [],
    } as const satisfies SelectQueryPlan

    expect(queryCacheInternals.supportsAutomaticQueryCacheInvalidation(rawSelectionPlan)).toBe(false)
    expect(queryCacheInternals.inferAutomaticQueryCacheDependencies(rawSelectionPlan, 'main')).toBeUndefined()
    expect(queryCacheInternals.supportsAutomaticPredicateInvalidation({
      kind: 'raw',
      boolean: 'and',
      sql: '1 = 1',
      bindings: [],
    } as never)).toBe(false)
    expect(queryCacheInternals.supportsAutomaticPredicateInvalidation({
      kind: 'exists',
      boolean: 'and',
      query: rawSelectionPlan,
    } as never)).toBe(false)
    expect(queryCacheInternals.supportsAutomaticPredicateInvalidation({
      kind: 'subquery',
      boolean: 'and',
      column: 'id',
      operator: 'in',
      query: rawSelectionPlan,
    } as never)).toBe(false)
    expect(queryCacheInternals.supportsAutomaticPredicateInvalidation({
      kind: 'group',
      boolean: 'and',
      predicates: [{
        kind: 'raw',
        boolean: 'and',
        sql: '1 = 1',
        bindings: [],
      }],
    } as never)).toBe(false)
    expect(queryCacheInternals.supportsAutomaticPredicateInvalidation({
      kind: 'unsupported',
    } as never)).toBe(false)

    const subquerySelectionPlan = {
      ...rawSelectionPlan,
      selections: [{
        kind: 'subquery',
        query: rawSelectionPlan,
        alias: 'user_count',
      }],
    } as const satisfies SelectQueryPlan

    expect(queryCacheInternals.supportsAutomaticQueryCacheInvalidation(subquerySelectionPlan)).toBe(false)
  })

  it('normalizes object query-cache config invalidation metadata and rejects empty dependencies', () => {
    expect(queryCacheInternals.normalizeQueryCacheConfig({
      ttl: 60,
      key: ' users.list ',
      driver: ' redis ',
      invalidate: ['users', 'db:main:posts'],
    })).toEqual({
      ttl: 60,
      key: 'users.list',
      driver: 'redis',
      flexible: undefined,
      invalidate: ['users', 'db:main:posts'],
    })

    expect(() => queryCacheInternals.normalizeQueryCacheConfig({
      ttl: 60,
      invalidate: ['users', '   '],
    })).toThrow('Query cache invalidation dependencies must be non-empty strings')

    expect(() => queryCacheInternals.normalizeQueryCacheConfig({
      ttl: 60,
      key: '   ',
    })).toThrow('Query cache keys must be non-empty strings')

    expect(() => queryCacheInternals.normalizeQueryCacheConfig({
      ttl: 60,
      driver: '   ',
    })).toThrow('Query cache driver names must be non-empty strings')

    expect(() => queryCacheInternals.normalizeQueryCacheConfig({})).toThrow(
      'Query cache config requires "ttl" or "flexible"',
    )

    expect(() => queryCacheInternals.normalizeQueryCacheConfig({
      ttl: 60,
      flexible: [60, 300],
    })).toThrow('Query cache config cannot define both "ttl" and "flexible"')

    expect(queryCacheInternals.createDeterministicQueryCacheKey({
      sql: 'select * from "users"',
    }, 'main')).toMatch(/^db:query:/)
  })
})
