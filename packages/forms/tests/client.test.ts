import { createServer, type IncomingMessage, type IncomingHttpHeaders } from 'node:http'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createFailedSubmission, createSuccessfulSubmission } from '../src'
import { field, schema, ValidationException, type WebFileLike } from '@holo-js/validation'
import { createFormClient as useForm, markClientSubmitControlFlowError } from '../src/internal/client'
import { validationExceptionToFailure } from '../src/internal/validation-exception'
import { clearSensitiveInputValues, sanitizeFlashedInput } from '../src/sensitiveInput'

type SensitiveSchemaFixture = NonNullable<Parameters<typeof clearSensitiveInputValues>[1]>
async function createFormHttpEndpoint(response: Response | ((request: IncomingMessage) => Response | Promise<Response>)) {
  const headers: IncomingHttpHeaders[] = []
  const requests: Array<{ method: string | undefined, url: string | undefined, body: string }> = []
  const server = createServer(async (request, outgoing) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString() })
    headers.push(request.headers)
    const result = typeof response === 'function' ? await response(request) : response.clone()
    outgoing.writeHead(result.status, Object.fromEntries(result.headers))
    outgoing.end(Buffer.from(await result.arrayBuffer()))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The native form HTTP server did not bind')
  return { url: `http://127.0.0.1:${address.port}`, requests, headers }
}

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
  it('bootstraps a native CSRF token before an unsafe HTTP submission', async () => {
    const { configureSecurityRuntime, csrf, defineSecurityConfig, resetSecurityRuntime } = await import('../../security/src')
    configureSecurityRuntime({
      config: defineSecurityConfig({ csrf: { enabled: true } }),
      csrfSigningKey: 'native-form-bootstrap-key',
      csrfSession: { read: async () => 'session-token', write: async () => [] },
    })
    onTestFinished(resetSecurityRuntime)
    const token = await csrf.token(new Request('http://localhost/enquiries'))
    const endpoint = await createFormHttpEndpoint(request => request.url === '/csrf'
      ? Response.json({ token })
      : Response.json({ ok: true, status: 201, data: { submitted: true } }, { status: 201 }))
    const client = useForm(schema({ email: field.string().required().email() }), {
      action: `${endpoint.url}/enquiries`,
      credentials: 'include',
      csrf: { endpoint: `${endpoint.url}/csrf` },
      initialValues: { email: 'ava@example.com' },
    })
    await expect(client.submit()).resolves.toMatchObject({ ok: true, status: 201 })
    expect(endpoint.requests.map(request => [request.method, request.url])).toEqual([['GET', '/csrf'], ['POST', '/enquiries']])
    expect(endpoint.headers[1]?.['x-csrf-token']).toBe(token)
    expect(endpoint.requests[1]?.body).toContain('ava@example.com')
  })

  it('sends the bootstrapped CSRF token in the configured header', async () => {
    const browserGlobal = globalThis as typeof globalThis & { document?: { cookie?: string } }
    const originalDocument = browserGlobal.document
    browserGlobal.document = {
      cookie: `HOLO-CSRF-CONFIG=${encodeURIComponent(JSON.stringify({ csrf: { field: '_csrf', header: 'X-App-CSRF', cookie: 'app-xsrf' } }))}`,
    }
    onTestFinished(() => {
      if (originalDocument) browserGlobal.document = originalDocument
      else delete browserGlobal.document
    })
    const endpoint = await createFormHttpEndpoint(request => request.url === '/csrf'
      ? Response.json({ token: 'plain-session-token' })
      : Response.json({ ok: true, status: 201, data: { submitted: true } }, { status: 201 }))
    const client = useForm(schema({ email: field.string().required().email() }), {
      action: `${endpoint.url}/enquiries`,
      csrf: { endpoint: `${endpoint.url}/csrf` },
      initialValues: { email: 'ava@example.com' },
    })

    await expect(client.submit()).resolves.toMatchObject({ ok: true, status: 201 })
    expect(endpoint.headers[1]?.['x-app-csrf']).toBe('plain-session-token')
    expect(endpoint.headers[1]?.['x-csrf-token']).toBeUndefined()
  })

  it('preserves a failed HTTP CSRF bootstrap and does not submit the form', async () => {
    const endpoint = await createFormHttpEndpoint(new Response('Unavailable', { status: 503 }))
    const client = useForm(schema({ email: field.string().required().email() }), {
      action: `${endpoint.url}/enquiries`,
      credentials: 'include',
      csrf: { endpoint: `${endpoint.url}/csrf` },
      initialValues: { email: 'ava@example.com' },
    })
    await expect(client.submit()).resolves.toMatchObject({
      ok: false, status: 503, errors: { _root: ['Unable to submit the form right now. Please try again.'] },
    })
    expect(endpoint.requests).toEqual([{ method: 'GET', url: '/csrf', body: '' }])
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

  it('lets the newest submission own state while every caller receives its result', async () => {
    const first = createDeferred<{ ok: false, status: number, valid: false, values: { email: string }, errors: { email: string[] } }>()
    const second = createDeferred<{ ok: true, status: number, data: string }>()
    let calls = 0
    const client = useForm(schema({ email: field.string() }), {
      initialValues: { email: 'initial@example.com' },
      submitter: () => ++calls === 1 ? first.promise : second.promise,
    })
    const older = client.submit()
    await vi.waitFor(() => expect(calls).toBe(1))
    const newer = client.submit()
    await vi.waitFor(() => expect(calls).toBe(2))
    second.resolve({ ok: true, status: 200, data: 'newer' })
    expect(await newer).toMatchObject({ data: 'newer' })
    expect(client.submitting).toBe(true)
    first.resolve({ ok: false, status: 422, valid: false, values: { email: 'old@example.com' }, errors: { email: ['Old error'] } })
    expect(await older).toMatchObject({ ok: false, errors: { email: ['Old error'] } })
    expect(client.values.email).toBe('initial@example.com')
    expect(client.errors.flatten()).toEqual({})
    expect(client.lastSubmission).toMatchObject({ data: 'newer' })
    expect(client.submitting).toBe(false)
  })

  it.each(['reset', 'edit', 'server'] as const)('protects %s transitions from pending submission responses', async (transition) => {
    const response = createDeferred<{ ok: false, status: number, valid: false, values: { email: string }, errors: { email: string[] } }>()
    let started = false
    const client = useForm(schema({ email: field.string(), password: field.password() }), {
      initialValues: { email: 'before@example.com', password: 'secret' },
      submitter: () => {
        started = true
        return response.promise
      },
    })
    const pending = client.submit()
    await vi.waitFor(() => expect(started).toBe(true))
    if (transition === 'reset') client.reset({ email: 'current@example.com' })
    if (transition === 'edit') await client.fields.email.set('current@example.com')
    if (transition === 'server') client.applyServerState({ ok: false, status: 422, valid: false, values: { email: 'current@example.com' }, errors: {} })
    response.resolve({ ok: false, status: 422, valid: false, values: { email: 'stale@example.com' }, errors: { email: ['Stale error'] } })
    expect(await pending).toMatchObject({ ok: false })
    expect(client.values.email).toBe('current@example.com')
    expect(client.errors.flatten()).toEqual({})
    expect(client.values.password).toBe(transition === 'server' ? '' : 'secret')
    expect(client.fields.email.dirty).toBe(transition !== 'reset')
    expect(client.submitting).toBe(false)
  })

  it('protects edits and applied server errors from pending validation', async () => {
    const validation = createDeferred<true | string>()
    const client = useForm(schema({ email: field.string().customAsync(() => validation.promise) }), {
      initialValues: { email: 'before@example.com' },
    })
    const pending = client.validate()
    await client.setValue('email', 'edited@example.com')
    client.applyServerState({ ok: false, status: 422, valid: false, values: { email: 'server@example.com' }, errors: { email: ['Server error'] } })
    validation.resolve('Stale error')
    await pending
    expect(client.values.email).toBe('server@example.com')
    expect(client.errors.first('email')).toBe('Server error')
    expect(client.fields.email.dirty).toBe(true)
  })

  it('keeps reset values when earlier validation completes', async () => {
    const pending = createDeferred<true | string>()
    const client = useForm(schema({ email: field.string().customAsync(() => pending.promise) }), {
      initialValues: { email: 'before@example.com' },
    })
    const validation = client.validate()
    client.reset({ email: 'reset@example.com' })
    pending.resolve('Old error')
    await validation
    expect(client.values.email).toBe('reset@example.com')
    expect(client.errors.flatten()).toEqual({})
    expect(client.fields.email.dirty).toBe(false)
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

    const blurValidations: Array<{
      readonly value: string
      readonly deferred: ReturnType<typeof createDeferred<true | string>>
    }> = []
    const blurSchema = schema({
      email: field.string().required().customAsync(async (value) => {
        const deferred = createDeferred<true | string>()
        blurValidations.push({
          value,
          deferred,
        })
        return deferred.promise
      }),
    })

    const blurStaleClient = useForm(blurSchema, {
      initialValues: {
        email: 'ava@example.com',
      },
      validateOn: 'blur',
    })

    const firstBlur = blurStaleClient.fields.email.onBlur()
    await vi.waitFor(() => {
      expect(blurValidations).toHaveLength(1)
    })

    const secondBlur = blurStaleClient.fields.email.onBlur()
    await vi.waitFor(() => {
      expect(blurValidations).toHaveLength(2)
    })

    blurValidations[1]?.deferred.resolve(true)
    await secondBlur
    expect(blurStaleClient.errors.first('email')).toBeUndefined()

    blurValidations[0]?.deferred.resolve('Stale blur validation error.')
    await firstBlur
    expect(blurStaleClient.errors.first('email')).toBeUndefined()

    const fieldValidations: Array<ReturnType<typeof createDeferred<true | string>>> = []
    const fieldSchema = schema({
      email: field.string().required().customAsync(async () => {
        const deferred = createDeferred<true | string>()
        fieldValidations.push(deferred)
        return deferred.promise
      }),
    })
    const fieldClient = useForm(fieldSchema, {
      initialValues: {
        email: 'ava@example.com',
      },
    })

    const firstValidate = fieldClient.fields.email.validate()
    await vi.waitFor(() => {
      expect(fieldValidations).toHaveLength(1)
    })

    const secondValidate = fieldClient.fields.email.validate()
    await vi.waitFor(() => {
      expect(fieldValidations).toHaveLength(2)
    })

    fieldValidations[1]?.resolve(true)
    await secondValidate
    expect(fieldClient.errors.first('email')).toBeUndefined()

    fieldValidations[0]?.resolve('Stale field validation error.')
    await firstValidate
    expect(fieldClient.errors.first('email')).toBeUndefined()
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

    const secondClient = useForm(registerUser, {
      initialValues: {
        email: 'second@example.com',
        profile: {
          city: 'Giza',
        },
      },
    })
    secondClient.reset()
    expect(secondClient.values.email).toBe('second@example.com')
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

    const partialFailure = client.applyServerState({
      ok: false,
      status: 422,
      valid: false,
      values: {
        email: 'partial@example.com',
        profile: undefined,
      },
      errors: {
        email: ['Email is not available.'],
      },
    })

    expect('valid' in partialFailure && partialFailure.valid === false).toBe(true)
    expect(client.values.email).toBe('partial@example.com')
    expect(client.values.profile.city).toBe('')

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

  it('clears sensitive array items after a failed submission', () => {
    const team = schema({
      name: field.string().required(),
      recoveryCodes: field.array(field.string().sensitive()),
      pins: field.array(field.password()),
      vault: field.array(field.array(field.password())),
      members: field.array({
        email: field.string(),
        password: field.string(),
        apiKey: field.string().sensitive(),
        devices: field.array({ label: field.string(), secret: field.string().sensitive() }),
        backupCodes: field.array(field.array(field.password())),
      }),
    })
    const client = useForm(team, {
      initialValues: {
        name: 'Core',
        recoveryCodes: ['recovery-one'],
        pins: ['pin-one'],
        vault: [['vault-one']],
        members: [{
          email: 'ava@example.com',
          password: 'member-password',
          apiKey: 'member-key',
          devices: [{ label: 'phone', secret: 'device-secret' }],
          backupCodes: [['backup-one']],
        }],
      },
    })

    client.applyServerState({
      ok: false,
      status: 422,
      valid: false,
      values: { name: 'Core' },
      errors: { name: ['Name is taken.'] },
    })

    expect(client.values).toEqual({
      name: 'Core',
      recoveryCodes: [''],
      pins: [''],
      vault: [['']],
      members: [{
        email: 'ava@example.com',
        password: '',
        apiKey: '',
        devices: [{ label: 'phone', secret: '' }],
        backupCodes: [['']],
      }],
    })
    expect(JSON.stringify(client.values)).not.toMatch(/recovery-one|pin-one|vault-one|member-password|member-key|device-secret|backup-one/)
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
    expect(clearSensitiveInputValues(emptyPathValues, emptyPathSchema)).toEqual({ '': '' })
    expect(sanitizeFlashedInput(emptyPathValues, emptyPathSchema)).toEqual({})
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

    const endpoint1 = await createFormHttpEndpoint(Response.json({ ok: false, status: 422, valid: false, values: { email: 'server-bad', publishedAt: '2026-04-04T10:00:00.000Z' }, errors: { email: ['Server says no.'] } }))

    const fetchClient = useForm(registerUser, {
      action: `${endpoint1.url}/register`,
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

    const endpoint2 = await createFormHttpEndpoint(createJsonResponse({
      type: 'failure',
      status: 422,
      data: JSON.stringify({
        ok: false,
        status: 422,
        valid: false,
        values: {
          email: 'sveltekit-bad',
          publishedAt: '2026-04-04T10:00:00.000Z',
        },
        errors: {
          email: ['SvelteKit action says no.'],
        },
      }),
    }))

    const svelteKitActionClient = useForm(registerUser, {
      action: `${endpoint2.url}/register?/default`,
      initialValues: {
        email: 'ava@example.com',
        publishedAt: new Date('2026-04-04T10:00:00.000Z'),
        profile: {
          city: 'Cairo',
        },
      },
    })
    const svelteKitActionResult = await svelteKitActionClient.submit()
    expect('ok' in svelteKitActionResult && svelteKitActionResult.ok === false).toBe(true)
    expect(svelteKitActionClient.values.email).toBe('sveltekit-bad')
    expect(svelteKitActionClient.errors.first('email')).toBe('SvelteKit action says no.')

    const endpoint3 = await createFormHttpEndpoint(new Response(null, {
      status: 204,
    }))

    const noContentClient = useForm(registerUser, {
      action: `${endpoint3.url}/register`,
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

    const endpoint4 = await createFormHttpEndpoint(createJsonResponse({
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
      action: `${endpoint4.url}/register`,
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

    const endpoint5 = await createFormHttpEndpoint(createTextResponse('<html></html>', {
      status: 500,
      headers: {
        'content-type': 'text/html; charset=utf-8',
      },
    }))

    const nonJsonFailureClient = useForm(registerUser, {
      action: `${endpoint5.url}/register`,
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

    const endpoint6 = await createFormHttpEndpoint(createTextResponse('<html></html>', {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
      },
    }))

    const redirectedClient = useForm(registerUser, {
      action: `${endpoint6.url}/register`,
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

  it('handles malformed and error-shaped SvelteKit action responses', async () => {
    const login = schema({ email: field.string().required().email() })

    const endpoint7 = await createFormHttpEndpoint(createJsonResponse({
      type: 'failure',
      status: 422,
      data: '{malformed',
    }))
    const malformedClient = useForm(login, {
      action: `${endpoint7.url}/login?/default`,
      initialValues: { email: 'ava@example.com' },
    })
    const malformedResult = await malformedClient.submit()
    expect(malformedResult).toBeDefined()

    const endpoint8 = await createFormHttpEndpoint(createJsonResponse({
      type: 'error',
      error: {
        ok: false,
        status: 422,
        valid: false,
        values: { email: 'server@example.com' },
        errors: { email: ['Action failed.'] },
      },
    }))
    const errorClient = useForm(login, {
      action: `${endpoint8.url}/login?/default`,
      initialValues: { email: 'ava@example.com' },
    })
    const errorResult = await errorClient.submit()
    expect('ok' in errorResult && !errorResult.ok).toBe(true)
    expect(errorClient.errors.first('email')).toBe('Action failed.')
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
    if ('ok' in result && result.ok === false && 'status' in result && 'valid' in result && result.valid === false) {
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

  it('preserves HTTP status codes from app submitter errors', async () => {
    const form = useForm(schema({ title: field.string().required() }), {
      initialValues: { title: 'Denied post' },
      submitter() {
        throw Object.assign(new Error('Only the author can update posts.'), { status: 403 })
      },
    })
    await expect(form.submit()).resolves.toMatchObject({ ok: false, status: 403, valid: false })
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

  it('rethrows submitter control-flow errors without converting them into form failures', async () => {
    const login = schema({
      email: field.string().required().email(),
    })
    const redirectError = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/admin;303;',
    })

    const client = useForm(login, {
      initialValues: {
        email: 'ava@example.com',
      },
      async submitter() {
        throw markClientSubmitControlFlowError(redirectError)
      },
    })

    await expect(client.submit()).rejects.toBe(redirectError)
    expect(client.lastSubmission).toBeUndefined()
    expect(client.errors.first('_root')).toBeUndefined()
  })

  it('marks non-extensible submitter control-flow errors without mutating them', async () => {
    const login = schema({
      email: field.string().required().email(),
    })
    const redirectError = Object.freeze(Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/admin;303;',
    }))

    const client = useForm(login, {
      initialValues: {
        email: 'ava@example.com',
      },
      async submitter() {
        throw markClientSubmitControlFlowError(redirectError)
      },
    })

    await expect(client.submit()).rejects.toBe(redirectError)
    expect(client.lastSubmission).toBeUndefined()
    expect(client.errors.first('_root')).toBeUndefined()
  })

  it('leaves primitive control-flow markers unchanged', () => {
    expect(markClientSubmitControlFlowError(undefined)).toBeUndefined()
    expect(markClientSubmitControlFlowError(null)).toBeNull()
    expect(markClientSubmitControlFlowError(false)).toBe(false)
    expect(markClientSubmitControlFlowError('redirect')).toBe('redirect')

    const redirect = () => undefined
    expect(markClientSubmitControlFlowError(redirect)).toBe(redirect)
  })

  it('normalizes validation exceptions and nested form failures with retry metadata', () => {
    const exception = ValidationException.withMessages({ email: ['Invalid email.'] })
    expect(validationExceptionToFailure(exception, { email: 'fallback@example.com' })).toMatchObject({
      status: 422,
      values: { email: 'fallback@example.com' },
      errors: { email: ['Invalid email.'] },
    })

    Object.defineProperty(exception, 'toJSON', {
      value: () => ({
        ok: false,
        status: 429,
        valid: false,
        message: 'Try later.',
        bag: 'default',
        values: { email: 'submitted@example.com' },
        errors: { _root: ['Try later.'] },
        retryAfterSeconds: 30,
        retryAt: '2026-07-12T12:00:00.000Z',
      }),
    })
    expect(validationExceptionToFailure(exception)).toMatchObject({
      values: { email: 'submitted@example.com' },
      retryAfterSeconds: 30,
      retryAt: '2026-07-12T12:00:00.000Z',
    })
    expect(validationExceptionToFailure({ body: exception.toJSON() })).toEqual(validationExceptionToFailure(exception))

    expect(validationExceptionToFailure({
      response: {
        data: {
          ok: false,
          status: 429,
          valid: false,
          values: {},
          errors: { _root: ['Try later.'] },
          retryAfterSeconds: 30,
          retryAt: '2026-07-12T12:00:00.000Z',
        },
      },
    }, { email: 'fallback@example.com' })).toMatchObject({
      status: 429,
      values: { email: 'fallback@example.com' },
      retryAfterSeconds: 30,
      retryAt: '2026-07-12T12:00:00.000Z',
    })
  })

  it('normalizes unmarked primitive and function submission failures', async () => {
    const login = schema({ email: field.string().required().email() })
    const primitiveClient = useForm(login, {
      initialValues: { email: 'ava@example.com' },
      submitter() {
        throw false
      },
    })
    await expect(primitiveClient.submit()).resolves.toMatchObject({ ok: false, status: 500 })

    const functionClient = useForm(login, {
      initialValues: { email: 'ava@example.com' },
      submitter() {
        throw (() => undefined)
      },
    })
    await expect(functionClient.submit()).resolves.toMatchObject({ ok: false, status: 500 })
  })

  it('normalizes rate-limited failure metadata and empty submitter results', async () => {
    const login = schema({ email: field.string().required().email() })
    const rateLimitedClient = useForm(login, {
      initialValues: { email: 'ava@example.com' },
      submitter: () => ({
        ok: false,
        status: 429,
        valid: false,
        values: { email: 'ava@example.com' },
        errors: { _root: ['Try later.'] },
        retryAfterSeconds: 30,
        retryAt: '2026-07-12T12:00:00.000Z',
      }),
    })
    await expect(rateLimitedClient.submit()).resolves.toMatchObject({
      retryAfterSeconds: 30,
      retryAt: '2026-07-12T12:00:00.000Z',
    })

    const emptyClient = useForm(login, {
      initialValues: { email: 'ava@example.com' },
      submitter: () => undefined,
    })
    await expect(emptyClient.submit()).resolves.toMatchObject({ ok: true, status: 204 })
  })

  it('normalizes validation digests thrown across server action transports', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
      password: field.password().required(),
    })
    const validationError = ValidationException.withMessages({
      email: ['These credentials do not match our records.'],
      password: ['These credentials do not match our records.'],
    })

    const client = useForm(registerUser, {
      initialValues: {
        email: 'missing@example.com',
        password: 'secret-secret',
      },
      async submitter() {
        throw Object.assign(new Error(validationError.message), {
          digest: validationError.digest,
        })
      },
    })

    const result = await client.submit()

    expect('ok' in result && result.ok === false).toBe(true)
    expect(client.values.email).toBe('missing@example.com')
    expect(client.errors.first('email')).toBe('These credentials do not match our records.')
    expect(client.errors.first('password')).toBe('These credentials do not match our records.')
  })

  it('normalizes thrown serialized form failures from fetch transports', async () => {
    const login = schema({
      email: field.string().required().email(),
      password: field.password().required(),
    })

    const client = useForm(login, {
      initialValues: {
        email: 'editor@example.com',
        password: 'wrong-password',
      },
      async submitter() {
        throw {
          data: {
            ok: false,
            status: 422,
            valid: false,
            values: {
              email: 'editor@example.com',
            },
            errors: {
              email: ['These credentials do not match our records.'],
              password: ['These credentials do not match our records.'],
            },
          },
        }
      },
    })

    const result = await client.submit()

    expect('ok' in result && result.ok === false).toBe(true)
    expect(client.values.email).toBe('editor@example.com')
    expect(client.values.password).toBe('')
    expect(client.errors.first('email')).toBe('These credentials do not match our records.')
    expect(client.errors.first('password')).toBe('These credentials do not match our records.')
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

  it('serializes nested GET fields over real HTTP without a request body', async () => {
    const endpoint = await createFormHttpEndpoint(Response.json({ ok: true, status: 200, data: { results: [] } }))
    const searchSchema = schema({ q: field.string().required(), filters: { city: field.string().required() } })
    const client = useForm(searchSchema, {
      action: `${endpoint.url}/search`,
      method: 'GET',
      initialValues: { q: 'ava', filters: { city: 'Cairo' } },
    })
    await expect(client.submit()).resolves.toMatchObject({ ok: true, status: 200 })
    expect(endpoint.requests).toEqual([{ method: 'GET', url: '/search?q=ava&filters.city=Cairo', body: '' }])
  })

  it('submits file names through native HEAD requests and accepts an empty successful response', async () => {
    const endpoint = await createFormHttpEndpoint(new Response(null, { status: 204 }))
    const client = useForm(schema({ avatar: field.file().optional() }), {
      action: `${endpoint.url}/upload#done`,
      method: 'HEAD',
      initialValues: { avatar: new File(['avatar'], 'avatar.png', { type: 'image/png' }) },
    })
    await expect(client.submit()).resolves.toMatchObject({ ok: true, status: 204, data: undefined })
    expect(endpoint.requests).toEqual([{ method: 'HEAD', url: '/upload?avatar=avatar.png', body: '' }])
  })

  it('submits GET actions with a hash and no query fields through native HTTP', async () => {
    const endpoint = await createFormHttpEndpoint(Response.json({ ok: true, status: 200, data: { results: [] } }))
    const client = useForm(schema({ q: field.string().optional() }), {
      action: `${endpoint.url}/search#results`,
      method: 'GET',
    })
    await expect(client.submit()).resolves.toMatchObject({ ok: true, status: 200 })
    expect(endpoint.requests).toEqual([{ method: 'GET', url: '/search', body: '' }])
  })
})
