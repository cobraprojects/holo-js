import { afterEach, describe, expect, it, vi } from 'vitest'

describe('@holo-js/adapter-nuxt route protection', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('#imports')
    vi.doUnmock('../src/runtime/composables/auth')
  })

  it('redirects authenticated users from guest-only route middleware', async () => {
    const navigateTo = vi.fn((to: string, options?: { readonly redirectCode?: number }) => ({ to, options }))
    vi.doMock('#imports', () => ({
      defineNuxtRouteMiddleware: (middleware: unknown) => middleware,
      navigateTo,
    }))
    vi.doMock('../src/runtime/composables/auth', () => ({
      useAuth: vi.fn(async () => ({
        authenticated: { value: true },
      })),
    }))

    const { guestOnly } = await import('../src/runtime/server/protection')
    const middleware = guestOnly({
      routes: ['/login', '/register', '/auth/*'],
      redirectTo: '/admin',
    })

    await expect(middleware({ path: '/login' }, { path: '/' })).resolves.toEqual({
      to: '/admin',
      options: { redirectCode: 303 },
    })
  })

  it('continues for guest-only route middleware when no user is authenticated', async () => {
    vi.doMock('#imports', () => ({
      defineNuxtRouteMiddleware: (middleware: unknown) => middleware,
      navigateTo: vi.fn(),
    }))
    vi.doMock('../src/runtime/composables/auth', () => ({
      useAuth: vi.fn(async () => ({
        authenticated: { value: false },
      })),
    }))

    const { guestOnly } = await import('../src/runtime/server/protection')
    const middleware = guestOnly({
      routes: ['/login'],
      redirectTo: '/admin',
    })

    await expect(middleware({ path: '/login' }, { path: '/' })).resolves.toBeUndefined()
  })

  it('supports wildcard route matching for guest-only route middleware', async () => {
    vi.doMock('#imports', () => ({
      defineNuxtRouteMiddleware: (middleware: unknown) => middleware,
      navigateTo: vi.fn(),
    }))

    const { routeProtectionInternals } = await import('../src/runtime/server/protection')

    expect(routeProtectionInternals.matchesRoutes(['/auth/*'], '/auth')).toBe(true)
    expect(routeProtectionInternals.matchesRoutes(['/auth/*'], '/auth/reset')).toBe(true)
    expect(routeProtectionInternals.matchesRoutes(['/auth/*'], '/login')).toBe(false)

    const statefulRoute = /^\/auth/g
    expect(routeProtectionInternals.matchesRoutes([statefulRoute], '/auth')).toBe(true)
    expect(routeProtectionInternals.matchesRoutes([statefulRoute], '/auth')).toBe(true)
  })
})
