import { afterEach, describe, expect, it, vi } from 'vitest'
import { field, schema } from '@holo-js/forms'

vi.mock('svelte/reactivity', () => ({
  createSubscriber(start: (update: () => void) => void | (() => void)) {
    let initialized = false

    return () => {
      if (!initialized) {
        const cleanup = start(() => {})
        cleanup?.()
        initialized = true
      }
    }
  },
}))

describe('@holo-js/adapter-sveltekit client', () => {
  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.doUnmock('@holo-js/auth/client')
  })

  it('exposes current user state through the auth client helper', async () => {
    const refreshedUser = {
      id: 2,
      email: 'nora@example.com',
      name: 'Nora',
    }

    vi.doMock('@holo-js/auth/client', () => ({
      refreshUser: vi.fn(async () => refreshedUser),
    }))

    const { useAuth } = await import('../src/client')
    const auth = useAuth({
      initialUser: {
        id: 1,
        email: 'ava@example.com',
        name: 'Ava',
      },
    })

    expect(auth.authenticated).toBe(true)
    expect(auth.user?.email).toBe('ava@example.com')
    await expect(auth.refreshUser()).resolves.toEqual(refreshedUser)
    expect(auth.user).toEqual(refreshedUser)
  })

  it('allows refresh before Svelte subscribes to auth state', async () => {
    vi.doMock('@holo-js/auth/client', () => ({
      refreshUser: vi.fn(async () => null),
    }))

    const { useAuth } = await import('../src/client')
    const auth = useAuth({
      initialUser: {
        id: 1,
        email: 'ava@example.com',
        name: 'Ava',
      },
    })

    await expect(auth.refreshUser()).resolves.toBeNull()
    expect(auth.user).toBeNull()
  })

  it('wraps the shared form client with a Svelte reactive subscriber bridge', async () => {
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
