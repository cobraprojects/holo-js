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
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    }), exactPredicates)).toBe(false)
    expect(readExactPredicateValues(exactPredicates, 'main', 'posts', 'status')).toBeUndefined()
  })

  it('detects contradicted exact predicate values and missing table metadata', () => {
    expect(isQueryObservationContradictedByExactPredicates(createQuery({
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    }), createExactPredicates('status', [
      encodeDependencyValue('closed'),
    ]))).toBe(true)

    expect(isQueryObservationContradictedByExactPredicates(createQuery({
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
    }), createExactPredicates('status', [
      encodeDependencyValue('open'),
    ], 'db:main:comments'))).toBeUndefined()
  })

  it('keeps queries eligible when predicates can match or no exact column is present', () => {
    const exactPredicates = createExactPredicates('status', [
      encodeDependencyValue('open'),
    ])

    expect(isQueryObservationContradictedByExactPredicates(createQuery(), exactPredicates)).toBe(false)
    expect(isQueryObservationContradictedByExactPredicates(createQuery({
      predicates: [{ column: 'kind', operator: '=', value: 'post' }],
    }), exactPredicates)).toBe(false)
    expect(isQueryObservationContradictedByExactPredicates(createQuery({
      predicates: [{ column: 'status', operator: '=', value: 'open' }],
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
})
