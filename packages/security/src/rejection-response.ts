import { HoloRequestBodyTooLargeError, HoloRequestUrlError } from '@holo-js/kernel'
import { SecurityCsrfError } from './contracts'

export type SecurityRejection = SecurityCsrfError | HoloRequestUrlError | HoloRequestBodyTooLargeError

export function isSecurityRejection(error: unknown): error is SecurityRejection {
  return error instanceof SecurityCsrfError
    || error instanceof HoloRequestUrlError
    || error instanceof HoloRequestBodyTooLargeError
}

export function createSecurityRejectionResponse(error: SecurityRejection): Response {
  return new Response(error.message, {
    status: error.status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  })
}
