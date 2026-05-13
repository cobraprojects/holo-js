import { afterEach, describe, expect, it, vi } from 'vitest'

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

describe('@holo-js/auth framework helpers', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.doUnmock('#imports')
    vi.doUnmock('react')
    vi.doUnmock('../src/client')
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

    await defaultAuth.refreshUser()

    expect(fetchCurrentUser).toHaveBeenCalledWith({}, { force: true })
  })

  it('does not treat cross-origin Next redirects as self redirects', async () => {
    const { routeProtectionInternals } = await import('../src/next/server')

    expect(routeProtectionInternals.isSameUrl(
      new URL('https://app.test/login'),
      new URL('https://other.test/login'),
    )).toBe(false)
  })

  it('compares Nuxt self redirects by pathname without query strings', async () => {
    vi.doMock('#imports', () => ({
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
    }))

    const { routeProtectionInternals } = await import('../src/nuxt/server')

    expect(routeProtectionInternals.isSamePath('/login', '/login?returnUrl=/admin')).toBe(true)
    expect(routeProtectionInternals.isSamePath('/login', 'https://app.test/login#top')).toBe(true)
    expect(routeProtectionInternals.isSamePath('/login', '/register?returnUrl=/admin')).toBe(false)
  })
})
