import { describe, expect, it } from 'vitest'
import { ValidationException, validationInternals } from '../src'

describe('validation error serialization', () => {
  it('normalizes raw exceptions and validated payloads carried across framework boundaries', () => {
    const exception = ValidationException.withMessages({ email: ['These credentials do not match our records.'] })
    const payload = exception.toJSON()
    expect(validationInternals.serializeValidationException(exception)).toEqual(payload)
    expect(validationInternals.serializeValidationException(JSON.parse(JSON.stringify(payload)))).toEqual(payload)
    for (const property of ['body', 'data', 'error', 'cause']) {
      expect(validationInternals.serializeValidationException({ [property]: payload })).toEqual(payload)
    }
    expect(validationInternals.serializeValidationException({ status: 422, body: { status: 422, errors: payload.errors } })).toBeUndefined()
    expect(validationInternals.serializeValidationException(new Error('Unrelated failure'))).toBeUndefined()
    expect(validationInternals.serializeValidationException({ ...payload, errors: { email: 42 } })).toBeUndefined()
  })
})
