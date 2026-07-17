import { afterEach, describe, expect, it, vi } from 'vitest'
import { adapterSvelteKitInternals } from '../src'
import { ValidationException, validationInternals } from '@holo-js/forms/schema'

const payload = {
  ok: false as const,
  status: 422,
  valid: false as const,
  message: 'Invalid input.',
  bag: 'default',
  values: {
    title: 'Post',
    password: 'secret',
    nested: { token: 'secret', safe: true },
    list: [1, undefined, { credential: 'secret', value: 'ok' }],
    file: new Date(),
  },
  errors: { title: ['Required.'] },
}

function createEvent(path = '/posts', method = 'POST', accept = 'text/html') {
  const values = new Map<string, string>()
  return {
    url: new URL(`https://example.test${path}`),
    request: {
      method,
      headers: new Headers({ accept }),
    },
    cookies: {
      get: (name: string) => values.get(name),
      set: vi.fn((name: string, value: string) => values.set(name, value)),
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SvelteKit server adapter internals', () => {
  it('normalizes statuses, paths, request kinds, and sensitive keys', () => {
    expect(adapterSvelteKitInternals.toSvelteKitErrorStatus(404)).toBe(404)
    expect(adapterSvelteKitInternals.toSvelteKitErrorStatus(200)).toBe(500)
    expect(adapterSvelteKitInternals.isApiEvent(createEvent('/api/posts') as never)).toBe(true)
    expect(adapterSvelteKitInternals.isApiEvent(createEvent('/posts') as never)).toBe(false)
    expect(adapterSvelteKitInternals.isSvelteKitActionJsonRequest(createEvent('/posts', 'post', 'APPLICATION/JSON') as never)).toBe(true)
    expect(adapterSvelteKitInternals.isSvelteKitActionJsonRequest(createEvent('/posts', 'GET', 'application/json') as never)).toBe(false)
    expect(adapterSvelteKitInternals.normalizeCookiePath(createEvent('/posts;a\nb') as never)).toBe('/postsab')
    expect(adapterSvelteKitInternals.normalizeCookiePath({} as never)).toBe('/')
    expect(adapterSvelteKitInternals.normalizeCookiePath({ url: { pathname: '' } } as never)).toBe('/')
    expect(adapterSvelteKitInternals.normalizeCookiePath({ url: { pathname: ';' } } as never)).toBe('/')
    for (const key of ['_private', 'pass_word', 'auth-token', 'client secret', 'credential']) {
      expect(adapterSvelteKitInternals.isSensitiveFlashKey(key)).toBe(true)
    }
    expect(adapterSvelteKitInternals.isSensitiveFlashKey('title')).toBe(false)
  })

  it('filters flash values recursively and encodes only safe data', () => {
    expect(adapterSvelteKitInternals.filterFlashValue(null)).toBeNull()
    expect(adapterSvelteKitInternals.filterFlashValue('value')).toBe('value')
    expect(adapterSvelteKitInternals.filterFlashValue(new Date())).toBeUndefined()
    expect(adapterSvelteKitInternals.filterFlashValues(payload.values)).toEqual({
      title: 'Post',
      nested: { safe: true },
      list: [1, { value: 'ok' }],
    })
    const encoded = adapterSvelteKitInternals.encodeValidationFlashPayload(payload as never)
    expect(JSON.parse(decodeURIComponent(encoded))).toMatchObject({
      values: { title: 'Post', nested: { safe: true } },
    })
  })

  it('validates serialized payloads and creates action responses', async () => {
    expect(adapterSvelteKitInternals.isSerializedValidationException(payload)).toBe(true)
    expect(adapterSvelteKitInternals.isSerializedValidationException({ ...payload, errors: null })).toBe(false)
    const event = createEvent()
    const original = new Response(JSON.stringify({ type: 'error' }), {
      status: 500,
      headers: { 'content-type': 'application/json', 'x-test': 'yes' },
    })
    const failure = adapterSvelteKitInternals.createValidationActionFailureResponse(payload as never, original, true)
    expect(failure.status).toBe(200)
    expect(failure.headers.get('x-holo-validation-flash')).toBe('1')
    const redirect = adapterSvelteKitInternals.createValidationActionRedirectResponse(event as never, payload as never)
    expect(redirect.status).toBe(303)
    expect(redirect.headers.get('location')).toBe('/posts')
    expect(redirect.headers.get('set-cookie')).toContain('HOLO-SVELTEKIT-VALIDATION=')
    expect(await failure.json()).toMatchObject({ type: 'failure', status: 422 })
    expect(adapterSvelteKitInternals.createValidationActionRedirectResponse({ ...event, url: undefined } as never, payload as never).headers.get('location')).toBe('/')
    expect(adapterSvelteKitInternals.toSvelteKitValidationBody(payload as never)).toBe(payload)
  })

  it('preserves explicit options and creates native authorization errors', () => {
    const authRequest = { getCookie: vi.fn(), getHeader: vi.fn() }
    const authorizationError = { createError: vi.fn() }
    const explicit = adapterSvelteKitInternals.resolveSvelteKitOptions({ authRequest, authorizationError })
    expect(explicit.authRequest).toBe(authRequest)
    expect(explicit.authorizationError).toBe(authorizationError)

    const defaults = adapterSvelteKitInternals.resolveSvelteKitOptions({})
    const createError = defaults.authorizationError?.createError
    expect(createError).toBeTypeOf('function')
    expect(() => createError?.({ status: 404 })).toThrow()
    expect(() => createError?.({ status: 403, message: 'Denied.' })).toThrow()
  })

  it('registers the validation thrower once and handles absent and active request contexts', () => {
    adapterSvelteKitInternals.registerValidationExceptionThrower()
    adapterSvelteKitInternals.registerValidationExceptionThrower()
    const exception = ValidationException.withMessages({ title: ['Required.'] })
    expect(adapterSvelteKitInternals.serializeValidationException(exception)).toEqual(exception.toJSON())
    expect(adapterSvelteKitInternals.serializeValidationException(new Error('other'))).toBeUndefined()
    expect(() => validationInternals.throwValidationException(exception)).toThrow(exception)
  })

  it('flashes and retrieves failures by event, request, and request key', () => {
    const event = createEvent()
    adapterSvelteKitInternals.flashValidationPayload(event as never, payload as never)
    expect(event.cookies.set).toHaveBeenCalled()
    adapterSvelteKitInternals.flashValidationPayload({ ...event, url: undefined } as never, payload as never)

    adapterSvelteKitInternals.rememberValidationActionFailure(event as never, payload as never)
    expect(adapterSvelteKitInternals.takeValidationActionFailure(event as never)).toEqual(payload)
    expect(adapterSvelteKitInternals.takeValidationActionFailure({ ...event, url: undefined } as never)).toBeUndefined()

    const noMethod = { ...createEvent('/method'), request: { headers: new Headers() } }
    expect(adapterSvelteKitInternals.getValidationActionFailureKey(noMethod as never)).toBe(`GET ${noMethod.url.href}`)

    const requestEvent = createEvent('/request')
    adapterSvelteKitInternals.rememberValidationActionFailure(requestEvent as never, payload as never)
    expect(adapterSvelteKitInternals.takeValidationActionFailure({
      ...requestEvent,
      request: requestEvent.request,
    } as never)).toEqual(payload)

    const keyedEvent = createEvent('/keyed')
    adapterSvelteKitInternals.rememberValidationActionFailure(keyedEvent as never, payload as never)
    expect(adapterSvelteKitInternals.takeValidationActionFailure(createEvent('/keyed') as never)).toEqual(payload)

    const noUrl = { ...createEvent('/none'), url: undefined }
    adapterSvelteKitInternals.rememberValidationActionFailure(noUrl as never, payload as never)
    expect(adapterSvelteKitInternals.takeValidationActionFailure({ ...noUrl, request: { ...noUrl.request } } as never)).toBeUndefined()

    const eventWithoutKey = { ...createEvent('/event-no-key'), url: undefined }
    adapterSvelteKitInternals.rememberValidationActionFailure(eventWithoutKey as never, payload as never)
    expect(adapterSvelteKitInternals.takeValidationActionFailure(eventWithoutKey as never)).toEqual(payload)

    const requestWithoutKey = { ...createEvent('/request-no-key'), url: undefined }
    adapterSvelteKitInternals.rememberValidationActionFailure(requestWithoutKey as never, payload as never)
    expect(adapterSvelteKitInternals.takeValidationActionFailure({
      ...requestWithoutKey,
      request: requestWithoutKey.request,
    } as never)).toEqual(payload)
  })

  it('maps API, browser, malformed, and serialized action responses', async () => {
    const api = createEvent('/api/posts')
    adapterSvelteKitInternals.rememberValidationActionFailure(api as never, payload as never)
    const apiResponse = await adapterSvelteKitInternals.mapValidationActionResponse(api as never, new Response('original'))
    expect(apiResponse.status).toBe(422)

    const apiWithoutPayload = createEvent('/api/none')
    const original = new Response('original')
    expect(await adapterSvelteKitInternals.mapValidationActionResponse(apiWithoutPayload as never, original)).toBe(original)

    const browser = createEvent('/posts')
    adapterSvelteKitInternals.rememberValidationActionFailure(browser as never, payload as never)
    expect((await adapterSvelteKitInternals.mapValidationActionResponse(browser as never, original)).status).toBe(303)

    const json = createEvent('/posts', 'POST', 'application/json')
    adapterSvelteKitInternals.rememberValidationActionFailure(json as never, payload as never)
    expect((await adapterSvelteKitInternals.mapValidationActionResponse(json as never, original)).status).toBe(200)

    expect(await adapterSvelteKitInternals.mapValidationActionResponse(createEvent('/posts', 'GET') as never, original)).toBe(original)
    expect(await adapterSvelteKitInternals.mapValidationActionResponse(createEvent('/posts', 'POST', 'application/json') as never, new Response(null))).toBeInstanceOf(Response)
    expect(await adapterSvelteKitInternals.mapValidationActionResponse(createEvent('/posts', 'POST', 'application/json') as never, new Response('plain'))).toBeInstanceOf(Response)
    expect(await adapterSvelteKitInternals.mapValidationActionResponse(createEvent('/posts', 'POST', 'application/json') as never, new Response('{', { headers: { 'content-type': 'application/json' } }))).toBeInstanceOf(Response)
    expect(await adapterSvelteKitInternals.mapValidationActionResponse(createEvent('/posts', 'POST', 'application/json') as never, Response.json({ type: 'success' }))).toBeInstanceOf(Response)

    const serialized = Response.json({ type: 'error', error: payload }, { status: 500 })
    const mapped = await adapterSvelteKitInternals.mapValidationActionResponse(createEvent('/posts', 'POST', 'application/json') as never, serialized)
    expect(mapped.status).toBe(200)
  })
})
