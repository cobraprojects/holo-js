import { afterEach, describe, expect, it, vi } from 'vitest'
import { svelteClientInternals } from '../src/client'

const field = { kind: 'field', definition: {} }
const schema = {
  fields: {
    title: field,
    profile: { email: field },
  },
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('SvelteKit client form internals', () => {
  it('classifies values and collects schema and value paths', () => {
    expect(svelteClientInternals.isPlainObject({})).toBe(true)
    expect(svelteClientInternals.isPlainObject([])).toBe(false)
    expect(svelteClientInternals.isPlainObject(new Date())).toBe(false)
    expect(svelteClientInternals.isPlainObject(new Blob([]))).toBe(false)
    expect(svelteClientInternals.isSchemaField(field)).toBe(true)
    expect(svelteClientInternals.isSchemaField({ kind: 'field' })).toBe(false)
    expect(svelteClientInternals.collectSchemaPaths(schema.fields)).toEqual(['title', 'profile.email'])
    expect(svelteClientInternals.collectSchemaPaths('invalid')).toEqual([])
    expect(svelteClientInternals.collectValuePaths({ title: 'Post', profile: { email: 'a@b.test' } })).toEqual(['title', 'profile.email'])
    expect(svelteClientInternals.collectValuePaths('value')).toEqual([])
    expect(svelteClientInternals.collectValuePaths('value', 'title')).toEqual(['title'])
  })

  it('flattens restorable values while omitting files and absent values', () => {
    expect(svelteClientInternals.flattenRestorableValues(undefined)).toEqual([])
    expect(svelteClientInternals.flattenRestorableValues(new Blob([]), 'file')).toEqual([])
    expect(svelteClientInternals.flattenRestorableValues({
      title: 'Post',
      tags: ['a', 'b'],
      profile: { active: true },
    })).toEqual([
      ['title', 'Post'],
      ['tags', 'a'],
      ['tags', 'b'],
      ['profile.active', 'true'],
    ])
    expect(svelteClientInternals.flattenRestorableValues('root')).toEqual([])
  })

  it('restores text, checkbox, and radio controls and skips unrelated and file controls', async () => {
    const controls = [
      { name: 'title', type: 'text', value: '' },
      { name: 'tags', type: 'checkbox', value: 'a', checked: false },
      { name: 'tags', type: 'checkbox', value: 'c', checked: true },
      { name: 'enabled', type: 'checkbox', checked: false },
      { name: 'choice', type: 'radio', value: 'yes', checked: false },
      { name: 'file', type: 'file', value: 'preserved' },
      { name: 'missing', type: 'text', value: 'preserved' },
      { type: 'text', value: 'anonymous' },
    ]
    const requestAnimationFrame = vi.fn((callback: () => void) => {
      callback()
      return 1
    })
    vi.stubGlobal('document', { querySelectorAll: () => controls })
    vi.stubGlobal('window', { requestAnimationFrame })
    const values = { title: 'Post', tags: ['a', 'b'], enabled: 'on', choice: 'yes', file: 'ignored' }
    svelteClientInternals.scheduleBrowserFormValueRestore(values)
    await Promise.resolve()
    expect(controls[0]?.value).toBe('Post')
    expect(controls[1]?.checked).toBe(true)
    expect(controls[2]?.checked).toBe(false)
    expect(controls[3]?.checked).toBe(true)
    expect(controls[4]?.checked).toBe(true)
    expect(controls[5]?.value).toBe('preserved')
    expect(requestAnimationFrame).toHaveBeenCalled()

    vi.stubGlobal('document', {})
    expect(() => svelteClientInternals.restoreBrowserFormValues(values)).not.toThrow()
  })

  it('uses timeout restoration when animation frames are unavailable', () => {
    const setTimeout = vi.fn((callback: () => void) => {
      callback()
      return 1
    })
    vi.stubGlobal('document', { querySelectorAll: () => [] })
    vi.stubGlobal('window', { setTimeout })
    svelteClientInternals.scheduleBrowserFormValueRestore({})
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 0)
  })

  it('parses, reads, and clears flashed cookies safely', () => {
    expect(svelteClientInternals.safeDecodeURIComponent('%')).toBe('%')
    expect(svelteClientInternals.safeDecodeURIComponent('%20')).toBe(' ')
    expect(svelteClientInternals.parseValidationFlashCookie(undefined)).toBeUndefined()
    expect(svelteClientInternals.parseValidationFlashCookie('invalid')).toBeUndefined()
    const payload = { ok: false, status: 422, valid: false, values: { title: 'Post' }, errors: { title: ['Required'] } }
    expect(svelteClientInternals.parseValidationFlashCookie(encodeURIComponent(JSON.stringify(payload)))).toEqual(payload)

    expect(svelteClientInternals.readBrowserCookie('flash')).toBeUndefined()
    const document = { cookie: 'broken; other=value; flash=payload' }
    vi.stubGlobal('document', document)
    expect(svelteClientInternals.readBrowserCookie('flash')).toBe('payload')
    expect(svelteClientInternals.readBrowserCookie('missing')).toBeUndefined()
    svelteClientInternals.clearBrowserCookie('flash')
    expect(document.cookie).toContain('Max-Age=0')
    vi.stubGlobal('document', undefined)
    expect(() => svelteClientInternals.clearBrowserCookie('flash')).not.toThrow()
  })

  it('matches form states to schemas', () => {
    const state = { valid: false, values: { title: 'Post', profile: { email: 'a@b.test' } }, errors: {} }
    expect(svelteClientInternals.isFormState(state)).toBe(true)
    expect(svelteClientInternals.isFormState({ valid: false })).toBe(false)
    expect(svelteClientInternals.stateMatchesSchema(schema as never, state as never)).toBe(true)
    expect(svelteClientInternals.stateMatchesSchema(schema as never, { ...state, values: { unrelated: true } } as never)).toBe(false)
  })

  it('recognizes forms, actions, response content, and normalized field names', () => {
    vi.stubGlobal('window', { location: { href: 'https://example.test/posts', pathname: '/posts' } })
    const form = { tagName: 'FORM', method: 'POST', action: 'https://example.test/posts?/save' }
    expect(svelteClientInternals.resolveSubmittedForm(form as never)).toBe(form)
    expect(svelteClientInternals.resolveSubmittedForm({ tagName: 'DIV' } as never)).toBeUndefined()
    expect(svelteClientInternals.isNativePostForm(form)).toBe(true)
    expect(svelteClientInternals.isNativePostForm({ method: 'GET' })).toBe(false)
    expect(svelteClientInternals.isNativePostForm({})).toBe(false)
    expect(svelteClientInternals.isSvelteKitActionForm(form)).toBe(true)
    expect(svelteClientInternals.isSvelteKitActionForm({ method: 'GET' })).toBe(false)
    expect(svelteClientInternals.isSvelteKitActionForm({ method: 'POST', action: '' })).toBe(false)
    expect(svelteClientInternals.isSvelteKitActionForm({ method: 'POST' })).toBe(false)
    expect(svelteClientInternals.normalizeFormDataName('tags[]')).toBe('tags')
    expect(svelteClientInternals.normalizeFormDataName('title')).toBe('title')
    expect(svelteClientInternals.currentLocationHref()).toBe('https://example.test/posts')
    expect(svelteClientInternals.getBrowserCookiePath()).toBe('/posts')
    expect(svelteClientInternals.isJsonResponse(Response.json({}))).toBe(true)
    expect(svelteClientInternals.isJsonResponse(new Response('', { headers: { 'content-type': 'application/problem+json; charset=utf-8' } }))).toBe(true)
    expect(svelteClientInternals.isJsonResponse(new Response('text'))).toBe(false)
  })

  it('counts matching form fields and handles unsupported FormData construction', () => {
    class TestFormData {
      entries(): IterableIterator<[string, string]> {
        return ([['title', 'Post'], ['tags[]', 'a']] as Array<[string, string]>)[Symbol.iterator]()
      }
    }
    vi.stubGlobal('FormData', TestFormData)
    expect(svelteClientInternals.countMatchingFormFields({} as never, ['title', 'tags', 'missing'])).toBe(2)
    vi.stubGlobal('FormData', class { constructor() { throw new Error('unsupported') } })
    expect(svelteClientInternals.countMatchingFormFields({} as never, ['title'])).toBe(0)
  })

  it('submits and redirects through available browser primitives', () => {
    const submit = vi.fn()
    svelteClientInternals.submitNativeForm({ submit })
    expect(submit).toHaveBeenCalled()
    const assign = vi.fn()
    vi.stubGlobal('window', { location: { assign, href: '', pathname: '' } })
    svelteClientInternals.redirectBrowser('/login')
    expect(assign).toHaveBeenCalledWith('/login')
    const location = { href: '', pathname: '' }
    vi.stubGlobal('window', { location })
    svelteClientInternals.redirectBrowser('/dashboard')
    expect(location.href).toBe('/dashboard')
    expect(svelteClientInternals.getBrowserCookiePath()).toBe('/')
  })

  it('normalizes every SvelteKit action response shape', async () => {
    const context = {
      action: '/save',
      method: 'POST',
      values: { title: 'Post' },
      formData: new FormData(),
    }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    fetchMock.mockResolvedValueOnce(new Response('plain', { status: 201 }))
    await expect(svelteClientInternals.submitSvelteKitAction(context)).resolves.toMatchObject({ ok: true, status: 201 })

    fetchMock.mockResolvedValueOnce(Response.json({ custom: true }))
    await expect(svelteClientInternals.submitSvelteKitAction(context)).resolves.toEqual({ custom: true })

    fetchMock.mockResolvedValueOnce(Response.json({ type: 'failure', status: 422, data: '{' }))
    await expect(svelteClientInternals.submitSvelteKitAction(context)).resolves.toMatchObject({
      ok: false,
      status: 422,
      errors: { _root: [expect.any(String)] },
    })

    const failure = { ok: false, status: 422, valid: false, values: {}, errors: { title: ['Required'] } }
    fetchMock.mockResolvedValueOnce(Response.json({ type: 'failure', status: 422, data: JSON.stringify(failure) }))
    await expect(svelteClientInternals.submitSvelteKitAction(context)).resolves.toEqual(failure)

    fetchMock.mockResolvedValueOnce(Response.json({ type: 'redirect', status: 303, location: '/done' }))
    const location = { href: '', pathname: '/' }
    vi.stubGlobal('window', { location })
    await expect(svelteClientInternals.submitSvelteKitAction(context)).resolves.toMatchObject({ ok: true, status: 303 })
    expect(location.href).toBe('/done')

    fetchMock.mockResolvedValueOnce(Response.json({ type: 'success', status: 200, data: { id: 1 } }))
    await expect(svelteClientInternals.submitSvelteKitAction(context)).resolves.toEqual({ ok: true, status: 200, data: { id: 1 } })

    fetchMock.mockResolvedValueOnce(Response.json({ type: 'error', error: 'broken' }, { status: 500, statusText: 'Failure' }))
    await expect(svelteClientInternals.submitSvelteKitAction(context)).resolves.toMatchObject({ status: 500, message: 'Failure' })

    const getContext = { ...context, method: 'GET' }
    fetchMock.mockResolvedValueOnce(Response.json({ type: 'success', status: 200 }))
    await svelteClientInternals.submitSvelteKitAction(getContext)
    expect(fetchMock).toHaveBeenLastCalledWith('/save', expect.not.objectContaining({ body: expect.anything() }))

    vi.stubGlobal('fetch', undefined)
    await expect(svelteClientInternals.submitSvelteKitAction(context)).resolves.toMatchObject({ ok: true, status: 200, data: context.values })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { location: { href: '/fallback', pathname: ';' } })
    fetchMock.mockResolvedValueOnce(Response.json({ type: 'success', status: 200 }))
    await svelteClientInternals.submitSvelteKitAction({ ...context, action: undefined })
    expect(fetchMock).toHaveBeenLastCalledWith('/fallback', expect.any(Object))
    expect(svelteClientInternals.getBrowserCookiePath()).toBe('/')
  })

  it('registers browser forms, intercepts matching submits, and unregisters idempotently', async () => {
    let listener: ((event: { target: unknown, preventDefault(): void, stopImmediatePropagation(): void }) => void) | undefined
    const addEventListener = vi.fn((_type: string, next: typeof listener) => { listener = next })
    vi.stubGlobal('window', { addEventListener, location: { href: 'https://example.test/posts', pathname: '/posts' } })
    vi.stubGlobal('FormData', class {
      entries(): IterableIterator<[string, string]> {
        return ([['title', 'Post']] as Array<[string, string]>)[Symbol.iterator]()
      }
    })
    const submit = vi.fn(async () => ({ ok: true }))
    const unregister = svelteClientInternals.registerForm(schema as never, { submit } as never)
    svelteClientInternals.ensureSubmitListener()
    const preventDefault = vi.fn()
    const stopImmediatePropagation = vi.fn()
    listener?.({
      target: { tagName: 'FORM', method: 'POST', action: '/save' },
      preventDefault,
      stopImmediatePropagation,
    })
    await Promise.resolve()
    expect(preventDefault).toHaveBeenCalled()
    expect(stopImmediatePropagation).toHaveBeenCalled()
    expect(submit).toHaveBeenCalled()
    vi.stubGlobal('FormData', class {
      entries(): IterableIterator<[string, string]> {
        return ([] as Array<[string, string]>)[Symbol.iterator]()
      }
    })
    expect(svelteClientInternals.resolveRegisteredForm({ method: 'POST' })).toBeUndefined()
    unregister()
    unregister()

    expect(svelteClientInternals.resolveRegisteredForm({ method: 'GET' })).toBeUndefined()

    const nativeSubmit = vi.fn()
    const fetchMock = vi.fn(async () => Response.json({ type: 'failure', status: 422, data: '{' }))
    vi.stubGlobal('fetch', fetchMock)
    listener?.({
      target: { tagName: 'FORM', method: 'POST', action: 'https://example.test/posts?/native', submit: nativeSubmit },
      preventDefault,
      stopImmediatePropagation,
    })
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled()
      expect(nativeSubmit).toHaveBeenCalled()
    })

    listener?.({ target: null, preventDefault, stopImmediatePropagation })
    listener?.({ target: { tagName: 'FORM', method: 'POST', action: '/ordinary' }, preventDefault, stopImmediatePropagation })
    const serverUnregister = (() => {
      vi.stubGlobal('window', undefined)
      return svelteClientInternals.registerForm(schema as never, { submit } as never)
    })()
    expect(() => serverUnregister()).not.toThrow()
  })

  it('falls back when action URLs are malformed', () => {
    vi.stubGlobal('window', { location: {} })
    expect(svelteClientInternals.isSvelteKitActionForm({ method: 'POST', action: '?/save' })).toBe(true)
    expect(svelteClientInternals.isSvelteKitActionForm({ method: 'POST', action: '%' })).toBe(false)
  })

  it('takes matching server-flashed state and rejects mismatched or browser state', () => {
    const payload = { ok: false, status: 422, valid: false, values: { title: 'Post' }, errors: { title: ['Required'] } }
    const cookies = { get: vi.fn(() => encodeURIComponent(JSON.stringify(payload))), set: vi.fn() }
    vi.stubGlobal('__holoSvelteKitRequestEventStore', {
      getStore: () => ({ cookies, url: new URL('https://example.test/posts') }),
    })
    expect(svelteClientInternals.takeFlashedValidationState(schema as never)).toEqual(payload)
    expect(cookies.set).toHaveBeenCalledWith(expect.any(String), '', expect.objectContaining({ path: '/posts', maxAge: 0 }))

    vi.stubGlobal('__holoSvelteKitRequestEventStore', {
      getStore: () => ({ cookies, url: undefined }),
    })
    expect(svelteClientInternals.takeFlashedValidationState(schema as never)).toEqual(payload)
    expect(cookies.set).toHaveBeenLastCalledWith(expect.any(String), '', expect.objectContaining({ path: '/' }))
    expect(svelteClientInternals.takeValidationErrors('default')).toEqual(payload)

    cookies.get.mockReturnValue(encodeURIComponent(JSON.stringify({ ...payload, values: { unrelated: true } })))
    expect(svelteClientInternals.takeFlashedValidationState(schema as never)).toBeUndefined()
    vi.stubGlobal('window', {})
    expect(svelteClientInternals.takeFlashedValidationState(schema as never)).toBeUndefined()
  })

  it('renders non-validation action errors and leaves successful results alone', async () => {
    const form = { method: '', action: '/save', submit: vi.fn() }
    vi.stubGlobal('FormData', class {})
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ type: 'error', error: { message: 'Denied.' } }, { status: 403 })))
    await svelteClientInternals.submitSvelteKitActionForm(form)
    expect(form.submit).not.toHaveBeenCalled()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ type: 'success', status: 200 })))
    await svelteClientInternals.submitSvelteKitActionForm(form)
    expect(form.submit).not.toHaveBeenCalled()
    vi.stubGlobal('window', undefined)
    expect(() => svelteClientInternals.redirectBrowser('/ignored')).not.toThrow()
    svelteClientInternals.renderFormHttpFailure({ ok: false, status: 200 })
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ type: 'error', error: {} }, { status: 200 })))
    await expect(svelteClientInternals.submitSvelteKitAction({
      action: '/save',
      method: 'POST',
      values: {},
      formData: new FormData(),
    })).resolves.toMatchObject({ status: 200 })
  })

  it('wraps ordinary and symbol submit methods while preserving descriptors', async () => {
    const submitSymbol = Symbol('submit')
    const dataSymbol = Symbol('data')
    const ghostSymbol = Symbol('ghost')
    const source = {
      value: 1,
      async submit() { return { ok: false, status: 422 } },
      [submitSymbol]: async () => ({ ok: false, status: 422 }),
      [dataSymbol]: 1,
    }
    const proxy = new Proxy(source, {
      ownKeys(target) {
        return [...Reflect.ownKeys(target), ghostSymbol]
      },
      getOwnPropertyDescriptor(target, key) {
        return key === ghostSymbol ? undefined : Reflect.getOwnPropertyDescriptor(target, key)
      },
    })
    const wrapped = svelteClientInternals.createHttpHandledForm(proxy as never) as unknown as typeof source
    await expect(wrapped.submit()).resolves.toMatchObject({ status: 422 })
    await expect(wrapped[submitSymbol]()).resolves.toMatchObject({ status: 422 })
    expect(wrapped[dataSymbol]).toBe(1)
  })
})
