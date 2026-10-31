type RenderedValidationFlashGlobals = typeof globalThis & {
  __holoNextRenderedValidationFlashes?: WeakMap<object, string>
}

const renderedValidationFlashes = (globalThis as RenderedValidationFlashGlobals).__holoNextRenderedValidationFlashes ??= new WeakMap()

export function rememberRenderedValidationFlash(request: object, flash: string): void {
  renderedValidationFlashes.set(request, flash)
}

export function renderedValidationFlash(request: object | undefined): string | undefined {
  return request ? renderedValidationFlashes.get(request) : undefined
}
