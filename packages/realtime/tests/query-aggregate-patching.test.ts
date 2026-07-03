import { describe, expect, it } from 'vitest'
import type { DatabaseMutationEvent } from '../src/runtime/dependencies'
import { createAggregateBackfillKey } from '../src/runtime/query-metadata'
import {
  selectAggregatePatchMode,
  tryPatchQueryAggregate,
} from '../src/runtime/query-aggregate-patching'
import type { AggregateBackfillEntry } from '../src/runtime/query-aggregate-common'
import type {
  AggregateBackfillResult,
  BackfillCache,
  DatabaseQueryObservation,
} from '../src/runtime/query-state'

function createQuery(overrides: Partial<DatabaseQueryObservation> = {}): DatabaseQueryObservation {
  return {
    aggregate: {
      column: 'views',
      kind: 'sum',
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

describe('@holo-js/realtime aggregate patching dispatcher', () => {
  it('selects aggregate patch modes from query metadata', () => {
    expect(selectAggregatePatchMode(createQuery({ aggregate: undefined }))).toBeUndefined()
    expect(selectAggregatePatchMode(createQuery({ limit: 1 }))).toBe('unpatchable')
    expect(selectAggregatePatchMode(createQuery({
      aggregate: { column: 'views', kind: 'avg' },
    }))).toBe('average')
    expect(selectAggregatePatchMode(createQuery({
      aggregate: { column: 'views', kind: 'min' },
    }))).toBe('extreme')
    expect(selectAggregatePatchMode(createQuery({
      aggregate: { column: 'views', kind: 'max' },
    }))).toBe('extreme')
    expect(selectAggregatePatchMode(createQuery())).toBe('simple')
  })

  it('rejects unpatchable, missing, and invalid simple aggregates', () => {
    const query = createQuery()

    expect(tryPatchQueryAggregate(
      query,
      1,
      [],
      createBackfills(query),
      'unpatchable',
    )).toEqual({ patched: false })

    expect(tryPatchQueryAggregate(
      createQuery({ aggregate: undefined }),
      1,
      [],
      createBackfills(query),
      'simple',
    )).toEqual({ patched: false })

    expect(tryPatchQueryAggregate(
      query,
      '1',
      [],
      createBackfills(query),
      'simple',
    )).toEqual({ patched: false })
  })

  it('patches numeric aggregates and falls back when deltas cannot be evaluated', async () => {
    const query = createQuery()
    const backfillResult = {
      nextAggregate: { column: 'views', kind: 'sum' },
      value: 9,
    } satisfies AggregateBackfillResult

    expect(tryPatchQueryAggregate(
      query,
      5,
      [
        createMutation({
          rows: [{ id: 1, status: 'open', views: 4 }],
        }),
      ],
      createBackfills(query),
      'simple',
    )).toEqual({
      patched: true,
      query,
      value: 9,
    })

    expect(tryPatchQueryAggregate(
      query,
      5,
      [
        createMutation({
          rows: [{ id: 1, status: 'closed', views: 4 }],
        }),
      ],
      createBackfills(query),
      'simple',
    )).toEqual({
      patched: true,
      unchanged: true,
    })

    await expect(tryPatchQueryAggregate(
      query,
      5,
      [
        createMutation({
          rows: [{ id: 1, status: 'open' }],
        }),
      ],
      createBackfills(query, backfillResult),
      'simple',
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        aggregate: backfillResult.nextAggregate,
      },
      patched: true,
      query,
      value: 9,
    })
  })

  it('keeps net-zero boolean count aggregate mutations unchanged', () => {
    const query = createQuery({
      aggregate: {
        count: 1,
        kind: 'count',
        output: 'boolean',
      },
    })

    expect(tryPatchQueryAggregate(
      query,
      true,
      [
        createMutation({
          kind: 'delete',
          rows: [{ id: 1, status: 'open', views: 4 }],
        }),
        createMutation({
          kind: 'insert',
          rows: [{ id: 2, status: 'open', views: 5 }],
        }),
      ],
      createBackfills(query),
      'simple',
    )).toEqual({ patched: true, unchanged: true })
  })

  it('routes average and extreme aggregate modes to their patchers', () => {
    const averageQuery = createQuery({
      aggregate: {
        column: 'views',
        count: 1,
        kind: 'avg',
        sum: 5,
      },
    })

    expect(tryPatchQueryAggregate(
      averageQuery,
      5,
      [
        createMutation({
          rows: [{ id: 2, status: 'open', views: 7 }],
        }),
      ],
      createBackfills(averageQuery),
      'average',
    )).toEqual({
      nextQuery: {
        ...averageQuery,
        aggregate: {
          column: 'views',
          count: 2,
          kind: 'avg',
          sum: 12,
        },
      },
      patched: true,
      query: averageQuery,
      value: 6,
    })

    const extremeQuery = createQuery({
      aggregate: {
        column: 'views',
        currentValueCount: 1,
        kind: 'min',
      },
    })

    expect(tryPatchQueryAggregate(
      extremeQuery,
      5,
      [
        createMutation({
          rows: [{ id: 2, status: 'open', views: 3 }],
        }),
      ],
      createBackfills(extremeQuery),
      'extreme',
    )).toEqual({
      nextQuery: {
        ...extremeQuery,
        aggregate: {
          column: 'views',
          currentValueCount: 1,
          kind: 'min',
        },
      },
      patched: true,
      query: extremeQuery,
      value: 3,
    })
  })

  it('falls back for invalid boolean count metadata', async () => {
    const query = createQuery({
      aggregate: {
        kind: 'count',
        output: 'boolean',
      },
    })
    const backfillResult = {
      nextAggregate: {
        count: 2,
        kind: 'count',
        output: 'boolean',
      },
      value: true,
    } satisfies AggregateBackfillResult

    await expect(tryPatchQueryAggregate(
      query,
      true,
      [],
      createBackfills(query, backfillResult),
      'simple',
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        aggregate: backfillResult.nextAggregate,
      },
      patched: true,
      unchanged: true,
    })
  })

  it('falls back or rejects unsafe boolean count deltas', async () => {
    const query = createQuery({
      aggregate: {
        count: 1,
        kind: 'count',
        output: 'boolean',
      },
    })
    const backfillResult = {
      nextAggregate: {
        count: 3,
        kind: 'count',
        output: 'boolean',
      },
      value: true,
    } satisfies AggregateBackfillResult

    await expect(tryPatchQueryAggregate(
      query,
      true,
      [
        createMutation({
          rows: [{ id: 1 }],
        }),
      ],
      createBackfills(query, backfillResult),
      'simple',
    )).resolves.toEqual({
      nextQuery: {
        ...query,
        aggregate: backfillResult.nextAggregate,
      },
      patched: true,
      unchanged: true,
    })

    expect(tryPatchQueryAggregate(
      query,
      true,
      [
        createMutation({
          kind: 'delete',
          rows: [
            { id: 1, status: 'open' },
            { id: 2, status: 'open' },
          ],
        }),
      ],
      createBackfills(query),
      'simple',
    )).toEqual({ patched: false })
  })

  it('updates boolean count metadata when truthiness does not change', () => {
    const query = createQuery({
      aggregate: {
        count: 1,
        kind: 'count',
        output: 'boolean',
      },
    })
    const nextAggregate = {
      count: 2,
      kind: 'count',
      output: 'boolean',
    } as const

    expect(tryPatchQueryAggregate(
      query,
      true,
      [
        createMutation({
          rows: [{ id: 1, status: 'open' }],
        }),
      ],
      createBackfills(query),
      'simple',
    )).toEqual({
      nextQuery: {
        ...query,
        aggregate: nextAggregate,
      },
      patched: true,
      unchanged: true,
    })
  })

  it('patches boolean count value changes', () => {
    const query = createQuery({
      aggregate: {
        count: 0,
        kind: 'count',
        output: 'boolean',
      },
    })
    const nextAggregate = {
      count: 1,
      kind: 'count',
      output: 'boolean',
    } as const

    expect(tryPatchQueryAggregate(
      query,
      false,
      [
        createMutation({
          rows: [{ id: 1, status: 'open' }],
        }),
      ],
      createBackfills(query),
      'simple',
    )).toEqual({
      nextQuery: {
        ...query,
        aggregate: nextAggregate,
      },
      patched: true,
      query,
      value: true,
    })
  })
})
