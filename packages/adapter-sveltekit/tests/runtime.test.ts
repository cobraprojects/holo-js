import { afterEach, describe, expect, it, vi } from 'vitest'

type MockAuthRequest = {
  getCookie(name: string): Promise<string | undefined>
  getHeader(name: string): Promise<string | undefined>
  appendResponseCookie?(cookie: string): void | Promise<void>
  redirectResponse?(url: string, status?: 301 | 302 | 303 | 307 | 308): Promise<void>
}

function makeHoloCoreMock(
  setCapturedAuthRequest: (authRequest: MockAuthRequest | undefined) => void,
) {
  return {
    createHoloFrameworkAdapter: () => ({
      capabilities: {},
      async createProject() {
        return {}
      },
      async initializeProject() {
        return {}
      },
      createHelpers(options: {
        authRequest?: MockAuthRequest
      }) {
        setCapturedAuthRequest(options.authRequest)

        return {
          async getApp() {
            return {}
          },
          async getProject() {
            return {}
          },
          async getSession() {
            return undefined
          },
          async getAuth() {
            return undefined
          },
          async useConfig() {
            return undefined
          },
          async config() {
            return undefined
          },
        }
      },
      async resetProject() {},
      internals: {
        getState() {
          return {}
        },
        resolveOptions() {
          return {}
        },
      },
    }),
  }
}

afterEach(() => {
  vi.doUnmock('@holo-js/core')
  vi.resetModules()
})

describe('@holo-js/adapter-sveltekit request context', () => {
  it('owns auth request accessors inside the adapter and resolves them from the current request event', async () => {
    let capturedAuthRequest: MockAuthRequest | undefined
    const responseCookies: Array<{
      readonly name: string
      readonly value: string
      readonly options: {
        readonly path: string
        readonly domain?: string
        readonly maxAge?: number
        readonly expires?: Date
        readonly secure?: boolean
        readonly httpOnly?: boolean
        readonly sameSite?: 'lax' | 'strict' | 'none'
        readonly partitioned?: boolean
      }
    }> = []

    vi.doMock('@holo-js/core', () => makeHoloCoreMock((authRequest) => {
      capturedAuthRequest = authRequest
    }))

    const { createSvelteKitHoloHelpers, runWithSvelteKitRequestEvent } = await import('../src')
    const helpers = createSvelteKitHoloHelpers({
      projectRoot: '/tmp/holo-sveltekit-runtime',
    })

    await runWithSvelteKitRequestEvent({
      cookies: {
        get(name: string) {
          return name === 'session' ? 'cookie-value' : undefined
        },
        set(name, value, options) {
          responseCookies.push({ name, value, options })
        },
      },
      request: {
        headers: new Headers({
          'x-request-id': 'header-value',
        }),
      },
    }, async () => {
      await helpers.getProject()

      expect(capturedAuthRequest).toBeDefined()
      if (!capturedAuthRequest) {
        throw new Error('Expected auth request accessors to be captured.')
      }
      await expect(capturedAuthRequest.getCookie('session')).resolves.toBe('cookie-value')
      await expect(capturedAuthRequest.getHeader('x-request-id')).resolves.toBe('header-value')
      await capturedAuthRequest.appendResponseCookie?.('session=response-value; Path=/; HttpOnly; SameSite=Lax; Partitioned')
      await capturedAuthRequest.appendResponseCookie?.('analytics=off; Path=/metrics; Partitioned=false')
      await capturedAuthRequest.appendResponseCookie?.('empty-path=value; ; Path=')
      await capturedAuthRequest.appendResponseCookie?.('encoded%20name=encoded%20value; Domain=example.com; Max-Age=60; Expires=Wed, 20 May 2026 00:00:00 GMT; Secure; SameSite=Strict')
      await capturedAuthRequest.appendResponseCookie?.('invalid=ignored; Max-Age=never; Expires=never; SameSite=invalid')
      await capturedAuthRequest.appendResponseCookie?.('%E0%A4%A=raw%zz')
      await capturedAuthRequest.appendResponseCookie?.('bad-cookie')
    })
    await capturedAuthRequest?.appendResponseCookie?.('orphan=value')

    expect(responseCookies).toEqual([
      {
        name: 'session',
        value: 'response-value',
        options: {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          partitioned: true,
        },
      },
      {
        name: 'analytics',
        value: 'off',
        options: {
          path: '/metrics',
          partitioned: false,
        },
      },
      {
        name: 'empty-path',
        value: 'value',
        options: {
          path: '/',
        },
      },
      {
        name: 'encoded name',
        value: 'encoded value',
        options: {
          path: '/',
          domain: 'example.com',
          maxAge: 60,
          expires: new Date('2026-05-20T00:00:00.000Z'),
          secure: true,
          sameSite: 'strict',
        },
      },
      {
        name: 'invalid',
        value: 'ignored',
        options: {
          path: '/',
        },
      },
      {
        name: '%E0%A4%A',
        value: 'raw%zz',
        options: {
          path: '/',
        },
      },
    ])

    expect(capturedAuthRequest).toBeDefined()
    if (!capturedAuthRequest) {
      throw new Error('Expected auth request accessors to be captured.')
    }
    await expect(capturedAuthRequest.getCookie('session')).resolves.toBeUndefined()
    await expect(capturedAuthRequest.getHeader('x-request-id')).resolves.toBeUndefined()
  })

  it('preserves explicit auth request overrides', async () => {
    let capturedAuthRequest: MockAuthRequest | undefined

    vi.doMock('@holo-js/core', () => makeHoloCoreMock((authRequest) => {
      capturedAuthRequest = authRequest
    }))

    const customAuthRequest = {
      async getCookie() {
        return 'custom-cookie'
      },
      async getHeader() {
        return 'custom-header'
      },
    }

    const { createSvelteKitHoloHelpers } = await import('../src')
    const helpers = createSvelteKitHoloHelpers({
      projectRoot: '/tmp/holo-sveltekit-runtime',
      authRequest: customAuthRequest,
    })

    await helpers.getProject()

    expect(capturedAuthRequest).toBe(customAuthRequest)
  })

  it('delegates redirect responses through SvelteKit', async () => {
    let capturedAuthRequest: MockAuthRequest | undefined
    const redirect = vi.fn((status: number, url: string): never => {
      throw Object.assign(new Error('redirect'), { status, url })
    })

    vi.doMock('@holo-js/core', () => makeHoloCoreMock((authRequest) => {
      capturedAuthRequest = authRequest
    }))
    vi.doMock('@sveltejs/kit', () => ({ redirect }))

    const { createSvelteKitHoloHelpers } = await import('../src')
    const helpers = createSvelteKitHoloHelpers({
      projectRoot: '/tmp/holo-sveltekit-runtime',
    })

    await helpers.getProject()

    await expect(capturedAuthRequest?.redirectResponse?.('/login')).rejects.toMatchObject({
      status: 307,
      url: '/login',
    })
    expect(redirect).toHaveBeenCalledWith(307, '/login')
  })
})
