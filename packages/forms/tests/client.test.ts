import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFailedSubmission, createSuccessfulSubmission, field, schema } from '../src'
import { useForm } from '../src/client'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function createDeferred<TValue>() {
  let resolvePromise: (value: TValue) => void = () => {}
  const promise = new Promise<TValue>((resolve) => {
    resolvePromise = resolve
  })

  return {
    promise,
    resolve(value: TValue) {
      resolvePromise(value)
    },
  }
}

describe('@holo-js/forms client', () => {
  it('creates a typed field tree with initial values and no initial errors', () => {
    const registerUser = schema({
      email: field.string().required().email(),
      profile: {
        city: field.string().required(),
      },
      tags: field.array(field.string().required()).optional(),
    })

    const client = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
        profile: {
          city: 'Cairo',
        },
        tags: ['admin'],
      },
    })

    expect(client.values.email).toBe('ava@example.com')
    expect(client.fields.email.value).toBe('ava@example.com')
    expect(client.fields.email.errors).toEqual([])
    expect(client.fields.profile.city.value).toBe('Cairo')
    expect(client.fields.tags.value).toEqual(['admin'])
    expect(client.valid).toBe(true)
    expect(client.errors.flatten()).toEqual({})
  })

  it('builds field accessors from the schema when initial values are omitted', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
      profile: {
        city: field.string().required(),
      },
    })

    const client = useForm(registerUser)

    expect(client.fields.email.errors).toEqual([])
    expect(client.fields.profile.city.errors).toEqual([])

    await client.fields.email.onInput('broken')
    await client.fields.profile.city.onInput('')

    expect(client.values.email).toBe('broken')
    expect(client.values.profile.city).toBe('')
    expect((await client.validate()).valid).toBe(false)
    expect(client.errors.first('email')).toBeDefined()
    expect(client.errors.first('profile.city')).toBe('This field is required.')
  })

  it('validates on change and blur through field methods', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
      profile: {
        city: field.string().required(),
      },
    })

    const changeClient = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
        profile: {
          city: 'Cairo',
        },
      },
      validateOn: 'change',
    })

    await changeClient.fields.email.onInput('bad')
    expect(changeClient.errors.first('email')).toBeDefined()
    expect(changeClient.fields.email.dirty).toBe(true)

    await changeClient.fields.email.set('ava@example.com')
    expect(changeClient.fields.email.dirty).toBe(false)
    expect(changeClient.fields.email.errors).toEqual([])

    const blurClient = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
        profile: {
          city: 'Cairo',
        },
      },
      validateOn: 'blur',
    })

    await blurClient.fields.profile.city.set('')
    await blurClient.fields.profile.city.onBlur()
    expect(blurClient.fields.profile.city.touched).toBe(true)
    expect(blurClient.errors.first('profile.city')).toBe('This field is required.')

    const emailErrors = await blurClient.fields.email.validate()
    expect(emailErrors).toEqual([])
  })

  it('validates, resets, and preserves local failure state on submit', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
      age: field.number().integer().optional(),
      profile: {
        city: field.string().required(),
      },
    })

    const client = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
        age: 18,
        profile: {
          city: 'Cairo',
        },
      },
    })

    await client.setValue('email', 'bad')
    await client.setValue('profile.city', '')

    const validated = await client.validate()
    expect(validated.valid).toBe(false)
    expect(client.lastSubmission).toEqual(validated.serialize())

    const fieldErrors = await client.validateField('email')
    expect(fieldErrors.length).toBeGreaterThan(0)

    const failure = await client.submit()
    expect('valid' in failure && failure.valid === false).toBe(true)
    expect(client.lastSubmission).toEqual(
      'serialize' in failure ? failure.serialize() : client.lastSubmission,
    )

    client.reset({
      email: 'reset@example.com',
    })

    expect(client.values.email).toBe('reset@example.com')
    expect(client.errors.flatten()).toEqual({})
    expect(client.lastSubmission).toBeUndefined()
  })

  it('uses reset values as the new dirty-state baseline', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
    })

    const client = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
      },
    })

    client.reset({
      email: 'reset@example.com',
    })

    await client.setValue('email', 'next@example.com')
    expect(client.fields.email.dirty).toBe(true)

    await client.setValue('email', 'reset@example.com')

    expect(client.fields.email.dirty).toBe(false)
  })

  it('treats structurally equal array and date values as clean', async () => {
    const registerUser = schema({
      publishedAt: field.date().required(),
      tags: field.array(field.string().required()).optional(),
    })

    const client = useForm(registerUser, {
      initialValues: {
        publishedAt: new Date('2026-04-05T00:00:00.000Z'),
        tags: ['admin'],
      },
    })

    await client.fields.tags.set(['admin'])
    expect(client.fields.tags.dirty).toBe(false)

    await client.setValue('publishedAt', new Date('2026-04-05T00:00:00.000Z'))
    expect(client.fields.publishedAt.dirty).toBe(false)

    await client.fields.tags.set(['editor'])
    expect(client.fields.tags.dirty).toBe(true)

    await client.setValue('publishedAt', new Date('2026-04-06T00:00:00.000Z'))
    expect(client.fields.publishedAt.dirty).toBe(true)
  })

  it('applies server failure and success payloads back into client state', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
      profile: {
        city: field.string().required(),
      },
    })

    const client = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
        profile: {
          city: 'Cairo',
        },
      },
    })

    const payloadFailure = client.applyServerState({
      ok: false,
      status: 422,
      valid: false,
      values: {
        email: 'bad',
        profile: {
          city: '',
        },
      },
      errors: {
        email: ['Email must be valid.'],
        'profile.city': ['City is required.'],
      },
    })

    expect('valid' in payloadFailure && payloadFailure.valid === false).toBe(true)
    expect(client.values.email).toBe('bad')
    expect(client.errors.first('profile.city')).toBe('City is required.')

    const directSubmission = createFailedSubmission(registerUser, {
      email: 'typed-bad',
      profile: {
        city: '',
      },
    }, {
      email: ['Typed invalid email.'],
    })
    const directResult = client.applyServerState(directSubmission)

    expect('valid' in directResult && directResult.valid === false).toBe(true)
    expect(client.values.email).toBe('typed-bad')
    expect(client.errors.first('email')).toBe('Typed invalid email.')

    const serializedFailure = createFailedSubmission(registerUser, {
      email: 'again-bad',
    }, {
      email: ['Another invalid email.'],
    }).serialize()

    const serializedResult = client.applyServerState(serializedFailure)
    expect('valid' in serializedResult && serializedResult.valid === false).toBe(true)
    expect(client.values.email).toBe('again-bad')
    expect(client.errors.first('email')).toBe('Another invalid email.')

    const serializedSuccess = createSuccessfulSubmission(registerUser, {
      email: 'ok@example.com',
      profile: {
        city: 'Alexandria',
      },
    }).serialize()
    const successfulSerializedResult = client.applyServerState(serializedSuccess)

    expect('valid' in successfulSerializedResult && successfulSerializedResult.valid === true).toBe(true)
    if ('valid' in successfulSerializedResult && successfulSerializedResult.valid) {
      expect(successfulSerializedResult.data.email).toBe('ok@example.com')
    }

    const success = client.applyServerState({
      ok: true,
      status: 200,
      data: {
        message: 'Account created.',
      },
    })

    expect('ok' in success && success.ok === true).toBe(true)
    expect(client.errors.flatten()).toEqual({})

    const fallback = client.applyServerState({
      ok: false,
      status: 500,
      data: {
        ignored: true,
      },
    } as never)

    expect('valid' in fallback && fallback.valid === true).toBe(true)
  })

  it('submits through custom submitters and default transports', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
      publishedAt: field.date().required(),
      avatar: field.file().optional(),
      profile: {
        city: field.string().required(),
      },
      tags: field.array(field.string().required()).optional(),
    })

    const customSubmitter = vi.fn(async ({ formData }: { formData: FormData }) => {
      expect(formData.get('email')).toBe('ava@example.com')
      expect(typeof formData.get('publishedAt')).toBe('string')
      expect(formData.get('profile.city')).toBe('Cairo')
      expect(formData.getAll('tags[]')).toEqual(['admin', 'editor'])

      return {
        ok: true as const,
        status: 201,
        data: {
          saved: true,
        },
      }
    })

    const image = new File([new Uint8Array(12)], 'avatar.png', { type: 'image/png' })
    const customClient = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
        publishedAt: new Date('2026-04-04T10:00:00.000Z'),
        avatar: undefined,
        profile: {
          city: 'Cairo',
        },
        tags: ['admin', 'editor'],
      },
      submitter: customSubmitter,
    })

    const customResult = await customClient.submit()
    expect('ok' in customResult && customResult.ok === true).toBe(true)
    expect(customSubmitter).toHaveBeenCalledTimes(1)

    await customClient.setValue('avatar', image)
    expect(customClient.fields.avatar.value).toBe(image)
    await customClient.submit()
    expect(customSubmitter).toHaveBeenCalledTimes(2)

    const localClient = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
        publishedAt: new Date('2026-04-04T10:00:00.000Z'),
        profile: {
          city: 'Cairo',
        },
      },
    })
    const localResult = await localClient.submit()
    expect('ok' in localResult && localResult.ok === true).toBe(true)

    globalThis.fetch = vi.fn(async () => ({
      headers: new Headers({
        'content-type': 'application/json',
      }),
      async json() {
        return {
          ok: false,
          status: 422,
          valid: false,
          values: {
            email: 'server-bad',
            publishedAt: '2026-04-04T10:00:00.000Z',
          },
          errors: {
            email: ['Server says no.'],
          },
        }
      },
    } as Response))

    const fetchClient = useForm(registerUser, {
      action: '/register',
      initialValues: {
        email: 'ava@example.com',
        publishedAt: new Date('2026-04-04T10:00:00.000Z'),
        profile: {
          city: 'Cairo',
        },
      },
    })
    const fetchResult = await fetchClient.submit()

    expect('valid' in fetchResult && fetchResult.valid === false).toBe(true)
    expect(fetchClient.errors.first('email')).toBe('Server says no.')

    globalThis.fetch = vi.fn(async () => ({
      status: 204,
      async json() {
        throw new Error('204 responses should not be parsed as JSON.')
      },
    } as Response))

    const noContentClient = useForm(registerUser, {
      action: '/register',
      initialValues: {
        email: 'ava@example.com',
        publishedAt: new Date('2026-04-04T10:00:00.000Z'),
        profile: {
          city: 'Cairo',
        },
      },
    })
    const noContentResult = await noContentClient.submit()
    expect('ok' in noContentResult && noContentResult.ok === true).toBe(true)
    if ('ok' in noContentResult && noContentResult.ok) {
      expect(noContentResult.status).toBe(204)
      expect(noContentResult.data).toBeUndefined()
    }

    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 422,
      async json() {
        return {
          ok: false,
          status: 422,
          valid: false,
          values: {
            email: 'missing-header-bad',
            publishedAt: '2026-04-04T10:00:00.000Z',
          },
          errors: {
            email: ['Missing header failure.'],
          },
        }
      },
    } as Response))

    const headerlessFailureClient = useForm(registerUser, {
      action: '/register',
      initialValues: {
        email: 'ava@example.com',
        publishedAt: new Date('2026-04-04T10:00:00.000Z'),
        profile: {
          city: 'Cairo',
        },
      },
    })
    const headerlessFailure = await headerlessFailureClient.submit()
    expect('valid' in headerlessFailure && headerlessFailure.valid === false).toBe(true)
    expect(headerlessFailureClient.errors.first('email')).toBe('Missing header failure.')

    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      headers: new Headers({
        'content-type': 'text/html; charset=utf-8',
      }),
      async json() {
        throw new Error('Non-JSON error responses should not be parsed as JSON.')
      },
    } as Response))

    const nonJsonFailureClient = useForm(registerUser, {
      action: '/register',
      initialValues: {
        email: 'ava@example.com',
        publishedAt: new Date('2026-04-04T10:00:00.000Z'),
        profile: {
          city: 'Cairo',
        },
      },
    })

    await expect(nonJsonFailureClient.submit()).resolves.toEqual({
      ok: false,
      status: 500,
      submitted: true,
      valid: false,
      values: {
        email: 'ava@example.com',
        publishedAt: new Date('2026-04-04T10:00:00.000Z'),
        profile: {
          city: 'Cairo',
        },
      },
      errors: {},
    })
    expect(nonJsonFailureClient.lastSubmission).toEqual({
      valid: false,
      submitted: true,
      values: {
        email: 'ava@example.com',
        publishedAt: new Date('2026-04-04T10:00:00.000Z'),
        profile: {
          city: 'Cairo',
        },
      },
      errors: {},
    })
    expect(nonJsonFailureClient.errors.flatten()).toEqual({})

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'text/html; charset=utf-8',
      }),
      async json() {
        throw new Error('Non-JSON success responses should not be parsed as JSON.')
      },
    } as Response))

    const redirectedClient = useForm(registerUser, {
      action: '/register',
      initialValues: {
        email: 'ava@example.com',
        publishedAt: new Date('2026-04-04T10:00:00.000Z'),
        profile: {
          city: 'Cairo',
        },
      },
    })
    const redirectedResult = await redirectedClient.submit()
    expect('ok' in redirectedResult && redirectedResult.ok === true).toBe(true)
    if ('ok' in redirectedResult && redirectedResult.ok) {
      expect(redirectedResult.status).toBe(200)
      expect(redirectedResult.data).toBeUndefined()
    }
  })

  it('preserves failure payload status codes returned by submitters', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
    })

    const client = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
      },
      submitter: () => ({
        ok: false,
        status: 409,
        valid: false,
        values: {
          email: 'taken@example.com',
        },
        errors: {
          email: ['Email is already taken.'],
        },
      }),
    })

    const result = await client.submit()

    expect('ok' in result && result.ok === false).toBe(true)
    if ('ok' in result && result.ok === false) {
      expect(result.status).toBe(409)
      expect(result.errors.email).toEqual(['Email is already taken.'])
    }
    expect(client.values.email).toBe('taken@example.com')
    expect(client.errors.first('email')).toBe('Email is already taken.')
  })

  it('clears dirty state when a field is restored and skips change-validation for non-leaf paths', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
      profile: {
        city: field.string().required(),
      },
    })

    const client = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
        profile: {
          city: 'Cairo',
        },
      },
      validateOn: 'change',
    })

    await client.setValue('email', 'broken')
    expect(client.fields.email.dirty).toBe(true)
    expect(client.errors.first('email')).toBeDefined()

    await client.setValue('email', 'ava@example.com')
    expect(client.fields.email.dirty).toBe(false)
    expect(client.errors.first('email')).toBeUndefined()

    await client.setValue('profile', {
      city: '',
    })
    expect(client.errors.first('profile.city')).toBeUndefined()

    await client.setValue('profile.country.code', 'EG')
    expect((client.values.profile as Record<string, unknown>).country).toEqual({
      code: 'EG',
    })
  })

  it('preserves array values when setting an indexed path', async () => {
    const registerUser = schema({
      tags: field.array(field.string().required()).optional(),
    })

    const client = useForm(registerUser, {
      initialValues: {
        tags: ['first', 'second'],
      },
    })

    await client.setValue('tags.0', 'updated')

    expect(client.values.tags).toEqual(['updated', 'second'])
  })

  it('supports nested object updates inside array values', async () => {
    const registerUser = schema({
      contacts: field.array(
        field.string().required(),
      ).optional(),
    })

    const client = useForm(registerUser, {
      initialValues: {
        contacts: [] as unknown as string[],
      },
    })

    await client.setValue('contacts.0.label', 'home')

    expect(client.values.contacts).toEqual([
      {
        label: 'home',
      },
    ])
  })

  it('reuses existing object entries inside arrays', async () => {
    const registerUser = schema({
      contacts: field.array(field.string().required()).optional(),
    })

    const client = useForm(registerUser, {
      initialValues: {
        contacts: [
          {
            label: 'home',
          },
        ] as unknown as string[],
      },
    })

    await client.setValue('contacts.0.label', 'work')

    expect(client.values.contacts).toEqual([
      {
        label: 'work',
      },
    ])
  })

  it('creates array containers for missing numeric path segments', async () => {
    const registerUser = schema({
      matrix: field.array(field.string().required()).optional(),
    })

    const client = useForm(registerUser)

    await client.setValue('matrix.0.1', 'cell')

    expect(client.values.matrix).toEqual([
      [undefined, 'cell'],
    ])
  })

  it('creates top-level arrays for missing numeric child segments', async () => {
    const registerUser = schema({
      groups: field.array(field.string().required()).optional(),
    })

    const client = useForm(registerUser)

    await client.setValue('groups.0.name', 'admins')

    expect(client.values.groups).toEqual([
      {
        name: 'admins',
      },
    ])
  })

  it('reuses existing nested objects when setting deep paths', async () => {
    const registerUser = schema({
      profile: {
        country: field.string().required(),
      },
    })

    const client = useForm(registerUser, {
      initialValues: {
        profile: {
          country: {
            code: 'EG',
          },
        } as unknown as {
          country: string
        },
      },
    })

    await client.setValue('profile.country.code', 'US')

    expect(client.values.profile).toEqual({
      country: {
        code: 'US',
      },
    })
  })

  it('ignores invalid array offsets when setting nested paths', async () => {
    const registerUser = schema({
      tags: field.array(field.string().required()).optional(),
    })

    const client = useForm(registerUser, {
      initialValues: {
        tags: ['first'],
      },
    })

    await client.setValue('tags.invalid', 'ignored')
    await client.setValue('tags.-1', 'ignored')

    expect(client.values.tags).toEqual(['first'])
  })

  it('supports direct field assignment and listener unsubscribe', () => {
    const registerUser = schema({
      email: field.string().required().email(),
    })

    const client = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
      },
    })

    let notifications = 0
    const unsubscribe = client.subscribe(() => {
      notifications += 1
    })

    client.fields.email.value = 'broken'
    expect(client.values.email).toBe('broken')
    expect(notifications).toBe(1)

    unsubscribe()
    client.fields.email.value = 'ava@example.com'
    expect(notifications).toBe(1)
  })

  it('surfaces array item errors on the array field state', () => {
    const registerUser = schema({
      tags: field.array(field.string().required()).optional(),
    })

    const client = useForm(registerUser, {
      initialValues: {
        tags: [''],
      },
    })

    client.applyServerState({
      ok: false,
      status: 422,
      valid: false,
      values: {
        tags: [''],
      },
      errors: {
        'tags.0': ['Tag is required.'],
      },
    })

    expect(client.errors.first('tags.0')).toBe('Tag is required.')
    expect(client.fields.tags.errors).toEqual(['Tag is required.'])
  })

  it('rehydrates from serialized initial state', () => {
    const registerUser = schema({
      email: field.string().required().email(),
      profile: {
        city: field.string().required(),
      },
    })

    const initialState = createFailedSubmission(registerUser, {
      email: 'serialized-bad',
      profile: {
        city: '',
      },
    }, {
      email: ['Serialized invalid email.'],
      'profile.city': ['Serialized city is required.'],
    }).serialize()

    const client = useForm(registerUser, {
      initialState,
    })

    expect(client.values.email).toBe('serialized-bad')
    expect(client.errors.first('email')).toBe('Serialized invalid email.')
    expect(client.lastSubmission).toEqual(initialState)
  })

  it('tracks submitting while an async submitter is in flight', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
    })

    const deferred = createDeferred<{
      ok: true
      status: number
      data: {
        saved: true
      }
    }>()

    const client = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
      },
      submitter() {
        return deferred.promise
      },
    })

    const pending = client.submit()
    expect(client.submitting).toBe(true)

    deferred.resolve({
      ok: true,
      status: 200,
      data: {
        saved: true,
      },
    })

    const result = await pending
    expect('ok' in result && result.ok === true).toBe(true)
    expect(client.submitting).toBe(false)
  })

  it('ignores empty paths when setting values', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
    })

    const client = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
      },
    })

    await client.setValue('', 'ignored')
    expect(client.values.email).toBe('ava@example.com')
  })

  it('serializes GET submissions into the query string without sending a request body', async () => {
    const searchSchema = schema({
      q: field.string().required(),
      filters: {
        city: field.string().required(),
      },
    })

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'application/json',
      }),
      async json() {
        return {
          ok: true as const,
          status: 200,
          data: {
            results: [],
          },
        }
      },
    }))

    globalThis.fetch = fetchMock as typeof fetch

    const client = useForm(searchSchema, {
      action: 'https://example.com/search',
      method: 'GET',
      initialValues: {
        q: 'ava',
        filters: {
          city: 'Cairo',
        },
      },
    })

    const result = await client.submit()

    expect('ok' in result && result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/search?q=ava&filters.city=Cairo', {
      method: 'GET',
    })
  })

  it('preserves hashes and file names when serializing HEAD submissions without requiring a JSON body', async () => {
    const uploadSchema = schema({
      avatar: field.file().optional(),
    })

    const fetchMock = vi.fn(async () => ({
      status: 204,
      json: vi.fn(async () => {
        throw new Error('HEAD responses should not be parsed as JSON')
      }),
    }))

    globalThis.fetch = fetchMock as typeof fetch

    const client = useForm(uploadSchema, {
      action: 'https://example.com/upload#done',
      method: 'HEAD',
      initialValues: {
        avatar: new File(['avatar'], 'avatar.png', { type: 'image/png' }),
      },
    })

    const result = await client.submit()

    expect('ok' in result && result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/upload?avatar=avatar.png#done', {
      method: 'HEAD',
    })
    await expect(fetchMock.mock.results[0]?.value).resolves.toMatchObject({ status: 204 })
  })

  it('keeps hash-only GET actions intact when there are no query parameters', async () => {
    const searchSchema = schema({
      q: field.string().optional(),
    })

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'application/json',
      }),
      async json() {
        return {
          ok: true as const,
          status: 200,
          data: {
            results: [],
          },
        }
      },
    }))

    globalThis.fetch = fetchMock as typeof fetch

    const client = useForm(searchSchema, {
      action: 'https://example.com/search#results',
      method: 'GET',
    })

    const result = await client.submit()

    expect('ok' in result && result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('https://example.com/search#results', {
      method: 'GET',
    })
  })
})
