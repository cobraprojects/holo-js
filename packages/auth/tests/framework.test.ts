import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

const execFileAsync = promisify(execFile)

type MockReactContext<TValue> = {
  currentRenderValue: TValue
  readonly Provider: (props: { readonly value: TValue, readonly children?: unknown }) => unknown
}

function createReactMock(): Readonly<Record<string, unknown>> {
  return {
    createContext<TValue>(defaultValue: TValue): MockReactContext<TValue> {
      const context: MockReactContext<TValue> = {
        currentRenderValue: defaultValue,
        Provider({ value, children }) {
          context.currentRenderValue = value
          return children
        },
      }

      return context
    },
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: readonly unknown[]): unknown {
      if (typeof type === 'function') {
        return (type as (props: Record<string, unknown>) => unknown)({
          ...(props ?? {}),
          children: children.length === 1 ? children[0] : children,
        })
      }

      return { type, props, children }
    },
    useCallback<TCallback extends (...args: never[]) => unknown>(callback: TCallback) {
      return callback
    },
    useContext<TValue>(context: MockReactContext<TValue>): TValue {
      return context.currentRenderValue
    },
    useEffect(effect: () => void | (() => void)) {
      return effect()
    },
    useRef<TValue>(initialValue?: TValue) {
      return { current: initialValue }
    },
    useState<TValue>(initialState: TValue | (() => TValue)) {
      const value = typeof initialState === 'function'
        ? (initialState as () => TValue)()
        : initialState

      return [value, vi.fn()] as const
    },
  }
}

function createNuxtImportsMock(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    computed<TValue>(getter: () => TValue) {
      return {
        get value() {
          return getter()
        },
      }
    },
    defineNuxtRouteMiddleware<TValue>(middleware: TValue) {
      return middleware
    },
    navigateTo: vi.fn(),
    useFetch: vi.fn(),
    useState<TValue>(_key: string, init: () => TValue) {
      return { value: init() }
    },
    ...overrides,
  }
}

describe('@holo-js/auth framework helpers', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.doUnmock('#imports')
    vi.doUnmock('next/navigation.js')
    vi.doUnmock('next/server.js')
    vi.doUnmock('react')
    vi.doUnmock('../src/client')
    vi.doUnmock('../src/index')
    vi.doUnmock('../src/nuxt')
  })

  it('reuses the Next auth provider when useAuth receives an empty options object', async () => {
    const refreshUser = vi.fn(async () => null)
    vi.doMock('../src/client', () => ({
      refreshUser,
    }))
    vi.doMock('next/navigation.js', () => ({
      usePathname: () => '/admin',
    }))
    vi.doMock('react', () => createReactMock())

    const { AuthProvider, useAuth } = await import('../src/next/client')

    AuthProvider({
      initialUser: {
        id: 1,
        email: 'ava@example.com',
        name: 'Ava',
        role: 'admin',
      },
      children: null,
    })

    const auth = useAuth({})

    expect(auth.user?.email).toBe('ava@example.com')
    expect(refreshUser).not.toHaveBeenCalled()
  })

  it('refreshes the Next auth provider after client route changes', async () => {
    let currentPathname = '/login'
    let stateCursor = 0
    let refCursor = 0
    const states: unknown[] = []
    const refs: { current: unknown }[] = []
    const fetchCurrentUser = vi.fn(async () => ({
      authenticated: true,
      guard: 'web',
      provider: 'users',
      user: {
        id: 1,
        email: 'ava@example.com',
        name: 'Ava',
      },
    }))

    function resetRenderCursors() {
      stateCursor = 0
      refCursor = 0
    }

    vi.doMock('../src/client', () => ({
      authClientInternals: {
        fetchCurrentUser,
      },
    }))
    vi.doMock('next/navigation.js', () => ({
      usePathname: () => currentPathname,
    }))
    vi.doMock('react', () => ({
      createContext<TValue>(defaultValue: TValue): MockReactContext<TValue> {
        const context: MockReactContext<TValue> = {
          currentRenderValue: defaultValue,
          Provider({ value, children }) {
            context.currentRenderValue = value
            return children
          },
        }

        return context
      },
      createElement(type: unknown, props: Record<string, unknown> | null, ...children: readonly unknown[]): unknown {
        if (typeof type === 'function') {
          return (type as (props: Record<string, unknown>) => unknown)({
            ...(props ?? {}),
            children: children.length === 1 ? children[0] : children,
          })
        }

        return { type, props, children }
      },
      useCallback<TCallback extends (...args: never[]) => unknown>(callback: TCallback) {
        return callback
      },
      useContext<TValue>(context: MockReactContext<TValue>): TValue {
        return context.currentRenderValue
      },
      useEffect(effect: () => void | (() => void)) {
        return effect()
      },
      useRef<TValue>(initialValue?: TValue) {
        const index = refCursor
        refCursor += 1
        refs[index] ??= { current: initialValue }
        return refs[index] as { current: TValue | undefined }
      },
      useState<TValue>(initialState: TValue | (() => TValue)) {
        const index = stateCursor
        stateCursor += 1
        if (!(index in states)) {
          states[index] = typeof initialState === 'function'
            ? (initialState as () => TValue)()
            : initialState
        }

        return [
          states[index] as TValue,
          (value: TValue | ((previous: TValue) => TValue)) => {
            states[index] = typeof value === 'function'
              ? (value as (previous: TValue) => TValue)(states[index] as TValue)
              : value
          },
        ] as const
      },
    }))

    const { AuthProvider } = await import('../src/next/client')

    resetRenderCursors()
    AuthProvider({
      initialProvider: null,
      initialUser: null,
      children: null,
    })
    expect(fetchCurrentUser).not.toHaveBeenCalled()

    currentPathname = '/admin'
    resetRenderCursors()
    AuthProvider({
      initialProvider: null,
      initialUser: null,
      children: null,
    })

    expect(fetchCurrentUser).toHaveBeenCalledWith({}, {
      force: true,
    })
  })

  it('does not reuse the SvelteKit auth context when explicit request options are passed', async () => {
    type SvelteContextValue = unknown

    let storedContext: SvelteContextValue
    const fetchCurrentUser = vi.fn(async () => ({
      authenticated: true,
      guard: 'web',
      provider: 'users',
      user: {
        id: 1,
        email: 'ava@example.com',
        name: 'Ava',
      },
    }))

    vi.doMock('../src/client', () => ({
      authClientInternals: {
        fetchCurrentUser,
      },
    }))
    vi.doMock('svelte', () => ({
      getContext() {
        return storedContext
      },
      setContext(_key: symbol, value: SvelteContextValue) {
        storedContext = value
        return value
      },
    }))
    vi.doMock('svelte/reactivity', () => ({
      createSubscriber() {
        return () => {}
      },
    }))

    const { useAuth } = await import('../src/sveltekit/client')

    const defaultAuth = useAuth({
      initialProvider: 'users',
      initialUser: {
        id: 1,
        email: 'ava@example.com',
        name: 'Ava',
      },
    })
    const adminAuth = useAuth({ guard: 'admin' })

    expect(adminAuth).not.toBe(defaultAuth)
    expect(adminAuth.user).toBeNull()
    expect(useAuth()).toBe(defaultAuth)
    expect(useAuth().user?.email).toBe('ava@example.com')

    await defaultAuth.refreshUser()

    expect(fetchCurrentUser).toHaveBeenCalledWith({}, { force: true })
  })

  it('does not overwrite the SvelteKit auth context when endpoint or headers are passed', async () => {
    type SvelteContextValue = unknown

    let storedContext: SvelteContextValue

    vi.doMock('../src/client', () => ({
      authClientInternals: {
        fetchCurrentUser: vi.fn(),
      },
    }))
    vi.doMock('svelte', () => ({
      getContext() {
        return storedContext
      },
      setContext(_key: symbol, value: SvelteContextValue) {
        storedContext = value
        return value
      },
    }))
    vi.doMock('svelte/reactivity', () => ({
      createSubscriber() {
        return () => {}
      },
    }))

    const { useAuth } = await import('../src/sveltekit/client')

    const defaultAuth = useAuth({
      initialProvider: 'users',
      initialUser: {
        id: 1,
        email: 'ava@example.com',
        name: 'Ava',
      },
    })
    const endpointAuth = useAuth({ endpoint: '/api/admin/auth/current' })
    const headersAuth = useAuth({ headers: { 'x-holo-guard': 'admin' } })

    expect(endpointAuth).not.toBe(defaultAuth)
    expect(headersAuth).not.toBe(defaultAuth)
    expect(useAuth()).toBe(defaultAuth)
    expect(useAuth().user?.email).toBe('ava@example.com')
  })

  it('does not treat cross-origin Next redirects as self redirects', async () => {
    const { routeProtectionInternals } = await import('../src/next/server')

    expect(routeProtectionInternals.isSameUrl(
      new URL('https://app.test/login'),
      new URL('https://other.test/login'),
    )).toBe(false)
  })

  it('keeps Next route protection helpers out of Node-only edge bundles', async () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const tempDir = await mkdtemp(resolve(tmpdir(), 'holo-auth-edge-'))
    const entryPath = resolve(tempDir, 'next-route-protection-edge-entry.ts')
    const outputPath = resolve(tempDir, 'next-route-protection-edge-entry.mjs')

    try {
      await writeFile(entryPath, [
        `import { authOnly, guestOnly, protectRoutes } from ${JSON.stringify(resolve(packageRoot, 'src/next/server.ts'))}`,
        'export const proxy = protectRoutes(',
        '  guestOnly({ routes: [\'/login\'], redirectTo: \'/admin\' }),',
        '  authOnly({ routes: [\'/admin/*\'], redirectTo: \'/login\' }),',
        ')',
      ].join('\n'))

      await execFileAsync('bun', [
        'build',
        entryPath,
        '--target=browser',
        '--format=esm',
        '--external',
        'next/server.js',
        '--outfile',
        outputPath,
      ], {
        cwd: packageRoot,
      })

      await expect(readFile(outputPath, 'utf8')).resolves.not.toContain('node:async_hooks')
    } finally {
      await rm(tempDir, { force: true, recursive: true })
    }
  })

  it('keeps the published Next route protection edge condition out of Node-only bundles', async () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const tempDir = await mkdtemp(resolve(tmpdir(), 'holo-auth-published-edge-'))
    const outDir = resolve(tempDir, 'dist')
    const entryPath = resolve(tempDir, 'published-next-route-protection-edge-entry.ts')
    const outputPath = resolve(tempDir, 'published-next-route-protection-edge-entry.mjs')

    try {
      await execFileAsync('bun', ['run', 'build'], {
        cwd: packageRoot,
        env: {
          ...process.env,
          HOLO_BUILD_OUT_DIR: outDir,
        },
      })

      await writeFile(entryPath, [
        `import { authOnly, guestOnly, protectRoutes } from ${JSON.stringify(resolve(outDir, 'next/server.edge.mjs'))}`,
        'export const proxy = protectRoutes(',
        '  guestOnly({ routes: [\'/login\'], redirectTo: \'/admin\' }),',
        '  authOnly({ routes: [\'/admin/*\'], redirectTo: \'/login\' }),',
        ')',
      ].join('\n'))

      await execFileAsync('bun', [
        'build',
        entryPath,
        '--target=browser',
        '--format=esm',
        '--external',
        'next/server.js',
        '--outfile',
        outputPath,
      ], {
        cwd: packageRoot,
      })

      await expect(readFile(outputPath, 'utf8')).resolves.not.toContain('async_hooks')
    } finally {
      await rm(tempDir, { force: true, recursive: true })
    }
  }, 30_000)

  it('keeps the current Next request available while route protection resolves auth state', async () => {
    const connection = vi.fn(async () => {})
    let observedRequest: unknown

    vi.doMock('next/server.js', () => ({ connection }))
    vi.doMock('../src/index', async () => {
      const { getCurrentNextAuthRequest } = await import('../src/next/request-context')

      return {
        default: {
          guard() {
            return {
              provider: vi.fn(async () => 'users'),
              user: vi.fn(async () => null),
            }
          },
        },
        authRuntimeInternals: {
          getRuntimeBindings() {
            return {
              config: {
                defaults: {
                  guard: 'web',
                },
              },
            }
          },
        },
        provider: vi.fn(async () => 'users'),
        user: vi.fn(async () => {
          observedRequest = getCurrentNextAuthRequest()
          await Promise.resolve()

          return {
            id: 1,
            email: 'ava@example.com',
            name: 'Ava',
          }
        }),
      }
    })

    const { guestOnly } = await import('../src/next/server')
    const request = {
      cookies: {
        get: vi.fn(),
      },
      headers: new Headers(),
      nextUrl: new URL('https://app.test/login'),
      url: 'https://app.test/login',
    }
    const response = await guestOnly({
      routes: ['/login'],
      redirectTo: '/admin',
    })(request)

    expect(observedRequest).toBe(request)
    expect(connection).not.toHaveBeenCalled()
    expect(response?.status).toBe(303)
    expect(response?.headers.get('location')).toBe('https://app.test/admin')
  })

  it('leaves Next CSRF cookies to the security middleware when route protection lets a guest page continue', async () => {
    const { protectRoutes } = await import('../src/next/server')
    const request = {
      method: 'GET',
      cookies: {
        get: vi.fn(() => undefined),
      },
      headers: new Headers({
        'x-forwarded-proto': 'https',
      }),
      nextUrl: new URL('http://app.test/login'),
      url: 'http://app.test/login',
    }
    const response = await protectRoutes(async () => undefined)(request)

    expect(response).toBeUndefined()
  })

  it('keeps Next route protection branch behavior unchanged', async () => {
    let currentUser: null | {
      readonly id: number
      readonly email: string
      readonly name: string
    } = null

    vi.doMock('../src/index', () => ({
      default: {
        guard() {
          return {
            provider: vi.fn(async () => currentUser ? 'users' : null),
            user: vi.fn(async () => currentUser),
          }
        },
      },
      authRuntimeInternals: {
        getRuntimeBindings() {
          return {
            config: {
              defaults: {
                guard: 'web',
              },
            },
          }
        },
      },
      provider: vi.fn(async () => currentUser ? 'users' : null),
      user: vi.fn(async () => currentUser),
    }))

    const { authOnly, guestOnly, protectRoutes, routeProtectionInternals } = await import('../src/next/server')
    const request = {
      cookies: {
        get: vi.fn(),
      },
      headers: new Headers(),
      nextUrl: new URL('https://app.test/public'),
      url: 'https://app.test/public',
    }

    expect(routeProtectionInternals.matchesRoutes(undefined, '/anything')).toBe(true)
    expect(routeProtectionInternals.matchesRoute('/admin/*', '/admin/settings/')).toBe(true)
    expect(routeProtectionInternals.matchesRoute(/^\/admin$/g, '/admin/')).toBe(true)
    expect(routeProtectionInternals.matchesRoute(pathname => pathname === '/admin', '/admin/')).toBe(true)
    await expect(guestOnly({
      routes: ['/login'],
      redirectTo: '/admin',
    })(request)).resolves.toBeUndefined()

    request.nextUrl = new URL('https://app.test/login')
    request.url = 'https://app.test/login'
    await expect(guestOnly({
      routes: ['/login'],
      redirectTo: '/admin',
    })(request)).resolves.toBeUndefined()

    currentUser = {
      id: 1,
      email: 'ava@example.com',
      name: 'Ava',
    }

    await expect(guestOnly({
      routes: ['/login'],
      redirectTo: '/login',
    })(request)).resolves.toBeUndefined()

    const guestRedirect = await guestOnly({
      routes: ['/login'],
      redirectTo: '/admin',
      status: 302,
    })(request)
    expect(guestRedirect?.status).toBe(302)
    expect(guestRedirect?.headers.get('location')).toBe('https://app.test/admin')

    request.nextUrl = new URL('https://app.test/admin')
    request.url = 'https://app.test/admin'
    await expect(authOnly({
      routes: ['/admin'],
      redirectTo: '/login',
    })(request)).resolves.toBeUndefined()

    currentUser = null

    const authRedirect = await authOnly({
      guard: 'admin',
      routes: ['/admin'],
      redirectTo: '/login',
    })(request)
    expect(authRedirect?.status).toBe(303)
    expect(authRedirect?.headers.get('location')).toBe('https://app.test/login')

    const proxy = protectRoutes(
      async () => undefined,
      async () => new Response('blocked', { status: 401 }),
    )
    await expect(proxy(request)).resolves.toMatchObject({ status: 401 })
  })

  it('clears fallback Next request context after async and throwing callbacks', async () => {
    const globals = globalThis as typeof globalThis & {
      __holoNextAuthRequestStore?: unknown
    }
    delete globals.__holoNextAuthRequestStore

    const { getCurrentNextAuthRequest, runWithNextAuthRequest } = await import('../src/next/request-context')
    const request = {
      cookies: {
        get: vi.fn(),
      },
      headers: new Headers(),
    }

    await expect(runWithNextAuthRequest(request, async () => {
      await Promise.resolve()

      return getCurrentNextAuthRequest()
    })).resolves.toBe(request)
    expect(getCurrentNextAuthRequest()).toBeUndefined()
    expect(() => runWithNextAuthRequest(request, () => {
      throw new Error('boom')
    })).toThrow('boom')
    expect(getCurrentNextAuthRequest()).toBeUndefined()
  })

  it('does not treat cross-origin SvelteKit redirects as self redirects', async () => {
    const { routeProtectionInternals } = await import('../src/sveltekit/server')

    expect(routeProtectionInternals.isSameUrl(
      new URL('https://app.test/login'),
      new URL('https://other.test/login'),
    )).toBe(false)
  })

  it('allows SvelteKit route guards to redirect across origins with the same path', async () => {
    vi.doMock('../src/index', () => ({
      default: {
        guard() {
          return {
            provider: vi.fn(async () => 'users'),
            user: vi.fn(async () => null),
          }
        },
      },
      authRuntimeInternals: {
        getRuntimeBindings() {
          return {
            config: {
              defaults: {
                guard: 'web',
              },
            },
          }
        },
      },
      provider: vi.fn(async () => 'users'),
      user: vi.fn(async () => ({
        id: 1,
        email: 'ava@example.com',
        name: 'Ava',
      })),
    }))

    const { guestOnly } = await import('../src/sveltekit/server')
    const resolve = vi.fn(() => new Response('ok'))
    const guestResponse = await guestOnly({
      routes: ['/login'],
      redirectTo: 'https://other.test/login',
    })({
      event: {
        url: new URL('https://app.test/login'),
      },
      resolve,
    })

    expect(guestResponse.status).toBe(303)
    expect(guestResponse.headers.get('location')).toBe('https://other.test/login')
    expect(resolve).not.toHaveBeenCalled()

    vi.resetModules()
    vi.doMock('../src/index', () => ({
      default: {
        guard() {
          return {
            provider: vi.fn(async () => null),
            user: vi.fn(async () => null),
          }
        },
      },
      authRuntimeInternals: {
        getRuntimeBindings() {
          return {
            config: {
              defaults: {
                guard: 'web',
              },
            },
          }
        },
      },
      provider: vi.fn(async () => null),
      user: vi.fn(async () => null),
    }))

    const { authOnly: freshAuthOnly } = await import('../src/sveltekit/server')
    const authResponse = await freshAuthOnly({
      routes: ['/login'],
      redirectTo: 'https://other.test/login',
    })({
      event: {
        url: new URL('https://app.test/login'),
      },
      resolve,
    })

    expect(authResponse.status).toBe(303)
    expect(authResponse.headers.get('location')).toBe('https://other.test/login')
  })

  it('leaves SvelteKit CSRF cookies to the security middleware', async () => {
    vi.doMock('../src/index', () => ({
      default: {
        guard() {
          return {
            provider: vi.fn(async () => null),
            user: vi.fn(async () => null),
          }
        },
      },
      authRuntimeInternals: {
        getRuntimeBindings() {
          return {
            config: {
              defaults: {
                guard: 'web',
              },
            },
          }
        },
      },
      provider: vi.fn(async () => null),
      user: vi.fn(async () => null),
    }))

    const setCookie = vi.fn()
    const { guestOnly } = await import('../src/sveltekit/server')
    const resolve = vi.fn(() => new Response('ok'))
    await guestOnly({
      routes: ['/login'],
      redirectTo: '/admin',
    })({
      event: {
        url: new URL('http://app.test/login'),
        cookies: {
          get: vi.fn(() => undefined),
          set: setCookie,
        },
        request: {
          method: 'GET',
          headers: new Headers({
            'x-forwarded-proto': 'https',
          }),
        },
      },
      resolve,
    })

    expect(resolve).toHaveBeenCalledOnce()
    expect(setCookie).not.toHaveBeenCalled()
  })

  it('compares Nuxt self redirects by pathname without query strings', async () => {
    const navigateTo = vi.fn()
    vi.doMock('#imports', () => createNuxtImportsMock({ navigateTo }))
    vi.doMock('../src/nuxt', () => ({
      useAuth: vi.fn(async () => ({
        authenticated: { value: true },
      })),
    }))

    const { guestOnly } = await import('../src/nuxt/server')

    const queryRedirect = guestOnly({
      routes: ['/login'],
      redirectTo: '/login?returnUrl=/admin',
    })
    const absoluteRedirect = guestOnly({
      routes: ['/login'],
      redirectTo: 'https://app.test/login#top',
    })
    const differentRedirect = guestOnly({
      routes: ['/login'],
      redirectTo: '/register?returnUrl=/admin',
    })
    const malformedRedirect = guestOnly({
      routes: ['/login'],
      redirectTo: 'http://[',
    })

    await queryRedirect({ path: '/login' }, { path: '/' })
    await absoluteRedirect({ path: '/login' }, { path: '/' })
    expect(navigateTo).not.toHaveBeenCalled()

    await differentRedirect({ path: '/login' }, { path: '/' })
    await malformedRedirect({ path: '/login' }, { path: '/' })

    expect(navigateTo).toHaveBeenNthCalledWith(1, '/register?returnUrl=/admin', {
      redirectCode: 303,
    })
    expect(navigateTo).toHaveBeenNthCalledWith(2, 'http://[', {
      redirectCode: 303,
    })
  })

  it('matches Nuxt protected routes across matcher types', async () => {
    const navigateTo = vi.fn()
    vi.doMock('#imports', () => createNuxtImportsMock({ navigateTo }))
    vi.doMock('../src/nuxt', () => ({
      useAuth: vi.fn(async () => ({
        authenticated: { value: true },
      })),
    }))

    const { guestOnly } = await import('../src/nuxt/server')
    const routeMatcher = vi.fn((pathname: string) => pathname === '/admin')
    const regexMatcher = /^\/admin$/g

    await guestOnly({ routes: ['/'], redirectTo: '/dashboard' })({ path: '/' }, { path: '/' })
    await guestOnly({ routes: [routeMatcher], redirectTo: '/dashboard' })({ path: '/admin/' }, { path: '/' })
    expect(routeMatcher).toHaveBeenCalledWith('/admin')
    await guestOnly({ routes: [regexMatcher], redirectTo: '/dashboard' })({ path: '/admin/' }, { path: '/' })
    await guestOnly({ routes: ['/admin/*'], redirectTo: '/dashboard' })({ path: '/admin/settings' }, { path: '/' })
    await guestOnly({ routes: ['/admin/*'], redirectTo: '/dashboard' })({ path: '/administrator' }, { path: '/' })
    await guestOnly({ redirectTo: '/dashboard' })({ path: '/anything' }, { path: '/' })

    expect(navigateTo).toHaveBeenCalledTimes(5)
  })

  it('keeps Nuxt useAuth authenticated state from the current-auth response', async () => {
    const data = {
      value: {
        authenticated: true,
        guard: 'web',
        provider: null,
        user: null,
      },
    }
    const refresh = vi.fn(async () => {
      data.value = {
        authenticated: false,
        guard: 'web',
        provider: null,
        user: null,
      }
    })
    const useFetch = vi.fn(async () => ({
      data,
      refresh,
    }))

    vi.doMock('#imports', () => createNuxtImportsMock({ useFetch }))

    const { useAuth } = await import('../src/nuxt')
    const auth = await useAuth()

    expect(auth.authenticated.value).toBe(true)
    expect(auth.provider.value).toBeNull()
    expect(auth.user.value).toBeNull()

    await expect(auth.refreshUser()).resolves.toBeNull()

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(auth.authenticated.value).toBe(false)
  })

  it('passes the configured guard through Nuxt guest-only middleware', async () => {
    const useAuth = vi.fn(async (_options?: { readonly guard?: string }) => ({
      authenticated: { value: true },
    }))
    const navigateTo = vi.fn((path: string, options: { readonly redirectCode?: number }) => ({
      path,
      options,
    }))

    vi.doMock('../src/nuxt', () => ({
      useAuth,
    }))
    vi.doMock('#imports', () => createNuxtImportsMock({ navigateTo }))

    const { guestOnly } = await import('../src/nuxt/server')
    const middleware = guestOnly({
      guard: 'admin',
      routes: ['/super-admin/login'],
      redirectTo: '/super-admin',
      status: 302,
    })

    await expect(middleware(
      { path: '/super-admin/login' },
      { path: '/' },
    )).resolves.toEqual({
      path: '/super-admin',
      options: { redirectCode: 302 },
    })
    expect(useAuth).toHaveBeenCalledWith({ guard: 'admin' })
    expect(navigateTo).toHaveBeenCalledWith('/super-admin', { redirectCode: 302 })
  })

  it('leaves Nuxt CSRF cookies to the security middleware before allowing guest pages', async () => {
    vi.doMock('../src/nuxt', () => ({
      useAuth: vi.fn(async () => ({
        authenticated: { value: false },
      })),
    }))
    vi.doMock('#imports', () => createNuxtImportsMock())

    const { guestOnly } = await import('../src/nuxt/server')
    const middleware = guestOnly({
      routes: ['/login'],
      redirectTo: '/admin',
    })

    await expect(middleware({ path: '/login' }, { path: '/' })).resolves.toBeUndefined()
  })

  it('passes the configured guard through Nuxt auth-only middleware', async () => {
    const useAuth = vi.fn(async (_options?: { readonly guard?: string }) => ({
      authenticated: { value: false },
    }))
    const navigateTo = vi.fn((path: string, options: { readonly redirectCode?: number }) => ({
      path,
      options,
    }))

    vi.doMock('../src/nuxt', () => ({
      useAuth,
    }))
    vi.doMock('#imports', () => createNuxtImportsMock({ navigateTo }))

    const { authOnly } = await import('../src/nuxt/server')
    const middleware = authOnly({
      guard: 'admin',
      routes: ['/super-admin/*'],
      redirectTo: '/super-admin/login',
    })

    await expect(middleware(
      { path: '/super-admin' },
      { path: '/' },
    )).resolves.toEqual({
      path: '/super-admin/login',
      options: { redirectCode: 303 },
    })
    expect(useAuth).toHaveBeenCalledWith({ guard: 'admin' })
    expect(navigateTo).toHaveBeenCalledWith('/super-admin/login', { redirectCode: 303 })
  })

  it('keeps Nuxt route middleware on the default guard when guard is omitted', async () => {
    const useAuth = vi.fn(async (_options?: { readonly guard?: string }) => ({
      authenticated: { value: false },
    }))
    const navigateTo = vi.fn((path: string, options: { readonly redirectCode?: number }) => ({
      path,
      options,
    }))

    vi.doMock('../src/nuxt', () => ({
      useAuth,
    }))
    vi.doMock('#imports', () => createNuxtImportsMock({ navigateTo }))

    const { authOnly } = await import('../src/nuxt/server')
    const middleware = authOnly({
      routes: ['/admin/*'],
      redirectTo: '/login',
    })

    await middleware({ path: '/admin/posts' }, { path: '/' })

    expect(useAuth).toHaveBeenCalledWith(undefined)
    expect(navigateTo).toHaveBeenCalledWith('/login', { redirectCode: 303 })
  })

  it('keeps Nuxt route middleware branch behavior unchanged', async () => {
    let authenticated = false
    const useAuth = vi.fn(async (_options?: { readonly guard?: string }) => ({
      authenticated: { value: authenticated },
    }))
    const navigateTo = vi.fn((path: string, options: { readonly redirectCode?: number }) => ({
      path,
      options,
    }))

    vi.doMock('../src/nuxt', () => ({
      useAuth,
    }))
    vi.doMock('#imports', () => createNuxtImportsMock({ navigateTo }))

    const { authOnly, guestOnly } = await import('../src/nuxt/server')
    const guestMiddleware = guestOnly({
      routes: ['/login'],
      redirectTo: '/admin',
    })

    await expect(guestMiddleware({ path: '/register' }, { path: '/' })).resolves.toBeUndefined()
    expect(useAuth).not.toHaveBeenCalled()

    await expect(guestMiddleware({ path: '/login' }, { path: '/' })).resolves.toBeUndefined()
    expect(useAuth).toHaveBeenCalledTimes(1)

    authenticated = true
    const guestSelfRedirect = guestOnly({
      routes: ['/admin'],
      redirectTo: '/admin?from=login',
    })
    await expect(guestSelfRedirect({ path: '/admin' }, { path: '/' })).resolves.toBeUndefined()

    const guestDefaultRoutes = guestOnly({
      redirectTo: '/admin',
    })
    await expect(guestDefaultRoutes({ path: '/login' }, { path: '/' })).resolves.toEqual({
      path: '/admin',
      options: { redirectCode: 303 },
    })

    const authMiddleware = authOnly({
      routes: ['/admin'],
      redirectTo: '/login',
    })
    await expect(authMiddleware({ path: '/public' }, { path: '/' })).resolves.toBeUndefined()

    await expect(authMiddleware({ path: '/admin' }, { path: '/' })).resolves.toBeUndefined()

    authenticated = false
    const authSelfRedirect = authOnly({
      routes: ['/login'],
      redirectTo: '/login?returnUrl=/admin',
    })
    await expect(authSelfRedirect({ path: '/login' }, { path: '/' })).resolves.toBeUndefined()
  })

  it('propagates Next client refresh failures after reporting them', async () => {
    const failure = new Error('refresh failed')
    const fetchCurrentUser = vi.fn(async () => { throw failure })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.doMock('../src/client', () => ({ authClientInternals: { fetchCurrentUser } }))
    vi.doMock('next/navigation.js', () => ({ usePathname: () => '/settings' }))
    vi.doMock('react', () => createReactMock())
    const { useAuth } = await import('../src/next/client')
    const current = useAuth({ endpoint: '/api/auth/current', initialUser: null })

    await expect(current.refreshUser()).rejects.toThrow('refresh failed')
    expect(error).toHaveBeenCalledWith('Failed to refresh auth user.', failure)
  })

  it('refreshes the Next client on mount when no initial user is supplied', async () => {
    const fetchCurrentUser = vi.fn(async () => ({
      authenticated: false,
      guard: 'web',
      provider: null,
      user: null,
    }))
    vi.doMock('../src/client', () => ({ authClientInternals: { fetchCurrentUser } }))
    vi.doMock('next/navigation.js', () => ({ usePathname: () => '/login' }))
    vi.doMock('react', () => createReactMock())
    const { useAuth } = await import('../src/next/client')
    useAuth()
    await vi.waitFor(() => expect(fetchCurrentUser).toHaveBeenCalledWith({}, { force: true }))
  })

  it('returns a safe Next auth state when runtime user resolution fails', async () => {
    const connection = vi.fn(async () => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.doMock('next/server.js', () => ({ connection }))
    vi.doMock('../src/index', () => ({
      default: { guard: () => ({ user: async () => { throw new Error('failed') }, provider: async () => null }) },
      authRuntimeInternals: { getRuntimeBindings: () => ({ config: { defaults: { guard: 'web' } } }) },
      provider: async () => null,
      user: async () => { throw new Error('failed') },
    }))
    const { auth, routeProtectionInternals } = await import('../src/next/server')
    await expect(auth()).resolves.toEqual({ authenticated: false, guard: 'web', provider: null, user: null })
    expect(connection).toHaveBeenCalledOnce()
    expect(routeProtectionInternals.matchesRoute('/', '/')).toBe(true)
  })

  it('constructs relative and absolute Nuxt auth URLs with guards', async () => {
    const useFetch = vi.fn(async () => ({
      data: { value: { authenticated: false, guard: 'admin', provider: null, user: null } },
      refresh: vi.fn(),
    }))
    vi.doMock('#imports', () => createNuxtImportsMock({ useFetch }))
    const { useAuth } = await import('../src/nuxt')
    await useAuth({ endpoint: '/api/auth/user?from=test#hash', guard: 'admin', key: 'relative' })
    await useAuth({ endpoint: 'https://api.test/auth?from=test', guard: 'admin', key: 'absolute' })
    expect(useFetch).toHaveBeenNthCalledWith(1, '/api/auth/user?from=test&guard=admin#hash', { key: 'relative:request' })
    expect(useFetch).toHaveBeenNthCalledWith(2, 'https://api.test/auth?from=test&guard=admin', { key: 'absolute:request' })
  })

  it('keeps Nuxt auth state empty when fetch data remains unavailable', async () => {
    const data = { value: undefined }
    const useFetch = vi.fn(async () => ({ data, refresh: vi.fn(async () => {}) }))
    vi.doMock('#imports', () => createNuxtImportsMock({ useFetch }))
    const { useAuth } = await import('../src/nuxt')
    const current = await useAuth()
    expect(current.authenticated.value).toBe(false)
    await expect(current.refreshUser()).resolves.toBeNull()
    expect(current.authenticated.value).toBe(false)
  })

  it('deduplicates SvelteKit client refreshes and tolerates missing component context', async () => {
    let resolveRefresh!: (value: {
      authenticated: boolean
      guard: string
      provider: string
      user: { id: number, email: string, name: string }
    }) => void
    const pending = new Promise<{
      authenticated: boolean
      guard: string
      provider: string
      user: { id: number, email: string, name: string }
    }>((resolve) => { resolveRefresh = resolve })
    const fetchCurrentUser = vi.fn(() => pending)
    const cleanups: Array<() => void> = []
    vi.doMock('../src/client', () => ({ authClientInternals: { fetchCurrentUser } }))
    vi.doMock('svelte', () => ({
      getContext() { throw new Error('outside component') },
      setContext() { throw new Error('outside component') },
    }))
    vi.doMock('svelte/reactivity', () => ({
      createSubscriber(start: (update: () => void) => () => void) {
        let started = false
        return () => {
          if (!started) {
            started = true
            cleanups.push(start(() => {}))
          }
        }
      },
    }))
    const { useAuth } = await import('../src/sveltekit/client')
    const current = useAuth()
    expect(current.authenticated).toBe(false)
    expect(current.provider).toBeNull()
    expect(current.user).toBeNull()
    const first = current.refreshUser()
    const second = current.refreshUser()
    expect(fetchCurrentUser).toHaveBeenCalledOnce()
    resolveRefresh({
      authenticated: true,
      guard: 'web',
      provider: 'users',
      user: { id: 1, email: 'ava@example.com', name: 'Ava' },
    })
    await expect(first).resolves.toMatchObject({ id: 1 })
    await expect(second).resolves.toMatchObject({ id: 1 })
    expect(current.authenticated).toBe(true)
    expect(current.provider).toBe('users')
    cleanups.forEach(cleanup => cleanup())
    await expect(current.refreshUser()).resolves.toMatchObject({ id: 1 })
  })

  it('covers SvelteKit route matcher, continuation, self-redirect, and auth failure behavior', async () => {
    let currentUser: { id: number, email: string, name: string, toJSON?: () => unknown } | null = null
    let fail = false
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.doMock('../src/index', () => ({
      default: {
        guard() {
          return {
            provider: async () => currentUser ? 'users' : null,
            user: async () => {
              if (fail) throw new Error('auth failed')
              return currentUser
            },
          }
        },
      },
      authRuntimeInternals: {
        getRuntimeBindings: () => ({ config: { defaults: { guard: 'web' } } }),
      },
      provider: async () => currentUser ? 'users' : null,
      user: async () => {
        if (fail) throw new Error('auth failed')
        return currentUser
      },
    }))
    const { auth, authOnly, guestOnly, routeProtectionInternals } = await import('../src/sveltekit/server')
    expect(routeProtectionInternals.matchesRoutes(undefined, '/anything')).toBe(true)
    expect(routeProtectionInternals.matchesRoute('/', '/')).toBe(true)
    expect(routeProtectionInternals.matchesRoute('/admin/*', '/admin/settings/')).toBe(true)
    expect(routeProtectionInternals.matchesRoute(/^\/admin$/g, '/admin/')).toBe(true)
    expect(routeProtectionInternals.matchesRoute(path => path === '/admin', '/admin/')).toBe(true)
    expect(routeProtectionInternals.matchesRoute('/admin', '/public')).toBe(false)

    const resolve = vi.fn(() => new Response('ok'))
    const basicEvent = { url: new URL('https://app.test/public') }
    await expect(guestOnly({ routes: ['/login'], redirectTo: '/admin' })({ event: basicEvent, resolve })).resolves.toMatchObject({ status: 200 })

    currentUser = { id: 1, email: 'ava@example.com', name: 'Ava', toJSON: () => ({ id: 1, email: 'safe@app.test', name: 'Safe' }) }
    await expect(auth()).resolves.toMatchObject({ authenticated: true, user: { email: 'safe@app.test' } })
    await expect(auth({ guard: 'admin' })).resolves.toMatchObject({ authenticated: true, provider: 'users' })
    const selfEvent = { url: new URL('https://app.test/login') }
    await expect(guestOnly({ routes: ['/login'], redirectTo: '/login' })({ event: selfEvent, resolve })).resolves.toMatchObject({ status: 200 })

    currentUser = null
    await expect(authOnly({ routes: ['/admin'], redirectTo: '/login' })({
      event: { url: new URL('https://app.test/admin') },
      resolve,
    })).resolves.toMatchObject({ status: 303 })

    fail = true
    await expect(auth({ guard: 'admin' })).resolves.toEqual({
      authenticated: false,
      guard: 'admin',
      provider: null,
      user: null,
    })
  })

  it('restores synchronous fallback Next request context callbacks', async () => {
    const globals = globalThis as typeof globalThis & { __holoNextAuthRequestStore?: unknown }
    delete globals.__holoNextAuthRequestStore
    const { getCurrentNextAuthRequest, runWithNextAuthRequest } = await import('../src/next/request-context')
    const request = { cookies: { get: vi.fn() }, headers: new Headers() }
    expect(runWithNextAuthRequest(request, () => getCurrentNextAuthRequest())).toBe(request)
    expect(getCurrentNextAuthRequest()).toBeUndefined()
  })

  it('uses a global AsyncLocalStorage implementation for Next request context when available', async () => {
    const globals = globalThis as typeof globalThis & {
      AsyncLocalStorage?: new <TValue>() => {
        getStore(): TValue | undefined
        run<TResult>(value: TValue, callback: () => TResult): TResult
      }
      __holoNextAuthRequestStore?: unknown
    }
    delete globals.__holoNextAuthRequestStore
    class TestStorage<TValue> {
      value?: TValue
      getStore(): TValue | undefined { return this.value }
      run<TResult>(value: TValue, callback: () => TResult): TResult {
        this.value = value
        return callback()
      }
    }
    vi.stubGlobal('AsyncLocalStorage', TestStorage)
    vi.resetModules()
    const { getCurrentNextAuthRequest, runWithNextAuthRequest } = await import('../src/next/request-context')
    const request = { cookies: { get: vi.fn() }, headers: new Headers() }
    expect(runWithNextAuthRequest(request, () => getCurrentNextAuthRequest())).toBe(request)
  })

  it('derives Next route URLs when nextUrl is absent', async () => {
    vi.doMock('../src/index', () => ({
      default: { guard: () => ({ provider: async () => null, user: async () => null }) },
      authRuntimeInternals: { getRuntimeBindings: () => ({ config: { defaults: { guard: 'web' } } }) },
      provider: async () => null,
      user: async () => null,
    }))
    const { authOnly } = await import('../src/next/server')
    const response = await authOnly({ routes: ['/admin'], redirectTo: '/login' })({
      cookies: { get: vi.fn() },
      headers: new Headers(),
      url: 'https://app.test/admin',
    })
    expect(response?.status).toBe(303)
  })

  it('reuses a plain Svelte context without treating it as mutable client state', async () => {
    const context = {
      authenticated: true,
      provider: 'users',
      user: { id: 1, email: 'plain@app.test', name: 'Plain' },
      refreshUser: async () => null,
    }
    vi.doMock('../src/client', () => ({ authClientInternals: { fetchCurrentUser: vi.fn() } }))
    vi.doMock('svelte', () => ({ getContext: () => context, setContext: vi.fn() }))
    vi.doMock('svelte/reactivity', () => ({ createSubscriber: () => () => {} }))
    const { useAuth } = await import('../src/sveltekit/client')
    expect(useAuth()).toBe(context)
  })
})
