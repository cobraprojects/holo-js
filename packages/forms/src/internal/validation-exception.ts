import {
  type SerializedValidationException,
  isValidationException,
  validationInternals,
} from '@holo-js/validation'
import type { FormFailurePayload } from '../contracts'

type SubmittedFormFailurePayload<TData> = FormFailurePayload<TData> & {
  readonly submitted: true
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isErrorRecord(value: unknown): value is Record<string, readonly string[]> {
  return isPlainObject(value)
    && Object.values(value).every(messages => Array.isArray(messages) && messages.every(message => typeof message === 'string'))
}

function isFormFailurePayload<TData>(value: unknown): value is FormFailurePayload<TData> {
  return isPlainObject(value)
    && value.ok === false
    && typeof value.status === 'number'
    && value.valid === false
    && isPlainObject(value.values)
    && isErrorRecord(value.errors)
}

function readNestedPayload(value: unknown, path: readonly string[]): unknown {
  let cursor = value

  for (const key of path) {
    if (!isPlainObject(cursor)) {
      return undefined
    }

    cursor = cursor[key]
  }

  return cursor
}

function formFailurePayloadFromError<TData>(error: unknown): FormFailurePayload<TData> | undefined {
  const candidates = [
    error,
    readNestedPayload(error, ['data']),
    readNestedPayload(error, ['response', '_data']),
    readNestedPayload(error, ['response', 'data']),
  ]

  return candidates.find((candidate): candidate is FormFailurePayload<TData> => isFormFailurePayload<TData>(candidate))
}

export function validationExceptionToFailure<TData>(
  error: unknown,
  fallbackValues: Partial<TData> = {},
): SubmittedFormFailurePayload<TData> | undefined {
  const payload = isValidationException(error)
    ? error.toJSON() as SerializedValidationException<TData>
    : validationInternals.parseValidationExceptionDigest<TData>(error)

  if (payload) {
    return {
      ok: false,
      status: payload.status,
      submitted: true,
      valid: false,
      values: payload.values && Object.keys(payload.values).length > 0 ? payload.values : fallbackValues,
      errors: payload.errors,
      ...(typeof payload.retryAfterSeconds === 'number' ? { retryAfterSeconds: payload.retryAfterSeconds } : {}),
      ...(typeof payload.retryAt === 'string' ? { retryAt: payload.retryAt } : {}),
    }
  }

  const formFailurePayload = formFailurePayloadFromError<TData>(error)
  if (formFailurePayload) {
    return {
      ok: false,
      status: formFailurePayload.status,
      submitted: true,
      valid: false,
      values: Object.keys(formFailurePayload.values).length > 0 ? formFailurePayload.values : fallbackValues,
      errors: formFailurePayload.errors,
      ...(typeof formFailurePayload.retryAfterSeconds === 'number' ? { retryAfterSeconds: formFailurePayload.retryAfterSeconds } : {}),
      ...(typeof formFailurePayload.retryAt === 'string' ? { retryAt: formFailurePayload.retryAt } : {}),
    }
  }

  return undefined
}
