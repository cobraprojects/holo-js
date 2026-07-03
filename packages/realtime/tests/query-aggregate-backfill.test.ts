import { afterEach, describe, expect, it } from 'vitest'
import { configureRealtimeRuntime, resetRealtimeRuntime } from '../src/runtime/lifecycle'
import { backfillAggregate } from '../src/runtime/query-aggregate-backfill'
import type { AggregateBackfillEntry } from '../src/runtime/query-aggregate-common'
import {
  createAggregateBackfillKey,
  createAggregateScopeKey,
  createAggregateSqlBackfillKey,
} from '../src/runtime/query-metadata'
import {
  createMutationIndexKey,
  type DatabaseMutationEvent,
  type PredicateDependencyIndex,
} from '../src/runtime/dependencies'
import type {
  AggregateBackfillResult,
  AggregateSqlBackfillResult,
  BackfillCache,
  DatabaseQueryObservation,
} from '../src/runtime/query-state'
import { stableStringify } from '../src/runtime/stable-stringify'
import { createFakeDatabase } from './helpers/fake-database'

function createQuery(overrides: Partial<DatabaseQueryObservation> = {}): DatabaseQueryObservation {
  return {
    aggregate: {
      kind: 'count',
    },
    connectionName: 'main',
    dependencies: ['db:main:posts'],
    orderBy: [],
    patchable: true,
    predicates: [{ column: 'status', operator: '=', value: 'open' }],
    tableName: 'posts',
    ...overrides,
  }
}

function createBackfills(
  entries: readonly AggregateBackfillEntry[] = [],
  overrides: Partial<BackfillCache<AggregateBackfillEntry>> = {},
): BackfillCache<AggregateBackfillEntry> {
  return {
    aggregateSql: new Map(),
    aggregates: new Map(),
    entries,
    mutationMetadata: new WeakMap(),
    mutations: new Map(),
    paginationCounts: new Map(),
    rows: new Map(),
    ...overrides,
  }
}

function createExactPredicateIndex(column: string, value: unknown): PredicateDependencyIndex {
  return new Map([
    [
      'db:main:posts',
      new Map([
        [column, new Set([encodeURIComponent(JSON.stringify(value))])],
      ]),
    ],
  ])
}

function createGroupedAggregateSqlBackfillKey(
  query: DatabaseQueryObservation,
  groupColumn: string,
  values: readonly unknown[],
  columns: readonly string[],
): string {
  return '{"columns":'
    + stableStringify(columns)
    + ',"connectionName":'
    + stableStringify(query.connectionName)
    + ',"groupColumn":'
    + stableStringify(groupColumn)
    + ',"tableName":'
    + stableStringify(query.tableName)
    + ',"values":'
    + stableStringify(values)
    + '}'
}

describe('@holo-js/realtime aggregate backfill', () => {
  afterEach(() => {
    resetRealtimeRuntime()
  })

  it('rejects queries without aggregate metadata', async () => {
    await expect(backfillAggregate(createQuery({
      aggregate: undefined,
    }), createBackfills(), 0)).resolves.toEqual({ patched: false })
  })

  it('backfills count aggregates through the bound database connection', async () => {
    const database = createFakeDatabase(() => [
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const query = createQuery()

    await expect(backfillAggregate(query, createBackfills(), 0)).resolves.toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          count: undefined,
          kind: 'count',
          output: undefined,
        },
      },
      patched: true,
      query,
      value: 3,
    })
    expect(database.queries).toHaveLength(1)
    expect(database.queries[0]?.sql).toContain('FROM "posts"')
    expect(database.queries[0]?.sql).toContain('"status" = ?')
    expect(database.queries[0]?.bindings).toEqual(['open'])
  })

  it('backfills sum aggregates through scoped SQL aggregate rows', async () => {
    const database = createFakeDatabase(() => [
      {
        __holo_count: '2',
        __holo_sum_0: '7',
        __holo_avg_0: '3.5',
        __holo_min_0: '3',
        __holo_max_0: '4',
      },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const query = createQuery({
      aggregate: {
        column: 'score',
        kind: 'sum',
      },
    })

    await expect(backfillAggregate(query, createBackfills(), 0)).resolves.toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          column: 'score',
          kind: 'sum',
        },
      },
      patched: true,
      query,
      value: 7,
    })
    expect(database.queries).toHaveLength(1)
    expect(database.queries[0]?.sql).toContain('SUM("score") AS "__holo_sum_0"')
    expect(database.queries[0]?.sql).toContain('AVG("score") AS "__holo_avg_0"')
  })

  it('keeps avg aggregate backfills silent when the current value is already fresh', async () => {
    const database = createFakeDatabase(() => [
      {
        __holo_count: 2,
        __holo_sum_0: 7,
        __holo_avg_0: 3.5,
        __holo_min_0: 3,
        __holo_max_0: 4,
      },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const query = createQuery({
      aggregate: {
        column: 'score',
        kind: 'avg',
      },
    })

    await expect(backfillAggregate(query, createBackfills(), 3.5)).resolves.toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          column: 'score',
          count: 2,
          kind: 'avg',
          sum: 7,
        },
      },
      patched: true,
      unchanged: true,
    })
  })

  it('backfills aggregate SQL rows with all scoped aggregate columns once', async () => {
    const database = createFakeDatabase(() => [
      {
        __holo_count: 2,
        __holo_sum_0: 7,
        __holo_avg_0: 3.5,
        __holo_min_0: 3,
        __holo_max_0: 4,
        __holo_sum_1: 15,
        __holo_avg_1: 7.5,
        __holo_min_1: 7,
        __holo_max_1: 8,
        __holo_sum_2: 21,
        __holo_avg_2: 10.5,
        __holo_min_2: 10,
        __holo_max_2: 11,
      },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const scoreQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'sum',
      },
    })
    const ratingQuery = createQuery({
      aggregate: {
        column: 'rating',
        kind: 'avg',
      },
    })
    const priorityQuery = createQuery({
      aggregate: {
        column: 'priority',
        kind: 'sum',
      },
    })

    await expect(backfillAggregate(
      priorityQuery,
      createBackfills([{ queries: [scoreQuery, ratingQuery] }]),
      0,
    )).resolves.toEqual({
      nextQuery: {
        ...priorityQuery,
        aggregate: {
          column: 'priority',
          kind: 'sum',
        },
      },
      patched: true,
      query: priorityQuery,
      value: 21,
    })
    expect(database.queries).toHaveLength(1)
    expect(database.queries[0]?.sql).toContain('SUM("score") AS "__holo_sum_0"')
    expect(database.queries[0]?.sql).toContain('SUM("rating") AS "__holo_sum_1"')
    expect(database.queries[0]?.sql).toContain('SUM("priority") AS "__holo_sum_2"')
  })

  it('backfills grouped max aggregate rows and attaches extreme value counts', async () => {
    const database = createFakeDatabase(statement => {
      if (statement.sql.includes('GROUP BY "status", "score"')) {
        return [
          { __holo_count: 2, score: 4, status: 'open' },
          { __holo_count: 1, score: 9, status: 'closed' },
        ]
      }

      return [
        {
          __holo_count: 2,
          __holo_sum_0: 7,
          __holo_avg_0: 3.5,
          __holo_min_0: 3,
          __holo_max_0: 4,
          __holo_sum_1: 12,
          __holo_avg_1: 6,
          __holo_min_1: 5,
          __holo_max_1: 7,
          status: 'open',
        },
        {
          __holo_count: 1,
          __holo_sum_0: 9,
          __holo_avg_0: 9,
          __holo_min_0: 9,
          __holo_max_0: 9,
          __holo_sum_1: 3,
          __holo_avg_1: 3,
          __holo_min_1: 3,
          __holo_max_1: 3,
          status: 'closed',
        },
      ]
    })
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const openMaxQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'max',
      },
    })
    const closedSumQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'sum',
      },
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })
    const closedRatingQuery = createQuery({
      aggregate: {
        column: 'rating',
        kind: 'sum',
      },
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })
    const closedMutation = {
      connectionName: 'main',
      kind: 'insert',
      predicates: [],
      tableName: 'posts',
    } satisfies DatabaseMutationEvent
    const mutationExactPredicates = new WeakMap<DatabaseMutationEvent, PredicateDependencyIndex>()
    mutationExactPredicates.set(closedMutation, createExactPredicateIndex('status', 'closed'))

    await expect(backfillAggregate(openMaxQuery, createBackfills([{ queries: [openMaxQuery, closedSumQuery, closedRatingQuery] }], {
      aggregateGroupedSql: new Map(),
      mutationExactPredicates,
      mutations: new Map([
        [createMutationIndexKey('main', 'posts'), [closedMutation]],
      ]),
    }), 0)).resolves.toEqual({
      nextQuery: {
        ...openMaxQuery,
        aggregate: {
          column: 'score',
          currentValueCount: 2,
          kind: 'max',
        },
      },
      patched: true,
      query: openMaxQuery,
      value: 4,
    })
    expect(database.queries).toHaveLength(2)
    expect(database.queries[0]?.sql).toContain('GROUP BY "status"')
    expect(database.queries[0]?.sql).toContain('SUM("rating") AS "__holo_sum_1"')
    expect(database.queries[1]?.sql).toContain('GROUP BY "status", "score"')
  })

  it('backfills grouped min aggregate rows and attaches extreme value counts', async () => {
    const database = createFakeDatabase(statement => {
      if (statement.sql.includes('GROUP BY "status", "score"')) {
        return [
          { __holo_count: 2, score: 3, status: 'open' },
          { __holo_count: 1, score: 6, status: 'closed' },
        ]
      }

      return [
        {
          __holo_count: 2,
          __holo_sum_0: 7,
          __holo_avg_0: 3.5,
          __holo_min_0: 3,
          __holo_max_0: 4,
          status: 'open',
        },
        {
          __holo_count: 1,
          __holo_sum_0: 9,
          __holo_avg_0: 9,
          __holo_min_0: 6,
          __holo_max_0: 9,
          status: 'closed',
        },
      ]
    })
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const openMinQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'min',
      },
    })
    const closedMinQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'min',
      },
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })
    const closedMutation = {
      connectionName: 'main',
      kind: 'insert',
      predicates: [],
      tableName: 'posts',
    } satisfies DatabaseMutationEvent
    const mutationExactPredicates = new WeakMap<DatabaseMutationEvent, PredicateDependencyIndex>()
    mutationExactPredicates.set(closedMutation, createExactPredicateIndex('status', 'closed'))

    await expect(backfillAggregate(openMinQuery, createBackfills([{ queries: [openMinQuery, closedMinQuery] }], {
      aggregateGroupedSql: new Map(),
      mutationExactPredicates,
      mutations: new Map([
        [createMutationIndexKey('main', 'posts'), [closedMutation]],
      ]),
    }), 0)).resolves.toEqual({
      nextQuery: {
        ...openMinQuery,
        aggregate: {
          column: 'score',
          currentValueCount: 2,
          kind: 'min',
        },
      },
      patched: true,
      query: openMinQuery,
      value: 3,
    })
    expect(database.queries).toHaveLength(2)
    expect(database.queries[1]?.sql).toContain('GROUP BY "status", "score"')
  })

  it('skips grouped extreme count backfills when all grouped extreme values are null', async () => {
    const database = createFakeDatabase(() => [
      {
        __holo_count: 1,
        __holo_sum_0: null,
        __holo_avg_0: null,
        __holo_min_0: null,
        __holo_max_0: null,
        status: 'open',
      },
      {
        __holo_count: 1,
        __holo_sum_0: null,
        __holo_avg_0: null,
        __holo_min_0: null,
        __holo_max_0: null,
        status: 'closed',
      },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const openMaxQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'max',
      },
    })
    const closedMaxQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'max',
      },
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })
    const closedMutation = {
      connectionName: 'main',
      kind: 'insert',
      predicates: [],
      tableName: 'posts',
    } satisfies DatabaseMutationEvent
    const mutationExactPredicates = new WeakMap<DatabaseMutationEvent, PredicateDependencyIndex>()
    mutationExactPredicates.set(closedMutation, createExactPredicateIndex('status', 'closed'))

    await expect(backfillAggregate(openMaxQuery, createBackfills([{ queries: [openMaxQuery, closedMaxQuery] }], {
      aggregateGroupedSql: new Map(),
      mutationExactPredicates,
      mutations: new Map([
        [createMutationIndexKey('main', 'posts'), [closedMutation]],
      ]),
    }), 0)).resolves.toEqual({
      nextQuery: {
        ...openMaxQuery,
        aggregate: {
          column: 'score',
          kind: 'max',
        },
      },
      patched: true,
      query: openMaxQuery,
      value: null,
    })
    expect(database.queries).toHaveLength(1)
  })

  it('backfills grouped count aggregate rows before falling back to per-query counts', async () => {
    const database = createFakeDatabase(() => [
      { __holo_count: '5', status: 'open' },
      { __holo_count: '2', status: 'closed' },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const openQuery = createQuery()
    const closedQuery = createQuery({
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })
    const missingExactQuery = createQuery({
      predicates: [{ column: 'status', operator: '=', value: 'pending' }],
    })
    const nonGroupQuery = createQuery({
      predicates: [
        { column: 'status', operator: '=', value: 'ignored' },
        { column: 'tenant_id', operator: '=', value: 1 },
      ],
    })
    const closedMutation = {
      connectionName: 'main',
      kind: 'insert',
      predicates: [],
      tableName: 'posts',
    } satisfies DatabaseMutationEvent
    const missingExactMutation = {
      connectionName: 'main',
      kind: 'insert',
      predicates: [],
      tableName: 'posts',
    } satisfies DatabaseMutationEvent
    const mutationExactPredicates = new WeakMap<DatabaseMutationEvent, PredicateDependencyIndex>()
    mutationExactPredicates.set(closedMutation, createExactPredicateIndex('status', 'closed'))

    await expect(backfillAggregate(openQuery, createBackfills([{ queries: [openQuery, closedQuery, missingExactQuery, nonGroupQuery] }], {
      aggregateGroupedSql: new Map(),
      mutationExactPredicates,
      mutations: new Map([
        [createMutationIndexKey('main', 'posts'), [closedMutation, missingExactMutation]],
      ]),
    }), 0)).resolves.toEqual({
      nextQuery: {
        ...openQuery,
        aggregate: {
          count: undefined,
          kind: 'count',
          output: undefined,
        },
      },
      patched: true,
      query: openQuery,
      value: 5,
    })
    expect(database.queries).toHaveLength(1)
    expect(database.queries[0]?.sql).toContain('GROUP BY "status"')
    expect(database.queries[0]?.bindings).toEqual(['open', 'closed'])
  })

  it('does not require a database connection for grouped aggregate fallback', async () => {
    const openQuery = createQuery()
    const closedQuery = createQuery({
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })
    const closedMutation = {
      connectionName: 'main',
      kind: 'insert',
      predicates: [],
      tableName: 'posts',
    } satisfies DatabaseMutationEvent
    const mutationExactPredicates = new WeakMap<DatabaseMutationEvent, PredicateDependencyIndex>()
    mutationExactPredicates.set(closedMutation, createExactPredicateIndex('status', 'closed'))

    await expect(backfillAggregate(openQuery, createBackfills([{ queries: [openQuery, closedQuery] }], {
      aggregateGroupedSql: new Map(),
      mutationExactPredicates,
      mutations: new Map([
        [createMutationIndexKey('main', 'posts'), [closedMutation]],
      ]),
    }), 0)).resolves.toEqual({ patched: false })
  })

  it('falls back when grouped aggregate candidates are missing or duplicate the same value', async () => {
    const openQuery = createQuery()
    const duplicateOpenQuery = createQuery()
    const openMutation = {
      connectionName: 'main',
      kind: 'insert',
      predicates: [],
      tableName: 'posts',
    } satisfies DatabaseMutationEvent
    const mutationExactPredicates = new WeakMap<DatabaseMutationEvent, PredicateDependencyIndex>()
    mutationExactPredicates.set(openMutation, createExactPredicateIndex('status', 'open'))

    await expect(backfillAggregate(openQuery, createBackfills([], {
      aggregateGroupedSql: new Map(),
    }), 0)).resolves.toEqual({ patched: false })
    await expect(backfillAggregate(openQuery, createBackfills([{ queries: [openQuery, duplicateOpenQuery] }], {
      aggregateGroupedSql: new Map(),
      mutationExactPredicates,
      mutations: new Map([
        [createMutationIndexKey('main', 'posts'), [openMutation]],
      ]),
    }), 0)).resolves.toEqual({ patched: false })
  })

  it('ignores grouped extreme metadata for columns absent from grouped aggregate results', async () => {
    const database = createFakeDatabase(statement => {
      if (statement.sql.includes('GROUP BY "status", "score"')) {
        return [
          { __holo_count: 2, score: 4, status: 'open' },
          { __holo_count: 1, score: 9, status: 'closed' },
        ]
      }

      return [
      {
        __holo_count: 2,
        __holo_sum_0: 7,
        __holo_avg_0: 3.5,
        __holo_min_0: 3,
        __holo_max_0: 4,
        status: 'open',
      },
      {
        __holo_count: 1,
        __holo_sum_0: 9,
        __holo_avg_0: 9,
        __holo_min_0: 9,
        __holo_max_0: 9,
        status: 'closed',
      },
      ]
    })
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const openMaxQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'max',
      },
    })
    const closedSumQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'sum',
      },
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })
    const closedMutation = {
      connectionName: 'main',
      kind: 'insert',
      predicates: [],
      tableName: 'posts',
    } satisfies DatabaseMutationEvent
    const mutationExactPredicates = new WeakMap<DatabaseMutationEvent, PredicateDependencyIndex>()
    mutationExactPredicates.set(closedMutation, createExactPredicateIndex('status', 'closed'))

    await expect(backfillAggregate(openMaxQuery, createBackfills([{ queries: [openMaxQuery, closedSumQuery] }], {
      aggregateExtremeKindsByScope: new Map([
        [createAggregateScopeKey(openMaxQuery), new Map([
          ['rating', Object.freeze({ max: true, min: false })],
        ])],
      ]),
      aggregateGroupedSql: new Map(),
      mutationExactPredicates,
      mutations: new Map([
        [createMutationIndexKey('main', 'posts'), [closedMutation]],
      ]),
    }), 0)).resolves.toEqual({
      nextQuery: {
        ...openMaxQuery,
        aggregate: {
          column: 'score',
          currentValueCount: 2,
          kind: 'max',
        },
      },
      patched: true,
      query: openMaxQuery,
      value: 4,
    })
    expect(database.queries).toHaveLength(2)
  })

  it('skips exact-contradicted grouped aggregate candidates', async () => {
    const database = createFakeDatabase(() => [
      { __holo_count: 5, status: 'open' },
      { __holo_count: 2, status: 'closed' },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const openQuery = createQuery()
    const closedQuery = createQuery({
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })
    const contradictedQuery = createQuery({
      predicates: [
        { column: 'status', operator: '=', value: 'open' },
        { column: 'tenant_id', operator: '=', value: 2 },
      ],
    })
    const closedMutation = {
      connectionName: 'main',
      kind: 'update',
      predicates: [],
      tableName: 'posts',
    } satisfies DatabaseMutationEvent
    const mutationExactPredicates = new WeakMap<DatabaseMutationEvent, PredicateDependencyIndex>()
    mutationExactPredicates.set(closedMutation, createExactPredicateIndex('status', 'closed'))

    await expect(backfillAggregate(openQuery, createBackfills([{ queries: [openQuery, closedQuery, contradictedQuery] }], {
      aggregateGroupedSql: new Map(),
      exactPredicates: createExactPredicateIndex('tenant_id', 1),
      mutationExactPredicates,
      mutations: new Map([
        [createMutationIndexKey('main', 'posts'), [closedMutation]],
      ]),
    }), 0)).resolves.toEqual({
      nextQuery: {
        ...openQuery,
        aggregate: {
          count: undefined,
          kind: 'count',
          output: undefined,
        },
      },
      patched: true,
      query: openQuery,
      value: 5,
    })
    expect(database.queries[0]?.bindings).toEqual(['open', 'closed'])
  })

  it('falls back to a per-query count when grouped count rows are invalid', async () => {
    const database = createFakeDatabase(statement => {
      if (statement.sql.includes('GROUP BY "status"')) {
        return [
          { __holo_count: -1, status: 'open' },
          { __holo_count: 2, status: 'closed' },
        ]
      }

      return [
        { id: 1 },
        { id: 2 },
        { id: 3 },
      ]
    })
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const openQuery = createQuery()
    const closedQuery = createQuery({
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })
    const closedMutation = {
      connectionName: 'main',
      kind: 'insert',
      predicates: [],
      tableName: 'posts',
    } satisfies DatabaseMutationEvent
    const mutationExactPredicates = new WeakMap<DatabaseMutationEvent, PredicateDependencyIndex>()
    mutationExactPredicates.set(closedMutation, createExactPredicateIndex('status', 'closed'))

    await expect(backfillAggregate(openQuery, createBackfills([{ queries: [openQuery, closedQuery] }], {
      aggregateGroupedSql: new Map(),
      mutationExactPredicates,
      mutations: new Map([
        [createMutationIndexKey('main', 'posts'), [closedMutation]],
      ]),
    }), 0)).resolves.toEqual({
      nextQuery: {
        ...openQuery,
        aggregate: {
          count: undefined,
          kind: 'count',
          output: undefined,
        },
      },
      patched: true,
      query: openQuery,
      value: 3,
    })
    expect(database.queries).toHaveLength(2)
    expect(database.queries[0]?.sql).toContain('GROUP BY "status"')
    expect(database.queries[1]?.sql).toContain('"status" = ?')
  })

  it('falls back to single aggregate SQL when grouped extreme count rows are invalid or incomplete', async () => {
    const invalidCountDatabase = createFakeDatabase(statement => {
      if (statement.sql.includes('GROUP BY "status", "score"')) {
        return [
          { __holo_count: 'invalid', score: 4, status: 'open' },
          { __holo_count: 1, score: 9, status: 'closed' },
        ]
      }

      if (statement.sql.includes('GROUP BY "status"')) {
        return [
          {
            __holo_count: 2,
            __holo_sum_0: 7,
            __holo_avg_0: 3.5,
            __holo_min_0: 3,
            __holo_max_0: 4,
            status: 'open',
          },
          {
            __holo_count: 1,
            __holo_sum_0: 9,
            __holo_avg_0: 9,
            __holo_min_0: 9,
            __holo_max_0: 9,
            status: 'closed',
          },
        ]
      }

      return [
        {
          __holo_count: 2,
          __holo_sum_0: 7,
          __holo_avg_0: 3.5,
          __holo_min_0: 3,
          __holo_max_0: 4,
        },
      ]
    })
    configureRealtimeRuntime({
      db: () => invalidCountDatabase.connection,
    })
    const openMaxQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'max',
      },
    })
    const closedMaxQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'max',
      },
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })
    const closedMutation = {
      connectionName: 'main',
      kind: 'insert',
      predicates: [],
      tableName: 'posts',
    } satisfies DatabaseMutationEvent
    const mutationExactPredicates = new WeakMap<DatabaseMutationEvent, PredicateDependencyIndex>()
    mutationExactPredicates.set(closedMutation, createExactPredicateIndex('status', 'closed'))

    await expect(backfillAggregate(openMaxQuery, createBackfills([{ queries: [openMaxQuery, closedMaxQuery] }], {
      aggregateGroupedSql: new Map(),
      mutationExactPredicates,
      mutations: new Map([
        [createMutationIndexKey('main', 'posts'), [closedMutation]],
      ]),
    }), 0)).resolves.toEqual({
      nextQuery: {
        ...openMaxQuery,
        aggregate: {
          column: 'score',
          currentValueCount: 1,
          kind: 'max',
        },
      },
      patched: true,
      query: openMaxQuery,
      value: 4,
    })
    expect(invalidCountDatabase.queries).toHaveLength(5)

    const incompleteCountDatabase = createFakeDatabase(statement => {
      if (statement.sql.includes('GROUP BY "status", "score"')) {
        return [
          { __holo_count: 1, score: 9, status: 'closed' },
        ]
      }

      if (statement.sql.includes('GROUP BY "status"')) {
        return [
          {
            __holo_count: 2,
            __holo_sum_0: 7,
            __holo_avg_0: 3.5,
            __holo_min_0: 3,
            __holo_max_0: 4,
            status: 'open',
          },
          {
            __holo_count: 1,
            __holo_sum_0: 9,
            __holo_avg_0: 9,
            __holo_min_0: 9,
            __holo_max_0: 9,
            status: 'closed',
          },
        ]
      }

      return [
        {
          __holo_count: 2,
          __holo_sum_0: 7,
          __holo_avg_0: 3.5,
          __holo_min_0: 3,
          __holo_max_0: 4,
        },
      ]
    })
    configureRealtimeRuntime({
      db: () => incompleteCountDatabase.connection,
    })

    await expect(backfillAggregate(openMaxQuery, createBackfills([{ queries: [openMaxQuery, closedMaxQuery] }], {
      aggregateGroupedSql: new Map(),
      mutationExactPredicates,
      mutations: new Map([
        [createMutationIndexKey('main', 'posts'), [closedMutation]],
      ]),
    }), 0)).resolves.toEqual({
      nextQuery: {
        ...openMaxQuery,
        aggregate: {
          column: 'score',
          currentValueCount: 1,
          kind: 'max',
        },
      },
      patched: true,
      query: openMaxQuery,
      value: 4,
    })
    expect(incompleteCountDatabase.queries).toHaveLength(5)
  })

  it('attaches min current value counts while preserving non-extreme aggregate columns', async () => {
    const database = createFakeDatabase(statement => {
      if (statement.sql.includes('"score" = ?')) {
        return [
          { id: 1 },
          { id: 2 },
        ]
      }

      return [
        {
          __holo_count: 4,
          __holo_sum_0: 20,
          __holo_avg_0: 5,
          __holo_min_0: 3,
          __holo_max_0: 8,
          __holo_sum_1: 11,
          __holo_avg_1: 2.75,
          __holo_min_1: 2,
          __holo_max_1: 5,
        },
      ]
    })
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const ratingQuery = createQuery({
      aggregate: {
        column: 'rating',
        kind: 'sum',
      },
    })
    const scoreQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'min',
      },
    })

    await expect(backfillAggregate(scoreQuery, createBackfills([{ queries: [ratingQuery] }]), 0)).resolves.toEqual({
      nextQuery: {
        ...scoreQuery,
        aggregate: {
          column: 'score',
          currentValueCount: 2,
          kind: 'min',
        },
      },
      patched: true,
      query: scoreQuery,
      value: 2,
    })
    expect(database.queries).toHaveLength(3)
    expect(database.queries[0]?.sql).toContain('SUM("rating") AS "__holo_sum_0"')
    expect(database.queries[0]?.sql).toContain('MIN("score") AS "__holo_min_1"')
    expect(database.queries[1]?.sql).toContain('GROUP BY "score"')
    expect(database.queries[2]?.sql).toContain('"score" = ?')
  })

  it('reuses min duplicate counts for max metadata when both extremes share the same value', async () => {
    const database = createFakeDatabase(statement => {
      if (statement.sql.includes('"score" = ?')) {
        return [
          { id: 1 },
          { id: 2 },
        ]
      }

      return [
        {
          __holo_count: 2,
          __holo_sum_0: 14,
          __holo_avg_0: 7,
          __holo_min_0: 7,
          __holo_max_0: 7,
        },
      ]
    })
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const minQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'min',
      },
    })
    const maxQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'max',
      },
    })

    await expect(backfillAggregate(maxQuery, createBackfills([{ queries: [minQuery] }]), 0)).resolves.toEqual({
      nextQuery: {
        ...maxQuery,
        aggregate: {
          column: 'score',
          currentValueCount: 2,
          kind: 'max',
        },
      },
      patched: true,
      query: maxQuery,
      value: 7,
    })
    expect(database.queries).toHaveLength(3)
  })

  it('attaches bounded runner-up value counts for single extreme aggregate backfills', async () => {
    const database = createFakeDatabase(statement => {
      if (statement.sql.includes('GROUP BY "score"')) {
        return [
          { __holo_value_count: 2, score: 7 },
          { __holo_value_count: 1, score: 5 },
        ]
      }

      return [
        {
          __holo_count: 3,
          __holo_sum_0: 19,
          __holo_avg_0: 19 / 3,
          __holo_min_0: 5,
          __holo_max_0: 7,
        },
      ]
    })
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const query = createQuery({
      aggregate: {
        column: 'score',
        kind: 'max',
      },
    })

    await expect(backfillAggregate(query, createBackfills(), 0)).resolves.toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          column: 'score',
          currentValueCount: 2,
          kind: 'max',
          valueCounts: [
            { count: 1, value: 5 },
            { count: 2, value: 7 },
          ],
          valueCountsComplete: false,
        },
      },
      patched: true,
      query,
      value: 7,
    })
    expect(database.queries).toHaveLength(2)
    expect(database.queries[1]?.sql).toContain('GROUP BY "score"')
    expect(database.queries.some(statement => statement.sql.includes('"score" = ?'))).toBe(false)
  })

  it('falls back to duplicate counts when bounded value windows omit the current extreme', async () => {
    const database = createFakeDatabase(statement => {
      if (statement.sql.includes('GROUP BY "score"')) {
        return [
          { __holo_value_count: 1, score: 5 },
        ]
      }

      if (statement.sql.includes('"score" = ?')) {
        return [
          { id: 1 },
          { id: 2 },
        ]
      }

      return [
        {
          __holo_count: 3,
          __holo_sum_0: 19,
          __holo_avg_0: 19 / 3,
          __holo_min_0: 5,
          __holo_max_0: 7,
        },
      ]
    })
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const query = createQuery({
      aggregate: {
        column: 'score',
        kind: 'max',
      },
    })

    await expect(backfillAggregate(query, createBackfills(), 0)).resolves.toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          column: 'score',
          currentValueCount: 2,
          kind: 'max',
        },
      },
      patched: true,
      query,
      value: 7,
    })
    expect(database.queries).toHaveLength(3)
  })

  it('attaches zero current value count for single aggregate null extremes', async () => {
    const database = createFakeDatabase(() => [
      {
        __holo_count: 1,
        __holo_sum_0: null,
        __holo_avg_0: null,
        __holo_min_0: null,
        __holo_max_0: null,
      },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const query = createQuery({
      aggregate: {
        column: 'score',
        kind: 'max',
      },
    })

    await expect(backfillAggregate(query, createBackfills(), 0)).resolves.toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          column: 'score',
          currentValueCount: 0,
          kind: 'max',
        },
      },
      patched: true,
      query,
      value: null,
    })
    expect(database.queries).toHaveLength(1)
  })

  it('uses cached aggregate SQL results without recomputing extreme counts', async () => {
    const query = createQuery({
      aggregate: {
        column: 'score',
        kind: 'max',
      },
      connectionName: 'other',
    })
    const cachedResult: AggregateSqlBackfillResult = Object.freeze({
      columns: new Map([
        ['score', Object.freeze({
          avg: 10,
          max: 10,
          min: 10,
          sum: 10,
        })],
      ]),
      count: 1,
    })
    const aggregateSql = new Map<string, Promise<AggregateSqlBackfillResult | undefined>>([
      [createAggregateSqlBackfillKey(query, ['score']), Promise.resolve(cachedResult)],
    ])

    await expect(backfillAggregate(query, createBackfills([], {
      aggregateSql,
    }), 0)).resolves.toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          column: 'score',
          kind: 'max',
        },
      },
      patched: true,
      query,
      value: 10,
    })
  })

  it('falls back from malformed grouped aggregate cache results', async () => {
    const database = createFakeDatabase(statement => {
      if (statement.sql.includes('"score" = ?')) {
        return [
          { id: 1 },
        ]
      }

      return [
        {
          __holo_count: 2,
          __holo_sum_0: 7,
          __holo_avg_0: 3.5,
          __holo_min_0: 3,
          __holo_max_0: 4,
        },
      ]
    })
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const openMaxQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'max',
      },
    })
    const closedMaxQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'max',
      },
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })
    const groupedKey = createGroupedAggregateSqlBackfillKey(openMaxQuery, 'status', ['open', 'closed'], ['score'])
    const malformedGroupedResult = new Map<unknown, AggregateSqlBackfillResult>([
      ['open', Object.freeze({
        columns: new Map(),
        count: 2,
      })],
      ['closed', Object.freeze({
        columns: new Map([
          ['score', Object.freeze({
            avg: 9,
            max: 9,
            min: 9,
            sum: 9,
          })],
        ]),
        count: 1,
      })],
    ])
    const groupedSql = new Map<string, Promise<ReadonlyMap<unknown, AggregateSqlBackfillResult> | undefined>>([
      [groupedKey, Promise.resolve(malformedGroupedResult)],
    ])
    const closedMutation = {
      connectionName: 'main',
      kind: 'insert',
      predicates: [],
      tableName: 'posts',
    } satisfies DatabaseMutationEvent
    const mutationExactPredicates = new WeakMap<DatabaseMutationEvent, PredicateDependencyIndex>()
    mutationExactPredicates.set(closedMutation, createExactPredicateIndex('status', 'closed'))

    await expect(backfillAggregate(openMaxQuery, createBackfills([{ queries: [openMaxQuery, closedMaxQuery] }], {
      aggregateGroupedSql: groupedSql,
      mutationExactPredicates,
      mutations: new Map([
        [createMutationIndexKey('main', 'posts'), [closedMutation]],
      ]),
    }), 0)).resolves.toEqual({ patched: false })
  })

  it('falls back safely when aggregate SQL backfills are unavailable or invalid', async () => {
    const query = createQuery({
      aggregate: {
        column: 'score',
        kind: 'sum',
      },
    })

    await expect(backfillAggregate(query, createBackfills(), 0)).resolves.toEqual({ patched: false })

    const invalidCountDatabase = createFakeDatabase(() => [
      {
        __holo_count: -1,
        __holo_sum_0: 7,
        __holo_avg_0: 3.5,
        __holo_min_0: 3,
        __holo_max_0: 4,
      },
    ])
    configureRealtimeRuntime({
      db: () => invalidCountDatabase.connection,
    })
    await expect(backfillAggregate(query, createBackfills(), 0)).resolves.toEqual({ patched: false })

    const invalidColumnDatabase = createFakeDatabase(() => [
      {
        __holo_count: 2,
        __holo_sum_0: undefined,
        __holo_avg_0: 3.5,
        __holo_min_0: 3,
        __holo_max_0: 4,
      },
    ])
    configureRealtimeRuntime({
      db: () => invalidColumnDatabase.connection,
    })
    await expect(backfillAggregate(query, createBackfills(), 0)).resolves.toEqual({ patched: false })
  })

  it('falls back safely for malformed aggregate metadata and cached SQL results', async () => {
    const scoreQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'sum',
      },
    })
    const malformedMissingColumnQuery = createQuery({
      aggregate: {
        kind: 'sum',
      } as unknown as NonNullable<DatabaseQueryObservation['aggregate']>,
    })
    const unsupportedAggregateQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'median',
      } as unknown as NonNullable<DatabaseQueryObservation['aggregate']>,
    })
    const database = createFakeDatabase(() => [
      {
        __holo_count: 1,
        __holo_sum_0: 10,
        __holo_avg_0: 10,
        __holo_min_0: 10,
        __holo_max_0: 10,
      },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })

    await expect(backfillAggregate(
      malformedMissingColumnQuery,
      createBackfills([{ queries: [scoreQuery] }]),
      0,
    )).resolves.toEqual({ patched: false })
    await expect(backfillAggregate(unsupportedAggregateQuery, createBackfills(), 0)).resolves.toEqual({ patched: false })

    const malformedSqlResult: AggregateSqlBackfillResult = Object.freeze({
      columns: new Map(),
      count: 1,
    })
    const aggregateSql = new Map<string, Promise<AggregateSqlBackfillResult | undefined>>([
      [createAggregateSqlBackfillKey(scoreQuery, ['score']), Promise.resolve(malformedSqlResult)],
    ])

    await expect(backfillAggregate(scoreQuery, createBackfills([], {
      aggregateSql,
    }), 0)).resolves.toEqual({ patched: false })
  })

  it('falls back when grouped aggregate mutations do not match candidate groups', async () => {
    const openQuery = createQuery()
    const closedQuery = createQuery({
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })

    await expect(backfillAggregate(openQuery, createBackfills([{ queries: [openQuery, closedQuery] }], {
      aggregateGroupedSql: new Map(),
      mutations: new Map(),
    }), 0)).resolves.toEqual({ patched: false })
  })

  it('falls back when SQL aggregate numbers are NaN or rows are empty', async () => {
    const query = createQuery({
      aggregate: {
        column: 'score',
        kind: 'sum',
      },
    })
    const nanDatabase = createFakeDatabase(() => [
      {
        __holo_avg_0: 3.5,
        __holo_count: 2,
        __holo_max_0: 4,
        __holo_min_0: 3,
        __holo_sum_0: Number.NaN,
      },
    ])
    configureRealtimeRuntime({
      db: () => nanDatabase.connection,
    })

    await expect(backfillAggregate(query, createBackfills(), 0)).resolves.toEqual({ patched: false })

    const emptyDatabase = createFakeDatabase(() => [])
    configureRealtimeRuntime({
      db: () => emptyDatabase.connection,
    })

    await expect(backfillAggregate(query, createBackfills(), 0)).resolves.toEqual({ patched: false })
  })

  it('uses zero duplicate counts for grouped null aggregate extremes', async () => {
    const database = createFakeDatabase(statement => {
      if (statement.sql.includes('GROUP BY "status", "score"')) {
        return [
          { __holo_count: 1, score: 9, status: 'closed' },
        ]
      }

      return [
        {
          __holo_avg_0: null,
          __holo_count: 0,
          __holo_max_0: null,
          __holo_min_0: null,
          __holo_sum_0: null,
          status: 'open',
        },
        {
          __holo_avg_0: 9,
          __holo_count: 1,
          __holo_max_0: 9,
          __holo_min_0: 9,
          __holo_sum_0: 9,
          status: 'closed',
        },
      ]
    })
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const openMinQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'min',
      },
    })
    const closedMaxQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'max',
      },
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })
    const closedMutation = {
      connectionName: 'main',
      kind: 'insert',
      predicates: [],
      tableName: 'posts',
    } satisfies DatabaseMutationEvent
    const mutationExactPredicates = new WeakMap<DatabaseMutationEvent, PredicateDependencyIndex>()
    mutationExactPredicates.set(closedMutation, createExactPredicateIndex('status', 'closed'))

    await expect(backfillAggregate(openMinQuery, createBackfills([{ queries: [openMinQuery, closedMaxQuery] }], {
      aggregateGroupedSql: new Map(),
      mutationExactPredicates,
      mutations: new Map([
        [createMutationIndexKey('main', 'posts'), [closedMutation]],
      ]),
    }), 0)).resolves.toEqual({
      nextQuery: {
        ...openMinQuery,
        aggregate: {
          column: 'score',
          currentValueCount: 0,
          kind: 'min',
        },
      },
      patched: true,
      query: openMinQuery,
      value: null,
    })
  })

  it('uses zero duplicate counts for grouped null max aggregate extremes', async () => {
    const database = createFakeDatabase(statement => {
      if (statement.sql.includes('GROUP BY "status", "score"')) {
        return [
          { __holo_count: 1, score: 9, status: 'closed' },
        ]
      }

      return [
        {
          __holo_avg_0: null,
          __holo_count: 0,
          __holo_max_0: null,
          __holo_min_0: null,
          __holo_sum_0: null,
          status: 'open',
        },
        {
          __holo_avg_0: 9,
          __holo_count: 1,
          __holo_max_0: 9,
          __holo_min_0: 9,
          __holo_sum_0: 9,
          status: 'closed',
        },
      ]
    })
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const openMaxQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'max',
      },
    })
    const closedMinQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'min',
      },
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })
    const closedMutation = {
      connectionName: 'main',
      kind: 'insert',
      predicates: [],
      tableName: 'posts',
    } satisfies DatabaseMutationEvent
    const mutationExactPredicates = new WeakMap<DatabaseMutationEvent, PredicateDependencyIndex>()
    mutationExactPredicates.set(closedMutation, createExactPredicateIndex('status', 'closed'))

    await expect(backfillAggregate(openMaxQuery, createBackfills([{ queries: [openMaxQuery, closedMinQuery] }], {
      aggregateGroupedSql: new Map(),
      mutationExactPredicates,
      mutations: new Map([
        [createMutationIndexKey('main', 'posts'), [closedMutation]],
      ]),
    }), 0)).resolves.toEqual({
      nextQuery: {
        ...openMaxQuery,
        aggregate: {
          column: 'score',
          currentValueCount: 0,
          kind: 'max',
        },
      },
      patched: true,
      query: openMaxQuery,
      value: null,
    })
  })

  it('omits duplicate-count metadata when cached extreme aggregate SQL results do not include it', async () => {
    const minQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'min',
      },
    })
    const maxQuery = createQuery({
      aggregate: {
        column: 'score',
        kind: 'max',
      },
    })
    const result: AggregateSqlBackfillResult = Object.freeze({
      columns: new Map([
        ['score', Object.freeze({
          avg: 7,
          max: 9,
          min: 4,
          sum: 14,
        })],
      ]),
      count: 2,
    })

    await expect(backfillAggregate(minQuery, createBackfills([], {
      aggregateSql: new Map([
        [createAggregateSqlBackfillKey(minQuery, ['score']), Promise.resolve(result)],
      ]),
    }), 0)).resolves.toEqual({
      nextQuery: {
        ...minQuery,
        aggregate: {
          column: 'score',
          kind: 'min',
        },
      },
      patched: true,
      query: minQuery,
      value: 4,
    })
    await expect(backfillAggregate(maxQuery, createBackfills([], {
      aggregateSql: new Map([
        [createAggregateSqlBackfillKey(maxQuery, ['score']), Promise.resolve(result)],
      ]),
    }), 0)).resolves.toEqual({
      nextQuery: {
        ...maxQuery,
        aggregate: {
          column: 'score',
          kind: 'max',
        },
      },
      patched: true,
      query: maxQuery,
      value: 9,
    })
  })

  it('falls back when non-count aggregate metadata has no column and no scoped columns', async () => {
    const malformedQuery = createQuery({
      aggregate: {
        kind: 'sum',
      } as unknown as NonNullable<DatabaseQueryObservation['aggregate']>,
    })

    await expect(backfillAggregate(malformedQuery, createBackfills(), 0)).resolves.toEqual({ patched: false })
  })

  it('uses cached aggregate backfill values without forcing query metadata updates', async () => {
    const query = createQuery()
    const unchangedResult: AggregateBackfillResult = Object.freeze({
      value: 5,
    })
    const changedResult: AggregateBackfillResult = Object.freeze({
      value: 6,
    })

    await expect(backfillAggregate(query, createBackfills([], {
      aggregates: new Map([
        [createAggregateBackfillKey(query), Promise.resolve(unchangedResult)],
      ]),
    }), 5)).resolves.toEqual({ patched: true, unchanged: true })
    await expect(backfillAggregate(query, createBackfills([], {
      aggregates: new Map([
        [createAggregateBackfillKey(query), Promise.resolve(changedResult)],
      ]),
    }), 5)).resolves.toEqual({
      nextQuery: undefined,
      patched: true,
      query,
      value: 6,
    })
  })
})
