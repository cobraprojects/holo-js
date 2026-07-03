import { afterEach, describe, expect, it } from 'vitest'
import { query, type RealtimeQueryDefinitionMetadata } from '../src'
import type { PredicateDependencyIndex } from '../src/runtime/dependencies'
import { configureRealtimeRuntime, resetRealtimeRuntime } from '../src/runtime/lifecycle'
import {
  backfillCurrentQueryRows,
  backfillLimitedQueryRows,
  backfillOffsetQueryRows,
} from '../src/runtime/query-row-backfill'
import {
  createBackfillQueryKey,
} from '../src/runtime/query-metadata'
import type { DatabaseQueryObservation } from '../src/runtime/query-state'
import type {
  ActiveQueryEntry,
  BackfillCache,
} from '../src/runtime/state'
import { createFakeDatabase } from './helpers/fake-database'

const backfillQuery = query({
  name: 'row.backfill',
  access: 'public',
  handler: () => null,
})

function createQuery(
  userId: number,
  overrides: Partial<DatabaseQueryObservation> = {},
): DatabaseQueryObservation {
  return {
    connectionName: 'main',
    dependencies: [`db:main:posts:where:user_id:${userId}`],
    limit: 2,
    offset: 1,
    orderBy: [{ column: 'id', direction: 'asc' }],
    patchable: true,
    predicates: [{ column: 'user_id', operator: '=', value: userId }],
    selections: [
      { column: 'id', resultKey: 'id' },
      { column: 'title', resultKey: 'label' },
    ],
    tableName: 'posts',
    ...overrides,
  }
}

function createExactQuery(id: number, overrides: Partial<DatabaseQueryObservation> = {}): DatabaseQueryObservation {
  return createQuery(id, {
    dependencies: [`db:main:posts:where:id:${id}`],
    limit: 1,
    offset: undefined,
    orderBy: [],
    predicates: [{ column: 'id', operator: '=', value: id }],
    rowWindowMode: 'single',
    ...overrides,
  })
}

function createEntry(queries: DatabaseQueryObservation[]): ActiveQueryEntry<RealtimeQueryDefinitionMetadata> {
  return {
    args: {},
    definition: backfillQuery,
    dependencies: [],
    patchFallbackSubscriberRefs: new Set(),
    patchSubscriberRefs: new Set(),
    patchTargets: [],
    predicateDependencies: new Map(),
    queries,
    refreshKey: 'row.backfill:{}',
    resultHash: 'null',
    resultHashDirty: false,
    snapshotSubscriberRefs: new Set(),
    subscriberRefs: new Set(),
    subscribers: new Set(),
    tableDependencies: [],
    version: 1,
  }
}

function createBackfills(
  queries: DatabaseQueryObservation[],
  overrides: Partial<BackfillCache> = {},
): BackfillCache {
  return {
    aggregateSql: new Map(),
    aggregates: new Map(),
    entries: [createEntry(queries)],
    mutationMetadata: new WeakMap(),
    mutations: new Map(),
    paginationCounts: new Map(),
    rowGroups: new Map(),
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

describe('@holo-js/realtime row backfill', () => {
  afterEach(() => {
    resetRealtimeRuntime()
  })

  it('backfills grouped projected offset windows with one query', async () => {
    const database = createFakeDatabase(() => [
      {
        __holo_group_id: 1,
        __holo_row_number: 2,
        id: 12,
        label: 'Second visible',
      },
      {
        __holo_group_id: 2,
        __holo_row_number: 2,
        id: 22,
        label: 'Other visible',
      },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const firstQuery = createQuery(1)
    const secondQuery = createQuery(2)

    await expect(backfillOffsetQueryRows(firstQuery, createBackfills([firstQuery, secondQuery]))).resolves.toEqual([
      {
        id: 12,
        label: 'Second visible',
      },
    ])
    expect(database.queries).toHaveLength(1)
    expect(database.queries[0]?.sql).toBe('SELECT * FROM (SELECT "id", "title" AS "label", "user_id" AS "__holo_group_id", ROW_NUMBER() OVER (PARTITION BY "user_id" ORDER BY "id" ASC) AS "__holo_row_number" FROM "posts" WHERE "user_id" IN (?, ?)) AS "__holo_grouped_rows" WHERE "__holo_row_number" > ? AND "__holo_row_number" <= ? ORDER BY "__holo_group_id" ASC, "__holo_row_number" ASC')
    expect(database.queries[0]?.bindings).toEqual([1, 2, 1, 3])
  })

  it('backfills grouped exact projected rows with one query', async () => {
    const database = createFakeDatabase(() => [
      {
        __holo_group_id: 1,
        id: 1,
        label: 'First',
      },
      {
        __holo_group_id: 2,
        id: 2,
        label: 'Second',
      },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const firstQuery = createExactQuery(1)
    const secondQuery = createExactQuery(2)
    const thirdQuery = createExactQuery(3)

    await expect(backfillCurrentQueryRows(thirdQuery, createBackfills([
      firstQuery,
      secondQuery,
      thirdQuery,
    ]))).resolves.toEqual([])
    expect(database.queries).toHaveLength(1)
    expect(database.queries[0]?.sql).toBe('SELECT "id", "title" AS "label", "id" AS "__holo_group_id" FROM "posts" WHERE "id" IN (?, ?, ?)')
    expect(database.queries[0]?.bindings).toEqual([1, 2, 3])
  })

  it('backfills grouped exact rows without projected selections', async () => {
    const database = createFakeDatabase(() => [
      {
        id: 1,
        title: 'First',
      },
      {
        id: 2,
        title: 'Second',
      },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const firstQuery = createExactQuery(1, {
      selections: undefined,
    })
    const secondQuery = createExactQuery(2, {
      selections: undefined,
    })

    await expect(backfillCurrentQueryRows(firstQuery, createBackfills([
      firstQuery,
      secondQuery,
    ]))).resolves.toEqual([
      {
        id: 1,
        title: 'First',
      },
    ])
    expect(database.queries).toHaveLength(1)
    expect(database.queries[0]?.sql).toBe('SELECT * FROM "posts" WHERE "id" IN (?, ?)')
  })

  it('falls back safely when grouped exact rows cannot be fetched', async () => {
    const firstQuery = createExactQuery(1)
    const secondQuery = createExactQuery(2)

    await expect(backfillCurrentQueryRows(firstQuery, createBackfills([
      firstQuery,
      secondQuery,
    ]))).resolves.toBeUndefined()

    const database = createFakeDatabase(() => [
      {
        id: 1,
        label: 'Missing hidden identity',
      },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })

    await expect(backfillCurrentQueryRows(firstQuery, createBackfills([
      firstQuery,
      secondQuery,
    ]))).resolves.toEqual([
      {
        id: 1,
        label: 'Missing hidden identity',
      },
    ])
    expect(database.queries).toHaveLength(2)
  })

  it('falls back to single exact row backfills when grouped exact candidates are filtered or duplicated', async () => {
    const database = createFakeDatabase(() => [
      {
        id: 1,
        label: 'First',
      },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const firstQuery = createExactQuery(1)
    const secondQuery = createExactQuery(2)

    await expect(backfillCurrentQueryRows(firstQuery, createBackfills([
      firstQuery,
      secondQuery,
    ], {
      exactPredicates: createExactPredicateIndex('id', 1),
    }))).resolves.toEqual([
      {
        id: 1,
        label: 'First',
      },
    ])

    await expect(backfillCurrentQueryRows(firstQuery, createBackfills([
      firstQuery,
      createExactQuery(1),
    ]))).resolves.toEqual([
      {
        id: 1,
        label: 'First',
      },
    ])

    expect(database.queries).toHaveLength(2)
  })

  it('falls back to single exact row backfills when exact candidate selections differ', async () => {
    const database = createFakeDatabase(() => [
      {
        id: 1,
        label: 'First',
      },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const firstQuery = createExactQuery(1)
    const lengthMismatchQuery = createExactQuery(2, {
      selections: [
        { column: 'id', resultKey: 'id' },
      ],
    })
    const aliasMismatchQuery = createExactQuery(3, {
      selections: [
        { column: 'id', resultKey: 'id' },
        { column: 'title', resultKey: 'title' },
      ],
    })

    await expect(backfillCurrentQueryRows(firstQuery, createBackfills([
      firstQuery,
      lengthMismatchQuery,
    ]))).resolves.toEqual([
      {
        id: 1,
        label: 'First',
      },
    ])
    await expect(backfillCurrentQueryRows(firstQuery, createBackfills([
      firstQuery,
      aliasMismatchQuery,
    ]))).resolves.toEqual([
      {
        id: 1,
        label: 'First',
      },
    ])
    expect(database.queries).toHaveLength(2)
  })

  it('falls back safely when grouped offset rows are malformed', async () => {
    const database = createFakeDatabase(statement => statement.sql.includes('ROW_NUMBER()')
      ? [
        {
          __holo_row_number: 2,
          id: 12,
          label: 'Missing group',
        },
      ]
      : [])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const firstQuery = createQuery(1)
    const secondQuery = createQuery(2)

    await expect(backfillOffsetQueryRows(firstQuery, createBackfills([
      firstQuery,
      secondQuery,
    ]))).resolves.toEqual([])
    expect(database.queries).toHaveLength(2)
  })

  it('falls back to single offset backfills when grouped window candidates are filtered or duplicated', async () => {
    const database = createFakeDatabase(() => [
      {
        id: 12,
        label: 'Second visible',
      },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const firstQuery = createQuery(1)
    const secondQuery = createQuery(2)

    await expect(backfillOffsetQueryRows(firstQuery, createBackfills([
      firstQuery,
      secondQuery,
    ], {
      exactPredicates: createExactPredicateIndex('user_id', 1),
    }))).resolves.toEqual([
      {
        id: 12,
        label: 'Second visible',
      },
    ])

    await expect(backfillOffsetQueryRows(firstQuery, createBackfills([
      firstQuery,
      createQuery(1),
    ]))).resolves.toEqual([
      {
        id: 12,
        label: 'Second visible',
      },
    ])

    expect(database.queries).toHaveLength(2)
  })

  it('falls back to single offset backfills when grouped window order differs', async () => {
    const database = createFakeDatabase(() => [
      {
        id: 12,
        label: 'Second visible',
      },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const firstQuery = createQuery(1)
    const orderLengthMismatchQuery = createQuery(2, {
      orderBy: [
        { column: 'id', direction: 'asc' },
        { column: 'title', direction: 'asc' },
      ],
    })
    const orderDirectionMismatchQuery = createQuery(3, {
      orderBy: [
        { column: 'id', direction: 'desc' },
      ],
    })

    await expect(backfillOffsetQueryRows(firstQuery, createBackfills([
      firstQuery,
      orderLengthMismatchQuery,
    ]))).resolves.toEqual([
      {
        id: 12,
        label: 'Second visible',
      },
    ])
    await expect(backfillOffsetQueryRows(firstQuery, createBackfills([
      firstQuery,
      orderDirectionMismatchQuery,
    ]))).resolves.toEqual([
      {
        id: 12,
        label: 'Second visible',
      },
    ])
    expect(database.queries).toHaveLength(2)
  })

  it('backfills grouped current windows without projected selections', async () => {
    const database = createFakeDatabase(() => [
      {
        __holo_group_id: 1,
        __holo_row_number: 2,
        id: 12,
        title: 'Second visible',
        user_id: 1,
      },
      {
        __holo_group_id: 2,
        __holo_row_number: 2,
        id: 22,
        title: 'Other visible',
        user_id: 2,
      },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const firstQuery = createQuery(1, {
      selections: undefined,
    })
    const secondQuery = createQuery(2, {
      selections: undefined,
    })

    await expect(backfillCurrentQueryRows(firstQuery, createBackfills([
      firstQuery,
      secondQuery,
    ]))).resolves.toEqual([
      {
        id: 12,
        title: 'Second visible',
        user_id: 1,
      },
    ])
    expect(database.queries).toHaveLength(1)
    expect(database.queries[0]?.sql).toContain('SELECT *, "user_id" AS "__holo_group_id"')
  })

  it('falls back safely when grouped window backfills have no connection', async () => {
    const firstQuery = createQuery(1)
    const secondQuery = createQuery(2)

    await expect(backfillOffsetQueryRows(firstQuery, createBackfills([
      firstQuery,
      secondQuery,
    ]))).resolves.toBeUndefined()
  })

  it('backfills limited windows through the query cache', async () => {
    const database = createFakeDatabase(() => [
      {
        id: 2,
        title: 'Second',
      },
      {
        id: 3,
        title: 'Third',
      },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const query = createQuery(1, {
      limit: 3,
      offset: undefined,
      predicates: [],
      rowWindowMode: 'limited',
      selections: undefined,
    })
    const backfills = createBackfills([query])

    await expect(backfillLimitedQueryRows(query, [
      {
        id: 1,
        title: 'First',
      },
    ], backfills)).resolves.toEqual([
      {
        id: 1,
        title: 'First',
      },
      {
        id: 2,
        title: 'Second',
      },
      {
        id: 3,
        title: 'Third',
      },
    ])
    await expect(backfillLimitedQueryRows(query, [
      {
        id: 1,
        title: 'First',
      },
    ], backfills)).resolves.toEqual([
      {
        id: 1,
        title: 'First',
      },
      {
        id: 2,
        title: 'Second',
      },
      {
        id: 3,
        title: 'Third',
      },
    ])
    expect(database.queries).toHaveLength(1)
    expect(database.queries[0]?.sql).toBe('SELECT * FROM "posts" ORDER BY "id" ASC LIMIT 2 OFFSET 1')
    expect(database.queries[0]?.bindings).toEqual([])

    const unchangedRows = Object.freeze([
      Object.freeze({
        id: 1,
        title: 'First',
      }),
    ])
    await expect(backfillLimitedQueryRows(query, unchangedRows, createBackfills([query], {
      rows: new Map([
        [createBackfillQueryKey(query, 1, 2), Promise.resolve([
          {
            id: 1,
            title: 'First',
          },
        ])],
      ]),
    }))).resolves.toBe(unchangedRows)
  })

  it('returns undefined for unsupported or unavailable row backfills', async () => {
    const query = createQuery(1)

    await expect(backfillCurrentQueryRows(createQuery(1, {
      limit: 2,
      offset: undefined,
      orderBy: [],
    }), createBackfills([]))).resolves.toBeUndefined()
    await expect(backfillOffsetQueryRows(createQuery(1, {
      limit: undefined,
    }), createBackfills([]))).resolves.toBeUndefined()
    await expect(backfillCurrentQueryRows(createQuery(1, {
      limit: undefined,
      offset: 1,
      rowWindowMode: 'invalid',
    }), createBackfills([]))).resolves.toBeUndefined()
    await expect(backfillCurrentQueryRows(createExactQuery(1), createBackfills([], {
      rowGroups: undefined,
    }))).resolves.toBeUndefined()
    await expect(backfillLimitedQueryRows(createQuery(1, {
      offset: undefined,
      rowWindowMode: 'limited',
    }), [], createBackfills([]))).resolves.toBeUndefined()
    await expect(backfillLimitedQueryRows(query, [], createBackfills([]))).resolves.toBeUndefined()
  })

  it('returns undefined when limited window ordering cannot be verified', async () => {
    const database = createFakeDatabase(() => [
      {
        title: 'Missing order column',
      },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const query = createQuery(1, {
      limit: 2,
      offset: undefined,
      rowWindowMode: 'limited',
      selections: undefined,
    })

    await expect(backfillLimitedQueryRows(query, [], createBackfills([query]))).resolves.toBeUndefined()
  })

  it('returns undefined when backfilled belongs-to or related hydration cannot complete', async () => {
    const database = createFakeDatabase(() => [
      {
        author_id: 1,
        id: 2,
        title: 'Second',
      },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const belongsToQuery = createQuery(1, {
      belongsToHydrations: [
        {
          foreignKey: 'author_id',
          ownerKey: 'id',
          relatedConnectionName: 'other',
          relatedTableName: 'users',
          relationKey: 'author',
        },
      ],
      limit: 1,
      offset: undefined,
      rowWindowMode: 'limited',
      selections: undefined,
    })
    const relatedQuery = createQuery(1, {
      limit: 1,
      offset: undefined,
      relatedHydrations: [
        {
          foreignKey: 'post_id',
          kind: 'hasMany',
          localKey: 'id',
          orderBy: [],
          predicates: [],
          relatedConnectionName: 'other',
          relatedTableName: 'comments',
          relationKey: 'comments',
        },
      ],
      rowWindowMode: 'limited',
      selections: undefined,
    })

    await expect(backfillLimitedQueryRows(belongsToQuery, [], createBackfills([
      belongsToQuery,
    ]))).resolves.toEqual([
      {
        author: null,
        author_id: 1,
        id: 2,
        title: 'Second',
      },
    ])
    await expect(backfillLimitedQueryRows(relatedQuery, [], createBackfills([
      relatedQuery,
    ]))).resolves.toBeUndefined()
  })
})
