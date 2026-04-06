import { describe, expect, it } from 'vitest'
import {
  FormContractError,
  createFailedSubmission,
  createSuccessfulSubmission,
  defineSchema,
  field,
  isFormSchema,
  schema,
  validate,
} from '../src'

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
    expect(direct.fields.email.definition.rules.map(rule => rule.name)).toEqual(['required', 'email'])
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
    ))) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain('@holo-js/adapter-next')
    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain('@holo-js/adapter-nuxt')
    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain('@holo-js/adapter-sveltekit')
    expect(Object.keys(packageJson.devDependencies ?? {})).not.toContain('next')
    expect(Object.keys(packageJson.devDependencies ?? {})).not.toContain('nuxt')
  })
})
