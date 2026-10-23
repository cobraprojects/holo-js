import { HoloRequestBodyTooLargeError, normalizeHoloHttpError } from '@holo-js/kernel'

type RateLimitFailure = {
  readonly ok: false
  readonly valid: false
  readonly status: 429
  readonly bag: 'default'
  readonly message: string
  readonly errors: { readonly _root: readonly string[] }
  readonly values: Readonly<Record<string, never>>
  readonly retryAfterSeconds?: number
}

type RequestBodyTooLargeFailure = {
  readonly ok: false
  readonly valid: false
  readonly status: 413
  readonly bag: 'default'
  readonly message: string
  readonly errors: { readonly _root: readonly string[] }
  readonly values: Readonly<Record<string, never>>
  readonly retryAfterSeconds?: undefined
}

export function serializeRequestBodyTooLargeError(error: unknown): RequestBodyTooLargeFailure | undefined {
  if (!(error instanceof HoloRequestBodyTooLargeError)
    && !(error instanceof Error && error.name === 'HoloRequestBodyTooLargeError')) {
    const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : undefined
    return cause === undefined ? undefined : serializeRequestBodyTooLargeError(cause)
  }

  return {
    ok: false, valid: false, status: 413, bag: 'default', message: error.message,
    errors: { _root: [error.message] }, values: {},
  }
}

export function serializeRateLimitError(error: unknown): RateLimitFailure | undefined {
  const normalized = normalizeHoloHttpError(error)
  if (!normalized || normalized.status !== 429) return undefined
  const retryAfterSeconds = error && typeof error === 'object' && 'retryAfterSeconds' in error
    && typeof error.retryAfterSeconds === 'number' && Number.isFinite(error.retryAfterSeconds)
    ? error.retryAfterSeconds : undefined
  if (retryAfterSeconds === undefined && error && typeof error === 'object' && 'cause' in error) {
    const cause = serializeRateLimitError(error.cause)
    if (cause) return cause
  }
  return {
    ok: false, valid: false, status: 429, bag: 'default', message: normalized.message,
    errors: { _root: [normalized.message] }, values: {},
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  }
}
