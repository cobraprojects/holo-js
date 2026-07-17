import { describe, expect, it, vi } from 'vitest'
import { svelteRealtimeInternals } from '../src/realtime'

describe('SvelteKit realtime internals', () => {
  it('classifies reactive values', () => {
    expect(svelteRealtimeInternals.isPlainObject({})).toBe(true)
    expect(svelteRealtimeInternals.isPlainObject(Object.create(null))).toBe(true)
    expect(svelteRealtimeInternals.isPlainObject([])).toBe(false)
    expect(svelteRealtimeInternals.isPlainObject(null)).toBe(false)
    expect(svelteRealtimeInternals.isPlainObject(new Date())).toBe(false)
    expect(svelteRealtimeInternals.isReactiveObject([])).toBe(true)
    expect(svelteRealtimeInternals.isReactiveObject({})).toBe(true)
    expect(svelteRealtimeInternals.isReactiveObject('value')).toBe(false)
  })

  it('creates stable reactive values for absent, array, object, and scalar data', () => {
    const subscribe = () => {}
    expect(svelteRealtimeInternals.createRealtimeReactiveValue(undefined, subscribe)).toEqual([])
    expect(svelteRealtimeInternals.createRealtimeReactiveValue([{ id: 1 }], subscribe)).toEqual([{ id: 1 }])
    expect(svelteRealtimeInternals.createRealtimeReactiveValue({ id: 1 }, subscribe)).toEqual({ id: 1 })
    expect(svelteRealtimeInternals.createRealtimeReactiveValue('value', subscribe)).toBe('value')
  })

  it('updates arrays, object-shaped arrays, objects, and incompatible values', () => {
    const array = [1, 2]
    expect(svelteRealtimeInternals.replaceRealtimeReactiveValue(array, [3])).toBe(array)
    expect(array).toEqual([3])

    const keyedArray = Object.assign([1], { stale: true, current: false })
    const keyedValue = { current: true }
    expect(svelteRealtimeInternals.replaceRealtimeReactiveValue<unknown>(keyedArray, keyedValue)).toBe(keyedArray)
    expect(keyedArray).toMatchObject({ current: true })
    expect('stale' in keyedArray).toBe(false)

    const object: Record<string, unknown> = { stale: true, keep: 1 }
    expect(svelteRealtimeInternals.replaceRealtimeReactiveValue(object, { keep: 2, added: true })).toBe(object)
    expect(object).toEqual({ keep: 2, added: true })
    expect(svelteRealtimeInternals.replaceRealtimeReactiveValue<unknown>(object, 'scalar')).toBe('scalar')
  })

  it('connects stores only in browser environments and ignores non-http errors', () => {
    const connect = vi.fn()
    svelteRealtimeInternals.connectRealtimeStoreInBrowser({ connect }, false)
    expect(connect).not.toHaveBeenCalled()
    svelteRealtimeInternals.connectRealtimeStoreInBrowser({ connect }, true)
    expect(connect).toHaveBeenCalledOnce()
    expect(() => svelteRealtimeInternals.emitRealtimeError(new Error('network'))).not.toThrow()
  })
})
