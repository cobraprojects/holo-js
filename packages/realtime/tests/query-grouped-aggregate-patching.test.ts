import { afterEach, describe, expect, it } from 'vitest'
import { configureRealtimeRuntime, resetRealtimeRuntime } from '../src/runtime/lifecycle'
import { backfillGroupedAggregateRows } from '../src/runtime/query-grouped-aggregate-backfill'
import { tryPatchGroupedAggregateQuery } from '../src/runtime/query-grouped-aggregate-patching'
import type { DatabaseMutationEvent } from '../src/runtime/dependencies'
import type {
  BackfillCache,
  DatabaseQueryGroupedAggregateObservation,
  DatabaseQueryObservation,
} from '../src/runtime/query-state'
import { createFakeDatabase } from './helpers/fake-database'

const groupedCount = Object.freeze({
  aggregateResultKey: 'total',
  groupColumn: 'user_id',
  groupResultKey: 'user_id',
  kind: 'count',
} satisfies DatabaseQueryGroupedAggregateObservation)

const groupedSum = Object.freeze({
  aggregateColumn: 'score',
  aggregateResultKey: 'score_total',
  groupColumn: 'user_id',
  groupResultKey: 'user_id',
  kind: 'sum',
} satisfies DatabaseQueryGroupedAggregateObservation)

const groupedCountHavingWithStates = Object.freeze({
  ...groupedCount,
  aggregateStates: [
    {
      aggregateValue: 2,
      groupValue: 1,
      rowCount: 2,
    },
    {
      aggregateValue: 1,
      groupValue: 2,
      rowCount: 1,
    },
  ],
  having: { operator: '>', value: 1 },
} satisfies DatabaseQueryGroupedAggregateObservation)

const groupedSumHavingWithStates = Object.freeze({
  ...groupedSum,
  aggregateStates: [
    {
      aggregateValue: 12,
      groupValue: 1,
      rowCount: 2,
    },
    {
      aggregateValue: 11,
      groupValue: 2,
      rowCount: 1,
    },
  ],
  having: { operator: '>', value: 1 },
} satisfies DatabaseQueryGroupedAggregateObservation)

const groupedAvg = Object.freeze({
  aggregateColumn: 'score',
  aggregateResultKey: 'average_score',
  groupColumn: 'user_id',
  groupResultKey: 'user_id',
  kind: 'avg',
} satisfies DatabaseQueryGroupedAggregateObservation)

const groupedAvgWithStates = Object.freeze({
  ...groupedAvg,
  averageStates: [{
    count: 2,
    groupValue: 1,
    rowCount: 2,
    sum: 12,
  }],
} satisfies DatabaseQueryGroupedAggregateObservation)

const groupedMax = Object.freeze({
  aggregateColumn: 'score',
  aggregateResultKey: 'best_score',
  groupColumn: 'user_id',
  groupResultKey: 'user_id',
  kind: 'max',
} satisfies DatabaseQueryGroupedAggregateObservation)

const groupedMin = Object.freeze({
  aggregateColumn: 'score',
  aggregateResultKey: 'lowest_score',
  groupColumn: 'user_id',
  groupResultKey: 'user_id',
  kind: 'min',
} satisfies DatabaseQueryGroupedAggregateObservation)

const groupedMaxHavingWithStates = Object.freeze({
  ...groupedMax,
  aggregateStates: [
    {
      aggregateValue: 7,
      groupValue: 1,
      rowCount: 2,
    },
    {
      aggregateValue: 11,
      groupValue: 2,
      rowCount: 1,
    },
  ],
  having: { operator: '>', value: 1 },
} satisfies DatabaseQueryGroupedAggregateObservation)

const groupedMinHavingWithStates = Object.freeze({
  ...groupedMin,
  aggregateStates: [
    {
      aggregateValue: 5,
      groupValue: 1,
      rowCount: 2,
    },
    {
      aggregateValue: 11,
      groupValue: 2,
      rowCount: 1,
    },
  ],
  having: { operator: '>', value: 1 },
} satisfies DatabaseQueryGroupedAggregateObservation)

function createQuery(
  overrides: Partial<DatabaseQueryObservation> = {},
): DatabaseQueryObservation {
  return Object.freeze({
    connectionName: 'main',
    dependencies: ['db:main:posts'],
    groupedAggregate: groupedCount,
    orderBy: [],
    patchable: true,
    predicates: [],
    selections: [],
    tableName: 'posts',
    ...overrides,
  })
}

function createMutation(
  kind: DatabaseMutationEvent['kind'],
  overrides: Partial<DatabaseMutationEvent> = {},
): DatabaseMutationEvent {
  return Object.freeze({
    connectionName: 'main',
    kind,
    predicates: [],
    tableName: 'posts',
    ...overrides,
  })
}

function createBackfills(overrides: Partial<BackfillCache> = {}): BackfillCache {
  return {
    aggregates: new Map(),
    aggregateSql: new Map(),
    entries: [],
    mutationMetadata: new WeakMap(),
    mutations: new Map(),
    paginationCounts: new Map(),
    rows: new Map(),
    ...overrides,
  }
}

describe('query grouped aggregate patching', () => {
  afterEach(() => {
    resetRealtimeRuntime()
  })

  it('patches grouped count inserts without rerunning the query', () => {
    const query = createQuery({
      orderBy: [{ column: 'user_id', direction: 'asc' }],
    })
    const result = tryPatchGroupedAggregateQuery(
      query,
      [{ total: 2, user_id: 1 }],
      [
        createMutation('insert', {
          rows: [
            { id: 3, user_id: 1 },
            { id: 4, user_id: 2 },
          ],
        }),
      ],
    )

    expect(result).toEqual({
      patched: true,
      query,
      value: [
        { total: 3, user_id: 1 },
        { total: 1, user_id: 2 },
      ],
    })
  })

  it('patches grouped count deletes that remove empty groups', () => {
    const query = createQuery()
    const result = tryPatchGroupedAggregateQuery(
      query,
      [
        { total: 2, user_id: 1 },
        { total: 1, user_id: 2 },
      ],
      [
        createMutation('delete', {
          rows: [{ id: 3, user_id: 2 }],
        }),
      ],
    )

    expect(result).toEqual({
      patched: true,
      query,
      value: [{ total: 2, user_id: 1 }],
    })
  })

  it('patches grouped count updates across groups and predicates', () => {
    const query = createQuery({
      orderBy: [{ column: 'user_id', direction: 'asc' }],
      predicates: [{ column: 'active', operator: '=', value: true }],
    })
    const result = tryPatchGroupedAggregateQuery(
      query,
      [
        { total: 1, user_id: 1 },
        { total: 1, user_id: 2 },
      ],
      [
        createMutation('update', {
          previousRows: [
            { active: true, id: 1, user_id: 1 },
            { active: false, id: 2, user_id: 2 },
          ],
          rows: [
            { active: true, id: 1, user_id: 2 },
            { active: false, id: 2, user_id: 1 },
          ],
        }),
      ],
    )

    expect(result).toEqual({
      patched: true,
      query,
      value: [{ total: 2, user_id: 2 }],
    })
  })

  it('patches grouped count rows through supported having operators', () => {
    const lessThanQuery = createQuery({
      groupedAggregate: {
        ...groupedCount,
        having: { operator: '<', value: 2 },
      },
    })
    expect(tryPatchGroupedAggregateQuery(
      lessThanQuery,
      [{ total: 1, user_id: 1 }],
      [createMutation('insert', { rows: [{ id: 2, user_id: 1 }] })],
    )).toEqual({
      patched: true,
      query: lessThanQuery,
      value: [],
    })

    const lessThanOrEqualQuery = createQuery({
      groupedAggregate: {
        ...groupedCount,
        having: { operator: '<=', value: 2 },
      },
    })
    expect(tryPatchGroupedAggregateQuery(
      lessThanOrEqualQuery,
      [{ total: 1, user_id: 1 }],
      [createMutation('insert', { rows: [{ id: 2, user_id: 1 }] })],
    )).toEqual({
      patched: true,
      query: lessThanOrEqualQuery,
      value: [{ total: 2, user_id: 1 }],
    })

    const equalQuery = createQuery({
      groupedAggregate: {
        ...groupedCount,
        having: { operator: '=', value: 2 },
      },
    })
    expect(tryPatchGroupedAggregateQuery(
      equalQuery,
      [{ total: 1, user_id: 1 }],
      [createMutation('insert', { rows: [{ id: 2, user_id: 1 }] })],
    )).toEqual({
      patched: true,
      query: equalQuery,
      value: [{ total: 2, user_id: 1 }],
    })

    const greaterThanQuery = createQuery({
      groupedAggregate: {
        ...groupedCount,
        having: { operator: '>', value: 2 },
      },
    })
    expect(tryPatchGroupedAggregateQuery(
      greaterThanQuery,
      [{ total: 2, user_id: 1 }],
      [createMutation('insert', { rows: [{ id: 3, user_id: 1 }] })],
    )).toEqual({
      patched: true,
      query: greaterThanQuery,
      value: [{ total: 3, user_id: 1 }],
    })

    const greaterThanOrEqualQuery = createQuery({
      groupedAggregate: {
        ...groupedCount,
        having: { operator: '>=', value: 2 },
      },
    })
    expect(tryPatchGroupedAggregateQuery(
      greaterThanOrEqualQuery,
      [{ total: 2, user_id: 1 }],
      [createMutation('delete', { rows: [{ id: 2, user_id: 1 }] })],
    )).toEqual({
      patched: true,
      query: greaterThanOrEqualQuery,
      value: [],
    })
  })

  it('patches grouped sum inserts and same-group updates', () => {
    const query = createQuery({
      groupedAggregate: groupedSum,
      orderBy: [{ column: 'user_id', direction: 'asc' }],
    })
    const result = tryPatchGroupedAggregateQuery(
      query,
      [{ score_total: 10, user_id: 1 }],
      [
        createMutation('insert', {
          rows: [
            { id: 2, score: 5, user_id: 1 },
            { id: 3, score: 7, user_id: 2 },
          ],
        }),
        createMutation('update', {
          previousRows: [{ id: 1, score: 10, user_id: 1 }],
          rows: [{ id: 1, score: 14, user_id: 1 }],
        }),
      ],
    )

    expect(result).toEqual({
      patched: true,
      query,
      value: [
        { score_total: 19, user_id: 1 },
        { score_total: 7, user_id: 2 },
      ],
    })
  })

  it('patches grouped sum rows that enter predicates', () => {
    const query = createQuery({
      groupedAggregate: groupedSum,
      predicates: [{ column: 'published', operator: '=', value: true }],
    })
    const result = tryPatchGroupedAggregateQuery(
      query,
      [{ score_total: 10, user_id: 1 }],
      [
        createMutation('update', {
          previousRows: [{ id: 2, published: false, score: 5, user_id: 1 }],
          rows: [{ id: 2, published: true, score: 5, user_id: 1 }],
        }),
      ],
    )

    expect(result).toEqual({
      patched: true,
      query,
      value: [{ score_total: 15, user_id: 1 }],
    })
  })

  it('falls back for grouped sum having queries without a backfill cache', () => {
    const query = createQuery({
      groupedAggregate: {
        ...groupedSum,
        having: { operator: '>', value: 1 },
      },
    })

    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ score_total: 12, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 3, score: 6, user_id: 2 }],
      })],
    )).toEqual({ patched: false })
  })

  it('falls back for grouped average queries without a backfill cache', () => {
    const query = createQuery({
      groupedAggregate: groupedAvg,
    })

    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ average_score: 6, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 3, score: 8, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
  })

  it('patches hidden grouped count rows from retained state', () => {
    const query = createQuery({
      groupedAggregate: groupedCountHavingWithStates,
      orderBy: [{ column: 'user_id', direction: 'asc' }],
    })

    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ total: 2, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 4, user_id: 2 }],
      })],
    )).toEqual({
      nextQuery: {
        ...query,
        groupedAggregate: {
          ...groupedCountHavingWithStates,
          aggregateStates: [
            {
              aggregateValue: 2,
              groupValue: 1,
              rowCount: 2,
            },
            {
              aggregateValue: 2,
              groupValue: 2,
              rowCount: 2,
            },
          ],
        },
      },
      patched: true,
      query,
      value: [
        { total: 2, user_id: 1 },
        { total: 2, user_id: 2 },
      ],
    })
  })

  it('patches hidden grouped sum rows from retained state', () => {
    const query = createQuery({
      groupedAggregate: groupedSumHavingWithStates,
      orderBy: [{ column: 'user_id', direction: 'asc' }],
    })

    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ score_total: 12, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 4, score: 6, user_id: 2 }],
      })],
    )).toEqual({
      nextQuery: {
        ...query,
        groupedAggregate: {
          ...groupedSumHavingWithStates,
          aggregateStates: [
            {
              aggregateValue: 12,
              groupValue: 1,
              rowCount: 2,
            },
            {
              aggregateValue: 17,
              groupValue: 2,
              rowCount: 2,
            },
          ],
        },
      },
      patched: true,
      query,
      value: [
        { score_total: 12, user_id: 1 },
        { score_total: 17, user_id: 2 },
      ],
    })
  })

  it('patches grouped sum updates between retained groups', () => {
    const query = createQuery({
      groupedAggregate: groupedSumHavingWithStates,
      orderBy: [{ column: 'user_id', direction: 'asc' }],
    })

    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ score_total: 12, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 3, score: 11, user_id: 2 }],
        rows: [{ id: 3, score: 6, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...query,
        groupedAggregate: {
          ...groupedSumHavingWithStates,
          aggregateStates: [{
            aggregateValue: 18,
            groupValue: 1,
            rowCount: 3,
          }],
        },
      },
      patched: true,
      query,
      value: [{ score_total: 18, user_id: 1 }],
    })
  })

  it('patches grouped sum deletes from retained hidden groups', () => {
    const query = createQuery({
      groupedAggregate: groupedSumHavingWithStates,
    })

    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ score_total: 12, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 3, score: 11, user_id: 2 }],
      })],
    )).toEqual({
      nextQuery: {
        ...query,
        groupedAggregate: {
          ...groupedSumHavingWithStates,
          aggregateStates: [{
            aggregateValue: 12,
            groupValue: 1,
            rowCount: 2,
          }],
        },
      },
      patched: true,
      unchanged: true,
    })
  })

  it('keeps grouped sum rows silent while retained hidden state changes', () => {
    const groupedSumHiddenHaving = Object.freeze({
      ...groupedSum,
      aggregateStates: [{
        aggregateValue: 12,
        groupValue: 1,
        rowCount: 2,
      }],
      having: { operator: '>', value: 3 },
    } satisfies DatabaseQueryGroupedAggregateObservation)
    const query = createQuery({
      groupedAggregate: groupedSumHiddenHaving,
    })

    expect(tryPatchGroupedAggregateQuery(
      query,
      [],
      [createMutation('insert', {
        rows: [{ id: 3, score: 6, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...query,
        groupedAggregate: {
          ...groupedSumHiddenHaving,
          aggregateStates: [{
            aggregateValue: 18,
            groupValue: 1,
            rowCount: 3,
          }],
        },
      },
      patched: true,
      unchanged: true,
    })
  })

  it('creates retained grouped count state for new hidden groups', () => {
    const groupedCountEmptyState = Object.freeze({
      ...groupedCount,
      aggregateStates: [],
      having: { operator: '>', value: 1 },
    } satisfies DatabaseQueryGroupedAggregateObservation)
    const query = createQuery({
      groupedAggregate: groupedCountEmptyState,
    })

    expect(tryPatchGroupedAggregateQuery(
      query,
      [],
      [createMutation('insert', {
        rows: [{ id: 1, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...query,
        groupedAggregate: {
          ...groupedCountEmptyState,
          aggregateStates: [{
            aggregateValue: 1,
            groupValue: 1,
            rowCount: 1,
          }],
        },
      },
      patched: true,
      unchanged: true,
    })
  })

  it('removes grouped count rows when retained state stops matching having', () => {
    const query = createQuery({
      groupedAggregate: groupedCountHavingWithStates,
    })

    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ total: 2, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 2, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...query,
        groupedAggregate: {
          ...groupedCountHavingWithStates,
          aggregateStates: [
            {
              aggregateValue: 1,
              groupValue: 1,
              rowCount: 1,
            },
            {
              aggregateValue: 1,
              groupValue: 2,
              rowCount: 1,
            },
          ],
        },
      },
      patched: true,
      query,
      value: [],
    })
  })

  it('removes grouped count retained state when the last row leaves', () => {
    const groupedCountSingleState = Object.freeze({
      ...groupedCount,
      aggregateStates: [{
        aggregateValue: 1,
        groupValue: 1,
        rowCount: 1,
      }],
      having: { operator: '>=', value: 1 },
    } satisfies DatabaseQueryGroupedAggregateObservation)
    const query = createQuery({
      groupedAggregate: groupedCountSingleState,
    })

    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ total: 1, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...query,
        groupedAggregate: {
          ...groupedCountSingleState,
          aggregateStates: [],
        },
      },
      patched: true,
      query,
      value: [],
    })
  })

  it('keeps grouped count retained state unchanged for irrelevant mutations', () => {
    const query = createQuery({
      groupedAggregate: groupedCountHavingWithStates,
      predicates: [{ column: 'status', operator: '=', value: 'published' }],
    })

    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ total: 2, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 4, status: 'draft', user_id: 2 }],
      })],
    )).toEqual({ patched: true, unchanged: true })
  })

  it('falls back for inconsistent grouped aggregate retained state', () => {
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedCount,
          aggregateStates: [],
          having: { operator: '>', value: 1 },
        },
      }),
      [],
      [createMutation('delete', {
        rows: [{ id: 1, user_id: 1 }],
      })],
    )).toEqual({ patched: false })

    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedCountHavingWithStates,
      }),
      [],
      [createMutation('insert', {
        rows: [{ id: 4, user_id: 1 }],
      })],
    )).toEqual({ patched: false })

    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedCountHavingWithStates,
      }),
      [{ total: 1, user_id: 2 }],
      [createMutation('insert', {
        rows: [{ id: 4, user_id: 2 }],
      })],
    )).toEqual({ patched: false })

    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedCount,
          aggregateStates: [{
            aggregateValue: 1,
            groupValue: 1,
            rowCount: 1,
          }],
          having: { operator: '>=', value: 1 },
        },
      }),
      [{ total: 1, user_id: 1 }],
      [createMutation('delete', {
        rows: [
          { id: 1, user_id: 1 },
          { id: 2, user_id: 1 },
        ],
      })],
    )).toEqual({ patched: false })

    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedSumHavingWithStates,
      }),
      [{ score_total: 12, user_id: 1 }],
      [createMutation('insert')],
    )).toEqual({ patched: false })

    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedSumHavingWithStates,
      }),
      [{ score_total: 12, user_id: 1 }],
      [createMutation('delete')],
    )).toEqual({ patched: false })

    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedSumHavingWithStates,
      }),
      [{ score_total: 12, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, user_id: 1 }],
        rows: [{ id: 1, score: 6, user_id: 1 }],
      })],
    )).toEqual({ patched: false })

    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedCount,
          aggregateStates: [],
          having: { operator: '>=', value: 1 },
        },
        orderBy: [{ column: 'created_at', direction: 'asc' }],
      }),
      [],
      [createMutation('insert', {
        rows: [{ id: 1, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
  })

  it('patches hidden grouped max and min rows from retained state', () => {
    const maxQuery = createQuery({
      groupedAggregate: groupedMaxHavingWithStates,
      orderBy: [{ column: 'user_id', direction: 'asc' }],
    })
    const minQuery = createQuery({
      groupedAggregate: groupedMinHavingWithStates,
      orderBy: [{ column: 'user_id', direction: 'asc' }],
    })

    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 7, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 4, score: 6, user_id: 2 }],
      })],
    )).toEqual({
      nextQuery: {
        ...maxQuery,
        groupedAggregate: {
          ...groupedMaxHavingWithStates,
          aggregateStates: [
            {
              aggregateValue: 7,
              groupValue: 1,
              rowCount: 2,
            },
            {
              aggregateValue: 11,
              groupValue: 2,
              rowCount: 2,
            },
          ],
        },
      },
      patched: true,
      query: maxQuery,
      value: [
        { best_score: 7, user_id: 1 },
        { best_score: 11, user_id: 2 },
      ],
    })
    expect(tryPatchGroupedAggregateQuery(
      minQuery,
      [{ lowest_score: 5, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 4, score: 6, user_id: 2 }],
      })],
    )).toEqual({
      nextQuery: {
        ...minQuery,
        groupedAggregate: {
          ...groupedMinHavingWithStates,
          aggregateStates: [
            {
              aggregateValue: 5,
              groupValue: 1,
              rowCount: 2,
            },
            {
              aggregateValue: 6,
              groupValue: 2,
              rowCount: 2,
            },
          ],
        },
      },
      patched: true,
      query: minQuery,
      value: [
        { lowest_score: 5, user_id: 1 },
        { lowest_score: 6, user_id: 2 },
      ],
    })
  })

  it('patches grouped extreme rows leaving having from retained state', () => {
    const query = createQuery({
      groupedAggregate: groupedMaxHavingWithStates,
    })

    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ best_score: 7, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, score: 5, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...query,
        groupedAggregate: {
          ...groupedMaxHavingWithStates,
          aggregateStates: [
            {
              aggregateValue: 7,
              groupValue: 1,
              rowCount: 1,
            },
            {
              aggregateValue: 11,
              groupValue: 2,
              rowCount: 1,
            },
          ],
        },
      },
      patched: true,
      query,
      value: [],
    })
  })

  it('keeps hidden grouped extreme state current without publishing unchanged rows', () => {
    const query = createQuery({
      groupedAggregate: {
        ...groupedMax,
        aggregateStates: [{
          aggregateValue: 7,
          groupValue: 1,
          rowCount: 2,
        }],
        having: { operator: '>', value: 3 },
      },
    })

    expect(tryPatchGroupedAggregateQuery(
      query,
      [],
      [createMutation('insert', {
        rows: [{ id: 3, score: 9, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...query,
        groupedAggregate: {
          ...query.groupedAggregate,
          aggregateStates: [{
            aggregateValue: 9,
            groupValue: 1,
            rowCount: 3,
          }],
        },
      },
      patched: true,
      unchanged: true,
    })
  })

  it('patches retained grouped extreme state for hidden and visible edge cases', () => {
    const hiddenQuery = createQuery({
      groupedAggregate: {
        ...groupedMax,
        aggregateStates: [{
          aggregateValue: 7,
          groupValue: 1,
          rowCount: 2,
        }],
        having: { operator: '>', value: 1 },
      },
    })
    const visibleQuery = createQuery({
      groupedAggregate: {
        ...groupedMax,
        aggregateStates: [{
          aggregateValue: 7,
          groupValue: 1,
          rowCount: 3,
        }],
        having: { operator: '>', value: 1 },
      },
    })

    expect(tryPatchGroupedAggregateQuery(
      hiddenQuery,
      [{ best_score: 7, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 5, user_id: 1 }],
        rows: [{ id: 1, score: 9, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...hiddenQuery,
        groupedAggregate: {
          ...hiddenQuery.groupedAggregate,
          aggregateStates: [{
            aggregateValue: 9,
            groupValue: 1,
            rowCount: 2,
          }],
        },
      },
      patched: true,
      query: hiddenQuery,
      value: [{ best_score: 9, user_id: 1 }],
    })
    expect(tryPatchGroupedAggregateQuery(
      hiddenQuery,
      [{ best_score: 7, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 5, user_id: 1 }],
        rows: [{ id: 1, score: 6, user_id: 1 }],
      })],
    )).toEqual({
      patched: true,
      unchanged: true,
    })
    expect(tryPatchGroupedAggregateQuery(
      hiddenQuery,
      [{ best_score: 7, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 7, user_id: 1 }],
        rows: [{ id: 1, score: 8, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...hiddenQuery,
        groupedAggregate: {
          ...hiddenQuery.groupedAggregate,
          aggregateStates: [{
            aggregateValue: 8,
            groupValue: 1,
            rowCount: 2,
          }],
        },
      },
      patched: true,
      query: hiddenQuery,
      value: [{ best_score: 8, user_id: 1 }],
    })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 11,
            groupValue: 2,
            rowCount: 1,
          }],
          having: { operator: '>', value: 1 },
        },
      }),
      [],
      [createMutation('update', {
        previousRows: [{ id: 2, score: 11, user_id: 2 }],
        rows: [{ id: 2, score: 12, user_id: 2 }],
      })],
    )).toEqual({
      nextQuery: createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 12,
            groupValue: 2,
            rowCount: 1,
          }],
          having: { operator: '>', value: 1 },
        },
      }),
      patched: true,
      unchanged: true,
    })
    expect(tryPatchGroupedAggregateQuery(
      hiddenQuery,
      [{ best_score: 7, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 3, score: 4, user_id: 3 }],
      })],
    )).toEqual({
      nextQuery: {
        ...hiddenQuery,
        groupedAggregate: {
          ...hiddenQuery.groupedAggregate,
          aggregateStates: [
            {
              aggregateValue: 7,
              groupValue: 1,
              rowCount: 2,
            },
            {
              aggregateValue: 4,
              groupValue: 3,
              rowCount: 1,
              valueCounts: [{
                count: 1,
                value: 4,
              }],
            },
          ],
        },
      },
      patched: true,
      unchanged: true,
    })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 4,
            groupValue: 3,
            rowCount: 1,
          }],
          having: { operator: '>', value: 1 },
        },
      }),
      [],
      [createMutation('delete', {
        rows: [{ id: 3, score: 4, user_id: 3 }],
      })],
    )).toEqual({
      nextQuery: createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [],
          having: { operator: '>', value: 1 },
        },
      }),
      patched: true,
      unchanged: true,
    })
    expect(tryPatchGroupedAggregateQuery(
      visibleQuery,
      [{ best_score: 7, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, score: 5, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...visibleQuery,
        groupedAggregate: {
          ...visibleQuery.groupedAggregate,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 2,
          }],
        },
      },
      patched: true,
      unchanged: true,
    })
    expect(tryPatchGroupedAggregateQuery(
      visibleQuery,
      [{ best_score: 7, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 4, score: 9, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...visibleQuery,
        groupedAggregate: {
          ...visibleQuery.groupedAggregate,
          aggregateStates: [{
            aggregateValue: 9,
            groupValue: 1,
            rowCount: 4,
          }],
        },
      },
      patched: true,
      query: visibleQuery,
      value: [{ best_score: 9, user_id: 1 }],
    })
  })

  it('patches retained grouped extremes to runner-up values without backfilling', () => {
    const maxQuery = createQuery({
      groupedAggregate: {
        ...groupedMax,
        aggregateStates: [{
          aggregateValue: 7,
          groupValue: 1,
          rowCount: 3,
          valueCounts: [
            { count: 1, value: 5 },
            { count: 1, value: 6 },
            { count: 1, value: 7 },
          ],
        }],
        having: { operator: '>', value: 1 },
      },
    })
    const minQuery = createQuery({
      groupedAggregate: {
        ...groupedMin,
        aggregateStates: [{
          aggregateValue: 5,
          groupValue: 1,
          rowCount: 3,
          valueCounts: [
            { count: 1, value: 5 },
            { count: 1, value: 6 },
            { count: 1, value: 7 },
          ],
        }],
        having: { operator: '>', value: 1 },
      },
    })

    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 7, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 3, score: 7, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...maxQuery,
        groupedAggregate: {
          ...maxQuery.groupedAggregate,
          aggregateStates: [{
            aggregateValue: 6,
            groupValue: 1,
            rowCount: 2,
            valueCounts: [
              { count: 1, value: 5 },
              { count: 1, value: 6 },
            ],
          }],
        },
      },
      patched: true,
      query: maxQuery,
      value: [{ best_score: 6, user_id: 1 }],
    })
    expect(tryPatchGroupedAggregateQuery(
      minQuery,
      [{ lowest_score: 5, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, score: 5, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...minQuery,
        groupedAggregate: {
          ...minQuery.groupedAggregate,
          aggregateStates: [{
            aggregateValue: 6,
            groupValue: 1,
            rowCount: 2,
            valueCounts: [
              { count: 1, value: 6 },
              { count: 1, value: 7 },
            ],
          }],
        },
      },
      patched: true,
      query: minQuery,
      value: [{ lowest_score: 6, user_id: 1 }],
    })
    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 7, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 3, score: 7, user_id: 1 }],
        rows: [{ id: 3, score: 4, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...maxQuery,
        groupedAggregate: {
          ...maxQuery.groupedAggregate,
          aggregateStates: [{
            aggregateValue: 6,
            groupValue: 1,
            rowCount: 3,
            valueCounts: [
              { count: 1, value: 4 },
              { count: 1, value: 5 },
              { count: 1, value: 6 },
            ],
          }],
        },
      },
      patched: true,
      query: maxQuery,
      value: [{ best_score: 6, user_id: 1 }],
    })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 3,
            valueCounts: [
              { count: 1, value: 5 },
              { count: 2, value: 7 },
            ],
          }],
          having: { operator: '>', value: 1 },
        },
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 3, score: 7, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 2,
            valueCounts: [
              { count: 1, value: 5 },
              { count: 1, value: 7 },
            ],
          }],
          having: { operator: '>', value: 1 },
        },
      }),
      patched: true,
      unchanged: true,
    })
  })

  it('patches retained grouped extreme predicate updates and group moves', () => {
    const predicateQuery = createQuery({
      groupedAggregate: {
        ...groupedMax,
        aggregateStates: [{
          aggregateValue: 7,
          groupValue: 1,
          rowCount: 2,
        }],
        having: { operator: '>', value: 1 },
      },
      predicates: [{ column: 'active', operator: '=', value: true }],
    })
    const moveQuery = createQuery({
      groupedAggregate: {
        ...groupedMax,
        aggregateStates: [
          {
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 2,
          },
          {
            aggregateValue: 4,
            groupValue: 2,
            rowCount: 1,
          },
        ],
        having: { operator: '>', value: 1 },
      },
      orderBy: [{ column: 'user_id', direction: 'asc' }],
    })

    expect(tryPatchGroupedAggregateQuery(
      predicateQuery,
      [{ best_score: 7, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ active: false, id: 3, score: 9, user_id: 1 }],
        rows: [{ active: true, id: 3, score: 9, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...predicateQuery,
        groupedAggregate: {
          ...predicateQuery.groupedAggregate,
          aggregateStates: [{
            aggregateValue: 9,
            groupValue: 1,
            rowCount: 3,
          }],
        },
      },
      patched: true,
      query: predicateQuery,
      value: [{ best_score: 9, user_id: 1 }],
    })
    expect(tryPatchGroupedAggregateQuery(
      predicateQuery,
      [{ best_score: 7, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ active: false, id: 3, score: 9, user_id: 1 }],
        rows: [{ active: false, id: 3, score: 9, user_id: 1 }],
      })],
    )).toEqual({
      patched: true,
      unchanged: true,
    })
    expect(tryPatchGroupedAggregateQuery(
      predicateQuery,
      [{ best_score: 7, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ active: true, id: 1, score: 5, user_id: 1 }],
        rows: [{ active: false, id: 1, score: 5, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...predicateQuery,
        groupedAggregate: {
          ...predicateQuery.groupedAggregate,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 1,
          }],
        },
      },
      patched: true,
      query: predicateQuery,
      value: [],
    })
    expect(tryPatchGroupedAggregateQuery(
      moveQuery,
      [{ best_score: 7, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 5, user_id: 1 }],
        rows: [{ id: 1, score: 9, user_id: 2 }],
      })],
    )).toEqual({
      nextQuery: {
        ...moveQuery,
        groupedAggregate: {
          ...moveQuery.groupedAggregate,
          aggregateStates: [
            {
              aggregateValue: 7,
              groupValue: 1,
              rowCount: 1,
            },
            {
              aggregateValue: 9,
              groupValue: 2,
              rowCount: 2,
            },
          ],
        },
      },
      patched: true,
      query: moveQuery,
      value: [{ best_score: 9, user_id: 2 }],
    })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [
            {
              aggregateValue: 7,
              groupValue: 1,
              rowCount: 3,
            },
            {
              aggregateValue: 4,
              groupValue: 2,
              rowCount: 1,
            },
          ],
          having: { operator: '>', value: 1 },
        },
        orderBy: [{ column: 'user_id', direction: 'asc' }],
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 5, user_id: 1 }],
        rows: [{ id: 1, score: 9, user_id: 2 }],
      })],
    )).toEqual({
      nextQuery: createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [
            {
              aggregateValue: 7,
              groupValue: 1,
              rowCount: 2,
            },
            {
              aggregateValue: 9,
              groupValue: 2,
              rowCount: 2,
            },
          ],
          having: { operator: '>', value: 1 },
        },
        orderBy: [{ column: 'user_id', direction: 'asc' }],
      }),
      patched: true,
      query: createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [
            {
              aggregateValue: 7,
              groupValue: 1,
              rowCount: 3,
            },
            {
              aggregateValue: 4,
              groupValue: 2,
              rowCount: 1,
            },
          ],
          having: { operator: '>', value: 1 },
        },
        orderBy: [{ column: 'user_id', direction: 'asc' }],
      }),
      value: [
        { best_score: 7, user_id: 1 },
        { best_score: 9, user_id: 2 },
      ],
    })
  })

  it('falls back for unsafe grouped extreme retained state changes', async () => {
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          aggregateColumn: 'score',
          aggregateResultKey: 'median_score',
          groupColumn: 'user_id',
          groupResultKey: 'user_id',
          kind: 'median' as DatabaseQueryGroupedAggregateObservation['kind'],
        },
      }),
      [],
      [createMutation('insert', {
        rows: [{ id: 1, score: 5, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(await tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          aggregateColumn: 'score',
          aggregateResultKey: 'median_score',
          groupColumn: 'user_id',
          groupResultKey: 'user_id',
          kind: 'median' as DatabaseQueryGroupedAggregateObservation['kind'],
        },
      }),
      [],
      [createMutation('insert', {
        rows: [{ id: 1, score: 5, user_id: 1 }],
      })],
      createBackfills(),
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedMaxHavingWithStates,
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('insert')],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedMaxHavingWithStates,
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('delete')],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedMaxHavingWithStates,
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 2, score: 7, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedMaxHavingWithStates,
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 2, score: 7, user_id: 1 }],
        rows: [{ id: 2, score: 6, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedMaxHavingWithStates,
        orderBy: [{ column: 'score', direction: 'asc' }],
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 4, score: 6, user_id: 2 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 2,
          }],
          having: { operator: '>', value: 1 },
        },
      }),
      [
        { best_score: 7, user_id: 1 },
        { best_score: 11, user_id: 2 },
      ],
      [createMutation('insert', {
        rows: [{ id: 4, score: 6, user_id: 2 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 2,
          }],
          having: { operator: '>', value: 1 },
        },
      }),
      [],
      [createMutation('insert', {
        rows: [{ id: 4, score: 6, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 2,
          }],
          having: { operator: '>', value: 1 },
        },
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 2, score: 7, user_id: 2 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [],
          having: { operator: '>', value: 1 },
        },
      }),
      [],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 5, user_id: 1 }],
        rows: [{ id: 1, score: 6, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 2,
          }],
          having: { operator: '>', value: 1 },
        },
      }),
      [],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 5, user_id: 1 }],
        rows: [{ id: 1, score: 6, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [
            {
              aggregateValue: 7,
              groupValue: 1,
              rowCount: 2,
            },
            {
              aggregateValue: 4,
              groupValue: 2,
              rowCount: 1,
            },
          ],
          having: { operator: '>', value: 1 },
        },
      }),
      [],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 5, user_id: 1 }],
        rows: [{ id: 1, score: 9, user_id: 2 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [
            {
              aggregateValue: 7,
              groupValue: 1,
              rowCount: 2,
            },
            {
              aggregateValue: 4,
              groupValue: 2,
              rowCount: 1,
            },
          ],
          having: { operator: '>', value: 1 },
        },
      }),
      [
        { best_score: 7, user_id: 1 },
        { best_score: 4, user_id: 2 },
      ],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 5, user_id: 1 }],
        rows: [{ id: 1, score: 9, user_id: 2 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 3,
          }],
          having: { operator: '>', value: 1 },
        },
        orderBy: [{ column: 'score', direction: 'asc' }],
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 5, user_id: 1 }],
        rows: [{ id: 1, score: 9, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 2,
          }],
          having: { operator: '>', value: 1 },
        },
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 2,
          }],
          having: { operator: '>', value: 1 },
        },
        predicates: [{ column: 'active', operator: '=', value: true }],
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ active: false, id: 1, score: 5, user_id: 1 }],
      })],
    )).toEqual({
      patched: true,
      unchanged: true,
    })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 2,
          }],
          having: { operator: '>', value: 1 },
        },
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 1, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 2,
          }],
          having: { operator: '>', value: 1 },
        },
        predicates: [{ column: 'active', operator: '=', value: true }],
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ active: false, id: 1, score: 5, user_id: 1 }],
      })],
    )).toEqual({
      patched: true,
      unchanged: true,
    })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 2,
          }],
          having: { operator: '>', value: 1 },
        },
        orderBy: [{ column: 'score', direction: 'asc' }],
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, score: 5, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 2,
          }],
          having: { operator: '>', value: 1 },
        },
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('update', {
        previousRows: [],
        rows: [{ id: 1, score: 5, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 2,
          }],
          having: { operator: '>', value: 1 },
        },
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, user_id: 1 }],
        rows: [{ id: 1, score: 5, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 2,
          }],
          having: { operator: '>', value: 1 },
        },
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('update', {
        previousRows: Object.freeze([undefined]) as unknown as readonly Readonly<Record<string, unknown>>[],
        rows: [{ id: 1, score: 5, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 2,
            valueCounts: [{ count: -2, value: 7 }],
          }],
          having: { operator: '>', value: 1 },
        },
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 3, score: 7, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 2,
            valueCounts: [{ count: 1, value: 6 }],
          }],
          having: { operator: '>', value: 1 },
        },
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 2, score: 7, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 2,
            valueCounts: [{ count: 1, value: 6 }],
          }],
          having: { operator: '>', value: 1 },
        },
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 2, score: 7, user_id: 1 }],
        rows: [{ id: 2, score: 8, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 1,
            rowCount: 2,
            valueCounts: [{ count: 0, value: 7 }],
          }],
          having: { operator: '>', value: 1 },
        },
      }),
      [{ best_score: 7, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 3, score: 8, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
  })

  it('patches grouped average rows from hidden state without a backfill cache', () => {
    const query = createQuery({
      groupedAggregate: groupedAvgWithStates,
    })

    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ average_score: 6, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 3, score: 9, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...query,
        groupedAggregate: {
          ...groupedAvgWithStates,
          averageStates: [{
            count: 3,
            groupValue: 1,
            rowCount: 3,
            sum: 21,
          }],
        },
      },
      patched: true,
      query,
      value: [{ average_score: 7, user_id: 1 }],
    })
  })

  it('keeps grouped average rows silent while advancing hidden state', () => {
    const query = createQuery({
      groupedAggregate: groupedAvgWithStates,
    })

    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ average_score: 6, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 3, score: 6, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...query,
        groupedAggregate: {
          ...groupedAvgWithStates,
          averageStates: [{
            count: 3,
            groupValue: 1,
            rowCount: 3,
            sum: 18,
          }],
        },
      },
      patched: true,
      unchanged: true,
    })
  })

  it('patches new grouped average rows without having from mutation state', () => {
    const query = createQuery({
      groupedAggregate: groupedAvgWithStates,
      orderBy: [{ column: 'user_id', direction: 'asc' }],
    })

    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ average_score: 6, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 3, score: 8, user_id: 2 }],
      })],
    )).toEqual({
      nextQuery: {
        ...query,
        groupedAggregate: {
          ...groupedAvgWithStates,
          averageStates: [
            {
              count: 2,
              groupValue: 1,
              rowCount: 2,
              sum: 12,
            },
            {
              count: 1,
              groupValue: 2,
              rowCount: 1,
              sum: 8,
            },
          ],
        },
      },
      patched: true,
      query,
      value: [
        { average_score: 6, user_id: 1 },
        { average_score: 8, user_id: 2 },
      ],
    })
  })

  it('patches grouped average having visibility from retained hidden state', () => {
    const groupedAvgHaving = Object.freeze({
      ...groupedAvgWithStates,
      having: { operator: '>', value: 1 },
    } satisfies DatabaseQueryGroupedAggregateObservation)
    const query = createQuery({
      groupedAggregate: groupedAvgHaving,
    })

    const result = tryPatchGroupedAggregateQuery(
      query,
      [{ average_score: 6, user_id: 1 }],
      [
        createMutation('delete', {
          rows: [{ id: 2, score: 7, user_id: 1 }],
        }),
        createMutation('insert', {
          rows: [{ id: 3, score: 9, user_id: 1 }],
        }),
      ],
    )

    expect(result).toEqual({
      nextQuery: {
        ...query,
        groupedAggregate: {
          ...groupedAvgHaving,
          averageStates: [{
            count: 2,
            groupValue: 1,
            rowCount: 2,
            sum: 14,
          }],
        },
      },
      patched: true,
      query,
      value: [{ average_score: 7, user_id: 1 }],
    })
  })

  it('falls back or stays silent for unsafe grouped average state patches', () => {
    const query = createQuery({
      groupedAggregate: groupedAvgWithStates,
    })
    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ average_score: 6, user_id: 1 }],
      [createMutation('insert')],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ average_score: 6, user_id: 1 }],
      [createMutation('delete')],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ average_score: 6, user_id: 1 }],
      [createMutation('update', {
        rows: [{ id: 1, score: 6, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedAvgWithStates,
        predicates: [{ column: 'status', operator: '=', value: 'published' }],
      }),
      [{ average_score: 6, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 1, score: 6, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedAvgWithStates,
        predicates: [{ column: 'status', operator: '=', value: 'published' }],
      }),
      [{ average_score: 6, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 1, score: 6, status: 'draft', user_id: 1 }],
      })],
    )).toEqual({ patched: true, unchanged: true })
    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ average_score: 6, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 1, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedAvg,
          averageStates: [],
          having: { operator: '>', value: 1 },
        },
      }),
      [],
      [createMutation('insert', {
        rows: [{ id: 1, score: 6, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ average_score: 6, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 6, user_id: 1 }],
        rows: [{ id: 1, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ average_score: 6, user_id: 1 }],
      [createMutation('delete', {
        rows: [
          { id: 1, score: 6, user_id: 1 },
          { id: 2, score: 7, user_id: 1 },
          { id: 3, score: 8, user_id: 1 },
        ],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedAvgWithStates,
        orderBy: [{ column: 'score', direction: 'asc' }],
      }),
      [{ average_score: 6, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 3, score: 9, user_id: 1 }],
      })],
    )).toEqual({ patched: false })

    const hiddenHavingQuery = createQuery({
      groupedAggregate: {
        ...groupedAvg,
        averageStates: [{
          count: 2,
          groupValue: 1,
          rowCount: 2,
          sum: 12,
        }],
        having: { operator: '>', value: 1 },
      },
    })
    expect(tryPatchGroupedAggregateQuery(
      hiddenHavingQuery,
      [],
      [createMutation('delete', {
        rows: [{ id: 1, score: 6, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...hiddenHavingQuery,
        groupedAggregate: {
          ...hiddenHavingQuery.groupedAggregate,
          averageStates: [{
            count: 1,
            groupValue: 1,
            rowCount: 1,
            sum: 6,
          }],
        },
      },
      patched: true,
      unchanged: true,
    })

    const nullableAverageQuery = createQuery({
      groupedAggregate: {
        ...groupedAvg,
        averageStates: [{
          count: 1,
          groupValue: 1,
          rowCount: 2,
          sum: 5,
        }],
      },
    })
    expect(tryPatchGroupedAggregateQuery(
      nullableAverageQuery,
      [{ average_score: 5, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, score: 5, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...nullableAverageQuery,
        groupedAggregate: {
          ...nullableAverageQuery.groupedAggregate,
          averageStates: [{
            count: 0,
            groupValue: 1,
            rowCount: 1,
            sum: 0,
          }],
        },
      },
      patched: true,
      query: nullableAverageQuery,
      value: [{ average_score: null, user_id: 1 }],
    })

    const singleRowAverageQuery = createQuery({
      groupedAggregate: {
        ...groupedAvg,
        averageStates: [{
          count: 1,
          groupValue: 1,
          rowCount: 1,
          sum: 5,
        }],
      },
    })
    expect(tryPatchGroupedAggregateQuery(
      singleRowAverageQuery,
      [{ average_score: 5, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, score: 5, user_id: 1 }],
      })],
    )).toEqual({
      nextQuery: {
        ...singleRowAverageQuery,
        groupedAggregate: {
          ...singleRowAverageQuery.groupedAggregate,
          averageStates: [],
        },
      },
      patched: true,
      query: singleRowAverageQuery,
      value: [],
    })
  })

  it('patches grouped max inserts and safe updates', () => {
    const query = createQuery({
      groupedAggregate: groupedMax,
      orderBy: [{ column: 'user_id', direction: 'asc' }],
    })
    const result = tryPatchGroupedAggregateQuery(
      query,
      [{ best_score: 10, user_id: 1 }],
      [
        createMutation('insert', {
          rows: [
            { id: 2, score: 12, user_id: 1 },
            { id: 3, score: 7, user_id: 2 },
          ],
        }),
        createMutation('update', {
          previousRows: [{ id: 4, score: 8, user_id: 1 }],
          rows: [{ id: 4, score: 13, user_id: 1 }],
        }),
      ],
    )

    expect(result).toEqual({
      patched: true,
      query,
      value: [
        { best_score: 13, user_id: 1 },
        { best_score: 7, user_id: 2 },
      ],
    })
  })

  it('patches grouped min inserts and safe updates', () => {
    const query = createQuery({
      groupedAggregate: groupedMin,
      orderBy: [{ column: 'user_id', direction: 'asc' }],
    })
    const result = tryPatchGroupedAggregateQuery(
      query,
      [{ lowest_score: 10, user_id: 1 }],
      [
        createMutation('insert', {
          rows: [
            { id: 2, score: 8, user_id: 1 },
            { id: 3, score: 7, user_id: 2 },
          ],
        }),
        createMutation('update', {
          previousRows: [{ id: 4, score: 12, user_id: 1 }],
          rows: [{ id: 4, score: 6, user_id: 1 }],
        }),
      ],
    )

    expect(result).toEqual({
      patched: true,
      query,
      value: [
        { lowest_score: 6, user_id: 1 },
        { lowest_score: 7, user_id: 2 },
      ],
    })
  })

  it('keeps unchanged grouped aggregate updates silent', () => {
    const countQuery = createQuery()
    const sumQuery = createQuery({
      groupedAggregate: groupedSum,
      predicates: [{ column: 'published', operator: '=', value: true }],
    })

    expect(tryPatchGroupedAggregateQuery(
      countQuery,
      [{ total: 2, user_id: 1 }],
      [],
    )).toEqual({ patched: true, unchanged: true })
    expect(tryPatchGroupedAggregateQuery(
      countQuery,
      [{ total: 2, user_id: 1 }],
      [
        createMutation('upsert', {
          previousRows: [{ id: 1, user_id: 1 }],
          rows: [{ id: 1, user_id: 1 }],
        }),
      ],
    )).toEqual({ patched: true, unchanged: true })
    expect(tryPatchGroupedAggregateQuery(
      sumQuery,
      [{ score_total: 2, user_id: 1 }],
      [
        createMutation('upsert', {
          previousRows: [{ id: 1, published: true, score: 2, user_id: 1 }],
          rows: [{ id: 1, published: true, score: 2, user_id: 1 }],
        }),
      ],
    )).toEqual({ patched: true, unchanged: true })
    expect(tryPatchGroupedAggregateQuery(
      sumQuery,
      [{ score_total: 2, user_id: 1 }],
      [
        createMutation('update', {
          previousRows: [{ id: 1, published: false, score: 2, user_id: 1 }],
          rows: [{ id: 1, published: false, score: 4, user_id: 1 }],
        }),
      ],
    )).toEqual({ patched: true, unchanged: true })
  })

  it('sorts grouped aggregate rows by string and date group values', () => {
    const stringQuery = createQuery({
      groupedAggregate: {
        aggregateResultKey: 'total',
        groupColumn: 'category',
        groupResultKey: 'category',
        kind: 'count',
      },
      orderBy: [{ column: 'category', direction: 'desc' }],
    })
    const dateQuery = createQuery({
      groupedAggregate: {
        aggregateResultKey: 'total',
        groupColumn: 'day',
        groupResultKey: 'day',
        kind: 'count',
      },
      orderBy: [{ column: 'day', direction: 'asc' }],
    })
    const earlier = new Date('2026-01-01T00:00:00.000Z')
    const later = new Date('2026-01-02T00:00:00.000Z')

    expect(tryPatchGroupedAggregateQuery(
      stringQuery,
      [{ category: 'b', total: 1 }],
      [createMutation('insert', { rows: [{ category: 'a', id: 2 }] })],
    )).toEqual({
      patched: true,
      query: stringQuery,
      value: [
        { category: 'b', total: 1 },
        { category: 'a', total: 1 },
      ],
    })
    expect(tryPatchGroupedAggregateQuery(
      dateQuery,
      [{ day: later, total: 1 }],
      [createMutation('insert', { rows: [{ day: earlier, id: 2 }] })],
    )).toEqual({
      patched: true,
      query: dateQuery,
      value: [
        { day: earlier, total: 1 },
        { day: later, total: 1 },
      ],
    })
  })

  it('falls back when grouped aggregate metadata or mutation rows are incomplete', () => {
    const query = createQuery()

    expect(tryPatchGroupedAggregateQuery(
      createQuery({ groupedAggregate: undefined }),
      [{ total: 1, user_id: 1 }],
      [createMutation('insert', { rows: [{ id: 2, user_id: 1 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ total: 1, user_id: 1 }],
      [createMutation('insert')],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ total: 1, user_id: 1 }],
      [createMutation('delete')],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ total: 1, user_id: 1 }],
      [createMutation('update', { rows: [{ id: 1, user_id: 1 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ total: 1, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, user_id: 1 }],
        rows: [
          { id: 1, user_id: 1 },
          { id: 2, user_id: 1 },
        ],
      })],
    )).toEqual({ patched: false })
  })

  it('falls back when grouped count rows cannot prove a safe patch', () => {
    const query = createQuery({
      orderBy: [{ column: 'created_at', direction: 'asc' }],
    })

    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        predicates: [{ column: 'active', operator: '>', value: true }],
      }),
      [{ total: 1, user_id: 1 }],
      [createMutation('insert', { rows: [{ active: 'yes', id: 2, user_id: 1 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery(),
      [{ total: 1, user_id: 1 }],
      [createMutation('insert', { rows: [{ id: 2 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery(),
      [{ total: '1', user_id: 1 }],
      [createMutation('insert', { rows: [{ id: 2, user_id: 1 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery(),
      [{ total: 1, user_id: 1 }],
      [createMutation('delete', { rows: [{ id: 2, user_id: 2 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery(),
      [{ total: 1, user_id: 1 }],
      [createMutation('delete', {
        rows: [
          { id: 1, user_id: 1 },
          { id: 2, user_id: 1 },
        ],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery(),
      [{ total: 1, user_id: 1 }],
      [createMutation('upsert', {
        previousRows: [{ id: 1, user_id: 1 }],
        rows: [{ id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ total: 1, user_id: 1 }],
      [createMutation('insert', { rows: [{ id: 2, user_id: 2 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        orderBy: [{ column: 'user_id', direction: 'asc' }],
      }),
      [{ total: 1, user_id: { id: 1 } }],
      [createMutation('insert', { rows: [{ id: 2, user_id: { id: 2 } }] })],
    )).toEqual({ patched: false })
  })

  it('falls back when grouped sum rows cannot prove a safe patch', () => {
    const query = createQuery({ groupedAggregate: groupedSum })

    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedSum,
        predicates: [{ column: 'published', operator: '=', value: true }],
      }),
      [{ score_total: 1, user_id: 1 }],
      [createMutation('insert', { rows: [{ id: 2, published: false, score: 2, user_id: 1 }] })],
    )).toEqual({ patched: true, unchanged: true })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedSum,
        predicates: [{ column: 'published', operator: '>', value: true }],
      }),
      [{ score_total: 1, user_id: 1 }],
      [createMutation('insert', { rows: [{ id: 2, published: 'yes', score: 2, user_id: 1 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ score_total: 1, user_id: 1 }],
      [createMutation('insert')],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ score_total: 1, user_id: 1 }],
      [createMutation('delete', { rows: [{ id: 1, score: 1, user_id: 1 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ score_total: 1, user_id: 1 }],
      [createMutation('update', { rows: [{ id: 1, score: 1, user_id: 1 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ score_total: 1, user_id: 1 }],
      [createMutation('update', {
        previousRows: [undefined as unknown as Readonly<Record<string, unknown>>],
        rows: [{ id: 1, score: 1, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedSum,
        predicates: [{ column: 'published', operator: '=', value: true }],
      }),
      [{ score_total: 1, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, published: false, score: 1, user_id: 1 }],
        rows: [{ id: 1, published: true, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ score_total: 1, user_id: 1 }],
      [createMutation('insert', { rows: [{ id: 2, score: null, user_id: 1 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          aggregateResultKey: 'score_total',
          groupColumn: 'user_id',
          groupResultKey: 'user_id',
          kind: 'sum',
        },
      }),
      [{ score_total: 1, user_id: 1 }],
      [createMutation('insert', { rows: [{ id: 2, score: 2, user_id: 1 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedSum,
        predicates: [{ column: 'published', operator: '>', value: true }],
      }),
      [{ score_total: 1, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, published: 'yes', score: 1, user_id: 1 }],
        rows: [{ id: 1, published: true, score: 2, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ score_total: 1, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 1, user_id: 1 }],
        rows: [{ id: 1, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      query,
      [{ score_total: 1, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 1, user_id: 1 }],
        rows: [{ id: 1, score: 1, user_id: 2 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedSum,
        predicates: [{ column: 'published', operator: '=', value: true }],
      }),
      [{ score_total: 1, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, published: true, score: 1, user_id: 1 }],
        rows: [{ id: 1, published: false, score: 1, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
  })

  it('falls back when grouped extremes cannot prove a safe patch', () => {
    const maxQuery = createQuery({ groupedAggregate: groupedMax })
    const minQuery = createQuery({ groupedAggregate: groupedMin })

    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('insert')],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete')],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete', { rows: [{ id: 1, score: 10, user_id: 1 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      minQuery,
      [{ lowest_score: 3, user_id: 1 }],
      [createMutation('delete', { rows: [{ id: 1, score: 3, user_id: 1 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete', { rows: [{ id: 2, score: 8, user_id: 2 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: '10', user_id: 1 }],
      [createMutation('delete', { rows: [{ id: 2, score: 8, user_id: 1 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('update', { rows: [{ id: 1, score: 12, user_id: 1 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('update', {
        previousRows: [undefined as unknown as Readonly<Record<string, unknown>>],
        rows: [{ id: 1, score: 12, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 'high', user_id: 1 }],
        rows: [{ id: 1, score: 12, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 10, user_id: 2 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 8, user_id: 1 }],
        rows: [{ id: 1, score: 12, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 10, user_id: 1 }],
        rows: [{ id: 1, score: 8, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      minQuery,
      [{ lowest_score: 3, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 3, user_id: 1 }],
        rows: [{ id: 1, score: 5, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 10, user_id: 1 }],
        rows: [{ id: 1, score: 12, user_id: 2 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedMax,
        predicates: [{ column: 'active', operator: '=', value: true }],
      }),
      [{ best_score: 10, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ active: true, id: 1, score: 10, user_id: 1 }],
        rows: [{ active: false, id: 1, score: 10, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('insert', { rows: [{ id: 2, score: 'high', user_id: 1 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete', { rows: [{ id: 2, score: 'high', user_id: 1 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedMax,
        predicates: [{ column: 'active', operator: '>', value: true }],
      }),
      [{ best_score: 10, user_id: 1 }],
      [createMutation('insert', { rows: [{ active: 'yes', id: 2, score: 12, user_id: 1 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedMax,
        orderBy: [{ column: 'created_at', direction: 'asc' }],
      }),
      [{ best_score: 10, user_id: 1 }],
      [createMutation('insert', { rows: [{ id: 2, score: 12, user_id: 2 }] })],
    )).toEqual({ patched: false })
  })

  it('keeps safe grouped extreme mutations silent', () => {
    const maxQuery = createQuery({ groupedAggregate: groupedMax })
    const minQuery = createQuery({ groupedAggregate: groupedMin })

    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('insert', { rows: [{ id: 2, score: 8, user_id: 1 }] })],
    )).toEqual({ patched: true, unchanged: true })
    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete', { rows: [{ id: 2, score: 8, user_id: 1 }] })],
    )).toEqual({ patched: true, unchanged: true })
    expect(tryPatchGroupedAggregateQuery(
      minQuery,
      [{ lowest_score: 3, user_id: 1 }],
      [createMutation('insert', { rows: [{ id: 2, score: 8, user_id: 1 }] })],
    )).toEqual({ patched: true, unchanged: true })
    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 10, user_id: 1 }],
        rows: [{ id: 1, score: 10, user_id: 1 }],
      })],
    )).toEqual({ patched: true, unchanged: true })
    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 10, user_id: 1 }],
        rows: [{ id: 1, score: 12, user_id: 1 }],
      })],
    )).toEqual({
      patched: true,
      query: maxQuery,
      value: [{ best_score: 12, user_id: 1 }],
    })
    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 6, user_id: 1 }],
        rows: [{ id: 1, score: 8, user_id: 1 }],
      })],
    )).toEqual({ patched: true, unchanged: true })
    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 6, user_id: 1 }],
        rows: [{ id: 1, score: 12, user_id: 2 }],
      })],
    )).toEqual({
      patched: true,
      query: maxQuery,
      value: [
        { best_score: 10, user_id: 1 },
        { best_score: 12, user_id: 2 },
      ],
    })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedMax,
        predicates: [{ column: 'active', operator: '=', value: true }],
      }),
      [{ best_score: 10, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ active: true, id: 1, score: 6, user_id: 1 }],
        rows: [{ active: false, id: 1, score: 8, user_id: 1 }],
      })],
    )).toEqual({ patched: true, unchanged: true })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedMax,
        predicates: [{ column: 'active', operator: '=', value: true }],
      }),
      [{ best_score: 10, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ active: false, id: 1, score: 6, user_id: 1 }],
        rows: [{ active: true, id: 1, score: 12, user_id: 1 }],
      })],
    )).toEqual({
      patched: true,
      query: createQuery({
        groupedAggregate: groupedMax,
        predicates: [{ column: 'active', operator: '=', value: true }],
      }),
      value: [{ best_score: 12, user_id: 1 }],
    })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedMax,
        predicates: [{ column: 'active', operator: '=', value: true }],
      }),
      [{ best_score: 10, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ active: false, id: 1, score: 6, user_id: 1 }],
        rows: [{ active: false, id: 1, score: 8, user_id: 1 }],
      })],
    )).toEqual({ patched: true, unchanged: true })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedMax,
        predicates: [{ column: 'active', operator: '=', value: true }],
      }),
      [{ best_score: 10, user_id: 1 }],
      [createMutation('insert', { rows: [{ active: false, id: 2, score: 12, user_id: 1 }] })],
    )).toEqual({ patched: true, unchanged: true })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: groupedMax,
        predicates: [{ column: 'active', operator: '=', value: true }],
      }),
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete', { rows: [{ active: false, id: 2, score: 12, user_id: 1 }] })],
    )).toEqual({ patched: true, unchanged: true })
    expect(tryPatchGroupedAggregateQuery(
      maxQuery,
      [{ best_score: '10', user_id: 1 }],
      [createMutation('insert', { rows: [{ id: 2, score: 12, user_id: 1 }] })],
    )).toEqual({ patched: false })
    expect(tryPatchGroupedAggregateQuery(
      createQuery({
        groupedAggregate: {
          ...groupedMin,
          having: { operator: '>', value: 1 },
        },
      }),
      [],
      [createMutation('insert', {
        rows: [{ id: 1, score: 3, user_id: 1 }],
      })],
    )).toEqual({ patched: false })
  })

  it('backfills grouped extreme rows through the bound database without the optional cache', async () => {
    const database = createFakeDatabase(() => [
      { __holo_grouped_aggregate_value: '10', user_id: 1 },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const query = createQuery({
      groupedAggregate: groupedMax,
    })

    await expect(backfillGroupedAggregateRows(
      query,
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, score: 10, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({ patched: true, unchanged: true })
    expect(database.queries).toHaveLength(1)
    expect(database.queries[0]?.sql).toContain('MAX("score")')
    expect(database.queries[0]?.bindings).toEqual([1])
  })

  it('dispatches grouped aggregate fallback patches through the bound database', async () => {
    const database = createFakeDatabase(({ sql }) => {
      if (sql.includes('AVG("score")')) {
        return [{ __holo_grouped_aggregate_value: 8, user_id: 1 }]
      }

      if (sql.includes('MIN("score")')) {
        return [{ __holo_grouped_aggregate_value: 3, user_id: 1 }]
      }

      if (sql.includes('SUM("score")')) {
        return [{ __holo_grouped_aggregate_value: 12, user_id: 1 }]
      }

      return [{ __holo_grouped_aggregate_value: 3, user_id: 1 }]
    })
    configureRealtimeRuntime({
      db: () => database.connection,
    })

    const averageQuery = createQuery({
      groupedAggregate: groupedAvg,
    })
    await expect(tryPatchGroupedAggregateQuery(
      averageQuery,
      [],
      [createMutation('insert', {
        rows: [{ id: 1, score: 8, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query: averageQuery,
      value: [{ average_score: 8, user_id: 1 }],
    })

    const minimumHavingQuery = createQuery({
      groupedAggregate: {
        ...groupedMin,
        having: { operator: '>', value: 1 },
      },
    })
    await expect(tryPatchGroupedAggregateQuery(
      minimumHavingQuery,
      [],
      [createMutation('insert', {
        rows: [{ id: 1, score: 3, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query: minimumHavingQuery,
      value: [{ lowest_score: 3, user_id: 1 }],
    })

    const sumQuery = createQuery({
      groupedAggregate: groupedSum,
    })
    await expect(tryPatchGroupedAggregateQuery(
      sumQuery,
      [{ score_total: 10, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 2, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query: sumQuery,
      value: [{ score_total: 12, user_id: 1 }],
    })

    const countStateQuery = createQuery({
      groupedAggregate: groupedCountHavingWithStates,
    })
    await expect(tryPatchGroupedAggregateQuery(
      countStateQuery,
      [],
      [createMutation('insert', {
        rows: [{ id: 3, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query: countStateQuery,
      value: [{ total: 3, user_id: 1 }],
    })
  })

  it('keeps grouped extreme backfills unchanged when no mutation rows match predicates', async () => {
    const query = createQuery({
      groupedAggregate: groupedMax,
      predicates: [{ column: 'active', operator: '=', value: true }],
    })

    await expect(backfillGroupedAggregateRows(
      query,
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ active: false, id: 1, score: 10, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({ patched: true, unchanged: true })
  })

  it('falls back from grouped extreme backfills when mutation rows are incomplete', async () => {
    const query = createQuery({
      groupedAggregate: groupedMax,
    })

    await expect(backfillGroupedAggregateRows(
      query,
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('insert')],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
    await expect(backfillGroupedAggregateRows(
      query,
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete')],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
    await expect(backfillGroupedAggregateRows(
      query,
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('update', {
        rows: [{ id: 1, score: 10, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
    await expect(backfillGroupedAggregateRows(
      query,
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('update', {
        previousRows: [
          { id: 1, score: 10, user_id: 1 },
          { id: 2, score: 11, user_id: 2 },
        ],
        rows: [{ id: 1, score: 8, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
    await expect(backfillGroupedAggregateRows(
      createQuery({
        groupedAggregate: groupedMax,
        predicates: [{ column: 'active', operator: '=', value: true }],
      }),
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 10, user_id: 1 }],
        rows: [{ active: true, id: 1, score: 8, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
  })

  it('falls back from grouped aggregate backfills when no database binding is available', async () => {
    await expect(backfillGroupedAggregateRows(
      createQuery({ groupedAggregate: groupedMax }),
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, score: 10, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
  })

  it('adds and removes grouped extreme rows from scoped SQL backfills', async () => {
    const addDatabase = createFakeDatabase(() => [
      { __holo_grouped_aggregate_value: 12, user_id: 2 },
    ])
    configureRealtimeRuntime({
      db: () => addDatabase.connection,
    })
    await expect(backfillGroupedAggregateRows(
      createQuery({
        groupedAggregate: groupedMax,
        orderBy: [{ column: 'user_id', direction: 'desc' }],
      }),
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 2, score: 12, user_id: 2 }],
      })],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query: createQuery({
        groupedAggregate: groupedMax,
        orderBy: [{ column: 'user_id', direction: 'desc' }],
      }),
      value: [
        { best_score: 12, user_id: 2 },
        { best_score: 10, user_id: 1 },
      ],
    })

    resetRealtimeRuntime()
    const removeDatabase = createFakeDatabase(() => [])
    configureRealtimeRuntime({
      db: () => removeDatabase.connection,
    })
    const query = createQuery({
      groupedAggregate: groupedMax,
      predicates: [{ column: 'active', operator: '=', value: true }],
    })

    await expect(backfillGroupedAggregateRows(
      query,
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ active: true, id: 1, score: 10, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [],
        },
      },
      patched: true,
      query,
      value: [],
    })
  })

  it('backfills grouped minimum rows with predicates and null aggregate values', async () => {
    const database = createFakeDatabase(() => [
      { __holo_grouped_aggregate_value: null, user_id: 1 },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const query = createQuery({
      groupedAggregate: groupedMin,
      predicates: [{ column: 'active', operator: '=', value: true }],
    })

    await expect(backfillGroupedAggregateRows(
      query,
      groupedMin,
      [{ lowest_score: 3, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ active: true, id: 1, score: 3, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query,
      value: [{ lowest_score: null, user_id: 1 }],
    })
    expect(database.queries[0]?.sql).toContain('MIN("score")')
    expect(database.queries[0]?.bindings).toEqual([true, 1])
  })

  it('backfills grouped extreme updates while deduplicating repeated group values', async () => {
    const database = createFakeDatabase(() => [
      { __holo_grouped_aggregate_value: 9, user_id: 1 },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const query = createQuery({
      groupedAggregate: groupedMax,
    })

    await expect(backfillGroupedAggregateRows(
      query,
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('update', {
        previousRows: [{ id: 1, score: 10, user_id: 1 }],
        rows: [{ id: 1, score: 9, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query,
      value: [{ best_score: 9, user_id: 1 }],
    })
    expect(database.queries[0]?.bindings).toEqual([1])
  })

  it('rebuilds grouped extreme state from backfills so later runner-up deletes patch without another query', async () => {
    const database = createFakeDatabase(({ sql }) => {
      if (sql.includes('__holo_grouped_aggregate_value_count')) {
        return [
          { __holo_grouped_aggregate_value_count: 1, score: 8, user_id: 1 },
          { __holo_grouped_aggregate_value_count: 1, score: 9, user_id: 1 },
        ]
      }

      return [{
        __holo_grouped_aggregate_row_count: 2,
        __holo_grouped_aggregate_value: 9,
        user_id: 1,
      }]
    })
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const groupedMaxWithRetainedState = Object.freeze({
      ...groupedMax,
      aggregateStates: [{
        aggregateValue: 7,
        groupValue: 2,
        rowCount: 1,
        valueCounts: [{ count: 1, value: 7 }],
      }],
    } satisfies DatabaseQueryGroupedAggregateObservation)
    const query = createQuery({
      groupedAggregate: groupedMaxWithRetainedState,
    })

    const backfillResult = await backfillGroupedAggregateRows(
      query,
      groupedMaxWithRetainedState,
      [
        { best_score: 10, user_id: 1 },
        { best_score: 7, user_id: 2 },
      ],
      [createMutation('delete', {
        rows: [{ id: 1, score: 10, user_id: 1 }],
      })],
      createBackfills(),
    )

    expect(backfillResult).toEqual({
      nextQuery: {
        ...query,
        groupedAggregate: {
          ...groupedMaxWithRetainedState,
          aggregateStates: [
            {
              aggregateValue: 7,
              groupValue: 2,
              rowCount: 1,
              valueCounts: [{ count: 1, value: 7 }],
            },
            {
              aggregateValue: 9,
              groupValue: 1,
              rowCount: 2,
              valueCounts: [
                { count: 1, value: 8 },
                { count: 1, value: 9 },
              ],
            },
          ],
        },
      },
      patched: true,
      query,
      value: [
        { best_score: 9, user_id: 1 },
        { best_score: 7, user_id: 2 },
      ],
    })
    expect(database.queries).toHaveLength(2)

    if (!backfillResult.patched || !('value' in backfillResult) || !backfillResult.nextQuery) {
      throw new Error('expected grouped aggregate backfill to refresh patch state')
    }

    const patchResult = tryPatchGroupedAggregateQuery(
      backfillResult.nextQuery,
      backfillResult.value as readonly Readonly<Record<string, unknown>>[],
      [createMutation('delete', {
        rows: [{ id: 2, score: 9, user_id: 1 }],
      })],
    )

    expect(patchResult).toEqual({
      nextQuery: {
        ...query,
        groupedAggregate: {
          ...groupedMax,
          aggregateStates: [
            {
              aggregateValue: 7,
              groupValue: 2,
              rowCount: 1,
              valueCounts: [{ count: 1, value: 7 }],
            },
            {
              aggregateValue: 8,
              groupValue: 1,
              rowCount: 1,
              valueCounts: [{ count: 1, value: 8 }],
            },
          ],
        },
      },
      patched: true,
      query: backfillResult.nextQuery,
      value: [
        { best_score: 8, user_id: 1 },
        { best_score: 7, user_id: 2 },
      ],
    })
    expect(database.queries).toHaveLength(2)
  })

  it('reuses grouped extreme value-count backfill metadata while rebuilding state', async () => {
    let valueCountQueries = 0
    const database = createFakeDatabase(({ sql }) => {
      if (sql.includes('__holo_grouped_aggregate_value_count')) {
        valueCountQueries += 1
        return [
          { __holo_grouped_aggregate_value_count: 1, score: '8', user_id: 1 },
          { __holo_grouped_aggregate_value_count: 1, score: 9n, user_id: 1 },
        ]
      }

      return [{
        __holo_grouped_aggregate_row_count: '2',
        __holo_grouped_aggregate_value: '9',
        user_id: 1,
      }]
    })
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const query = createQuery({
      groupedAggregate: groupedMax,
    })
    const backfills = createBackfills({
      groupedAggregateValueCounts: new Map(),
      groupedAggregateValues: new Map(),
    })

    const firstResult = await backfillGroupedAggregateRows(
      query,
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, score: 10, user_id: 1 }],
      })],
      backfills,
    )
    const secondResult = await backfillGroupedAggregateRows(
      query,
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, score: 10, user_id: 1 }],
      })],
      backfills,
    )

    expect(firstResult).toEqual(secondResult)
    expect(valueCountQueries).toBe(1)
    expect(database.queries).toHaveLength(2)
  })

  it('keeps grouped extreme backfills patchable when value-count metadata cannot rebuild state', async () => {
    const database = createFakeDatabase(({ sql }) => {
      if (sql.includes('__holo_grouped_aggregate_value_count')) {
        return [{ __holo_grouped_aggregate_value_count: 1, score: null, user_id: 1 }]
      }

      return [{
        __holo_grouped_aggregate_row_count: 2,
        __holo_grouped_aggregate_value: 9,
        user_id: 1,
      }]
    })
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const query = createQuery({
      groupedAggregate: groupedMax,
      predicates: [{ column: 'active', operator: '=', value: true }],
    })

    await expect(backfillGroupedAggregateRows(
      query,
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ active: true, id: 1, score: 10, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query,
      value: [{ best_score: 9, user_id: 1 }],
    })
    expect(database.queries).toHaveLength(2)
  })

  it('keeps grouped extreme row backfills when value-count metadata has unsafe counts', async () => {
    const database = createFakeDatabase(({ sql }) => {
      if (sql.includes('__holo_grouped_aggregate_value_count')) {
        return [{ __holo_grouped_aggregate_value_count: 0, score: 9, user_id: 1 }]
      }

      return [{
        __holo_grouped_aggregate_row_count: 2,
        __holo_grouped_aggregate_value: 9,
        user_id: 1,
      }]
    })
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const query = createQuery({
      groupedAggregate: groupedMax,
    })

    await expect(backfillGroupedAggregateRows(
      query,
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, score: 10, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query,
      value: [{ best_score: 9, user_id: 1 }],
    })
    expect(database.queries).toHaveLength(2)
  })

  it('falls back from grouped extreme row backfills when aggregate row counts are unsafe', async () => {
    const database = createFakeDatabase(() => [{
      __holo_grouped_aggregate_row_count: -1,
      __holo_grouped_aggregate_value: 9,
      user_id: 1,
    }])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const query = createQuery({
      groupedAggregate: groupedMax,
    })

    await expect(backfillGroupedAggregateRows(
      query,
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, score: 10, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({
      patched: false,
    })
  })

  it('keeps grouped extreme row backfills when value-count metadata is unavailable after a cached aggregate read', async () => {
    const database = createFakeDatabase(() => [{
      __holo_grouped_aggregate_row_count: 2,
      __holo_grouped_aggregate_value: 9,
      user_id: 1,
    }])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const query = createQuery({
      groupedAggregate: groupedMax,
    })
    const backfills = createBackfills({
      groupedAggregateValues: new Map(),
    })

    await backfillGroupedAggregateRows(
      query,
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, score: 10, user_id: 1 }],
      })],
      backfills,
    )

    resetRealtimeRuntime()
    await expect(backfillGroupedAggregateRows(
      query,
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, score: 10, user_id: 1 }],
      })],
      backfills,
    )).resolves.toEqual({
      patched: true,
      query,
      value: [{ best_score: 9, user_id: 1 }],
    })
  })

  it('clears only affected grouped extreme retained state when a backfilled group disappears', async () => {
    const database = createFakeDatabase(() => [])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const groupedMaxWithStates = Object.freeze({
      ...groupedMax,
      aggregateStates: [
        {
          aggregateValue: 10,
          groupValue: 1,
          rowCount: 1,
          valueCounts: [{ count: 1, value: 10 }],
        },
        {
          aggregateValue: 7,
          groupValue: 2,
          rowCount: 1,
          valueCounts: [{ count: 1, value: 7 }],
        },
      ],
    } satisfies DatabaseQueryGroupedAggregateObservation)
    const query = createQuery({
      groupedAggregate: groupedMaxWithStates,
    })

    await expect(backfillGroupedAggregateRows(
      query,
      groupedMaxWithStates,
      [
        { best_score: 10, user_id: 1 },
        { best_score: 7, user_id: 2 },
      ],
      [createMutation('delete', {
        rows: [{ id: 1, score: 10, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        groupedAggregate: {
          ...groupedMaxWithStates,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 2,
            rowCount: 1,
            valueCounts: [{ count: 1, value: 7 }],
          }],
        },
      },
      patched: true,
      query,
      value: [{ best_score: 7, user_id: 2 }],
    })
    expect(database.queries).toHaveLength(1)
  })

  it('clears hidden grouped extreme retained state while leaving visible rows unchanged', async () => {
    const database = createFakeDatabase(() => [])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const groupedMaxWithStates = Object.freeze({
      ...groupedMax,
      aggregateStates: [
        {
          aggregateValue: 10,
          groupValue: 1,
          rowCount: 1,
          valueCounts: [{ count: 1, value: 10 }],
        },
        {
          aggregateValue: 7,
          groupValue: 2,
          rowCount: 1,
          valueCounts: [{ count: 1, value: 7 }],
        },
      ],
      having: { operator: '>', value: 1 },
    } satisfies DatabaseQueryGroupedAggregateObservation)
    const query = createQuery({
      groupedAggregate: groupedMaxWithStates,
    })
    const rows = [{ best_score: 7, user_id: 2 }]

    await expect(backfillGroupedAggregateRows(
      query,
      groupedMaxWithStates,
      rows,
      [createMutation('delete', {
        rows: [{ id: 1, score: 10, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        groupedAggregate: {
          ...groupedMaxWithStates,
          aggregateStates: [{
            aggregateValue: 7,
            groupValue: 2,
            rowCount: 1,
            valueCounts: [{ count: 1, value: 7 }],
          }],
        },
      },
      patched: true,
      unchanged: true,
    })
    expect(database.queries).toHaveLength(1)
  })

  it('falls back from grouped extreme backfills when aggregate metadata or SQL values are unsafe', async () => {
    const unsafeDatabase = createFakeDatabase(() => [])
    configureRealtimeRuntime({
      db: () => unsafeDatabase.connection,
    })
    const groupedMaxWithoutColumn = Object.freeze({
      aggregateResultKey: 'best_score',
      groupColumn: 'user_id',
      groupResultKey: 'user_id',
      kind: 'max',
    } satisfies DatabaseQueryGroupedAggregateObservation)
    const query = createQuery({
      groupedAggregate: groupedMaxWithoutColumn,
    })

    await expect(backfillGroupedAggregateRows(
      query,
      groupedMaxWithoutColumn,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, score: 10, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({ patched: false })

    const groupedMinWithoutColumn = Object.freeze({
      aggregateResultKey: 'lowest_score',
      groupColumn: 'user_id',
      groupResultKey: 'user_id',
      kind: 'min',
    } satisfies DatabaseQueryGroupedAggregateObservation)
    await expect(backfillGroupedAggregateRows(
      createQuery({
        groupedAggregate: groupedMinWithoutColumn,
      }),
      groupedMinWithoutColumn,
      [{ lowest_score: 10, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, score: 10, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({ patched: false })

    const groupedSumWithoutColumn = Object.freeze({
      aggregateResultKey: 'score_total',
      groupColumn: 'user_id',
      groupResultKey: 'user_id',
      kind: 'sum',
    } satisfies DatabaseQueryGroupedAggregateObservation)
    await expect(backfillGroupedAggregateRows(
      createQuery({
        groupedAggregate: groupedSumWithoutColumn,
      }),
      groupedSumWithoutColumn,
      [{ score_total: 10, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 2, score: 5, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({ patched: false })

    const groupedAvgWithoutColumn = Object.freeze({
      aggregateResultKey: 'average_score',
      groupColumn: 'user_id',
      groupResultKey: 'user_id',
      kind: 'avg',
    } satisfies DatabaseQueryGroupedAggregateObservation)
    await expect(backfillGroupedAggregateRows(
      createQuery({
        groupedAggregate: groupedAvgWithoutColumn,
      }),
      groupedAvgWithoutColumn,
      [{ average_score: 10, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 2, score: 5, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({ patched: false })

    const database = createFakeDatabase(({ bindings }) => {
      const statementBindings = bindings ?? []
      return [
        {
          __holo_grouped_aggregate_value: statementBindings[0] === 1
            ? 'not-a-number'
            : statementBindings[0] === 2
              ? ''
              : statementBindings[0] === 3
                ? Number.NaN
                : 9007199254740993n,
          user_id: statementBindings[0],
        },
      ]
    })
    configureRealtimeRuntime({
      db: () => database.connection,
    })

    await expect(backfillGroupedAggregateRows(
      createQuery({ groupedAggregate: groupedMax }),
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, score: 10, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
    await expect(backfillGroupedAggregateRows(
      createQuery({ groupedAggregate: groupedMax }),
      groupedMax,
      [{ best_score: 10, user_id: 2 }],
      [createMutation('delete', {
        rows: [{ id: 2, score: 10, user_id: 2 }],
      })],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
    await expect(backfillGroupedAggregateRows(
      createQuery({ groupedAggregate: groupedMax }),
      groupedMax,
      [{ best_score: 10, user_id: 3 }],
      [createMutation('delete', {
        rows: [{ id: 3, score: 10, user_id: 3 }],
      })],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
    await expect(backfillGroupedAggregateRows(
      createQuery({ groupedAggregate: groupedMax }),
      groupedMax,
      [{ best_score: 10, user_id: 4 }],
      [createMutation('delete', {
        rows: [{ id: 4, score: 10, user_id: 4 }],
      })],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
  })

  it('filters backfilled grouped count rows through having metadata', async () => {
    const database = createFakeDatabase(() => [
      { __holo_grouped_aggregate_value: 2, user_id: 2 },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const groupedCountHaving = Object.freeze({
      ...groupedCount,
      having: { operator: '>', value: 2 },
    } satisfies DatabaseQueryGroupedAggregateObservation)
    const query = createQuery({
      groupedAggregate: groupedCountHaving,
    })

    await expect(backfillGroupedAggregateRows(
      query,
      groupedCountHaving,
      [],
      [createMutation('insert', {
        rows: [{ id: 2, user_id: 2 }],
      })],
      createBackfills(),
    )).resolves.toEqual({ patched: true, unchanged: true })
    await expect(backfillGroupedAggregateRows(
      query,
      groupedCountHaving,
      [{ total: 3, user_id: 2 }],
      [createMutation('delete', {
        rows: [{ id: 3, user_id: 2 }],
      })],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query,
      value: [],
    })
    expect(database.queries[0]?.sql).toContain('COUNT(*)')
    expect(database.queries[1]?.sql).toContain('COUNT(*)')
  })

  it('backfills grouped sum rows through having metadata', async () => {
    const database = createFakeDatabase(() => [
      { __holo_grouped_aggregate_value: 17, user_id: 2 },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const groupedSumHaving = Object.freeze({
      ...groupedSum,
      having: { operator: '>', value: 1 },
    } satisfies DatabaseQueryGroupedAggregateObservation)
    const query = createQuery({
      groupedAggregate: groupedSumHaving,
      orderBy: [{ column: 'user_id', direction: 'asc' }],
    })

    await expect(backfillGroupedAggregateRows(
      query,
      groupedSumHaving,
      [{ score_total: 12, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 3, score: 6, user_id: 2 }],
      })],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query,
      value: [
        { score_total: 12, user_id: 1 },
        { score_total: 17, user_id: 2 },
      ],
    })
    expect(database.queries[0]?.sql).toContain('SUM("score")')
    expect(database.queries[0]?.sql).toContain('HAVING COUNT(*) > ?')
  })

  it('backfills grouped average rows through having metadata', async () => {
    const database = createFakeDatabase(() => [
      { __holo_grouped_aggregate_value: 8.5, user_id: 2 },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })
    const groupedAvgHaving = Object.freeze({
      ...groupedAvg,
      having: { operator: '>', value: 1 },
    } satisfies DatabaseQueryGroupedAggregateObservation)
    const query = createQuery({
      groupedAggregate: groupedAvgHaving,
      orderBy: [{ column: 'user_id', direction: 'asc' }],
    })

    await expect(backfillGroupedAggregateRows(
      query,
      groupedAvgHaving,
      [{ average_score: 6, user_id: 1 }],
      [createMutation('insert', {
        rows: [{ id: 3, score: 6, user_id: 2 }],
      })],
      createBackfills(),
    )).resolves.toEqual({
      patched: true,
      query,
      value: [
        { average_score: 6, user_id: 1 },
        { average_score: 8.5, user_id: 2 },
      ],
    })
    expect(database.queries[0]?.sql).toContain('AVG("score")')
    expect(database.queries[0]?.sql).toContain('HAVING COUNT(*) > ?')
  })

  it('falls back from grouped extreme backfills when result ordering cannot be preserved', async () => {
    const database = createFakeDatabase(() => [
      { __holo_grouped_aggregate_value: 7, user_id: 1 },
    ])
    configureRealtimeRuntime({
      db: () => database.connection,
    })

    await expect(backfillGroupedAggregateRows(
      createQuery({
        groupedAggregate: groupedMax,
        orderBy: [{ column: 'score', direction: 'asc' }],
      }),
      groupedMax,
      [{ best_score: 10, user_id: 1 }],
      [createMutation('delete', {
        rows: [{ id: 1, score: 10, user_id: 1 }],
      })],
      createBackfills(),
    )).resolves.toEqual({ patched: false })

    resetRealtimeRuntime()
    const firstGroup = Object.freeze({ id: 1 })
    const secondGroup = Object.freeze({ id: 2 })
    const objectGroupDatabase = createFakeDatabase(() => [
      { __holo_grouped_aggregate_value: 7, user_id: firstGroup },
      { __holo_grouped_aggregate_value: 8, user_id: secondGroup },
    ])
    configureRealtimeRuntime({
      db: () => objectGroupDatabase.connection,
    })

    await expect(backfillGroupedAggregateRows(
      createQuery({
        groupedAggregate: groupedMax,
        orderBy: [{ column: 'user_id', direction: 'asc' }],
      }),
      groupedMax,
      [
        { best_score: 10, user_id: firstGroup },
        { best_score: 11, user_id: secondGroup },
      ],
      [createMutation('delete', {
        rows: [
          { id: 1, score: 10, user_id: firstGroup },
          { id: 2, score: 11, user_id: secondGroup },
        ],
      })],
      createBackfills(),
    )).resolves.toEqual({ patched: false })
  })
})
