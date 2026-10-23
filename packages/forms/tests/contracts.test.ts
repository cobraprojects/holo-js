import { describe, expect, it, onTestFinished } from 'vitest'
import { requestUrlInternals } from '@holo-js/kernel'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureSecurityRuntime, createFileRateLimitStore, ip, limit, resetSecurityRuntime } from '@holo-js/security'
import {
  FormContractError,
  createFailedSubmission,
  createSuccessfulSubmission,
  formsInternals,
  safeParse,
  validate,
  type FormFailureErrors,
} from '../src'
import {
  ValidationException,
  field,
  schema,
} from '@holo-js/validation'

function connectThroughLocalProxy(): void {
  requestUrlInternals.provideConnectionAddress(() => '127.0.0.1')
  onTestFinished(() => {
    resetSecurityRuntime()
    requestUrlInternals.provideConnectionAddress(undefined)
  })
}

async function configureNativeSecurity(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'holo-form-rate-limits-'))
  connectThroughLocalProxy()
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true })
  })
  configureSecurityRuntime({
    config: {
      trustedProxies: ['127.0.0.1'],
      rateLimit: {
        driver: 'file',
        limiters: {
          login: limit.perMinute(1).by(({ request, values }) => `${ip(request)}:${typeof values?.email === 'string' ? values.email : 'guest'}`),
        },
      },
    },
    rateLimitStore: createFileRateLimitStore(directory),
  })
  return directory
}

describe('@holo-js/forms contracts', () => {
  it('resolves form request origins from Host and honors only explicitly trusted proxies', () => {
    connectThroughLocalProxy()
    const input = {
      method: 'POST',
      url: 'http://localhost/signup?next=%2Fadmin',
      headers: {
        host: '127.0.0.1:43201',
        'x-forwarded-host': 'public.example',
        'x-forwarded-proto': 'https',
      },
      body: 'email=ava',
    }
    expect(formsInternals.normalizeRequestLikeInput(input)?.url).toBe('http://127.0.0.1:43201/signup?next=%2Fadmin')
    configureSecurityRuntime({ config: { trustedProxies: ['127.0.0.1'] } })
    expect(formsInternals.normalizeRequestLikeInput(input)?.url).toBe('https://public.example/signup?next=%2Fadmin')
    expect(formsInternals.normalizeRequestLikeInput({ ...input, headers: { ...input.headers, 'x-forwarded-prefix': '/blog' } })?.url)
      .toBe('https://public.example/signup?next=%2Fadmin')
  })

  it('returns validated data from validate and throws validation exceptions for failures', async () => {
    const login = schema({
      email: field.string().required().email(),
      password: field.password().required(),
    })

    const data = await validate({
      email: 'ava@example.com',
      password: 'secret123',
    }, login)

    expect(data).toEqual({
      email: 'ava@example.com',
      password: 'secret123',
    })

    await expect(validate({
      email: 'bad',
      password: '',
    }, login, { bag: 'login' })).rejects.toMatchObject({
      name: 'ValidationException',
      bag: 'login',
      status: 422,
    })

    try {
      await validate({
        email: 'bad',
        password: '',
      }, login)
      throw new Error('Expected validation to fail.')
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationException)
      const exception = error as ValidationException
      expect(exception.errors.first('email')).toBeDefined()
      expect(exception.errors.first('password')).toBe('This field is required.')
      expect(exception.values).toEqual({
        email: 'bad',
      })
    }
  })

  it('strips passwords and sensitive fields inside arrays from failures and thrown exceptions', async () => {
    const team = schema({
      name: field.string().required().min(5),
      members: field.array({
        email: field.string(),
        password: field.string(),
        ssn: field.string().sensitive(),
        keys: field.array({ label: field.string(), secret: field.string().sensitive() }),
      }),
    })
    const input = {
      name: 'abc',
      members: [{ email: 'ava@example.com', password: 'member-password', ssn: 'member-ssn', keys: [{ label: 'deploy', secret: 'key-secret' }] }],
    }
    const expected = { name: 'abc', members: [{ email: 'ava@example.com', keys: [{ label: 'deploy' }] }] }

    const failure = await safeParse(input, team)
    if (failure.valid) {
      throw new Error('Expected form submission failure.')
    }

    expect(failure.fail().values).toEqual(expected)
    expect(failure.serialize().values).toEqual(expected)
    const thrown = await validate(input, team).catch((error: unknown) => error)
    expect(thrown).toBeInstanceOf(ValidationException)
    expect((thrown as ValidationException).toJSON().values).toEqual(expected)
    expect((thrown as ValidationException).values).toEqual(expected)
  })

  it('creates successful and failed submission payload contracts', () => {
    const registerUser = schema({
      email: field.string().required().email(),
      profile: {
        city: field.string().required(),
      },
    })

    const success = createSuccessfulSubmission(registerUser, {
      email: 'ava@example.com',
      profile: {
        city: 'Cairo',
      },
    })
    const failure = createFailedSubmission(registerUser, {
      email: 'broken',
    }, {
      email: ['Email must be valid.'],
      'profile.city': ['City is required.'],
    })

    expect(success.valid).toBe(true)
    expect(success.errors.flatten()).toEqual({})
    expect(success.serialize()).toEqual({
      valid: true,
      submitted: true,
      values: {
        email: 'ava@example.com',
        profile: {
          city: 'Cairo',
        },
      },
      errors: {},
    })
    expect(success.success({ ok: true }, 201)).toEqual({
      ok: true,
      status: 201,
      data: { ok: true },
    })
    expect(success.fail()).toEqual({
      ok: false,
      status: 422,
      valid: false,
      values: {
        email: 'ava@example.com',
        profile: {
          city: 'Cairo',
        },
      },
      errors: {},
    })

    expect(failure.valid).toBe(false)
    expect(failure.errors.email).toEqual(['Email must be valid.'])
    expect(failure.errors.profile?.city).toEqual(['City is required.'])
    expect(failure.serialize()).toEqual({
      valid: false,
      submitted: true,
      values: {
        email: 'broken',
      },
      errors: {
        email: ['Email must be valid.'],
        'profile.city': ['City is required.'],
      },
    })
    expect(failure.fail(409).status).toBe(409)
    expect(() => createFailedSubmission(registerUser, {
      email: 'broken',
    }, {
      email: ['Email must be valid.'],
    }, 99)).toThrow('HTTP status codes must be integers greater than or equal to 100.')
  })

  it('submits form input through the shared validation engine and preserves failure values', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
      age: field.number().integer().optional(),
      profile: {
        city: field.string().required(),
      },
    })

    const success = await safeParse({
      email: 'ava@example.com',
      age: '42',
      profile: {
        city: 'Cairo',
      },
    }, registerUser)

    expect(success.valid).toBe(true)
    if (!success.valid) {
      throw new Error('Expected form submission success.')
    }

    expect(success.data.age).toBe(42)
    expect(success.success({ message: 'ok' })).toEqual({
      ok: true,
      status: 200,
      data: { message: 'ok' },
    })

    const failure = await safeParse({
      email: 'bad',
      age: '4.2',
      profile: {
        city: '',
      },
    }, registerUser)

    expect(failure.valid).toBe(false)
    if (failure.valid) {
      throw new Error('Expected form submission failure.')
    }

    expect(failure.values).toEqual({
      email: 'bad',
      age: 4.2,
      profile: {
        city: '',
      },
    })
    expect(failure.errors.first('email')).toBeDefined()
    expect(failure.errors.first('age')).toBeDefined()
    expect(failure.errors.first('profile.city')).toBe('This field is required.')
    expect(failure.fail()).toEqual({
      ok: false,
      status: 422,
      valid: false,
      values: {
        email: 'bad',
        age: 4.2,
        profile: {
          city: '',
        },
      },
      errors: failure.errors.flatten(),
    })
  })

  it('does not flash uploaded files in serialized failure payloads', async () => {
    const profile = schema({
      avatar: field.file().required().image().maxSize(1),
    })
    const avatar = new File(['avatar'], 'avatar.png', { type: 'image/png' })

    const failure = await safeParse({
      avatar,
    }, profile)

    expect(failure.valid).toBe(false)
    if (failure.valid) {
      throw new Error('Expected form submission failure.')
    }

    expect(failure.values.avatar).toBe(avatar)
    expect(failure.serialize()).toEqual({
      valid: false,
      submitted: true,
      values: {},
      errors: failure.errors.flatten(),
    })
    expect(failure.fail()).toEqual({
      ok: false,
      status: 422,
      valid: false,
      values: {},
      errors: failure.errors.flatten(),
    })
  })

  it('excludes password-like dontFlash fields while preserving transport tokens in serialized failure payloads', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
      password: field.password().required().min(8),
      passwordConfirmation: field.password().required(),
      token: field.string().required(),
      nationalId: field.string().sensitive().required(),
    })

    const failure = await safeParse({
      email: 'bad',
      password: 'super-secret',
      passwordConfirmation: 'super-secret',
      token: 'reset-token',
      nationalId: 'private-id',
    }, registerUser)

    expect(failure.valid).toBe(false)
    if (failure.valid) {
      throw new Error('Expected form submission failure.')
    }

    expect(failure.values).toEqual({
      email: 'bad',
      password: 'super-secret',
      passwordConfirmation: 'super-secret',
      token: 'reset-token',
      nationalId: 'private-id',
    })
    expect(failure.serialize()).toEqual({
      valid: false,
      submitted: true,
      values: {
        email: 'bad',
        token: 'reset-token',
      },
      errors: {
        email: ['This field must be a valid email address.'],
      },
    })
    expect(failure.fail()).toEqual({
      ok: false,
      status: 422,
      valid: false,
      values: {
        email: 'bad',
        token: 'reset-token',
      },
      errors: {
        email: ['This field must be a valid email address.'],
      },
    })
    expect(failure.fail({
      status: 409,
      errors: {
        email: ['A user with this email already exists.'],
      },
    })).toEqual({
      ok: false,
      status: 409,
      valid: false,
      values: {
        email: 'bad',
        token: 'reset-token',
      },
      errors: {
        email: ['A user with this email already exists.'],
      },
    })
  })

  it('merges failure override errors with existing validation errors', () => {
    const registerUser = schema({
      email: field.string().required().email(),
      token: field.string().required(),
    })
    const failure = createFailedSubmission(registerUser, {
      email: 'bad',
    }, {
      email: ['Invalid email.'],
      token: ['Missing token.'],
    })

    expect(failure.fail({
      errors: {
        email: ['A user with this email already exists.'],
      },
    }).errors).toEqual({
      email: ['A user with this email already exists.'],
      token: ['Missing token.'],
    })

    const undefinedOverride = { email: undefined } as FormFailureErrors

    expect(failure.fail({
      errors: undefinedOverride,
    }).errors).toEqual({
      email: ['Invalid email.'],
      token: ['Missing token.'],
    })
  })

  it('preserves verification and reset transport tokens while still stripping passwords', () => {
    expect(formsInternals.sanitizeFlashedInput({
      email: 'ava@example.com',
      password: 'secret-secret',
      token: 'reset-token',
      verification_token: 'verify-token',
      verificationCode: '123456',
    })).toEqual({
      email: 'ava@example.com',
      token: 'reset-token',
      verification_token: 'verify-token',
      verificationCode: '123456',
    })
  })

  it('does not mutate nested values when sanitizing flashed input', () => {
    const profileForm = schema({
      email: field.string().required(),
      profile: {
        displayName: field.string().required(),
        nationalId: field.string().sensitive().required(),
      },
    })
    const values = {
      email: 'ava@example.com',
      password: 'secret-secret',
      profile: {
        displayName: 'Ava',
        nationalId: 'private-id',
      },
    }

    expect(formsInternals.sanitizeFlashedInput(values, profileForm)).toEqual({
      email: 'ava@example.com',
      profile: {
        displayName: 'Ava',
      },
    })
    expect(values).toEqual({
      email: 'ava@example.com',
      password: 'secret-secret',
      profile: {
        displayName: 'Ava',
        nationalId: 'private-id',
      },
    })
  })

  it('does not coerce plain form objects with request-like field names into Request inputs', async () => {
    const requestMeta = schema({
      method: field.string().required(),
      url: field.string().required(),
      headers: field.string().required(),
      path: field.string().required(),
    })

    const submission = await safeParse({
      method: 'POST',
      url: '/login',
      headers: 'content-type: application/x-www-form-urlencoded',
      path: '/login',
    }, requestMeta)

    expect(submission.valid).toBe(true)
    if (!submission.valid) {
      throw new Error('Expected form submission success.')
    }

    expect(submission.data).toEqual({
      method: 'POST',
      url: '/login',
      headers: 'content-type: application/x-www-form-urlencoded',
      path: '/login',
    })
  })

  it('normalizes request-like event inputs even without security options', async () => {
    const forgotPassword = schema({
      email: field.string().required().email(),
    })

    const submission = await safeParse({
      method: 'POST',
      path: '/forgot-password',
      headers: {
        host: 'app.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        email: 'ava@example.com',
      }),
    }, forgotPassword)

    expect(submission.valid).toBe(true)
    if (!submission.valid) {
      throw new Error('Expected request-like event validation success.')
    }

    expect(submission.data).toEqual({
      email: 'ava@example.com',
    })
  })

  it('runs throttle checks through safeParse() and returns form-shaped security failures', async () => {
    const login = schema({
      email: field.string().required().email(),
    })

    await configureNativeSecurity()

    const allowedRequest = new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        'x-forwarded-for': '203.0.113.7',
      },
      body: new URLSearchParams({
        email: 'ava@example.com',
      }),
    })

    const firstAllowed = await safeParse(allowedRequest, login, {
      throttle: 'login',
    })
    expect(firstAllowed.valid).toBe(true)

    const differentEmail = await safeParse(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        'x-forwarded-for': '203.0.113.7',
      },
      body: new URLSearchParams({
        email: 'other@example.com',
      }),
    }), login, {
      throttle: 'login',
    })
    expect(differentEmail.valid).toBe(true)

    const throttled = await safeParse(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        'x-forwarded-for': '203.0.113.7',
      },
      body: new URLSearchParams({
        email: 'ava@example.com',
      }),
    }), login, {
      throttle: 'login',
    })

    expect(throttled.valid).toBe(false)
    if (throttled.valid) {
      throw new Error('Expected throttle failure.')
    }

    expect(throttled.values).toEqual({
      email: 'ava@example.com',
    })
    expect(throttled.errors.get('_root')).toEqual(['Too many attempts. Please try again later.'])
    expect(throttled.fail()).toMatchObject({ status: 429, retryAfterSeconds: 60 })
    const retryAt = throttled.fail().retryAt
    expect(retryAt).toBeDefined()
    expect(Date.parse(retryAt ?? '')).toBeGreaterThan(Date.now() + 59000)
    expect(Date.parse(retryAt ?? '')).toBeLessThanOrEqual(Date.now() + 60000)

    try {
      await validate(new Request('https://app.test/login', {
        method: 'POST',
        headers: {
          'x-forwarded-for': '203.0.113.7',
        },
        body: new URLSearchParams({
          email: 'other@example.com',
        }),
      }), login, {
        throttle: 'login',
      })
      throw new Error('Expected throttled validation to fail.')
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationException)
      const exception = error as ValidationException
      expect(exception.toJSON()).toMatchObject({
        status: 429,
        retryAfterSeconds: 60,
        retryAt: expect.any(String),
      })
    }
  })

  it('answers an oversized form body with a 413 failure, with or without throttling', async () => {
    const login = schema({
      email: field.string().required().email(),
    })
    const oversized = () => new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ email: 'ava@example.com', padding: 'x'.repeat(2 * 1024 * 1024) }),
    })

    const result = await safeParse(oversized(), login)

    expect(result.valid).toBe(false)
    if (result.valid) {
      throw new Error('Expected the oversized body to fail.')
    }
    expect(result.fail()).toMatchObject({ status: 413 })
    await expect(validate(oversized(), login)).rejects.toMatchObject({ status: 413 })
  })

  it('gives a custom throttle key resolver a readable copy of the submitted request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holo-form-limiter-request-'))
    connectThroughLocalProxy()
    onTestFinished(async () => {
      await rm(directory, { recursive: true, force: true })
    })
    const keyedEmails: string[] = []
    configureSecurityRuntime({
      config: {
        trustedProxies: ['127.0.0.1'],
        rateLimit: {
          driver: 'file',
          limiters: {
            login: limit.perMinute(5).by(async ({ request }) => {
              const form = await request.clone().formData()
              const email = String(form.get('email'))
              keyedEmails.push(email)
              return `${ip(request)}:${email}`
            }),
          },
        },
      },
      rateLimitStore: createFileRateLimitStore(directory),
    })
    const login = schema({
      email: field.string().required().email(),
    })

    const result = await safeParse(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        'x-forwarded-for': '203.0.113.13',
      },
      body: new URLSearchParams({ email: 'ava@example.com' }),
    }), login, {
      throttle: 'login',
    })

    expect(result.valid).toBe(true)
    expect(keyedEmails).toEqual(['ava@example.com'])
  })

  it('keys the throttle on the canonical value, so case and whitespace variants share one bucket', async () => {
    const login = schema({
      email: field.string().required().transform(value => value.trim().toLowerCase()),
    })

    await configureNativeSecurity()

    const attempt = (email: string) => safeParse(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        'x-forwarded-for': '203.0.113.11',
      },
      body: new URLSearchParams({ email }),
    }), login, {
      throttle: 'login',
    })

    expect((await attempt('Victim@Example.com ')).valid).toBe(true)

    const variant = await attempt('victim@example.com')

    expect(variant.valid).toBe(false)
    expect(variant.fail()).toMatchObject({ status: 429 })
  })

  it('counts an invalid submission toward the throttle, so the next attempt is answered 429', async () => {
    const login = schema({
      email: field.string().required().email(),
      password: field.string().required(),
    })

    await configureNativeSecurity()

    const attempt = () => safeParse(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        'x-forwarded-for': '203.0.113.12',
      },
      body: new URLSearchParams({ email: 'ava@example.com' }),
    }), login, {
      throttle: 'login',
    })

    const first = await attempt()
    expect(first.valid).toBe(false)
    expect(first.errors.first('password')).toBeDefined()

    const second = await attempt()
    expect(second.valid).toBe(false)
    expect(second.fail()).toMatchObject({ status: 429 })
  })

  it('validates a throttled submission whose body is a stream, reading the body once', async () => {
    const login = schema({
      email: field.string().required().email(),
    })

    await configureNativeSecurity()

    const pulls: number[] = []
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls.push(pulls.length)
        controller.enqueue(new TextEncoder().encode('email=ava%40example.com'))
        controller.close()
      },
    }, { highWaterMark: 0 })

    const result = await safeParse(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-for': '203.0.113.10',
      },
      body,
      duplex: 'half',
    } as RequestInit), login, {
      throttle: 'login',
    })

    expect(result.valid).toBe(true)
    if (!result.valid) {
      throw new Error('Expected the stream submission to validate.')
    }
    expect(result.data).toEqual({ email: 'ava@example.com' })
    expect(pulls.length).toBe(1)
  })

  it('returns the controlled malformed-input failure for throttled submissions instead of throwing', async () => {
    const login = schema({
      email: field.string().required().email(),
    })

    await configureNativeSecurity()

    const result = await safeParse(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        'x-forwarded-for': '203.0.113.9',
      },
      body: new URLSearchParams([
        ['profile[__proto__][x]', 'owned'],
        ['email', 'ava@example.com'],
      ]),
    }), login, {
      throttle: 'login',
    })

    expect(result.valid).toBe(false)
  })

  it('requires Request inputs for throttle-aware validation', async () => {
    const login = schema({
      email: field.string().required().email(),
    })

    await configureNativeSecurity()

    await expect(safeParse({
      email: 'ava@example.com',
    }, login, {
      throttle: 'login',
    })).rejects.toThrow('Security-aware safeParse() options require a Request or request-like event input.')

    await expect(safeParse(new FormData(), login, {
      throttle: 'login',
    })).rejects.toThrow('Security-aware safeParse() options require a Request or request-like event input.')
  })

  it('accepts h3-style event objects for security-aware validation', async () => {
    const login = schema({
      email: field.string().required().email(),
    })

    await configureNativeSecurity()

    const event = {
      method: 'POST',
      path: '/login',
      node: {
        req: {
          method: 'POST',
          headers: {
            'x-forwarded-for': '203.0.113.7',
            host: 'app.test',
          },
          body: new URLSearchParams({
            email: 'ava@example.com',
          }),
        },
      },
    }

    const firstAllowed = await safeParse(event, login, {
      throttle: 'login',
    })
    expect(firstAllowed.valid).toBe(true)

    const throttled = await safeParse(event, login, {
      throttle: 'login',
    })
    expect(throttled.valid).toBe(false)
    if (throttled.valid) {
      throw new Error('Expected throttle failure.')
    }

    expect(throttled.values).toEqual({
      email: 'ava@example.com',
    })
    expect(throttled.errors.get('_root')).toEqual(['Too many attempts. Please try again later.'])
  })

  it('accepts h3-style event objects after middleware cached the raw body', async () => {
    const login = schema({
      email: field.string().required().email(),
    })
    const rawBodySymbol = Symbol.for('h3RawBody')

    await configureNativeSecurity()

    const event = {
      method: 'POST',
      path: '/login',
      node: {
        req: {
          method: 'POST',
          url: '/login',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'x-forwarded-for': '203.0.113.8',
            host: 'app.test',
          },
          [rawBodySymbol]: Promise.resolve(new TextEncoder().encode('email=ava%40example.com')),
          pipe() {
            throw new Error('The drained request stream should not be reused.')
          },
        },
      },
    }

    const submission = await safeParse(event, login, {
      throttle: 'login',
    })
    expect(submission.valid).toBe(true)
    if (!submission.valid) {
      throw new Error('Expected cached h3 raw-body validation to pass.')
    }

    expect(submission.data.email).toBe('ava@example.com')
  })

  it('rejects security-aware FormData when ambient Next headers are unavailable', async () => {
    const login = schema({
      email: field.string().required().email(),
    })
    await configureNativeSecurity()

    const formData = new FormData()
    formData.set('email', 'ava@example.com')

    await expect(safeParse(formData, login, {
      throttle: 'login',
    })).rejects.toThrow('Security-aware safeParse() options require a Request or request-like event input.')
  })

  it('reuses embedded Request instances when normalizing request-like inputs', () => {
    const directRequest = new Request('https://app.test/direct', {
      method: 'POST',
    })
    const webRequest = new Request('https://app.test/web', {
      method: 'POST',
    })
    const nodeRequest = new Request('https://app.test/node', {
      method: 'PATCH',
    })

    expect(formsInternals.normalizeRequestLikeInput(directRequest)).toBe(directRequest)
    expect(formsInternals.normalizeRequestLikeInput({
      web: {
        request: webRequest,
      },
    })).toBe(webRequest)
    expect(formsInternals.normalizeRequestLikeInput({
      req: nodeRequest,
    })).toBe(nodeRequest)
  })

  it('validates embedded Request instances from request-like inputs', async () => {
    const login = schema({
      email: field.string().required().email(),
    })

    const webResult = await safeParse({
      web: {
        request: new Request('https://app.test/web', {
          method: 'POST',
          body: new URLSearchParams({
            email: 'web@example.com',
          }),
        }),
      },
    }, login)
    expect(webResult.valid).toBe(true)
    if (!webResult.valid) {
      throw new Error('Expected web request validation success.')
    }
    expect(webResult.data.email).toBe('web@example.com')

    const reqResult = await safeParse({
      req: new Request('https://app.test/node', {
        method: 'POST',
        body: new URLSearchParams({
          email: 'node@example.com',
        }),
      }),
    }, login)
    expect(reqResult.valid).toBe(true)
    if (!reqResult.valid) {
      throw new Error('Expected req request validation success.')
    }
    expect(reqResult.data.email).toBe('node@example.com')
  })

  it('validates request-like inputs without request bodies', async () => {
    const login = schema({
      email: field.string().required().email(),
    })

    const getResult = await safeParse({
      method: 'GET',
      path: '/login',
      node: {
        req: {
          method: 'GET',
          headers: {
            host: 'app.test',
          },
          body: new URLSearchParams({
            email: 'ignored@example.com',
          }),
        },
      },
    }, login)
    expect(getResult.valid).toBe(false)
    if (getResult.valid) {
      throw new Error('Expected GET validation failure.')
    }
    expect(getResult.values).toEqual({})

    const postResult = await safeParse({
      method: 'POST',
      path: '/login',
      node: {
        req: {
          method: 'POST',
          headers: {
            host: 'app.test',
          },
        },
      },
    }, login)
    expect(postResult.valid).toBe(false)
    if (postResult.valid) {
      throw new Error('Expected empty POST validation failure.')
    }
    expect(postResult.values).toEqual({})

    const topLevelPostResult = await safeParse({
      method: 'POST',
      path: '/login',
      headers: {
        host: 'app.test',
      },
    }, login)
    expect(topLevelPostResult.valid).toBe(false)
    if (topLevelPostResult.valid) {
      throw new Error('Expected top-level empty POST validation failure.')
    }
    expect(topLevelPostResult.values).toEqual({})
  })

  it('does not treat arbitrary nested request containers as requests', () => {
    expect(formsInternals.normalizeRequestLikeInput({
      req: {
        email: 'ava@example.com',
      },
    })).toBeUndefined()
    expect(formsInternals.normalizeRequestLikeInput({
      web: {
        request: {
          email: 'ava@example.com',
        },
      },
    })).toBeUndefined()
    expect(formsInternals.normalizeRequestLikeInput({
      node: {
        req: {
          email: 'ava@example.com',
        },
      },
    })).toBeUndefined()
    expect(formsInternals.normalizeRequestLikeInput({
      req: {
        headers: {
          email: 'ava@example.com',
        },
      },
    })).toBeUndefined()
  })

  it('marks streamed request-like bodies as duplex requests', async () => {
    const body = {
      async *[Symbol.asyncIterator]() {
        yield new TextEncoder().encode('email=ava@example.com')
      },
    }

    const request = formsInternals.normalizeRequestLikeInput({
      method: 'POST',
      path: '/streamed-login',
      headers: {
        host: 'app.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    })

    expect(request).toBeInstanceOf(Request)
    expect((request as Request & { duplex?: 'half' })?.duplex).toBe('half')
    await expect(request?.text()).resolves.toBe('email=ava@example.com')
  })

  it('normalizes request-like headers, urls, methods, and body variants through the form internals', async () => {
    expect(formsInternals.isRequestLikeHeaders(new Headers())).toBe(true)
    expect(formsInternals.isRequestLikeHeaders([
      ['accept', 'application/json'],
    ])).toBe(true)
    expect(formsInternals.isRequestLikeHeaders({
      host: 'forms.example.test',
    })).toBe(false)
    expect(formsInternals.isRequestLikeHeaders('accept: application/json')).toBe(false)

    const tupleHeaders = formsInternals.normalizeRequestHeaders([
      ['accept', 'application/json'],
      ['x-forwarded-host', 'forms.example.test'],
    ])
    expect(tupleHeaders.get('accept')).toBe('application/json')
    expect(tupleHeaders.get('x-forwarded-host')).toBe('forms.example.test')

    const objectHeaders = formsInternals.normalizeRequestHeaders({
      cookie: ['a=1', 'XSRF-TOKEN=token'],
      'x-forwarded-proto': 'https',
      'x-trace': ['trace-1', 'trace-2'],
      'x-empty': [],
      'x-number': 1 as never,
    })
    expect(objectHeaders.get('cookie')).toBe('a=1; XSRF-TOKEN=token')
    expect(objectHeaders.get('x-trace')).toBe('trace-1,trace-2')
    expect(objectHeaders.has('x-empty')).toBe(false)
    expect(objectHeaders.has('x-number')).toBe(false)

    class ForEachHeaders {
      forEach(callback: (value: string, name: string) => void) {
        callback('application/json', 'accept')
      }
    }

    const forEachHeaders = formsInternals.normalizeRequestHeaders(new ForEachHeaders())
    expect(forEachHeaders.get('accept')).toBe('application/json')

    class EntriesHeaders {
      entries() {
        return [
          ['x-entry', 'yes'],
        ][Symbol.iterator]()
      }
    }

    const entriesHeaders = formsInternals.normalizeRequestHeaders(new EntriesHeaders())
    expect(entriesHeaders.get('x-entry')).toBe('yes')

    class GetOnlyHeaders {
      get(name: string) {
        return name === 'accept' ? 'application/json' : undefined
      }
    }

    expect(() => formsInternals.normalizeRequestHeaders(new GetOnlyHeaders())).toThrow(
      new TypeError('get-only header accessor is not iterable.'),
    )

    const ignoredHeadersRequest = formsInternals.normalizeRequestLikeInput({
      web: {
        request: {
          url: 'https://forms.example.test/web-request',
          method: 'OPTIONS',
        },
      },
      path: '/fallback',
      headers: 42 as never,
    })
    expect(ignoredHeadersRequest?.url).toBe('https://forms.example.test/web-request')
    expect(ignoredHeadersRequest?.method).toBe('OPTIONS')

    const structuredWebRequest = formsInternals.normalizeRequestLikeInput({
      web: {
        request: {
          method: 'POST',
          url: 'https://forms.example.test/web-request-form',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            email: 'ava@example.com',
          }),
        },
      },
    })
    expect(structuredWebRequest?.headers.get('content-type')).toBe('application/x-www-form-urlencoded')
    await expect(structuredWebRequest?.formData()).resolves.toMatchObject({
      get: expect.any(Function),
    })

    const structuredSubmission = await safeParse({
      web: {
        request: {
          method: 'POST',
          url: 'https://forms.example.test/web-request-form',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            email: 'ava@example.com',
          }),
        },
      },
    }, schema({
      email: field.string().required().email(),
    }))
    expect(structuredSubmission.valid).toBe(true)
    if (!structuredSubmission.valid) {
      throw new Error('Expected structured web.request validation to pass.')
    }
    expect(structuredSubmission.data.email).toBe('ava@example.com')

    const formDataBody = new FormData()
    formDataBody.set('email', 'ava@example.com')
    const formDataRequest = formsInternals.normalizeRequestLikeInput({
      method: 'POST',
      path: '/signup',
      headers: {
        host: 'forms.example.test',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'forms.example.test',
      },
      body: formDataBody,
    })
    expect(formDataRequest?.url).toBe('http://forms.example.test/signup')
    expect(formDataRequest?.method).toBe('POST')
    await expect(formDataRequest?.formData()).resolves.toMatchObject({
      get: expect.any(Function),
    })

    const blobRequest = formsInternals.normalizeRequestLikeInput({
      method: 'PATCH',
      url: new URL('https://forms.example.test/profile'),
      headers: new Headers({
        'content-type': 'text/plain',
      }),
      body: new Blob(['patched']),
    })
    await expect(blobRequest?.text()).resolves.toBe('patched')

    const directUrlRequest = formsInternals.normalizeRequestLikeInput({
      method: 'POST',
      url: 'https://forms.example.test/direct',
      body: 'email=ava@example.com',
    })
    expect(directUrlRequest?.url).toBe('https://forms.example.test/direct')

    const fallbackUrlRequest = formsInternals.normalizeRequestLikeInput({
      method: 'POST',
      body: 'email=ava@example.com',
    })
    expect(fallbackUrlRequest?.url).toBe('http://localhost/')

    const defaultMethodRequest = formsInternals.normalizeRequestLikeInput({
      path: '/default-method',
      body: 'ignored',
    })
    expect(defaultMethodRequest?.method).toBe('GET')

    const jsonRequest = formsInternals.normalizeRequestLikeInput({
      req: {
        method: 'PUT',
        url: '/json',
        headers: {
          host: 'forms.example.test',
        },
        body: {
          city: 'Cairo',
        },
      },
    })
    expect(jsonRequest?.headers.get('content-type')).toBe('application/json')
    await expect(jsonRequest?.json()).resolves.toEqual({
      city: 'Cairo',
    })

    const jsonWithContentTypeRequest = formsInternals.normalizeRequestLikeInput({
      method: 'POST',
      path: '/json-custom',
      headers: {
        host: 'forms.example.test',
        'content-type': 'application/vnd.forms+json',
      },
      body: {
        city: 'Giza',
      },
    })
    expect(jsonWithContentTypeRequest?.headers.get('content-type')).toBe('application/vnd.forms+json')
    await expect(jsonWithContentTypeRequest?.json()).resolves.toEqual({
      city: 'Giza',
    })

    const typedArrayRequest = formsInternals.normalizeRequestLikeInput({
      method: 'POST',
      path: '/binary',
      headers: {
        host: 'forms.example.test',
      },
      body: new Uint8Array([65, 66, 67]),
    })
    expect(await typedArrayRequest?.text()).toBe('ABC')

    const arrayBufferRequest = formsInternals.normalizeRequestLikeInput({
      method: 'POST',
      path: '/buffer',
      headers: {
        host: 'forms.example.test',
      },
      body: new Uint8Array([68, 69, 70]).buffer,
    })
    expect(await arrayBufferRequest?.text()).toBe('DEF')

    const stringifiedRequest = formsInternals.normalizeRequestLikeInput({
      node: {
        req: {
          method: 'DELETE',
          url: '/remove',
          headers: {
            host: 'forms.example.test',
          },
          body: 404,
        },
      },
    })
    expect(stringifiedRequest?.method).toBe('DELETE')
    await expect(stringifiedRequest?.text()).resolves.toBe('404')

    const nodeBodyFallbackRequest = formsInternals.normalizeRequestLikeInput({
      node: {
        req: {
          method: 'POST',
          url: '/node-body',
          headers: {
            host: 'forms.example.test',
          },
          pipe() {},
        },
      },
    })
    expect(nodeBodyFallbackRequest?.method).toBe('POST')

    const emptyPostRequest = formsInternals.normalizeRequestLikeInput({
      req: {
        method: 'POST',
        url: '/empty',
        headers: {
          host: 'forms.example.test',
        },
        body: null,
      },
    })
    expect(await emptyPostRequest?.text()).toBe('')

    const headRequest = formsInternals.normalizeRequestLikeInput({
      method: 'HEAD',
      path: '/health',
      body: 'ignored',
    })
    expect(await headRequest?.text()).toBe('')

    const defaultGetRequest = formsInternals.normalizeRequestLikeInput({
      node: {
        req: {
          headers: {
            host: 'forms.example.test',
          },
        },
      },
    })
    expect(defaultGetRequest).toBeUndefined()
    expect(formsInternals.normalizeRequestLikeInput(null)).toBeUndefined()
  })

  it('validates throttled requests only once per submission', async () => {
    let validateCalls = 0

    const base = schema({
      email: field.string().required().email(),
    })
    const login = {
      ...base,
      '~standard': {
        ...base['~standard'],
        async validate(value: unknown) {
          validateCalls += 1
          return await base['~standard'].validate(value)
        },
      },
    } as typeof base

    await configureNativeSecurity()

    const result = await safeParse(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        'x-forwarded-for': '203.0.113.7',
      },
      body: new URLSearchParams({
        email: 'ava@example.com',
      }),
    }), login, {
      throttle: 'login',
    })

    expect(result.valid).toBe(true)
    expect(validateCalls).toBe(1)
  })

  it('answers throttled submissions with the root failure and the field errors from validation', async () => {
    const login = schema({
      email: field.string().required().email(),
    })

    await configureNativeSecurity()

    const firstAttempt = await safeParse(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: 'XSRF-TOKEN=login-token',
        'X-CSRF-TOKEN': 'login-token',
        'x-forwarded-for': '203.0.113.7',
      },
      body: new URLSearchParams({
        email: 'bad',
      }),
    }), login, {
      throttle: 'login',
    })

    expect(firstAttempt.valid).toBe(false)

    const throttled = await safeParse(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: 'XSRF-TOKEN=login-token',
        'X-CSRF-TOKEN': 'login-token',
        'x-forwarded-for': '203.0.113.7',
      },
      body: new URLSearchParams({
        email: 'bad',
      }),
    }), login, {
      throttle: 'login',
    })

    expect(throttled.valid).toBe(false)
    if (throttled.valid) {
      throw new Error('Expected throttled validation failure.')
    }

    expect(throttled.errors.first('email')).toBeDefined()
    expect(throttled.values).toEqual({ email: 'bad' })
    expect(throttled.errors.get('_root')).toEqual(['Too many attempts. Please try again later.'])
    expect(throttled.fail().status).toBe(429)
  })

  it('propagates real rate-limit persistence failures without reporting a validation error', async () => {
    const directory = await configureNativeSecurity()
    await chmod(directory, 0o500)
    try {
      await expect(safeParse(new Request('https://app.test/login', {
        method: 'POST',
        body: new URLSearchParams({ email: 'ava@example.com' }),
      }), schema({ email: field.string().required().email() }), { throttle: 'login' })).rejects.toThrow('EACCES')
    } finally {
      await chmod(directory, 0o700)
    }
  })

  it('rejects malformed submission status codes', () => {
    const login = schema({
      email: field.string().required(),
    })
    const failure = createFailedSubmission(login, {}, {
      email: ['Email is required.'],
    })

    expect(() => failure.fail(99)).toThrow(FormContractError)
    expect(() => failure.success(undefined, 99)).toThrow('HTTP status codes must be integers greater than or equal to 100.')
  })

  it('keeps shared-package boundaries free of framework adapter dependencies', async () => {
    const packageJson = JSON.parse(await import('node:fs/promises').then(module => module.readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    ))) as {
      version?: string
      exports: Record<string, unknown>
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }

    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain('@holo-js/adapter-next')
    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain('@holo-js/adapter-nuxt')
    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain('@holo-js/adapter-sveltekit')
    expect(packageJson.exports).not.toHaveProperty('./client')
    expect(packageJson.exports).not.toHaveProperty('./schema')
    expect(packageJson.exports).toHaveProperty('./internal/client')
    expect(Object.keys(packageJson.devDependencies ?? {})).not.toContain('next')
    expect(Object.keys(packageJson.devDependencies ?? {})).not.toContain('nuxt')
    expect(packageJson.peerDependencies?.['@holo-js/security']).toBe('catalog:')
    expect(packageJson.peerDependenciesMeta?.['@holo-js/security']?.optional).toBe(true)

    const forms = await import('../src')
    expect(forms).not.toHaveProperty('defineSchema')
    expect(forms).not.toHaveProperty('field')
    expect(forms).not.toHaveProperty('schema')
  })
})
