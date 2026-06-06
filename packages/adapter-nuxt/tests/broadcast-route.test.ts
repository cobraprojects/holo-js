import { afterEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('@holo-js/adapter-nuxt broadcast auth route', () => {
  it('resolves configured channel guards and falls back to the default auth guard', async () => {
    const adminUser = { id: 'admin_1' }
    const defaultUser = { id: 'user_1' }
    const guard = vi.fn(() => ({
      user: async () => adminUser,
    }))
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
      const admin = await options.resolveUser(new Request('http://localhost/broadcasting/auth'), { guard: 'admin' })
      const fallback = await options.resolveUser(new Request('http://localhost/broadcasting/auth'), {})
      return Response.json({
        admin,
        fallback,
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
})
