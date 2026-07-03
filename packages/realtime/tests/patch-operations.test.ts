import { describe, expect, it } from 'vitest'
import {
  compactPatchOperations,
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

  it('compacts adjacent replace operations into merge operations only when paths are compatible', () => {
    const first = createReplacePatchOperation(['row', 'title'], 'Updated')
    const second = createReplacePatchOperation(['row', 'status'], 'open')
    const duplicate = createReplacePatchOperation(['row', 'title'], 'Duplicate')
    const numericPath = createReplacePatchOperation(['rows', 0], { id: 1 })
    const undefinedReplace = createReplacePatchOperation(['row', 'body'], undefined)
    const move = createMovePatchOperation(['rows'], 1, 0)

    expect(compactPatchOperations([first])).toEqual([first])
    expect(compactPatchOperations([
      first,
      second,
      duplicate,
      numericPath,
      undefinedReplace,
      move,
    ])).toEqual([
      createMergePatchOperation(['row'], {
        status: 'open',
        title: 'Duplicate',
      }),
      numericPath,
      undefinedReplace,
      move,
    ])
  })

  it('compacts adjacent merge-compatible operations with ordered field overwrites', () => {
    const title = createReplacePatchOperation(['row', 'title'], 'Updated')
    const emptyMetadata = createMergePatchOperation(['row'], {})
    const metadata = createMergePatchOperation(['row'], { status: 'draft', title: 'Merged' })
    const optionalMetadata = createMergePatchOperation(['row'], { body: undefined, summary: 'Draft' })
    const status = createReplacePatchOperation(['row', 'status'], 'open')
    const other = createMergePatchOperation(['other'], { total: 1 })

    expect(compactPatchOperations([
      title,
      emptyMetadata,
      metadata,
      status,
      other,
    ])).toEqual([
      createMergePatchOperation(['row'], {
        status: 'open',
        title: 'Merged',
      }),
      other,
    ])

    expect(compactPatchOperations([
      emptyMetadata,
      createMergePatchOperation(['other'], {}),
    ])).toEqual([])

    expect(compactPatchOperations([
      title,
      undefined,
      status,
    ] as unknown as readonly RealtimeSubscriptionPatchOperation[])).toEqual([
      createMergePatchOperation(['row'], {
        status: 'open',
        title: 'Updated',
      }),
    ])

    expect(compactPatchOperations([
      optionalMetadata,
      status,
    ])).toEqual([
      optionalMetadata,
      status,
    ])
  })

  it('compacts splice runs and skips no-op splices without crossing incompatible operations', () => {
    expect(compactPatchOperations([
      undefined,
      createSplicePatchOperation(['rows'], 1, 0, []),
      createSplicePatchOperation(['rows'], 1, 0, [{ id: 2 }]),
      createSplicePatchOperation(['rows'], 2, 0, [{ id: 3 }]),
      createSplicePatchOperation(['rows'], 2, 1, [{ id: 4 }]),
      createSplicePatchOperation(['other'], 0, 0, [{ id: 1 }]),
    ] as unknown as readonly RealtimeSubscriptionPatchOperation[])).toEqual([
      createSplicePatchOperation(['rows'], 1, 0, [{ id: 2 }, { id: 3 }]),
      createSplicePatchOperation(['rows'], 2, 1, [{ id: 4 }]),
      createSplicePatchOperation(['other'], 0, 0, [{ id: 1 }]),
    ])
  })

  it('compacts same-index splice runs without crossing different path shapes', () => {
    expect(compactPatchOperations([
      createSplicePatchOperation(['rows'], 1, 0, [{ id: 2 }, { id: 3 }]),
      createSplicePatchOperation(['rows'], 2, 0, []),
      createSplicePatchOperation(['rows'], 1, 1, [{ id: 4 }]),
      createSplicePatchOperation(['rows', 0], 0, 0, ['tag']),
    ])).toEqual([
      createSplicePatchOperation(['rows'], 1, 0, [{ id: 4 }, { id: 3 }]),
      createSplicePatchOperation(['rows', 0], 0, 0, ['tag']),
    ])
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
    })).toEqual([
      createMergePatchOperation(['row'], {
        status: 'open',
        title: 'New',
      }),
    ])

    expect(createReplacePatchOperations(['rows'], [first, second], [first, updatedSecond])).toEqual([
      createReplacePatchOperation(['rows', 1, 'title'], 'Updated'),
    ])

    expect(createReplacePatchOperations(['rows'], [first, second, third], [second, { id: 1, title: 'Moved' }, third])).toEqual([
      createMovePatchOperation(['rows'], 0, 1),
      createReplacePatchOperation(['rows', 1, 'title'], 'Moved'),
    ])

    expect(createReplacePatchOperations(['rows'], [first, second, third], [second, third, { id: 4, title: 'Fourth' }])).toEqual([
      createSplicePatchOperation(['rows'], 0, 1, []),
      createSplicePatchOperation(['rows'], 2, 0, [{ id: 4, title: 'Fourth' }]),
    ])

    expect(createReplacePatchOperations(['rows'], [first, second, third], [{ id: 0, title: 'Zero' }, first, second])).toEqual([
      createSplicePatchOperation(['rows'], 0, 0, [{ id: 0, title: 'Zero' }]),
      createSplicePatchOperation(['rows'], 3, 1, []),
    ])

    expect(createReplacePatchOperations(['rows'], [first, second], [first, second, third])).toEqual([
      createSplicePatchOperation(['rows'], 2, 0, [third]),
    ])

    expect(createReplacePatchOperations(['rows'], [1, 2, 3], [1, 4, 5, 3])).toEqual([
      createSplicePatchOperation(['rows'], 1, 1, [4, 5]),
    ])
  })

  it('handles equivalent arrays, no-id records, and nested equivalent values while diffing replacements', () => {
    expect(createReplacePatchOperations(['rows'], [1, 2], [1, 2])).toEqual([])

    expect(createReplacePatchOperations(['rows'], [{ title: 'Old' }], [{ title: 'New' }])).toEqual([
      createReplacePatchOperation(['rows', 0, 'title'], 'New'),
    ])

    expect(createReplacePatchOperations(['rows'], [
      { id: 1, title: 'Same' },
      { id: 2, title: 'Old' },
    ], [
      { id: 1, title: 'Same' },
      { id: 2, title: 'New' },
    ])).toEqual([
      createReplacePatchOperation(['rows', 1, 'title'], 'New'),
    ])

    expect(createReplacePatchOperations(['row'], { id: 1 }, { id: 1 })).toEqual([])

    expect(createReplacePatchOperations(['row'], {
      id: 1,
      tags: ['realtime', 'patches'],
      title: 'Old',
    }, {
      id: 1,
      tags: ['realtime', 'patches'],
      title: 'New',
    })).toEqual([
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
    })).toEqual([
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
    ])).toEqual([
      createReplacePatchOperation(['rows', 0], second),
      createReplacePatchOperation(['rows', 1], { id: 1, status: 'open', title: 'First' }),
    ])
  })

  it('falls back to replace operations when values cannot be safely compacted', () => {
    expect(createReplacePatchOperations(['value'], 'old', 'new')).toEqual([
      createReplacePatchOperation(['value'], 'new'),
    ])
    expect(createReplacePatchOperations(['rows'], [{ id: 1 }], [{ id: 2 }])).toEqual([
      createReplacePatchOperation(['rows', 0], { id: 2 }),
    ])
    expect(createReplacePatchOperations(['rows'], [{ id: 1, nested: [1, 2] }], [{ id: 1, nested: [1, 3] }])).toEqual([
      createReplacePatchOperation(['rows', 0, 'nested'], [1, 3]),
    ])
    expect(createReplacePatchOperations(['rows'], [{ title: 'Old' }], [{ title: 'New', status: 'open' }])).toEqual([
      createReplacePatchOperation(['rows', 0], { status: 'open', title: 'New' }),
    ])
    expect(createReplacePatchOperations(['row'], { title: 'Old' }, { status: 'open' })).toEqual([
      createReplacePatchOperation(['row'], { status: 'open' }),
    ])
  })
})
