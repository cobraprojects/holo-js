import { afterEach, describe, expect, it } from 'vitest'
import {
  FormContractError,
  createFailedSubmission,
  createSuccessfulSubmission,
  defineSchema,
  field,
  formsInternals,
  isFormSchema,
  schema,
  validate,
} from '../src'

function createSecurityModule() {
  const attempts = new Map<string, number>()

  return {
    csrf: {
      async verify(request: Request) {
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
  delete (globalThis as typeof globalThis & { __holoFormsSecurityModule__?: unknown }).__holoFormsSecurityModule__
})

describe('@holo-js/forms contracts', () => {
  it('creates form schemas from shapes and validation schemas', () => {
    const direct = schema({
      email: field.string().required().email(),
      password: field.string().required().min(8),
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

    const success = await validate({
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

    const failure = await validate({
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

  it('does not coerce plain form objects with request-like field names into Request inputs', async () => {
    const requestMeta = schema({
      method: field.string().required(),
      url: field.string().required(),
      headers: field.string().required(),
      path: field.string().required(),
    })

    const submission = await validate({
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

  it('runs csrf and throttle checks through validate() and returns form-shaped security failures', async () => {
    const login = schema({
      email: field.string().required().email(),
    })

    ;(globalThis as typeof globalThis & { __holoFormsSecurityModule__?: unknown }).__holoFormsSecurityModule__ = createSecurityModule()

    const csrfFailure = await validate(new Request('https://app.test/login', {
      method: 'POST',
      body: new URLSearchParams({
        email: 'ava@example.com',
      }),
    }), login, {
      csrf: true,
    })

    expect(csrfFailure.valid).toBe(false)
    if (csrfFailure.valid) {
      throw new Error('Expected csrf failure.')
    }

    expect(csrfFailure.values).toEqual({
      email: 'ava@example.com',
    })
    expect(csrfFailure.errors.get('_root')).toEqual(['CSRF token mismatch.'])
    expect(csrfFailure.fail()).toEqual({
      ok: false,
      status: 419,
      valid: false,
      values: {
        email: 'ava@example.com',
      },
      errors: {
        _root: ['CSRF token mismatch.'],
      },
    })

    const allowedRequest = new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: 'XSRF-TOKEN=login-token',
        'X-CSRF-TOKEN': 'login-token',
        'x-forwarded-for': '203.0.113.7',
      },
      body: new URLSearchParams({
        email: 'ava@example.com',
      }),
    })

    const firstAllowed = await validate(allowedRequest, login, {
      csrf: true,
      throttle: 'login',
    })
    expect(firstAllowed.valid).toBe(true)

    const differentEmail = await validate(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: 'XSRF-TOKEN=login-token',
        'X-CSRF-TOKEN': 'login-token',
        'x-forwarded-for': '203.0.113.7',
      },
      body: new URLSearchParams({
        email: 'other@example.com',
      }),
    }), login, {
      throttle: 'login',
    })
    expect(differentEmail.valid).toBe(true)

    const throttled = await validate(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: 'XSRF-TOKEN=login-token',
        'X-CSRF-TOKEN': 'login-token',
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
    expect(throttled.fail().status).toBe(429)
  })

  it('merges validation errors with security root failures and requires Request inputs for security-aware validation', async () => {
    const login = schema({
      email: field.string().required().email(),
    })

    ;(globalThis as typeof globalThis & { __holoFormsSecurityModule__?: unknown }).__holoFormsSecurityModule__ = createSecurityModule()

    const failure = await validate(new Request('https://app.test/login', {
      method: 'POST',
      body: new URLSearchParams({
        email: 'bad',
      }),
    }), login, {
      csrf: true,
    })

    expect(failure.valid).toBe(false)
    if (failure.valid) {
      throw new Error('Expected combined failure.')
    }

    expect(failure.errors.first('email')).toBeDefined()
    expect(failure.errors.get('_root')).toEqual(['CSRF token mismatch.'])

    await expect(validate({
      email: 'ava@example.com',
    }, login, {
      csrf: true,
    })).rejects.toThrow('Security-aware validate() options require a Request or request-like event input.')
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
            cookie: 'XSRF-TOKEN=login-token',
            'X-CSRF-TOKEN': 'login-token',
            'x-forwarded-for': '203.0.113.7',
            host: 'app.test',
          },
          body: new URLSearchParams({
            email: 'ava@example.com',
          }),
        },
      },
    }

    const firstAllowed = await validate(event, login, {
      csrf: true,
      throttle: 'login',
    })
    expect(firstAllowed.valid).toBe(true)

    const throttled = await validate(event, login, {
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

  it('preserves cookie semantics for request-like header arrays during csrf validation', async () => {
    const login = schema({
      email: field.string().required().email(),
    })

    ;(globalThis as typeof globalThis & { __holoFormsSecurityModule__?: unknown }).__holoFormsSecurityModule__ = createSecurityModule()

    const submission = await validate({
      method: 'POST',
      path: '/login',
      headers: {
        cookie: [
          'tracking=1',
          'XSRF-TOKEN=login-token',
        ],
        'X-CSRF-TOKEN': 'login-token',
        host: 'app.test',
      },
      body: new URLSearchParams({
        email: 'ava@example.com',
      }),
    }, login, {
      csrf: true,
    })

    expect(submission.valid).toBe(true)
    if (!submission.valid) {
      throw new Error('Expected csrf validation success.')
    }

    expect(submission.data).toEqual({
      email: 'ava@example.com',
    })
  })

  it('reuses embedded Request instances when normalizing request-like inputs', () => {
    const webRequest = new Request('https://app.test/web', {
      method: 'POST',
    })
    const nodeRequest = new Request('https://app.test/node', {
      method: 'PATCH',
    })

    expect(formsInternals.normalizeRequestLikeInput({
      web: {
        request: webRequest,
      },
    })).toBe(webRequest)
    expect(formsInternals.normalizeRequestLikeInput({
      req: nodeRequest,
    })).toBe(nodeRequest)
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
    expect(request?.duplex).toBe('half')
    await expect(request?.text()).resolves.toBe('email=ava@example.com')
  })

  it('falls back to empty values when request inspection cannot be replayed after a security failure', async () => {
    const login = schema({
      email: field.string().required().email(),
    })

    ;(globalThis as typeof globalThis & { __holoFormsSecurityModule__?: unknown }).__holoFormsSecurityModule__ = createSecurityModule()

    const request = new Request('https://app.test/login', {
      method: 'POST',
      body: new URLSearchParams({
        email: 'ava@example.com',
      }),
    })

    await request.text()

    const failure = await validate(request, login, {
      csrf: true,
    })

    expect(failure.valid).toBe(false)
    if (failure.valid) {
      throw new Error('Expected security failure.')
    }

    expect(failure.values).toEqual({})
    expect(failure.errors.flatten()).toEqual({
      _root: ['CSRF token mismatch.'],
    })
    expect(failure.fail()).toEqual({
      ok: false,
      status: 419,
      valid: false,
      values: {},
      errors: {
        _root: ['CSRF token mismatch.'],
      },
    })
  })

  it('preserves existing root validation errors when returning security failures', async () => {
    const base = schema({
      email: field.string().required().email(),
    })
    const login = {
      ...base,
      '~standard': {
        ...base['~standard'],
        async validate(value: unknown) {
          const result = await base['~standard'].validate(value)

          if (result.issues) {
            return result
          }

          return {
            issues: [
              {
                message: 'Passwords do not match.',
              },
            ],
          }
        },
      },
    } as typeof base

    ;(globalThis as typeof globalThis & { __holoFormsSecurityModule__?: unknown }).__holoFormsSecurityModule__ = createSecurityModule()

    const failure = await validate(new Request('https://app.test/login', {
      method: 'POST',
      body: new URLSearchParams({
        email: 'ava@example.com',
      }),
    }), login, {
      csrf: true,
    })

    expect(failure.valid).toBe(false)
    if (failure.valid) {
      throw new Error('Expected combined root failure.')
    }

    expect(failure.errors.get('_root')).toEqual([
      'Passwords do not match.',
      'CSRF token mismatch.',
    ])
    expect(failure.fail().errors._root).toEqual([
      'Passwords do not match.',
      'CSRF token mismatch.',
    ])
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

    const result = await validate(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: 'XSRF-TOKEN=login-token',
        'X-CSRF-TOKEN': 'login-token',
        'x-forwarded-for': '203.0.113.7',
      },
      body: new URLSearchParams({
        email: 'ava@example.com',
      }),
    }), login, {
      csrf: true,
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

    const firstAttempt = await validate(new Request('https://app.test/login', {
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

    const throttled = await validate(new Request('https://app.test/login', {
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

  it('rethrows unexpected security errors from validate()', async () => {
    const login = schema({
      email: field.string().required().email(),
    })

    ;(globalThis as typeof globalThis & { __holoFormsSecurityModule__?: unknown }).__holoFormsSecurityModule__ = {
      csrf: {
        async verify() {
          return undefined
        },
      },
      async rateLimit() {
        throw new Error('security exploded')
      },
    }

    await expect(validate(new Request('https://app.test/login', {
      method: 'POST',
      body: new URLSearchParams({
        email: 'ava@example.com',
      }),
    }), login, {
      throttle: 'login',
    })).rejects.toThrow('security exploded')
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
    ))) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> }

    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain('@holo-js/adapter-next')
    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain('@holo-js/adapter-nuxt')
    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain('@holo-js/adapter-sveltekit')
    expect(Object.keys(packageJson.devDependencies ?? {})).not.toContain('next')
    expect(Object.keys(packageJson.devDependencies ?? {})).not.toContain('nuxt')
    expect(packageJson.peerDependencies?.['@holo-js/security']).toBe('^0.1.2')
    expect(packageJson.peerDependenciesMeta?.['@holo-js/security']?.optional).toBe(true)
  })
})
