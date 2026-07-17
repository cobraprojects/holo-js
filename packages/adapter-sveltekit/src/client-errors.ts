import {
  normalizeHoloHttpError,
  renderClientHttpErrorPage,
  type NormalizedHoloHttpError,
} from '@holo-js/adapter-shared'

export function normalizeSvelteKitClientHttpError(error: unknown): NormalizedHoloHttpError | undefined {
  return normalizeHoloHttpError(error)
}

export function renderSvelteKitClientHttpErrorPage(error: NormalizedHoloHttpError): void {
  renderClientHttpErrorPage(error, {
    rootId: '__holo_sveltekit_client_http_error__',
    statusClassName: 'sveltekit-error-h1',
  })
}
