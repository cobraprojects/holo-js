import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../src'
import { configureRealtimeRuntime, resetRealtimeRuntime } from '../src/runtime/lifecycle'
import { tryPatchQueryPaginationMeta } from '../src/runtime/query-pagination-patching'
import {
  createMutationIndexKey,
  type DatabaseMutationEvent,
  type PredicateDependencyIndex,
} from '../src/runtime/dependencies'
import type { BackfillCache } from '../src/runtime/state'
import type { DatabaseQueryObservation } from '../src/runtime/query-state'
import { createFakeDatabase } from './helpers/fake-database'

const paginationBackfillQuery = query({
  name: 'pagination.backfill',
  access: 'public',
  handler: () => null,
})

function createQuery(overrides: Partial<DatabaseQueryObservation> = {}): DatabaseQueryObservation {
  return {
    connectionName: 'main',
    dependencies: ['db:main:posts'],
    orderBy: [],
    patchable: true,
    predicates: [],
    tableName: 'posts',
    ...overrides,
  }
}

function createMutation(overrides: Partial<DatabaseMutationEvent> = {}): DatabaseMutationEvent {
  return {
    connectionName: 'main',
    kind: 'insert',
    predicates: [],
    tableName: 'posts',
    ...overrides,
  }
}

function createBackfills(overrides: Partial<BackfillCache> = {}): BackfillCache {
  return {
    aggregateSql: new Map(),
    aggregates: new Map(),
    entries: [],
    mutationMetadata: new WeakMap(),
    mutations: new Map(),
    paginationCounts: new Map(),
    rows: new Map(),
    ...overrides,
  }
}

function createBackfillEntry(queries: DatabaseQueryObservation[]): BackfillCache['entries'][number] {
  return {
    args: {},
    definition: paginationBackfillQuery,
    dependencies: ['db:main:posts'],
    patchFallbackSubscriberRefs: new Set(),
    patchSubscriberRefs: new Set(),
    patchTargets: [],
    predicateDependencies: new Map(),
    queries,
    refreshKey: 'pagination.backfill:{}',
    resultHash: 'hash',
    resultHashDirty: false,
    snapshotSubscriberRefs: new Set(),
    subscriberRefs: new Set(),
    subscribers: new Set(),
    tableDependencies: ['db:main:posts'],
    version: 1,
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

function createExactPredicateIndexValues(column: string, values: readonly unknown[]): PredicateDependencyIndex {
  return new Map([
    [
      'db:main:posts',
      new Map([
        [column, new Set(values.map(value => encodeURIComponent(JSON.stringify(value))))],
      ]),
    ],
  ])
}

describe('@holo-js/realtime pagination patching', () => {
  afterEach(() => {
    resetRealtimeRuntime()
  })

  it('rejects unsupported pagination metadata inputs without patching', async () => {
    await expect(tryPatchQueryPaginationMeta(
      createQuery(),
      {},
      [],
      createBackfills(),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchQueryPaginationMeta(
      createQuery({
        pagination: {
          currentPage: 1,
          kind: 'standard',
          pageName: 'page',
          perPage: 10,
          total: 1,
        },
      }),
      null,
      [],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
  })

  it('patches standard pagination metadata from matching insert and delete deltas', async () => {
    const query = createQuery({
      pagination: {
        currentPage: 2,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 3,
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      {
        currentPage: 2,
        from: 3,
        hasMorePages: false,
        lastPage: 2,
        pageName: 'page',
        perPage: 2,
        to: 3,
        total: 3,
      },
      [
        createMutation({
          kind: 'insert',
          rows: [{ id: 4, status: 'open' }],
        }),
        createMutation({
          kind: 'delete',
          rows: [{ id: 1, status: 'closed' }],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        pagination: {
          currentPage: 2,
          kind: 'standard',
          pageName: 'page',
          perPage: 2,
          total: 4,
        },
      },
      patched: true,
      query,
      value: {
        currentPage: 2,
        from: 3,
        hasMorePages: false,
        lastPage: 2,
        pageName: 'page',
        perPage: 2,
        to: 4,
        total: 4,
      },
    })
  })

  it('patches standard pagination metadata from predicate-changing update deltas', async () => {
    const query = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 3,
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 2,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 3,
      },
      [
        createMutation({
          kind: 'update',
          previousRows: [{ id: 1, status: 'closed' }],
          rows: [{ id: 1, status: 'open' }],
          values: { status: 'open' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        pagination: {
          currentPage: 1,
          kind: 'standard',
          pageName: 'page',
          perPage: 2,
          total: 4,
        },
      },
      patched: true,
      query,
      value: {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 2,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 4,
      },
    })
  })

  it('patches standard pagination metadata from predicate-changing update values without returned rows', async () => {
    const query = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 3,
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 2,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 3,
      },
      [
        createMutation({
          kind: 'update',
          previousRows: [{ id: 1, status: 'closed' }],
          values: { status: 'open' },
          valueKeys: ['status'],
        }),
        createMutation({
          kind: 'update',
          previousRows: [{ id: 2, status: 'open' }],
          values: { status: 'closed' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: true, unchanged: true })

    await expect(tryPatchQueryPaginationMeta(
      query,
      {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 2,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 3,
      },
      [
        createMutation({
          kind: 'update',
          previousRows: [{ id: 1, status: 'closed' }],
          values: { status: 'open' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        pagination: {
          currentPage: 1,
          kind: 'standard',
          pageName: 'page',
          perPage: 2,
          total: 4,
        },
      },
      patched: true,
      query,
      value: {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 2,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 4,
      },
    })
  })

  it('falls back when pagination update values cannot evaluate patched predicates', async () => {
    const query = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 10,
        total: 1,
      },
      predicates: [{ column: 'priority', operator: '>', value: 1 }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      {
        currentPage: 1,
        from: 1,
        hasMorePages: false,
        lastPage: 1,
        pageName: 'page',
        perPage: 10,
        to: 1,
        total: 1,
      },
      [
        createMutation({
          kind: 'update',
          previousRows: [{ id: 1, priority: 2 }],
          values: { priority: {} },
          valueKeys: ['priority'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
  })

  it('patches pagination metadata from multi-predicate update values without returned rows', async () => {
    const query = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 3,
      },
      predicates: [
        { column: 'status', operator: '=', value: 'open' },
        { column: 'category', operator: '=', value: 'news' },
      ],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 2,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 3,
      },
      [
        createMutation({
          kind: 'update',
          previousRows: [
            { category: 'news', id: 1, status: 'closed' },
            { category: 'archive', id: 2, status: 'closed' },
          ],
          values: { status: 'open' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        pagination: {
          currentPage: 1,
          kind: 'standard',
          pageName: 'page',
          perPage: 2,
          total: 4,
        },
      },
      patched: true,
      query,
      value: {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 2,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 4,
      },
    })
  })

  it('falls back when multi-predicate pagination update values cannot be evaluated', async () => {
    const query = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 10,
        total: 1,
      },
      predicates: [
        { column: 'status', operator: '=', value: 'open' },
        { column: 'priority', operator: '>', value: 1 },
      ],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      {
        currentPage: 1,
        from: 1,
        hasMorePages: false,
        lastPage: 1,
        pageName: 'page',
        perPage: 10,
        to: 1,
        total: 1,
      },
      [
        createMutation({
          kind: 'update',
          previousRows: [{ id: 1, priority: 2, status: 'closed' }],
          values: { priority: {}, status: 'open' },
          valueKeys: ['priority', 'status'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
  })

  it('rejects pagination count patches that would make row counts negative', async () => {
    const query = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 10,
        total: 0,
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      {
        currentPage: 1,
        from: null,
        hasMorePages: false,
        lastPage: 1,
        pageName: 'page',
        perPage: 10,
        to: null,
        total: 0,
      },
      [
        createMutation({
          kind: 'delete',
          rows: [{ id: 1, status: 'open' }],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
  })

  it('patches pagination metadata to an empty page after deleting the last row', async () => {
    const query = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 10,
        total: 1,
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      {
        currentPage: 1,
        from: 1,
        hasMorePages: false,
        lastPage: 1,
        pageName: 'page',
        perPage: 10,
        to: 1,
        total: 1,
      },
      [
        createMutation({
          kind: 'delete',
          rows: [{ id: 1, status: 'open' }],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        pagination: {
          currentPage: 1,
          kind: 'standard',
          pageName: 'page',
          perPage: 10,
          total: 0,
        },
      },
      patched: true,
      query,
      value: {
        currentPage: 1,
        from: null,
        hasMorePages: false,
        lastPage: 1,
        pageName: 'page',
        perPage: 10,
        to: null,
        total: 0,
      },
    })
  })

  it('keeps simple pagination metadata unchanged when the computed value is already current', async () => {
    const query = createQuery({
      pagination: {
        currentPage: 1,
        hasMorePages: false,
        kind: 'simple',
        pageName: 'page',
        perPage: 10,
        rowCount: 1,
      },
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      {
        currentPage: 1,
        from: 1,
        hasMorePages: false,
        pageName: 'page',
        perPage: 10,
        to: 1,
      },
      [
        createMutation({
          kind: 'update',
          values: { title: 'Updated' },
          valueKeys: ['title'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      unchanged: true,
    })
  })

  it('keeps pagination metadata silent when recomputed metadata already matches the value', async () => {
    const query = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 10,
        total: 1,
      },
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      {
        currentPage: 1,
        from: 1,
        hasMorePages: false,
        lastPage: 1,
        pageName: 'page',
        perPage: 10,
        to: 2,
        total: 2,
      },
      [
        createMutation({
          kind: 'insert',
          rows: [{ id: 2 }],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        pagination: {
          currentPage: 1,
          kind: 'standard',
          pageName: 'page',
          perPage: 10,
          total: 2,
        },
      },
      patched: true,
      unchanged: true,
    })
  })

  it('falls back safely when pagination count backfills are unavailable or invalid', async () => {
    const query = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 3,
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })
    const invalidCountDatabase = createFakeDatabase(() => [
      { __holo_count: '' },
    ])

    await expect(tryPatchQueryPaginationMeta(
      query,
      {},
      [
        createMutation({
          kind: 'update',
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchQueryPaginationMeta(
      query,
      {},
      [
        createMutation({
          kind: 'insert',
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchQueryPaginationMeta(
      query,
      {},
      [
        createMutation({
          kind: 'delete',
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchQueryPaginationMeta(
      query,
      {},
      [
        createMutation({
          kind: 'update',
          previousRows: [{ id: 1, status: 'open' }],
          rows: [{ id: 1 }],
          values: { status: 'closed' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })

    configureRealtimeRuntime({
      db: () => invalidCountDatabase.connection,
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      {},
      [
        createMutation({
          kind: 'update',
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
  })

  it('falls back to count backfill when update row predicates cannot be evaluated', async () => {
    const database = createFakeDatabase(() => [
      { __holo_count: '2' },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const query = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 10,
        total: 1,
      },
      predicates: [{ column: 'priority', operator: '>', value: 1 }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      {
        currentPage: 1,
        from: 1,
        hasMorePages: false,
        lastPage: 1,
        pageName: 'page',
        perPage: 10,
        to: 1,
        total: 1,
      },
      [
        createMutation({
          kind: 'update',
          previousRows: [{ id: 1, priority: {} }],
          rows: [{ id: 1, priority: 2 }],
          values: { priority: 2 },
          valueKeys: ['priority'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        pagination: {
          currentPage: 1,
          kind: 'standard',
          pageName: 'page',
          perPage: 10,
          total: 2,
        },
      },
      patched: true,
      query,
      value: {
        currentPage: 1,
        from: 1,
        hasMorePages: false,
        lastPage: 1,
        pageName: 'page',
        perPage: 10,
        to: 2,
        total: 2,
      },
    })
    expect(database.queries).toHaveLength(1)
    expect(database.queries[0]?.sql).toContain('COUNT(*) AS "__holo_count"')
  })

  it('backfills pagination counts through the bound database connection', async () => {
    const database = createFakeDatabase(() => [
      { __holo_count: '5' },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const query = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 3,
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 2,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 3,
      },
      [
        createMutation({
          kind: 'update',
          values: { status: 'closed' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        pagination: {
          currentPage: 1,
          kind: 'standard',
          pageName: 'page',
          perPage: 2,
          total: 5,
        },
      },
      patched: true,
      query,
      value: {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 3,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 5,
      },
    })
    expect(database.queries).toHaveLength(1)
    expect(database.queries[0]?.sql).toContain('COUNT(*) AS "__holo_count"')
    expect(database.queries[0]?.bindings).toEqual(['open'])
  })

  it('falls back to scoped pagination counts when grouped count predicates are unavailable', async () => {
    const database = createFakeDatabase(() => [
      { __holo_count: 6 },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const query = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 3,
      },
      predicates: [{ column: 'priority', operator: '>', value: 1 }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 2,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 3,
      },
      [
        createMutation({
          kind: 'update',
        }),
      ],
      createBackfills({
        paginationGroupedCounts: new Map(),
      }),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        pagination: {
          currentPage: 1,
          kind: 'standard',
          pageName: 'page',
          perPage: 2,
          total: 6,
        },
      },
      patched: true,
      query,
      value: {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 3,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 6,
      },
    })
    expect(database.queries).toHaveLength(1)
    expect(database.queries[0]?.sql).not.toContain('GROUP BY')
  })

  it('falls back to a scoped count when grouped pagination mutations are absent', async () => {
    const database = createFakeDatabase(() => [
      { __holo_count: 3 },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const openQuery = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 2,
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })
    const closedQuery = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 0,
      },
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      openQuery,
      {
        currentPage: 1,
        from: 1,
        hasMorePages: false,
        lastPage: 1,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 2,
      },
      [
        createMutation({
          kind: 'update',
          values: { status: 'closed' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills({
        entries: [createBackfillEntry([openQuery, closedQuery])],
        paginationGroupedCounts: new Map(),
      }),
    )).resolves.toEqual({
      nextQuery: {
        ...openQuery,
        pagination: {
          currentPage: 1,
          kind: 'standard',
          pageName: 'page',
          perPage: 2,
          total: 3,
        },
      },
      patched: true,
      query: openQuery,
      value: {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 2,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 3,
      },
    })
    expect(database.queries).toHaveLength(1)
    expect(database.queries[0]?.sql).not.toContain('GROUP BY "status"')
    expect(database.queries[0]?.bindings).toEqual(['open'])
  })

  it('backfills grouped pagination counts once across related paginated queries', async () => {
    const database = createFakeDatabase(() => [
      { __holo_count: '4', status: 'open' },
      { __holo_count: '1', status: 'closed' },
      { __holo_count: '2', status: 'pending' },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const openQuery = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 2,
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })
    const closedQuery = createQuery({
      pagination: {
        currentPage: 1,
        hasMorePages: false,
        kind: 'simple',
        pageName: 'page',
        perPage: 2,
        rowCount: 0,
      },
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })
    const pendingQuery = createQuery({
      pagination: {
        currentPage: 1,
        hasMorePages: false,
        kind: 'simple',
        pageName: 'page',
        perPage: 2,
        rowCount: 0,
      },
      predicates: [{ column: 'status', operator: '=', value: 'pending' }],
    })
    const unrelatedQuery = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 0,
      },
      predicates: [{ column: 'category', operator: '=', value: 'news' }],
    })
    const closedMutation = createMutation({
      kind: 'insert',
    })
    const ignoredPendingMutation = createMutation({
      kind: 'insert',
      rows: [{ id: 5, status: 'pending' }],
    })
    const pendingMutation = createMutation({
      kind: 'update',
      rows: [{ id: 6, status: 'pending' }],
    })
    const mutationExactPredicates = new WeakMap<DatabaseMutationEvent, PredicateDependencyIndex>()
    mutationExactPredicates.set(closedMutation, createExactPredicateIndex('status', 'closed'))
    mutationExactPredicates.set(ignoredPendingMutation, createExactPredicateIndex('status', 'pending'))
    mutationExactPredicates.set(pendingMutation, createExactPredicateIndex('status', 'pending'))

    await expect(tryPatchQueryPaginationMeta(
      openQuery,
      {
        currentPage: 1,
        from: 1,
        hasMorePages: false,
        lastPage: 1,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 2,
      },
      [
        createMutation({
          kind: 'update',
          values: { status: 'closed' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills({
        entries: [createBackfillEntry([openQuery, unrelatedQuery, closedQuery, pendingQuery])],
        mutationExactPredicates,
        mutations: new Map([
          [createMutationIndexKey('main', 'posts'), [closedMutation, ignoredPendingMutation, pendingMutation]],
        ]),
        paginationGroupedCounts: new Map(),
      }),
    )).resolves.toEqual({
      nextQuery: {
        ...openQuery,
        pagination: {
          currentPage: 1,
          kind: 'standard',
          pageName: 'page',
          perPage: 2,
          total: 4,
        },
      },
      patched: true,
      query: openQuery,
      value: {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 2,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 4,
      },
    })
    expect(database.queries).toHaveLength(1)
    expect(database.queries[0]?.sql).toContain('GROUP BY "status"')
    expect(database.queries[0]?.bindings).toEqual(['open', 'closed', 'pending'])
  })

  it('falls back to a scoped count when grouped pagination values are duplicated or incomplete', async () => {
    const database = createFakeDatabase(() => [
      { __holo_count: '3' },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const openQuery = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 2,
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })
    const closedQuery = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 0,
      },
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      openQuery,
      {
        currentPage: 1,
        from: 1,
        hasMorePages: false,
        lastPage: 1,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 2,
      },
      [
        createMutation({
          kind: 'update',
          values: { status: 'closed' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills({
        entries: [createBackfillEntry([openQuery, openQuery, closedQuery])],
        mutations: new Map([
          [createMutationIndexKey('main', 'posts'), [createMutation({ kind: 'insert' })]],
        ]),
        paginationGroupedCounts: new Map(),
      }),
    )).resolves.toEqual({
      nextQuery: {
        ...openQuery,
        pagination: {
          currentPage: 1,
          kind: 'standard',
          pageName: 'page',
          perPage: 2,
          total: 3,
        },
      },
      patched: true,
      query: openQuery,
      value: {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 2,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 3,
      },
    })
    expect(database.queries).toHaveLength(1)
    expect(database.queries[0]?.sql).not.toContain('GROUP BY "status"')
    expect(database.queries[0]?.bindings).toEqual(['open'])
  })

  it('falls back to scoped counts when grouped pagination count rows are invalid', async () => {
    const database = createFakeDatabase(statement => {
      if (statement.sql.includes('GROUP BY "status"')) {
        return [
          { __holo_count: 'bad', status: 'open' },
          { __holo_count: 1, status: 'closed' },
        ]
      }

      return [
        { __holo_count: 4 },
      ]
    })
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const openQuery = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 2,
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })
    const closedQuery = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 0,
      },
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })
    const closedMutation = createMutation({
      kind: 'insert',
    })
    const mutationExactPredicates = new WeakMap<DatabaseMutationEvent, PredicateDependencyIndex>()
    mutationExactPredicates.set(closedMutation, createExactPredicateIndex('status', 'closed'))

    await expect(tryPatchQueryPaginationMeta(
      openQuery,
      {
        currentPage: 1,
        from: 1,
        hasMorePages: false,
        lastPage: 1,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 2,
      },
      [
        createMutation({
          kind: 'update',
          values: { status: 'closed' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills({
        entries: [createBackfillEntry([openQuery, closedQuery])],
        mutationExactPredicates,
        mutations: new Map([
          [createMutationIndexKey('main', 'posts'), [closedMutation]],
        ]),
        paginationGroupedCounts: new Map(),
      }),
    )).resolves.toEqual({
      nextQuery: {
        ...openQuery,
        pagination: {
          currentPage: 1,
          kind: 'standard',
          pageName: 'page',
          perPage: 2,
          total: 4,
        },
      },
      patched: true,
      query: openQuery,
      value: {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 2,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 4,
      },
    })
    expect(database.queries).toHaveLength(2)
    expect(database.queries[0]?.sql).toContain('GROUP BY "status"')
    expect(database.queries[1]?.sql).not.toContain('GROUP BY "status"')
  })

  it('falls back safely when grouped pagination backfills have no database connection', async () => {
    const openQuery = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 2,
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })
    const closedQuery = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 0,
      },
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })
    const closedMutation = createMutation({
      kind: 'insert',
    })
    const mutationExactPredicates = new WeakMap<DatabaseMutationEvent, PredicateDependencyIndex>()
    mutationExactPredicates.set(closedMutation, createExactPredicateIndex('status', 'closed'))

    await expect(tryPatchQueryPaginationMeta(
      openQuery,
      {
        currentPage: 1,
        from: 1,
        hasMorePages: false,
        lastPage: 1,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 2,
      },
      [
        createMutation({
          kind: 'update',
          values: { status: 'closed' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills({
        entries: [createBackfillEntry([openQuery, closedQuery])],
        mutationExactPredicates,
        mutations: new Map([
          [createMutationIndexKey('main', 'posts'), [closedMutation]],
        ]),
        paginationGroupedCounts: new Map(),
      }),
    )).resolves.toEqual({ patched: false })
  })

  it('filters grouped pagination candidates contradicted by exact predicates', async () => {
    const database = createFakeDatabase(() => [
      { __holo_count: 4, status: 'open' },
      { __holo_count: 2, status: 'pending' },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const openQuery = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 2,
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })
    const closedQuery = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 0,
      },
      predicates: [{ column: 'status', operator: '=', value: 'closed' }],
    })
    const pendingQuery = createQuery({
      pagination: {
        currentPage: 1,
        kind: 'standard',
        pageName: 'page',
        perPage: 2,
        total: 0,
      },
      predicates: [{ column: 'status', operator: '=', value: 'pending' }],
    })
    const pendingMutation = createMutation({
      kind: 'insert',
    })
    const mutationExactPredicates = new WeakMap<DatabaseMutationEvent, PredicateDependencyIndex>()
    mutationExactPredicates.set(pendingMutation, createExactPredicateIndex('status', 'pending'))

    await expect(tryPatchQueryPaginationMeta(
      openQuery,
      {
        currentPage: 1,
        from: 1,
        hasMorePages: false,
        lastPage: 1,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 2,
      },
      [
        createMutation({
          kind: 'update',
          values: { status: 'closed' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills({
        entries: [createBackfillEntry([openQuery, closedQuery, pendingQuery])],
        exactPredicates: createExactPredicateIndexValues('status', ['open', 'pending']),
        mutationExactPredicates,
        mutations: new Map([
          [createMutationIndexKey('main', 'posts'), [pendingMutation]],
        ]),
        paginationGroupedCounts: new Map(),
      }),
    )).resolves.toEqual({
      nextQuery: {
        ...openQuery,
        pagination: {
          currentPage: 1,
          kind: 'standard',
          pageName: 'page',
          perPage: 2,
          total: 4,
        },
      },
      patched: true,
      query: openQuery,
      value: {
        currentPage: 1,
        from: 1,
        hasMorePages: true,
        lastPage: 2,
        pageName: 'page',
        perPage: 2,
        to: 2,
        total: 4,
      },
    })
    expect(database.queries).toHaveLength(1)
    expect(database.queries[0]?.sql).toContain('GROUP BY "status"')
    expect(database.queries[0]?.bindings).toEqual(['open', 'pending'])
  })

  it('falls back safely for cursor pagination mutations that cannot be evaluated locally', async () => {
    const firstRow = Object.freeze({ id: 1, priority: 1, status: 'open' })
    const secondRow = Object.freeze({ id: 2, priority: 2, status: 'open' })
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      pagination: {
        cursorName: 'cursor',
        hasMorePages: false,
        kind: 'cursor',
        nextCursor: null,
        perPage: 2,
        prevCursor: null,
        rowCount: 2,
        rows: [firstRow, secondRow],
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      null,
      [
        createMutation({
          kind: 'insert',
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchQueryPaginationMeta(
      query,
      null,
      [
        createMutation({
          kind: 'insert',
          rows: [{ id: 3, priority: 3 }],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchQueryPaginationMeta(
      query,
      null,
      [
        createMutation({
          kind: 'insert',
          rows: [{ id: 3, status: 'open' }],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchQueryPaginationMeta(
      query,
      null,
      [
        createMutation({
          kind: 'update',
          values: { status: 'closed' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
  })

  it('returns a null cursor when a zero-size cursor page has no visible last row', async () => {
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      pagination: {
        cursorName: 'cursor',
        hasMorePages: false,
        kind: 'cursor',
        nextCursor: 'stale',
        perPage: 0,
        prevCursor: null,
        rowCount: 0,
        rows: [],
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      'stale',
      [
        createMutation({
          kind: 'insert',
          rows: [{ id: 1, priority: 1, status: 'open' }],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        pagination: {
          ...query.pagination,
          hasMorePages: false,
          nextCursor: null,
          rows: [{ id: 1, priority: 1, status: 'open' }],
          rowCount: 1,
        },
      },
      patched: true,
      query,
      value: null,
    })
  })

  it('keeps cursor pagination unchanged for irrelevant inserts, deletes, and updates', async () => {
    const firstRow = Object.freeze({ id: 1, priority: 1, status: 'open' })
    const secondRow = Object.freeze({ id: 2, priority: 2, status: 'open' })
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      pagination: {
        cursorName: 'cursor',
        hasMorePages: false,
        kind: 'cursor',
        nextCursor: null,
        perPage: 2,
        prevCursor: null,
        rowCount: 2,
        rows: [firstRow, secondRow],
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      null,
      [
        createMutation({
          kind: 'insert',
          rows: [{ id: 3, priority: 3, status: 'closed' }],
        }),
        createMutation({
          kind: 'delete',
          rows: [{ id: 4, priority: 4, status: 'closed' }],
        }),
        createMutation({
          kind: 'update',
          values: { title: 'Updated' },
          valueKeys: ['title'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: true, unchanged: true })
  })

  it('falls back safely for cursor deletes with incomplete or inconsistent row data', async () => {
    const firstRow = Object.freeze({ id: 1, priority: 1, status: 'open' })
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      pagination: {
        cursorName: 'cursor',
        hasMorePages: false,
        kind: 'cursor',
        nextCursor: null,
        perPage: 2,
        prevCursor: null,
        rowCount: 1,
        rows: [firstRow],
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      null,
      [
        createMutation({
          kind: 'delete',
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchQueryPaginationMeta(
      query,
      null,
      [
        createMutation({
          kind: 'delete',
          rows: [{ priority: 1 }],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchQueryPaginationMeta(
      query,
      null,
      [
        createMutation({
          kind: 'delete',
          rows: [{ priority: 1, status: 'open' }],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchQueryPaginationMeta(
      query,
      null,
      [
        createMutation({
          kind: 'delete',
          rows: [
            { id: 1, priority: 1, status: 'open' },
            { id: 2, priority: 2, status: 'open' },
          ],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
  })

  it('falls back when cursor inserts leave too few rows to satisfy the current window', async () => {
    const firstRow = Object.freeze({ id: 1, priority: 1, status: 'open' })
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      pagination: {
        cursorName: 'cursor',
        hasMorePages: false,
        kind: 'cursor',
        nextCursor: null,
        perPage: 3,
        prevCursor: null,
        rowCount: 2,
        rows: [firstRow],
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      null,
      [
        createMutation({
          kind: 'insert',
          rows: [{ id: 2, priority: 2, status: 'open' }],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
  })

  it('falls back when cursor related row hydration cannot be resolved', async () => {
    const firstRow = Object.freeze({ id: 1, priority: 1, status: 'open' })
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      pagination: {
        cursorName: 'cursor',
        hasMorePages: false,
        kind: 'cursor',
        nextCursor: null,
        perPage: 2,
        prevCursor: null,
        rowCount: 1,
        rows: [firstRow],
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
      relatedHydrations: [{
        foreignKey: 'post_id',
        kind: 'hasMany',
        localKey: 'id',
        orderBy: [],
        predicates: [],
        relatedConnectionName: 'missing',
        relatedTableName: 'comments',
        relationKey: 'comments',
      }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      null,
      [
        createMutation({
          kind: 'insert',
          rows: [{ id: 2, priority: 2, status: 'open' }],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
  })

  it('falls back when cursor belongs-to hydration cannot read mutation rows', async () => {
    const firstRow = Object.freeze({ id: 1, priority: 1, status: 'open' })
    const query = createQuery({
      belongsToHydrations: [{
        foreignKey: 'author_id',
        ownerKey: 'id',
        relatedConnectionName: 'main',
        relatedTableName: 'authors',
        relationKey: 'author',
      }],
      orderBy: [{ column: 'priority', direction: 'asc' }],
      pagination: {
        cursorName: 'cursor',
        hasMorePages: false,
        kind: 'cursor',
        nextCursor: null,
        perPage: 2,
        prevCursor: null,
        rowCount: 1,
        rows: [firstRow],
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      null,
      [
        createMutation({
          kind: 'insert',
          rows: [undefined] as unknown as readonly Readonly<Record<string, unknown>>[],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
  })

  it('patches cursor deletes when the deleted row is outside the retained window', async () => {
    const firstRow = Object.freeze({ id: 1, priority: 1, status: 'open' })
    const secondRow = Object.freeze({ id: 2, priority: 2, status: 'open' })
    const thirdRow = Object.freeze({ id: 3, priority: 3, status: 'open' })
    const currentCursor = Buffer.from(JSON.stringify({ values: [2] }), 'utf8').toString('base64url')
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      pagination: {
        cursorName: 'cursor',
        hasMorePages: true,
        kind: 'cursor',
        nextCursor: currentCursor,
        perPage: 2,
        prevCursor: null,
        rowCount: 4,
        rows: [firstRow, secondRow, thirdRow],
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      currentCursor,
      [
        createMutation({
          kind: 'delete',
          rows: [{ id: 99, priority: 99, status: 'open' }],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        pagination: {
          cursorName: 'cursor',
          hasMorePages: true,
          kind: 'cursor',
          nextCursor: currentCursor,
          perPage: 2,
          prevCursor: null,
          rowCount: 3,
          rows: [
            firstRow,
            secondRow,
            thirdRow,
          ],
        },
      },
      patched: true,
      unchanged: true,
    })

    const mutableRows = [
      { id: 1, priority: 1, status: 'open' },
      { id: 2, priority: 2, status: 'open' },
    ]
    const mutableRowsQuery = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      pagination: {
        cursorName: 'cursor',
        hasMorePages: false,
        kind: 'cursor',
        nextCursor: null,
        perPage: 2,
        prevCursor: null,
        rowCount: 3,
        rows: mutableRows,
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })
    expect(Object.isFrozen(mutableRows)).toBe(false)

    await expect(tryPatchQueryPaginationMeta(
      mutableRowsQuery,
      null,
      [
        createMutation({
          kind: 'delete',
          rows: [{ id: 99, priority: 99, status: 'open' }],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      nextQuery: {
        ...mutableRowsQuery,
        pagination: {
          cursorName: 'cursor',
          hasMorePages: false,
          kind: 'cursor',
          nextCursor: null,
          perPage: 2,
          prevCursor: null,
          rowCount: 2,
          rows: mutableRows,
        },
      },
      patched: true,
      unchanged: true,
    })
    expect(Object.isFrozen((mutableRowsQuery.pagination as { readonly rows: readonly unknown[] }).rows)).toBe(true)
  })

  it('patches cursor predicate-changing update values without returned rows', async () => {
    const firstRow = Object.freeze({ id: 1, priority: 1, status: 'open' })
    const secondRow = Object.freeze({ id: 2, priority: 2, status: 'open' })
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      pagination: {
        cursorName: 'cursor',
        hasMorePages: false,
        kind: 'cursor',
        nextCursor: null,
        perPage: 2,
        prevCursor: null,
        rowCount: 2,
        rows: [firstRow, secondRow],
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })
    const expectedCursor = Buffer.from(JSON.stringify({ values: [2] }), 'utf8').toString('base64url')

    const entered = await tryPatchQueryPaginationMeta(
      query,
      null,
      [
        createMutation({
          kind: 'update',
          previousRows: [{ id: 3, priority: 3, status: 'closed' }],
          values: { status: 'open' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills(),
    )

    expect(entered).toEqual({
      nextQuery: {
        ...query,
        pagination: {
          cursorName: 'cursor',
          hasMorePages: true,
          kind: 'cursor',
          nextCursor: expectedCursor,
          perPage: 2,
          prevCursor: null,
          rowCount: 3,
          rows: [
            firstRow,
            secondRow,
            { id: 3, priority: 3, status: 'open' },
          ],
        },
      },
      patched: true,
      query,
      value: expectedCursor,
    })

    if (!entered.patched || !('nextQuery' in entered) || !entered.nextQuery) {
      throw new Error('Expected cursor predicate update to patch the query.')
    }

    await expect(tryPatchQueryPaginationMeta(
      entered.nextQuery,
      expectedCursor,
      [
        createMutation({
          kind: 'update',
          previousRows: [{ id: 3, priority: 3, status: 'open' }],
          values: { status: 'closed' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      nextQuery: {
        ...entered.nextQuery,
        pagination: {
          cursorName: 'cursor',
          hasMorePages: false,
          kind: 'cursor',
          nextCursor: null,
          perPage: 2,
          prevCursor: null,
          rowCount: 2,
          rows: [
            firstRow,
            secondRow,
          ],
        },
      },
      patched: true,
      query: entered.nextQuery,
      value: null,
    })
  })

  it('patches cursor predicate-changing upsert values without returned rows', async () => {
    const firstRow = Object.freeze({ id: 1, priority: 1, status: 'open' })
    const secondRow = Object.freeze({ id: 2, priority: 2, status: 'open' })
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      pagination: {
        cursorName: 'cursor',
        hasMorePages: false,
        kind: 'cursor',
        nextCursor: null,
        perPage: 2,
        prevCursor: null,
        rowCount: 2,
        rows: [firstRow, secondRow],
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })
    const expectedCursor = Buffer.from(JSON.stringify({ values: [2] }), 'utf8').toString('base64url')

    await expect(tryPatchQueryPaginationMeta(
      query,
      null,
      [
        createMutation({
          kind: 'upsert',
          previousRows: [{ id: 3, priority: 3, status: 'closed' }],
          values: { status: 'open' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        pagination: {
          cursorName: 'cursor',
          hasMorePages: true,
          kind: 'cursor',
          nextCursor: expectedCursor,
          perPage: 2,
          prevCursor: null,
          rowCount: 3,
          rows: [
            firstRow,
            secondRow,
            { id: 3, priority: 3, status: 'open' },
          ],
        },
      },
      patched: true,
      query,
      value: expectedCursor,
    })
  })

  it('keeps cursor pagination unchanged for outside retained predicate updates that do not change ordering', async () => {
    const firstRow = Object.freeze({ id: 1, priority: 1, status: 'open' })
    const secondRow = Object.freeze({ id: 2, priority: 2, status: 'open' })
    const currentCursor = Buffer.from(JSON.stringify({ values: [2] }), 'utf8').toString('base64url')
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      pagination: {
        cursorName: 'cursor',
        hasMorePages: true,
        kind: 'cursor',
        nextCursor: currentCursor,
        perPage: 2,
        prevCursor: null,
        rowCount: 3,
        rows: [firstRow, secondRow],
      },
      predicates: [{ column: 'status', operator: 'in', value: ['open', 'pending'] }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      currentCursor,
      [
        createMutation({
          kind: 'update',
          previousRows: [{ id: 3, priority: 3, status: 'open' }],
          values: { status: 'pending' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: true, unchanged: true })
  })

  it('keeps cursor pagination unchanged when predicate update remains outside the query', async () => {
    const firstRow = Object.freeze({ id: 1, priority: 1, status: 'open' })
    const secondRow = Object.freeze({ id: 2, priority: 2, status: 'open' })
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      pagination: {
        cursorName: 'cursor',
        hasMorePages: false,
        kind: 'cursor',
        nextCursor: null,
        perPage: 2,
        prevCursor: null,
        rowCount: 2,
        rows: [firstRow, secondRow],
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      null,
      [
        createMutation({
          kind: 'update',
          previousRows: [{ id: 3, priority: 3, status: 'closed' }],
          values: { status: 'archived' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: true, unchanged: true })
  })

  it('patches cursor row count when an outside retained row leaves the query', async () => {
    const firstRow = Object.freeze({ id: 1, priority: 1, status: 'open' })
    const secondRow = Object.freeze({ id: 2, priority: 2, status: 'open' })
    const currentCursor = Buffer.from(JSON.stringify({ values: [2] }), 'utf8').toString('base64url')
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      pagination: {
        cursorName: 'cursor',
        hasMorePages: true,
        kind: 'cursor',
        nextCursor: currentCursor,
        perPage: 2,
        prevCursor: null,
        rowCount: 3,
        rows: [firstRow, secondRow],
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      currentCursor,
      [
        createMutation({
          kind: 'update',
          previousRows: [{ id: 3, priority: 3, status: 'open' }],
          values: { status: 'closed' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        pagination: {
          cursorName: 'cursor',
          hasMorePages: false,
          kind: 'cursor',
          nextCursor: null,
          perPage: 2,
          prevCursor: null,
          rowCount: 2,
          rows: [firstRow, secondRow],
        },
      },
      patched: true,
      query,
      value: null,
    })
  })

  it('falls back when outside retained cursor predicate updates change ordering', async () => {
    const firstRow = Object.freeze({ id: 1, priority: 1, status: 'open' })
    const secondRow = Object.freeze({ id: 2, priority: 2, status: 'open' })
    const currentCursor = Buffer.from(JSON.stringify({ values: [2] }), 'utf8').toString('base64url')
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      pagination: {
        cursorName: 'cursor',
        hasMorePages: true,
        kind: 'cursor',
        nextCursor: currentCursor,
        perPage: 2,
        prevCursor: null,
        rowCount: 3,
        rows: [firstRow, secondRow],
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      currentCursor,
      [
        createMutation({
          kind: 'update',
          previousRows: [{ id: 3, priority: 3, status: 'open' }],
          values: { priority: 0 },
          valueKeys: ['priority'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
  })

  it('falls back when a cursor row enters but is already retained', async () => {
    const firstRow = Object.freeze({ id: 1, priority: 1, status: 'open' })
    const secondRow = Object.freeze({ id: 2, priority: 2, status: 'closed' })
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      pagination: {
        cursorName: 'cursor',
        hasMorePages: false,
        kind: 'cursor',
        nextCursor: null,
        perPage: 2,
        prevCursor: null,
        rowCount: 2,
        rows: [firstRow, secondRow],
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      null,
      [
        createMutation({
          kind: 'update',
          previousRows: [{ id: 2, priority: 2, status: 'closed' }],
          values: { status: 'open' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
  })

  it('patches retained cursor rows from predicate-changing update values without returned rows', async () => {
    const firstRow = Object.freeze({ id: 1, priority: 1, status: 'open' })
    const secondRow = Object.freeze({ id: 2, priority: 2, status: 'open' })
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      pagination: {
        cursorName: 'cursor',
        hasMorePages: false,
        kind: 'cursor',
        nextCursor: null,
        perPage: 2,
        prevCursor: null,
        rowCount: 2,
        rows: [firstRow, secondRow],
      },
      predicates: [{ column: 'status', operator: 'in', value: ['open', 'pending'] }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      null,
      [
        createMutation({
          kind: 'update',
          previousRows: [{ id: 2, priority: 2, status: 'open' }],
          values: { status: 'pending' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        pagination: {
          cursorName: 'cursor',
          hasMorePages: false,
          kind: 'cursor',
          nextCursor: null,
          perPage: 2,
          prevCursor: null,
          rowCount: 2,
          rows: [
            firstRow,
            { id: 2, priority: 2, status: 'pending' },
          ],
        },
      },
      patched: true,
      unchanged: true,
    })
  })

  it('falls back for malformed cursor predicate update values without returned rows', async () => {
    const firstRow = Object.freeze({ id: 1, priority: 1, status: 'open' })
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      pagination: {
        cursorName: 'cursor',
        hasMorePages: false,
        kind: 'cursor',
        nextCursor: null,
        perPage: 2,
        prevCursor: null,
        rowCount: 1,
        rows: [firstRow],
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })

    await expect(tryPatchQueryPaginationMeta(
      query,
      null,
      [
        createMutation({
          kind: 'update',
          previousRows: [{ priority: 2, status: 'closed' }],
          values: { status: 'open' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchQueryPaginationMeta(
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
        pagination: {
          cursorName: 'cursor',
          hasMorePages: false,
          kind: 'cursor',
          nextCursor: null,
          perPage: 2,
          prevCursor: null,
          rowCount: 0,
          rows: [],
        },
        predicates: [{ column: 'status', operator: '=', value: 'open' }],
      }),
      null,
      [
        createMutation({
          kind: 'update',
          previousRows: [{ id: 1, priority: 1, status: 'open' }],
          values: { status: 'closed' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchQueryPaginationMeta(
      createQuery({
        orderBy: [{ column: 'priority', direction: 'asc' }],
        pagination: {
          cursorName: 'cursor',
          hasMorePages: false,
          kind: 'cursor',
          nextCursor: null,
          perPage: 2,
          prevCursor: null,
          rowCount: 1,
          rows: [firstRow],
        },
        predicates: [
          { column: 'status', operator: '=', value: 'open' },
          { column: 'priority', operator: '>', value: 1 },
        ],
      }),
      null,
      [
        createMutation({
          kind: 'update',
          previousRows: [{ id: 1, priority: 2, status: 'closed' }],
          values: { priority: {}, status: 'open' },
          valueKeys: ['priority', 'status'],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
  })

  it('patches cursor next cursors for inserts and deletes without handler reruns', async () => {
    const firstRow = Object.freeze({ id: 1, priority: 1, status: 'open' })
    const secondRow = Object.freeze({ id: 2, priority: 2, status: 'open' })
    const query = createQuery({
      orderBy: [{ column: 'priority', direction: 'asc' }],
      pagination: {
        cursorName: 'cursor',
        hasMorePages: false,
        kind: 'cursor',
        nextCursor: null,
        perPage: 2,
        prevCursor: null,
        rowCount: 2,
        rows: [firstRow, secondRow],
      },
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    })
    const expectedCursor = Buffer.from(JSON.stringify({ values: [2] }), 'utf8').toString('base64url')

    const inserted = await tryPatchQueryPaginationMeta(
      query,
      null,
      [
        createMutation({
          kind: 'insert',
          rows: [{ id: 3, priority: 3, status: 'open' }],
        }),
      ],
      createBackfills(),
    )

    expect(inserted).toEqual({
      nextQuery: {
        ...query,
        pagination: {
          cursorName: 'cursor',
          hasMorePages: true,
          kind: 'cursor',
          nextCursor: expectedCursor,
          perPage: 2,
          prevCursor: null,
          rowCount: 3,
          rows: [
            firstRow,
            secondRow,
            { id: 3, priority: 3, status: 'open' },
          ],
        },
      },
      patched: true,
      query,
      value: expectedCursor,
    })

    if (!inserted.patched || !('nextQuery' in inserted) || !inserted.nextQuery) {
      throw new Error('Expected cursor insert to patch the query.')
    }

    await expect(tryPatchQueryPaginationMeta(
      inserted.nextQuery,
      expectedCursor,
      [
        createMutation({
          kind: 'delete',
          rows: [{ id: 3, priority: 3, status: 'open' }],
        }),
      ],
      createBackfills(),
    )).resolves.toEqual({
      nextQuery: {
        ...inserted.nextQuery,
        pagination: {
          cursorName: 'cursor',
          hasMorePages: false,
          kind: 'cursor',
          nextCursor: null,
          perPage: 2,
          prevCursor: null,
          rowCount: 2,
          rows: [
            firstRow,
            secondRow,
          ],
        },
      },
      patched: true,
      query: inserted.nextQuery,
      value: null,
    })
  })
})
