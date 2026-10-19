import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureSecurityRuntime,
  csrf,
  csrfInternals,
  defineSecurityConfig,
  resetSecurityRuntime,
} from '../src'
import { SECURITY_CLIENT_CONFIG_COOKIE } from '../src/client-config'
import { csrfProtection } from '../src/sveltekit/server'
import { memoryCsrfSessions, type MemoryCsrfSessions } from './support/csrf-session'

type CookieWrite = {
  readonly name: string
  readonly value: string
  readonly options: {
    readonly path: string
    readonly secure?: boolean
    readonly httpOnly?: boolean
    readonly sameSite?: 'lax' | 'strict' | 'none'
  }
}

function configureSecurity(
  except: readonly string[] = [],
  trustedProxies: readonly string[] | '*' = [],
  sessions: MemoryCsrfSessions = memoryCsrfSessions(),
): MemoryCsrfSessions {
  configureSecurityRuntime({
    config: defineSecurityConfig({
      csrf: {
        enabled: true,
        except,
      },
      trustedProxies,
    }),
    csrfSigningKey: 'test-signing-key',
    csrfSession: sessions,
  })
  return sessions
}

function createEvent(request: Request, cookieValue?: string): {
  readonly event: {
    readonly url: URL
    readonly request: Request
    readonly cookies: {
      get(name: string): string | undefined
      set(name: string, value: string, options: CookieWrite['options']): void
    }
  }
  readonly writes: CookieWrite[]
} {
  const writes: CookieWrite[] = []

  return {
    event: {
      url: new URL(request.url),
      request,
      cookies: {
        get(name: string) {
          return name === 'XSRF-TOKEN' ? cookieValue : undefined
        },
        set(name, value, options) {
          writes.push({ name, value, options })
        },
      },
    },
    writes,
  }
}

afterEach(() => {
  resetSecurityRuntime()
})

describe('@holo-js/security SvelteKit csrf middleware', () => {
  it.each([
    { 'x-forwarded-port': 'abc' },
    { 'x-forwarded-host': 'a b' },
  ])('answers malformed trusted proxy headers %j with a bad request', async (headers) => {
    configureSecurity([], '*')
    for (const method of ['GET', 'HEAD']) {
      const { event } = createEvent(new Request('https://app.test/page', { method, headers }))
      const response = await csrfProtection()({ event, resolve: () => new Response('handled') })
      expect(response.status).toBe(400)
    }
  })

  it('rejects TRACE before resolving the route', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({ csrf: { enabled: true } }),
      csrfSigningKey: 'test-signing-key',
    })
    const request = new Request('https://app.test/login')
    const traceRequest = new Proxy(request, {
      get(target, property) {
        return property === 'method' ? 'TRACE' : Reflect.get(target, property, target)
      },
    })
    const { event } = createEvent(traceRequest)
    const resolve = vi.fn(async () => new Response('ok'))
    const response = await csrfProtection()({ event, resolve })

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toContain('POST')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('issues the readable csrf cookie on safe requests before page loads render csrf.input()', async () => {
    const sessions = configureSecurity()
    const request = new Request('https://app.test/login')
    const { event, writes } = createEvent(request)
    const resolve = vi.fn(() => new Response('ok'))

    const response = await csrfProtection()({ event, resolve })
    const input = await csrf.input(request)

    expect(response.status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
    expect(sessions.tokens.get('guest-1')).toBe(input.value)
    expect(response.headers.getSetCookie()).toEqual(['browser=guest-1; Path=/; HttpOnly; SameSite=Lax'])
    expect(writes).toEqual([
      {
        name: 'XSRF-TOKEN',
        value: expect.stringMatching(/^[\w-]+$/),
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
            header: 'X-CSRF-TOKEN',
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
    expect(writes[0]?.value).not.toBe(input.value)
    expect(csrfInternals.decryptCsrfToken(writes[0]?.value ?? '')).toBe(input.value)
  })

  it('preserves current cookies and refreshes only stale client configuration before rendering', async () => {
    const token = 'session-token'
    const sessions = configureSecurity([], [], memoryCsrfSessions({ 'browser-a': token }))
    const encryptedToken = csrfInternals.encryptCsrfToken(token)
    const clientConfig = '{"csrf":{"field":"_token","cookie":"XSRF-TOKEN","header":"X-CSRF-TOKEN"}}'
    for (const configuration of [clientConfig, 'stale']) {
      const request = new Request('https://app.test/login', {
        headers: { cookie: `browser=browser-a; XSRF-TOKEN=${encryptedToken}` },
      })
      const { event, writes } = createEvent(request, encryptedToken)
      const configuredEvent = {
        ...event,
        cookies: {
          ...event.cookies,
          get(name: string) {
            return name === SECURITY_CLIENT_CONFIG_COOKIE ? configuration : event.cookies.get(name)
          },
        },
      }
      const response = await csrfProtection()({
        event: configuredEvent,
        resolve: async () => {
          expect(writes.map(write => write.name)).toEqual(configuration === clientConfig ? [] : [SECURITY_CLIENT_CONFIG_COOKIE])
          expect((await csrf.input(request)).value).toBe(token)
          return new Response('ok')
        },
      })
      expect(response.status).toBe(200)
      expect(response.headers.getSetCookie()).toEqual([])
    }
    expect(sessions.writes).toEqual([])
  })

  it('issues the readable csrf cookie for HEAD requests', async () => {
    const sessions = configureSecurity()
    const { event, writes } = createEvent(new Request('https://app.test/login', {
      method: 'HEAD',
    }))
    const resolve = vi.fn(() => new Response(null))

    const response = await csrfProtection()({ event, resolve })

    expect(response.status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
    expect(writes).toHaveLength(2)
    expect(csrfInternals.decryptCsrfToken(writes[0]?.value ?? '')).toBe(sessions.tokens.get('guest-1'))
    expect(response.headers.getSetCookie()).toEqual(['browser=guest-1; Path=/; HttpOnly; SameSite=Lax'])
  })

  it('refreshes invalid csrf cookies on safe requests', async () => {
    const sessions = configureSecurity([], [], memoryCsrfSessions({ 'browser-a': 'session-token' }))
    const foreignCookie = csrfInternals.encryptCsrfToken('other-session-token')
    for (const existingCookie of ['existing-token', foreignCookie]) {
      const { event, writes } = createEvent(new Request('https://app.test/login', {
        headers: { cookie: `browser=browser-a; XSRF-TOKEN=${existingCookie}` },
      }), existingCookie)
      const resolve = vi.fn(() => new Response('ok'))

      const response = await csrfProtection()({ event, resolve })

      expect(response.status).toBe(200)
      expect(resolve).toHaveBeenCalledOnce()
      expect(writes).toHaveLength(2)
      expect(writes[0]?.name).toBe('XSRF-TOKEN')
      expect(writes[0]?.value).not.toBe(existingCookie)
      expect(csrfInternals.decryptCsrfToken(writes[0]?.value ?? '')).toBe('session-token')
    }
    expect(sessions.writes).toEqual([])
  })

  it('rejects unsafe requests with a 419 response before the route action runs', async () => {
    configureSecurity([], [], memoryCsrfSessions({ 'browser-a': 'session-token' }))
    const { event } = createEvent(new Request('https://app.test/login', {
      method: 'POST',
      headers: { cookie: 'browser=browser-a' },
      body: new URLSearchParams({
        email: 'editor@example.com',
      }),
    }))
    const resolve = vi.fn(() => new Response('should not run'))

    const response = await csrfProtection()({ event, resolve })

    expect(response.status).toBe(419)
    await expect(response.text()).resolves.toBe('CSRF token mismatch.')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('propagates non-csrf failures', async () => {
    const { event } = createEvent(new Request('https://app.test/login', {
      method: 'POST',
    }))
    const resolve = vi.fn(() => new Response('should not run'))

    await expect(csrfProtection()({ event, resolve })).rejects.toThrow(/Security runtime/)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('skips configured csrf exceptions', async () => {
    configureSecurity(['/webhooks/*'])
    const { event } = createEvent(new Request('https://app.test/webhooks/stripe', {
      method: 'POST',
    }))
    const resolve = vi.fn(() => new Response('ok'))

    const response = await csrfProtection()({ event, resolve })

    expect(response.status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
  })

  it('does nothing when csrf is disabled', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: false,
        },
      }),
      csrfSigningKey: 'test-signing-key',
    })
    const { event, writes } = createEvent(new Request('https://app.test/login'))
    const resolve = vi.fn(() => new Response('ok'))

    const response = await csrfProtection()({ event, resolve })

    expect(response.status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
    expect(writes).toEqual([])
  })
})
