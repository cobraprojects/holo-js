import { send, setHeader, setResponseStatus, type H3Error, type H3Event } from 'h3'
import { isValidationException, type ValidationException } from '@holo-js/validation'
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

export default defineNitroErrorHandler(async (error: H3Error, event: H3Event) => {
  const validationError = findValidationException(error)
  if (!validationError) {
    return
  }

  const payload = validationError.toJSON()
  if (shouldRedirectFormFailure(event)) {
    const failure = { ...payload }
    const response: NitroResponse = {}
    applyFormFailureRedirect(event, response, failure)
    await send(event, '', 'text/html')
    return
  }

  setResponseStatus(event, payload.status)
  setHeader(event, 'content-type', 'application/json; charset=utf-8')
  await send(event, JSON.stringify(payload), 'application/json')
})
