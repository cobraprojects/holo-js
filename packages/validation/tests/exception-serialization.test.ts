import { describe, expect, expectTypeOf, it } from 'vitest'
import { isValidationException, serializeValidationException, ValidationException, type SerializedValidationException, validationInternals } from '../src'

describe('validation failure serialization', () => {
  it('returns one public payload contract for live, serialized, wrapped and digest errors', () => {
    const exception = ValidationException.withMessages({ file: ['Upload a square avatar.'] }, { bag: 'avatar' })
    validationInternals.setValidationExceptionValues(exception, { title: 'Profile' })
    validationInternals.setValidationExceptionStatus(exception, 429)
    validationInternals.setValidationExceptionMetadata(exception, { retryAfterSeconds: 30, retryAt: '2026-10-18T12:00:00Z' })
    const payload = exception.toJSON()
    for (const failure of [exception, payload, { body: payload }, { data: payload }, { digest: exception.digest, body: payload }, new Error('wrapped', { cause: new Error('nested', { cause: exception }) })]) {
      expect(serializeValidationException(failure)).toEqual(payload)
    }
    const transported = Object.assign(new Error('Server error'), { digest: exception.digest })
    expect(isValidationException(transported)).toBe(false)
    expect(serializeValidationException(transported)).toEqual({ ...payload, values: {} })
    expectTypeOf(serializeValidationException(transported)).toEqualTypeOf<SerializedValidationException | undefined>()
    if (isValidationException(exception)) {
      expect(exception.errors.flatten()).toEqual(payload.errors)
    }
  })

  it('ignores unrelated, malformed and cyclic failures', () => {
    const cyclic = new Error('ordinary')
    cyclic.cause = cyclic
    const exception = ValidationException.withMessages({ file: ['Invalid.'] })
    for (const failure of [null, cyclic, { ...exception.toJSON(), errors: { file: [42] } }, { ...exception.toJSON(), retryAt: 42 }, { digest: 'HOLO_VALIDATION;%invalid' }, { digest: `HOLO_VALIDATION;${encodeURIComponent(JSON.stringify({ ...exception.toJSON(), errors: { file: [42] } }))}` }]) {
      expect(serializeValidationException(failure)).toBeUndefined()
    }
  })
})
