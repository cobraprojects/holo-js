import { describe, expect, it } from 'vitest'
import { HOLO_FIELD_ERRORS } from '@holo-js/kernel/field-errors'
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

  it('serializes field-error carriers from other packages and ignores invalid ones', () => {
    const carrier = (fieldErrors: unknown) => Object.assign(new Error('The cursor is invalid.'), { [HOLO_FIELD_ERRORS]: fieldErrors })
    expect(validationInternals.serializeValidationException(carrier({ after: ['The cursor is invalid.'] }))).toEqual({
      ok: false,
      status: 422,
      valid: false,
      message: 'The cursor is invalid.',
      bag: 'default',
      values: {},
      errors: { after: ['The cursor is invalid.'] },
    })

    for (const invalid of [{}, new Map([['after', ['x']]]), { after: [] }, { after: 'x' }, { after: Array(1) }, Object.defineProperty({}, 'after', { enumerable: true, get: () => { throw new Error('getter') } })]) {
      expect(validationInternals.serializeValidationException(carrier(invalid))).toBeUndefined()
    }
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const wrapped = { error: revoked.proxy, cause: ValidationException.withMessages({ email: ['Invalid email.'] }) }
    expect(validationInternals.serializeValidationException(wrapped)?.errors).toEqual({ email: ['Invalid email.'] })
    const hidingCarrier = Object.defineProperty(carrier({ after: ['x'] }), 'message', { get: () => { throw new Error('message') } })
    Object.assign(hidingCarrier, { cause: ValidationException.withMessages({ email: ['Invalid email.'] }) })
    expect(validationInternals.serializeValidationException(hidingCarrier)?.errors).toEqual({ email: ['Invalid email.'] })
    const nanLength = new Proxy(['x'], { get: (target, key) => key === 'length' ? Number.NaN : Reflect.get(target, key) })
    expect(validationInternals.serializeValidationException(carrier({ after: nanLength }))).toBeUndefined()
    const prototypeNamed = validationInternals.serializeValidationException(carrier(JSON.parse('{"__proto__":["x"]}')))
    expect(Object.entries(prototypeNamed?.errors ?? {})).toEqual([['__proto__', ['x']]])
    const sparse = Object.assign(Array(2), { 0: 'x', [Symbol.iterator]: function* () { yield 'x'; yield 'y' } })
    expect(validationInternals.serializeValidationException(carrier({ after: sparse }))).toBeUndefined()
    const throwing = Object.defineProperty(new Error('boom'), HOLO_FIELD_ERRORS, { get: () => { throw new Error('getter') } })
    expect(validationInternals.serializeValidationException(throwing)).toBeUndefined()
    for (const flags of [{}, { ok: false, status: 422, valid: false }]) {
      const throwingMessage = Object.defineProperty(Object.assign(carrier({ after: ['x'] }), flags), 'message', { get: () => { throw new Error('message') } })
      expect(validationInternals.serializeValidationException(throwingMessage)).toBeUndefined()
    }
  })
})
