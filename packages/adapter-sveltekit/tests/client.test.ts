import { afterEach, describe, expect, it, vi } from 'vitest'
import { field, schema } from '@holo-js/forms'

describe('@holo-js/adapter-sveltekit client', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('wraps the shared form client with a Svelte reactive subscriber bridge', async () => {
    vi.mock('svelte/reactivity', () => ({
      createSubscriber(start: (update: () => void) => void | (() => void)) {
        let initialized = false

        return () => {
          if (!initialized) {
            void start(() => {})
            initialized = true
          }
        }
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

    expect(form.fields.email).toBe(form.fields.email)
    expect(form.fields.email.value).toBe('ava@example.com')
    form.fields.email.value = 'broken'
    await form.fields.email.onInput('ava@example.com')
    expect(form.values.email).toBe('ava@example.com')
  })

  it('exposes nested keys that are added after the wrapper is created', async () => {
    vi.mock('svelte/reactivity', () => ({
      createSubscriber(start: (update: () => void) => void | (() => void)) {
        let initialized = false

        return () => {
          if (!initialized) {
            void start(() => {})
            initialized = true
          }
        }
      },
    }))

    const { useForm } = await import('../src/client')
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
    vi.mock('svelte/reactivity', () => ({
      createSubscriber(start: (update: () => void) => void | (() => void)) {
        let initialized = false

        return () => {
          if (!initialized) {
            void start(() => {})
            initialized = true
          }
        }
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

    expect(Object.getOwnPropertyDescriptor(form, 'missing')).toBeUndefined()
  })

  it('preserves array and date values as native objects through the proxy', async () => {
    vi.mock('svelte/reactivity', () => ({
      createSubscriber(start: (update: () => void) => void | (() => void)) {
        let initialized = false

        return () => {
          if (!initialized) {
            void start(() => {})
            initialized = true
          }
        }
      },
    }))

    const { useForm } = await import('../src/client')
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
})
