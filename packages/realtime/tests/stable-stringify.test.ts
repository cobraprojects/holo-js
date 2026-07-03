import { describe, expect, it } from 'vitest'
import { stableStringify } from '../src/runtime/stable-stringify'

type CircularRecord = {
  readonly name: string
  self?: CircularRecord
}

describe('@holo-js/realtime stable stringification', () => {
  it('serializes object keys in stable order and expands repeated non-cyclic references', () => {
    const shared = { id: 1 }

    expect(stableStringify({
      z: shared,
      a: shared,
    })).toBe('{"a":{"id":1},"z":{"id":1}}')
  })

  it('serializes circular object and array references without recursing forever', () => {
    const record: CircularRecord = { name: 'post' }
    record.self = record
    const items: unknown[] = []
    items.push(items)

    expect(stableStringify(record)).toBe('{"name":"post","self":"[Circular]"}')
    expect(stableStringify(items)).toBe('["[Circular]"]')
  })
})
