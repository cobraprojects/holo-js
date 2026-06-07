import { afterEach, describe, expect, it, vi } from 'vitest'
import { field, schema } from '@holo-js/forms'
import type { RealtimeSubscriptionSnapshot } from '@holo-js/realtime'
import type { ClientSubmitContext, UseFormOptions } from '@holo-js/forms/internal/client'

type MockReactContext<TValue> = {
  currentRenderValue: TValue
  readonly Provider: (props: { readonly value: TValue, readonly children?: unknown }) => unknown
}

function createReactMock(overrides: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
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
    useContext<TValue>(context: MockReactContext<TValue>): TValue {
      return context.currentRenderValue
    },
    ...overrides,
  }
}

describe('@holo-js/adapter-next client', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.doUnmock('react')
    vi.doUnmock('@holo-js/forms/internal/client')
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
    type ReactState = {
      currentHookIndex: number
      hookValues: unknown[]
    }

    ;(globalThis as unknown as { __holoNextHttpFormState?: ReactState }).__holoNextHttpFormState = {
      currentHookIndex: 0,
      hookValues: [],
    }

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
    }))

    vi.doMock('react', () => createReactMock({
      useEffect(effect: () => void | (() => void)) {
        return effect()
      },
      useRef<TValue>(initialValue?: TValue) {
        const state = (globalThis as unknown as {
          __holoNextHttpFormState: ReactState
        }).__holoNextHttpFormState
        const index = state.currentHookIndex++

        if (!(index in state.hookValues)) {
          state.hookValues[index] = { current: initialValue }
        }

        return state.hookValues[index] as { current: TValue | undefined }
      },
      useState<TValue>(initialState: TValue | (() => TValue)) {
        const state = (globalThis as unknown as {
          __holoNextHttpFormState: ReactState
        }).__holoNextHttpFormState
        const index = state.currentHookIndex++

        if (!(index in state.hookValues)) {
          state.hookValues[index] = typeof initialState === 'function'
            ? (initialState as () => TValue)()
            : initialState
        }

        return [state.hookValues[index] as TValue, (next: TValue | ((previous: TValue) => TValue)) => {
          state.hookValues[index] = typeof next === 'function'
            ? (next as (previous: TValue) => TValue)(state.hookValues[index] as TValue)
            : next
        }] as const
      },
    }))

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

    const state = (globalThis as unknown as {
      __holoNextHttpFormState: ReactState
    }).__holoNextHttpFormState
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

  it('returns undefined before the first realtime query snapshot arrives', async () => {
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

    expect(listPosts()).toBeUndefined()
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

    let realtimeErrorSnapshot: Error | undefined
    const originalFetch = globalThis.fetch
    const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket
    const originalLocation = (globalThis as { location?: unknown }).location

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      key: 'app-key',
      host: 'localhost',
      port: 6001,
      path: '/app',
      scheme: 'http',
    }))) as typeof fetch
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
          const snapshot = getSnapshot()
          if (snapshot instanceof Error) {
            realtimeErrorSnapshot = snapshot
          }
          return snapshot
        },
      }))

      const {
        resetRealtimeClientRuntime,
      } = await import('@holo-js/realtime/client')
      const { query } = await import('@holo-js/realtime')
      await import('../src/realtime')

      const listPosts = query({
        name: 'posts.denied',
        access: 'public',
        handler: async () => [],
      })

      expect(listPosts()).toBeUndefined()
      await Promise.resolve()
      await Promise.resolve()
      MockWebSocket.last?.listeners.get('open')?.({})
      for (let attempt = 0; attempt < 10 && (MockWebSocket.last?.sentMessages.length ?? 0) === 0; attempt += 1) {
        await Promise.resolve()
      }
      for (const id of ['realtime.1', 'realtime.2']) {
        MockWebSocket.last?.listeners.get('message')?.({
          data: JSON.stringify({
            event: 'holo:realtime:error',
            data: {
              id,
              message: 'Only the author can update posts.',
              status: 403,
            },
          }),
        })
      }

      expect(() => listPosts()).toThrow('Only the author can update posts.')
      expect(realtimeErrorSnapshot).toMatchObject({
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
    let realtimeErrorSnapshot: Error | undefined

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
        const snapshot = getSnapshot()
        if (snapshot instanceof Error) {
          realtimeErrorSnapshot = snapshot
        }
        return snapshot
      },
    }))

    const {
      configureRealtimeClientTransport,
      resetRealtimeClientRuntime,
    } = await import('@holo-js/realtime/client')
    const { mutation, query } = await import('../src/realtime')

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

    expect(listPosts()).toBeUndefined()
    await expect(renamePost()).rejects.toThrow('Only the author can update posts.')
    expect(() => listPosts()).toThrow('Only the author can update posts.')
    expect(realtimeErrorSnapshot).toMatchObject({
      digest: 'NEXT_HTTP_ERROR_FALLBACK;403',
    })
    resetRealtimeClientRuntime()
  })

  it('recreates the form instance when schema options change across rerenders', async () => {
    type ReactState = {
      rerenders: number[]
      currentHookIndex: number
      hookValues: unknown[]
    }

    ;(globalThis as unknown as { __holoNextClientTestState?: ReactState }).__holoNextClientTestState = {
      rerenders: [],
      currentHookIndex: 0,
      hookValues: [],
    }

    vi.doMock('@holo-js/forms/internal/client', () => ({
      createFormClient: vi.fn((_schema, options: { initialValues?: { email?: string } }) => ({
        subscribe() {
          return () => {}
        },
        values: {
          email: options.initialValues?.email,
        },
      })),
    }))

    vi.doMock('react', () => createReactMock({
      useCallback<TCallback extends (...args: never[]) => unknown>(callback: TCallback) {
        return callback
      },
      useEffect(effect: () => void | (() => void)) {
        return effect()
      },
      useRef<TValue>(initialValue?: TValue) {
        const state = (globalThis as unknown as {
          __holoNextClientTestState: ReactState
        }).__holoNextClientTestState
        const index = state.currentHookIndex++

        if (!(index in state.hookValues)) {
          state.hookValues[index] = { current: initialValue }
        }

        return state.hookValues[index] as { current: TValue | undefined }
      },
      useState<TValue>(initialState: TValue | (() => TValue)) {
        const state = (globalThis as unknown as {
          __holoNextClientTestState: ReactState
        }).__holoNextClientTestState
        const index = state.currentHookIndex++

        if (!(index in state.hookValues)) {
          state.hookValues[index] = typeof initialState === 'function'
            ? (initialState as () => TValue)()
            : initialState
        }

        return [state.hookValues[index] as TValue, (next: TValue | ((previous: TValue) => TValue)) => {
          const previous = state.hookValues[index] as TValue
          state.hookValues[index] = typeof next === 'function'
            ? (next as (previous: TValue) => TValue)(previous)
            : next
          if (index === 0 && typeof state.hookValues[index] === 'number') {
            state.rerenders.push(state.hookValues[index] as number)
          }
        }] as const
      },
    }))

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

    const state = (globalThis as unknown as {
      __holoNextClientTestState: ReactState
    }).__holoNextClientTestState
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
    type ReactState = {
      currentHookIndex: number
      hookValues: unknown[]
    }

    ;(globalThis as unknown as { __holoNextClientStableOptionsState?: ReactState }).__holoNextClientStableOptionsState = {
      currentHookIndex: 0,
      hookValues: [],
    }

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
    }))

    vi.doMock('react', () => createReactMock({
      useCallback<TCallback extends (...args: never[]) => unknown>(callback: TCallback) {
        return callback
      },
      useEffect(effect: () => void | (() => void)) {
        return effect()
      },
      useRef<TValue>(initialValue?: TValue) {
        const state = (globalThis as unknown as {
          __holoNextClientStableOptionsState: ReactState
        }).__holoNextClientStableOptionsState
        const index = state.currentHookIndex++

        if (!(index in state.hookValues)) {
          state.hookValues[index] = { current: initialValue }
        }

        return state.hookValues[index] as { current: TValue | undefined }
      },
      useState<TValue>(initialState: TValue | (() => TValue)) {
        const state = (globalThis as unknown as {
          __holoNextClientStableOptionsState: ReactState
        }).__holoNextClientStableOptionsState
        const index = state.currentHookIndex++

        if (!(index in state.hookValues)) {
          state.hookValues[index] = typeof initialState === 'function'
            ? (initialState as () => TValue)()
            : initialState
        }

        return [state.hookValues[index] as TValue, vi.fn()] as const
      },
    }))

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

    const state = (globalThis as unknown as {
      __holoNextClientStableOptionsState: ReactState
    }).__holoNextClientStableOptionsState
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
    type ReactState = {
      currentHookIndex: number
      hookValues: unknown[]
    }

    ;(globalThis as unknown as { __holoNextClientSubmitterState?: ReactState }).__holoNextClientSubmitterState = {
      currentHookIndex: 0,
      hookValues: [],
    }

    const createForm = vi.fn(() => ({
      id: Symbol('form'),
      subscribe() {
        return () => {}
      },
    }))

    vi.doMock('@holo-js/forms/internal/client', () => ({
      createFormClient: createForm,
    }))

    vi.doMock('react', () => createReactMock({
      useCallback<TCallback extends (...args: never[]) => unknown>(callback: TCallback) {
        return callback
      },
      useEffect(effect: () => void | (() => void)) {
        return effect()
      },
      useRef<TValue>(initialValue?: TValue) {
        const state = (globalThis as unknown as {
          __holoNextClientSubmitterState: ReactState
        }).__holoNextClientSubmitterState
        const index = state.currentHookIndex++

        if (!(index in state.hookValues)) {
          state.hookValues[index] = { current: initialValue }
        }

        return state.hookValues[index] as { current: TValue | undefined }
      },
      useState<TValue>(initialState: TValue | (() => TValue)) {
        const state = (globalThis as unknown as {
          __holoNextClientSubmitterState: ReactState
        }).__holoNextClientSubmitterState
        const index = state.currentHookIndex++

        if (!(index in state.hookValues)) {
          state.hookValues[index] = typeof initialState === 'function'
            ? (initialState as () => TValue)()
            : initialState
        }

        return [state.hookValues[index] as TValue, vi.fn()] as const
      },
    }))

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

    const state = (globalThis as unknown as {
      __holoNextClientSubmitterState: ReactState
    }).__holoNextClientSubmitterState
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
    type ReactState = {
      currentHookIndex: number
      hookValues: unknown[]
    }

    ;(globalThis as unknown as { __holoNextClientSubmitterBridgeState?: ReactState }).__holoNextClientSubmitterBridgeState = {
      currentHookIndex: 0,
      hookValues: [],
    }

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
    }))

    vi.doMock('react', () => createReactMock({
      useCallback<TCallback extends (...args: never[]) => unknown>(callback: TCallback) {
        return callback
      },
      useEffect(effect: () => void | (() => void)) {
        return effect()
      },
      useRef<TValue>(initialValue?: TValue) {
        const state = (globalThis as unknown as {
          __holoNextClientSubmitterBridgeState: ReactState
        }).__holoNextClientSubmitterBridgeState
        const index = state.currentHookIndex++

        if (!(index in state.hookValues)) {
          state.hookValues[index] = { current: initialValue }
        }

        return state.hookValues[index] as { current: TValue | undefined }
      },
      useState<TValue>(initialState: TValue | (() => TValue)) {
        const state = (globalThis as unknown as {
          __holoNextClientSubmitterBridgeState: ReactState
        }).__holoNextClientSubmitterBridgeState
        const index = state.currentHookIndex++

        if (!(index in state.hookValues)) {
          state.hookValues[index] = typeof initialState === 'function'
            ? (initialState as () => TValue)()
            : initialState
        }

        return [state.hookValues[index] as TValue, vi.fn()] as const
      },
    }))

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

    const state = (globalThis as unknown as {
      __holoNextClientSubmitterBridgeState: ReactState
    }).__holoNextClientSubmitterBridgeState
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
    type ReactState = {
      currentHookIndex: number
      hookValues: unknown[]
    }

    ;(globalThis as unknown as { __holoNextClientSubmitterRemovalState?: ReactState }).__holoNextClientSubmitterRemovalState = {
      currentHookIndex: 0,
      hookValues: [],
    }

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
    }))

    vi.doMock('react', () => createReactMock({
      useCallback<TCallback extends (...args: never[]) => unknown>(callback: TCallback) {
        return callback
      },
      useEffect(effect: () => void | (() => void)) {
        return effect()
      },
      useRef<TValue>(initialValue?: TValue) {
        const state = (globalThis as unknown as {
          __holoNextClientSubmitterRemovalState: ReactState
        }).__holoNextClientSubmitterRemovalState
        const index = state.currentHookIndex++

        if (!(index in state.hookValues)) {
          state.hookValues[index] = { current: initialValue }
        }

        return state.hookValues[index] as { current: TValue | undefined }
      },
      useState<TValue>(initialState: TValue | (() => TValue)) {
        const state = (globalThis as unknown as {
          __holoNextClientSubmitterRemovalState: ReactState
        }).__holoNextClientSubmitterRemovalState
        const index = state.currentHookIndex++

        if (!(index in state.hookValues)) {
          state.hookValues[index] = typeof initialState === 'function'
            ? (initialState as () => TValue)()
            : initialState
        }

        return [state.hookValues[index] as TValue, vi.fn()] as const
      },
    }))

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

    const state = (globalThis as unknown as {
      __holoNextClientSubmitterRemovalState: ReactState
    }).__holoNextClientSubmitterRemovalState
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
    type ReactState = {
      currentHookIndex: number
      hookValues: unknown[]
    }

    ;(globalThis as unknown as { __holoNextClientFileOptionsState?: ReactState }).__holoNextClientFileOptionsState = {
      currentHookIndex: 0,
      hookValues: [],
    }

    const createForm = vi.fn((_schema, options: { initialValues?: { avatar?: File } }) => ({
      id: Symbol(options.initialValues?.avatar?.name ?? 'empty'),
      subscribe() {
        return () => {}
      },
    }))

    vi.doMock('@holo-js/forms/internal/client', () => ({
      createFormClient: createForm,
    }))

    vi.doMock('react', () => createReactMock({
      useCallback<TCallback extends (...args: never[]) => unknown>(callback: TCallback) {
        return callback
      },
      useEffect(effect: () => void | (() => void)) {
        return effect()
      },
      useRef<TValue>(initialValue?: TValue) {
        const state = (globalThis as unknown as {
          __holoNextClientFileOptionsState: ReactState
        }).__holoNextClientFileOptionsState
        const index = state.currentHookIndex++

        if (!(index in state.hookValues)) {
          state.hookValues[index] = { current: initialValue }
        }

        return state.hookValues[index] as { current: TValue | undefined }
      },
      useState<TValue>(initialState: TValue | (() => TValue)) {
        const state = (globalThis as unknown as {
          __holoNextClientFileOptionsState: ReactState
        }).__holoNextClientFileOptionsState
        const index = state.currentHookIndex++

        if (!(index in state.hookValues)) {
          state.hookValues[index] = typeof initialState === 'function'
            ? (initialState as () => TValue)()
            : initialState
        }

        return [state.hookValues[index] as TValue, vi.fn()] as const
      },
    }))

    const { useForm } = await import('../src/client')
    const upload = schema({
      avatar: field.file().optional(),
    })

    const firstForm = useForm(upload, {
      initialValues: {
        avatar: new File(['first'], 'avatar.png', { type: 'image/png' }),
      },
    })

    const state = (globalThis as unknown as {
      __holoNextClientFileOptionsState: ReactState
    }).__holoNextClientFileOptionsState
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
