function requestAppBases(): WeakMap<object, string> {
  const runtime = globalThis as typeof globalThis & { __holoRequestAppBases__?: WeakMap<object, string> }
  runtime.__holoRequestAppBases__ ??= new WeakMap()
  return runtime.__holoRequestAppBases__
}

function normalizeBase(base: string): string {
  return new URL(`http://holo.local/${base.replace(/^\/+/, '')}`).pathname.replace(/\/+$/, '')
}

function set(owner: object, base: string): void {
  requestAppBases().set(owner, normalizeBase(base))
}

function base(owner: object): string {
  return requestAppBases().get(owner) ?? ''
}

function pathname(request: Request): string {
  const path = new URL(request.url).pathname
  const prefix = base(request)
  if (!prefix) return path
  if (path === prefix || path === `${prefix}/`) return '/'
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path
}

function withBase(request: Request, path: string): string {
  return `${base(request)}${path}`
}

export const requestAppBaseInternals = { set, base, pathname, withBase }
