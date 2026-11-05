import { describe, expect, it } from 'vitest'
import {
  isQueryObservationContradictedByExactPredicates,
  readExactPredicateValues,
} from '../src/runtime/predicate-dependency-matching'
import type { PredicateDependencyIndex } from '../src/runtime/dependencies'
import type { DatabaseQueryObservation } from '../src/runtime/query-state'

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

function createExactPredicates(
  column: string,
  values: readonly string[],
  tableKey = 'db:main:posts',
): PredicateDependencyIndex {
  return new Map([
    [
      tableKey,
      new Map([
        [column, new Set(values)],
      ]),
    ],
  ])
}

function encodeDependencyValue(value: unknown): string {
  return encodeURIComponent(JSON.stringify(value))
}

describe('@holo-js/realtime predicate dependency matching', () => {
  it('does not contradict queries when exact dependency values are unreadable', () => {
    const exactPredicates = createExactPredicates('status', ['%'])

    expect(isQueryObservationContradictedByExactPredicates(createQuery({
      predicates: [{ column: 'status', operator: '=', value: 1 }],
    }), exactPredicates)).toBe(false)
    expect(readExactPredicateValues(exactPredicates, 'main', 'posts', 'status')).toBeUndefined()
  })

  it('detects contradicted exact predicate values and missing table metadata', () => {
    expect(isQueryObservationContradictedByExactPredicates(createQuery({
      predicates: [{ column: 'status', operator: '=', value: 1 }],
    }), createExactPredicates('status', [
      encodeDependencyValue(0),
    ]))).toBe(true)

    expect(isQueryObservationContradictedByExactPredicates(createQuery({
      predicates: [{ column: 'status', operator: '=', value: 1 }],
    }), createExactPredicates('status', [
      encodeDependencyValue(1),
    ], 'db:main:comments'))).toBeUndefined()
  })

  it('keeps queries eligible when predicates can match or no exact column is present', () => {
    const exactPredicates = createExactPredicates('status', [
      encodeDependencyValue(1),
    ])

    expect(isQueryObservationContradictedByExactPredicates(createQuery(), exactPredicates)).toBe(false)
    expect(isQueryObservationContradictedByExactPredicates(createQuery({
      predicates: [{ column: 'kind', operator: '=', value: 'post' }],
    }), exactPredicates)).toBe(false)
    expect(isQueryObservationContradictedByExactPredicates(createQuery({
      predicates: [{ column: 'status', operator: '=', value: 1 }],
    }), exactPredicates)).toBe(false)
  })

  it('reads exact predicate values when every dependency value is decodable', () => {
    expect(readExactPredicateValues(
      createExactPredicates('id', [
        encodeDependencyValue(1),
        encodeDependencyValue(2),
      ]),
      'main',
      'posts',
      'id',
    )).toEqual([1, 2])
    expect(readExactPredicateValues(
      createExactPredicates('id', [
        encodeDependencyValue(1),
      ]),
      'main',
      'posts',
      'missing',
    )).toBeUndefined()
  })

  it('matches BigInt predicates against exact dependency values by integer value', () => {
    const query = (value: bigint) => createQuery({ predicates: [{ column: 'n', operator: '=', value }] })

    expect(isQueryObservationContradictedByExactPredicates(query(1n), createExactPredicates('n', ['1']))).toBe(false)
    expect(isQueryObservationContradictedByExactPredicates(query(2n), createExactPredicates('n', ['1']))).toBe(true)
    expect(isQueryObservationContradictedByExactPredicates(query(9007199254740993n), createExactPredicates('n', ['9007199254740993']))).toBe(false)
    expect(isQueryObservationContradictedByExactPredicates(query(9007199254740992n), createExactPredicates('n', ['9007199254740993']))).toBe(false)
    expect(readExactPredicateValues(createExactPredicates('n', ['9007199254740993']), 'main', 'posts', 'n')).toBeUndefined()
    expect(readExactPredicateValues(createExactPredicates('n', [encodeURIComponent('[1,9007199254740993]')]), 'main', 'posts', 'n')).toBeUndefined()
  })
})
