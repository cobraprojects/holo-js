import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('vue', () => ({
  reactive: <TValue>(value: TValue) => value,
  onScopeDispose: vi.fn(),
}))

import { nuxtRealtimeInternals } from '../src/runtime/composables/realtime'

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'showError')
})

describe('Nuxt realtime internals', () => {
  it('normalizes HTTP failures through the Nuxt client boundary', () => {
    const showError = vi.fn()
    Object.defineProperty(globalThis, 'showError', { value: showError, configurable: true })
    nuxtRealtimeInternals.emitRealtimeError(new Error('ordinary'))
    expect(showError).not.toHaveBeenCalled()
    nuxtRealtimeInternals.emitRealtimeError({ status: 403, message: 'Denied' })
    expect(showError).toHaveBeenCalledWith({ statusCode: 403, statusMessage: 'Denied', message: 'Denied' })
  })

  it('creates and updates reactive arrays, objects, and scalar values', () => {
    expect(nuxtRealtimeInternals.createRealtimeReactiveValue(undefined)).toBeUndefined()
    expect(nuxtRealtimeInternals.createRealtimeReactiveValue(4)).toBe(4)
    const array = nuxtRealtimeInternals.createRealtimeReactiveValue([1, 2])!
    expect(array).toEqual([1, 2])
    expect(nuxtRealtimeInternals.replaceRealtimeReactiveValue(array, [3])).toBe(array)
    expect(array).toEqual([3])
    const object = nuxtRealtimeInternals.createRealtimeReactiveValue({ old: true, keep: 1 })!
    expect(nuxtRealtimeInternals.replaceRealtimeReactiveValue(object, { keep: 2 } as never)).toBe(object)
    expect(object).toEqual({ keep: 2 })
    expect(nuxtRealtimeInternals.replaceRealtimeReactiveValue(undefined, { fresh: true })).toEqual({ fresh: true })
    expect(nuxtRealtimeInternals.replaceRealtimeReactiveValue('old', 'new')).toBe('new')

    const connect = vi.fn()
    nuxtRealtimeInternals.connectRealtimeStoreInBrowser({ connect })
    expect(connect).not.toHaveBeenCalled()
    Object.defineProperty(globalThis, 'window', { value: {}, configurable: true })
    nuxtRealtimeInternals.connectRealtimeStoreInBrowser({ connect })
    expect(connect).toHaveBeenCalledOnce()
    Reflect.deleteProperty(globalThis, 'window')
  })
})
