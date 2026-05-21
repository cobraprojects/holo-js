import { execFile } from 'node:child_process'
import { createHmac } from 'node:crypto'
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
    useCookie: vi.fn(() => ({ value: undefined })),
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
    vi.doUnmock('react')
    vi.doUnmock('../src/client')
    vi.doUnmock('../src/index')
  })

  it('reuses the Next auth provider when useAuth receives an empty options object', async () => {
    const refreshUser = vi.fn(async () => null)
    vi.doMock('../src/client', () => ({
      refreshUser,
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
        'next/server',
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
        'next/server',
        '--outfile',
        outputPath,
      ], {
        cwd: packageRoot,
      })

      await expect(readFile(outputPath, 'utf8')).resolves.not.toContain('async_hooks')
    } finally {
      await rm(tempDir, { force: true, recursive: true })
    }
  })

  it('keeps the current Next request available while route protection resolves auth state', async () => {
    let observedRequest: unknown

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
    expect(response?.status).toBe(303)
    expect(response?.headers.get('location')).toBe('https://app.test/admin')
  })

  it('issues a signed CSRF cookie when Next route protection lets a guest page continue', async () => {
    const previousAppKey = process.env.APP_KEY
    process.env.APP_KEY = 'next-csrf-signing-key'

    try {
      vi.doMock('next/server', () => ({
        NextResponse: {
          next() {
            const response = new Response(null, {
              headers: {
                'x-middleware-next': '1',
              },
            })
            const headers = response.headers

            return Object.assign(response, {
              cookies: {
                set(name: string, value: string, options: { readonly path?: string, readonly sameSite?: string, readonly secure?: boolean }) {
                  headers.append('set-cookie', [
                    `${name}=${encodeURIComponent(value)}`,
                    options.path ? `Path=${options.path}` : undefined,
                    options.sameSite ? `SameSite=${options.sameSite[0]?.toUpperCase()}${options.sameSite.slice(1)}` : undefined,
                    options.secure ? 'Secure' : undefined,
                  ].filter((attribute): attribute is string => typeof attribute === 'string').join('; '))
                },
              },
            })
          },
        },
      }))

      const { protectRoutes } = await import('../src/next/server')
      const request = {
        method: 'GET',
        cookies: {
          get: vi.fn(() => undefined),
        },
        headers: new Headers(),
        nextUrl: new URL('https://app.test/login'),
        url: 'https://app.test/login',
      }
      const response = await protectRoutes(async () => undefined)(request)
      const setCookie = response?.headers.get('set-cookie') ?? ''
      const encodedToken = setCookie.split(';', 1)[0]?.slice('XSRF-TOKEN='.length)
      const token = decodeURIComponent(encodedToken ?? '')
      const separator = token.indexOf('.')
      const nonce = token.slice(0, separator)
      const signature = token.slice(separator + 1)

      expect(response?.headers.get('x-middleware-next')).toBe('1')
      expect(setCookie).toContain('XSRF-TOKEN=')
      expect(setCookie).toContain('Path=/')
      expect(setCookie).toContain('SameSite=Lax')
      expect(setCookie).toContain('Secure')
      expect(separator).toBeGreaterThan(0)
      expect(signature).toBe(createHmac('sha256', 'next-csrf-signing-key')
        .update(nonce)
        .digest('base64url'))
    } finally {
      if (typeof previousAppKey === 'undefined') {
        delete process.env.APP_KEY
      } else {
        process.env.APP_KEY = previousAppKey
      }
    }
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

  it('issues a signed SvelteKit CSRF cookie before resolving guest pages', async () => {
    const previousAppKey = process.env.APP_KEY
    process.env.APP_KEY = 'sveltekit-csrf-signing-key'

    try {
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
          url: new URL('https://app.test/login'),
          cookies: {
            get: vi.fn(() => undefined),
            set: setCookie,
          },
          request: {
            method: 'GET',
            headers: new Headers(),
          },
        },
        resolve,
      })
      const [name, token, options] = setCookie.mock.calls[0] ?? []
      const separator = typeof token === 'string' ? token.indexOf('.') : -1
      const nonce = typeof token === 'string' ? token.slice(0, separator) : ''
      const signature = typeof token === 'string' ? token.slice(separator + 1) : ''

      expect(name).toBe('XSRF-TOKEN')
      expect(options).toEqual({
        path: '/',
        sameSite: 'lax',
        secure: true,
      })
      expect(signature).toBe(createHmac('sha256', 'sveltekit-csrf-signing-key')
        .update(nonce)
        .digest('base64url'))
    } finally {
      if (typeof previousAppKey === 'undefined') {
        delete process.env.APP_KEY
      } else {
        process.env.APP_KEY = previousAppKey
      }
    }
  })

  it('compares Nuxt self redirects by pathname without query strings', async () => {
    vi.doMock('#imports', () => createNuxtImportsMock())

    const { routeProtectionInternals } = await import('../src/nuxt/server')

    expect(routeProtectionInternals.isSamePath('/login', '/login?returnUrl=/admin')).toBe(true)
    expect(routeProtectionInternals.isSamePath('/login', 'https://app.test/login#top')).toBe(true)
    expect(routeProtectionInternals.isSamePath('/login', '/register?returnUrl=/admin')).toBe(false)
    expect(routeProtectionInternals.isSamePath('/login', 'http://[')).toBe(false)
  })

  it('matches Nuxt protected routes across matcher types', async () => {
    vi.doMock('#imports', () => createNuxtImportsMock())

    const { routeProtectionInternals } = await import('../src/nuxt/server')
    const routeMatcher = vi.fn((pathname: string) => pathname === '/admin')
    const regexMatcher = /^\/admin$/g

    expect(routeProtectionInternals.matchesRoute('/', '/')).toBe(true)
    expect(routeProtectionInternals.matchesRoute(routeMatcher, '/admin/')).toBe(true)
    expect(routeMatcher).toHaveBeenCalledWith('/admin')
    expect(routeProtectionInternals.matchesRoute(regexMatcher, '/admin/')).toBe(true)
    expect(routeProtectionInternals.matchesRoute('/admin/*', '/admin/settings')).toBe(true)
    expect(routeProtectionInternals.matchesRoute('/admin/*', '/administrator')).toBe(false)
    expect(routeProtectionInternals.matchesRoutes(undefined, '/anything')).toBe(true)
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

  it('issues a signed Nuxt CSRF cookie before allowing guest pages', async () => {
    const previousAppKey = process.env.APP_KEY
    const previousAppUrl = process.env.APP_URL
    process.env.APP_KEY = 'nuxt-csrf-signing-key'
    process.env.APP_URL = 'https://app.test'

    try {
      const cookie = { value: undefined as string | undefined }
      const useCookie = vi.fn(() => cookie)
      vi.doMock('../src/nuxt', () => ({
        useAuth: vi.fn(async () => ({
          authenticated: { value: false },
        })),
      }))
      vi.doMock('#imports', () => createNuxtImportsMock({ useCookie }))

      const { guestOnly } = await import('../src/nuxt/server')
      const middleware = guestOnly({
        routes: ['/login'],
        redirectTo: '/admin',
      })

      await expect(middleware({ path: '/login' }, { path: '/' })).resolves.toBeUndefined()

      const separator = cookie.value?.indexOf('.') ?? -1
      const nonce = cookie.value?.slice(0, separator) ?? ''
      const signature = cookie.value?.slice(separator + 1) ?? ''

      expect(useCookie).toHaveBeenCalledWith('XSRF-TOKEN', {
        path: '/',
        sameSite: 'lax',
        secure: true,
      })
      expect(signature).toBe(createHmac('sha256', 'nuxt-csrf-signing-key')
        .update(nonce)
        .digest('base64url'))
    } finally {
      if (typeof previousAppKey === 'undefined') {
        delete process.env.APP_KEY
      } else {
        process.env.APP_KEY = previousAppKey
      }

      if (typeof previousAppUrl === 'undefined') {
        delete process.env.APP_URL
      } else {
        process.env.APP_URL = previousAppUrl
      }
    }
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
})
