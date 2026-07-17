import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  column,
  configureDB,
  configureDatabaseQueryCacheBridge,
  collectDatabaseQueryDependencies,
  createConnectionManager,
  DatabaseContext,
  DB,
  defineGeneratedTable,
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
import {
  createDatabaseQueryFallbackObservation,
  inferDatabaseQueryObservationDependencies,
  invalidateQueryCacheDependencies,
  readDatabaseQueryObservationCount,
  rebindDatabaseQueryObservationCursorPagination,
  rebindDatabaseQueryObservationPagination,
  truncateDatabaseQueryObservations,
} from '../src/cache'
import { ModelRepository } from '../src/model/ModelRepository'
import { defineModelFromTable, defineTable } from './support/internal'

const DATABASE_DEPENDENCY_METADATA_KEY = '__holoDatabaseDependencyMetadata__'

type TestDependencyMetadata = {
  readonly directDependencies: readonly string[]
  readonly exactPredicates: readonly Readonly<Record<string, unknown>>[]
  readonly hasMutationDependency: boolean
  readonly predicates: readonly Readonly<Record<string, unknown>>[]
  readonly tableDependencies: readonly string[]
}

class QueryCacheAdapter implements DriverAdapter {
  connected = false
  inTransaction = false
  queryRows: Record<string, unknown>[] = []
  queryCount = 0
  executionCount = 0
  readonly queries: Array<{ sql: string, bindings: readonly unknown[] }> = []
  readonly executions: Array<{ sql: string, bindings: readonly unknown[] }> = []
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

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql = '',
    bindings: readonly unknown[] = [],
  ): Promise<DriverQueryResult<TRow>> {
    this.queryCount += 1
    this.queries.push({ sql, bindings })
    return {
      rows: this.queryRows as TRow[],
      rowCount: this.queryRows.length,
    }
  }

  async execute(
    sql = '',
    bindings: readonly unknown[] = [],
  ): Promise<DriverExecutionResult> {
    this.executionCount += 1
    this.executions.push({ sql, bindings })
    return {
      affectedRows: this.affectedRows,
      lastInsertId: this.executionCount,
    }
  }

  async beginTransaction(): Promise<void> {
    this.inTransaction = true
  }

  async commit(): Promise<void> {
    this.inTransaction = false
  }

  async rollback(): Promise<void> {
    this.inTransaction = false
  }
}

class MemoryQueryCacheBridge implements DatabaseQueryCacheBridge {
  readonly values = new Map<string, unknown>()
  readonly keyDependencies = new Map<string, readonly string[]>()
  readonly dependencyKeys = new Map<string, Set<string>>()
  readonly getCalls: string[] = []
  readonly putCalls: Array<{ key: string, driver?: string }> = []
  readonly flexibleCalls: Array<{
    key: string
    driver?: string
    ttl: readonly [number, number] | { readonly fresh: number, readonly stale: number }
  }> = []
  readonly invalidatedDependencies: string[][] = []
  readonly invalidationTransactionStates: boolean[] = []
  readonly inFlightFlexible = new Map<string, Promise<unknown>>()

  constructor(private readonly isInTransaction: () => boolean = () => false) {}

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
    ttl: readonly [number, number] | { readonly fresh: number, readonly stale: number },
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

    const pending = this.inFlightFlexible.get(cacheKey) as Promise<TValue> | undefined
    if (pending) {
      return pending
    }

    const compute = (async () => {
      const value = await callback()
      this.values.set(cacheKey, value)
      this.flexibleCalls.push({ key, driver: options?.driver, ttl })
      this.registerDependencies(cacheKey, options?.dependencies)
      return value
    })()
    this.inFlightFlexible.set(cacheKey, compute)

    try {
      return await compute
    } finally {
      this.inFlightFlexible.delete(cacheKey)
    }
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
    this.invalidationTransactionStates.push(this.isInTransaction())
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

function createReturningDialect(): Dialect {
  return {
    ...createDialect(),
    capabilities: {
      ...createDialect().capabilities,
      returning: true,
    },
  }
}

describe('@holo-js/db query cache integration', () => {
  let adapter: QueryCacheAdapter
  let bridge: MemoryQueryCacheBridge

  beforeEach(() => {
    adapter = new QueryCacheAdapter()
    bridge = new MemoryQueryCacheBridge(() => adapter.inTransaction)
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
    queryCacheInternals.resetDatabaseDependencyInvalidationListeners()
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
    expect(bridge.flexibleCalls[0]?.key).toMatch(/^db:query:/)
    expect(bridge.flexibleCalls[1]).toEqual({
      key: 'users.explicit',
      driver: 'redis',
      ttl: [300, 300],
    })
    expect(explicit[0]?.name).toBe('Changed')

    await DB.table(users).cache(new Date(Date.now() + 30_000)).get()
    expect(bridge.flexibleCalls[2]?.ttl).toEqual(expect.arrayContaining([
      expect.any(Number),
      expect.any(Number),
    ]))
    expect(Array.isArray(bridge.flexibleCalls[2]?.ttl)).toBe(true)
    const ttl = bridge.flexibleCalls[2]?.ttl
    if (!ttl || !Array.isArray(ttl)) {
      throw new Error('Expected Date TTL to normalize into a fixed tuple.')
    }
    expect(ttl[0]).toBe(ttl[1])
    expect(ttl[0]).toBeGreaterThan(0)

    await expect(
      DB.table(users).cache(new Date('invalid')).get(),
    ).rejects.toThrow('Query cache Date TTL must be valid')
  })

  it('notifies remaining database dependency listeners when one listener fails', async () => {
    const calls: string[] = []
    const error = new Error('listener failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    queryCacheInternals.onDatabaseDependencyInvalidated(() => {
      calls.push('first')
      throw error
    })
    queryCacheInternals.onDatabaseDependencyInvalidated(() => {
      calls.push('second')
    })

    await expect(queryCacheInternals.notifyDatabaseDependencyInvalidationListeners({
      connectionName: 'main',
      dependencies: ['db:main:posts'],
    })).resolves.toBeUndefined()

    expect(calls).toEqual(['first', 'second'])
    expect(consoleError).toHaveBeenCalledWith(
      '[@holo-js/db] Database dependency invalidation listener failed.',
      error,
    )
    consoleError.mockRestore()
  })

  it('derives structured invalidation metadata from dependency strings when no plan metadata is supplied', async () => {
    const events: unknown[] = []
    queryCacheInternals.onDatabaseDependencyInvalidated((event) => {
      events.push(event)
    })

    await invalidateQueryCacheDependencies(DB.connection(), [
      'external:dependency',
      'db:main:users',
      'db:main:posts',
      'db:main:users:mutation',
      'db:main:users:where:status:%22active%22',
      'db:main:users:where-exact:name:%22Ava%22',
      'db:main:users:',
      'db:',
      'db:main:',
      'db:main::row',
      'db:main:users:where::%22active%22',
      'db:main:users:where:status:',
      'db:main:users:unknown:status:%22active%22',
    ])

    const metadata = (events[0] as { [DATABASE_DEPENDENCY_METADATA_KEY]?: TestDependencyMetadata } | undefined)?.[
      DATABASE_DEPENDENCY_METADATA_KEY
    ]

    expect(events).toHaveLength(1)
    expect(metadata).toEqual({
      directDependencies: [
        'external:dependency',
        'db:main:users:mutation',
        'db:main:users:where:status:%22active%22',
        'db:main:users:where-exact:name:%22Ava%22',
        'db:main:users:',
        'db:',
        'db:main:',
        'db:main::row',
        'db:main:users:where::%22active%22',
        'db:main:users:where:status:',
        'db:main:users:unknown:status:%22active%22',
        'db:main:posts',
      ],
      exactPredicates: [{
        tableKey: 'db:main:users',
        columnName: 'name',
        encodedValue: '%22Ava%22',
      }],
      hasMutationDependency: true,
      predicates: [{
        tableKey: 'db:main:users',
        columnName: 'status',
        encodedValue: '%22active%22',
      }],
      tableDependencies: ['db:main:users'],
    })
  })

  it('collects structured query observations while collecting dependencies', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string(),
      created_at: column.timestamp(),
    })
    adapter.queryRows = [{ id: 1, name: 'Ava', status: 'active' }]

    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .where('status', 'active')
        .orderBy('created_at', 'desc')
        .limit(10)
        .get()
    })

    expect(result.value).toEqual([{ id: 1, name: 'Ava', status: 'active' }])
    expect(result.dependencies).toEqual([
      'db:main:users',
      'db:main:users:where:status:%22active%22',
    ])
    expect(result.queries).toEqual([expect.objectContaining({
      connectionName: 'main',
      tableName: 'users',
      dependencies: result.dependencies,
      limit: 10,
      orderBy: [{ column: 'created_at', direction: 'desc' }],
      patchable: true,
      predicates: [{ column: 'status', operator: '=', value: 'active' }],
    })])
  })

  it('collects nested conjunctive predicate observations as patchable queries', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string(),
    })
    adapter.queryRows = [{ id: 1, name: 'Ava', status: 'active' }]

    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .where(query => query.where('status', 'active').where('name', 'Ava'))
        .get()
    })

    expect(result.value).toEqual([{ id: 1, name: 'Ava', status: 'active' }])
    expect(result.queries).toEqual([expect.objectContaining({
      connectionName: 'main',
      tableName: 'users',
      patchable: true,
      predicates: [
        { column: 'status', operator: '=', value: 'active' },
        { column: 'name', operator: '=', value: 'Ava' },
      ],
    })])
  })

  it('keeps structured query observations out of the public dependency collector result', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })
    adapter.queryRows = [{ id: 1, name: 'Ava' }]

    const result = await collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .where('id', 1)
        .get()
    })

    expect(result).toEqual({
      value: [{ id: 1, name: 'Ava' }],
      dependencies: [
        'db:main:users:row:id:1',
        'db:main:users:row:*',
      ],
    })
    expect(Object.hasOwn(result, 'queries')).toBe(false)
  })

  it('keeps uncached normal reads off the realtime dependency observation path', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string(),
    })
    adapter.queryRows = [{ id: 1, name: 'Ava', status: 'active' }]

    const rows = await DB.table(users)
      .where('status', 'active')
      .get()

    expect(rows).toEqual([{ id: 1, name: 'Ava', status: 'active' }])
    expect(adapter.queryCount).toBe(1)
    expect(bridge.getCalls).toEqual([])
    expect(bridge.putCalls).toEqual([])
    expect(bridge.flexibleCalls).toEqual([])
    expect(bridge.invalidatedDependencies).toEqual([])

    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .where('status', 'active')
        .get()
    })

    expect(adapter.queryCount).toBe(2)
    expect(result.dependencies).toEqual([
      'db:main:users',
      'db:main:users:where:status:%22active%22',
    ])
    expect(result.queries).toEqual([expect.objectContaining({
      connectionName: 'main',
      tableName: 'users',
      patchable: true,
      predicates: [{ column: 'status', operator: '=', value: 'active' }],
    })])
    expect(bridge.getCalls).toEqual([])
    expect(bridge.putCalls).toEqual([])
    expect(bridge.flexibleCalls).toEqual([])
  })

  it('records broad observation dependencies for unsupported active collector reads', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })
    adapter.queryRows = [{ name: 'Ava', total: 2 }]

    await DB.table(users)
      .select('name')
      .addSelectSum('total', 'id')
      .groupBy('name')
      .having('sum(id)', '>', 1)
      .get()

    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .select('name')
        .addSelectSum('total', 'id')
        .groupBy('name')
        .having('sum(id)', '>', 1)
        .get()
    })

    expect(result.dependencies).toEqual(['db:main:users'])
    expect(result.queries).toEqual([expect.objectContaining({
      connectionName: 'main',
      tableName: 'users',
      patchable: false,
      dependencies: ['db:main:users'],
    })])
    expect(bridge.getCalls).toEqual([])
    expect(bridge.putCalls).toEqual([])
    expect(bridge.flexibleCalls).toEqual([])
  })

  it('records patchable grouped aggregate observation metadata', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      score: column.integer(),
    })
    adapter.queryRows = [{ name: 'Ava', total: 2 }]

    const countResult = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .select('name')
        .addSelectCount('total')
        .groupBy('name')
        .orderBy('name')
        .get()
    })

    expect(countResult.dependencies).toEqual(['db:main:users'])
    expect(countResult.queries).toEqual([expect.objectContaining({
      connectionName: 'main',
      dependencies: ['db:main:users'],
      groupedAggregate: {
        aggregateResultKey: 'total',
        groupColumn: 'name',
        groupResultKey: 'name',
        kind: 'count',
      },
      orderBy: [{ column: 'name', direction: 'asc' }],
      patchable: true,
      tableName: 'users',
    })])

    const redundantHavingResult = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .select('name')
        .addSelectCount('total')
        .groupBy('name')
        .having('count(*)', '>=', 1)
        .get()
    })

    expect(redundantHavingResult.dependencies).toEqual(['db:main:users'])
    expect(redundantHavingResult.queries).toEqual([expect.objectContaining({
      groupedAggregate: {
        aggregateResultKey: 'total',
        groupColumn: 'name',
        groupResultKey: 'name',
        kind: 'count',
      },
      patchable: true,
    })])

    const generatedPosts = defineGeneratedTable('posts', {
      id: column.id(),
      author_id: column.integer(),
      title: column.string(),
    })
    adapter.queryRows = [{ author_id: 1, total: 2 }]
    const generatedRedundantHavingResult = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(generatedPosts)
        .select('author_id')
        .addSelectCount('total')
        .groupBy('author_id')
        .having('count(*)', '>=', 1)
        .orderBy('author_id')
        .get()
    })

    expect(generatedRedundantHavingResult.dependencies).toEqual(['db:main:posts'])
    expect(generatedRedundantHavingResult.queries).toEqual([expect.objectContaining({
      groupedAggregate: {
        aggregateResultKey: 'total',
        groupColumn: 'author_id',
        groupResultKey: 'author_id',
        kind: 'count',
      },
      patchable: true,
    })])

    adapter.queryRows = [{ name: 'Ava', total: 2 }]
    const thresholdHavingResult = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .select('name')
        .addSelectCount('total')
        .groupBy('name')
        .having('count(*)', '>', 1)
        .get()
    })

    expect(thresholdHavingResult.dependencies).toEqual(['db:main:users'])
    expect(thresholdHavingResult.queries).toEqual([expect.objectContaining({
      groupedAggregate: {
        aggregateResultKey: 'total',
        groupColumn: 'name',
        groupResultKey: 'name',
        having: {
          operator: '>',
          value: 1,
        },
        kind: 'count',
      },
      patchable: true,
    })])

    adapter.queryRows = [{ name: 'Ava', score_total: 7 }]
    const sumResult = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .select('name')
        .addSelectSum('score_total', 'score')
        .groupBy('name')
        .orderBy('name')
        .get()
    })

    expect(sumResult.dependencies).toEqual(['db:main:users'])
    expect(sumResult.queries).toEqual([expect.objectContaining({
      connectionName: 'main',
      dependencies: ['db:main:users'],
      groupedAggregate: {
        aggregateColumn: 'score',
        aggregateResultKey: 'score_total',
        groupColumn: 'name',
        groupResultKey: 'name',
        kind: 'sum',
      },
      orderBy: [{ column: 'name', direction: 'asc' }],
      patchable: true,
      tableName: 'users',
    })])

    adapter.queryRows = [{ name: 'Ava', score_total: 7 }]
    const sumThresholdHavingResult = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .select('name')
        .addSelectSum('score_total', 'score')
        .groupBy('name')
        .having('count(*)', '>', 1)
        .orderBy('name')
        .get()
    })

    expect(sumThresholdHavingResult.queries).toEqual([expect.objectContaining({
      groupedAggregate: {
        aggregateColumn: 'score',
        aggregateResultKey: 'score_total',
        groupColumn: 'name',
        groupResultKey: 'name',
        having: {
          operator: '>',
          value: 1,
        },
        kind: 'sum',
      },
      patchable: true,
    })])

    adapter.queryRows = [{ average_score: 6, name: 'Ava' }]
    const avgResult = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .select('name')
        .addSelectAvg('average_score', 'score')
        .groupBy('name')
        .orderBy('name')
        .get()
    })

    expect(avgResult.queries).toEqual([expect.objectContaining({
      groupedAggregate: {
        aggregateColumn: 'score',
        aggregateResultKey: 'average_score',
        groupColumn: 'name',
        groupResultKey: 'name',
        kind: 'avg',
      },
      patchable: true,
    })])

    adapter.queryRows = [{ average_score: 6, name: 'Ava' }]
    const avgThresholdHavingResult = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .select('name')
        .addSelectAvg('average_score', 'score')
        .groupBy('name')
        .having('count(*)', '>', 1)
        .orderBy('name')
        .get()
    })

    expect(avgThresholdHavingResult.queries).toEqual([expect.objectContaining({
      groupedAggregate: {
        aggregateColumn: 'score',
        aggregateResultKey: 'average_score',
        groupColumn: 'name',
        groupResultKey: 'name',
        having: {
          operator: '>',
          value: 1,
        },
        kind: 'avg',
      },
      patchable: true,
    })])

    adapter.queryRows = [{ best_score: 9, name: 'Ava' }]
    const maxThresholdHavingResult = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .select('name')
        .addSelectMax('best_score', 'score')
        .groupBy('name')
        .having('count(*)', '>', 1)
        .orderBy('name')
        .get()
    })

    expect(maxThresholdHavingResult.queries).toEqual([expect.objectContaining({
      groupedAggregate: {
        aggregateColumn: 'score',
        aggregateResultKey: 'best_score',
        groupColumn: 'name',
        groupResultKey: 'name',
        having: {
          operator: '>',
          value: 1,
        },
        kind: 'max',
      },
      patchable: true,
    })])

    adapter.queryRows = [{ lowest_score: 3, name: 'Ava' }]
    const minThresholdHavingResult = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .select('name')
        .addSelectMin('lowest_score', 'score')
        .groupBy('name')
        .having('count(*)', '>', 1)
        .orderBy('name')
        .get()
    })

    expect(minThresholdHavingResult.queries).toEqual([expect.objectContaining({
      groupedAggregate: {
        aggregateColumn: 'score',
        aggregateResultKey: 'lowest_score',
        groupColumn: 'name',
        groupResultKey: 'name',
        having: {
          operator: '>',
          value: 1,
        },
        kind: 'min',
      },
      patchable: true,
    })])

    adapter.queryRows = [{ best_score: 9, name: 'Ava' }]
    const maxResult = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .select('name')
        .addSelectMax('best_score', 'score')
        .groupBy('name')
        .orderBy('name')
        .get()
    })

    expect(maxResult.queries).toEqual([expect.objectContaining({
      groupedAggregate: {
        aggregateColumn: 'score',
        aggregateResultKey: 'best_score',
        groupColumn: 'name',
        groupResultKey: 'name',
        kind: 'max',
      },
      patchable: true,
    })])

    adapter.queryRows = [{ lowest_score: 3, name: 'Ava' }]
    const minResult = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .select('name')
        .addSelectMin('lowest_score', 'score')
        .groupBy('name')
        .orderBy('name')
        .get()
    })

    expect(minResult.queries).toEqual([expect.objectContaining({
      groupedAggregate: {
        aggregateColumn: 'score',
        aggregateResultKey: 'lowest_score',
        groupColumn: 'name',
        groupResultKey: 'name',
        kind: 'min',
      },
      patchable: true,
    })])
  })

  it('records hidden grouped average state metadata while collecting dependencies', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      score: column.integer(),
    })
    adapter.query = async <TRow extends Record<string, unknown> = Record<string, unknown>>(
      sql = '',
      bindings: readonly unknown[] = [],
    ): Promise<DriverQueryResult<TRow>> => {
      adapter.queryCount += 1
      adapter.queries.push({ sql, bindings })
      const rows = sql.includes('__holo_grouped_average_count')
        ? [
            {
              __holo_grouped_average_count: '2',
              __holo_grouped_average_group: 'Ava',
              __holo_grouped_average_row_count: 2,
              __holo_grouped_average_sum: '12',
            },
            {
              __holo_grouped_average_count: 1,
              __holo_grouped_average_group: 'Ben',
              __holo_grouped_average_row_count: 1,
              __holo_grouped_average_sum: 10,
            },
          ]
        : [{ average_score: 6, name: 'Ava' }]

      return {
        rows: rows as unknown as TRow[],
        rowCount: rows.length,
      }
    }

    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .select('name')
        .addSelectAvg('average_score', 'score')
        .groupBy('name')
        .having('count(*)', '>', 1)
        .orderBy('name')
        .get()
    })

    expect(result.value).toEqual([{ average_score: 6, name: 'Ava' }])
    expect(result.queries).toEqual([expect.objectContaining({
      groupedAggregate: {
        aggregateColumn: 'score',
        aggregateResultKey: 'average_score',
        averageStates: [{
          count: 2,
          groupValue: 'Ava',
          rowCount: 2,
          sum: 12,
        }, {
          count: 1,
          groupValue: 'Ben',
          rowCount: 1,
          sum: 10,
        }],
        groupColumn: 'name',
        groupResultKey: 'name',
        having: {
          operator: '>',
          value: 1,
        },
        kind: 'avg',
      },
      patchable: true,
    })])
    expect(adapter.queries).toHaveLength(2)
    expect(adapter.queries[0]?.sql).toContain('AVG("score")')
    expect(adapter.queries[1]?.sql).toContain('COUNT("score")')
    expect(adapter.queries[1]?.sql).toContain('COUNT(*)')
    expect(adapter.queries[1]?.sql).toContain('SUM("score")')
    expect(adapter.queries[1]?.sql).not.toContain('HAVING')
  })

  it('records hidden grouped sum state metadata while collecting dependencies', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      score: column.integer(),
    })
    adapter.query = async <TRow extends Record<string, unknown> = Record<string, unknown>>(
      sql = '',
      bindings: readonly unknown[] = [],
    ): Promise<DriverQueryResult<TRow>> => {
      adapter.queryCount += 1
      adapter.queries.push({ sql, bindings })
      const rows = sql.includes('__holo_grouped_aggregate_state_value')
        ? [
            {
              __holo_grouped_aggregate_state_group: 'Ava',
              __holo_grouped_aggregate_state_row_count: '2',
              __holo_grouped_aggregate_state_value: '12',
            },
            {
              __holo_grouped_aggregate_state_group: 'Ben',
              __holo_grouped_aggregate_state_row_count: 1,
              __holo_grouped_aggregate_state_value: 10,
            },
            {
              __holo_grouped_aggregate_state_group: 'Null',
              __holo_grouped_aggregate_state_row_count: null,
              __holo_grouped_aggregate_state_value: null,
            },
            {
              __holo_grouped_aggregate_state_group: 'Big',
              __holo_grouped_aggregate_state_row_count: 1n,
              __holo_grouped_aggregate_state_value: 2n,
            },
          ]
        : [{ name: 'Ava', score_total: 12 }]

      return {
        rows: rows as unknown as TRow[],
        rowCount: rows.length,
      }
    }

    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .select('name')
        .addSelectSum('score_total', 'score')
        .groupBy('name')
        .having('count(*)', '>', 1)
        .orderBy('name')
        .get()
    })

    expect(result.value).toEqual([{ name: 'Ava', score_total: 12 }])
    expect(result.queries).toEqual([expect.objectContaining({
      groupedAggregate: {
        aggregateColumn: 'score',
        aggregateResultKey: 'score_total',
        aggregateStates: [{
          aggregateValue: 12,
          groupValue: 'Ava',
          rowCount: 2,
        }, {
        aggregateValue: 10,
        groupValue: 'Ben',
        rowCount: 1,
        }, {
          aggregateValue: 0,
          groupValue: 'Null',
          rowCount: 0,
        }, {
          aggregateValue: 2,
          groupValue: 'Big',
          rowCount: 1,
        }],
        groupColumn: 'name',
        groupResultKey: 'name',
        having: {
          operator: '>',
          value: 1,
        },
        kind: 'sum',
      },
      patchable: true,
    })])
    expect(adapter.queries).toHaveLength(2)
    expect(adapter.queries[0]?.sql).toContain('SUM("score")')
    expect(adapter.queries[1]?.sql).toContain('SUM("score")')
    expect(adapter.queries[1]?.sql).toContain('COUNT(*)')
    expect(adapter.queries[1]?.sql).not.toContain('HAVING')
  })

  it('records hidden grouped minimum state metadata while collecting dependencies', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      score: column.integer(),
    })
    adapter.query = async <TRow extends Record<string, unknown> = Record<string, unknown>>(
      sql = '',
      bindings: readonly unknown[] = [],
    ): Promise<DriverQueryResult<TRow>> => {
      adapter.queryCount += 1
      adapter.queries.push({ sql, bindings })
      const rows = sql.includes('__holo_grouped_aggregate_state_value_count')
        ? [
            {
              __holo_grouped_aggregate_state_count_value: 5,
              __holo_grouped_aggregate_state_group: 'Ava',
              __holo_grouped_aggregate_state_value_count: 1,
            },
            {
              __holo_grouped_aggregate_state_count_value: 7,
              __holo_grouped_aggregate_state_group: 'Ava',
              __holo_grouped_aggregate_state_value_count: 1,
            },
            {
              __holo_grouped_aggregate_state_count_value: 10,
              __holo_grouped_aggregate_state_group: 'Ben',
              __holo_grouped_aggregate_state_value_count: 1,
            },
          ]
        : sql.includes('__holo_grouped_aggregate_state_value')
          ? [
              {
                __holo_grouped_aggregate_state_group: 'Ava',
                __holo_grouped_aggregate_state_row_count: '2',
                __holo_grouped_aggregate_state_value: '5',
              },
              {
                __holo_grouped_aggregate_state_group: 'Ben',
                __holo_grouped_aggregate_state_row_count: 1,
                __holo_grouped_aggregate_state_value: 10,
              },
              {
                __holo_grouped_aggregate_state_group: 'NoCounts',
                __holo_grouped_aggregate_state_row_count: 1,
                __holo_grouped_aggregate_state_value: 12,
              },
            ]
          : [{ lowest_score: 5, name: 'Ava' }]

      return {
        rows: rows as unknown as TRow[],
        rowCount: rows.length,
      }
    }

    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .select('name')
        .addSelectMin('lowest_score', 'score')
        .groupBy('name')
        .having('count(*)', '>', 1)
        .orderBy('name')
        .get()
    })

    expect(result.value).toEqual([{ lowest_score: 5, name: 'Ava' }])
    expect(result.queries).toEqual([expect.objectContaining({
      groupedAggregate: {
        aggregateColumn: 'score',
        aggregateResultKey: 'lowest_score',
          aggregateStates: [{
            aggregateValue: 5,
            groupValue: 'Ava',
            rowCount: 2,
            valueCounts: [{
              count: 1,
              value: 5,
            }, {
              count: 1,
              value: 7,
            }],
          }, {
            aggregateValue: 10,
            groupValue: 'Ben',
            rowCount: 1,
            valueCounts: [{
              count: 1,
              value: 10,
            }],
          }, {
            aggregateValue: 12,
            groupValue: 'NoCounts',
            rowCount: 1,
            valueCounts: [],
          }],
        groupColumn: 'name',
        groupResultKey: 'name',
        having: {
          operator: '>',
          value: 1,
        },
        kind: 'min',
      },
      patchable: true,
    })])
    expect(adapter.queries).toHaveLength(3)
    expect(adapter.queries[0]?.sql).toContain('MIN("score")')
    expect(adapter.queries[1]?.sql).toContain('"score" AS "__holo_grouped_aggregate_state_count_value"')
    expect(adapter.queries[1]?.sql).toContain('COUNT(*)')
    expect(adapter.queries[1]?.sql).not.toContain('HAVING')
    expect(adapter.queries[2]?.sql).toContain('MIN("score")')
    expect(adapter.queries[2]?.sql).toContain('COUNT(*)')
    expect(adapter.queries[2]?.sql).not.toContain('HAVING')
  })

  it('omits grouped aggregate state metadata when driver values cannot be represented safely', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      score: column.integer(),
    })
    adapter.query = async <TRow extends Record<string, unknown> = Record<string, unknown>>(
      sql = '',
    ): Promise<DriverQueryResult<TRow>> => {
      const rows = sql.includes('__holo_grouped_aggregate_state_value_count')
        ? []
        : sql.includes('__holo_grouped_aggregate_state_value')
          ? [{
              __holo_grouped_aggregate_state_group: 'Ava',
              __holo_grouped_aggregate_state_row_count: 1,
              __holo_grouped_aggregate_state_value: null,
            }]
          : [{ lowest_score: null, name: 'Ava' }]
      return { rowCount: rows.length, rows: rows as unknown as TRow[] }
    }

    const minimum = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return DB.table(users)
        .select('name')
        .addSelectMin('lowest_score', 'score')
        .groupBy('name')
        .having('count(*)', '>', 0)
        .get()
    })
    expect(minimum.queries[0]?.groupedAggregate).not.toHaveProperty('aggregateStates')

    adapter.query = async <TRow extends Record<string, unknown> = Record<string, unknown>>(
      sql = '',
    ): Promise<DriverQueryResult<TRow>> => {
      const rows = sql.includes('__holo_grouped_aggregate_state_value')
        ? [{
            __holo_grouped_aggregate_state_group: 'Ava',
            __holo_grouped_aggregate_state_row_count: 1,
            __holo_grouped_aggregate_state_value: 9007199254740992n,
          }]
        : [{ name: 'Ava', score_total: 1 }]
      return { rowCount: rows.length, rows: rows as unknown as TRow[] }
    }
    const sum = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return DB.table(users)
        .select('name')
        .addSelectSum('score_total', 'score')
        .groupBy('name')
        .having('count(*)', '>', 0)
        .get()
    })
    expect(sum.queries[0]?.groupedAggregate).not.toHaveProperty('aggregateStates')

    for (const value of [Number.POSITIVE_INFINITY, 'not-a-number']) {
      adapter.query = async <TRow extends Record<string, unknown> = Record<string, unknown>>(
        sql = '',
      ): Promise<DriverQueryResult<TRow>> => {
        const rows = sql.includes('__holo_grouped_aggregate_state_value')
          ? [{
              __holo_grouped_aggregate_state_group: 'Ava',
              __holo_grouped_aggregate_state_row_count: 1,
              __holo_grouped_aggregate_state_value: value,
            }]
          : [{ name: 'Ava', score_total: 1 }]
        return { rowCount: rows.length, rows: rows as unknown as TRow[] }
      }
      const malformed = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
        return DB.table(users)
          .select('name')
          .addSelectSum('score_total', 'score')
          .groupBy('name')
          .having('count(*)', '>', 0)
          .get()
      })
      expect(malformed.queries[0]?.groupedAggregate).not.toHaveProperty('aggregateStates')
    }
  })

  it('keeps dependency observation helpers inert when no collector or listener is active', async () => {
    expect(readDatabaseQueryObservationCount()).toBe(0)
    expect(queryCacheInternals.hasActiveDatabaseDependencyCollector()).toBe(false)
    expect(queryCacheInternals.hasDatabaseDependencyInvalidationListeners()).toBe(false)
    expect(queryCacheInternals.createTablePredicateCacheDependency('main', 'users', 'status', undefined)).toBeUndefined()

    queryCacheInternals.recordDatabaseQueryDependencies(['db:main:users'])
    queryCacheInternals.recordDatabaseQueryObservation(undefined)
    queryCacheInternals.disableDatabaseQueryObservationPatching([])
    truncateDatabaseQueryObservations(0)
    await expect(invalidateQueryCacheDependencies(DB.connection(), [])).resolves.toBeUndefined()
    queryCacheInternals.recordDatabaseQueryObservation(queryCacheInternals.createDatabaseQueryObservation(
      (
        new TableQueryBuilder('users', DB.connection())
          .where('status', 'active') as unknown as { readonly plan: SelectQueryPlan }
      ).plan,
      'main',
      ['db:main:users'],
      [],
    ))

    await expect(queryCacheInternals.notifyDatabaseDependencyInvalidationListeners({
      connectionName: 'main',
      dependencies: ['db:main:users'],
    })).resolves.toBeUndefined()

    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => true)

    expect(result).toEqual({
      value: true,
      dependencies: [],
      queries: [],
    })
  })

  it('rebinds standard and cursor pagination observations by source identity', async () => {
    const users = defineTable('users', {
      id: column.id(),
    })
    const plan = DB.table(users).orderBy('id').getPlan()
    const dependencies = ['db:main:users']
    expect(inferDatabaseQueryObservationDependencies(plan, 'main')).toBeUndefined()
    expect(createDatabaseQueryFallbackObservation(plan, 'main', [])).toBeUndefined()

    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      const standardSource = [{ id: 1 }]
      queryCacheInternals.recordDatabaseQueryObservation(
        queryCacheInternals.createDatabaseQueryObservation(plan, 'main', dependencies, standardSource),
      )
      truncateDatabaseQueryObservations(99)
      rebindDatabaseQueryObservationPagination([], standardSource, {
        total: 1,
        perPage: 1,
        pageName: 'page',
        currentPage: 1,
        lastPage: 1,
        from: 1,
        to: 1,
        hasMorePages: false,
      }, {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 1,
        total: 1,
      }, 0)
      rebindDatabaseQueryObservationPagination(standardSource, standardSource, {
        total: 1,
        perPage: 1,
        pageName: 'page',
        currentPage: 1,
        lastPage: 1,
        from: 1,
        to: 1,
        hasMorePages: false,
      }, {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 1,
        total: 1,
      }, 0)

      const cursorSource = [{ id: 1 }]
      queryCacheInternals.recordDatabaseQueryObservation(
        queryCacheInternals.createDatabaseQueryObservation(plan, 'main', dependencies, cursorSource),
      )
      const cursorMeta = { cursorName: 'cursor', nextCursor: null, perPage: 1, prevCursor: null }
      const cursor = {
        cursorName: 'cursor',
        hasMorePages: false,
        kind: 'cursor' as const,
        nextCursor: null,
        perPage: 1,
        prevCursor: null,
        rowCount: 1,
        rows: cursorSource,
      }
      rebindDatabaseQueryObservationCursorPagination([], cursorSource, cursorMeta, cursor)
      rebindDatabaseQueryObservationCursorPagination(cursorSource, cursorSource, cursorMeta, cursor)
      return true
    })

    expect(result.value).toBe(true)
    expect(result.queries).toHaveLength(4)
  })

  it('keeps uncached aggregate reads off the realtime dependency observation path', async () => {
    const posts = defineTable('posts', {
      id: column.id(),
      status: column.string(),
      views: column.integer(),
    })
    adapter.queryRows = [
      { id: 1, status: 'published', views: 5 },
      { id: 2, status: 'published', views: 7 },
    ]

    const count = await DB.table(posts).where('status', 'published').count()
    const views = await DB.table(posts).where('status', 'published').sum('views')

    expect(count).toBe(2)
    expect(views).toBe(12)
    expect(adapter.queryCount).toBe(2)
    expect(queryCacheInternals.hasActiveDatabaseDependencyCollector()).toBe(false)
    expect(bridge.getCalls).toEqual([])
    expect(bridge.putCalls).toEqual([])
    expect(bridge.flexibleCalls).toEqual([])
    expect(bridge.invalidatedDependencies).toEqual([])

    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(posts)
        .where('status', 'published')
        .sum('views')
    })

    expect(result.value).toBe(12)
    expect(result.queries).toEqual([expect.objectContaining({
      aggregate: { column: 'views', kind: 'sum' },
      connectionName: 'main',
      tableName: 'posts',
      patchable: true,
      predicates: [{ column: 'status', operator: '=', value: 'published' }],
      result: 12,
    })])
  })

  it('collects model aggregate observations for empty and populated result sets', async () => {
    const users = defineTable('users', {
      id: column.id(),
      score: column.integer(),
    })
    const User = defineModelFromTable(users)

    adapter.queryRows = []
    const empty = await queryCacheInternals.collectDatabaseQueryDependencies(async () => ({
      average: await User.avg('score'),
      maximum: await User.max('score'),
      minimum: await User.min('score'),
      total: await User.sum('score'),
    }))
    expect(empty.value).toEqual({ average: null, maximum: null, minimum: null, total: 0 })
    expect(empty.queries).toHaveLength(4)

    adapter.queryRows = [
      { id: 1, score: 2 },
      { id: 2, score: 2 },
      { id: 3, score: 4 },
    ]
    const populated = await queryCacheInternals.collectDatabaseQueryDependencies(async () => ({
      average: await User.avg('score'),
      maximum: await User.max('score'),
      minimum: await User.min('score'),
      total: await User.sum('score'),
    }))
    expect(populated.value).toEqual({ average: 8 / 3, maximum: 4, minimum: 2, total: 8 })
    expect(populated.queries).toHaveLength(4)
  })

  it('collects table aggregate and existence observations for empty and populated rows', async () => {
    const users = defineTable('users', {
      id: column.id(),
      score: column.integer(),
    })

    adapter.queryRows = []
    const empty = await queryCacheInternals.collectDatabaseQueryDependencies(async () => ({
      average: await DB.table(users).avg('score'),
      exists: await DB.table(users).exists(),
      maximum: await DB.table(users).max('score'),
      minimum: await DB.table(users).min('score'),
      missing: await DB.table(users).doesntExist(),
    }))
    expect(empty.value).toEqual({ average: null, exists: false, maximum: null, minimum: null, missing: true })

    adapter.queryRows = [
      { id: 1, score: 2 },
      { id: 2, score: 2 },
      { id: 3, score: 4 },
    ]
    const populated = await queryCacheInternals.collectDatabaseQueryDependencies(async () => ({
      average: await DB.table(users).avg('score'),
      exists: await DB.table(users).exists(),
      maximum: await DB.table(users).max('score'),
      minimum: await DB.table(users).min('score'),
      missing: await DB.table(users).doesntExist(),
    }))
    expect(populated.value).toEqual({ average: 8 / 3, exists: true, maximum: 4, minimum: 2, missing: false })
  })

  it('collects paginated data and metadata observations while collecting dependencies', async () => {
    const posts = defineTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    adapter.queryRows = [
      { id: 3, title: 'Third' },
      { id: 2, title: 'Second' },
      { id: 1, title: 'First' },
    ]

    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(posts)
        .orderBy('id', 'desc')
        .paginate(2, 1)
    })

    expect(result.value.toJSON()).toEqual({
      data: [
        { id: 3, title: 'Third' },
        { id: 2, title: 'Second' },
      ],
      meta: {
        total: 3,
        perPage: 2,
        pageName: 'page',
        currentPage: 1,
        lastPage: 2,
        from: 1,
        to: 2,
        hasMorePages: true,
      },
    })
    expect(result.queries).toEqual([
      expect.objectContaining({
        limit: 2,
        offset: 0,
        orderBy: [{ column: 'id', direction: 'desc' }],
        pagination: undefined,
        result: [
          { id: 3, title: 'Third' },
          { id: 2, title: 'Second' },
        ],
      }),
      expect.objectContaining({
        limit: undefined,
        offset: undefined,
        orderBy: [{ column: 'id', direction: 'desc' }],
        pagination: {
          currentPage: 1,
          kind: 'standard',
          pageName: 'page',
          perPage: 2,
          total: 3,
        },
        result: {
          total: 3,
          perPage: 2,
          pageName: 'page',
          currentPage: 1,
          lastPage: 2,
          from: 1,
          to: 2,
          hasMorePages: true,
        },
      }),
    ])
  })

  it('collects cursor paginated data and cursor metadata observations while collecting dependencies', async () => {
    const posts = defineTable('posts', {
      id: column.id(),
      title: column.string(),
    })
    adapter.queryRows = [
      { id: 1, title: 'First' },
      { id: 2, title: 'Second' },
      { id: 3, title: 'Third' },
    ]

    const firstPage = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(posts)
        .orderBy('id')
        .cursorPaginate(2)
    })

    expect(firstPage.value.toJSON()).toEqual({
      data: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
      perPage: 2,
      cursorName: 'cursor',
      nextCursor: expect.any(String),
      prevCursor: null,
    })
    expect(firstPage.queries).toEqual([
      expect.objectContaining({
        cursorRowCount: 3,
        cursorRows: [
          { id: 1, title: 'First' },
          { id: 2, title: 'Second' },
          { id: 3, title: 'Third' },
        ],
        limit: 2,
        orderBy: [{ column: 'id', direction: 'asc' }],
        pagination: undefined,
        result: [
          { id: 1, title: 'First' },
          { id: 2, title: 'Second' },
        ],
      }),
      expect.objectContaining({
        limit: undefined,
        orderBy: [{ column: 'id', direction: 'asc' }],
        pagination: expect.objectContaining({
          cursorName: 'cursor',
          hasMorePages: true,
          kind: 'cursor',
          nextCursor: firstPage.value.nextCursor,
          perPage: 2,
          prevCursor: null,
          rowCount: 3,
        }),
        result: firstPage.value.nextCursor,
        resultPath: ['nextCursor'],
      }),
    ])

    const secondPage = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(posts)
        .orderBy('id')
        .cursorPaginate(2, firstPage.value.nextCursor)
    })

    expect(secondPage.value.toJSON()).toEqual({
      data: [{ id: 3, title: 'Third' }],
      perPage: 2,
      cursorName: 'cursor',
      nextCursor: null,
      prevCursor: firstPage.value.nextCursor,
    })
    expect(secondPage.queries).toEqual([expect.objectContaining({
      limit: undefined,
      orderBy: [{ column: 'id', direction: 'asc' }],
      result: [{ id: 3, title: 'Third' }],
    })])
  })

  it('marks unsafe structured query observations as non-patchable', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string(),
      created_at: column.timestamp(),
    })
    adapter.queryRows = [{ id: 1, name: 'Ava', status: 'active' }]

    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      await DB.table(users).select('name').get()
      await DB.table(users).orderBy('id').offset(1).get()
      await DB.table(users)
        .where('status', 'active')
        .orWhere('status', 'pending')
        .get()
      return true
    })

    expect(result.queries).toHaveLength(3)
    expect(result.queries.map(query => query.patchable)).toEqual([false, false, false])
  })

  it('collects patchable column projection observations when required columns are selected', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string(),
      created_at: column.timestamp(),
    })
    adapter.queryRows = [{ id: 1, name: 'Ava', status: 'active', label: 'Ava' }]

    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .select('id', 'status', 'created_at', 'name as label')
        .where('status', 'active')
        .orderBy('created_at', 'desc')
        .get()
    })

    expect(result.queries).toEqual([expect.objectContaining({
      patchable: true,
      selections: [
        { column: 'id', resultKey: 'id' },
        { column: 'status', resultKey: 'status' },
        { column: 'created_at', resultKey: 'created_at' },
        { column: 'name', resultKey: 'label' },
      ],
    })])
  })

  it('keeps projected observations patchable when predicates are not selected', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string(),
      created_at: column.timestamp(),
    })
    adapter.queryRows = [{ id: 1, name: 'Ava' }]

    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .select('id', 'name')
        .where('status', 'active')
        .orderBy('id')
        .limit(10)
        .get()
    })

    expect(result.queries).toEqual([expect.objectContaining({
      patchable: true,
      predicates: [{ column: 'status', operator: '=', value: 'active' }],
      selections: [
        { column: 'id', resultKey: 'id' },
        { column: 'name', resultKey: 'name' },
      ],
    })])
  })

  it('keeps exact primary key single projections patchable without selecting the primary key', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string(),
    })
    adapter.queryRows = [{ name: 'Ava' }]

    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .select('name')
        .where('id', 1)
        .first()
    })

    expect(result.queries).toEqual([expect.objectContaining({
      limit: 1,
      patchable: true,
      predicates: [{ column: 'id', operator: '=', value: 1 }],
      selections: [
        { column: 'name', resultKey: 'name' },
      ],
    })])
  })

  it('keeps bounded ordered offset observations patchable', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string(),
    })
    adapter.queryRows = [
      { id: 2, name: 'Bryn', status: 'active' },
      { id: 3, name: 'Cora', status: 'active' },
    ]

    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .select('id', 'name')
        .where('status', 'active')
        .orderBy('id')
        .offset(1)
        .limit(2)
        .get()
    })

    expect(result.queries).toEqual([expect.objectContaining({
      limit: 2,
      offset: 1,
      patchable: true,
      predicates: [{ column: 'status', operator: '=', value: 'active' }],
      selections: [
        { column: 'id', resultKey: 'id' },
        { column: 'name', resultKey: 'name' },
      ],
    })])
  })

  it('collects aggregate query observations', async () => {
    const posts = defineTable('posts', {
      id: column.id(),
      status: column.string(),
      views: column.integer(),
    })
    adapter.queryRows = [
      { id: 1, status: 'published', views: 5 },
      { id: 2, status: 'published', views: 7 },
    ]

    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => ({
      average: await DB.table(posts).where('status', 'published').avg('views'),
      count: await DB.table(posts).where('status', 'published').count(),
      maximum: await DB.table(posts).where('status', 'published').max('views'),
      minimum: await DB.table(posts).where('status', 'published').min('views'),
      views: await DB.table(posts).where('status', 'published').sum('views'),
    }))

    expect(result.value).toEqual({
      average: 6,
      count: 2,
      maximum: 7,
      minimum: 5,
      views: 12,
    })
    expect(result.queries).toEqual([
      expect.objectContaining({
        aggregate: expect.objectContaining({ column: 'views', count: 2, kind: 'avg', sum: 12 }),
        connectionName: 'main',
        tableName: 'posts',
        patchable: true,
        predicates: [{ column: 'status', operator: '=', value: 'published' }],
        result: 6,
      }),
      expect.objectContaining({
        aggregate: expect.objectContaining({ kind: 'count' }),
        connectionName: 'main',
        tableName: 'posts',
        patchable: true,
        predicates: [{ column: 'status', operator: '=', value: 'published' }],
        result: 2,
      }),
      expect.objectContaining({
        aggregate: expect.objectContaining({
          column: 'views',
          currentValueCount: 1,
          kind: 'max',
          valueCounts: [
            { count: 1, value: 5 },
            { count: 1, value: 7 },
          ],
        }),
        connectionName: 'main',
        tableName: 'posts',
        patchable: true,
        predicates: [{ column: 'status', operator: '=', value: 'published' }],
        result: 7,
      }),
      expect.objectContaining({
        aggregate: expect.objectContaining({
          column: 'views',
          currentValueCount: 1,
          kind: 'min',
          valueCounts: [
            { count: 1, value: 5 },
            { count: 1, value: 7 },
          ],
        }),
        connectionName: 'main',
        tableName: 'posts',
        patchable: true,
        predicates: [{ column: 'status', operator: '=', value: 'published' }],
        result: 5,
      }),
      expect.objectContaining({
        aggregate: expect.objectContaining({ column: 'views', kind: 'sum' }),
        connectionName: 'main',
        tableName: 'posts',
        patchable: true,
        predicates: [{ column: 'status', operator: '=', value: 'published' }],
        result: 12,
      }),
    ])
  })

  it('binds first query observations to the returned row', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })
    adapter.queryRows = [{ id: 1, name: 'Ava' }]

    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      return await DB.table(users)
        .where('id', 1)
        .first()
    })

    expect(result.value).toEqual({ id: 1, name: 'Ava' })
    expect(result.queries).toEqual([expect.objectContaining({
      connectionName: 'main',
      tableName: 'users',
      limit: 1,
      patchable: true,
      predicates: [{ column: 'id', operator: '=', value: 1 }],
      result: result.value,
    })])
  })

  it('includes structured mutation events with dependency invalidations', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string(),
    })
    const events: unknown[] = []
    queryCacheInternals.onDatabaseDependencyInvalidated((event) => {
      events.push(event)
    })
    adapter.queryRows = [{ id: 2, name: 'Old', status: 'active' }]

    await DB.table(users).where('status', 'active').update({ name: 'Ava' })

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(expect.objectContaining({
      connectionName: 'main',
      mutations: [{
        connectionName: 'main',
        tableName: 'users',
        kind: 'update',
        predicates: [{ column: 'status', operator: '=', value: 'active' }],
        previousRows: [{ id: 2, name: 'Old', status: 'active' }],
        values: { name: 'Ava' },
        rows: [{ id: 2, name: 'Ava', status: 'active' }],
      }],
    }))
  })

  it('includes structured delete mutation events with dependency invalidations', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })
    const events: unknown[] = []
    queryCacheInternals.onDatabaseDependencyInvalidated((event) => {
      events.push(event)
    })
    adapter.queryRows = [{ id: 1, name: 'Ava' }]

    await DB.table(users).where('id', 1).delete()

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(expect.objectContaining({
      connectionName: 'main',
      dependencies: expect.arrayContaining([
        'db:main:users',
        'db:main:users:mutation',
        'db:main:users:row:id:1',
        'db:main:users:where:id:1',
        'db:main:users:where-exact:id:1',
      ]),
      mutations: [{
        connectionName: 'main',
        tableName: 'users',
        kind: 'delete',
        predicates: [{ column: 'id', operator: '=', value: 1 }],
        previousRows: undefined,
        values: undefined,
        rows: [{ id: 1, name: 'Ava' }],
      }],
    }))

    const event = events[0] as Record<string, unknown>
    const descriptor = Object.getOwnPropertyDescriptor(event, DATABASE_DEPENDENCY_METADATA_KEY)
    const metadata = event[DATABASE_DEPENDENCY_METADATA_KEY] as TestDependencyMetadata | undefined
    expect(descriptor?.enumerable).toBe(false)
    expect(Object.keys(event)).not.toContain(DATABASE_DEPENDENCY_METADATA_KEY)
    expect(JSON.stringify(event)).not.toContain(DATABASE_DEPENDENCY_METADATA_KEY)
    expect(metadata).toEqual({
      directDependencies: expect.arrayContaining([
        'db:main:users:mutation',
        'db:main:users:row:id:1',
        'db:main:users:where:id:1',
        'db:main:users:where-exact:id:1',
      ]),
      exactPredicates: expect.arrayContaining([
        {
          tableKey: 'db:main:users',
          columnName: 'id',
          encodedValue: '1',
        },
      ]),
      hasMutationDependency: true,
      predicates: expect.arrayContaining([
        {
          tableKey: 'db:main:users',
          columnName: 'id',
          encodedValue: '1',
        },
      ]),
      tableDependencies: ['db:main:users'],
    })
  })

  it('handles empty non-returning update and delete mutation captures', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })
    const events: unknown[] = []
    queryCacheInternals.onDatabaseDependencyInvalidated((event) => {
      events.push(event)
    })
    adapter.queryRows = []

    await DB.table(users).where('id', 1).update({ name: 'Missing' })
    await DB.table(users).where('id', 1).delete()

    expect(events).toHaveLength(2)
    expect(events).toEqual([
      expect.objectContaining({ mutations: [expect.objectContaining({ kind: 'update', rows: undefined })] }),
      expect.objectContaining({ mutations: [expect.objectContaining({ kind: 'delete', rows: undefined })] }),
    ])
  })

  it('aligns captured upsert previous rows with the input row order', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string(),
    })
    const events: unknown[] = []
    queryCacheInternals.onDatabaseDependencyInvalidated((event) => {
      events.push(event)
    })
    adapter.queryRows = [
      { id: 2, name: 'Second', status: 'active' },
      { id: 1, name: 'First', status: 'active' },
    ]

    await DB.table(users).upsert([
      { id: 1, name: 'Updated First', status: 'active' },
      { id: 2, name: 'Updated Second', status: 'active' },
    ], ['id'], ['name'])

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(expect.objectContaining({
      mutations: [expect.objectContaining({
        kind: 'upsert',
        previousRows: [
          { id: 1, name: 'First', status: 'active' },
          { id: 2, name: 'Second', status: 'active' },
        ],
        rows: [
          { id: 1, name: 'Updated First', status: 'active' },
          { id: 2, name: 'Updated Second', status: 'active' },
        ],
      })],
    }))

    adapter.queryRows = [{ id: 2, name: 'Second', status: 'active' }]
    await DB.table(users).upsert([
      { id: 1, name: 'Missing First', status: 'active' },
    ], ['id'], ['name'])
    expect(events[1]).toEqual(expect.objectContaining({
      mutations: [expect.objectContaining({ previousRows: [] })],
    }))

  })

  it('captures non-returning JSON update rows with applied JSON values', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      settings: column.json(),
    })
    const events: unknown[] = []
    queryCacheInternals.onDatabaseDependencyInvalidated((event) => {
      events.push(event)
    })
    adapter.queryRows = [{
      id: 1,
      name: 'Ava',
      settings: {
        flags: {
          beta: false,
        },
        profile: {
          region: 'mena',
        },
      },
    }]

    await DB.table(users)
      .where('id', 1)
      .updateJson('settings->profile->region', 'eu')

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(expect.objectContaining({
      mutations: [expect.objectContaining({
        kind: 'update',
        previousRows: [{
          id: 1,
          name: 'Ava',
          settings: {
            flags: {
              beta: false,
            },
            profile: {
              region: 'mena',
            },
          },
        }],
        rows: [{
          id: 1,
          name: 'Ava',
          settings: {
            flags: {
              beta: false,
            },
            profile: {
              region: 'eu',
            },
          },
        }],
      })],
    }))

    adapter.queryRows = [{ id: 2, name: 'Nora', settings: 'legacy' }]
    await DB.table(users)
      .where('id', 2)
      .updateJson('settings->profile->region', 'eu')
    expect(events[1]).toEqual(expect.objectContaining({
      mutations: [expect.objectContaining({
        rows: [{
          id: 2,
          name: 'Nora',
          settings: { profile: { region: 'eu' } },
        }],
      })],
    }))
  })

  it('uses returning mutation rows instead of pre-reading rows when the dialect supports returning', async () => {
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: {
          adapter,
          dialect: createReturningDialect(),
          driver: 'sqlite',
        },
      },
    }))
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string(),
    })
    const events: unknown[] = []
    queryCacheInternals.onDatabaseDependencyInvalidated((event) => {
      events.push(event)
    })
    adapter.queryRows = [{ id: 2, name: 'Ava', status: 'active' }]

    await DB.table(users).where('status', 'active').update({ name: 'Ava' })

    expect(adapter.executionCount).toBe(0)
    expect(adapter.queries).toEqual([{
      sql: 'UPDATE "users" SET "name" = ?1 WHERE "status" = ?2 RETURNING *',
      bindings: ['Ava', 'active'],
    }])
    expect(events[0]).toEqual(expect.objectContaining({
      mutations: [{
        connectionName: 'main',
        tableName: 'users',
        kind: 'update',
        predicates: [{ column: 'status', operator: '=', value: 'active' }],
        previousRows: undefined,
        values: { name: 'Ava' },
        rows: [{ id: 2, name: 'Ava', status: 'active' }],
      }],
    }))

    adapter.queryRows = [{ id: 2, name: 'Ava', status: 'active' }]
    adapter.queries.length = 0
    await DB.table(users).where('id', 2).delete()

    expect(adapter.executionCount).toBe(0)
    expect(adapter.queries).toEqual([{
      sql: 'DELETE FROM "users" WHERE "id" = ?1 RETURNING *',
      bindings: [2],
    }])
    expect(events[1]).toEqual(expect.objectContaining({
      mutations: [{
        connectionName: 'main',
        tableName: 'users',
        kind: 'delete',
        predicates: [{ column: 'id', operator: '=', value: 2 }],
        previousRows: undefined,
        values: undefined,
        rows: [{ id: 2, name: 'Ava', status: 'active' }],
      }],
    }))

    adapter.queryRows = [{ id: 3, name: 'Mina', status: 'active', created_at: '2026-06-24T10:00:00.000Z' }]
    adapter.queries.length = 0
    const insertResult = await DB.table(users).insert({ name: 'Mina', status: 'active' })

    expect(insertResult).toEqual({
      affectedRows: 1,
      lastInsertId: 3,
    })
    expect(insertResult).not.toHaveProperty('rows')
    expect(adapter.executionCount).toBe(0)
    expect(adapter.queries).toEqual([{
      sql: 'INSERT INTO "users" ("name", "status") VALUES (?1, ?2) RETURNING *',
      bindings: ['Mina', 'active'],
    }])
    expect(events[2]).toEqual(expect.objectContaining({
      mutations: [{
        connectionName: 'main',
        tableName: 'users',
        kind: 'insert',
        predicates: [],
        previousRows: undefined,
        values: undefined,
        rows: [{ id: 3, name: 'Mina', status: 'active', created_at: '2026-06-24T10:00:00.000Z' }],
      }],
    }))

    adapter.queryRows = []
    adapter.queries.length = 0
    const ignoredInsert = await DB.table(users).insertOrIgnore({ id: 3, name: 'Mina', status: 'active' })
    expect(ignoredInsert.affectedRows).toBe(0)

    expect(adapter.queries).toEqual([{
      sql: 'INSERT OR IGNORE INTO "users" ("id", "name", "status") VALUES (?1, ?2, ?3) RETURNING *',
      bindings: [3, 'Mina', 'active'],
    }])
    expect(events).toHaveLength(3)

    adapter.queries.length = 0
    const ignoredUpsert = await DB.table(users).upsert(
      { id: 5, name: 'Ignored', status: 'active' },
      ['id'],
      ['name'],
    )
    expect(ignoredUpsert.affectedRows).toBe(0)
    expect(events).toHaveLength(3)

    adapter.queryRows = [{ id: 4, name: 'Noor', status: 'active', created_at: '2026-06-24T11:00:00.000Z' }]
    adapter.queries.length = 0
    const upsertResult = await DB.table(users).upsert({ id: 4, name: 'Noor', status: 'active' }, ['id'], ['name'])

    expect(upsertResult).toEqual({
      affectedRows: 1,
      lastInsertId: 4,
    })
    expect(upsertResult).not.toHaveProperty('rows')
    expect(adapter.queries).toEqual([
      {
        sql: 'SELECT * FROM "users" WHERE "id" IN (?1)',
        bindings: [4],
      },
      {
        sql: 'INSERT INTO "users" ("id", "name", "status") VALUES (?1, ?2, ?3) ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name" RETURNING *',
        bindings: [4, 'Noor', 'active'],
      },
    ])
    expect(events[3]).toEqual(expect.objectContaining({
      mutations: [{
        connectionName: 'main',
        tableName: 'users',
        kind: 'upsert',
        predicates: [],
        previousRows: [{ id: 4, name: 'Noor', status: 'active', created_at: '2026-06-24T11:00:00.000Z' }],
        values: undefined,
        rows: [{ id: 4, name: 'Noor', status: 'active', created_at: '2026-06-24T11:00:00.000Z' }],
      }],
    }))

    adapter.queryRows = [{ id: true, name: 'Invalid Identifier', status: 'active' }]
    const invalidIdentifierInsert = await DB.table(users).insert({
      name: 'Invalid Identifier',
      status: 'active',
    })
    expect(invalidIdentifierInsert.lastInsertId).toBeUndefined()
  })

  it('keeps returning-capable normal writes off the realtime mutation row path without listeners', async () => {
    configureDB(createConnectionManager({
      defaultConnection: 'main',
      connections: {
        main: {
          adapter,
          dialect: createReturningDialect(),
          driver: 'sqlite',
        },
      },
    }))
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string(),
    })

    await DB.table(users).where('status', 'active').update({ name: 'Ava' })
    await DB.table(users).where('id', 1).delete()
    await DB.table(users).insert({ name: 'Mina', status: 'active' })
    await DB.table(users).insertOrIgnore({ id: 2, name: 'Mina', status: 'active' })
    await DB.table(users).upsert({ id: 3, name: 'Noor', status: 'active' }, ['id'], ['name'])

    expect(adapter.queryCount).toBe(0)
    expect(adapter.executionCount).toBe(5)
    expect(adapter.executions).toEqual([
      {
        sql: 'UPDATE "users" SET "name" = ?1 WHERE "status" = ?2',
        bindings: ['Ava', 'active'],
      },
      {
        sql: 'DELETE FROM "users" WHERE "id" = ?1',
        bindings: [1],
      },
      {
        sql: 'INSERT INTO "users" ("name", "status") VALUES (?1, ?2)',
        bindings: ['Mina', 'active'],
      },
      {
        sql: 'INSERT OR IGNORE INTO "users" ("id", "name", "status") VALUES (?1, ?2, ?3)',
        bindings: [2, 'Mina', 'active'],
      },
      {
        sql: 'INSERT INTO "users" ("id", "name", "status") VALUES (?1, ?2, ?3) ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"',
        bindings: [3, 'Noor', 'active'],
      },
    ])
    expect(adapter.executions.map(execution => execution.sql)).toEqual([
      expect.not.stringContaining('RETURNING'),
      expect.not.stringContaining('RETURNING'),
      expect.not.stringContaining('RETURNING'),
      expect.not.stringContaining('RETURNING'),
      expect.not.stringContaining('RETURNING'),
    ])
  })

  it('keeps non-returning normal writes off realtime row capture without cache bridge or listeners', async () => {
    resetDatabaseQueryCacheBridge()
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string(),
    })

    await DB.table(users).where('status', 'active').update({ name: 'Ava' })
    await DB.table(users).where('id', 1).delete()
    await DB.table(users).insert({ name: 'Mina', status: 'active' })
    await DB.table(users).insertOrIgnore({ id: 2, name: 'Mina', status: 'active' })
    await DB.table(users).upsert({ id: 3, name: 'Noor', status: 'active' }, ['id'], ['name'])

    expect(adapter.queryCount).toBe(0)
    expect(adapter.executionCount).toBe(5)
    expect(adapter.executions).toEqual([
      {
        sql: 'UPDATE "users" SET "name" = ?1 WHERE "status" = ?2',
        bindings: ['Ava', 'active'],
      },
      {
        sql: 'DELETE FROM "users" WHERE "id" = ?1',
        bindings: [1],
      },
      {
        sql: 'INSERT INTO "users" ("name", "status") VALUES (?1, ?2)',
        bindings: ['Mina', 'active'],
      },
      {
        sql: 'INSERT OR IGNORE INTO "users" ("id", "name", "status") VALUES (?1, ?2, ?3)',
        bindings: [2, 'Mina', 'active'],
      },
      {
        sql: 'INSERT INTO "users" ("id", "name", "status") VALUES (?1, ?2, ?3) ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name"',
        bindings: [3, 'Noor', 'active'],
      },
    ])
  })

  it('keeps model query writes off realtime row capture without cache bridge or listeners', async () => {
    resetDatabaseQueryCacheBridge()
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string(),
    })
    const User = defineModelFromTable(users)

    await User.query().where('status', 'active').update({ name: 'Ava' })
    await User.query().where('id', 1).delete()
    await User.query().upsert({ name: 'Noor', status: 'active' }, ['status'], ['name'])

    expect(adapter.queryCount).toBe(0)
    expect(adapter.executionCount).toBe(3)
    expect(adapter.executions).toEqual([
      {
        sql: 'UPDATE "users" SET "name" = ?1 WHERE "status" = ?2',
        bindings: ['Ava', 'active'],
      },
      {
        sql: 'DELETE FROM "users" WHERE "id" = ?1',
        bindings: [1],
      },
      {
        sql: 'INSERT INTO "users" ("name", "status") VALUES (?1, ?2) ON CONFLICT ("status") DO UPDATE SET "name" = EXCLUDED."name"',
        bindings: ['Noor', 'active'],
      },
    ])
  })

  it('invalidates query cache without firing dependency events when no listener is active', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })
    const events: unknown[] = []
    const unsubscribe = queryCacheInternals.onDatabaseDependencyInvalidated((event) => {
      events.push(event)
    })
    unsubscribe()
    adapter.queryRows = [{ id: 1, name: 'Old' }]

    await DB.table(users).where('id', 1).update({ name: 'Ava' })

    expect(events).toEqual([])
    expect(adapter.queryCount).toBe(0)
    expect(queryCacheInternals.hasDatabaseDependencyInvalidationListeners()).toBe(false)
    expect(bridge.invalidatedDependencies).toEqual([expect.arrayContaining([
      'db:main:users',
      'db:main:users:mutation',
      'db:main:users:row:id:1',
      'db:main:users:where:id:1',
      'db:main:users:where-exact:id:1',
      'db:main:users:where:name:%22Ava%22',
      'db:main:users:where-exact:name:%22Ava%22',
    ])])
  })

  it('keeps every write operation off realtime row capture when listeners are inactive', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string(),
    })
    const events: unknown[] = []
    const unsubscribe = queryCacheInternals.onDatabaseDependencyInvalidated((event) => {
      events.push(event)
    })
    unsubscribe()

    await DB.table(users).insert({ name: 'Ava', status: 'active' })
    await DB.table(users).upsert({ id: 2, name: 'Mina', status: 'active' }, ['id'], ['name'])
    await DB.table(users).where('id', 2).update({ status: 'inactive' })
    await DB.table(users).where('id', 3).delete()

    expect(events).toEqual([])
    expect(adapter.queryCount).toBe(0)
    expect(adapter.executionCount).toBe(4)
    expect(queryCacheInternals.hasDatabaseDependencyInvalidationListeners()).toBe(false)
    expect(bridge.invalidatedDependencies).toHaveLength(4)
    expect(bridge.invalidatedDependencies).toEqual([
      expect.arrayContaining([
        'db:main:users',
        'db:main:users:where:name:%22Ava%22',
        'db:main:users:where-exact:status:%22active%22',
      ]),
      expect.arrayContaining([
        'db:main:users',
        'db:main:users:row:id:2',
        'db:main:users:where-exact:id:2',
      ]),
      expect.arrayContaining([
        'db:main:users',
        'db:main:users:mutation',
        'db:main:users:row:id:2',
        'db:main:users:where-exact:status:%22inactive%22',
      ]),
      expect.arrayContaining([
        'db:main:users',
        'db:main:users:mutation',
        'db:main:users:row:id:3',
        'db:main:users:where-exact:id:3',
      ]),
    ])
  })

  it('includes generated ids in single-row insert mutation events', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })
    const events: unknown[] = []
    queryCacheInternals.onDatabaseDependencyInvalidated((event) => {
      events.push(event)
    })

    await DB.table(users).insert({ name: 'Ava' })

    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(expect.objectContaining({
      mutations: [{
        connectionName: 'main',
        tableName: 'users',
        kind: 'insert',
        predicates: [],
        previousRows: undefined,
        values: undefined,
        rows: [{ id: 1, name: 'Ava' }],
      }],
    }))
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

  it('deduplicates concurrent ttl cache misses through the cache bridge compute path', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })

    adapter.queryRows = [{ id: 1, name: 'Ava' }]
    const originalQuery = adapter.query.bind(adapter)
    adapter.query = async <TRow extends Record<string, unknown> = Record<string, unknown>>(): Promise<DriverQueryResult<TRow>> => {
      await new Promise((resolveDelay) => {
        setTimeout(resolveDelay, 0)
      })
      return originalQuery<TRow>()
    }

    const [first, second] = await Promise.all([
      DB.table(users).cache(300).get(),
      DB.table(users).cache(300).get(),
    ])

    expect(first).toEqual(second)
    expect(adapter.queryCount).toBe(1)
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

    expect(bridge.invalidatedDependencies.some(dependencies => dependencies.includes('db:main:users'))).toBe(true)
    expect(bridge.invalidatedDependencies.some(dependencies => dependencies.includes('db:main:users:row:id:1'))).toBe(true)
    expect(refreshed[0]?.name).toBe('Stale')
    expect(unsupported[0]?.name).toBe('Joined')
  })

  it('uses table dependencies for primary key predicates that are part of an or query', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      active: column.boolean(),
    })

    adapter.queryRows = [{ id: 1, name: 'Ava', active: false }]
    await DB.table(users)
      .where('id', 1)
      .orWhere('active', true)
      .cache(300)
      .get()

    adapter.queryRows = [{ id: 2, name: 'Mina', active: true }]
    await DB.table(users).where('id', 2).update({ name: 'Updated' })
    const refreshed = await DB.table(users)
      .where('id', 1)
      .orWhere('active', true)
      .cache(300)
      .get()

    expect(refreshed).toEqual([{ id: 2, name: 'Mina', active: true }])
  })

  it('falls back to broad dependencies for disjunctive primary key query plans', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      active: column.boolean(),
    })
    const directOrPlan = (
      new TableQueryBuilder(users, DB.connection())
        .where('id', 1)
        .orWhere('active', true) as unknown as { readonly plan: SelectQueryPlan }
    ).plan
    const nestedOrPlan = (
      new TableQueryBuilder(users, DB.connection())
        .where(query => query.where('id', 1).orWhere('active', true)) as unknown as { readonly plan: SelectQueryPlan }
    ).plan
    const negatedGroupPlan = (
      new TableQueryBuilder(users, DB.connection())
        .whereNot(query => query.where('id', 1)) as unknown as { readonly plan: SelectQueryPlan }
    ).plan

    expect(queryCacheInternals.inferAutomaticQueryCacheDependencies(directOrPlan, 'main')).toEqual([
      'db:main:users',
    ])
    expect(queryCacheInternals.inferAutomaticQueryCacheDependencies(nestedOrPlan, 'main')).toEqual([
      'db:main:users',
    ])
    expect(queryCacheInternals.inferAutomaticQueryCacheInvalidationDependencies(directOrPlan, 'main')).toEqual([
      'db:main:users',
      'db:main:users:row:*',
    ])
    expect(queryCacheInternals.inferAutomaticQueryCacheInvalidationDependencies(negatedGroupPlan, 'main')).toEqual([
      'db:main:users',
      'db:main:users:row:*',
    ])
  })

  it('keeps row dependencies for nested conjunctive primary key query plans', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      active: column.boolean(),
    })
    const nestedPrimaryKeyPlan = (
      new TableQueryBuilder(users, DB.connection())
        .where(query => query.where('id', 1).where('active', true)) as unknown as { readonly plan: SelectQueryPlan }
    ).plan
    const nestedNonPrimaryKeyPlan = (
      new TableQueryBuilder(users, DB.connection())
        .where(query => query.where('active', true)) as unknown as { readonly plan: SelectQueryPlan }
    ).plan

    expect(queryCacheInternals.inferAutomaticQueryCacheDependencies(nestedPrimaryKeyPlan, 'main')).toEqual([
      'db:main:users:row:id:1',
      'db:main:users:row:*',
    ])
    expect(queryCacheInternals.inferAutomaticQueryCacheDependencies(nestedNonPrimaryKeyPlan, 'main')).toEqual([
      'db:main:users',
      'db:main:users:where:active:1',
    ])
  })

  it('keeps predicate value dependencies for conjunctive where-in query plans', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      status: column.string(),
    })
    const whereInPlan = (
      new TableQueryBuilder(users, DB.connection())
        .whereIn('status', ['active', 'pending']) as unknown as { readonly plan: SelectQueryPlan }
    ).plan

    expect(queryCacheInternals.inferAutomaticQueryCacheDependencies(whereInPlan, 'main')).toEqual([
      'db:main:users',
      'db:main:users:where:status:%22active%22',
      'db:main:users:where:status:%22pending%22',
    ])
    expect(queryCacheInternals.inferAutomaticQueryCacheInvalidationDependencies(whereInPlan, 'main')).toEqual([
      'db:main:users',
      'db:main:users:mutation',
      'db:main:users:row:*',
      'db:main:users:where:status:%22active%22',
      'db:main:users:where:status:%22pending%22',
      'db:main:users:where-exact:status:%22active%22',
      'db:main:users:where-exact:status:%22pending%22',
    ])
  })

  it('includes exact record predicate dependencies for query invalidation values', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      active: column.boolean(),
    })
    const predicatePlan = (
      new TableQueryBuilder(users, DB.connection())
        .where('active', true) as unknown as { readonly plan: SelectQueryPlan }
    ).plan

    expect(queryCacheInternals.inferAutomaticQueryCacheInvalidationDependencies(predicatePlan, 'main', {
      active: false,
    })).toContain('db:main:users:where-exact:active:false')
  })

  it('builds structured invalidation metadata from automatic dependency sources only when requested', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      active: column.boolean(),
    })
    const predicatePlan = (
      new TableQueryBuilder(users, DB.connection())
        .where('active', true) as unknown as { readonly plan: SelectQueryPlan }
    ).plan
    const dependencyOnlyPlan = queryCacheInternals.inferAutomaticQueryCacheInvalidationPlan(predicatePlan, 'main', {
      name: 'Ava',
    })
    const metadataPlan = queryCacheInternals.inferAutomaticQueryCacheInvalidationPlan(predicatePlan, 'main', {
      name: 'Ava',
    }, true)
    const insertMetadataPlan = queryCacheInternals.inferAutomaticInsertCacheInvalidationPlan('main', 'users', [{
      id: 1,
      active: true,
    }], undefined, true)

    expect(dependencyOnlyPlan.dependencies).toEqual(
      queryCacheInternals.inferAutomaticQueryCacheInvalidationDependencies(predicatePlan, 'main', {
        name: 'Ava',
      }),
    )
    expect(dependencyOnlyPlan.metadata).toBeUndefined()
    expect(metadataPlan.dependencies).toEqual(dependencyOnlyPlan.dependencies)
    expect(metadataPlan.metadata).toEqual({
      directDependencies: expect.arrayContaining([
        'db:main:users:mutation',
        'db:main:users:row:*',
        'db:main:users:where:active:1',
        'db:main:users:where-exact:active:1',
        'db:main:users:where:name:%22Ava%22',
        'db:main:users:where-exact:name:%22Ava%22',
      ]),
      exactPredicates: expect.arrayContaining([
        {
          tableKey: 'db:main:users',
          columnName: 'active',
          encodedValue: '1',
        },
        {
          tableKey: 'db:main:users',
          columnName: 'name',
          encodedValue: '%22Ava%22',
        },
      ]),
      hasMutationDependency: true,
      predicates: expect.arrayContaining([
        {
          tableKey: 'db:main:users',
          columnName: 'active',
          encodedValue: '1',
        },
        {
          tableKey: 'db:main:users',
          columnName: 'name',
          encodedValue: '%22Ava%22',
        },
      ]),
      tableDependencies: ['db:main:users'],
    })
    expect(insertMetadataPlan.dependencies).toEqual(
      queryCacheInternals.inferAutomaticInsertCacheInvalidationDependencies('main', 'users', [{
        id: 1,
        active: true,
      }]),
    )
    expect(insertMetadataPlan.dependencies).toEqual(expect.arrayContaining([
      'db:main:users',
      'db:main:users:row:id:1',
      'db:main:users:where:id:1',
      'db:main:users:where:active:true',
      'db:main:users:where-exact:id:1',
      'db:main:users:where-exact:active:true',
    ]))
    expect(insertMetadataPlan.metadata).toEqual(expect.objectContaining({
      hasMutationDependency: false,
      tableDependencies: ['db:main:users'],
    }))
  })

  it('keeps empty insert invalidation broad enough for list subscribers', () => {
    const plan = queryCacheInternals.inferAutomaticInsertCacheInvalidationPlan('main', 'users', [], undefined, true)

    expect(plan).toEqual({
      dependencies: [
        'db:main:users',
        'db:main:users:row:*',
      ],
      metadata: {
        directDependencies: [
          'db:main:users:row:*',
          'db:main:users',
        ],
        exactPredicates: [],
        hasMutationDependency: false,
        predicates: [],
        tableDependencies: [],
      },
    })
  })

  it('creates mutation events without optional row payloads', () => {
    expect(queryCacheInternals.createDatabaseMutationEvent(
      'delete',
      'main',
      'users',
      [{
        kind: 'comparison',
        boolean: 'and',
        column: 'status',
        operator: '=',
        value: 'archived',
      }],
    )).toEqual({
      connectionName: 'main',
      tableName: 'users',
      kind: 'delete',
      predicates: [{ column: 'status', operator: '=', value: 'archived' }],
      previousRows: undefined,
      rows: undefined,
      values: undefined,
    })
  })

  it('skips query caching for locked queries and uses a fresh read during numeric adjustments', async () => {
    const users = defineTable('users', {
      id: column.id(),
      points: column.integer(),
      name: column.string(),
    })

    adapter.queryRows = [{ id: 1, points: 10, name: 'Ava' }]
    await DB.table(users).cache(300).get()

    adapter.queryRows = [{ id: 1, points: 11, name: 'Ava' }]
    const lockedRows = await DB.table(users).cache(300).lockForUpdate().get()

    adapter.queryRows = [{ id: 1, points: 50, name: 'Ava' }]
    const result = await DB.table(users).cache(300).where('id', 1).increment('points', 2)

    expect(lockedRows[0]?.points).toBe(11)
    expect(adapter.queryCount).toBe(3)
    expect(bridge.flexibleCalls).toHaveLength(1)
    expect(result.affectedRows).toBe(1)
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

    expect(bridge.invalidatedDependencies.some((dependencies) => {
      return dependencies.includes('db:main:users')
        && dependencies.includes('db:main:users:row:id:1')
        && dependencies.includes('db:main:users:where:id:1')
    })).toBe(true)
  })

  it('defers model write invalidation until its implicit transaction commits', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })
    const User = defineModelFromTable(users, {
      fillable: ['name'],
    })

    await User.create({
      name: 'Ava',
    })

    expect(bridge.invalidatedDependencies).toHaveLength(1)
    expect(bridge.invalidatedDependencies[0]).toContain('db:main:users')
    expect(bridge.invalidationTransactionStates).toEqual([false])
  })

  it('keeps repositories on their original context when another context shares the same connection name', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })
    const User = defineModelFromTable(users, {})
    const first = new DatabaseContext({
      connectionName: 'main',
      adapter: new QueryCacheAdapter(),
      dialect: createDialect(),
      driver: 'sqlite',
    })
    const second = new DatabaseContext({
      connectionName: 'main',
      adapter: new QueryCacheAdapter(),
      dialect: createDialect(),
      driver: 'sqlite',
    })
    const secondRepository = new ModelRepository(User.definition, second)

    await first.transaction(async () => {
      expect(secondRepository.getConnection()).toBe(second)
    })
  })

  it('normalizes explicit invalidation dependencies and disables automatic invalidation for raw order clauses', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })
    const posts = defineTable('posts', {
      id: column.id(),
      user_id: column.integer(),
      title: column.string(),
    })

    const orderedQuery = new TableQueryBuilder(users, DB.connection()).unsafeOrderBy('RANDOM()', [])
    const orderedPlan = (orderedQuery as unknown as { readonly plan: SelectQueryPlan }).plan
    const predicateQuery = new TableQueryBuilder(posts, DB.connection()).where('user_id', 1)
    const predicatePlan = (predicateQuery as unknown as { readonly plan: SelectQueryPlan }).plan

    expect(queryCacheInternals.supportsAutomaticQueryCacheInvalidation(orderedPlan)).toBe(false)
    expect(queryCacheInternals.resolveQueryCacheDependencies(orderedPlan, 'main', ['users', 'db:main:posts'])).toEqual([
      'db:main:users',
      'db:main:posts',
    ])
    expect(queryCacheInternals.inferAutomaticQueryCacheDependencies(predicatePlan, 'main')).toEqual([
      'db:main:posts',
      'db:main:posts:where:user_id:1',
    ])
  })

  it('rejects unsupported predicate and selection shapes for automatic invalidation helpers', () => {
    const aggregateSelectionPlan = {
      kind: 'select',
      source: {
        kind: 'table',
        tableName: 'users',
      },
      distinct: false,
      selections: [{
        kind: 'aggregate',
        aggregate: 'count',
        column: '*',
        alias: 'count',
      }],
      joins: [],
      unions: [],
      predicates: [],
      groupBy: [],
      having: [],
      orderBy: [],
    } as const satisfies SelectQueryPlan
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

    expect(queryCacheInternals.createDatabaseQueryObservation(aggregateSelectionPlan, 'main', ['db:main:users'])).toEqual(
      expect.objectContaining({
        connectionName: 'main',
        tableName: 'users',
        dependencies: ['db:main:users'],
        patchable: true,
        selections: [],
      }),
    )
    expect(queryCacheInternals.supportsAutomaticQueryCacheInvalidation(rawSelectionPlan)).toBe(false)
    expect(queryCacheInternals.createDatabaseQueryObservation(rawSelectionPlan, 'main', [])).toBeUndefined()
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
      subquery: rawSelectionPlan,
    })).toBe(false)
    expect(queryCacheInternals.supportsAutomaticPredicateInvalidation({
      kind: 'subquery',
      boolean: 'and',
      column: 'id',
      operator: 'in',
      subquery: rawSelectionPlan,
    })).toBe(false)
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

    const postsPlan = {
      kind: 'select',
      source: {
        kind: 'table',
        tableName: 'posts',
      },
      distinct: false,
      selections: [],
      joins: [],
      unions: [],
      predicates: [],
      groupBy: [],
      having: [],
      orderBy: [],
    } as const satisfies SelectQueryPlan
    const nestedFallbackPredicatePlan = {
      ...postsPlan,
      source: {
        kind: 'table',
        tableName: 'users',
      },
      predicates: [{
        kind: 'group',
        boolean: 'and',
        predicates: [
          {
            kind: 'exists',
            boolean: 'and',
            subquery: postsPlan,
          },
          {
            kind: 'subquery',
            boolean: 'and',
            column: 'id',
            operator: 'in',
            subquery: postsPlan,
          },
          {
            kind: 'raw',
            boolean: 'and',
            sql: '1 = 1',
            bindings: [],
          },
          {
            kind: 'vector',
            boolean: 'and',
            column: 'embedding',
            vector: [0.1, 0.2],
            minSimilarity: 0.5,
          },
          {
            kind: 'fulltext',
            boolean: 'and',
            columns: ['title'],
            mode: 'natural',
            value: 'search',
          },
        ],
      }],
    } as const satisfies SelectQueryPlan

    expect(inferDatabaseQueryObservationDependencies(nestedFallbackPredicatePlan, 'main')).toEqual([
      'db:main:users',
      'db:main:posts',
    ])

    const compositeFallbackPlan = {
      ...postsPlan,
      source: { kind: 'table', tableName: 'users' },
      joins: [
        { kind: 'inner', table: 'roles', predicates: [] },
        { kind: 'inner', subquery: postsPlan, predicates: [] },
      ],
      unions: [{ all: true, query: postsPlan }],
      selections: [{ alias: 'post_count', kind: 'subquery', query: postsPlan }],
    } as unknown as SelectQueryPlan
    expect(inferDatabaseQueryObservationDependencies(compositeFallbackPlan, 'main')).toEqual([
      'db:main:users',
      'db:main:roles',
      'db:main:posts',
    ])

    expect(queryCacheInternals.createDatabaseQueryObservation(rawSelectionPlan, 'main', ['db:main:users']))
      .toBeUndefined()
    const rawOrderPlan = {
      ...postsPlan,
      orderBy: [{ bindings: [], kind: 'raw', sql: 'RANDOM()' }],
    } as never
    expect(createDatabaseQueryFallbackObservation(rawOrderPlan, 'main', ['db:main:users']))
      .toEqual(expect.objectContaining({ patchable: false }))

    const groupedWrongSelection = {
      ...postsPlan,
      selections: [{ kind: 'column', column: 'name' }, { kind: 'column', column: 'status' }],
      groupBy: ['name'],
    } as never
    expect(createDatabaseQueryFallbackObservation(groupedWrongSelection, 'main', ['db:main:posts']))
      .toEqual(expect.objectContaining({ patchable: false }))

    const groupedWrongOrder = {
      ...postsPlan,
      selections: [
        { kind: 'column', column: 'name' },
        { alias: 'total', aggregate: 'count', column: '*', kind: 'aggregate' },
      ],
      groupBy: ['name'],
      orderBy: [{ column: 'id', direction: 'asc', kind: 'column' }],
    } as unknown as SelectQueryPlan
    expect(createDatabaseQueryFallbackObservation(groupedWrongOrder, 'main', ['db:main:posts']))
      .toEqual(expect.objectContaining({ patchable: false }))

    const multipleHavingPlan = {
      ...groupedWrongOrder,
      orderBy: [],
      having: [
        { expression: 'COUNT(*)', operator: '>=', value: 1 },
        { expression: 'COUNT(*)', operator: '<=', value: 5 },
      ],
    } as never
    expect(inferDatabaseQueryObservationDependencies(multipleHavingPlan, 'main')).toEqual(['db:main:posts'])
    expect(createDatabaseQueryFallbackObservation(multipleHavingPlan, 'main', ['db:main:posts']))
      .toEqual(expect.objectContaining({ groupedAggregate: undefined, patchable: false }))

    const invalidHavingPlan = {
      ...groupedWrongOrder,
      orderBy: [],
      having: [{ expression: 'COUNT(*)', operator: '<>', value: 1 }],
    } as never
    expect(createDatabaseQueryFallbackObservation(invalidHavingPlan, 'main', ['db:main:posts']))
      .toEqual(expect.objectContaining({ groupedAggregate: undefined, patchable: false }))

    const groupedPredicatePlan = {
      ...postsPlan,
      selections: [
        { kind: 'column', column: 'name' },
        { alias: 'total', aggregate: 'count', column: '*', kind: 'aggregate' },
      ],
      groupBy: ['name'],
      predicates: [{ boolean: 'and', column: 'status', kind: 'comparison', operator: '=', value: 'active' }],
    } as never
    expect(queryCacheInternals.createDatabaseQueryObservation(groupedPredicatePlan, 'main', ['db:main:posts']))
      .toEqual(expect.objectContaining({ patchable: true }))

    const nestedExactPlan = new TableQueryBuilder('posts', DB.connection())
      .where(query => query.where('user_id', 1).where('title', 'Post'))
      .getPlan()
    expect(queryCacheInternals.inferAutomaticQueryCacheDependencies(nestedExactPlan, 'main')).toEqual(expect.arrayContaining([
      'db:main:posts:where:user_id:1',
      'db:main:posts:where:title:%22Post%22',
    ]))
    expect(queryCacheInternals.inferAutomaticQueryCacheInvalidationPlan(
      nestedExactPlan,
      'main',
      { id: 1 },
      true,
    ).metadata?.predicates).toHaveLength(3)

    const nestedRangePlan = new TableQueryBuilder('posts', DB.connection())
      .where(query => query.where('id', '>', 0))
      .getPlan()
    expect(queryCacheInternals.inferAutomaticQueryCacheInvalidationPlan(
      nestedRangePlan,
      'main',
      { id: 1 },
      true,
    ).metadata?.predicates).toEqual([{
      columnName: 'id',
      encodedValue: '1',
      tableKey: 'db:main:posts',
    }])

    const fallbackPredicates = [
      { boolean: 'and', kind: 'subquery', subquery: postsPlan },
      { bindings: [], boolean: 'and', kind: 'raw', sql: '1 = 1' },
      { boolean: 'and', column: 'embedding', kind: 'vector', minSimilarity: 0.5, vector: [0.1] },
      { boolean: 'and', columns: ['title'], kind: 'fulltext', mode: 'natural', value: 'search' },
    ] as const
    for (const predicate of fallbackPredicates) {
      const fallbackPredicatePlan = { ...postsPlan, predicates: [predicate] } as never
      expect(inferDatabaseQueryObservationDependencies(fallbackPredicatePlan, 'main')).toContain('db:main:posts')
      expect(createDatabaseQueryFallbackObservation(fallbackPredicatePlan, 'main', ['db:main:posts']))
        .toEqual(expect.objectContaining({ patchable: false }))
    }

    const undefinedPredicatePlan = {
      ...postsPlan,
      predicates: [{ boolean: 'and', column: 'id', kind: 'comparison', operator: '=', value: undefined }],
    } as never
    expect(queryCacheInternals.inferAutomaticQueryCacheInvalidationPlan(
      undefinedPredicatePlan,
      'main',
      { id: undefined },
      true,
    ).metadata).toEqual(expect.objectContaining({ exactPredicates: [], predicates: [] }))
    expect(queryCacheInternals.inferAutomaticQueryCacheDependencies(undefinedPredicatePlan, 'main')).toEqual([
      'db:main:posts',
    ])
    expect(queryCacheInternals.inferAutomaticQueryCacheDependencies(
      new TableQueryBuilder('posts', DB.connection()).where('id', '>', 0).getPlan(),
      'main',
    )).toEqual(['db:main:posts'])
    expect(queryCacheInternals.inferAutomaticInsertCacheInvalidationDependencies(
      'main',
      'posts',
      [{ id: undefined }],
    )).toContain('db:main:posts')

    const logs = defineTable('logs', { message: column.string() })
    expect(queryCacheInternals.inferAutomaticQueryCacheDependencies(
      new TableQueryBuilder(logs, DB.connection()).where('message', 'entry').getPlan(),
      'main',
    )).toContain('db:main:logs')

    const rawMutationPlan = {
      ...postsPlan,
      predicates: [{ bindings: [], boolean: 'and', kind: 'raw', sql: '1 = 1' }],
    } as never
    expect(queryCacheInternals.inferAutomaticQueryCacheInvalidationPlan(
      rawMutationPlan,
      'main',
      {},
      true,
    ).metadata).toBeDefined()

    const disjunctivePlan = new TableQueryBuilder('posts', DB.connection())
      .where(query => query.where('id', 1).orWhere('id', 2))
      .getPlan()
    expect(queryCacheInternals.inferAutomaticQueryCacheInvalidationPlan(
      disjunctivePlan,
      'main',
      {},
      true,
    ).metadata).toBeDefined()
  })

  it('marks direct upsert invalidations as mutation dependencies', async () => {
    const events: unknown[] = []
    queryCacheInternals.onDatabaseDependencyInvalidated((event) => {
      events.push(event)
    })
    const mutation = queryCacheInternals.createDatabaseMutationEvent('upsert', 'main', 'users')
    await invalidateQueryCacheDependencies(DB.connection(), ['db:main:users'], [mutation])
    const event = events[0] as Record<string, unknown> | undefined
    expect(event?.[DATABASE_DEPENDENCY_METADATA_KEY]).toEqual(expect.objectContaining({
      hasMutationDependency: true,
    }))
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

  it('rejects malformed query-cache state without ttl or flexible metadata at execution time', async () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })

    await expect(
      new TableQueryBuilder(
        users,
        DB.connection(),
        undefined,
        {
          key: 'users.malformed',
        } as never,
      ).get(),
    ).rejects.toThrow('Query cache config requires "ttl" or "flexible"')
  })
})
