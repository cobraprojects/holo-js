import { describe, expect, it } from 'vitest'
import { field, schema } from '../src'

describe('regex validation', () => {
  it.each([
    { pattern: /^[A-Z]+$/g, valid: 'ABC' },
    { pattern: /^[A-Z]+$/y, valid: 'ABC' },
    { pattern: /^[A-Z]+$/gy, valid: 'ABC' },
    { pattern: /^[a-z]+.$/gimsu, valid: 'ABC\n' },
  ])('reuses $pattern deterministically without changing caller state', async ({ pattern, valid }) => {
    const definition = schema({ code: field.string().required().regex(pattern) })

    for (let iteration = 0; iteration < 3; iteration++) {
      expect(await definition['~standard'].validate({ code: valid })).toEqual({ value: { code: valid } })
      expect(pattern.lastIndex).toBe(0)
    }

    pattern.lastIndex = 2
    const inputs = [valid, '123', valid, '123', valid]
    const results = await Promise.all(inputs.map(code => definition['~standard'].validate({ code })))

    expect(results).toEqual(inputs.map(code => code === valid
      ? { value: { code } }
      : { issues: [{ message: 'This field format is invalid.', path: [{ key: 'code' }] }] },
    ))
    expect(pattern.lastIndex).toBe(2)
  })

  it.each(['y', 'gy'])('preserves sticky matching with %s flags and a custom message', async (flags) => {
    const pattern = new RegExp('[A-Z]+', flags)
    pattern.lastIndex = 1
    const definition = schema({ code: field.string().regex(pattern, 'Invalid code.') })

    expect(await definition['~standard'].validate({ code: '1ABC' })).toEqual({
      issues: [{ message: 'Invalid code.', path: [{ key: 'code' }] }],
    })
    expect(await definition['~standard'].validate({ code: 'ABC' })).toEqual({ value: { code: 'ABC' } })
    expect(pattern.lastIndex).toBe(1)
  })
})
