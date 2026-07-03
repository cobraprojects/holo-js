import { describe, expect, it } from 'vitest'
import {
  replacePatchedQueryDataWithPlan,
  type PatchedQueryDataReplacement,
} from '../src/runtime/result-query-data-replacement'
import {
  applyTopLevelPathReplacement,
  applyTopLevelSegmentReplacement,
  canReplaceTopLevelPath,
  finishTopLevelPathReplacement,
  type TopLevelReplacementState,
} from '../src/runtime/result-top-level-replacement'
import {
  copyArrayWithReplacement,
  copyRecordWithReplacement,
  replaceValueAtPath,
} from '../src/runtime/result-value-replacement'
import {
  replaceTwoValuesAtPaths,
  replaceValuesAtPaths,
  replaceValuesAtPathsUsing,
  spliceValueAtPath,
  spliceValuesAtPath,
} from '../src/runtime/result-multi-replacement'
import {
  getValueAtPath,
} from '../src/runtime/result-path'
import {
  addPathReplacementToPlan,
  createEmptyPathReplacementPlan,
  createTwoPathReplacementPlan,
  replaceValueWithPlan,
} from '../src/runtime/result-replacement-plan'

describe('@holo-js/realtime result replacement helpers', () => {
  it('replaces multiple values through a shared replacement plan', () => {
    const value = Object.freeze({
      data: Object.freeze({
        first: Object.freeze({ id: 1 }),
        second: Object.freeze({ id: 2 }),
      }),
      meta: Object.freeze({ total: 2 }),
    })

    expect(replaceValuesAtPaths(value, [
      { path: ['data', 'first'], value: { id: 10 } },
      { path: ['meta', 'total'], value: 3 },
    ])).toEqual({
      data: {
        first: { id: 10 },
        second: { id: 2 },
      },
      meta: { total: 3 },
    })
  })

  it('rejects invalid and conflicting replacement plans', () => {
    const invalidPath: (string | number)[] = []
    invalidPath.length = 1

    expect(createTwoPathReplacementPlan(invalidPath, 1, ['value'], 2)).toBeUndefined()

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

  it('falls back to sequential replacement for conflicting paths', () => {
    const value = Object.freeze({
      data: Object.freeze({
        rows: Object.freeze([{ id: 1 }]),
      }),
    })

    expect(replaceValuesAtPaths(value, [
      { path: ['data'], value: { rows: [{ id: 2 }], total: 1 } },
      { path: ['data', 'total'], value: 2 },
    ])).toEqual({
      data: {
        rows: [{ id: 2 }],
        total: 2,
      },
    })
    expect(replaceValuesAtPaths(value, [])).toBe(value)
    expect(replaceValuesAtPaths(value, [
      { path: [], value: { replaced: true } },
    ])).toEqual({ replaced: true })
    expect(replaceValuesAtPaths(value, [
      { path: ['data'], value: { total: 1 } },
      { path: [], value: { replaced: true } },
    ])).toEqual({ replaced: true })
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

  it('replaces two top-level values and falls back for conflicting root replacements', () => {
    const value = Object.freeze({
      first: 1,
      second: 2,
    })

    expect(replaceTwoValuesAtPaths(value, ['first'], 10, ['second'], 20)).toEqual({
      first: 10,
      second: 20,
    })
    expect(replaceTwoValuesAtPaths(value, [], { root: true }, ['root'], false)).toEqual({
      root: false,
    })
    expect(replaceTwoValuesAtPaths(value, ['first'], 10, [], { replaced: true })).toEqual({
      replaced: true,
    })
    expect(replaceTwoValuesAtPaths([1, 2], [0], 1, [1], 20)).toEqual([1, 20])
    expect(replaceTwoValuesAtPaths([1, 2], [3], 30, [1], 20)).toEqual([1, 20])
    expect(replaceTwoValuesAtPaths([1], [0], 2, [1], 3)).toEqual([2])
  })

  it('splices root and nested arrays while preserving no-op splices', () => {
    const root = Object.freeze([1, 2, 3])

    expect(spliceValueAtPath(root, [], 1, 1, [20, 21])).toEqual([1, 20, 21, 3])
    expect(spliceValueAtPath(root, [], 1, 1, [2])).toBe(root)
    expect(spliceValueAtPath(root, [], 1, 0, [])).toBe(root)
    expect(spliceValueAtPath(root, [], -1, 1, [9])).toBe(root)
    expect(spliceValueAtPath({ rows: root }, ['rows'], 2, 10, [30])).toEqual({
      rows: [1, 2, 30],
    })
    expect(spliceValueAtPath({ rows: root }, ['missing'], 0, 1, [9])).toEqual({ rows: root })
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

  it('copies arrays and records with replacement helpers', () => {
    const row = Object.freeze({ id: 1 })
    const rows = Object.freeze([row, Object.freeze({ id: 2 })])
    const record = Object.freeze({ first: row })

    expect(copyArrayWithReplacement(rows, 1, { id: 20 })).toEqual([
      row,
      { id: 20 },
    ])
    expect(copyRecordWithReplacement(record, 'first', { id: 10 })).toEqual({
      first: { id: 10 },
    })
    expect(copyRecordWithReplacement(record, 'second', { id: 2 })).toEqual({
      first: row,
      second: { id: 2 },
    })
  })

  it('applies top-level replacements through shared state', () => {
    const value = Object.freeze({
      first: 1,
      second: 2,
    })
    const state: TopLevelReplacementState = {}

    expect(applyTopLevelPathReplacement(value, state, ['first'], 10)).toBe(true)
    expect(applyTopLevelPathReplacement(value, state, ['second'], 20)).toBe(true)
    expect(finishTopLevelPathReplacement(value, state).value).toEqual({
      first: 10,
      second: 20,
    })

    const noOpState: TopLevelReplacementState = {}
    expect(applyTopLevelSegmentReplacement(value, noOpState, 'first', 1)).toBe(true)
    expect(finishTopLevelPathReplacement(value, noOpState).value).toBe(value)
  })

  it('handles top-level array replacements and no-op replacements', () => {
    const value = Object.freeze([1, 2, 3])
    const state: TopLevelReplacementState = {}

    expect(applyTopLevelSegmentReplacement(value, state, 0, 1)).toBe(true)
    expect(finishTopLevelPathReplacement(value, state).value).toBe(value)
    expect(applyTopLevelSegmentReplacement(value, state, 1, 20)).toBe(true)
    expect(applyTopLevelSegmentReplacement(value, state, 2, 30)).toBe(true)
    expect(finishTopLevelPathReplacement(value, state).value).toEqual([1, 20, 30])
  })

  it('rejects invalid top-level replacements', () => {
    const value = Object.freeze([1, 2, 3])
    const state: TopLevelReplacementState = {}

    expect(applyTopLevelPathReplacement(value, state, [], 10)).toBe(false)
    expect(applyTopLevelPathReplacement(value, state, [0, 'id'], 10)).toBe(false)
    expect(applyTopLevelSegmentReplacement(value, state, '0', 10)).toBe(false)
    expect(applyTopLevelSegmentReplacement(value, state, -1, 10)).toBe(false)
    expect(applyTopLevelSegmentReplacement(value, state, 1.5, 10)).toBe(false)
    expect(applyTopLevelSegmentReplacement(value, state, 4, 10)).toBe(false)
    expect(applyTopLevelSegmentReplacement(1, state, 'value', 10)).toBe(false)
    expect(finishTopLevelPathReplacement(value, state).value).toBe(value)
  })

  it('validates top-level replacement path support', () => {
    expect(canReplaceTopLevelPath(['rows'])).toBe(true)
    expect(canReplaceTopLevelPath([0])).toBe(true)
    expect(canReplaceTopLevelPath([])).toBe(false)
    expect(canReplaceTopLevelPath(['rows', 0])).toBe(false)
  })

  it('reads values at valid paths and returns undefined for invalid paths', () => {
    const value = Object.freeze({
      rows: Object.freeze([{ id: 1 }]),
    })

    expect(getValueAtPath(value, ['rows', 0, 'id'])).toBe(1)
    expect(getValueAtPath(value, ['rows', '0'])).toBeUndefined()
  })

  it('replaces patched query data through shared parent paths', () => {
    const value = Object.freeze({
      payload: Object.freeze({
        rows: Object.freeze([
          Object.freeze({ id: 1 }),
          Object.freeze({ id: 2 }),
        ]),
        total: 2,
      }),
    })

    expect(replacePatchedQueryDataWithPlan(
      value,
      createPatch(['payload', 'rows'], [{ id: 3 }]),
      [
        createPatch(['payload', 'total'], 1),
      ],
    )).toEqual({
      payload: {
        rows: [{ id: 3 }],
        total: 1,
      },
    })
  })

  it('falls back to query data replacement plans and sequential root replacement', () => {
    const value = Object.freeze({
      payload: Object.freeze({
        rows: Object.freeze([{ id: 1 }]),
        total: 1,
      }),
    })

    expect(replacePatchedQueryDataWithPlan(
      value,
      createPatch(['payload', 'rows'], [{ id: 2 }]),
      [
        createPatch(['payload'], { rows: [{ id: 3 }], total: 1 }),
      ],
    )).toEqual({
      payload: {
        rows: [{ id: 3 }],
        total: 1,
      },
    })
    expect(replacePatchedQueryDataWithPlan(
      value,
      createPatch([], { replaced: true }),
      [
        createPatch(['payload'], { rows: [], total: 0 }),
      ],
    )).toEqual({
      replaced: true,
      payload: {
        rows: [],
        total: 0,
      },
    })
    expect(replacePatchedQueryDataWithPlan(
      value,
      {
        nextQuery: { resultPath: ['payload', 'total'] },
        query: { resultPath: ['ignored'] },
        value: 2,
      },
      [],
    )).toEqual({
      payload: {
        rows: [{ id: 1 }],
        total: 2,
      },
    })
  })

  it('falls back safely when the first patched query path is invalid', () => {
    const value = Object.freeze({
      payload: Object.freeze({
        rows: Object.freeze([{ id: 1 }]),
      }),
    })
    const invalidPath: (string | number)[] = ['payload']
    invalidPath.length = 2

    expect(replacePatchedQueryDataWithPlan(
      value,
      createPatch(invalidPath, [{ id: 2 }]),
      [
        createPatch(['payload', 'rows'], [{ id: 3 }]),
      ],
    )).toEqual({
      payload: [{ id: 2 }],
    })
  })

  it('applies root replacements after nested sequential fallback patches', () => {
    const value = Object.freeze({
      payload: Object.freeze({
        rows: Object.freeze([{ id: 1 }]),
      }),
    })

    expect(replacePatchedQueryDataWithPlan(
      value,
      createPatch(['payload', 'rows'], [{ id: 2 }]),
      [
        createPatch([], { replaced: true }),
      ],
    )).toEqual({ replaced: true })
  })

  it('uses replacement plans when shared parent replacement cannot batch valid paths', () => {
    const value = Object.freeze({
      payload: Object.freeze({
        rows: Object.freeze([{ id: 1 }]),
      }),
      other: Object.freeze({
        rows: Object.freeze([{ id: 2 }]),
      }),
    })

    expect(replacePatchedQueryDataWithPlan(
      value,
      createPatch(['payload', 'rows'], [{ id: 10 }]),
      [
        createPatch(['other', 'rows'], [{ id: 20 }]),
      ],
    )).toEqual({
      payload: {
        rows: [{ id: 10 }],
      },
      other: {
        rows: [{ id: 20 }],
      },
    })
  })

  it('falls back when shared parent replacement sees invalid parents or segments', () => {
    const invalidParentValue = Object.freeze({
      payload: null,
    })
    const value = Object.freeze({
      payload: Object.freeze({
        rows: Object.freeze([{ id: 1 }]),
      }),
    })
    const invalidPath: (string | number)[] = ['payload']
    invalidPath.length = 2

    expect(replacePatchedQueryDataWithPlan(
      invalidParentValue,
      createPatch(['payload', 'rows'], [{ id: 2 }]),
      [],
    )).toBe(invalidParentValue)
    expect(replacePatchedQueryDataWithPlan(
      value,
      createPatch(['payload', 'rows'], [{ id: 2 }]),
      [
        createPatch(invalidPath, [{ id: 3 }]),
      ],
    )).toEqual({
      payload: [{ id: 3 }],
    })
    expect(replacePatchedQueryDataWithPlan(
      value,
      createPatch(['payload', 'rows'], [{ id: 2 }]),
      [
        createPatch(['payload', 0], { id: 3 }),
      ],
    )).toEqual({
      payload: {
        rows: [{ id: 2 }],
      },
    })
  })
})

function createPatch(
  path: readonly (string | number)[],
  value: unknown,
): PatchedQueryDataReplacement {
  return {
    query: { resultPath: path },
    value,
  }
}
