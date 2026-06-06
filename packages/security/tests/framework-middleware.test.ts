import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineSecurityConfig } from '@holo-js/config'
import {
  configureSecurityRuntime,
  csrf,
  csrfInternals,
  resetSecurityRuntime,
} from '../src'
import {
  SECURITY_CLIENT_CONFIG_COOKIE,
  createSecurityClientConfig,
  serializeSecurityClientConfig,
} from '../src/client-config'
import { getSecurityRuntime } from '../src/runtime'

function configureSecurity(except: readonly string[] = []): void {
  configureSecurityRuntime({
    config: defineSecurityConfig({
      csrf: {
        enabled: true,
        except,
      },
    }),
    csrfSigningKey: 'test-signing-key',
  })
}

afterEach(() => {
  vi.doUnmock('h3')
  vi.doUnmock('next/server')
  vi.resetModules()
  resetSecurityRuntime()
})

describe('@holo-js/security framework csrf middleware', () => {
  it('wires Next csrf cookies and 419 responses without auth', async () => {
    vi.doMock('next/server', () => ({
      NextResponse: {
        next() {
          const response = new Response(null, {
            headers: {
              'x-middleware-next': '1',
            },
          })

          return Object.assign(response, {
            cookies: {
              set(name: string, value: string, options: { readonly path?: string, readonly sameSite?: string, readonly secure?: boolean, readonly httpOnly?: boolean }) {
                response.headers.append('set-cookie', [
                  `${name}=${encodeURIComponent(value)}`,
                  options.path ? `Path=${options.path}` : undefined,
                  options.sameSite ? `SameSite=${options.sameSite[0]?.toUpperCase()}${options.sameSite.slice(1)}` : undefined,
                  options.secure ? 'Secure' : undefined,
                  options.httpOnly ? 'HttpOnly' : undefined,
                ].filter((attribute): attribute is string => typeof attribute === 'string').join('; '))
              },
            },
          })
        },
      },
    }))
    configureSecurity()

    const { csrfProtection } = await import('../src/next/server')
    const clientConfig = serializeSecurityClientConfig(createSecurityClientConfig(getSecurityRuntime().config))
    const getRequest = Object.assign(new Request('https://app.test/login'), {
      cookies: {
        get: vi.fn(() => undefined),
      },
      nextUrl: new URL('https://app.test/login'),
    })
    const getResponse = await csrfProtection()(getRequest)
    const token = decodeURIComponent(getResponse?.headers.get('set-cookie')?.split(';', 1)[0]?.slice('XSRF-TOKEN='.length) ?? '')

    expect(getResponse?.headers.get('x-middleware-next')).toBe('1')
    expect(getResponse?.headers.get('set-cookie')).toContain('XSRF-TOKEN=')
    expect(getResponse?.headers.get('set-cookie')).toContain(`${SECURITY_CLIENT_CONFIG_COOKIE}=`)
    expect(getResponse?.headers.get('set-cookie')).toContain(encodeURIComponent('"cookie":"XSRF-TOKEN"'))
    expect(getResponse?.headers.get('set-cookie')).toContain(encodeURIComponent('"field":"_token"'))
    expect(getResponse?.headers.get('set-cookie')).toContain('Secure')

    const existingCookieRequest = Object.assign(new Request('https://app.test/login', {
      headers: {
        cookie: `XSRF-TOKEN=${token}; ${SECURITY_CLIENT_CONFIG_COOKIE}=${encodeURIComponent(clientConfig)}`,
      },
    }), {
      cookies: {
        get: vi.fn((name: string) => {
          if (name === 'XSRF-TOKEN') return { value: token }
          if (name === SECURITY_CLIENT_CONFIG_COOKIE) return { value: clientConfig }
          return undefined
        }),
      },
    })
    const existingCookieResponse = await csrfProtection()(existingCookieRequest)
    expect(existingCookieResponse).toBeUndefined()

    const staleConfigRequest = Object.assign(new Request('https://app.test/login', {
      headers: {
        cookie: `XSRF-TOKEN=${token}; ${SECURITY_CLIENT_CONFIG_COOKIE}=stale`,
      },
    }), {
      cookies: {
        get: vi.fn((name: string) => {
          if (name === 'XSRF-TOKEN') return token
          if (name === SECURITY_CLIENT_CONFIG_COOKIE) return { value: 'stale' }
          return undefined
        }),
      },
    })
    const staleConfigResponse = await csrfProtection()(staleConfigRequest)
    const staleConfigSetCookie = staleConfigResponse?.headers.get('set-cookie')
    expect(staleConfigSetCookie).not.toContain('XSRF-TOKEN=')
    expect(staleConfigSetCookie).toContain(`${SECURITY_CLIENT_CONFIG_COOKIE}=`)

    const invalidCsrfRequest = Object.assign(new Request('https://app.test/login', {
      headers: {
        cookie: `XSRF-TOKEN=forged-token; ${SECURITY_CLIENT_CONFIG_COOKIE}=${encodeURIComponent(clientConfig)}`,
      },
    }), {
      cookies: {
        get: vi.fn((name: string) => {
          if (name === 'XSRF-TOKEN') return { value: 'forged-token' }
          if (name === SECURITY_CLIENT_CONFIG_COOKIE) return { value: clientConfig }
          return undefined
        }),
      },
    })
    const invalidCsrfResponse = await csrfProtection()(invalidCsrfRequest)
    expect(invalidCsrfResponse?.headers.get('set-cookie')).toContain('XSRF-TOKEN=')
    expect(invalidCsrfResponse?.headers.get('set-cookie')).not.toContain(`${SECURITY_CLIENT_CONFIG_COOKIE}=`)

    const headRequest = Object.assign(new Request('https://app.test/login', {
      method: 'HEAD',
      headers: {
        cookie: `XSRF-TOKEN=${token}; ${SECURITY_CLIENT_CONFIG_COOKIE}=${encodeURIComponent(clientConfig)}`,
      },
    }), {
      cookies: {
        get: vi.fn((name: string) => {
          if (name === 'XSRF-TOKEN') return { value: token }
          if (name === SECURITY_CLIENT_CONFIG_COOKIE) return { value: clientConfig }
          return undefined
        }),
      },
    })
    const headResponse = await csrfProtection()(headRequest)
    expect(headResponse).toBeUndefined()

    resetSecurityRuntime()
    await expect(csrfProtection()(Object.assign(new Request('https://app.test/login', {
      method: 'POST',
    }), {
      cookies: {
        get: vi.fn(() => undefined),
      },
    }))).rejects.toThrow(/Security runtime/)
    configureSecurity()

    const denied = await csrfProtection()(Object.assign(new Request('https://app.test/login', {
      method: 'POST',
      body: new URLSearchParams({
        email: 'ava@example.com',
      }),
    }), {
      cookies: {
        get: vi.fn(() => undefined),
      },
    }))
    expect(denied?.status).toBe(419)

    const allowed = await csrfProtection()(Object.assign(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: `XSRF-TOKEN=${token}`,
      },
      body: new URLSearchParams({
        _token: token,
      }),
    }), {
      cookies: {
        get: vi.fn(() => ({ value: token })),
      },
    }))
    expect(allowed).toBeUndefined()
  })

  it('wires Nuxt csrf cookies, request body verification, and exceptions without auth', async () => {
    const writes: Array<{
      readonly name: string
      readonly value: string
      readonly options: object
    }> = []
    const state = {
      method: 'GET',
      url: new URL('https://app.test/login'),
      headers: {} as Record<string, string | undefined>,
      cookie: undefined as string | undefined,
      clientConfigCookie: undefined as string | undefined,
      body: undefined as Buffer | undefined,
    }
    vi.doMock('h3', () => ({
      createError(input: { readonly statusCode: number, readonly message?: string }) {
        return Object.assign(new Error(input.message), { statusCode: input.statusCode })
      },
      defineEventHandler<TValue>(handler: TValue) {
        return handler
      },
      getCookie(_event: unknown, name: string) {
        if (name === 'XSRF-TOKEN') return state.cookie
        if (name === SECURITY_CLIENT_CONFIG_COOKIE) return state.clientConfigCookie
        return undefined
      },
      getMethod() {
        return state.method
      },
      getRequestHeaders() {
        return state.headers
      },
      getRequestURL() {
        return state.url
      },
      async readRawBody() {
        return state.body
      },
      setCookie(_event: unknown, name: string, value: string, options: object) {
        writes.push({ name, value, options })
      },
    }))
    configureSecurity(['/webhooks/*'])

    const { csrfProtection } = await import('../src/nuxt/server')
    const middleware = csrfProtection()
    await middleware({ node: { req: { headers: {} } } })
    const token = writes[0]?.value ?? ''
    const clientConfig = serializeSecurityClientConfig(createSecurityClientConfig(getSecurityRuntime().config))

    expect(writes).toEqual([
      {
        name: 'XSRF-TOKEN',
        value: token,
        options: {
          httpOnly: false,
          path: '/',
          sameSite: 'lax',
          secure: true,
        },
      },
      {
        name: SECURITY_CLIENT_CONFIG_COOKIE,
        value: JSON.stringify({
          csrf: {
            field: '_token',
            cookie: 'XSRF-TOKEN',
          },
        }),
        options: {
          httpOnly: false,
          path: '/',
          sameSite: 'lax',
          secure: true,
        },
      },
    ])

    writes.length = 0
    state.cookie = token
    state.clientConfigCookie = clientConfig
    state.headers = {
      cookie: `XSRF-TOKEN=${token}; ${SECURITY_CLIENT_CONFIG_COOKIE}=${encodeURIComponent(clientConfig)}`,
    }
    await middleware({ node: { req: { headers: {} } } })
    expect(writes).toEqual([])

    state.clientConfigCookie = 'stale'
    await middleware({ node: { req: { headers: {} } } })
    expect(writes).toEqual([
      {
        name: SECURITY_CLIENT_CONFIG_COOKIE,
        value: clientConfig,
        options: {
          httpOnly: false,
          path: '/',
          sameSite: 'lax',
          secure: true,
        },
      },
    ])
    writes.length = 0

    state.cookie = csrfInternals.encodeCsrfToken('old-token')
    state.clientConfigCookie = clientConfig
    state.headers = {
      cookie: `XSRF-TOKEN=${state.cookie}; ${SECURITY_CLIENT_CONFIG_COOKIE}=${encodeURIComponent(clientConfig)}`,
    }
    await middleware({ node: { req: { headers: {} } } })
    expect(writes).toEqual([])
    writes.length = 0

    state.cookie = 'forged-token'
    state.headers = {
      cookie: `XSRF-TOKEN=forged-token; ${SECURITY_CLIENT_CONFIG_COOKIE}=${encodeURIComponent(clientConfig)}`,
    }
    await middleware({ node: { req: { headers: {} } } })
    expect(writes).toHaveLength(1)
    expect(writes[0]?.name).toBe('XSRF-TOKEN')
    writes.length = 0

    state.method = 'POST'
    state.headers = {
      cookie: `XSRF-TOKEN=${token}`,
      'X-CSRF-TOKEN': token,
      'content-type': 'application/x-www-form-urlencoded',
    }
    state.cookie = token
    state.body = Buffer.from(new URLSearchParams({ _token: token }).toString())
    await expect(middleware({ node: { req: { headers: {} } } })).resolves.toBeUndefined()

    state.method = 'HEAD'
    state.headers = {
      'x-array': undefined,
    }
    await expect(middleware({ node: { req: { headers: {} } } })).resolves.toBeUndefined()

    state.body = Buffer.from('')
    state.method = 'POST'
    await expect(middleware({ node: { req: { headers: {} } } })).rejects.toMatchObject({
      statusCode: 419,
    })

    state.url = new URL('https://app.test/webhooks/stripe')
    await expect(middleware({ node: { req: { headers: {} } } })).resolves.toBeUndefined()

    state.url = new URL('https://app.test/broadcasting/auth')
    await expect(middleware({ node: { req: { headers: {} } } })).resolves.toBeUndefined()

    resetSecurityRuntime()
    state.url = new URL('https://app.test/login')
    await expect(middleware({ node: { req: { headers: {} } } })).rejects.toThrow(/Security runtime/)
  })
})
