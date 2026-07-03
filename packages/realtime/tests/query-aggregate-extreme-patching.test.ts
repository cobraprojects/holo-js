import { describe, expect, it } from 'vitest'
import type { DatabaseMutationEvent } from '../src/runtime/dependencies'
import { createAggregateBackfillKey } from '../src/runtime/query-metadata'
import { tryPatchExtremeAggregate } from '../src/runtime/query-aggregate-extreme-patching'
import type { AggregateBackfillEntry } from '../src/runtime/query-aggregate-common'
import type {
  AggregateBackfillResult,
  BackfillCache,
  DatabaseQueryAggregateObservation,
  DatabaseQueryObservation,
} from '../src/runtime/query-state'

function createQuery(overrides: Partial<DatabaseQueryObservation> = {}): DatabaseQueryObservation {
  return {
    aggregate: {
      column: 'views',
      currentValueCount: 1,
      kind: 'min',
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

function createPatchedExtremeResult(
  query: DatabaseQueryObservation,
  value: number,
  currentValueCount: number,
) {
  return {
    nextQuery: {
      ...query,
      aggregate: {
        ...query.aggregate,
        currentValueCount,
      },
    },
    patched: true,
    query,
    value,
  }
}

describe('@holo-js/realtime extreme aggregate patching', () => {
  it('patches min and max inserts without backfill', () => {
    const minQuery = createQuery()
    const minAggregate = minQuery.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
      minQuery,
      minAggregate,
      5,
      [
        createMutation({
          rows: [
            { id: 2, status: 'open', views: 3 },
          ],
        }),
      ],
      createBackfills(minQuery),
    )).toEqual(createPatchedExtremeResult(minQuery, 3, 1))

    const maxQuery = createQuery({
      aggregate: {
        column: 'views',
        currentValueCount: 1,
        kind: 'max',
      },
    })
    const maxAggregate = maxQuery.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
      maxQuery,
      maxAggregate,
      5,
      [
        createMutation({
          rows: [
            { id: 2, status: 'open', views: 9 },
          ],
        }),
      ],
      createBackfills(maxQuery),
    )).toEqual(createPatchedExtremeResult(maxQuery, 9, 1))
  })

  it('patches min and max from multiple returned rows without backfill', () => {
    const minQuery = createQuery()
    const minAggregate = minQuery.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
      minQuery,
      minAggregate,
      5,
      [
        createMutation({
          rows: [
            { id: 2, status: 'open', views: 4 },
            { id: 3, status: 'open', views: 3 },
          ],
        }),
      ],
      createBackfills(minQuery),
    )).toEqual(createPatchedExtremeResult(minQuery, 3, 1))

    const maxQuery = createQuery({
      aggregate: {
        column: 'views',
        currentValueCount: 1,
        kind: 'max',
      },
    })
    const maxAggregate = maxQuery.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
      maxQuery,
      maxAggregate,
      5,
      [
        createMutation({
          rows: [
            { id: 2, status: 'open', views: 9 },
            { id: 3, status: 'open', views: 6 },
          ],
        }),
      ],
      createBackfills(maxQuery),
    )).toEqual(createPatchedExtremeResult(maxQuery, 9, 1))
  })

  it('carries current-value counts when returned rows create a new duplicate extreme', () => {
    const query = createQuery()
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      5,
      [
        createMutation({
          rows: [
            { id: 2, status: 'open', views: 3 },
            { id: 3, status: 'open', views: 3 },
          ],
        }),
      ],
      createBackfills(query),
    )).toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          column: 'views',
          currentValueCount: 2,
          kind: 'min',
        },
      },
      patched: true,
      query,
      value: 3,
    })
  })

  it('increments current-value counts when returned rows duplicate the existing extreme', () => {
    const query = createQuery()
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      5,
      [
        createMutation({
          rows: [
            { id: 2, status: 'open', views: 5 },
          ],
        }),
      ],
      createBackfills(query),
    )).toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          column: 'views',
          currentValueCount: 2,
          kind: 'min',
        },
      },
      patched: true,
      unchanged: true,
    })
  })

  it('patches current extreme replacements without duplicate-count metadata', () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        kind: 'min',
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      5,
      [
        createMutation({
          kind: 'upsert',
          previousRows: [
            { id: 1, status: 'open', views: 5 },
          ],
          rows: [
            { id: 1, status: 'open', views: 4 },
          ],
        }),
      ],
      createBackfills(query),
    )).toEqual(createPatchedExtremeResult(query, 4, 1))
  })

  it('patches null extreme values from returned candidate rows', () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        kind: 'min',
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      null,
      [
        createMutation({
          rows: [
            { id: 2, status: 'open', views: 4 },
          ],
        }),
      ],
      createBackfills(query),
    )).toEqual(createPatchedExtremeResult(query, 4, 1))
  })

  it('updates current-value counts when the extreme value remains present', () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        currentValueCount: 2,
        kind: 'min',
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation
    const nextAggregate = {
      column: 'views',
      currentValueCount: 1,
      kind: 'min',
    } satisfies DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
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
        aggregate: nextAggregate,
      },
      patched: true,
      unchanged: true,
    })
  })

  it('uses backfill when deleting the only current extreme cannot be resolved locally', async () => {
    const query = createQuery()
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation
    const backfillResult = {
      nextAggregate: {
        column: 'views',
        currentValueCount: 1,
        kind: 'min',
      },
      value: 7,
    } satisfies AggregateBackfillResult

    await expect(tryPatchExtremeAggregate(
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
      createBackfills(query, backfillResult),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        aggregate: backfillResult.nextAggregate,
      },
      patched: true,
      query,
      value: 7,
    })
  })

  it('patches current extreme deletes to runner-up values from value counts', () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        currentValueCount: 1,
        kind: 'max',
        valueCounts: [
          { count: 1, value: 4 },
          { count: 1, value: 5 },
          { count: 1, value: 7 },
        ],
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      7,
      [
        createMutation({
          kind: 'delete',
          rows: [
            { id: 1, status: 'open', views: 7 },
          ],
        }),
      ],
      createBackfills(query),
    )).toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          column: 'views',
          currentValueCount: 1,
          kind: 'max',
          valueCounts: [
            { count: 1, value: 4 },
            { count: 1, value: 5 },
          ],
        },
      },
      patched: true,
      query,
      value: 5,
    })
  })

  it('updates unchanged extreme metadata from value counts without emitting values', () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        currentValueCount: 1,
        kind: 'max',
        valueCounts: [
          { count: 1, value: 5 },
          { count: 1, value: 7 },
        ],
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      7,
      [
        createMutation({
          kind: 'update',
          previousRows: [
            { id: 1, status: 'open', views: 5 },
          ],
          rows: [
            { id: 1, status: 'open', views: 6 },
          ],
          values: { views: 6 },
          valueKeys: ['views'],
        }),
      ],
      createBackfills(query),
    )).toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          column: 'views',
          currentValueCount: 1,
          kind: 'max',
          valueCounts: [
            { count: 1, value: 6 },
            { count: 1, value: 7 },
          ],
        },
      },
      patched: true,
      unchanged: true,
    })
  })

  it('updates unchanged extreme metadata when value-count keys change without changing the value', () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        currentValueCount: 1,
        kind: 'max',
        valueCounts: [
          { count: 1, value: 2 },
          { count: 1, value: 4 },
          { count: 1, value: 6 },
        ],
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'update',
          previousRows: [
            { id: 1, status: 'open', views: 2 },
            { id: 2, status: 'open', views: 4 },
            { id: 3, status: 'open', views: 6 },
          ],
          rows: [
            { id: 1, status: 'open', views: 3 },
            { id: 2, status: 'open', views: 3 },
            { id: 3, status: 'open', views: 6 },
          ],
          values: { views: 3 },
          valueKeys: ['views'],
        }),
      ],
      createBackfills(query),
    )).toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          column: 'views',
          currentValueCount: 1,
          kind: 'max',
          valueCounts: [
            { count: 2, value: 3 },
            { count: 1, value: 6 },
          ],
        },
      },
      patched: true,
      unchanged: true,
    })
  })

  it('updates unchanged extreme metadata when value-count frequencies change without changing the value', () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        currentValueCount: 1,
        kind: 'max',
        valueCounts: [
          { count: 1, value: 2 },
          { count: 1, value: 5 },
          { count: 1, value: 6 },
        ],
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      6,
      [
        createMutation({
          kind: 'update',
          previousRows: [
            { id: 1, status: 'open', views: 2 },
            { id: 2, status: 'open', views: 5 },
            { id: 3, status: 'open', views: 6 },
          ],
          rows: [
            { id: 1, status: 'open', views: 3 },
            { id: 2, status: 'open', views: 4 },
            { id: 3, status: 'open', views: 6 },
          ],
          values: { views: 3 },
          valueKeys: ['views'],
        }),
      ],
      createBackfills(query),
    )).toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          column: 'views',
          currentValueCount: 1,
          kind: 'max',
          valueCounts: [
            { count: 1, value: 3 },
            { count: 1, value: 4 },
            { count: 1, value: 6 },
          ],
        },
      },
      patched: true,
      unchanged: true,
    })
  })

  it('keeps unchanged value-count metadata stable for no-op aggregate updates', () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        currentValueCount: 1,
        kind: 'max',
        valueCounts: [
          { count: 1, value: 5 },
          { count: 1, value: 7 },
        ],
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      7,
      [
        createMutation({
          kind: 'update',
          previousRows: [
            { id: 1, status: 'open', views: 5 },
          ],
          rows: [
            { id: 1, status: 'open', views: 5 },
          ],
          values: { views: 5 },
          valueKeys: ['views'],
        }),
      ],
      createBackfills(query),
    )).toEqual({
      patched: true,
      unchanged: true,
    })
  })

  it('removes absent previous values from value-count metadata without producing negative counts', () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        currentValueCount: 1,
        kind: 'max',
        valueCounts: [
          { count: 1, value: 5 },
        ],
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      7,
      [
        createMutation({
          kind: 'delete',
          rows: [
            { id: 1, status: 'open', views: 7 },
          ],
        }),
      ],
      createBackfills(query),
    )).toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          column: 'views',
          currentValueCount: 1,
          kind: 'max',
          valueCounts: [
            { count: 1, value: 5 },
          ],
        },
      },
      patched: true,
      query,
      value: 5,
    })
  })

  it('patches current extreme deletes from partial runner-up value-count metadata', () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        currentValueCount: 1,
        kind: 'max',
        valueCounts: [
          { count: 1, value: 5 },
          { count: 1, value: 7 },
        ],
        valueCountsComplete: false,
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      7,
      [
        createMutation({
          kind: 'delete',
          rows: [
            { id: 1, status: 'open', views: 7 },
          ],
        }),
      ],
      createBackfills(query),
    )).toEqual({
      nextQuery: {
        ...query,
        aggregate: {
          column: 'views',
          currentValueCount: 1,
          kind: 'max',
          valueCounts: [
            { count: 1, value: 5 },
          ],
          valueCountsComplete: false,
        },
      },
      patched: true,
      query,
      value: 5,
    })
  })

  it('falls back when partial value-count metadata cannot prove a null extreme', async () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        currentValueCount: 1,
        kind: 'max',
        valueCounts: [
          { count: 1, value: 7 },
        ],
        valueCountsComplete: false,
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    await expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      7,
      [
        createMutation({
          kind: 'delete',
          rows: [
            { id: 1, status: 'open', views: 7 },
          ],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })
  })

  it('falls back when partial value-count metadata does not contain the current value', async () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        currentValueCount: 1,
        kind: 'max',
        valueCounts: [
          { count: 1, value: 5 },
        ],
        valueCountsComplete: false,
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    await expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      7,
      [
        createMutation({
          rows: [
            { id: 2, status: 'open', views: 8 },
          ],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })
  })

  it('falls back when extreme value-count metadata is malformed', async () => {
    const query = createQuery({
      aggregate: {
        column: 'views',
        currentValueCount: 1,
        kind: 'max',
        valueCounts: [
          { count: 0, value: 5 },
        ],
      },
    })
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    await expect(tryPatchExtremeAggregate(
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
    )).resolves.toEqual({ patched: false })
  })

  it('patches current extreme replacements when the next candidate preserves the extreme', () => {
    const query = createQuery()
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      5,
      [
        createMutation({
          kind: 'upsert',
          previousRows: [
            { id: 1, status: 'open', views: 5 },
          ],
          rows: [
            { id: 1, status: 'open', views: 4 },
          ],
        }),
      ],
      createBackfills(query),
    )).toEqual(createPatchedExtremeResult(query, 4, 1))
  })

  it('falls back when current extreme replacements do not preserve the extreme', async () => {
    const query = createQuery()
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    await expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      5,
      [
        createMutation({
          kind: 'upsert',
          previousRows: [
            { id: 1, status: 'open', views: 5 },
          ],
          rows: [
            { id: 1, status: 'open', views: 7 },
          ],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })
  })

  it('keeps unmatched rows and non-current extreme deletes unchanged', () => {
    const query = createQuery()
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      5,
      [
        createMutation({
          rows: [
            { id: 2, status: 'closed', views: 3 },
          ],
        }),
      ],
      createBackfills(query),
    )).toEqual({
      patched: true,
      unchanged: true,
    })

    expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      5,
      [
        createMutation({
          kind: 'delete',
          rows: [
            { id: 2, status: 'open', views: 7 },
          ],
        }),
      ],
      createBackfills(query),
    )).toEqual({
      patched: true,
      unchanged: true,
    })
  })

  it('falls back when extreme rows cannot be evaluated', async () => {
    const query = createQuery()
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    await expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      5,
      [
        createMutation({
          rows: [
            { id: 2, views: 3 },
          ],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      5,
      [
        createMutation({
          rows: [
            { id: 2, status: 'open' },
          ],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      5,
      [
        createMutation({
          rows: [
            { id: 2, status: 'open', views: Number.NaN },
          ],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })
  })

  it('falls back for unsupported extreme mutation shapes', async () => {
    const query = createQuery()
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      '5',
      [],
      createBackfills(query),
    )).toEqual({ patched: false })

    await expect(tryPatchExtremeAggregate(
      createQuery({ aggregate: undefined }),
      aggregate,
      5,
      [createMutation({ rows: [{ id: 2, status: 'open', views: 3 }] })],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      5,
      [createMutation({})],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      5,
      [createMutation({ kind: 'delete' })],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      5,
      [createMutation({ kind: 'upsert', rows: [{ id: 2, status: 'open', views: 3 }] })],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      5,
      [
        createMutation({
          kind: 'upsert',
          previousRows: [
            { id: 2, views: 3 },
          ],
          rows: [
            { id: 2, status: 'open', views: 3 },
          ],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      5,
      [createMutation({
        kind: 'update',
        rows: [{ id: 2, status: 'open', views: 3 }],
        values: { views: 3 },
        valueKeys: ['views'],
      })],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      5,
      [
        createMutation({
          kind: 'update',
          previousRows: [
            { id: 2, views: 3 },
          ],
          rows: [
            { id: 2, status: 'open', views: 3 },
          ],
          values: { views: 3 },
          valueKeys: ['views'],
        }),
      ],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })

    await expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      5,
      [createMutation({ kind: 'unknown' as DatabaseMutationEvent['kind'] })],
      createBackfills(query),
    )).resolves.toEqual({ patched: false })
  })

  it('keeps safe updates unchanged without backfill', () => {
    const query = createQuery()
    const aggregate = query.aggregate as DatabaseQueryAggregateObservation

    expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      5,
      [
        createMutation({
          kind: 'update',
          values: { title: 'Updated' },
          valueKeys: ['title'],
        }),
      ],
      createBackfills(query),
    )).toEqual({
      patched: true,
      unchanged: true,
    })

    expect(tryPatchExtremeAggregate(
      query,
      aggregate,
      5,
      [
        createMutation({
          kind: 'update',
          previousRows: [
            { id: 1, status: 'open', views: 5 },
          ],
          rows: [
            { id: 1, status: 'open', views: 4 },
          ],
          values: { views: 4 },
          valueKeys: ['views'],
        }),
      ],
      createBackfills(query),
    )).toEqual(createPatchedExtremeResult(query, 4, 1))
  })
})
