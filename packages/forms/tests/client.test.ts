import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFailedSubmission, createSuccessfulSubmission, field, schema } from '../src'
import { createFormClient as useForm } from '../src/internal/client'
import { clearSensitiveInputValues, sanitizeFlashedInput } from '../src/sensitiveInput'

const browserGlobal = globalThis as typeof globalThis & { document?: Document }
const originalFetch = globalThis.fetch
const originalDocument = browserGlobal.document
type SensitiveSchemaFixture = NonNullable<Parameters<typeof clearSensitiveInputValues>[1]>

function createSecurityClientModule(config: { readonly field: string, readonly cookie: string } = {
  field: '_token',
  cookie: 'XSRF-TOKEN',
}) {
  return {
    getSecurityClientConfig() {
      return {
        csrf: config,
      }
    },
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (typeof originalDocument === 'undefined') {
    delete (browserGlobal as { document?: Document }).document
  } else {
    browserGlobal.document = originalDocument
  }
  delete (globalThis as typeof globalThis & { __holoFormsSecurityModule__?: unknown }).__holoFormsSecurityModule__
  delete (globalThis as typeof globalThis & { __holoFormsSecurityClientModule__?: unknown }).__holoFormsSecurityClientModule__
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

function createJsonResponse(body: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers)
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  })
}

function createTextResponse(body: string, init?: ResponseInit): Response {
  return new Response(body, init)
}

function createSensitiveSchemaFixture(fields: Record<string, unknown>): SensitiveSchemaFixture {
  return { fields } as unknown as SensitiveSchemaFixture
}

describe('@holo-js/forms client', () => {
  it('attaches the configured csrf token to unsafe outgoing form data when the cookie exists', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
    })

    ;(globalThis as typeof globalThis & { __holoFormsSecurityClientModule__?: unknown }).__holoFormsSecurityClientModule__ = createSecurityClientModule()

    browserGlobal.document = {
      cookie: 'XSRF-TOKEN=client-token',
    } as Document

    const client = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
      },
      async submitter({ formData }) {
        expect(formData.get('_token')).toBe('client-token')
        return {
          ok: true,
          status: 200,
          data: undefined,
        }
      },
    })

    await expect(client.submit()).resolves.toEqual({
      ok: true,
      status: 200,
      data: undefined,
    })
  })

  it('uses csrf names exposed by the security client module without requiring the server runtime in the browser', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
    })

    ;(globalThis as typeof globalThis & { __holoFormsSecurityClientModule__?: unknown }).__holoFormsSecurityClientModule__ = createSecurityClientModule({
      field: '_csrf',
      cookie: 'csrf-token',
    })

    browserGlobal.document = {
      cookie: 'csrf-token=client-token',
    } as Document

    const client = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
      },
      async submitter({ formData }) {
        expect(formData.get('_csrf')).toBe('client-token')
        expect(formData.has('_token')).toBe(false)
        return {
          ok: true,
          status: 200,
          data: undefined,
        }
      },
    })

    await expect(client.submit()).resolves.toEqual({
      ok: true,
      status: 200,
      data: undefined,
    })
  })

  it('does not attach csrf tokens for safe methods or when the csrf cookie is missing', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
    })

    ;(globalThis as typeof globalThis & { __holoFormsSecurityClientModule__?: unknown }).__holoFormsSecurityClientModule__ = createSecurityClientModule()

    browserGlobal.document = {
      cookie: 'XSRF-TOKEN=safe-token',
    } as Document

    const safeClient = useForm(registerUser, {
      method: 'GET',
      initialValues: {
        email: 'ava@example.com',
      },
      async submitter({ formData }) {
        expect(formData.has('_token')).toBe(false)
        return {
          ok: true,
          status: 200,
          data: undefined,
        }
      },
    })

    await safeClient.submit()

    browserGlobal.document = {
      cookie: '',
    } as Document

    const clientWithoutCookie = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
      },
      async submitter({ formData }) {
        expect(formData.has('_token')).toBe(false)
        return {
          ok: true,
          status: 200,
          data: undefined,
        }
      },
    })

    await clientWithoutCookie.submit()
  })

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
    expect(blurClient.errors.first('email')).toBeUndefined()

    const emailErrors = await blurClient.fields.email.validate()
    expect(emailErrors).toEqual([])
  })

  it('ignores stale async change validation results that resolve out of order', async () => {
    const validations: Array<{
      readonly value: string
      readonly deferred: ReturnType<typeof createDeferred<true | string>>
    }> = []
    const registerUser = schema({
      email: field.string().required().customAsync(async (value) => {
        const deferred = createDeferred<true | string>()
        validations.push({
          value,
          deferred,
        })
        return deferred.promise
      }),
    })

    const client = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
      },
      validateOn: 'change',
    })

    const first = client.fields.email.onInput('bad')
    await vi.waitFor(() => {
      expect(validations).toHaveLength(1)
    })

    const second = client.fields.email.onInput('next@example.com')
    await vi.waitFor(() => {
      expect(validations).toHaveLength(2)
    })

    expect(validations[0]?.value).toBe('bad')
    expect(validations[1]?.value).toBe('next@example.com')

    validations[1]?.deferred.resolve(true)
    await second
    expect(client.errors.first('email')).toBeUndefined()

    validations[0]?.deferred.resolve('Stale validation error.')
    await first

    expect(client.values.email).toBe('next@example.com')
    expect(client.errors.first('email')).toBeUndefined()

    const setValueValidations: Array<{
      readonly value: string
      readonly deferred: ReturnType<typeof createDeferred<true | string>>
    }> = []
    const setValueSchema = schema({
      email: field.string().required().customAsync(async (value) => {
        const deferred = createDeferred<true | string>()
        setValueValidations.push({
          value,
          deferred,
        })
        return deferred.promise
      }),
    })

    const setValueClient = useForm(setValueSchema, {
      initialValues: {
        email: 'ava@example.com',
      },
      validateOn: 'change',
    })

    const firstSetValue = setValueClient.setValue('email', 'bad')
    await vi.waitFor(() => {
      expect(setValueValidations).toHaveLength(1)
    })

    const secondSetValue = setValueClient.setValue('email', 'next@example.com')
    await vi.waitFor(() => {
      expect(setValueValidations).toHaveLength(2)
    })

    expect(setValueValidations[0]?.value).toBe('bad')
    expect(setValueValidations[1]?.value).toBe('next@example.com')

    setValueValidations[1]?.deferred.resolve(true)
    await secondSetValue
    expect(setValueClient.errors.first('email')).toBeUndefined()

    setValueValidations[0]?.deferred.resolve('Stale validation error.')
    await firstSetValue

    expect(setValueClient.values.email).toBe('next@example.com')
    expect(setValueClient.errors.first('email')).toBeUndefined()
  })

  it('keeps untouched field errors hidden when blur validation runs', async () => {
    const registerUser = schema({
      name: field.string().required(),
      email: field.string().required().email(),
      password: field.password().required().min(8),
    })

    const client = useForm(registerUser, {
      initialValues: {
        name: '',
        email: '',
        password: '',
      },
      validateOn: 'blur',
    })

    await client.fields.name.onBlur()

    expect(client.errors.first('name')).toBe('This field is required.')
    expect(client.errors.first('email')).toBeUndefined()
    expect(client.errors.first('password')).toBeUndefined()
  })

  it('marks fields touched without validating on blur outside blur mode', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
    })

    const client = useForm(registerUser, {
      initialValues: {
        email: '',
      },
    })

    await client.fields.email.onBlur()

    expect(client.fields.email.touched).toBe(true)
    expect(client.errors.first('email')).toBeUndefined()
  })

  it('replaces path-specific blur errors without dropping unrelated server errors', async () => {
    const registerUser = schema({
      profile: {
        city: field.string().required(),
        country: field.string().required(),
      },
    })

    const client = useForm(registerUser, {
      validateOn: 'blur',
      initialValues: {
        profile: {
          city: 'Cairo',
          country: '',
        },
      },
    })

    client.applyServerState({
      ok: false,
      status: 422,
      valid: false,
      values: {},
      errors: {
        'profile.city': ['Old city error.'],
        'profile.country': ['Old country error.'],
      },
    })

    await client.fields.profile.city.onBlur()

    expect(client.errors.first('profile.city')).toBeUndefined()
    expect(client.errors.first('profile.country')).toBe('Old country error.')
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
    expect(client.lastSubmission).toBeUndefined()

    const fieldErrors = await client.validateField('email')
    expect(fieldErrors.length).toBeGreaterThan(0)

    const failure = await client.submit()
    expect('valid' in failure && failure.valid === false).toBe(true)
    expect(client.lastSubmission).toBeUndefined()

    client.reset({
      email: 'reset@example.com',
    })

    expect(client.values.email).toBe('reset@example.com')
    expect(client.errors.flatten()).toEqual({})
    expect(client.lastSubmission).toBeUndefined()
  })

  it('serializes valid client submissions and can convert them to failures', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
    })

    const client = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
      },
    })

    const submission = await client.validate()
    expect(submission.valid).toBe(true)

    if (submission.valid) {
      expect(submission.serialize()).toEqual({
        valid: true,
        submitted: true,
        values: {
          email: 'ava@example.com',
        },
        errors: {},
      })
      expect(submission.success({ message: 'Saved.' }, 201)).toEqual({
        ok: true,
        status: 201,
        data: {
          message: 'Saved.',
        },
      })
      expect(submission.fail({
        status: 409,
        errors: {
          _root: ['Manual failure.'],
        },
      })).toEqual({
        ok: false,
        status: 409,
        valid: false,
        values: {
          email: 'ava@example.com',
        },
        errors: {
          _root: ['Manual failure.'],
        },
      })
    }
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
    if (
      'valid' in successfulSerializedResult
      && successfulSerializedResult.valid
      && 'data' in successfulSerializedResult
    ) {
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

  it('resets sensitive fields to controlled empty values after server-side failures', () => {
    const registerUser = schema({
      email: field.string().required().email(),
      password: field.password().required().min(8),
      passwordConfirmation: field.password().required(),
      nationalId: field.string().sensitive().required(),
    })

    const client = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
        password: 'super-secret',
        passwordConfirmation: 'super-secret',
        nationalId: 'private-id',
      },
    })

    client.applyServerState({
      ok: false,
      status: 422,
      valid: false,
      values: {
        email: 'bad',
      },
      errors: {
        email: ['Email must be valid.'],
        password: ['The password field is required.'],
      },
    })

    expect(client.values.email).toBe('bad')
    expect(client.values.password).toBe('')
    expect(client.values.passwordConfirmation).toBe('')
    expect(client.values.nationalId).toBe('')
    expect(client.errors.first('password')).toBe('The password field is required.')
  })

  it('preserves controlled sensitive values for nested and malformed client state', () => {
    const nestedCredentials = schema({
      credentials: {
        password: field.password().required(),
        nationalId: field.string().sensitive().required(),
        nested: {
          deep: {
            password: field.password().required(),
          },
        },
      },
    })

    const nestedValues = {
      credentials: {
        password: 'super-secret',
        nationalId: 'private-id',
      },
    }
    expect(clearSensitiveInputValues(nestedValues, nestedCredentials)).toEqual({
      credentials: {
        password: '',
        nationalId: '',
      },
    })

    const malformedValues = {
      credentials: {
        nested: 'not-an-object',
      },
    }
    expect(clearSensitiveInputValues(malformedValues, nestedCredentials)).toEqual({
      credentials: {
        nested: 'not-an-object',
      },
    })
    expect(sanitizeFlashedInput(malformedValues, nestedCredentials)).toEqual({
      credentials: {
        nested: 'not-an-object',
      },
    })

    const missingLeafValues = {
      credentials: {},
      passwordConfirmation: 'super-secret',
    }
    expect(clearSensitiveInputValues(missingLeafValues, nestedCredentials)).toEqual({
      credentials: {},
      passwordConfirmation: '',
    })

    const emptyPathSchema = createSensitiveSchemaFixture({
      '': {
        kind: 'field',
        definition: {
          kind: 'string',
          rules: [],
          sensitive: true,
        },
      },
    })
    const emptyPathValues = {
      '': 'private-id',
    }
    expect(clearSensitiveInputValues(emptyPathValues, emptyPathSchema)).toEqual(emptyPathValues)
    expect(sanitizeFlashedInput(emptyPathValues, emptyPathSchema)).toEqual(emptyPathValues)
    expect(clearSensitiveInputValues('super-secret')).toBe('super-secret')
    expect(sanitizeFlashedInput('super-secret')).toBe('super-secret')

    const shallowMalformedSchema = createSensitiveSchemaFixture({
      credentials: {
        password: {
          kind: 'field',
          definition: {
            kind: 'string',
            rules: [],
            sensitive: true,
          },
        },
      },
      ignored: null,
    })
    const shallowMalformedValues = {
      credentials: 'not-an-object',
      ignored: 'kept',
    }
    expect(sanitizeFlashedInput(shallowMalformedValues, shallowMalformedSchema)).toEqual(shallowMalformedValues)
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

    globalThis.fetch = vi.fn(async (): Promise<Response> => new Response(null, {
      status: 204,
    }))

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

    globalThis.fetch = vi.fn(async (): Promise<Response> => createJsonResponse({
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
    }, {
      status: 422,
    }))

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

    globalThis.fetch = vi.fn(async (): Promise<Response> => createTextResponse('<html></html>', {
      status: 500,
      headers: {
        'content-type': 'text/html; charset=utf-8',
      },
    }))

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
      errors: {
        _root: ['Unable to submit the form right now. Please try again.'],
      },
    })
    expect(nonJsonFailureClient.lastSubmission).toEqual({
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
      errors: {
        _root: ['Unable to submit the form right now. Please try again.'],
      },
    })
    expect(nonJsonFailureClient.errors.flatten()).toEqual({
      _root: ['Unable to submit the form right now. Please try again.'],
    })

    globalThis.fetch = vi.fn(async (): Promise<Response> => createTextResponse('<html></html>', {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
      },
    }))

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
    if ('ok' in result && result.ok === false && 'status' in result) {
      expect(result.status).toBe(409)
      expect(result.errors.email).toEqual(['Email is already taken.'])
    }
    expect(client.values.email).toBe('taken@example.com')
    expect(client.errors.first('email')).toBe('Email is already taken.')
  })

  it('supports destructuring submit from the form client', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
    })

    const submitter = vi.fn(() => ({
      ok: false as const,
      status: 422,
      valid: false as const,
      values: {
        email: 'taken@example.com',
      },
      errors: {
        email: ['Email is already taken.'],
      },
    }))

    const client = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
      },
      submitter,
    })
    const submit = client.submit

    const result = await submit()

    expect(submitter).toHaveBeenCalledTimes(1)
    expect('ok' in result && result.ok === false).toBe(true)
    expect(client.values.email).toBe('taken@example.com')
    expect(client.errors.first('email')).toBe('Email is already taken.')
  })

  it('normalizes submitter transport errors into form failures', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
    })

    const client = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
      },
      async submitter() {
        throw new SyntaxError('Unexpected token < in JSON')
      },
    })

    await expect(client.submit()).resolves.toEqual({
      ok: false,
      status: 500,
      submitted: true,
      valid: false,
      values: {
        email: 'ava@example.com',
      },
      errors: {
        _root: ['Unable to submit the form right now. Please try again.'],
      },
    })
    expect(client.errors.first('_root')).toBe('Unable to submit the form right now. Please try again.')
    expect(client.lastSubmission).toEqual({
      ok: false,
      status: 500,
      submitted: true,
      valid: false,
      values: {
        email: 'ava@example.com',
      },
      errors: {
        _root: ['Unable to submit the form right now. Please try again.'],
      },
    })
  })

  it('removes sensitive values from transport failure payloads', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
      password: field.password().required().min(8),
      passwordConfirmation: field.password().required(),
      nationalId: field.string().sensitive().required(),
    })

    const client = useForm(registerUser, {
      initialValues: {
        email: 'ava@example.com',
        password: 'super-secret',
        passwordConfirmation: 'super-secret',
        nationalId: 'private-id',
      },
      async submitter() {
        throw new SyntaxError('Unexpected token < in JSON')
      },
    })

    const result = await client.submit()

    expect(result).toEqual({
      ok: false,
      status: 500,
      submitted: true,
      valid: false,
      values: {
        email: 'ava@example.com',
      },
      errors: {
        _root: ['Unable to submit the form right now. Please try again.'],
      },
    })
    expect(client.lastSubmission).toEqual(result)
    expect(client.values).toEqual({
      email: 'ava@example.com',
      password: '',
      passwordConfirmation: '',
      nationalId: '',
    })
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

  it('lets initial server state override default initial values', () => {
    const registerUser = schema({
      email: field.string().required().email(),
    })

    const initialState = createFailedSubmission(registerUser, {
      email: 'submitted-bad',
    }, {
      email: ['Submitted email is invalid.'],
    }).fail()

    const client = useForm(registerUser, {
      initialValues: {
        email: '',
      },
      initialState,
    })

    expect(client.values.email).toBe('submitted-bad')
    expect(client.errors.first('email')).toBe('Submitted email is invalid.')
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

    const fetchMock = vi.fn(async (): Promise<Response> => createJsonResponse({
      ok: true as const,
      status: 200,
      data: {
        results: [],
      },
    }, {
      status: 200,
    }))

    globalThis.fetch = fetchMock

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

    const fetchMock = vi.fn(async (): Promise<Response> => new Response(null, {
      status: 204,
    }))

    globalThis.fetch = fetchMock

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

    const fetchMock = vi.fn(async (): Promise<Response> => createJsonResponse({
      ok: true as const,
      status: 200,
      data: {
        results: [],
      },
    }, {
      status: 200,
    }))

    globalThis.fetch = fetchMock

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
