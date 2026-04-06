import { describe, expect, it } from 'vitest'
import { field, parse, schema, validate } from '../src'

describe('@holo-js/validation documented examples', () => {
  it('covers the documented JSON API validation flow without forms', async () => {
    const updateProfile = schema({
      displayName: field.string().required().min(3).max(80),
      timezone: field.string().required(),
      birthday: field.date().nullable().beforeOrToday(),
    })

    const success = await parse({
      displayName: 'Ava',
      timezone: 'Africa/Cairo',
      birthday: '2024-01-10T00:00:00.000Z',
    }, updateProfile)

    expect(success.displayName).toBe('Ava')
    expect(success.birthday).toBeInstanceOf(Date)

    const failure = await validate({
      displayName: 'Av',
      timezone: '',
      birthday: '3024-01-10T00:00:00.000Z',
    }, updateProfile)

    expect(failure.valid).toBe(false)
    if (!failure.valid) {
      expect(failure.errors.first('displayName')).toBeDefined()
      expect(failure.errors.first('timezone')).toBe('This field is required.')
      expect(failure.errors.first('birthday')).toBeDefined()
    }
  })
})
