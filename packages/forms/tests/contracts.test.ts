import { afterEach, describe, expect, it } from 'vitest'
import {
  FormContractError,
  ValidationException,
  createFailedSubmission,
  createSuccessfulSubmission,
  defineSchema,
  field,
  formsInternals,
  isFormSchema,
  schema,
  safeParse,
  validate,
  type FormFailureErrors,
} from '../src'

type FormsTestGlobal = typeof globalThis & {
  __holoFormsSecurityModule__?: unknown
  __holoFormsNextHeadersImport__?: () => Promise<unknown>
}

function createSecurityModule() {
  const attempts = new Map<string, number>()

  return {
    csrf: {
      async verify(request: Request) {
        if (request.method !== 'GET' && !request.bodyUsed) {
          await request.formData()
        }

        const cookie = request.headers.get('cookie') ?? ''
        const header = request.headers.get('X-CSRF-TOKEN') ?? ''
        const token = cookie
          .split(';')
          .map(segment => segment.trim())
          .find(segment => segment.startsWith('XSRF-TOKEN='))
          ?.slice('XSRF-TOKEN='.length) ?? ''

        if (!token || token !== header) {
          const error = new Error('CSRF token mismatch.') as Error & { status: number }
          error.status = 419
          throw error
        }
      },
    },
    async rateLimit(name: string, options: { readonly request?: Request, readonly values?: Readonly<Record<string, unknown>> }) {
      const request = options.request
      const forwardedFor = request?.headers.get('x-forwarded-for')?.split(',', 1)[0]?.trim() ?? 'unknown'
      const email = typeof options.values?.email === 'string' ? options.values.email : 'guest'
      const key = `${name}:${forwardedFor}:${email}`
      const next = (attempts.get(key) ?? 0) + 1

      attempts.set(key, next)
      if (next > 1) {
        const error = new Error('Too many attempts. Please try again later.') as Error & { status: number }
        error.status = 429
        Object.defineProperties(error, {
          retryAfterSeconds: {
            value: 60,
          },
          snapshot: {
            value: {
              expiresAt: new Date('2026-05-20T12:34:56.000Z'),
            },
          },
        })
        throw error
      }
    },
    getSecurityRuntime() {
      return {
        config: {
          csrf: {
            field: '_token',
            cookie: 'XSRF-TOKEN',
          },
        },
      }
    },
  }
}

afterEach(() => {
  const runtime = globalThis as FormsTestGlobal
  delete runtime.__holoFormsSecurityModule__
  delete runtime.__holoFormsNextHeadersImport__
})

describe('@holo-js/forms contracts', () => {
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
        password: '',
      })
    }
  })

  it('creates form schemas from shapes and validation schemas', () => {
    const direct = schema({
      email: field.string().required().email(),
      password: field.password().required().min(8),
    })
    const nested = schema(defineSchema({
      profile: {
        city: field.string().required(),
      },
    }))

    expect(direct.mode).toBe('form')
    expect(direct.fields.email.definition.rules.map((rule: { name: string }) => rule.name)).toEqual(['required', 'email'])
    expect(nested.fields.profile.city.definition.kind).toBe('string')
    expect(isFormSchema(direct)).toBe(true)
    expect(isFormSchema(defineSchema({ email: field.string() }))).toBe(false)
    expect(isFormSchema(schema({ email: field.string() }))).toBe(true)
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
        email: ['Invalid email: Received "bad"'],
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
        email: ['Invalid email: Received "bad"'],
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

    ;(globalThis as typeof globalThis & { __holoFormsSecurityModule__?: unknown }).__holoFormsSecurityModule__ = createSecurityModule()

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
    expect(throttled.fail()).toMatchObject({
      status: 429,
      retryAfterSeconds: 60,
      retryAt: '2026-05-20T12:34:56.000Z',
    })

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
        retryAt: '2026-05-20T12:34:56.000Z',
      })
    }
  })

  it('requires Request inputs for throttle-aware validation', async () => {
    const login = schema({
      email: field.string().required().email(),
    })

    ;(globalThis as typeof globalThis & { __holoFormsSecurityModule__?: unknown }).__holoFormsSecurityModule__ = createSecurityModule()

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

    ;(globalThis as typeof globalThis & { __holoFormsSecurityModule__?: unknown }).__holoFormsSecurityModule__ = createSecurityModule()

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

    ;(globalThis as typeof globalThis & { __holoFormsSecurityModule__?: unknown }).__holoFormsSecurityModule__ = createSecurityModule()

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

  it('accepts Next server action FormData for security-aware validation', async () => {
    const login = schema({
      email: field.string().required().email(),
    })
    const runtime = globalThis as FormsTestGlobal

    runtime.__holoFormsSecurityModule__ = createSecurityModule()
    runtime.__holoFormsNextHeadersImport__ = async () => ({
      headers: () => new Headers({
        cookie: 'XSRF-TOKEN=login-token',
        'x-forwarded-for': '203.0.113.11',
        host: 'app.test',
        referer: 'https://app.test/login',
        'content-type': 'multipart/form-data; boundary=stale-action-boundary',
        'content-length': '123',
      }),
    })

    const formData = new FormData()
    formData.set('email', 'ava@example.com')

    const firstAllowed = await safeParse(formData, login, {
      throttle: 'login',
    })

    expect(firstAllowed.valid).toBe(true)
    if (!firstAllowed.valid) {
      throw new Error('Expected Next action form validation success.')
    }

    expect(firstAllowed.data).toEqual({
      email: 'ava@example.com',
    })

    const throttled = await safeParse(formData, login, {
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

    runtime.__holoFormsSecurityModule__ = createSecurityModule()
    runtime.__holoFormsNextHeadersImport__ = async () => ({
      headers: () => new Headers({
        'x-forwarded-for': '203.0.113.12',
        'x-forwarded-host': 'forms.example.test',
        'x-forwarded-proto': 'https',
        'content-type': 'multipart/form-data; boundary=stale-action-boundary',
      }),
    })
    const noRefererFormData = new FormData()
    noRefererFormData.set('email', 'noreferer@example.com')
    const noRefererResult = await safeParse(noRefererFormData, login, {
      throttle: 'login',
    })
    expect(noRefererResult.valid).toBe(true)

    runtime.__holoFormsSecurityModule__ = createSecurityModule()
    runtime.__holoFormsNextHeadersImport__ = async () => ({
      headers: () => new Headers({
        host: 'forms.example.test',
        'content-type': 'multipart/form-data; boundary=stale-action-boundary',
      }),
    })
    const hostOnlyFormData = new FormData()
    hostOnlyFormData.set('email', 'hostonly@example.com')
    const hostOnlyResult = await safeParse(hostOnlyFormData, login, {
      throttle: 'login',
    })
    expect(hostOnlyResult.valid).toBe(true)

    runtime.__holoFormsSecurityModule__ = createSecurityModule()
    runtime.__holoFormsNextHeadersImport__ = async () => ({
      headers: () => new Headers({
        'content-type': 'multipart/form-data; boundary=stale-action-boundary',
      }),
    })
    const defaultHostFormData = new FormData()
    defaultHostFormData.set('email', 'default@example.com')
    const defaultHostResult = await safeParse(defaultHostFormData, login, {
      throttle: 'login',
    })
    expect(defaultHostResult.valid).toBe(true)

    runtime.__holoFormsNextHeadersImport__ = async () => ({})
    await expect(safeParse(new FormData(), login, {
      throttle: 'login',
    })).rejects.toThrow('Security-aware safeParse() options require a Request or request-like event input.')
  })

  it('rejects security-aware FormData when ambient Next headers are unavailable', async () => {
    const login = schema({
      email: field.string().required().email(),
    })
    const runtime = globalThis as FormsTestGlobal

    runtime.__holoFormsSecurityModule__ = createSecurityModule()
    runtime.__holoFormsNextHeadersImport__ = async () => ({})

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
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'forms.example.test',
      },
      body: formDataBody,
    })
    expect(formDataRequest?.url).toBe('https://forms.example.test/signup')
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

    ;(globalThis as typeof globalThis & { __holoFormsSecurityModule__?: unknown }).__holoFormsSecurityModule__ = createSecurityModule()

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

  it('merges field errors with throttled security failures without revalidating', async () => {
    const login = schema({
      email: field.string().required().email(),
    })

    ;(globalThis as typeof globalThis & { __holoFormsSecurityModule__?: unknown }).__holoFormsSecurityModule__ = createSecurityModule()

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
    expect(throttled.errors.get('_root')).toEqual(['Too many attempts. Please try again later.'])
    expect(throttled.fail().status).toBe(429)
  })

  it('rethrows unexpected security errors from safeParse()', async () => {
    const login = schema({
      email: field.string().required().email(),
    })

    ;(globalThis as typeof globalThis & { __holoFormsSecurityModule__?: unknown }).__holoFormsSecurityModule__ = {
      async rateLimit() {
        throw new Error('security exploded')
      },
    }

    await expect(safeParse(new Request('https://app.test/login', {
      method: 'POST',
      body: new URLSearchParams({
        email: 'ava@example.com',
      }),
    }), login, {
      throttle: 'login',
    })).rejects.toThrow('security exploded')
  })

  it('returns csrf-like root security failures without rate-limit metadata', async () => {
    const login = schema({
      email: field.string().required().email(),
    })

    ;(globalThis as typeof globalThis & { __holoFormsSecurityModule__?: unknown }).__holoFormsSecurityModule__ = {
      async rateLimit() {
        const error = new Error('CSRF token mismatch.') as Error & { status: number }
        error.status = 419
        throw error
      },
    }

    const result = await safeParse(new Request('https://app.test/login', {
      method: 'POST',
      body: new URLSearchParams({
        email: 'ava@example.com',
      }),
    }), login, {
      throttle: 'login',
    })

    expect(result.valid).toBe(false)
    if (result.valid) {
      throw new Error('Expected csrf-like root failure.')
    }

    const failure = result.fail()
    expect(failure.status).toBe(419)
    expect(failure.errors._root).toEqual(['CSRF token mismatch.'])
    expect('retryAfterSeconds' in failure).toBe(false)
    expect('retryAt' in failure).toBe(false)
  })

  it('revalidates request values when root security errors happen before submission validation is captured', async () => {
    const login = schema({
      email: field.string().required().email(),
    })
    ;(globalThis as typeof globalThis & { __holoFormsSecurityImport__?: () => Promise<unknown> }).__holoFormsSecurityImport__ = async () => {
      const error = new Error('Too many attempts. Please try again later.') as Error & { status: number }
      error.status = 429
      throw error
    }

    const result = await safeParse(new Request('https://app.test/login', {
      method: 'POST',
      body: new URLSearchParams({
        email: 'ava@example.com',
      }),
    }), login, {
      throttle: 'login',
    })

    expect(result.valid).toBe(false)
    if (result.valid) {
      throw new Error('Expected root security failure.')
    }

    expect(result.values).toEqual({
      email: 'ava@example.com',
    })
    expect(result.errors.get('_root')).toEqual(['Too many attempts. Please try again later.'])
    expect(result.fail()).toMatchObject({
      status: 429,
    })
  })

  it('preserves validation errors when root security errors happen before submission validation is captured', async () => {
    const login = schema({
      email: field.string().required().email(),
    })
    ;(globalThis as typeof globalThis & { __holoFormsSecurityImport__?: () => Promise<unknown> }).__holoFormsSecurityImport__ = async () => {
      const error = new Error('Too many attempts. Please try again later.') as Error & { status: number }
      error.status = 429
      throw error
    }

    const result = await safeParse(new Request('https://app.test/login', {
      method: 'POST',
      body: new URLSearchParams({
        email: 'bad',
      }),
    }), login, {
      throttle: 'login',
    })

    expect(result.valid).toBe(false)
    if (result.valid) {
      throw new Error('Expected validation and root security failure.')
    }

    expect(result.values).toEqual({
      email: 'bad',
    })
    expect(result.errors.first('email')).toBeDefined()
    expect(result.errors.get('_root')).toEqual(['Too many attempts. Please try again later.'])
  })

  it('falls back to empty values when security failure revalidation cannot read the request', async () => {
    const login = schema({
      email: field.string().required().email(),
    })

    ;(globalThis as typeof globalThis & { __holoFormsSecurityImport__?: () => Promise<unknown> }).__holoFormsSecurityImport__ = async () => {
      const error = new Error('Too many attempts. Please try again later.') as Error & { status: number }
      error.status = 429
      throw error
    }

    const request = new Request('https://app.test/login', {
      method: 'POST',
      body: new URLSearchParams({
        email: 'ava@example.com',
      }),
    })
    await request.text()

    const result = await safeParse(request, login, {
      throttle: 'login',
    })

    expect(result.valid).toBe(false)
    if (result.valid) {
      throw new Error('Expected root security failure.')
    }

    expect(result.values).toEqual({})
    expect(result.errors.flatten()).toEqual({
      _root: ['Too many attempts. Please try again later.'],
    })
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
    expect(packageJson.exports).toHaveProperty('./internal/client')
    expect(Object.keys(packageJson.devDependencies ?? {})).not.toContain('next')
    expect(Object.keys(packageJson.devDependencies ?? {})).not.toContain('nuxt')
    expect(packageJson.peerDependencies?.['@holo-js/security']).toBe('catalog:')
    expect(packageJson.peerDependenciesMeta?.['@holo-js/security']?.optional).toBe(true)
  })
})
