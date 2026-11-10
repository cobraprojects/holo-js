import { describe, expect, it } from 'vitest'
import {
  compareValues,
  matchesPredicateValue,
  type DatabaseQueryPredicateObservation,
} from '../src/runtime/predicate-matching'

describe('@holo-js/realtime predicate matching', () => {
  it('compares numbers with BigInt values by exact integer value', () => {
    expect(compareValues(0, 0n)).toBe(0)
    expect(compareValues(1n, 2)).toBe(-1)
    expect(compareValues(3n, 2n)).toBe(1)
    expect(compareValues(9007199254740991, 9007199254740991n)).toBe(0)
    expect(compareValues(9007199254740992, 9007199254740993n)).toBeUndefined()
    expect(compareValues(9007199254740993n, 9007199254740992)).toBeUndefined()
    expect(compareValues(9007199254740993n, 9007199254740992n)).toBeUndefined()
    expect(compareValues(9007199254740994, 9007199254740992)).toBeUndefined()
    expect(matchesPredicateValue(0, { column: 'n', operator: '=', value: 0n })).toBe(true)
    expect(matchesPredicateValue(1, { column: 'n', operator: '=', value: 0n })).toBe(false)
    expect(matchesPredicateValue(2, { column: 'n', operator: '!=', value: 2n })).toBe(false)
    expect(matchesPredicateValue(2, { column: 'n', operator: 'in', value: [1n, 2n] })).toBe(true)
    expect(matchesPredicateValue(3, { column: 'n', operator: 'in', value: [1n, 2n] })).toBe(false)
    expect(matchesPredicateValue(3, { column: 'n', operator: '>', value: 2n })).toBe(true)
    expect(matchesPredicateValue(9007199254740992, { column: 'n', operator: '=', value: 9007199254740993n })).toBeUndefined()
    expect(matchesPredicateValue(9007199254740992, { column: 'n', operator: '!=', value: 9007199254740993n })).toBeUndefined()
    expect(compareValues(Number.NaN, 5n)).toBeUndefined()
    expect(matchesPredicateValue(Number.NaN, { column: 'n', operator: '=', value: 5n })).toBe(false)
  })

  it('compares typed values without assuming database string collation', () => {
    expect(compareValues(1, 2)).toBe(-1)
    expect(compareValues(2, 2)).toBe(0)
    expect(compareValues(3, 2)).toBe(1)
    expect(compareValues('a', 'b')).toBeUndefined()
    expect(compareValues('b', 'a')).toBeUndefined()
    expect(compareValues(new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-02T00:00:00.000Z'))).toBe(-1)
    expect(compareValues(new Date('2026-01-02T00:00:00.000Z'), new Date('2026-01-02T00:00:00.000Z'))).toBe(0)
    expect(compareValues(new Date('2026-01-03T00:00:00.000Z'), new Date('2026-01-02T00:00:00.000Z'))).toBe(1)

    const marker = Object.freeze({ id: 1 })
    expect(compareValues(marker, marker)).toBe(0)
    expect(compareValues(1, '1')).toBeUndefined()
  })

  it('matches a number read from an integer column against an equal bigint predicate', () => {
    expect(matchesPredicateValue(0, createPredicate('n', '=', 0n))).toBe(true)
    expect(matchesPredicateValue(0n, createPredicate('n', '=', 0))).toBe(true)
    expect(matchesPredicateValue(1, createPredicate('n', '=', 0n))).toBe(false)
    expect(matchesPredicateValue(0, createPredicate('n', '!=', 0n))).toBe(false)
    expect(matchesPredicateValue(5, createPredicate('n', 'in', [0n, 5n]))).toBe(true)
    expect(matchesPredicateValue(0.5, createPredicate('n', '=', 0n))).toBe(false)
  })

  it('matches range, set, and unknown predicate operators safely', () => {
    const between = createPredicate('score', 'between', [10, 20])
    const notBetween = createPredicate('score', 'not between', [10, 20])

    expect(matchesPredicateValue(10, createPredicate('score', '>=' , 10))).toBe(true)
    expect(matchesPredicateValue(9, createPredicate('score', '>=' , 10))).toBe(false)
    expect(matchesPredicateValue(9, createPredicate('score', '<', 10))).toBe(true)
    expect(matchesPredicateValue(10, createPredicate('score', '<=', 10))).toBe(true)
    expect(matchesPredicateValue(15, between)).toBe(true)
    expect(matchesPredicateValue(25, between)).toBe(false)
    expect(matchesPredicateValue(5, notBetween)).toBe(true)
    expect(matchesPredicateValue(15, notBetween)).toBe(false)
    expect(matchesPredicateValue(15, createPredicate('score', 'between', [10]))).toBeUndefined()
    expect(matchesPredicateValue(15, createPredicate('score', 'not between', [10]))).toBeUndefined()
    expect(matchesPredicateValue('15', between)).toBeUndefined()
    expect(matchesPredicateValue('15', notBetween)).toBeUndefined()
    expect(matchesPredicateValue(1, createPredicate('score', 'in', [1, 2]))).toBe(true)
    expect(matchesPredicateValue(3, createPredicate('score', 'not in', [1, 2]))).toBe(true)
    expect(matchesPredicateValue(3, createPredicate('score', 'in', 1))).toBeUndefined()
    expect(matchesPredicateValue(3, createPredicate('score', 'not in', 1))).toBeUndefined()
    expect(matchesPredicateValue(3, createPredicate('score', 'unknown', 1))).toBeUndefined()
  })

  it('leaves a number compared with text undecided, since databases may compare them numerically', () => {
    expect(matchesPredicateValue('12.30', createPredicate('amount', '=', 12.3))).toBeUndefined()
    expect(matchesPredicateValue(12.3, createPredicate('amount', '=', '12.30'))).toBeUndefined()
    expect(matchesPredicateValue('12.30', createPredicate('amount', '!=', 12.3))).toBeUndefined()
    expect(matchesPredicateValue('12.30', createPredicate('amount', 'in', [12.3]))).toBeUndefined()
    expect(matchesPredicateValue('12.30', createPredicate('amount', 'not in', [12.3]))).toBeUndefined()
    expect(matchesPredicateValue('12.30', createPredicate('amount', '=', true))).toBeUndefined()
    expect(matchesPredicateValue(true, createPredicate('enabled', '=', '1'))).toBeUndefined()
    expect(matchesPredicateValue(false, createPredicate('enabled', 'in', ['0']))).toBeUndefined()
    expect(matchesPredicateValue(1, createPredicate('amount', '=', 2))).toBe(false)
  })

  it('compares a boolean with the one or zero a database binds for it', () => {
    expect(matchesPredicateValue(true, createPredicate('enabled', '=', 1))).toBe(true)
    expect(matchesPredicateValue(false, createPredicate('enabled', '=', 0))).toBe(true)
    expect(matchesPredicateValue(true, createPredicate('enabled', '=', 0))).toBe(false)
    expect(matchesPredicateValue(false, createPredicate('enabled', '!=', 1))).toBe(true)
    expect(matchesPredicateValue(true, createPredicate('enabled', 'in', [1]))).toBe(true)
    expect(matchesPredicateValue(1, createPredicate('enabled', '=', true))).toBe(true)
    expect(matchesPredicateValue(true, createPredicate('enabled', '=', 1n))).toBe(true)
    expect(matchesPredicateValue(0n, createPredicate('enabled', '=', true))).toBe(false)
    expect(compareValues(false, 1n)).toBe(-1)
    expect(compareValues(false, true)).toBe(-1)
    expect(compareValues(true, 0)).toBe(1)
    expect(compareValues(true, true)).toBe(0)
  })

})

function createPredicate(
  column: string,
  operator: string,
  value: unknown,
): DatabaseQueryPredicateObservation {
  return Object.freeze({
    column,
    operator,
    value,
  })
}
