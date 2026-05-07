import { afterEach, describe, expect, it, vi } from 'vitest'

const authProviderMarker = Symbol.for('holo-js.auth.provider')

describe('@holo-js/adapter-sveltekit server auth', () => {
  afterEach(() => {
    vi.restoreAllMocks()
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

  it('returns a guest auth state when auth resolution fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.doMock('@holo-js/auth', () => ({
      default: {
        guard: vi.fn(),
      },
      user: vi.fn(async () => {
        throw new Error('auth unavailable')
      }),
    }))

    const { auth } = await import('../src/server')
    const currentAuth = await auth()

    expect(currentAuth).toEqual({
      authenticated: false,
      user: null,
    })
    expect(console.warn).toHaveBeenCalled()
  })

  it('redirects authenticated users from guest-only hook routes', async () => {
    vi.doMock('@holo-js/auth', () => ({
      default: {
        guard: vi.fn(),
      },
      user: vi.fn(async () => ({ id: 1, email: 'ava@example.com' })),
    }))

    const { guestOnly } = await import('../src/server')
    const handle = guestOnly({
      routes: ['/login', '/register', '/auth/*'],
      redirectTo: '/admin',
    })
    const response = await handle({
      event: {
        url: new URL('https://app.test/login'),
      },
      resolve: vi.fn(async () => new Response('ok')),
    })

    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('https://app.test/admin')
  })

  it('resolves guest-only hook routes when no user is authenticated', async () => {
    vi.doMock('@holo-js/auth', () => ({
      default: {
        guard: vi.fn(),
      },
      user: vi.fn(async () => null),
    }))

    const { guestOnly } = await import('../src/server')
    const resolved = new Response('ok')
    const resolve = vi.fn(async () => resolved)
    const handle = guestOnly({
      routes: ['/login'],
      redirectTo: '/admin',
    })

    await expect(handle({
      event: {
        url: new URL('https://app.test/login'),
      },
      resolve,
    })).resolves.toBe(resolved)
  })

  it('resolves guest-only hook routes when the redirect target is the current URL', async () => {
    vi.doMock('@holo-js/auth', () => ({
      default: {
        guard: vi.fn(),
      },
      user: vi.fn(async () => ({ id: 1, email: 'ava@example.com' })),
    }))

    const { guestOnly } = await import('../src/server')
    const resolved = new Response('ok')
    const resolve = vi.fn(async () => resolved)
    const handle = guestOnly({
      routes: ['/login'],
      redirectTo: '/login?next=%2Fadmin',
    })

    await expect(handle({
      event: {
        url: new URL('https://app.test/login?next=%2Fadmin'),
      },
      resolve,
    })).resolves.toBe(resolved)
  })

  it('supports wildcard route matching for guest-only hook routes', async () => {
    const { routeProtectionInternals } = await import('../src/server')

    expect(routeProtectionInternals.matchesRoutes(['/auth/*'], '/auth')).toBe(true)
    expect(routeProtectionInternals.matchesRoutes(['/auth/*'], '/auth/reset')).toBe(true)
    expect(routeProtectionInternals.matchesRoutes(['/auth/*'], '/login')).toBe(false)

    const statefulRoute = /^\/auth/g
    expect(routeProtectionInternals.matchesRoutes([statefulRoute], '/auth')).toBe(true)
    expect(routeProtectionInternals.matchesRoutes([statefulRoute], '/auth')).toBe(true)
  })
})
