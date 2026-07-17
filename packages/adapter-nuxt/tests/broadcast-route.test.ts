import { afterEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('@holo-js/adapter-nuxt broadcast auth route', () => {
  it('renders the active broadcast client configuration', async () => {
    const config = { default: 'main', connections: { main: { driver: 'holo' } } }
    const renderBroadcastClientConfigResponse = vi.fn(() => Response.json({ key: 'client-key' }))
    vi.doMock('h3', () => ({ defineEventHandler: (handler: unknown) => handler }))
    vi.doMock('@holo-js/broadcast/client-config', () => ({ renderBroadcastClientConfigResponse }))
    vi.doMock('../src/runtime/composables', () => ({
      holo: { getApp: async () => ({ config: { broadcast: config } }) },
    }))

    const route = await import('../src/runtime/server/routes/broadcast-config.get')
    const response = await route.default({} as H3Event)
    await expect(response.json()).resolves.toEqual({ key: 'client-key' })
    expect(renderBroadcastClientConfigResponse).toHaveBeenCalledWith(config)
  })

  it('resolves configured channel guards and falls back to the default auth guard', async () => {
    const adminUser = { id: 'admin_1' }
    const defaultUser = { id: 'user_1' }
    const guard = vi.fn(() => ({
      user: async () => adminUser,
    }))
    const user = vi.fn(async () => defaultUser)
    const renderBroadcastAuthResponse = vi.fn(async (_request: Request, options: {
      readonly appKey?: string
      readonly appSecret?: string
      readonly resolveUser: (request: Request, context: { readonly guard?: string }) => Promise<unknown>
      readonly channelAuth: {
        readonly registry: {
          readonly projectRoot: string
          readonly channels: readonly unknown[]
        }
      }
    }) => {
      const admin = await options.resolveUser(new Request('http://localhost/broadcasting/auth'), { guard: 'admin' })
      const fallback = await options.resolveUser(new Request('http://localhost/broadcasting/auth'), {})
      return Response.json({
        admin,
        fallback,
        signing: { appKey: options.appKey, appSecret: options.appSecret },
        registry: options.channelAuth.registry,
      })
    })

    vi.doMock('h3', () => ({
      defineEventHandler: (handler: unknown) => handler,
      getHeaders: () => ({
        cookie: 'sid=1',
        ignored: ['not-string'],
      }),
      getRequestURL: () => new URL('http://localhost/broadcasting/auth'),
      readRawBody: async () => 'channel_name=admin.blog',
    }))
    vi.doMock('@holo-js/broadcast/auth', () => ({
      renderBroadcastAuthResponse,
    }))
    vi.doMock('../src/runtime/composables', () => ({
      holo: {
        getApp: async () => ({
          projectRoot: '/project',
          config: {
            broadcast: {
              default: 'main',
              connections: {
                main: { driver: 'holo', key: 'key', secret: 'secret' },
              },
            },
          },
          registry: {
            channels: [{
              pattern: 'admin.blog',
            }],
          },
        }),
        getAuth: async () => ({
          guard,
          user,
        }),
      },
    }))

    const route = await import('../src/runtime/server/routes/broadcast-auth.post')
    const response = await route.default({
      method: 'POST',
    } as H3Event)

    await expect(response.json()).resolves.toEqual({
      admin: adminUser,
      fallback: defaultUser,
      signing: { appKey: 'key', appSecret: 'secret' },
      registry: {
        projectRoot: '/project',
        channels: [{
          pattern: 'admin.blog',
        }],
      },
    })
    expect(guard).toHaveBeenCalledWith('admin')
    expect(user).toHaveBeenCalledTimes(1)
    expect(renderBroadcastAuthResponse).toHaveBeenCalledTimes(1)
  })

  it('uses an empty generated registry and the default guard when no channel guard is selected', async () => {
    const defaultUser = { id: 'user_1' }
    const guard = vi.fn()
    const user = vi.fn(async () => defaultUser)
    const renderBroadcastAuthResponse = vi.fn(async (_request: Request, options: {
      readonly resolveUser: (request: Request, context: { readonly guard?: string }) => Promise<unknown>
      readonly channelAuth: {
        readonly registry: {
          readonly projectRoot: string
          readonly channels: readonly unknown[]
        }
      }
    }) => {
      const fallback = await options.resolveUser(new Request('http://localhost/broadcasting/auth'), {})
      return Response.json({
        fallback,
        registry: options.channelAuth.registry,
      })
    })

    vi.doMock('h3', () => ({
      defineEventHandler: (handler: unknown) => handler,
      getHeaders: () => ({}),
      getRequestURL: () => new URL('http://localhost/broadcasting/auth'),
      readRawBody: async () => 'channel_name=blog.posts',
    }))
    vi.doMock('@holo-js/broadcast/auth', () => ({
      renderBroadcastAuthResponse,
    }))
    vi.doMock('../src/runtime/composables', () => ({
      holo: {
        getApp: async () => ({
          projectRoot: '/project',
        }),
        getAuth: async () => ({
          guard,
          user,
        }),
      },
    }))

    const route = await import('../src/runtime/server/routes/broadcast-auth.post')
    const response = await route.default({
      method: 'POST',
    } as H3Event)

    await expect(response.json()).resolves.toEqual({
      fallback: defaultUser,
      registry: {
        projectRoot: '/project',
        channels: [],
      },
    })
    expect(guard).not.toHaveBeenCalled()
    expect(user).toHaveBeenCalledTimes(1)
    expect(renderBroadcastAuthResponse).toHaveBeenCalledTimes(1)
  })

  it('does not sign auth responses for non-Holo broadcast connections', async () => {
    const renderBroadcastAuthResponse = vi.fn(async (_request: Request, options: Record<string, unknown>) => Response.json(options))
    vi.doMock('h3', () => ({
      defineEventHandler: (handler: unknown) => handler,
      getHeaders: () => ({}),
      getRequestURL: () => new URL('http://localhost/broadcasting/auth'),
      readRawBody: async () => '',
    }))
    vi.doMock('@holo-js/broadcast/auth', () => ({ renderBroadcastAuthResponse }))
    vi.doMock('../src/runtime/composables', () => ({
      holo: {
        getApp: async () => ({
          projectRoot: '/project', registry: { channels: [] },
          config: { broadcast: { default: 'main', connections: { main: { driver: 'pusher', key: 'key', secret: 'secret' } } } },
        }),
        getAuth: async () => undefined,
      },
    }))

    const route = await import('../src/runtime/server/routes/broadcast-auth.post')
    const response = await route.default({ method: 'POST' } as H3Event)
    const options = await response.json() as Record<string, unknown>
    expect(options).not.toHaveProperty('appKey')
    expect(options).not.toHaveProperty('appSecret')
  })
})
