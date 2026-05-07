import { afterEach, describe, expect, it, vi } from 'vitest'
import { field, schema } from '@holo-js/forms'

describe('@holo-js/adapter-nuxt client', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.doUnmock('#imports')
  })

  it('wraps the shared form client in a Vue-friendly reactive proxy', async () => {
    ;(globalThis as unknown as {
      __holoNuxtClientDisposed?: boolean
      __holoNuxtDisposeCallback?: () => void
    }).__holoNuxtClientDisposed = false

    vi.doMock('vue', () => ({
      onScopeDispose(callback: () => void) {
        ;(globalThis as unknown as {
          __holoNuxtDisposeCallback?: () => void
        }).__holoNuxtDisposeCallback = () => {
          callback()
          ;(globalThis as unknown as { __holoNuxtClientDisposed?: boolean }).__holoNuxtClientDisposed = true
        }
      },
      reactive<TValue extends object>(value: TValue) {
        return value
      },
      shallowRef<TValue>(value: TValue) {
        return { value }
      },
      watchEffect(effect: (onCleanup: (cleanup: () => void) => void) => void) {
        let cleanup: (() => void) | undefined
        effect((nextCleanup) => {
          cleanup = nextCleanup
        })
        return () => cleanup?.()
      },
    }))

    const { useForm } = await import('../src/runtime/composables/forms')
    const login = schema({
      email: field.string().required().email(),
    })

    const form = useForm(login, {
      initialValues: {
        email: 'ava@example.com',
      },
    })

    expect(form.fields.email).toBe(form.fields.email)
    form.fields.email.value = 'broken'
    await form.fields.email.onInput('ava@example.com')
    ;(globalThis as unknown as {
      __holoNuxtDisposeCallback?: () => void
    }).__holoNuxtDisposeCallback?.()

    expect(form.values.email).toBe('ava@example.com')
    expect((globalThis as unknown as { __holoNuxtClientDisposed?: boolean }).__holoNuxtClientDisposed).toBe(true)
  })

  it('exposes nested keys that are added after the wrapper is created', async () => {
    vi.doMock('vue', () => ({
      onScopeDispose() {},
      reactive<TValue extends object>(value: TValue) {
        return value
      },
      shallowRef<TValue>(value: TValue) {
        return { value }
      },
      watchEffect(effect: (onCleanup: (cleanup: () => void) => void) => void) {
        let cleanup: (() => void) | undefined
        effect((nextCleanup) => {
          cleanup = nextCleanup
        })
        return () => cleanup?.()
      },
    }))

    const { useForm } = await import('../src/runtime/composables/forms')
    const login = schema({
      profile: {
        city: field.string().required(),
      },
    })

    const form = useForm(login, {
      initialValues: {
        profile: {
          city: 'Cairo',
        },
      },
    })

    void form.values.profile
    await form.setValue('profile.country.code', 'EG')

    expect((form.values.profile as Record<string, unknown>).country).toEqual({
      code: 'EG',
    })
  })

  it('returns undefined descriptors for missing proxy keys', async () => {
    vi.doMock('vue', () => ({
      onScopeDispose() {},
      reactive<TValue extends object>(value: TValue) {
        return value
      },
      shallowRef<TValue>(value: TValue) {
        return { value }
      },
      watchEffect(effect: (onCleanup: (cleanup: () => void) => void) => void) {
        let cleanup: (() => void) | undefined
        effect((nextCleanup) => {
          cleanup = nextCleanup
        })
        return () => cleanup?.()
      },
    }))

    const { useForm } = await import('../src/runtime/composables/forms')
    const login = schema({
      email: field.string().required().email(),
    })

    const form = useForm(login, {
      initialValues: {
        email: 'ava@example.com',
      },
    })

    expect(Object.getOwnPropertyDescriptor(form, 'missing')).toBeUndefined()
  })

  it('preserves date values and exposes array contents through the proxy', async () => {
    vi.doMock('vue', () => ({
      onScopeDispose() {},
      reactive<TValue extends object>(value: TValue) {
        return value
      },
      shallowRef<TValue>(value: TValue) {
        return { value }
      },
      watchEffect(effect: (onCleanup: (cleanup: () => void) => void) => void) {
        let cleanup: (() => void) | undefined
        effect((nextCleanup) => {
          cleanup = nextCleanup
        })
        return () => cleanup?.()
      },
    }))

    const { useForm } = await import('../src/runtime/composables/forms')
    const publishPost = schema({
      publishedAt: field.date().required(),
      tags: field.array(field.string().required()).optional(),
    })

    const publishedAt = new Date('2026-04-05T00:00:00.000Z')
    const form = useForm(publishPost, {
      initialValues: {
        publishedAt,
        tags: ['news'],
      },
    })

    expect(form.values.publishedAt).toBeInstanceOf(Date)
    expect(form.values.publishedAt.getTime()).toBe(publishedAt.getTime())
    const tags = form.values.tags
    expect(Array.isArray(tags)).toBe(true)
    expect(tags).toBeDefined()
    if (!tags) {
      throw new Error('Expected tags to be defined')
    }

    expect(Array.from(tags)).toEqual(['news'])
  })

  it('recreates the wrapped form when watched inputs change', async () => {
    let rerunEffect = () => {}

    vi.doMock('vue', () => ({
      onScopeDispose() {},
      reactive<TValue extends object>(value: TValue) {
        return value
      },
      shallowRef<TValue>(value: TValue) {
        return { value }
      },
      watchEffect(effect: (onCleanup: (cleanup: () => void) => void) => void) {
        let cleanup: (() => void) | undefined
        const run = () => {
          cleanup?.()
          cleanup = undefined
          effect((nextCleanup) => {
            cleanup = nextCleanup
          })
        }

        run()
        rerunEffect = run
        return () => cleanup?.()
      },
    }))

    const { useForm } = await import('../src/runtime/composables/forms')
    const login = schema({
      email: field.string().required().email(),
    })

    let initialValues = {
      email: 'ava@example.com',
    }
    const form = useForm(login, {
      get initialValues() {
        return initialValues
      },
    })

    expect(form.values.email).toBe('ava@example.com')

    initialValues = {
      email: 'nora@example.com',
    }
    rerunEffect()

    expect(form.values.email).toBe('nora@example.com')
  })

  it('returns Vue-reactive form state for v-model bindings', async () => {
    const reactiveCalls: unknown[] = []

    vi.doMock('vue', () => ({
      onScopeDispose() {},
      reactive<TValue extends object>(value: TValue) {
        reactiveCalls.push(value)
        return value
      },
      shallowRef<TValue>(value: TValue) {
        return { value }
      },
      watchEffect(effect: (onCleanup: (cleanup: () => void) => void) => void) {
        let cleanup: (() => void) | undefined
        effect((nextCleanup) => {
          cleanup = nextCleanup
        })
        return () => cleanup?.()
      },
    }))

    const { useForm } = await import('../src/runtime/composables/forms')
    const login = schema({
      email: field.string().required().email(),
    })

    const form = useForm(login, {
      initialValues: {
        email: '',
      },
    })

    expect(reactiveCalls.length).toBeGreaterThan(0)

    form.values.email = 'ava@example.com'

    expect(form.fields.email.value).toBe('ava@example.com')
  })

  it('routes array mutations through setValue so touched, dirty, and validation update', async () => {
    vi.doMock('vue', () => ({
      onScopeDispose() {},
      reactive<TValue extends object>(value: TValue) {
        return value
      },
      shallowRef<TValue>(value: TValue) {
        return { value }
      },
      watchEffect(effect: (onCleanup: (cleanup: () => void) => void) => void) {
        let cleanup: (() => void) | undefined
        effect((nextCleanup) => {
          cleanup = nextCleanup
        })
        return () => cleanup?.()
      },
    }))

    const { useForm } = await import('../src/runtime/composables/forms')
    const publishPost = schema({
      tags: field.array(field.string().required()).required().min(1),
    })

    const form = useForm(publishPost, {
      initialValues: {
        tags: [],
      },
      validateOn: 'change',
    })

    await form.validate()
    expect(form.errors.first('tags')).toBeDefined()
    expect(form.fields.tags.touched).toBe(false)
    expect(form.fields.tags.dirty).toBe(false)

    form.values.tags.push('news')
    await Promise.resolve()
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(Array.from(form.values.tags)).toEqual(['news'])
    expect(form.fields.tags.touched).toBe(true)
    expect(form.fields.tags.dirty).toBe(true)
    expect(form.errors.first('tags')).toBeUndefined()
  })
})
