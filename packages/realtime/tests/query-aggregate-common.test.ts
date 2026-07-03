import { describe, expect, it } from 'vitest'
import type { DatabaseMutationEvent } from '../src/runtime/dependencies'
import {
  aggregateMutationCannotChangeValue,
  canPatchAggregateQuery,
  createCountAggregateObservation,
  formatCountAggregateValue,
  readAggregateMutationDelta,
} from '../src/runtime/query-aggregate-common'
import type { DatabaseQueryObservation } from '../src/runtime/query-state'

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

describe('@holo-js/realtime aggregate common helpers', () => {
  it('checks aggregate patch eligibility and count output formatting', () => {
    expect(canPatchAggregateQuery(createQuery())).toBe(true)
    expect(canPatchAggregateQuery(createQuery({ limit: 1 }))).toBe(false)
    expect(canPatchAggregateQuery(createQuery({ patchable: false }))).toBe(false)

    expect(formatCountAggregateValue(2, { kind: 'count' })).toBe(2)
    expect(formatCountAggregateValue(2, { kind: 'count', output: 'boolean' })).toBe(true)
    expect(formatCountAggregateValue(0, { kind: 'count', output: 'boolean' })).toBe(false)
    expect(formatCountAggregateValue(0, { kind: 'count', output: 'inverseBoolean' })).toBe(true)
    expect(formatCountAggregateValue(2, { kind: 'count', output: 'inverseBoolean' })).toBe(false)

    expect(createCountAggregateObservation({ kind: 'count' }, 3)).toEqual({
      count: undefined,
      kind: 'count',
      output: undefined,
    })
    expect(createCountAggregateObservation({ kind: 'count', output: 'boolean' }, 3)).toEqual({
      count: 3,
      kind: 'count',
      output: 'boolean',
    })
  })

  it('detects updates that cannot affect aggregate values', () => {
    expect(aggregateMutationCannotChangeValue(
      createQuery(),
      { column: 'views', kind: 'sum' },
      createMutation({
        kind: 'update',
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
    )).toBe(true)
    expect(aggregateMutationCannotChangeValue(
      createQuery(),
      { kind: 'sum' },
      createMutation({
        kind: 'update',
        values: { title: 'Updated' },
        valueKeys: ['title'],
      }),
    )).toBe(false)
    expect(aggregateMutationCannotChangeValue(
      createQuery(),
      { column: 'views', kind: 'sum' },
      createMutation({
        kind: 'update',
        values: { views: 10 },
        valueKeys: ['views'],
      }),
    )).toBe(false)
    expect(aggregateMutationCannotChangeValue(
      createQuery(),
      { column: 'views', kind: 'sum' },
      createMutation({
        kind: 'update',
        values: { status: 'closed' },
        valueKeys: ['status'],
      }),
    )).toBe(false)
    expect(aggregateMutationCannotChangeValue(
      createQuery(),
      { column: 'views', kind: 'sum' },
      createMutation({
        kind: 'insert',
        rows: [{ id: 1, status: 'open', views: 3 }],
      }),
    )).toBe(false)
  })

  it('reads insert, delete, upsert, and update aggregate deltas', () => {
    const query = createQuery()
    const countQuery = createQuery({
      aggregate: { kind: 'count' },
    })

    expect(readAggregateMutationDelta(countQuery, createMutation({
      kind: 'insert',
      rows: [
        { id: 1, status: 'open' },
        { id: 2, status: 'closed' },
      ],
    }))).toBe(1)

    expect(readAggregateMutationDelta(query, createMutation({
      kind: 'insert',
      rows: [
        { id: 1, status: 'open', views: 3 },
        { id: 2, status: 'closed', views: 7 },
      ],
    }))).toBe(3)
    expect(readAggregateMutationDelta(query, createMutation({
      kind: 'delete',
      rows: [
        { id: 1, status: 'open', views: 3 },
      ],
    }))).toBe(-3)
    expect(readAggregateMutationDelta(query, createMutation({
      kind: 'upsert',
      previousRows: [
        { id: 1, status: 'open', views: 3 },
      ],
      rows: [
        { id: 1, status: 'open', views: 9 },
      ],
    }))).toBe(6)
    expect(readAggregateMutationDelta(query, createMutation({
      kind: 'update',
      previousRows: [
        { id: 1, status: 'open', views: 3 },
      ],
      rows: [
        { id: 1, status: 'open', views: 9 },
      ],
      values: { views: 9 },
      valueKeys: ['views'],
    }))).toBe(6)
    expect(readAggregateMutationDelta(query, createMutation({
      kind: 'update',
      values: { title: 'Updated' },
      valueKeys: ['title'],
    }))).toBe(0)
  })

  it('returns undefined when aggregate delta inputs cannot be evaluated', () => {
    expect(readAggregateMutationDelta(createQuery({ aggregate: undefined }), createMutation({
      kind: 'insert',
      rows: [{ id: 1, status: 'open', views: 3 }],
    }))).toBeUndefined()
    expect(readAggregateMutationDelta(createQuery(), createMutation({
      kind: 'insert',
      rows: [{ id: 1, views: 3 }],
    }))).toBeUndefined()
    expect(readAggregateMutationDelta(createQuery(), createMutation({
      kind: 'insert',
      rows: [{ id: 1, status: 'closed', views: 3 }],
    }))).toBe(0)
    expect(readAggregateMutationDelta(createQuery(), createMutation({
      kind: 'insert',
      rows: [{ id: 1, status: 'open' }],
    }))).toBeUndefined()
    expect(readAggregateMutationDelta(createQuery(), createMutation({
      kind: 'insert',
      rows: [{ id: 1, status: 'open', views: Number.NaN }],
    }))).toBeUndefined()
    expect(readAggregateMutationDelta(createQuery(), createMutation({
      kind: 'delete',
    }))).toBeUndefined()
    expect(readAggregateMutationDelta(createQuery(), createMutation({
      kind: 'delete',
      rows: [{ id: 1, status: 'open' }],
    }))).toBeUndefined()
    expect(readAggregateMutationDelta(createQuery(), createMutation({
      kind: 'upsert',
      rows: [{ id: 1, status: 'open', views: 3 }],
    }))).toBeUndefined()
    expect(readAggregateMutationDelta(createQuery(), createMutation({
      kind: 'upsert',
      previousRows: [{ id: 1, status: 'open' }],
      rows: [{ id: 1, status: 'open', views: 3 }],
    }))).toBeUndefined()
    expect(readAggregateMutationDelta(createQuery(), createMutation({
      kind: 'upsert',
      previousRows: [{ id: 1, status: 'open', views: 3 }],
      rows: [{ id: 1, status: 'open' }],
    }))).toBeUndefined()
    expect(readAggregateMutationDelta(createQuery(), createMutation({
      kind: 'update',
      previousRows: [{ id: 1, status: 'open' }],
      rows: [{ id: 1, status: 'open', views: 4 }],
      values: { views: 4 },
      valueKeys: ['views'],
    }))).toBeUndefined()
    expect(readAggregateMutationDelta(createQuery(), createMutation({
      kind: 'update',
      previousRows: [{ id: 1, status: 'open', views: 3 }],
      rows: [{ id: 1, status: 'open' }],
      values: { views: 4 },
      valueKeys: ['views'],
    }))).toBeUndefined()
    expect(readAggregateMutationDelta(createQuery(), createMutation({
      kind: 'update',
      previousRows: [{ id: 1, status: 'open', views: 3 }],
      rows: [
        { id: 1, status: 'open', views: 4 },
        { id: 2, status: 'open', views: 5 },
      ],
      values: { views: 4 },
      valueKeys: ['views'],
    }))).toBeUndefined()
    expect(readAggregateMutationDelta(createQuery(), createMutation({
      kind: 'unknown' as DatabaseMutationEvent['kind'],
    }))).toBeUndefined()
  })
})
