import { send, setHeader, setResponseStatus, type H3Error, type H3Event } from 'h3'
import { isValidationException, type ValidationException } from '@holo-js/validation'
import { serializeRateLimitError } from '@holo-js/adapter-shared/server-errors'
import {
  applyFormFailureRedirect,
  shouldRedirectFormFailure,
  type NitroResponse,
} from './form-failure'

function findValidationException(error: unknown): ValidationException | undefined {
  if (isValidationException(error)) {
    return error
  }

  if (!error || typeof error !== 'object' || !('cause' in error)) {
    return undefined
  }

  return findValidationException((error as { readonly cause?: unknown }).cause)
}

export default async function handleValidationError(error: H3Error, event: H3Event): Promise<void> {
  const validationError = findValidationException(error)
  const payload = validationError?.toJSON() ?? serializeRateLimitError(error)
  if (!payload) {
    return
  }

  if (shouldRedirectFormFailure(event)) {
    const failure = { ...payload }
    const response: NitroResponse = {}
    applyFormFailureRedirect(event, response, failure)
    await send(event, '', 'text/html')
    return
  }

  setResponseStatus(event, payload.status)
  setHeader(event, 'content-type', 'application/json; charset=utf-8')
  if (payload.retryAfterSeconds !== undefined) setHeader(event, 'Retry-After', payload.retryAfterSeconds)
  await send(event, JSON.stringify(payload), 'application/json')
}
