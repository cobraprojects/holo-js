export const COOKIE_WRITE_UNAVAILABLE = 'cookie_write_unavailable'

export function createCookieWriteUnavailableError(message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), {
    code: COOKIE_WRITE_UNAVAILABLE,
  })
}
