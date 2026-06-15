import { authRuntimeInternals } from '@holo-js/auth'
import type { ClerkRequestInput } from './contracts'

export function normalizeClerkRequest(input: ClerkRequestInput): Request {
  return authRuntimeInternals.normalizeRequestInput(input)
}
