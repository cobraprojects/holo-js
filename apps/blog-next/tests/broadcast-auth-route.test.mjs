import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  user: vi.fn(),
}))

vi.mock('@holo-js/adapter-next/runtime', async (importOriginal) => {
  const actual = await importOriginal()

  return {
    ...actual,
    createNextHoloHelpers: () => ({
      getApp: async () => ({
        projectRoot: process.cwd(),
        config: {
          broadcast: {
            default: 'holo',
            connections: {
              holo: {
                driver: 'holo',
                key: 'app-key',
                secret: 'app-secret',
              },
            },
          },
        },
        registry: {
          channels: [
            {
              sourcePath: 'server/channels/blog-admin.ts',
              pattern: 'blog.admin',
              type: 'private',
              params: [],
              whispers: [],
            },
          ],
        },
      }),
      getAuth: async () => ({
        user: mocks.user,
      }),
    }),
  }
})

const route = await import('../.holo-js/generated/next/broadcast-auth-route.ts')

function createRequest(channelName = 'blog.admin') {
  return new Request('http://localhost/broadcasting/auth', {
    method: 'POST',
    body: new URLSearchParams({
      socket_id: 'socket.1',
      channel_name: channelName,
    }),
  })
}

describe('POST /broadcasting/auth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when no user is authenticated', async () => {
    mocks.user.mockResolvedValue(null)

    const response = await route.POST(createRequest())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'unauthenticated',
    })
  })

  it('authorizes the private blog admin channel for authenticated users', async () => {
    mocks.user.mockResolvedValue({
      id: 1,
      email: 'admin@example.com',
    })

    const response = await route.POST(createRequest())
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      ok: true,
      channel: 'blog.admin',
      type: 'private',
    })
    expect(payload.auth).toMatch(/^app-key:/)
  })
})
