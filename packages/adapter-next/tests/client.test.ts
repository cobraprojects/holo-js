import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { field, schema } from '@holo-js/forms'
import type { RealtimeSubscriptionSnapshot } from '@holo-js/realtime'
import type { ClientSubmitContext, UseFormOptions } from '@holo-js/forms/internal/client'

type MockReactContext<TValue> = {
  currentRenderValue: TValue
  readonly Provider: (props: { readonly value: TValue, readonly children?: unknown }) => unknown
}

type ReactHookState = {
  currentHookIndex: number
  hookValues: unknown[]
}

type ReactHookStateOptions = {
  readonly onStateChange?: (index: number, value: unknown) => void
}

type PromiseRecord =
  | { readonly status: 'pending' }
  | { readonly status: 'fulfilled', readonly value: unknown }
  | { readonly status: 'rejected', readonly reason: unknown }

const promiseRecords = new WeakMap<PromiseLike<unknown>, PromiseRecord>()

function readPromise<TValue>(promise: PromiseLike<TValue>): TValue {
  const record = promiseRecords.get(promise)
  if (record?.status === 'fulfilled') return record.value as TValue
  if (record?.status === 'rejected') throw record.reason
  if (!record) {
    promiseRecords.set(promise, { status: 'pending' })
    void promise.then(
      value => promiseRecords.set(promise, { status: 'fulfilled', value }),
      reason => promiseRecords.set(promise, { status: 'rejected', reason }),
    )
  }
  throw promise
}

function captureSuspensePromise(callback: () => unknown): Promise<unknown> {
  try {
    callback()
  } catch (error) {
    if (error instanceof Promise) return error
    throw error
  }

  throw new Error('Expected rendering to suspend with a Promise.')
}

function createReactMock(overrides: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return {
    cache<TFunction extends (...args: never[]) => unknown>(fn: TFunction) {
      return fn
    },
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
    useContext<TValue>(context: MockReactContext<TValue>): TValue {
      return context.currentRenderValue
    },
    useMemo<TValue>(factory: () => TValue) {
      return factory()
    },
    use<TValue>(value: PromiseLike<TValue>): TValue {
      return readPromise(value)
    },
    ...overrides,
  }
}

function createReactHookState(): ReactHookState {
  return {
    currentHookIndex: 0,
    hookValues: [],
  }
}

function markClientSubmitControlFlowError(error: unknown): unknown {
  return error
}

function createReactHookStateMock(
  state: ReactHookState,
  options: ReactHookStateOptions = {},
): Readonly<Record<string, unknown>> {
  return createReactMock({
    useCallback<TCallback extends (...args: never[]) => unknown>(callback: TCallback) {
      return callback
    },
    useEffect(effect: () => void | (() => void)) {
      return effect()
    },
    useRef<TValue>(initialValue?: TValue) {
      const index = state.currentHookIndex++

      if (!(index in state.hookValues)) {
        state.hookValues[index] = { current: initialValue }
      }

      return state.hookValues[index] as { current: TValue | undefined }
    },
    useState<TValue>(initialState: TValue | (() => TValue)) {
      const index = state.currentHookIndex++

      if (!(index in state.hookValues)) {
        state.hookValues[index] = typeof initialState === 'function'
          ? (initialState as () => TValue)()
          : initialState
      }

      const setState = (next: TValue | ((previous: TValue) => TValue)) => {
        const previous = state.hookValues[index] as TValue
        const value = typeof next === 'function'
          ? (next as (previous: TValue) => TValue)(previous)
          : next

        state.hookValues[index] = value
        options.onStateChange?.(index, value)
      }

      return [state.hookValues[index] as TValue, setState] as const
    },
  })
}

describe('@holo-js/adapter-next client', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {})
    vi.doMock('next/navigation', () => ({
      useServerInsertedHTML() {},
    }))
  })

  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.doUnmock('react')
    vi.doUnmock('next/navigation')
    vi.doUnmock('@holo-js/forms/internal/client')
    vi.unstubAllGlobals()
  })

  it('wraps the shared form client with a React subscription bridge', async () => {
    const rerenders: number[] = []
    let subscribedListener: (() => void) | undefined
    const fakeForm = {
      subscribe(listener: () => void) {
        subscribedListener = listener
        return () => {}
      },
    }

    vi.doMock('@holo-js/forms/internal/client', () => ({
      createFormClient: vi.fn(() => fakeForm),
      markClientSubmitControlFlowError,
    }))

    vi.doMock('react', () => createReactMock({
      useCallback<TCallback extends (...args: never[]) => unknown>(callback: TCallback) {
        return callback
      },
      useEffect(effect: () => void | (() => void)) {
        void effect()
      },
      useRef<TValue>(initialValue?: TValue) {
        return { current: initialValue }
      },
      useState<TValue>(initialState: TValue | (() => TValue)) {
        const value = typeof initialState === 'function'
          ? (initialState as () => TValue)()
          : initialState

        return [value, (next: TValue | ((previous: TValue) => TValue)) => {
          const resolved = typeof next === 'function'
            ? (next as (previous: number) => number)(0 as TValue & number)
            : next

          if (typeof resolved === 'number') {
            rerenders.push(resolved)
          }
        }] as const
      },
    }))

    const { useForm } = await import('../src/client')
    const login = schema({
      email: field.string().required().email(),
    })

    const form = useForm(login, {
      initialValues: {
        email: 'ava@example.com',
      },
    })

    subscribedListener?.()

    expect(form).toBe(fakeForm)
    expect(rerenders).toEqual([1])
  })

  it('throws HTTP submitter errors through the Next render boundary', async () => {
    type PostFormData = {
      readonly title: string
    }
    const state = createReactHookState()

    let capturedSubmitter: UseFormOptions<PostFormData, unknown>['submitter']
    const forbidden = Object.assign(new Error('Only the author can update posts.'), {
      status: 403,
    })
    const fakeForm = {
      subscribe() {
        return () => {}
      },
    }

    vi.doMock('@holo-js/forms/internal/client', () => ({
      createFormClient: vi.fn((_schema, options: UseFormOptions<PostFormData, unknown>) => {
        capturedSubmitter = options.submitter
        return fakeForm
      }),
      markClientSubmitControlFlowError,
    }))

    vi.doMock('react', () => createReactHookStateMock(state))

    const { useForm } = await import('../src/client')
    const post = schema({
      title: field.string().required(),
    })

    const form = useForm(post, {
      submitter: async () => {
        throw forbidden
      },
    })

    expect(form).toBe(fakeForm)
    await expect(capturedSubmitter?.({
      method: 'POST',
      values: { title: 'Draft' },
      formData: new FormData(),
    } satisfies ClientSubmitContext<PostFormData>)).rejects.toBe(forbidden)

    state.currentHookIndex = 0

    expect(() => useForm(post, {
      submitter: async () => {
        throw forbidden
      },
    })).toThrow('Only the author can update posts.')

    try {
      useForm(post, {
        submitter: async () => {
          throw forbidden
        },
      })
    } catch (error) {
      expect(error).toMatchObject({
        digest: 'NEXT_HTTP_ERROR_FALLBACK;403',
      })
    }
  })

  it('rethrows Next redirect submitter errors for the form client control-flow path', async () => {
    type LoginFormData = {
      readonly email: string
    }
    const state = createReactHookState()

    let capturedSubmitter: UseFormOptions<LoginFormData, unknown>['submitter']
    const redirectError = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/admin;303;',
    })
    const fakeForm = {
      subscribe() {
        return () => {}
      },
    }

    vi.doMock('@holo-js/forms/internal/client', () => ({
      createFormClient: vi.fn((_schema, options: UseFormOptions<LoginFormData, unknown>) => {
        capturedSubmitter = options.submitter
        return fakeForm
      }),
      markClientSubmitControlFlowError,
    }))

    vi.doMock('react', () => createReactHookStateMock(state))

    const { useForm } = await import('../src/client')
    const login = schema({
      email: field.string().required().email(),
    })

    const form = useForm(login, {
      submitter: async () => {
        throw redirectError
      },
    })

    expect(form).toBe(fakeForm)
    await expect(capturedSubmitter?.({
      method: 'POST',
      values: { email: 'ava@example.com' },
      formData: new FormData(),
    } satisfies ClientSubmitContext<LoginFormData>)).rejects.toBe(redirectError)
  })

  it('returns updated realtime query data by calling the query definition', async () => {
    type Post = { readonly id: number, readonly title: string }
    type PostSnapshot = RealtimeSubscriptionSnapshot<readonly Post[]>
    let realtimeListener: ((snapshot: PostSnapshot) => void) | undefined

    vi.doMock('react', () => createReactMock({
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

        return [value, () => {}] as const
      },
      useSyncExternalStore<TSnapshot>(
        subscribe: (listener: () => void) => () => void,
        getSnapshot: () => TSnapshot,
      ) {
        subscribe(() => {})
        return getSnapshot()
      },
    }))

    const {
      configureRealtimeClientTransport,
      hydrateRealtimeQuery,
      resetRealtimeClientRuntime,
    } = await import('@holo-js/realtime/client')
    const { query } = await import('@holo-js/realtime')
    await import('../src/realtime')

    const listPosts = query({
      name: 'posts.list',
      access: 'public',
      handler: async () => [{ id: 1, title: 'First' }],
    })

    configureRealtimeClientTransport({
      async query<TResult>() {
        return {
          name: 'posts.list',
          data: [{ id: 1, title: 'First' }] as TResult,
          dependencies: [],
          version: 1,
        }
      },
      async mutate<TResult>() {
        return {
          name: 'posts.create',
          data: { created: true } as TResult,
          dependencies: [],
        }
      },
      subscribe<TResult>(_name: string, _args: Record<string, unknown>, listener: (snapshot: RealtimeSubscriptionSnapshot<TResult>) => void) {
        realtimeListener = snapshot => listener(snapshot as unknown as RealtimeSubscriptionSnapshot<TResult>)
        return () => {}
      },
    })
    hydrateRealtimeQuery(listPosts, {}, {
      name: 'posts.list',
      data: [{ id: 1, title: 'First' }],
      dependencies: [],
      version: 1,
    })

    expect(listPosts()).toEqual([{ id: 1, title: 'First' }])

    realtimeListener?.({
      name: 'posts.list',
      data: [
        { id: 1, title: 'First' },
        { id: 2, title: 'Second' },
      ],
      dependencies: [],
      version: 2,
    })

    expect(listPosts()).toEqual([
      { id: 1, title: 'First' },
      { id: 2, title: 'Second' },
    ])
    resetRealtimeClientRuntime()
  })

  it('does not reconnect realtime queries on unrelated client rerenders', async () => {
    type Post = { readonly id: number, readonly title: string }
    const queryCalls: string[] = []
    const subscribeCalls: string[] = []

    vi.doMock('react', () => createReactMock({
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

        return [value, () => {}] as const
      },
      useSyncExternalStore<TSnapshot>(
        subscribe: (listener: () => void) => () => void,
        getSnapshot: () => TSnapshot,
      ) {
        subscribe(() => {})
        return getSnapshot()
      },
    }))

    const {
      configureRealtimeClientTransport,
      resetRealtimeClientRuntime,
    } = await import('@holo-js/realtime/client')
    const { query } = await import('@holo-js/realtime')
    await import('../src/realtime')

    const listPosts = query({
      name: 'posts.rerender',
      access: 'public',
      handler: async () => [{ id: 1, title: 'First' }],
    })

    configureRealtimeClientTransport({
      async query<TResult>(name: string) {
        queryCalls.push(name)

        return {
          name,
          data: [{ id: 1, title: 'First' }] as TResult,
          dependencies: [],
          version: queryCalls.length,
        }
      },
      async mutate<TResult>(name: string) {
        return {
          name,
          data: {} as TResult,
          dependencies: [],
        }
      },
      subscribe(name: string) {
        subscribeCalls.push(name)

        return () => {}
      },
    })

    const pendingSnapshot = captureSuspensePromise(() => listPosts())
    await pendingSnapshot
    expect(listPosts()).toEqual([{ id: 1, title: 'First' }])
    expect(listPosts()).toEqual([{ id: 1, title: 'First' }])

    expect(queryCalls).toEqual(['posts.rerender'])
    expect(subscribeCalls).toEqual(['posts.rerender'])
    resetRealtimeClientRuntime()
  })

  it('suspends the initial client render until the first realtime query snapshot loads', async () => {
    vi.doMock('react', () => createReactMock({
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

        return [value, () => {}] as const
      },
      useSyncExternalStore<TSnapshot>(
        subscribe: (listener: () => void) => () => void,
        getSnapshot: () => TSnapshot,
      ) {
        subscribe(() => {})
        return getSnapshot()
      },
    }))

    const {
      configureRealtimeClientTransport,
      resetRealtimeClientRuntime,
    } = await import('@holo-js/realtime/client')
    const { query } = await import('@holo-js/realtime')
    await import('../src/realtime')

    const listPosts = query({
      name: 'posts.pending',
      access: 'public',
      handler: async () => [{ id: 1, title: 'First' }],
    })

    configureRealtimeClientTransport({
      async query<TResult>() {
        return {
          name: 'posts.pending',
          data: [{ id: 1, title: 'First' }] as TResult,
          dependencies: [],
          version: 1,
        }
      },
      async mutate<TResult>() {
        return {
          name: 'posts.create',
          data: { created: true } as TResult,
          dependencies: [],
        }
      },
      subscribe() {
        return () => {}
      },
    })

    const pendingSnapshot = captureSuspensePromise(() => listPosts())
    await pendingSnapshot
    expect(listPosts()).toEqual([{ id: 1, title: 'First' }])
    resetRealtimeClientRuntime()
  })

  it('throws realtime HTTP errors from the adapter transport through the Next render boundary', async () => {
    type MockWebSocketEvent = 'open' | 'message' | 'close' | 'error'
    type MockWebSocketListener = (event: { readonly data?: unknown }) => void
    class MockWebSocket {
      static last: MockWebSocket | undefined

      readonly readyState = 1
      readonly listeners = new Map<MockWebSocketEvent, MockWebSocketListener>()
      readonly sentMessages: string[] = []

      constructor(readonly url: string) {
        MockWebSocket.last = this
      }

      send(value: string): void {
        this.sentMessages.push(value)
      }

      close(): void {}

      addEventListener(event: MockWebSocketEvent, listener: MockWebSocketListener): void {
        this.listeners.set(event, listener)
      }
    }

    const originalFetch = globalThis.fetch
    const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket
    const originalLocation = (globalThis as { location?: unknown }).location

    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === '/holo/realtime/query') {
        return Response.json({
          message: 'Only the author can update posts.',
          kind: 'authorization',
          status: 403,
        }, { status: 403 })
      }

      return Response.json({
        key: 'app-key',
        host: 'localhost',
        port: 6001,
        path: '/app',
        scheme: 'http',
      })
    }) as typeof fetch
    ;(globalThis as unknown as { WebSocket?: typeof MockWebSocket }).WebSocket = MockWebSocket
    ;(globalThis as { location?: { readonly protocol: string, readonly hostname: string } }).location = {
      protocol: 'http:',
      hostname: 'localhost',
    }

    try {
      vi.doMock('react', () => createReactMock({
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

          return [value, () => {}] as const
        },
        useSyncExternalStore<TSnapshot>(
          subscribe: (listener: () => void) => () => void,
          getSnapshot: () => TSnapshot,
        ) {
          subscribe(() => {})
          return getSnapshot()
        },
      }))

      const {
        resetRealtimeClientRuntime,
      } = await import('@holo-js/realtime/client')
      const { query } = await import('@holo-js/realtime')
      const { adapterNextRealtimeInternals } = await import('../src/realtime')

      const listPosts = query({
        name: 'posts.denied',
        access: 'public',
        handler: async () => [],
      })

      const pendingSnapshot = captureSuspensePromise(() => listPosts())
      await expect(pendingSnapshot).rejects.toThrow('Only the author can update posts.')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/holo/realtime/query',
        expect.objectContaining({ method: 'POST' }),
      )
      await vi.waitFor(() => {
        expect(adapterNextRealtimeInternals.getRealtimeErrorSnapshot()).toBeDefined()
      })
      let renderedError: unknown
      try {
        listPosts()
      } catch (error) {
        renderedError = error
      }
      expect(renderedError).toMatchObject({
        message: 'Only the author can update posts.',
        digest: 'NEXT_HTTP_ERROR_FALLBACK;403',
      })
      resetRealtimeClientRuntime()
    } finally {
      globalThis.fetch = originalFetch
      ;(globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket
      ;(globalThis as { location?: unknown }).location = originalLocation
    }
  })

  it('throws realtime mutation HTTP errors through the Next render boundary', async () => {
    vi.doMock('react', () => createReactMock({
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

        return [value, () => {}] as const
      },
      useSyncExternalStore<TSnapshot>(
        subscribe: (listener: () => void) => () => void,
        getSnapshot: () => TSnapshot,
      ) {
        subscribe(() => {})
        return getSnapshot()
      },
    }))

    const {
      configureRealtimeClientTransport,
      resetRealtimeClientRuntime,
    } = await import('@holo-js/realtime/client')
    const { adapterNextRealtimeInternals, mutation, query } = await import('../src/realtime')

    const listPosts = query({
      name: 'posts.after-mutation-denied',
      access: 'public',
      handler: async () => [],
    })
    const renamePost = mutation({
      name: 'posts.rename.denied',
      access: 'public',
      handler: async () => ({ id: 1 }),
    })

    configureRealtimeClientTransport({
      async query<TResult>() {
        return {
          name: 'posts.after-mutation-denied',
          data: [] as TResult,
          dependencies: [],
          version: 1,
        }
      },
      async mutate<TResult>() {
        throw Object.assign(new Error('Only the author can update posts.'), {
          status: 403,
        }) as Error & { readonly status: 403 } & { readonly __result?: TResult }
      },
      subscribe() {
        return () => {}
      },
    })

    const pendingSnapshot = captureSuspensePromise(() => listPosts())
    await pendingSnapshot
    expect(listPosts()).toEqual([])
    await expect(renamePost()).rejects.toThrow('Only the author can update posts.')
    await vi.waitFor(() => {
      expect(adapterNextRealtimeInternals.getRealtimeErrorSnapshot()).toBeDefined()
    })
    let renderedError: unknown
    try {
      listPosts()
    } catch (error) {
      renderedError = error
    }
    expect(renderedError).toMatchObject({
      message: 'Only the author can update posts.',
      digest: 'NEXT_HTTP_ERROR_FALLBACK;403',
    })
    resetRealtimeClientRuntime()
  })

  it('recreates the form instance when schema options change across rerenders', async () => {
    const state = createReactHookState()

    vi.doMock('@holo-js/forms/internal/client', () => ({
      createFormClient: vi.fn((_schema, options: { initialValues?: { email?: string } }) => ({
        subscribe() {
          return () => {}
        },
        values: {
          email: options.initialValues?.email,
        },
      })),
      markClientSubmitControlFlowError,
    }))

    vi.doMock('react', () => createReactHookStateMock(state))

    const { useForm } = await import('../src/client')
    const login = schema({
      email: field.string().required().email(),
    })

    const firstOptions = {
      initialValues: {
        email: 'ava@example.com',
      },
    }
    const firstForm = useForm(login, firstOptions)

    state.currentHookIndex = 0

    const secondForm = useForm(login, {
      initialValues: {
        email: 'nora@example.com',
      },
    })

    expect(firstForm).not.toBe(secondForm)
    expect((secondForm as { values: { email?: string } }).values.email).toBe('nora@example.com')
  })

  it('preserves the form instance across rerenders when option values are unchanged', async () => {
    const state = createReactHookState()

    const createForm = vi.fn((_schema, options: { initialValues?: { email?: string } }) => ({
      id: Symbol(options.initialValues?.email ?? 'empty'),
      subscribe() {
        return () => {}
      },
      values: {
        email: options.initialValues?.email,
      },
    }))

    vi.doMock('@holo-js/forms/internal/client', () => ({
      createFormClient: createForm,
      markClientSubmitControlFlowError,
    }))

    vi.doMock('react', () => createReactHookStateMock(state))

    const { useForm } = await import('../src/client')
    const login = schema({
      email: field.string().required().email(),
      createdAt: field.date().required(),
      tags: field.array(field.string().required()).optional(),
    })

    const firstForm = useForm(login, {
      initialValues: {
        email: 'ava@example.com',
        createdAt: new Date('2026-04-05T00:00:00.000Z'),
        tags: ['admin'],
      },
    })

    state.currentHookIndex = 0

    const secondForm = useForm(login, {
      initialValues: {
        email: 'ava@example.com',
        createdAt: new Date('2026-04-05T00:00:00.000Z'),
        tags: ['admin'],
      },
    })

    expect(firstForm).toBe(secondForm)
    expect(createForm).toHaveBeenCalledTimes(1)
  })

  it('preserves the form instance across rerenders when submitter identity changes', async () => {
    const state = createReactHookState()

    const createForm = vi.fn(() => ({
      id: Symbol('form'),
      subscribe() {
        return () => {}
      },
    }))

    vi.doMock('@holo-js/forms/internal/client', () => ({
      createFormClient: createForm,
      markClientSubmitControlFlowError,
    }))

    vi.doMock('react', () => createReactHookStateMock(state))

    const { useForm } = await import('../src/client')
    const login = schema({
      email: field.string().required().email(),
    })

    const firstForm = useForm(login, {
      initialValues: {
        email: 'ava@example.com',
      },
      submitter: async ({ values }) => ({
        ok: true as const,
        status: 200,
        data: values,
      }),
    })

    state.currentHookIndex = 0

    const secondForm = useForm(login, {
      initialValues: {
        email: 'ava@example.com',
      },
      submitter: async ({ values }) => ({
        ok: true as const,
        status: 200,
        data: values,
      }),
    })

    expect(firstForm).toBe(secondForm)
    expect(createForm).toHaveBeenCalledTimes(1)
  })

  it('uses the latest inline submitter without recreating the form instance', async () => {
    const state = createReactHookState()

    const firstSubmitter = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: 'first',
    }))
    const secondSubmitter = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: 'second',
    }))

    const createForm = vi.fn((_schema, options: {
      submitter?: (context: { values: { email: string } }) => Promise<unknown>
    }) => ({
      subscribe() {
        return () => {}
      },
      async submit() {
        return await options.submitter?.({
          values: {
            email: 'ava@example.com',
          },
        } as { values: { email: string } })
      },
    }))

    vi.doMock('@holo-js/forms/internal/client', () => ({
      createFormClient: createForm,
      markClientSubmitControlFlowError,
    }))

    vi.doMock('react', () => createReactHookStateMock(state))

    const { useForm } = await import('../src/client')
    const login = schema({
      email: field.string().required().email(),
    })

    const firstForm = useForm(login, {
      initialValues: {
        email: 'ava@example.com',
      },
      submitter: firstSubmitter,
    })

    state.currentHookIndex = 0

    const secondForm = useForm(login, {
      initialValues: {
        email: 'ava@example.com',
      },
      submitter: secondSubmitter,
    })

    await (secondForm as { submit(): Promise<unknown> }).submit()

    expect(firstForm).toBe(secondForm)
    expect(createForm).toHaveBeenCalledTimes(1)
    expect(firstSubmitter).not.toHaveBeenCalled()
    expect(secondSubmitter).toHaveBeenCalledTimes(1)
  })

  it('throws if a stale bridged submitter runs after submitter support is removed', async () => {
    const state = createReactHookState()

    const capturedSubmitters: Array<((context: { values: { email: string } }) => Promise<unknown> | unknown) | undefined> = []

    const createForm = vi.fn((_schema, options: {
      submitter?: (context: { values: { email: string } }) => Promise<unknown> | unknown
    }) => {
      capturedSubmitters.push(options.submitter)

      return {
        subscribe() {
          return () => {}
        },
      }
    })

    vi.doMock('@holo-js/forms/internal/client', () => ({
      createFormClient: createForm,
      markClientSubmitControlFlowError,
    }))

    vi.doMock('react', () => createReactHookStateMock(state))

    const { useForm } = await import('../src/client')
    const login = schema({
      email: field.string().required().email(),
    })

    useForm(login, {
      initialValues: {
        email: 'ava@example.com',
      },
      submitter: async ({ values }) => ({
        ok: true,
        status: 200,
        data: values,
      }),
    })

    state.currentHookIndex = 0

    useForm(login, {
      initialValues: {
        email: 'ava@example.com',
      },
    })

    await expect(capturedSubmitters[0]?.({
      values: {
        email: 'ava@example.com',
      },
    } as { values: { email: string } })).rejects.toThrow('Expected submitter to be defined.')
    expect(createForm).toHaveBeenCalledTimes(2)
  })

  it('recreates the form instance when file-valued options change across rerenders', async () => {
    const state = createReactHookState()

    const createForm = vi.fn((_schema, options: { initialValues?: { avatar?: File } }) => ({
      id: Symbol(options.initialValues?.avatar?.name ?? 'empty'),
      subscribe() {
        return () => {}
      },
    }))

    vi.doMock('@holo-js/forms/internal/client', () => ({
      createFormClient: createForm,
      markClientSubmitControlFlowError,
    }))

    vi.doMock('react', () => createReactHookStateMock(state))

    const { useForm } = await import('../src/client')
    const upload = schema({
      avatar: field.file().optional(),
    })

    const firstForm = useForm(upload, {
      initialValues: {
        avatar: new File(['first'], 'avatar.png', { type: 'image/png' }),
      },
    })

    state.currentHookIndex = 0

    const secondForm = useForm(upload, {
      initialValues: {
        avatar: new File(['first'], 'avatar.png', { type: 'image/png' }),
      },
    })

    expect(firstForm).not.toBe(secondForm)
    expect(createForm).toHaveBeenCalledTimes(2)
  })
})
