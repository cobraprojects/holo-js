import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('@holo-js/core')
  vi.resetModules()
})

describe('@holo-js/adapter-sveltekit request context', () => {
  it('owns auth request accessors inside the adapter and resolves them from the current request event', async () => {
    let capturedAuthRequest:
      | {
        getCookie(name: string): Promise<string | undefined>
        getHeader(name: string): Promise<string | undefined>
      }
      | undefined

    vi.doMock('@holo-js/core', () => ({
      createHoloFrameworkAdapter: () => ({
        capabilities: {},
        async createProject() {
          return {}
        },
        async initializeProject() {
          return {}
        },
        createHelpers(options: {
          authRequest?: {
            getCookie(name: string): Promise<string | undefined>
            getHeader(name: string): Promise<string | undefined>
          }
        }) {
          capturedAuthRequest = options.authRequest

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
      },
      request: {
        headers: new Headers({
          'x-request-id': 'header-value',
        }),
      },
    }, async () => {
      await helpers.getProject()

      await expect(capturedAuthRequest?.getCookie('session')).resolves.toBe('cookie-value')
      await expect(capturedAuthRequest?.getHeader('x-request-id')).resolves.toBe('header-value')
    })

    await expect(capturedAuthRequest?.getCookie('session')).resolves.toBeUndefined()
    await expect(capturedAuthRequest?.getHeader('x-request-id')).resolves.toBeUndefined()
  })

  it('preserves explicit auth request overrides', async () => {
    let capturedAuthRequest:
      | {
        getCookie(name: string): Promise<string | undefined>
        getHeader(name: string): Promise<string | undefined>
      }
      | undefined

    vi.doMock('@holo-js/core', () => ({
      createHoloFrameworkAdapter: () => ({
        capabilities: {},
        async createProject() {
          return {}
        },
        async initializeProject() {
          return {}
        },
        createHelpers(options: {
          authRequest?: {
            getCookie(name: string): Promise<string | undefined>
            getHeader(name: string): Promise<string | undefined>
          }
        }) {
          capturedAuthRequest = options.authRequest

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
