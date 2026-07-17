import {
  normalizeHoloHttpError,
  renderClientHttpErrorPage,
  type NormalizedHoloHttpError,
} from '@holo-js/adapter-shared'

type NextHttpError = Error & { digest: `NEXT_HTTP_ERROR_FALLBACK;${number}` }
const nextHttpAccessFallbackStatuses = new Set<number>([401, 403, 404])

export function normalizeNextClientHttpError(error: unknown): NormalizedHoloHttpError | undefined {
  return normalizeHoloHttpError(error)
}

export function createNextRenderableError(error: NormalizedHoloHttpError): Error {
  if (!nextHttpAccessFallbackStatuses.has(error.status)) return new Error(error.message, { cause: error.cause })
  const nextError = new Error(error.message, { cause: error.cause }) as NextHttpError
  nextError.digest = `NEXT_HTTP_ERROR_FALLBACK;${error.status}`
  return nextError
}

export function renderNextClientHttpErrorPage(error: NormalizedHoloHttpError): void {
  renderClientHttpErrorPage(error, {
    rootId: '__holo_next_client_http_error__',
    statusClassName: 'next-error-h1',
  })
}
