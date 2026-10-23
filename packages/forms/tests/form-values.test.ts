import { describe, expect, it } from 'vitest'
import { setFormValueAtPath } from '../src/internal/formValues'

describe('form value paths', () => {
  it.each([
    '__proto__.polluted',
    'profile.__proto__.polluted',
    'constructor.prototype.polluted',
    'prototype.polluted',
  ])('does not write through the unsafe path %s', (path) => {
    const values: Record<string, unknown> = {}

    setFormValueAtPath(values, path, 'owned')

    expect(Object.getPrototypeOf(values)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.keys(values)).toEqual([])
  })

  it('still writes ordinary nested paths', () => {
    const values: Record<string, unknown> = {}

    setFormValueAtPath(values, 'profile.name', 'Ada')

    expect(values).toEqual({ profile: { name: 'Ada' } })
  })
})
