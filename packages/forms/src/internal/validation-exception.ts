import {
  type SerializedValidationException,
  isValidationException,
} from '@holo-js/validation'
import type { FormFailurePayload } from '../contracts'

type SubmittedFormFailurePayload<TData> = FormFailurePayload<TData> & {
  readonly submitted: true
}

export function validationExceptionToFailure<TData>(
  error: unknown,
  fallbackValues: Partial<TData> = {},
): SubmittedFormFailurePayload<TData> | undefined {
  if (!isValidationException(error)) {
    return undefined
  }

  const payload = error.toJSON() as SerializedValidationException<TData>
  return {
    ok: false,
    status: payload.status,
    submitted: true,
    valid: false,
    values: Object.keys(payload.values).length > 0 ? payload.values : fallbackValues,
    errors: payload.errors,
    ...(typeof payload.retryAfterSeconds === 'number' ? { retryAfterSeconds: payload.retryAfterSeconds } : {}),
    ...(typeof payload.retryAt === 'string' ? { retryAt: payload.retryAt } : {}),
  }
}
