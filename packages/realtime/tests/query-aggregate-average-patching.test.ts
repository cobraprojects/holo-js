import { describe, expect, it } from 'vitest'
import { tryPatchAverageAggregate } from '../src/runtime/query-aggregate-average-patching'
import type { DatabaseMutationEvent } from '../src/runtime/dependencies'
import { createAggregateBackfillKey } from '../src/runtime/query-metadata'
import type { AggregateBackfillEntry } from '../src/runtime/query-aggregate-common'
import type {
  AggregateBackfillResult,
  BackfillCache,
  DatabaseQueryAggregateObservation,
  DatabaseQueryObservation,
} from '../src/runtime/query-state'

type TestRow = Readonly<Record<string, unknown>>

function createQuery(overrides: Partial<DatabaseQueryObservation> = {}): DatabaseQueryObservation {
  return {
    aggregate: {
      column: 'views',
      count: 2,
      kind: 'avg',
      sum: 12,
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

function createMutation(overrides: Partial<DatabaseMutationEvent>): DatabaseMutationEvent {
  return {
    connectionName: 'main',
    kind: 'insert',
    predicates: [],
    tableName: 'posts',
    ...overrides,
  }
}

function createBackfills(
  query: DatabaseQueryObservation,
  result?: AggregateBackfillResult,
): BackfillCache<AggregateBackfillEntry> {
  const aggregates = new Map<string, Promise<AggregateBackfillResult | undefined>>()
  if (result) {
    aggregates.set(createAggregateBackfillKey(query), Promise.resolve(result))
  }

  return {
    aggregateSql: new Map(),
    aggregates,
    entries: [{ queries: [query] }],
    mutationMetadata: new WeakMap(),
    mutations: new Map(),
    paginationCounts: new Map(),
    rows: new Map(),
  }
}

describe('@holo-js/realtime average aggregate patching', () => {
  it('patches inserted matching rows into average metadata without backfill', () => {
    const query = createQuery()
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'insert',
          rows: [
            { id: 3, status: 'open', views: 9 },
          ],
        }),
      ],
      createBackfills(query),
    )).toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          column: 'views',
          count: 3,
          kind: 'avg',
          sum: 21,
        },
      },
      patched: true,
      query,
      value: 7,
    })
  })

  it('patches deletes and updates by applying previous and next aggregate contributions', () => {
    const query = createQuery()
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'delete',
          rows: [
            { id: 1, status: 'open', views: 5 },
          ],
        }),
        createMutation({
          kind: 'update',
          previousRows: [
            { id: 2, status: 'open', views: 7 },
          ],
          rows: [
            { id: 2, status: 'open', views: 11 },
          ],
          values: { views: 11 },
          valueKeys: ['views'],
        }),
      ],
      createBackfills(query),
    )).toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          column: 'views',
          count: 1,
          kind: 'avg',
          sum: 11,
        },
      },
      patched: true,
      query,
      value: 11,
    })
  })

  it('keeps unchanged average values silent while updating aggregate metadata', () => {
    const query = createQuery()
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'insert',
          rows: [
            { id: 3, status: 'open', views: 6 },
          ],
        }),
      ],
      createBackfills(query),
    )).toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          column: 'views',
          count: 3,
          kind: 'avg',
          sum: 18,
        },
      },
      patched: true,
      unchanged: true,
    })
  })

  it('keeps irrelevant updates unchanged without changing aggregate metadata', () => {
    const query = createQuery()
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'update',
          values: { title: 'Updated' },
          valueKeys: ['title'],
        }),
      ],
      createBackfills(query),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('keeps unmatched average insert and delete rows unchanged', () => {
    const query = createQuery()
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'insert',
          rows: [
            { id: 3, status: 'closed', views: 9 },
          ],
        }),
        createMutation({
          kind: 'delete',
          rows: [
            { id: 4, status: 'closed', views: 4 },
          ],
        }),
      ],
      createBackfills(query),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('returns null when average patches remove the last matching row', () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        count: 1,
        kind: 'avg',
        sum: 5,
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchAverageAggregate(
      query,
      aggregate,
      5,
      [
        createMutation({
          kind: 'delete',
          rows: [
            { id: 1, status: 'open', views: 5 },
          ],
        }),
      ],
      createBackfills(query),
    )).toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          column: 'views',
          count: 0,
          kind: 'avg',
          sum: 0,
        },
      },
      patched: true,
      query,
      value: null,
    })
  })

  it('falls back to backfill when average metadata is missing and rows can affect the query', async () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        kind: 'avg',
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation
    const nextAggregate = Object.freeze({
      column: 'views',
      count: 3,
      kind: 'avg' as const,
      sum: 21,
    })

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'insert',
          rows: [
            { id: 3, status: 'open', views: 9 },
          ],
        }),
      ],
      createBackfills(query, {
        nextAggregate,
        value: 7,
      }),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        aggregate: nextAggregate,
      },
      patched: true,
      query,
      value: 7,
    })
  })

  it('keeps missing average metadata unchanged when mutations cannot affect the query', () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        kind: 'avg',
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'update',
          values: { title: 'Updated' },
          valueKeys: ['title'],
        }),
      ],
      createBackfills(query),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back with missing average metadata when returned rows are unavailable', async () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        kind: 'avg',
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'insert',
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'update',
          previousRows: [
            { id: 1, status: 'open' },
          ],
          rows: [
            { id: 1, status: 'open', views: 7 },
          ],
          values: { views: 7 },
          valueKeys: ['views'],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'update',
          previousRows: [
            { id: 1, views: 5 },
          ],
          rows: [
            { id: 1, status: 'open', views: 7 },
          ],
          values: { views: 7 },
          valueKeys: ['views'],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

  })

  it('falls back to backfill when aggregate rows are incomplete', async () => {
    const query = createQuery()
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'delete',
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'insert',
        }),
      ],
      createBackfills(query, {
        nextAggregate: aggregate,
        value: 6,
      }),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        aggregate,
      },
      patched: true,
      unchanged: true,
    })

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'update',
          rows: [
            { id: 1, status: 'open', views: 7 },
          ],
          values: { views: 7 },
          valueKeys: ['views'],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'update',
          previousRows: [
            { id: 1, views: 5 },
          ],
          rows: [
            { id: 1, status: 'open', views: 7 },
          ],
          values: { views: 7 },
          valueKeys: ['views'],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })
  })

  it('falls back when average upserts are missing previous rows or selected values', async () => {
    const query = createQuery()
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'upsert',
          rows: [
            { id: 3, status: 'open', views: 9 },
          ],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'upsert',
          previousRows: [
            { id: 3, views: 9 },
          ],
          rows: [
            { id: 3, status: 'open', views: 9 },
          ],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'upsert',
          previousRows: [
            { id: 3, status: 'open', views: 9 },
          ],
          rows: [
            { id: 3, status: 'open' },
          ],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })
  })

  it('falls back with missing average metadata when upsert previous rows are unavailable', async () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        kind: 'avg',
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'upsert',
          rows: [
            { id: 3, status: 'open', views: 9 },
          ],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'update',
          previousRows: [
            { id: 1, views: 5 },
          ],
          rows: [
            { id: 1, status: 'open', views: 7 },
          ],
          values: { views: 7 },
          valueKeys: ['views'],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })
  })

  it('patches average upserts across previous and next predicate matches', () => {
    const query = createQuery()
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'upsert',
          previousRows: [
            { id: 1, status: 'open', views: 5 },
          ],
          rows: [
            { id: 1, status: 'closed', views: 5 },
          ],
        }),
        createMutation({
          kind: 'upsert',
          previousRows: [
            { id: 3, status: 'closed', views: 9 },
          ],
          rows: [
            { id: 3, status: 'open', views: 9 },
          ],
        }),
      ],
      createBackfills(query),
    )).toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          column: 'views',
          count: 2,
          kind: 'avg',
          sum: 16,
        },
      },
      patched: true,
      query,
      value: 8,
    })
  })

  it('keeps missing average metadata unchanged when upserts and updates cannot affect the query', () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        kind: 'avg',
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'upsert',
          previousRows: [
            { id: 3, status: 'closed', views: 9 },
          ],
          rows: [
            { id: 3, status: 'closed', views: 10 },
          ],
        }),
        createMutation({
          kind: 'update',
          previousRows: [
            { id: 4, status: 'closed', views: 4 },
          ],
          rows: [
            { id: 4, status: 'closed', views: 5 },
          ],
          values: { views: 5 },
          valueKeys: ['views'],
        }),
      ],
      createBackfills(query),
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back with missing average metadata when upsert previous or next rows can affect the query', async () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        kind: 'avg',
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation
    const nextAggregate = Object.freeze({
      column: 'views',
      count: 2,
      kind: 'avg' as const,
      sum: 16,
    })

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'upsert',
          previousRows: [
            { id: 1, status: 'open', views: 5 },
          ],
          rows: [
            { id: 1, status: 'closed', views: 5 },
          ],
        }),
      ],
      createBackfills(query, {
        nextAggregate,
        value: 8,
      }),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        aggregate: nextAggregate,
      },
      patched: true,
      query,
      value: 8,
    })

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'upsert',
          previousRows: [
            { id: 3, status: 'closed', views: 9 },
          ],
          rows: [
            { id: 3, status: 'open', views: 9 },
          ],
        }),
      ],
      createBackfills(query, {
        nextAggregate,
        value: 8,
      }),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        aggregate: nextAggregate,
      },
      patched: true,
      query,
      value: 8,
    })
  })

  it('falls back with missing average metadata when possible affected rows cannot be evaluated', async () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        kind: 'avg',
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'update',
          previousRows: [
            { id: 3, views: 9 },
          ],
          rows: [
            { id: 3, status: 'closed', views: 9 },
          ],
          values: { views: 9 },
          valueKeys: ['views'],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'upsert',
          previousRows: [
            { id: 3, views: 9 },
          ],
          rows: [
            { id: 3, status: 'closed', views: 9 },
          ],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'insert',
          rows: [
            { id: 3, status: 'open' },
          ],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'insert',
          rows: [
            { id: 3, status: 'open', views: Number.NaN },
          ],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })
  })

  it('falls back with missing average metadata when update previous or next rows can affect the query', async () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        kind: 'avg',
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation
    const nextAggregate = Object.freeze({
      column: 'views',
      count: 2,
      kind: 'avg' as const,
      sum: 16,
    })

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'update',
          previousRows: [
            { id: 1, status: 'open', views: 5 },
          ],
          rows: [
            { id: 1, status: 'closed', views: 5 },
          ],
          values: { status: 'closed' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills(query, {
        nextAggregate,
        value: 8,
      }),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        aggregate: nextAggregate,
      },
      patched: true,
      query,
      value: 8,
    })

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'update',
          previousRows: [
            { id: 3, status: 'closed', views: 9 },
          ],
          rows: [
            { id: 3, status: 'open', views: 9 },
          ],
          values: { status: 'open' },
          valueKeys: ['status'],
        }),
      ],
      createBackfills(query, {
        nextAggregate,
        value: 8,
      }),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        aggregate: nextAggregate,
      },
      patched: true,
      query,
      value: 8,
    })
  })

  it('falls back when non-average aggregate metadata reaches the average patcher', async () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        count: 2,
        kind: 'sum',
        sum: 12,
      } as unknown as NonNullable<DatabaseQueryObservation['aggregate']>,
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      12,
      [
        createMutation({
          kind: 'insert',
          rows: [
            { id: 3, status: 'open', views: 9 },
          ],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })
  })

  it('rejects invalid current values and negative aggregate counts', () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        count: 0,
        kind: 'avg',
        sum: 0,
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchAverageAggregate(
      query,
      aggregate,
      '6',
      [],
      createBackfills(query),
    )).toEqual({ patched: false })
    expect(tryPatchAverageAggregate(
      query,
      aggregate,
      null,
      [
        createMutation({
          kind: 'delete',
          rows: [
            { id: 1, status: 'open', views: 5 },
          ],
        }),
      ],
      createBackfills(query),
    )).toEqual({ patched: false })
  })

  it('falls back when average row predicates or aggregate values cannot be evaluated', async () => {
    const query = createQuery()
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'insert',
          rows: [
            { id: 3, status: 'open' },
          ],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'insert',
          rows: [
            { id: 3, views: 9 },
          ],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchAverageAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'insert',
          rows: [
            { id: 3, status: 'open', views: Number.NaN },
          ],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })
  })
})
