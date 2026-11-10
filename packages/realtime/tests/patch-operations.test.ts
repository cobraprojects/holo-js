import { describe, expect, it } from 'vitest'
import {
  createMergePatchOperation,
  createMovePatchOperation,
  createReplacePatchOperation,
  createReplacePatchOperations,
  createSplicePatchOperation,
} from '../src/runtime/patch-operations'
import type { RealtimeSubscriptionPatchOperation } from '../src/runtime/state'

describe('@holo-js/realtime patch operations', () => {
  it('creates replace, merge, splice, and move operations with immutable payloads', () => {
    const replace = createReplacePatchOperation(['rows', 0, 'title'], undefined)
    const merge = createMergePatchOperation(['meta'], { total: 2 })
    const splice = createSplicePatchOperation(['rows'], 1, 0, [{ id: 2 }])
    const move = createMovePatchOperation(['rows'], 1, 0)

    expect(replace).toEqual({
      op: 'replace',
      path: ['rows', 0, 'title'],
      valueKind: 'undefined',
    })
    expect(merge).toEqual({
      fields: { total: 2 },
      op: 'merge',
      path: ['meta'],
    })
    expect(splice).toEqual({
      deleteCount: 0,
      index: 1,
      op: 'splice',
      path: ['rows'],
      values: [{ id: 2 }],
    })
    expect(move).toEqual({
      from: 1,
      op: 'move',
      path: ['rows'],
      to: 0,
    })
    expect(Object.isFrozen(replace)).toBe(true)
    if (merge.op !== 'merge') {
      throw new Error('Expected merge patch operation.')
    }
    expect(Object.isFrozen(merge.fields)).toBe(true)
    expect(Object.isFrozen(splice.values)).toBe(true)
  })

  it('creates compact operations for record field, array item, move, slide, and splice replacements', () => {
    const first = Object.freeze({ id: 1, title: 'First' })
    const second = Object.freeze({ id: 2, title: 'Second' })
    const updatedSecond = Object.freeze({ id: 2, title: 'Updated' })
    const third = Object.freeze({ id: 3, title: 'Third' })

    expect(createReplacePatchOperations(['row'], {
      id: 1,
      status: 'draft',
      title: 'Old',
    }, {
      id: 1,
      status: 'open',
      title: 'New',
    }, 'id')).toEqual([
      createMergePatchOperation(['row'], {
        status: 'open',
        title: 'New',
      }),
    ])

    expect(createReplacePatchOperations(['rows'], [first, second], [first, updatedSecond], 'id')).toEqual([
      createReplacePatchOperation(['rows', 1, 'title'], 'Updated'),
    ])

    expect(createReplacePatchOperations(['rows'], [first, second, third], [second, { id: 1, title: 'Moved' }, third], 'id')).toEqual([
      createMovePatchOperation(['rows'], 0, 1),
      createReplacePatchOperation(['rows', 1, 'title'], 'Moved'),
    ])

    expect(createReplacePatchOperations(['rows'], [first, second, third], [second, third, { id: 4, title: 'Fourth' }], 'id')).toEqual([
      createSplicePatchOperation(['rows'], 0, 1, []),
      createSplicePatchOperation(['rows'], 2, 0, [{ id: 4, title: 'Fourth' }]),
    ])

    expect(createReplacePatchOperations(['rows'], [first, second, third], [{ id: 0, title: 'Zero' }, first, second], 'id')).toEqual([
      createSplicePatchOperation(['rows'], 0, 0, [{ id: 0, title: 'Zero' }]),
      createSplicePatchOperation(['rows'], 3, 1, []),
    ])

    expect(createReplacePatchOperations(['rows'], [first, second], [first, second, third], 'id')).toEqual([
      createSplicePatchOperation(['rows'], 2, 0, [third]),
    ])

    expect(createReplacePatchOperations(['rows'], [1, 2, 3], [1, 4, 5, 3], 'id')).toEqual([
      createSplicePatchOperation(['rows'], 1, 1, [4, 5]),
    ])
  })

  it('identifies rows by the given primary key while diffing replacements', () => {
    const france = { code: 'FR', id: 1, name: 'France' }
    const germany = { code: 'DE', id: 1, name: 'Germany' }
    const italy = { code: 'IT', id: 2, name: 'Italy' }

    expect(createReplacePatchOperations(['rows'], [france, germany, italy], [germany, { ...france, name: 'République' }, italy], 'code')).toEqual([
      createMovePatchOperation(['rows'], 0, 1),
      createReplacePatchOperation(['rows', 1, 'name'], 'République'),
    ])
    expect(createReplacePatchOperations(['rows'], [france, italy], [{ ...germany, id: 1 }, italy], 'code')).toEqual([
      createReplacePatchOperation(['rows', 0], germany),
    ])
    expect(createReplacePatchOperations(['rows'], [france, italy], [{ ...france, id: 9, name: 'France' }, italy], 'code')).toEqual([
      createReplacePatchOperation(['rows', 0, 'id'], 9),
    ])
  })

  it('handles equivalent arrays, no-id records, and nested equivalent values while diffing replacements', () => {
    expect(createReplacePatchOperations(['rows'], [1, 2], [1, 2], 'id')).toEqual([])

    expect(createReplacePatchOperations(['rows'], [{ title: 'Old' }], [{ title: 'New' }], 'id')).toEqual([
      createReplacePatchOperation(['rows', 0, 'title'], 'New'),
    ])

    expect(createReplacePatchOperations(['rows'], [
      { id: 1, title: 'Same' },
      { id: 2, title: 'Old' },
    ], [
      { id: 1, title: 'Same' },
      { id: 2, title: 'New' },
    ], 'id')).toEqual([
      createReplacePatchOperation(['rows', 1, 'title'], 'New'),
    ])

    expect(createReplacePatchOperations(['row'], { id: 1 }, { id: 1 }, 'id')).toEqual([])

    expect(createReplacePatchOperations(['row'], {
      id: 1,
      tags: ['realtime', 'patches'],
      title: 'Old',
    }, {
      id: 1,
      tags: ['realtime', 'patches'],
      title: 'New',
    }, 'id')).toEqual([
      createReplacePatchOperation(['row', 'title'], 'New'),
    ])
  })

  it('keeps undefined record field replacements lossless for JSON patch transport', () => {
    expect(createReplacePatchOperations(['row'], {
      body: 'Body',
      id: 1,
      title: 'Old',
    }, {
      body: undefined,
      id: 1,
      title: 'New',
    }, 'id')).toEqual([
      createReplacePatchOperation(['row', 'body'], undefined),
      createReplacePatchOperation(['row', 'title'], 'New'),
    ])
  })

  it('falls back when moved rows have incompatible patchable fields', () => {
    const first = Object.freeze({ id: 1, title: 'First' })
    const second = Object.freeze({ id: 2, title: 'Second' })
    const third = Object.freeze({ id: 3, title: 'Third' })

    expect(createReplacePatchOperations(['rows'], [
      first,
      second,
      third,
    ], [
      second,
      { id: 1, status: 'open', title: 'First' },
      third,
    ], 'id')).toEqual([
      createReplacePatchOperation(['rows', 0], second),
      createReplacePatchOperation(['rows', 1], { id: 1, status: 'open', title: 'First' }),
    ])
  })

  it('falls back to replace operations when values cannot be safely compacted', () => {
    expect(createReplacePatchOperations(['value'], 'old', 'new', 'id')).toEqual([
      createReplacePatchOperation(['value'], 'new'),
    ])
    expect(createReplacePatchOperations(['rows'], [{ id: 1 }], [{ id: 2 }], 'id')).toEqual([
      createReplacePatchOperation(['rows', 0], { id: 2 }),
    ])
    expect(createReplacePatchOperations(['rows'], [{ id: 1, nested: [1, 2] }], [{ id: 1, nested: [1, 3] }], 'id')).toEqual([
      createReplacePatchOperation(['rows', 0, 'nested'], [1, 3]),
    ])
    expect(createReplacePatchOperations(['rows'], [{ title: 'Old' }], [{ title: 'New', status: 'open' }], 'id')).toEqual([
      createReplacePatchOperation(['rows', 0], { status: 'open', title: 'New' }),
    ])
    expect(createReplacePatchOperations(['row'], { title: 'Old' }, { status: 'open' }, 'id')).toEqual([
      createReplacePatchOperation(['row'], { status: 'open' }),
    ])
  })
})
