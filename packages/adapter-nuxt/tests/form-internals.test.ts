import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ useCookie: vi.fn() }))

vi.mock('vue', () => ({
  reactive: <TValue>(value: TValue) => value,
  shallowRef: <TValue>(value: TValue) => ({ value }),
  watchEffect: vi.fn(),
  onScopeDispose: vi.fn(),
}))

vi.mock('#app', () => ({ useCookie: mocks.useCookie }))

import { nuxtFormInternals } from '../src/runtime/composables/forms'

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document')
  Reflect.deleteProperty(globalThis, 'showError')
})

beforeEach(() => {
  mocks.useCookie.mockReset()
  mocks.useCookie.mockImplementation(() => { throw new Error('outside setup') })
})

describe('Nuxt form internals', () => {
  it('reads and validates flashed browser form failures', () => {
    expect(nuxtFormInternals.isLeafValue(new Date())).toBe(true)
    expect(nuxtFormInternals.isLeafValue(new Blob([]))).toBe(true)
    expect(nuxtFormInternals.isLeafValue({ nested: true })).toBe(false)
    expect(nuxtFormInternals.readBrowserCookie('missing')).toBeUndefined()
    Object.defineProperty(globalThis, 'document', {
      value: { cookie: `invalid; holo_form_failure=${encodeURIComponent(JSON.stringify({ bag: 'login', errors: { email: ['Invalid'] } }))}` },
      configurable: true,
    })
    expect(nuxtFormInternals.readBrowserCookie('holo_form_failure')).toContain('%7B')
    expect(nuxtFormInternals.readBrowserCookie('other')).toBeUndefined()
    expect(nuxtFormInternals.parseFlashedValidationPayload()).toEqual({ bag: 'login', errors: { email: ['Invalid'] } })
    mocks.useCookie.mockReturnValue({ value: { errors: { name: ['Required'] } } })
    expect(nuxtFormInternals.parseFlashedValidationPayload()).toEqual({ bag: 'default', errors: { name: ['Required'] } })
    mocks.useCookie.mockReturnValue({ value: null })
    ;(globalThis as typeof globalThis & { document: { cookie: string } }).document.cookie = 'other=value'
    expect(nuxtFormInternals.parseFlashedValidationPayload()).toBeUndefined()
    ;(globalThis as typeof globalThis & { document: { cookie: string } }).document.cookie = 'holo_form_failure=%'
    expect(nuxtFormInternals.parseFlashedValidationPayload()).toBeUndefined()
    ;(globalThis as typeof globalThis & { document: { cookie: string } }).document.cookie = `holo_form_failure=${encodeURIComponent('{}')}`
    expect(nuxtFormInternals.parseFlashedValidationPayload()).toBeUndefined()
  })

  it('renders non-validation HTTP form failures and wraps submitters', async () => {
    const showError = vi.fn()
    Object.defineProperty(globalThis, 'showError', { value: showError, configurable: true })
    nuxtFormInternals.renderFormHttpFailure(null)
    nuxtFormInternals.renderFormHttpFailure({ ok: false, status: 422, errors: { _root: ['Invalid'] } })
    expect(showError).not.toHaveBeenCalled()
    nuxtFormInternals.renderFormHttpFailure({ ok: false, status: 403, errors: { _root: ['Denied'] } })
    expect(showError).toHaveBeenCalledWith({ statusCode: 403, statusMessage: 'Denied', message: 'Denied' })

    const unchanged = {}
    expect(nuxtFormInternals.createHttpHandledFormOptions(unchanged)).toBe(unchanged)
    const success = nuxtFormInternals.createHttpHandledFormOptions({
      submitter: async () => ({ ok: true, status: 200, data: 'saved' }),
    })
    await expect(success.submitter?.({} as never)).resolves.toEqual({ ok: true, status: 200, data: 'saved' })
    const failure = nuxtFormInternals.createHttpHandledFormOptions({
      submitter: async () => { throw { status: 500, message: 'Failure' } },
    })
    await expect(failure.submitter?.({} as never)).rejects.toEqual({ status: 500, message: 'Failure' })
  })

  it('proxies nested values and array mutations into form setValue calls', () => {
    const state: { values: Record<string, unknown> } = {
      values: { profile: { name: 'Ava' }, tags: ['one', 'two'], removed: true },
    }
    const setValue = vi.fn(async (path: string, value: unknown) => {
      if (path === 'profile.name') (state.values.profile as Record<string, unknown>).name = value
      if (path === 'tags') state.values.tags = value
    })
    const getForm = () => ({ values: state.values, setValue })
    const version = { value: 1 }
    const cache = new WeakMap<readonly unknown[], unknown[]>()
    const target: Record<string, unknown> = { stale: true }
    nuxtFormInternals.syncValuesView(target, state.values, getForm, version, cache)
    expect(target.stale).toBeUndefined()
    expect((target.profile as Record<string, unknown>).name).toBe('Ava')
    ;(target.profile as Record<string, unknown>).name = 'Mina'
    expect(setValue).toHaveBeenCalledWith('profile.name', 'Mina')
    const tags = target.tags as string[]
    expect(tags.length).toBe(2)
    expect(tags.map(value => value.toUpperCase())).toEqual(['ONE', 'TWO'])
    expect(nuxtFormInternals.createArrayMutationView(state.values.tags as string[], 'tags', getForm, version, cache)).toBe(tags)
    expect(tags.push('three')).toBe(3)
    expect(setValue).toHaveBeenCalledWith('tags', ['one', 'two', 'three'])
    tags[0] = 'first'
    expect(setValue).toHaveBeenCalledWith('tags', ['first', 'two', 'three'])
    delete tags[0]
    expect(setValue).toHaveBeenCalled()
    const pushWhenCurrent = tags.push
    state.values.tags = 'not-an-array'
    expect(tags.length).toBeUndefined()
    expect(pushWhenCurrent('ignored')).toBeUndefined()
    expect(Reflect.set(tags, '0', 'ignored')).toBe(false)
    expect(Reflect.deleteProperty(tags, '0')).toBe(false)
    expect(nuxtFormInternals.getValueAtPath(state.values, 'profile.name')).toBe('Mina')
    expect(nuxtFormInternals.getValueAtPath(1, 'profile')).toBeUndefined()
    nuxtFormInternals.syncValuesView(target, null, getForm, version, cache)
    expect(target).toEqual({})

    const replacing: Record<string, unknown> = { tags: { nested: true }, name: { nested: true } }
    state.values = { tags: ['one'], name: 'Ava' }
    nuxtFormInternals.syncValuesView(replacing, state.values, getForm, version, new WeakMap())
    expect(Array.isArray(replacing.tags)).toBe(true)
    expect(replacing.name).toBe('Ava')
  })
})
