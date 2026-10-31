import { describe, expect, it } from 'vitest'
import { field, safeParse, schema, validate, ValidationContractError, ValidationException, type FieldBuilderInput } from '../src'

const rules = ['digits', 'minDigits', 'maxDigits'] as const

describe('numeric digit constraints', () => {
  it.each([
    [12, false, false, true],
    [123, true, true, true],
    [1234, false, true, false],
    [0, false, false, true],
    [-123, false, false, false],
    [12.3, false, false, false],
    [1e-7, false, false, false],
    [Number.NaN, false, false, false],
    [Number.POSITIVE_INFINITY, false, false, false],
    [Number.NEGATIVE_INFINITY, false, false, false],
  ])('checks independent digit constraints for %s', async (value, exact, minimum, maximum) => {
    const results = await Promise.all(rules.map(name => safeParse({ value }, schema({ value: field.number()[name](3) }))))
    expect(results.map(result => result.valid)).toEqual([exact, minimum, maximum])
  })

  it.each([
    [0, 1],
    [-0, 1],
    [1e3, 4],
    [999999999999999, 15],
    [1e15, 16],
    [1e21, 22],
    [1e23, 24],
    [Number.MAX_VALUE, 309],
  ])('counts the decimal magnitude of %s as %s digits', async (value, count) => {
    const validator = field.number().digits(count)
    expect(await validator['~standard'].validate(value)).toEqual({ value })
    expect((await field.number().digits(count + 1)['~standard'].validate(value)).issues).toBeDefined()
  })

  it('keeps strict numeric parsing and returns numbers from request and Standard Schema inputs', async () => {
    const definition = schema({ value: field.number().digits(3) })
    expect(await validate(new URLSearchParams({ value: '123' }), definition)).toEqual({ value: 123 })
    expect(await definition['~standard'].validate({ value: '1.23e2' })).toEqual({ value: { value: 123 } })
    for (const value of ['123abc', 'Infinity', 'NaN', '12.3', '-123', '']) {
      expect((await safeParse({ value }, definition)).valid).toBe(false)
    }
    await expect(validate({ value: 12 }, definition)).rejects.toBeInstanceOf(ValidationException)
  })

  it.each(rules)('retains optional, nullable and default behavior for %s', async (name) => {
    const definition = schema({
      optional: field.number()[name](3).optional(),
      nullable: field.number().nullable()[name](3),
      defaulted: field.number()[name](3).default(123),
    })
    expect(await validate({ nullable: null }, definition)).toEqual({ optional: undefined, nullable: null, defaulted: 123 })
    expect((await safeParse({ optional: 12.3, nullable: -123 }, definition)).valid).toBe(false)
    expect((await safeParse({}, schema({ value: field.number()[name](3) }))).valid).toBe(false)
  })

  it('applies zero and very large limits literally', async () => {
    for (const value of [0, 1, 123]) {
      const results = await Promise.all(rules.map(name => safeParse({ value }, schema({ value: field.number()[name](0) }))))
      expect(results.map(result => result.valid)).toEqual([false, true, false])
    }
    const limit = Number.MAX_SAFE_INTEGER
    const results = await Promise.all(rules.map(name => safeParse({ value: 123 }, schema({ value: field.number()[name](limit) }))))
    expect(results.map(result => result.valid)).toEqual([false, false, true])
  })

  it('preserves every authored constraint, message and transform position', async () => {
    const definition = schema({ value: field.number()
      .min(200, 'Value too small.')
      .digits(3, 'ثلاثة أرقام')
      .minDigits(4, 'More digits.')
      .maxDigits(2, 'Fewer digits.')
      .digits(5, 'Five digits.') })
    const result = await safeParse({ value: 12 }, definition)
    expect(result.errors.get('value')).toEqual(['Value too small.', 'ثلاثة أرقام', 'More digits.', 'Five digits.'])
    const transformed = schema({ value: field.number().digits(2).transform(value => value * 10).digits(3).max(150) })
    expect(await validate({ value: 12 }, transformed)).toEqual({ value: 120 })
    expect((await safeParse({ value: 20 }, transformed)).errors.get('value')).toEqual(['This field must be 150 or less.'])
  })

  it.each(rules)('rejects invalid %s declarations and non-number fields', (name) => {
    for (const count of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => field.number()[name](count)).toThrow(ValidationContractError)
    }
    for (const count of ['3', null, undefined]) {
      const builder = field.number()
      expect(() => Reflect.apply(builder[name], builder, [count])).toThrow(ValidationContractError)
    }
    expect(() => field.string()[name](3)).toThrow(ValidationContractError)
    expect(() => field.number()[name](3, ' ')).toThrow(ValidationContractError)
  })

  it('reports the default messages with singular and plural digits', async () => {
    const definition = schema({
      exact: field.number().digits(1),
      minimum: field.number().minDigits(2),
      maximum: field.number().maxDigits(1),
    })
    const result = await safeParse({ exact: 12, minimum: 1, maximum: 12 }, definition)
    expect(result.errors.flatten()).toEqual({
      exact: ['This field must have exactly 1 digit.'],
      minimum: ['This field must have at least 2 digits.'],
      maximum: ['This field must have at most 1 digit.'],
    })
  })

  it('validates serialized field rules through the public schema path', async () => {
    const original = field.number().digits(3, 'Three digits.').minDigits(2).maxDigits(4)
    const restored: FieldBuilderInput<number> = { field: JSON.parse(JSON.stringify(original.field)) as typeof original.field }
    const definition = schema({ value: restored })
    expect(await validate({ value: 123 }, definition)).toEqual({ value: 123 })
    expect((await safeParse({ value: 12 }, definition)).errors.get('value')).toEqual(['Three digits.'])
  })
})
