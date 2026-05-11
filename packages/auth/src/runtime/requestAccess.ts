type RequestAccessBindings = {
  readonly context: {
    getRequestCookie?(name: string): Promise<string | undefined> | string | undefined
    getRequestHeader?(name: string): Promise<string | undefined> | string | undefined
    appendResponseCookie?(cookie: string): Promise<void> | void
    redirectResponse?(url: string, status?: 301 | 302 | 303 | 307 | 308): Promise<void> | void
  }
}

const AUTH_RESPONSE_INTERRUPT = Symbol.for('holo-js.auth.response-interrupt')

type AuthResponseInterruptShape = {
  readonly [AUTH_RESPONSE_INTERRUPT]?: true
}

type FrameworkRedirectShape = {
  readonly digest?: unknown
  readonly status?: unknown
  readonly location?: unknown
}

export class AuthResponseInterrupt extends Error {
  readonly [AUTH_RESPONSE_INTERRUPT] = true

  constructor() {
    super('Holo auth response was already handled.')
    this.name = 'AuthResponseInterrupt'
  }
}

export function isAuthResponseInterrupt(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const interrupt = error as AuthResponseInterruptShape
  if (interrupt[AUTH_RESPONSE_INTERRUPT] === true) {
    return true
  }

  const frameworkRedirect = error as FrameworkRedirectShape
  if (typeof frameworkRedirect.digest === 'string' && frameworkRedirect.digest.startsWith('NEXT_REDIRECT')) {
    return true
  }

  return typeof frameworkRedirect.status === 'number'
    && frameworkRedirect.status >= 300
    && frameworkRedirect.status < 400
    && typeof frameworkRedirect.location === 'string'
}

export async function resolveRequestCookie(
  bindings: RequestAccessBindings,
  name: string,
): Promise<string | undefined> {
  return await bindings.context.getRequestCookie?.(name)
}

export async function resolveRequestHeader(
  bindings: RequestAccessBindings,
  name: string,
): Promise<string | undefined> {
  const value = await bindings.context.getRequestHeader?.(name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export async function appendResponseCookies(
  bindings: RequestAccessBindings,
  cookies: readonly string[],
): Promise<void> {
  if (!bindings.context.appendResponseCookie) {
    return
  }

  for (const cookie of cookies) {
    await bindings.context.appendResponseCookie(cookie)
  }
}

export async function redirectResponse(
  bindings: RequestAccessBindings,
  url: string,
  status: 301 | 302 | 303 | 307 | 308 = 307,
): Promise<never> {
  if (!bindings.context.redirectResponse) {
    throw new Error('Holo auth runtime cannot redirect the current framework response.')
  }

  await bindings.context.redirectResponse(url, status)
  throw new AuthResponseInterrupt()
}

export function parseBearerToken(header: string | undefined): string | undefined {
  if (typeof header !== 'string') {
    return undefined
  }

  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || undefined
}
