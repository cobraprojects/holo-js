import type { H3Error, H3Event } from 'h3'
import { send, setHeader, setResponseStatus } from '#imports'
import { serializeValidationException } from '@holo-js/validation'
import { serializeRateLimitError } from '@holo-js/adapter-shared/server-errors'
import {
  applyFormFailureRedirect,
  shouldRedirectFormFailure,
  type NitroResponse,
} from './form-failure'

export default async function handleValidationError(error: H3Error, event: H3Event): Promise<void> {
  const payload = serializeValidationException(error) ?? serializeRateLimitError(error)
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
