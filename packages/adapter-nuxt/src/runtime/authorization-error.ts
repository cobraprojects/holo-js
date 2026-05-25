import { createError } from 'h3'

type NuxtAuthorizationDecision = {
  readonly message?: string
  readonly status: 200 | 403 | 404
}

export function createNuxtAuthorizationError(decision: NuxtAuthorizationDecision): Error {
  const status = decision.status === 404 ? 404 : 403

  return createError({
    statusCode: status,
    statusMessage: decision.message ?? 'You are not authorized to perform this action.',
  })
}
