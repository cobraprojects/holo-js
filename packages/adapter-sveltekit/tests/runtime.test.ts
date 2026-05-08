import { afterEach, describe, expect, it, vi } from 'vitest'

type MockAuthRequest = {
  getCookie(name: string): Promise<string | undefined>
  getHeader(name: string): Promise<string | undefined>
  appendResponseCookie?(cookie: string): void | Promise<void>
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
    })

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
})
