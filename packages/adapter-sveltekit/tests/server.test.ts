import { afterEach, describe, expect, it, vi } from 'vitest'

const authProviderMarker = Symbol.for('holo-js.auth.provider')

describe('@holo-js/adapter-sveltekit server auth', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('@holo-js/auth')
  })

  it('returns a serializable current user without auth runtime symbol metadata', async () => {
    const runtimeUser = {
      id: 1,
      email: 'ava@example.com',
      name: 'Ava',
    }
    Object.defineProperty(runtimeUser, authProviderMarker, {
      value: 'users',
    })

    vi.doMock('@holo-js/auth', () => ({
      default: {
        guard: vi.fn(),
      },
      user: vi.fn(async () => runtimeUser),
    }))

    const { auth } = await import('../src/server')
    const currentAuth = await auth()

    expect(currentAuth.authenticated).toBe(true)
    expect(currentAuth.user).toEqual(runtimeUser)
    expect(currentAuth.user).not.toBe(runtimeUser)
    expect(Object.getOwnPropertySymbols(currentAuth.user!)).not.toContain(authProviderMarker)
  })

  it('returns a guest auth state when no user is authenticated', async () => {
    vi.doMock('@holo-js/auth', () => ({
      default: {
        guard: vi.fn(),
      },
      user: vi.fn(async () => null),
    }))

    const { auth } = await import('../src/server')
    const currentAuth = await auth()

    expect(currentAuth).toEqual({
      authenticated: false,
      user: null,
    })
  })

  it('resolves named guards through the auth facade', async () => {
    const guardUser = {
      id: 2,
      email: 'admin@example.com',
      name: 'Admin',
    }
    const guard = vi.fn(() => ({
      user: vi.fn(async () => guardUser),
    }))

    vi.doMock('@holo-js/auth', () => ({
      default: {
        guard,
      },
      user: vi.fn(),
    }))

    const { auth } = await import('../src/server')
    const currentAuth = await auth({ guard: 'admin' })

    expect(guard).toHaveBeenCalledWith('admin')
    expect(currentAuth.user).toEqual(guardUser)
  })
})
