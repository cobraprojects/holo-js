import { describe, expect, it } from 'vitest'
import {
  createStoreKey,
  normalizeArgs,
  parseRealtimeJsonObject,
  parseWireData,
  stableStringify,
} from '../src/client/utils'

describe('@holo-js/realtime client utilities', () => {
  it('serializes store keys with stable object ordering and nested array values', () => {
    expect(stableStringify({
      z: 1,
      a: {
        c: true,
        b: ['x', { y: null }],
      },
    })).toBe('{"a":{"b":["x",{"y":null}],"c":true},"z":1}')
    expect(stableStringify(undefined)).toBeUndefined()
    expect(stableStringify('value')).toBe('"value"')
    expect(createStoreKey('posts.list', {
      tag: 'news',
      limit: 10,
    })).toBe('posts.list:{"limit":10,"tag":"news"}')

    const circularArgs: { readonly tag: string, self?: unknown } = { tag: 'news' }
    circularArgs.self = circularArgs
    expect(createStoreKey('posts.list', circularArgs)).toBe('posts.list:{"self":"[Circular]","tag":"news"}')
  })

  it('normalizes query args to plain records', () => {
    const args = { tag: 'news' }

    expect(normalizeArgs(args)).toBe(args)
    expect(normalizeArgs(null)).toEqual({})
    expect(normalizeArgs(undefined)).toEqual({})
    expect(normalizeArgs('invalid')).toEqual({})
    expect(normalizeArgs(['invalid'])).toEqual({})
  })

  it('parses realtime JSON payloads into records only', () => {
    expect(parseRealtimeJsonObject('{"tag":"news"}')).toEqual({ tag: 'news' })
    expect(parseRealtimeJsonObject('null')).toEqual({})
    expect(parseRealtimeJsonObject('"invalid"')).toEqual({})
    expect(parseRealtimeJsonObject('[1,2]')).toEqual({})
  })

  it('parses wire data from strings and object payloads', () => {
    const payload = { tag: 'news' }

    expect(parseWireData('{"tag":"news"}')).toEqual({ tag: 'news' })
    expect(parseWireData(payload)).toBe(payload)
    expect(parseWireData(null)).toEqual({})
    expect(parseWireData(1)).toEqual({})
    expect(parseWireData(['invalid'])).toEqual({})
  })
})
