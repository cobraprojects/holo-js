import { describe, expect, it } from 'vitest'
import { replaceValueAtPath } from '../src/runtime/result-value-replacement'
import {
  replaceValuesAtPathsUsing,
  spliceValuesAtPath,
} from '../src/runtime/result-multi-replacement'
import {
  getValueAtPath,
} from '../src/runtime/result-path'
import {
  addPathReplacementToPlan,
  createEmptyPathReplacementPlan,
  replaceValueWithPlan,
} from '../src/runtime/result-replacement-plan'

describe('@holo-js/realtime result replacement helpers', () => {
  it('replaces nested values while preserving unchanged branches', () => {
    const unchanged = Object.freeze({ id: 2 })
    const value = Object.freeze({ data: Object.freeze({ first: { id: 1 }, second: unchanged }), meta: { total: 2 } })
    const next = replaceValuesAtPathsUsing(value, [
      { path: ['data', 'first'], value: { id: 10 } },
      { path: ['meta', 'total'], value: 3 },
    ], replacement => replacement.value)

    expect(next).toEqual({ data: { first: { id: 10 }, second: { id: 2 } }, meta: { total: 3 } })
    expect(getValueAtPath(next, ['data', 'second'])).toBe(unchanged)
    expect(value.data.first).toEqual({ id: 1 })
  })

  it('applies overlapping replacements in order and handles root and empty replacements', () => {
    const value = Object.freeze({ data: { rows: [{ id: 1 }] } })
    expect(replaceValuesAtPathsUsing(value, [
      { path: ['data'], value: { rows: [{ id: 2 }], total: 1 } },
      { path: ['data', 'total'], value: 2 },
    ], replacement => replacement.value)).toEqual({ data: { rows: [{ id: 2 }], total: 2 } })
    expect(replaceValuesAtPathsUsing(value, [], () => undefined)).toBe(value)
    expect(replaceValuesAtPathsUsing(value, [
      { path: [], value: { replaced: true } },
    ], replacement => replacement.value)).toEqual({ replaced: true })
    expect(replaceValuesAtPathsUsing(value, [
      { path: ['data'], value: { total: 1 } },
      { path: [], value: { replaced: true } },
    ], replacement => replacement.value)).toEqual({ replaced: true })
  })

  it('splices root and nested arrays while preserving no-op and invalid splices', () => {
    const root = Object.freeze([1, 2, 3])
    expect(spliceValuesAtPath(root, [], [{ index: 1, deleteCount: 1, values: [20, 21] }])).toEqual([1, 20, 21, 3])
    expect(spliceValuesAtPath(root, [], [{ index: 1, deleteCount: 1, values: [2] }])).toBe(root)
    expect(spliceValuesAtPath(root, [], [{ index: 1, deleteCount: 0, values: [] }])).toBe(root)
    expect(spliceValuesAtPath(root, [], [{ index: -1, deleteCount: 1, values: [9] }])).toBe(root)
    expect(spliceValuesAtPath({ rows: root }, ['rows'], [{ index: 2, deleteCount: 10, values: [30] }])).toEqual({ rows: [1, 2, 30] })
    expect(spliceValuesAtPath({ rows: root }, ['missing'], [{ index: 0, deleteCount: 1, values: [9] }])).toEqual({ rows: root })
    expect(root).toEqual([1, 2, 3])
  })
  it('rejects invalid and conflicting replacement plans', () => {
    const childPlan = createEmptyPathReplacementPlan()

    expect(addPathReplacementToPlan(childPlan, ['value'], 1)).toBe(true)
    expect(addPathReplacementToPlan(childPlan, [], { value: 2 })).toBe(false)
  })

  it('preserves values for empty replacement plans', () => {
    const value = Object.freeze({ id: 1 })

    expect(replaceValueWithPlan(value, createEmptyPathReplacementPlan())).toBe(value)
  })

  it('preserves arrays when planned child replacements are no-ops', () => {
    const value = Object.freeze([1])
    const plan = createEmptyPathReplacementPlan()

    expect(addPathReplacementToPlan(plan, [0, 'id'], 2)).toBe(true)
    expect(replaceValueWithPlan(value, plan)).toBe(value)
  })

  it('uses custom replacement readers for batched path replacement', () => {
    const value = Object.freeze({
      first: 1,
      second: 2,
    })

    expect(replaceValuesAtPathsUsing(value, [
      { next: 10, path: ['first'] },
      { next: 20, path: ['second'] },
    ], replacement => replacement.next)).toEqual({
      first: 10,
      second: 20,
    })
  })

  it('applies multiple splices against the evolving target', () => {
    expect(spliceValuesAtPath([1, 2, 3, 4], [], [
      { deleteCount: 1, index: 1, values: [20] },
      { deleteCount: 1, index: 2, values: [30, 31] },
      { deleteCount: 1.5, index: 0, values: [100] },
    ])).toEqual([1, 20, 30, 31, 4])
  })

  it('replaces direct values while preserving unchanged branches', () => {
    const rows = Object.freeze([
      Object.freeze({ id: 1, title: 'first' }),
      Object.freeze({ id: 2, title: 'second' }),
    ])
    const value = Object.freeze({
      rows,
      meta: Object.freeze({ total: 2 }),
    })

    const next = replaceValueAtPath(value, ['rows', 1, 'title'], 'updated')

    expect(replaceValueAtPath(value, [], { replaced: true })).toEqual({ replaced: true })
    expect(next).toEqual({
      rows: [
        { id: 1, title: 'first' },
        { id: 2, title: 'updated' },
      ],
      meta: { total: 2 },
    })
    expect(replaceValueAtPath(value, ['rows', 1, 'title'], 'second')).toBe(value)
    expect(replaceValueAtPath(value, ['meta'], value.meta)).toBe(value)
    expect(replaceValueAtPath(rows, [0], rows[0])).toBe(rows)
    expect(replaceValueAtPath(value, ['missing'], true)).toEqual({
      rows,
      meta: { total: 2 },
      missing: true,
    })
  })

  it('ignores invalid replacement paths without cloning', () => {
    const rows = Object.freeze([
      Object.freeze({ id: 1 }),
      Object.freeze({ id: 2 }),
    ])
    const value = Object.freeze({
      rows,
      meta: Object.freeze({ total: 2 }),
    })

    expect(replaceValueAtPath(rows, [2], { id: 3 })).toBe(rows)
    expect(replaceValueAtPath(rows, [-1], { id: 3 })).toBe(rows)
    expect(replaceValueAtPath(rows, [1.5], { id: 3 })).toBe(rows)
    expect(replaceValueAtPath(rows, ['0'], { id: 3 })).toBe(rows)
    expect(replaceValueAtPath(value, ['rows', 4, 'id'], 4)).toBe(value)
    expect(replaceValueAtPath(value, ['meta', 0], 'invalid')).toBe(value)
    expect(replaceValueAtPath('value', ['field'], 'next')).toBe('value')
  })

  it('reads values at valid paths and returns undefined for invalid paths', () => {
    const value = Object.freeze({
      rows: Object.freeze([{ id: 1 }]),
    })

    expect(getValueAtPath(value, ['rows', 0, 'id'])).toBe(1)
    expect(getValueAtPath(value, ['rows', '0'])).toBeUndefined()
  })

})
