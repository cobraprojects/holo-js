import { isValidationException } from '@holo-js/validation'

export function validationExceptionResponse(error: unknown): Response | null {
  if (!isValidationException(error)) {
    return null
  }

  const payload = error.toJSON()
  return Response.json(payload, {
    status: payload.status,
  })
}
