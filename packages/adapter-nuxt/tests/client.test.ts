import { afterEach, describe, expect, it, vi } from 'vitest'
import { field, schema } from '@holo-js/forms'

describe('@holo-js/adapter-nuxt client', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
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

  it('preserves array and date values as native objects through the proxy', async () => {
    vi.doMock('vue', () => ({
      onScopeDispose() {},
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
    expect(Array.isArray(form.values.tags)).toBe(true)
    expect(form.values.tags).toEqual(['news'])
  })

  it('recreates the wrapped form when watched inputs change', async () => {
    let rerunEffect = () => {}

    vi.doMock('vue', () => ({
      onScopeDispose() {},
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
})
