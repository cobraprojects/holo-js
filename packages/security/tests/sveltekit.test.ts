import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineSecurityConfig } from '@holo-js/config'
import {
  configureSecurityRuntime,
  csrf,
  resetSecurityRuntime,
} from '../src'
import { SECURITY_CLIENT_CONFIG_COOKIE } from '../src/client-config'
import { csrfProtection } from '../src/sveltekit/server'

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
  it('issues the readable csrf cookie on safe requests before page loads render csrf.input()', async () => {
    configureSecurity()
    const request = new Request('https://app.test/login')
    const { event, writes } = createEvent(request)
    const resolve = vi.fn(() => new Response('ok'))

    const response = await csrfProtection()({ event, resolve })
    const input = await csrf.input(request)

    expect(response.status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
    expect(writes).toEqual([
      {
        name: 'XSRF-TOKEN',
        value: input.value,
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
    expect(input).toEqual({
      type: 'hidden',
      name: '_token',
      value: writes[0]?.value,
    })
  })

  it('issues the readable csrf cookie for HEAD requests', async () => {
    configureSecurity()
    const { event, writes } = createEvent(new Request('https://app.test/login', {
      method: 'HEAD',
    }))
    const resolve = vi.fn(() => new Response(null))

    const response = await csrfProtection()({ event, resolve })

    expect(response.status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
    expect(writes).toHaveLength(2)
  })

  it('refreshes invalid csrf cookies on safe requests', async () => {
    configureSecurity()
    const { event, writes } = createEvent(new Request('https://app.test/login'), 'existing-token')
    const resolve = vi.fn(() => new Response('ok'))

    const response = await csrfProtection()({ event, resolve })

    expect(response.status).toBe(200)
    expect(resolve).toHaveBeenCalledOnce()
    expect(writes).toHaveLength(2)
    expect(writes[0]?.name).toBe('XSRF-TOKEN')
    expect(writes[0]?.value).not.toBe('existing-token')
  })

  it('rejects unsafe requests with a 419 response before the route action runs', async () => {
    configureSecurity()
    const { event } = createEvent(new Request('https://app.test/login', {
      method: 'POST',
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
