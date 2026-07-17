import { describe, expect, it } from 'vitest'
import {
  FIELD_KINDS,
  SUPPORTED_RULE_FAMILIES,
  type ValidationSchema,
  ValidationContractError,
  ValidationException,
  createErrorBag,
  DEFAULT_VALIDATION_BAG,
  field,
  isValidationException,
  isValidationSchema,
  parse,
  safeParse,
  schema,
  validate,
  validationInternals,
} from '../src'
import { normalizeFieldBuilder } from '../src/contracts-support'
import { summarizeErrors } from '../src/contracts-runtime'

function objectPrototypeHas(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(Object.prototype, key)
}

describe('@holo-js/validation contracts', () => {
  it('returns validated data from validate and throws validation exceptions for failures', async () => {
    const updatePost = schema({
      title: field.string().required(),
      image: field.file().optional().image('The selected file must be an image.'),
    })

    const data = await validate({
      title: 'Hello',
    }, updatePost)

    expect(data).toEqual({
      title: 'Hello',
      image: undefined,
    })

    await expect(validate({
      title: '',
      image: new Blob(['text'], { type: 'text/plain' }),
    }, updatePost)).rejects.toMatchObject({
      name: 'ValidationException',
      status: 422,
      bag: DEFAULT_VALIDATION_BAG,
    })

    try {
      await validate({
        title: '',
        image: new Blob(['text'], { type: 'text/plain' }),
      }, updatePost, { bag: 'post' })
      throw new Error('Expected validation to fail.')
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationException)
      const exception = error as ValidationException
      expect(exception.bag).toBe('post')
      expect(exception.errors.first('title')).toBe('This field is required.')
      expect(exception.errors.first('image')).toBe('The selected file must be an image.')
      expect(exception.values).toMatchObject({
        title: '',
        image: expect.any(Blob),
      })
      expect(exception.toJSON()).toEqual({
        ok: false,
        status: 422,
        valid: false,
        message: 'title: This field is required.',
        bag: 'post',
        values: {
          title: '',
        },
        errors: {
          title: ['This field is required.'],
          image: ['The selected file must be an image.'],
        },
      })
    }
  })

  it('serializes validation exception values without file objects or non-plain values', () => {
    const exception = ValidationException.withMessages({
      image: ['The selected file must be 2 MB or smaller.'],
    })
    validationInternals.setValidationExceptionValues(exception, {
      title: 'Draft',
      image: new Blob(['large'], { type: 'image/png' }),
      missing: undefined,
      nested: {
        keep: 'value',
        skip: new Date('2026-05-20T00:00:00.000Z'),
      },
      files: [
        new Blob(['large'], { type: 'image/png' }),
        'caption',
      ],
    })

    expect(exception.toJSON().values).toEqual({
      title: 'Draft',
      nested: {
        keep: 'value',
      },
      files: ['caption'],
    })

    const nonPlainValues = Object.create(Date.prototype) as Partial<Record<string, unknown>>
    validationInternals.setValidationExceptionValues(exception, nonPlainValues)
    expect(exception.toJSON().values).toEqual({})
  })

  it('creates manual validation exceptions in the default bag', () => {
    const exception = ValidationException.withMessages({
      image: ['The selected file must be 2 MB or smaller.'],
    })
    const thrown: unknown[] = []

    expect(exception.bag).toBe(DEFAULT_VALIDATION_BAG)
    expect(isValidationException(exception)).toBe(true)
    expect(exception.errors.first('image')).toBe('The selected file must be 2 MB or smaller.')
    expect(validationInternals.parseValidationExceptionDigest(exception)).toEqual({
      ok: false,
      status: 422,
      valid: false,
      message: 'image: The selected file must be 2 MB or smaller.',
      bag: DEFAULT_VALIDATION_BAG,
      errors: {
        image: ['The selected file must be 2 MB or smaller.'],
      },
    })

    validationInternals.setValidationExceptionMetadata(exception, {
      retryAfterSeconds: 30,
      retryAt: '2026-05-20T00:00:00.000Z',
    })
    expect(validationInternals.parseValidationExceptionDigest(exception)).toMatchObject({
      retryAfterSeconds: 30,
      retryAt: '2026-05-20T00:00:00.000Z',
    })

    validationInternals.setValidationExceptionStatus(exception, 429)
    expect(validationInternals.parseValidationExceptionDigest(exception)).toMatchObject({
      status: 429,
      errors: {
        image: ['The selected file must be 2 MB or smaller.'],
      },
    })

    const prefix = exception.digest.slice(0, exception.digest.indexOf(';') + 1)
    const invalidPayload = encodeURIComponent(JSON.stringify({
      ok: false,
      status: 422,
      valid: false,
      message: 'Invalid.',
      bag: DEFAULT_VALIDATION_BAG,
      errors: null,
    }))
    const payloadWithValues = encodeURIComponent(JSON.stringify({
      ok: false,
      status: 422,
      valid: false,
      message: 'title: Invalid.',
      bag: DEFAULT_VALIDATION_BAG,
      values: {
        title: 'a',
      },
      errors: {
        title: ['Invalid.'],
      },
    }))
    expect(validationInternals.parseValidationExceptionDigest('plain-error')).toBeUndefined()
    expect(validationInternals.parseValidationExceptionDigest({ digest: 10 })).toBeUndefined()
    expect(validationInternals.parseValidationExceptionDigest({ digest: 'plain-error' })).toBeUndefined()
    expect(validationInternals.parseValidationExceptionDigest({ digest: `${prefix}${invalidPayload}` })).toBeUndefined()
    expect(validationInternals.parseValidationExceptionDigest({ digest: `${prefix}%` })).toBeUndefined()
    expect(validationInternals.parseValidationExceptionDigest({ digest: `${prefix}${payloadWithValues}` })).toMatchObject({
      values: {
        title: 'a',
      },
    })

    try {
      validationInternals.setValidationExceptionThrower(error => {
        thrown.push(error)
      })
      expect(() => validationInternals.throwValidationException(exception)).toThrow(exception)
      expect(thrown).toEqual([exception])
    } finally {
      validationInternals.setValidationExceptionThrower(undefined)
    }
  })

  it('recognizes serialized-compatible validation exceptions from another module instance', () => {
    const exception = ValidationException.withMessages({
      email: ['Invalid credentials.'],
    })
    class ForeignValidationException extends Error {
      constructor() {
        super(exception.message)
        this.name = exception.name
      }

      toJSON(): unknown {
        return exception.toJSON()
      }
    }
    const crossBundleException = {
      name: exception.name,
      toJSON: () => exception.toJSON(),
    }
    const svelteKitError = {
      status: exception.status,
      body: exception.toJSON(),
    }

    expect(isValidationException(crossBundleException)).toBe(true)
    expect(isValidationException(new ForeignValidationException())).toBe(true)
    expect(isValidationException(exception.toJSON())).toBe(true)
    expect(isValidationException(svelteKitError)).toBe(true)
    expect(isValidationException(null)).toBe(false)
    expect(isValidationException({ name: 'ValidationException' })).toBe(false)
    expect(isValidationException({
      name: 'ValidationException',
      toJSON() {
        throw new Error('Bad serialization.')
      },
    })).toBe(false)
  })

  it('defines schemas, field builders, and rule families', () => {
    const registerUser = schema({
      name: field.string().required().min(3).max(255),
      email: field.string().required().email(),
      password: field.password().required().min(8).confirmed(),
      nationalId: field.string().sensitive().required(),
      newsletter: field.boolean().default(false),
      tags: field.array(field.string().min(1)).optional(),
      profile: {
        city: field.string().required(),
      },
    })

    expect(FIELD_KINDS).toEqual(['string', 'number', 'boolean', 'date', 'file', 'array'])
    expect(SUPPORTED_RULE_FAMILIES).toContain('confirmed')
    expect(registerUser.kind).toBe('schema')
    expect(registerUser['~standard'].version).toBe(1)
    expect(registerUser['~standard'].vendor).toBe('holo-js')
    expect(typeof registerUser['~standard'].validate).toBe('function')
    expect(registerUser.fields.name.definition.rules.map(rule => rule.name)).toEqual(['required', 'min', 'max'])
    expect(registerUser.fields.password.definition.sensitive).toBe(true)
    expect(registerUser.fields.nationalId.definition.sensitive).toBe(true)
    expect(registerUser.fields.tags.definition.item?.kind).toBe('string')
    expect(registerUser.fields.profile.city.definition.kind).toBe('string')
  })

  it('rejects invalid builder declarations and malformed schema shapes', () => {
    expect(() => field.number().min(Number.NaN)).toThrow(ValidationContractError)
    expect(() => field.string().regex('^bad$' as never)).toThrow('regex must be a RegExp instance.')
    expect(() => field.string().in([])).toThrow('in must contain at least one value.')
    expect(() => field.string().required('   ')).toThrow('Custom error messages must not be empty.')
    expect(() => schema({})).toThrow('schema must declare at least one field.')
    expect(() => schema({ broken: '' as never })).toThrow('schema.broken must be a field builder or nested schema object.')
  })

  it('creates error bags with field access, dot-path access, and flattened serialization', () => {
    const errors = createErrorBag<{
      email: string
      profile: {
        city: string
        zip: string
      }
    }>({
      email: ['Email is required.'],
      'profile.city': ['City is required.'],
      'profile.zip': ['ZIP is required.'],
    })

    expect(errors.has('email')).toBe(true)
    expect(errors.has('missing')).toBe(false)
    expect(errors.first('email')).toBe('Email is required.')
    expect(errors.first('missing')).toBeUndefined()
    expect(errors.get('profile.city')).toEqual(['City is required.'])
    expect(errors.email).toEqual(['Email is required.'])
    expect(errors.profile?.city).toEqual(['City is required.'])
    expect(errors.profile?.zip).toEqual(['ZIP is required.'])
    expect(errors.flatten()).toEqual({
      email: ['Email is required.'],
      'profile.city': ['City is required.'],
      'profile.zip': ['ZIP is required.'],
    })
    expect(errors.toJSON()).toEqual(errors.flatten())
  })

  it('rejects unsafe error paths without mutating Object.prototype', () => {
    Reflect.deleteProperty(Object.prototype, 'polluted')

    try {
      for (const path of ['__proto__.polluted', 'constructor.prototype.polluted', 'profile.prototype.polluted']) {
        expect(() => createErrorBag({ [path]: ['blocked'] })).toThrow(ValidationContractError)
      }

      expect(objectPrototypeHas('polluted')).toBe(false)
    } finally {
      Reflect.deleteProperty(Object.prototype, 'polluted')
    }
  })

  it('validates plain objects and applies coercion, defaults, and inferred nested output', async () => {
    const registerUser = schema({
      name: field.string().required().min(3),
      email: field.string().required().email(),
      age: field.number().integer().optional(),
      newsletter: field.boolean().default(false),
      tags: field.array(field.string().min(1)).optional(),
      password: field.password().required().min(8).confirmed(),
      passwordConfirmation: field.password().required(),
      profile: {
        city: field.string().required(),
      },
    })

    const result = await safeParse({
      name: 'Ava',
      email: 'ava@example.com',
      age: '42',
      tags: ['admin', 'editor'],
      password: 'supersecret',
      passwordConfirmation: 'supersecret',
      profile: {
        city: 'Cairo',
      },
    }, registerUser)

    expect(result.valid).toBe(true)
    if (!result.valid) {
      throw new Error('Expected validation success.')
    }

    expect(result.data).toEqual({
      name: 'Ava',
      email: 'ava@example.com',
      age: 42,
      newsletter: false,
      tags: ['admin', 'editor'],
      password: 'supersecret',
      passwordConfirmation: 'supersecret',
      profile: {
        city: 'Cairo',
      },
    })

    await expect(parse({
      name: 'Ava',
      email: 'ava@example.com',
      age: '42',
      password: 'supersecret',
      passwordConfirmation: 'supersecret',
      profile: { city: 'Cairo' },
    }, registerUser)).resolves.toMatchObject({
      age: 42,
      newsletter: false,
    })
  })

  it('returns flattened errors for schema, required, integer, and confirmation failures', async () => {
    const registerUser = schema({
      name: field.string().required().min(3),
      email: field.string().required().email(),
      age: field.number().integer().optional(),
      password: field.password().required().min(8).confirmed(),
      passwordConfirmation: field.password().required(),
      profile: {
        city: field.string().required(),
      },
    })

    const result = await safeParse({
      name: '   ',
      email: 'bad',
      age: '4.2',
      password: 'supersecret',
      passwordConfirmation: 'mismatch',
      profile: {
        city: '',
      },
    }, registerUser)

    expect(result.valid).toBe(false)
    if (result.valid) {
      throw new Error('Expected validation failure.')
    }

    expect(result.errors.first('name')).toBe('This field is required.')
    expect(result.errors.has('email')).toBe(true)
    expect(result.errors.has('age')).toBe(true)
    expect(result.errors.first('password')).toBe('This field does not match its confirmation.')
    expect(result.errors.first('profile.city')).toBe('This field is required.')
    expect((await safeParse({
      name: 'Ava',
      email: 'ava@example.com',
      age: '42',
      password: 'supersecret',
      passwordConfirmation: 'supersecret',
    }, registerUser)).errors.first('profile.city')).toBe('This field is required.')

    await expect(parse({
      name: '',
      email: 'bad',
      password: 'supersecret',
      passwordConfirmation: 'nope',
      profile: {
        city: '',
      },
    }, registerUser)).rejects.toThrow(/email|name|password|profile\.city/)
  })

  it('parses FormData, URLSearchParams, and Request inputs using web-native semantics', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
      age: field.number().integer().optional(),
      newsletter: field.boolean().default(false),
      tags: field.array(field.string().required()).optional(),
      profile: {
        city: field.string().required(),
      },
    })

    const formData = new FormData()
    formData.append('email', 'ava@example.com')
    formData.append('age', '18')
    formData.append('newsletter', 'on')
    formData.append('tags[]', 'admin')
    formData.append('tags[]', 'editor')
    formData.append('profile.city', 'Cairo')

    const formDataResult = await safeParse(formData, registerUser)
    expect(formDataResult.valid).toBe(true)
    if (formDataResult.valid) {
      expect(formDataResult.data.newsletter).toBe(true)
      expect(formDataResult.data.tags).toEqual(['admin', 'editor'])
      expect(formDataResult.data.age).toBe(18)
    }

    const searchParams = new URLSearchParams()
    searchParams.set('email', 'ava@example.com')
    searchParams.set('age', '21')
    searchParams.set('profile.city', 'Alexandria')

    const searchResult = await safeParse(searchParams, registerUser)
    expect(searchResult.valid).toBe(true)
    if (searchResult.valid) {
      expect(searchResult.data.age).toBe(21)
      expect(searchResult.data.newsletter).toBe(false)
    }

    const jsonRequest = new Request('https://example.com/register', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: 'ava@example.com',
        age: '33',
        profile: {
          city: 'Giza',
        },
      }),
    })

    const requestResult = await safeParse(jsonRequest, registerUser)
    expect(requestResult.valid).toBe(true)
    if (requestResult.valid) {
      expect(requestResult.data.age).toBe(33)
    }
  })

  it('rejects unsafe FormData and URLSearchParams paths without mutating Object.prototype', async () => {
    const s = schema({ ok: field.string().optional() })

    Reflect.deleteProperty(Object.prototype, 'polluted')

    try {
      const formData = new FormData()
      formData.append('__proto__.polluted', 'yes')
      await expect(safeParse(formData, s)).rejects.toThrow(ValidationContractError)

      const searchParams = new URLSearchParams()
      searchParams.append('constructor.prototype.polluted', 'yes')
      expect(() => validationInternals.normalizeFormData(searchParams)).toThrow(ValidationContractError)

      expect(objectPrototypeHas('polluted')).toBe(false)
    } finally {
      Reflect.deleteProperty(Object.prototype, 'polluted')
    }
  })

  it('validates nested shapes with async field schemas', async () => {
    const nestedSchema = schema({
      profile: {
        tags: field.array(field.string()).required(),
        bio: field.string().optional(),
      },
    })

    const success = await safeParse({
      profile: { tags: ['a'], bio: 'hello' },
    }, nestedSchema)

    expect(success.valid).toBe(true)
    if (success.valid) {
      expect(success.data.profile.tags).toEqual(['a'])
    }

    const failure = await safeParse({
      profile: { tags: [] },
    }, nestedSchema)

    expect(failure.valid).toBe(false)
    if (!failure.valid) {
      expect(failure.errors.first('profile.tags')).toBe('This field is required.')
    }
  })

  it('applies post-validation rules to array elements', async () => {
    const memberSchema = schema({
      tags: field.array(
        field.string()
          .required()
          .custom(value => value !== 'blocked' || 'Blocked tag.'),
      ).required(),
    })

    const missingValue = await safeParse({
      tags: [''],
    }, memberSchema)
    expect(missingValue.valid).toBe(false)
    if (!missingValue.valid) {
      expect(missingValue.errors.first('tags.0')).toBe('This field is required.')
    }

    const customFailure = await safeParse({
      tags: ['blocked'],
    }, memberSchema)
    expect(customFailure.valid).toBe(false)
    if (!customFailure.valid) {
      expect(customFailure.errors.first('tags.0')).toBe('Blocked tag.')
    }
  })

  it('applies post-validation rules to nested array elements', async () => {
    const memberSchema = schema({
      matrix: field.array(
        field.array(
          field.string()
            .required()
            .custom(value => value !== 'blocked' || 'Blocked cell.'),
        ),
      ).required(),
    })

    const missingValue = await safeParse({
      matrix: [['']],
    }, memberSchema)
    expect(missingValue.valid).toBe(false)
    if (!missingValue.valid) {
      expect(missingValue.errors.first('matrix.0.0')).toBe('This field is required.')
    }

    const customFailure = await safeParse({
      matrix: [['blocked']],
    }, memberSchema)
    expect(customFailure.valid).toBe(false)
    if (!customFailure.valid) {
      expect(customFailure.errors.first('matrix.0.0')).toBe('Blocked cell.')
    }

    const success = await safeParse({
      matrix: [['allowed']],
    }, memberSchema)
    expect(success.valid).toBe(true)
    if (success.valid) {
      expect(success.data.matrix).toEqual([['allowed']])
    }
  })

  it('validates arrays of nested objects from form data', async () => {
    const landing = schema({
      items: field.array({
        title: field.string().required(),
        caption: field.string().optional(),
      }).required(),
    })

    const formData = new FormData()
    formData.set('items[0].title', 'Operations')
    formData.set('items[0].caption', 'Industry Solutions')
    formData.set('items[1].title', 'Retail')

    const success = await safeParse(formData, landing)

    expect(success.valid).toBe(true)
    if (success.valid) {
      expect(success.data.items).toEqual([
        { title: 'Operations', caption: 'Industry Solutions' },
        { title: 'Retail', caption: undefined },
      ])
    }

    const invalidFormData = new FormData()
    invalidFormData.set('items[0].caption', 'Missing title')

    const failure = await safeParse(invalidFormData, landing)

    expect(failure.valid).toBe(false)
    if (!failure.valid) {
      expect(failure.errors.first('items.0.title')).toBe('This field is required.')
    }
  })

  it('infers and returns shape-changing transform output', async () => {
    const nameSchema = schema({
      nameLength: field.string().required().transform(value => value.length),
    })
    const defaultNameSchema = schema({
      nameLength: field.string().default('Ava').transform(value => value.length),
    })

    const parsed = await parse({
      nameLength: 'Ava',
    }, nameSchema)
    expect(parsed.nameLength).toBe(3)

    const defaultParsed = await parse({}, defaultNameSchema)
    expect(defaultParsed.nameLength).toBe(3)

    const result = await safeParse({
      nameLength: 'Lina',
    }, nameSchema)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.data.nameLength).toBe(4)
      expect(typeof result.data.nameLength).toBe('number')
    }
  })

  it('validates file fields, image requirements, and max size rules', async () => {
    const uploadAvatar = schema({
      avatar: field.file().required().image().maxSize('1kb'),
    })

    const image = new File([new Uint8Array(128)], 'avatar.png', { type: 'image/png' })
    const text = new File([new Uint8Array(2048)], 'notes.txt', { type: 'text/plain' })

    const success = await safeParse({ avatar: image }, uploadAvatar)
    expect(success.valid).toBe(true)

    const failure = await safeParse({ avatar: text }, uploadAvatar)
    expect(failure.valid).toBe(false)
    if (!failure.valid) {
      expect(failure.errors.first('avatar')).toBe('The selected file must be an image.')
      expect(failure.errors.get('avatar')).toContain('The selected file must be 1 KB or smaller.')
    }
  })

  it('uses friendly default max validation messages', async () => {
    const maxSchema = schema({
      title: field.string().required().max(5),
      subtitle: field.string().required().max(1),
      age: field.number().required().max(120),
      tags: field.array(field.string()).required().max(2),
      flags: field.array(field.string()).required().max(1),
      image: field.file().required().maxSize('2mb'),
      icon: field.file().required().maxSize(1),
    })

    const result = await safeParse({
      title: 'Too long',
      subtitle: 'AB',
      age: 121,
      tags: ['a', 'b', 'c'],
      flags: ['a', 'b'],
      image: new File([new Uint8Array((2 * 1024 * 1024) + 1)], 'large.png', { type: 'image/png' }),
      icon: new File([new Uint8Array(2)], 'icon.png', { type: 'image/png' }),
    }, maxSchema)

    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errors.first('title')).toBe('This field must be 5 characters or fewer.')
      expect(result.errors.first('subtitle')).toBe('This field must be 1 character or fewer.')
      expect(result.errors.first('age')).toBe('This field must be 120 or less.')
      expect(result.errors.first('tags')).toBe('This field must contain 2 items or fewer.')
      expect(result.errors.first('flags')).toBe('This field must contain 1 item or fewer.')
      expect(result.errors.first('image')).toBe('The selected file must be 2 MB or smaller.')
      expect(result.errors.first('icon')).toBe('The selected file must be 1 byte or smaller.')
    }
  })

  it('uses friendly default messages for built-in validation rules', async () => {
    const builtInSchema = schema({
      textType: field.string().required(),
      numberType: field.number().required(),
      booleanType: field.boolean().required(),
      dateType: field.date().required(),
      fileType: field.file().required(),
      email: field.string().required().email(),
      url: field.string().required().url(),
      uuid: field.string().required().uuid(),
      integer: field.number().required().integer(),
      pattern: field.string().required().regex(/^[A-Z]+$/),
      choice: field.string().required().in(['yes']),
      shortText: field.string().required().min(3),
      smallNumber: field.number().required().min(10),
      shortList: field.array(field.string()).required().min(2),
      exactText: field.string().required().size(3),
      exactNumber: field.number().required().size(10),
      exactList: field.array(field.string()).required().size(2),
      exactFile: field.file().required().size(1),
    })

    const result = await safeParse({
      textType: 10,
      numberType: 'abc',
      booleanType: 'maybe',
      dateType: 'not-a-date',
      fileType: 'not-a-file',
      email: 'not-email',
      url: 'not-url',
      uuid: 'not-uuid',
      integer: 1.2,
      pattern: 'abc',
      choice: 'no',
      shortText: 'ab',
      smallNumber: 9,
      shortList: ['one'],
      exactText: 'abcd',
      exactNumber: 9,
      exactList: ['one'],
      exactFile: new File([new Uint8Array(2)], 'two-bytes.txt', { type: 'text/plain' }),
    }, builtInSchema)

    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errors.first('textType')).toBe('This field must be text.')
      expect(result.errors.first('numberType')).toBe('This field must be a number.')
      expect(result.errors.first('booleanType')).toBe('This field must be true or false.')
      expect(result.errors.first('dateType')).toBe('This field must be a valid date.')
      expect(result.errors.first('fileType')).toBe('The selected file must be a file.')
      expect(result.errors.first('email')).toBe('This field must be a valid email address.')
      expect(result.errors.first('url')).toBe('This field must be a valid URL.')
      expect(result.errors.first('uuid')).toBe('This field must be a valid UUID.')
      expect(result.errors.first('integer')).toBe('This field must be an integer.')
      expect(result.errors.first('pattern')).toBe('This field format is invalid.')
      expect(result.errors.first('choice')).toBe('This field must be one of the allowed values.')
      expect(result.errors.first('shortText')).toBe('This field must be at least 3 characters.')
      expect(result.errors.first('smallNumber')).toBe('This field must be 10 or greater.')
      expect(result.errors.first('shortList')).toBe('This field must contain at least 2 items.')
      expect(result.errors.first('exactText')).toBe('This field must be exactly 3 characters.')
      expect(result.errors.first('exactNumber')).toBe('This field must be exactly 10.')
      expect(result.errors.first('exactList')).toBe('This field must contain exactly 2 items.')
      expect(result.errors.first('exactFile')).toBe('The selected file must be exactly 1 byte.')
    }
  })

  it('treats empty optional file inputs as missing files', async () => {
    const postSchema = schema({
      image: field.file().optional().image('The selected file must be an image.').maxSize('2mb', 'The selected file must be 2 MB or smaller.'),
    })
    const formData = new FormData()
    formData.set('image', new File([], '', { type: 'application/octet-stream' }))

    const result = await safeParse(formData, postSchema)

    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.data.image).toBeUndefined()
    }

    const unnamedEmptyFile = await safeParse({
      image: { size: 0, type: 'application/octet-stream' },
    }, postSchema)
    expect(unnamedEmptyFile.valid).toBe(true)
    if (unnamedEmptyFile.valid) {
      expect(unnamedEmptyFile.data.image).toBeUndefined()
    }

    const transportedEmptyFile = await safeParse({
      image: new File([], 'blob', { type: 'application/octet-stream' }),
    }, postSchema)
    expect(transportedEmptyFile.valid).toBe(true)
    if (transportedEmptyFile.valid) {
      expect(transportedEmptyFile.data.image).toBeUndefined()
    }

    const zeroByteNamedFile = new File([], 'empty.png', { type: 'image/png' })
    const namedFile = await safeParse({ image: zeroByteNamedFile }, postSchema)
    expect(namedFile.valid).toBe(true)
    if (namedFile.valid) {
      expect(namedFile.data.image).toBe(zeroByteNamedFile)
    }
  })

  it('supports custom and async custom rules', async () => {
    const userSchema = schema({
      username: field.string()
        .required()
        .custom(value => value !== 'taken' || 'Username is already taken.')
        .customAsync(async value => value !== 'blocked' || 'Username is blocked.'),
    })

    const blocked = await safeParse({ username: 'blocked' }, userSchema)
    expect(blocked.valid).toBe(false)
    if (!blocked.valid) {
      expect(blocked.errors.first('username')).toBe('Username is blocked.')
    }

    const available = await safeParse({ username: 'available' }, userSchema)
    expect(available.valid).toBe(true)
  })

  it('runs custom and confirmed post rules against rule-order values around transforms', async () => {
    const beforeTransformValues: unknown[] = []
    const afterTransformValues: unknown[] = []
    const customBeforeTransform = schema({
      value: field.string()
        .required()
        .custom(value => {
          beforeTransformValues.push(value)
          return value.startsWith('A') || 'Name must start with A.'
        })
        .transform(value => value.length),
    })
    const customAfterTransform = schema({
      value: field.string()
        .required()
        .transform(value => value.length)
        .custom(value => {
          afterTransformValues.push(value)
          return value === 3 || 'Name must be 3 characters.'
        }),
    })
    const confirmedBeforeTransform = schema({
      password: field.string()
        .required()
        .confirmed()
        .transform(value => value.length),
    })
    const confirmedAfterTransform = schema({
      password: field.string()
        .required()
        .transform(value => value.trim())
        .confirmed(),
    })
    const confirmedFromOutputParent = schema({
      passwordConfirmation: field.string().required(),
      password: field.string()
        .required()
        .transform(value => value.trim())
        .confirmed(),
    })

    const beforeSuccess = await safeParse({ value: 'Ava' }, customBeforeTransform)
    expect(beforeSuccess.valid).toBe(true)
    if (beforeSuccess.valid) {
      expect(beforeSuccess.data.value).toBe(3)
    }
    expect(beforeTransformValues).toEqual(['Ava'])

    const beforeFailure = await safeParse({ value: 'Mia' }, customBeforeTransform)
    expect(beforeFailure.valid).toBe(false)
    if (!beforeFailure.valid) {
      expect(beforeFailure.errors.first('value')).toBe('Name must start with A.')
    }

    const afterSuccess = await safeParse({ value: 'Ivy' }, customAfterTransform)
    expect(afterSuccess.valid).toBe(true)
    if (afterSuccess.valid) {
      expect(afterSuccess.data.value).toBe(3)
    }
    expect(afterTransformValues).toEqual([3])

    const afterFailure = await safeParse({ value: 'Lina' }, customAfterTransform)
    expect(afterFailure.valid).toBe(false)
    if (!afterFailure.valid) {
      expect(afterFailure.errors.first('value')).toBe('Name must be 3 characters.')
    }

    const confirmedSuccess = await safeParse({
      password: 'secret',
      passwordConfirmation: 'secret',
    }, confirmedBeforeTransform)
    expect(confirmedSuccess.valid).toBe(true)
    if (confirmedSuccess.valid) {
      expect(confirmedSuccess.data.password).toBe(6)
    }

    const confirmedFailure = await safeParse({
      password: 'secret',
      passwordConfirmation: 'different',
    }, confirmedBeforeTransform)
    expect(confirmedFailure.valid).toBe(false)
    if (!confirmedFailure.valid) {
      expect(confirmedFailure.errors.first('password')).toBe('This field does not match its confirmation.')
    }

    const outputParentSuccess = await safeParse({
      password: ' secret ',
      passwordConfirmation: 'secret',
    }, confirmedFromOutputParent)
    expect(outputParentSuccess.valid).toBe(true)

    expect(objectPrototypeHas('passwordConfirmation')).toBe(false)
    Object.defineProperty(Object.prototype, 'passwordConfirmation', {
      value: 'prototype-secret',
      configurable: true,
    })
    try {
      const transformedConfirmedSuccess = await safeParse({
        password: ' secret ',
        passwordConfirmation: 'secret',
      }, confirmedAfterTransform)
      expect(transformedConfirmedSuccess.valid).toBe(true)
      if (transformedConfirmedSuccess.valid) {
        expect(transformedConfirmedSuccess.data.password).toBe('secret')
      }
    } finally {
      Reflect.deleteProperty(Object.prototype, 'passwordConfirmation')
    }
    expect(objectPrototypeHas('passwordConfirmation')).toBe(false)
  })

  it('supports custom messages for built-in rules', async () => {
    const login = schema({
      email: field.string()
        .required('Email is mandatory.')
        .email('Please enter a valid email address.'),
      password: field.password()
        .min(8, 'Password must be at least 8 characters.'),
      avatar: field.file()
        .image('Avatar must be an image file.')
        .maxSize('1kb', 'Avatar must be smaller than 1kb.'),
      publishedAt: field.date()
        .beforeOrToday('Publish date cannot be in the future.'),
    })

    const result = await safeParse({
      email: 'bad',
      password: 'short',
      avatar: new File([new Uint8Array(2048)], 'avatar.txt', { type: 'text/plain' }),
      publishedAt: new Date(Date.now() + 86400000).toISOString(),
    }, login)

    expect(result.valid).toBe(false)
    if (result.valid) {
      throw new Error('Expected validation failure.')
    }

    expect(result.errors.first('email')).toBe('Please enter a valid email address.')
    expect(result.errors.first('password')).toBe('Password must be at least 8 characters.')
    expect(result.errors.get('avatar')).toContain('Avatar must be an image file.')
    expect(result.errors.get('avatar')).toContain('Avatar must be smaller than 1kb.')
    expect(result.errors.first('publishedAt')).toBe('Publish date cannot be in the future.')

    const missing = await safeParse({
      email: '',
      password: 'supersecret',
      avatar: new File([new Uint8Array(10)], 'avatar.png', { type: 'image/png' }),
      publishedAt: new Date().toISOString(),
    }, login)

    expect(missing.valid).toBe(false)
    if (!missing.valid) {
      expect(missing.errors.first('email')).toBe('Email is mandatory.')
    }
  })

  it('supports date comparison rules and today-based aliases', async () => {
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)

    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)

    const eventSchema = schema({
      publishedAt: field.date().required().before(tomorrow).after(yesterday),
      archivedAt: field.date().optional().beforeOrEqual(tomorrow).afterOrEqual(yesterday),
      expiresAt: field.date().todayOrAfter(),
      openedAt: field.date().beforeOrToday(),
      checkedAt: field.date().today(),
    })

    const success = await safeParse({
      publishedAt: new Date().toISOString(),
      archivedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
      openedAt: new Date().toISOString(),
      checkedAt: new Date().toISOString(),
    }, eventSchema)

    expect(success.valid).toBe(true)

    const failure = await safeParse({
      publishedAt: tomorrow.toISOString(),
      archivedAt: yesterday.toISOString(),
      expiresAt: yesterday.toISOString(),
      openedAt: tomorrow.toISOString(),
      checkedAt: tomorrow.toISOString(),
    }, eventSchema)

    expect(failure.valid).toBe(false)
    if (!failure.valid) {
      expect(failure.errors.first('publishedAt')).toContain('before')
      expect(failure.errors.first('expiresAt')).toBe('This field must be today or after.')
      expect(failure.errors.first('openedAt')).toBe('This field must be today or before.')
      expect(failure.errors.first('checkedAt')).toBe('This field must be today.')
    }
  })

  it('exposes Standard Schema V1 on field builders for single-value validation', async () => {
    const emailField = field.string().required().email()

    expect(emailField['~standard'].version).toBe(1)
    expect(emailField['~standard'].vendor).toBe('holo-js')

    const success = await emailField['~standard'].validate('ava@example.com')
    expect('value' in success).toBe(true)
    if ('value' in success) {
      expect(success.value).toBe('ava@example.com')
    }

    const failure = await emailField['~standard'].validate('bad')
    expect('issues' in failure && failure.issues).toBeDefined()
    if ('issues' in failure && failure.issues) {
      expect(failure.issues.length).toBeGreaterThan(0)
    }
  })

  it('exposes Standard Schema V1 on object schemas', async () => {
    const registerUser = schema({
      email: field.string().required().email(),
      age: field.number().integer().optional(),
    })

    const success = await registerUser['~standard'].validate({
      email: 'ava@example.com',
      age: 42,
    })
    expect('value' in success).toBe(true)

    const failure = await registerUser['~standard'].validate({
      email: 'bad',
    })
    expect('issues' in failure && failure.issues).toBeDefined()
  })

  it('locks helper internals', () => {
    expect(validationInternals.parseByteSize('2mb')).toBe(2 * 1024 * 1024)
    expect(validationInternals.normalizeIssuePath({
      path: [{ key: 'profile' }, { key: 'city' }],
    })).toBe('profile.city')
  })

  it('keeps shared-package boundaries free of framework adapter dependencies', async () => {
    const packageJson = JSON.parse(await import('node:fs/promises').then(module => module.readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    ))) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain('@holo-js/adapter-next')
    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain('@holo-js/adapter-nuxt')
    expect(Object.keys(packageJson.dependencies ?? {})).not.toContain('@holo-js/adapter-sveltekit')
    expect(Object.keys(packageJson.devDependencies ?? {})).not.toContain('nuxt')
    expect(validationInternals.isPlainObject({ ok: true })).toBe(true)
  })
})
