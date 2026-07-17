import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  initializeHolo: vi.fn(),
  cookieGet: vi.fn(),
  cookieSet: vi.fn(),
  headers: vi.fn(),
  redirect: vi.fn(),
}))

vi.mock('@holo-js/core/runtime', () => ({
  initializeHolo: mocks.initializeHolo,
}))

vi.mock('next/headers.js', () => ({
  cookies: async () => ({ get: mocks.cookieGet, set: mocks.cookieSet }),
  headers: mocks.headers,
}))

vi.mock('next/navigation.js', () => ({
  redirect: mocks.redirect,
}))

const {
  adapterNextRuntimeInternals,
  createNextHoloHelpers,
  createNextRequestContext,
  runWithNextRequest,
} = await import('../src/runtime')

describe('Next runtime entry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.cookieGet.mockReturnValue(undefined)
    mocks.headers.mockResolvedValue(new Headers())
  })

  afterEach(() => {
    delete (globalThis as typeof globalThis & { __holoNextAuthRequestRunner?: unknown }).__holoNextAuthRequestRunner
  })

  it('parses request and response cookies at framework boundaries', () => {
    const request = new Request('https://app.test', {
      headers: { cookie: 'plain=value; encoded%20name=encoded%20value; invalid; empty=' },
    })
    const context = createNextRequestContext(request)
    expect(context.cookies.get('plain')).toEqual({ value: 'value' })
    expect(context.cookies.get('encoded name')).toEqual({ value: 'encoded value' })
    expect(context.cookies.get('missing')).toBeUndefined()
    expect(createNextRequestContext(new Request('https://app.test')).cookies.get('missing')).toBeUndefined()
    expect(adapterNextRuntimeInternals.parseRequestCookies(' =value')).toEqual(new Map())

    const nextContext = createNextRequestContext(Object.assign(new Request('https://app.test'), {
      cookies: { get: (name: string) => name === 'native' ? { value: 'cookie' } : undefined },
    }))
    expect(nextContext.cookies.get('native')).toEqual({ value: 'cookie' })

    expect(adapterNextRuntimeInternals.safeDecodeCookieSegment('%')).toBe('%')
    expect(adapterNextRuntimeInternals.parseResponseCookie('')).toBeNull()
    expect(adapterNextRuntimeInternals.parseResponseCookie('invalid')).toBeNull()
    expect(adapterNextRuntimeInternals.parseResponseCookie('sid=value; Path=/; Domain=app.test; Max-Age=30; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Secure; HttpOnly; SameSite=Strict; Partitioned; Unknown=x')).toEqual({
      name: 'sid',
      value: 'value',
      options: {
        path: '/', domain: 'app.test', maxAge: 30, expires: new Date('Wed, 21 Oct 2015 07:28:00 GMT'),
        secure: true, httpOnly: true, sameSite: 'strict', partitioned: true,
      },
    })
    expect(adapterNextRuntimeInternals.parseResponseCookie('sid=value; Max-Age=no; Expires=no; SameSite=invalid; ;')).toEqual({
      name: 'sid', value: 'value', options: {},
    })
  })

  it('uses scoped requests and the installed auth request runner', async () => {
    const request = createNextRequestContext(new Request('https://app.test', {
      headers: { cookie: 'sid=scoped', authorization: 'Bearer token' },
    }))
    const runner = vi.fn(<TValue>(_accessors: unknown, callback: () => TValue) => callback())
    const runtime = {
      runWithAuthRequestAccessors: runner,
      config: vi.fn((path: string) => path),
      projectRoot: '/project', loadedConfig: { app: {} }, registry: {}, session: 'session', auth: 'auth',
    }
    mocks.initializeHolo.mockResolvedValue(runtime)
    const helpers = createNextHoloHelpers({ projectRoot: '/project' })
    await helpers.getApp()

    await runWithNextRequest(request, async () => {
      const options = mocks.initializeHolo.mock.calls.at(-1)?.[1]
      await expect(options.authRequest.getCookie('sid')).resolves.toBe('scoped')
      await expect(options.authRequest.getCookie('missing')).resolves.toBeUndefined()
      await expect(options.authRequest.getHeader('authorization')).resolves.toBe('Bearer token')
      await expect(options.authRequest.getHeader('missing')).resolves.toBeUndefined()
    })
    expect(runner).toHaveBeenCalled()
    await expect(helpers.getProject()).resolves.toMatchObject({ projectRoot: '/project', runtime })
    await expect(helpers.getSession()).resolves.toBe('session')
    await expect(helpers.getAuth()).resolves.toBe('auth')
    await expect(helpers.useConfig('app')).resolves.toBe('app')
    await expect(helpers.config('app')).resolves.toBe('app')
  })

  it('uses Next request modules and handles missing request scopes', async () => {
    mocks.cookieGet.mockReturnValue({ value: 'native' })
    mocks.headers.mockResolvedValue(new Headers({ authorization: 'Bearer native' }))
    const accessors = adapterNextRuntimeInternals.resolveNextAuthRequestAccessors()
    if (!accessors.getCookie || !accessors.getHeader || !accessors.appendResponseCookie || !accessors.redirectResponse) {
      throw new Error('Next auth request accessors are incomplete.')
    }
    await expect(accessors.getCookie('sid')).resolves.toBe('native')
    mocks.cookieGet.mockReturnValue(undefined)
    await expect(accessors.getCookie('missing')).resolves.toBeUndefined()
    await expect(accessors.getHeader('authorization')).resolves.toBe('Bearer native')
    mocks.headers.mockResolvedValue(new Headers())
    await expect(accessors.getHeader('missing')).resolves.toBeUndefined()
    await accessors.appendResponseCookie('sid=value; Path=/; HttpOnly')
    expect(mocks.cookieSet).toHaveBeenCalledWith('sid', 'value', { path: '/', httpOnly: true })
    await accessors.appendResponseCookie('invalid')
    mocks.redirect.mockImplementation(() => { throw new Error('redirect') })
    await expect(accessors.redirectResponse('https://app.test/login')).rejects.toThrow('redirect')

    mocks.cookieGet.mockImplementation(() => { throw new Error('outside a request scope') })
    mocks.headers.mockRejectedValue(new Error('outside a request scope'))
    mocks.cookieSet.mockImplementation(() => { throw new Error('outside a request scope') })
    await expect(accessors.getCookie('sid')).resolves.toBeUndefined()
    await expect(accessors.getHeader('authorization')).resolves.toBeUndefined()
    await expect(accessors.appendResponseCookie('sid=value')).resolves.toBeUndefined()
    expect(adapterNextRuntimeInternals.isMissingNextRequestScope('failure')).toBe(false)

    mocks.cookieGet.mockImplementation(() => { throw new Error('cookie failure') })
    mocks.headers.mockRejectedValue(new Error('header failure'))
    mocks.cookieSet.mockImplementation(() => { throw new Error('set failure') })
    await expect(accessors.getCookie('sid')).rejects.toThrow('cookie failure')
    await expect(accessors.getHeader('authorization')).rejects.toThrow('header failure')
    await expect(accessors.appendResponseCookie('sid=value')).rejects.toThrow('set failure')
  })

  it('maps default authorization errors and preserves explicit runtime options', async () => {
    const runtime = {
      runWithAuthRequestAccessors: <TValue>(_accessors: unknown, callback: () => TValue) => callback(),
      config: vi.fn(), projectRoot: '/project', loadedConfig: {}, registry: {},
    }
    mocks.initializeHolo.mockResolvedValue(runtime)
    await createNextHoloHelpers({ projectRoot: '/project' }).getApp()
    const options = mocks.initializeHolo.mock.calls.at(-1)?.[1]
    expect(() => options.authorizationError.createError({ status: 404, message: 'Missing' })).toThrow(expect.objectContaining({
      digest: 'NEXT_HTTP_ERROR_FALLBACK;404', message: 'Missing',
    }))
    expect(() => options.authorizationError.createError({ status: 404 })).toThrow(expect.objectContaining({
      digest: 'NEXT_HTTP_ERROR_FALLBACK;404', message: 'Resource not found.',
    }))
    expect(() => options.authorizationError.createError({ status: 403, message: 'Denied' })).toThrow(expect.objectContaining({
      digest: 'NEXT_HTTP_ERROR_FALLBACK;403', message: 'Denied',
    }))
    expect(() => options.authorizationError.createError({ status: 403 })).toThrow(expect.objectContaining({
      digest: 'NEXT_HTTP_ERROR_FALLBACK;403', message: 'Forbidden',
    }))

    const authRequest = { getCookie: vi.fn() }
    const authorizationError = { createError: vi.fn() }
    await createNextHoloHelpers({ projectRoot: '/project', authRequest, authorizationError }).getApp()
    expect(mocks.initializeHolo.mock.calls.at(-1)?.[1]).toMatchObject({ authRequest, authorizationError })
  })
})
