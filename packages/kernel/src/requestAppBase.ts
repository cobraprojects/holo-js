function requestAppBases(): WeakMap<Request, string> {
  const runtime = globalThis as typeof globalThis & { __holoRequestAppBases__?: WeakMap<Request, string> }
  runtime.__holoRequestAppBases__ ??= new WeakMap()
  return runtime.__holoRequestAppBases__
}

function set(request: Request, base: string): void {
  requestAppBases().set(request, base)
}

function pathname(request: Request): string {
  const path = new URL(request.url).pathname
  const base = requestAppBases().get(request) ?? ''
  if (!base) return path
  if (path === base || path === `${base}/`) return '/'
  return path.startsWith(`${base}/`) ? path.slice(base.length) : path
}

function withBase(request: Request, path: string): string {
  return `${requestAppBases().get(request) ?? ''}${path}`
}

export const requestAppBaseInternals = { set, pathname, withBase }
