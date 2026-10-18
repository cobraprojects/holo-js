import { serializeValidationException } from '@holo-js/validation'

export function validationExceptionResponse(error: unknown): Response | null {
  const payload = serializeValidationException(error)
  if (!payload) {
    return null
  }

  return Response.json(payload, {
    status: payload.status,
  })
}
