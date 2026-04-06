import { afterEach, describe, expect, it, vi } from 'vitest'
import { field, schema } from '@holo-js/forms'

describe('@holo-js/adapter-next client', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.doUnmock('react')
    vi.doUnmock('@holo-js/forms/client')
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

    vi.doMock('@holo-js/forms/client', () => ({
      useForm: vi.fn(() => fakeForm),
    }))

    vi.doMock('react', () => ({
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

    vi.doMock('@holo-js/forms/client', () => ({
      useForm: vi.fn((_schema, options: { initialValues?: { email?: string } }) => ({
        subscribe() {
          return () => {}
        },
        values: {
          email: options.initialValues?.email,
        },
      })),
    }))

    vi.doMock('react', () => ({
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

    vi.doMock('@holo-js/forms/client', () => ({
      useForm: createForm,
    }))

    vi.doMock('react', () => ({
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

    vi.doMock('@holo-js/forms/client', () => ({
      useForm: createForm,
    }))

    vi.doMock('react', () => ({
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

    vi.doMock('@holo-js/forms/client', () => ({
      useForm: createForm,
    }))

    vi.doMock('react', () => ({
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

    vi.doMock('@holo-js/forms/client', () => ({
      useForm: createForm,
    }))

    vi.doMock('react', () => ({
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

    expect(() => capturedSubmitters[0]?.({
      values: {
        email: 'ava@example.com',
      },
    } as { values: { email: string } })).toThrow('Expected submitter to be defined.')
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

    vi.doMock('@holo-js/forms/client', () => ({
      useForm: createForm,
    }))

    vi.doMock('react', () => ({
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
