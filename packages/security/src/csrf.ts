import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { SecurityCsrfError, type SecurityCsrfFacade, type SecurityCsrfField, type SecurityProtectOptions } from './contracts'
import { rateLimit } from './rate-limit'
import { getSecurityRuntime } from './runtime'

const generatedTokenCache = new WeakMap<Request, string>()

function parseCookieHeader(header: string | null | undefined): Readonly<Record<string, string>> {
  if (!header) {
    return Object.freeze({})
  }

  const decodeCookiePart = (value: string): string | undefined => {
    try {
      return decodeURIComponent(value)
    } catch {
      return undefined
    }
  }

  const entries = header
    .split(';')
    .map(segment => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const separator = segment.indexOf('=')
      if (separator <= 0) {
        return undefined
      }

      const key = decodeCookiePart(segment.slice(0, separator))
      const value = decodeCookiePart(segment.slice(separator + 1))
      if (!key || typeof value === 'undefined') {
        return undefined
      }

      return [key, value] as const
    })
    .filter((entry): entry is readonly [string, string] => !!entry)

  return Object.freeze(Object.fromEntries(entries))
}

function serializeCookie(name: string, value: string, options: { readonly secure?: boolean } = {}): string {
  const attributes = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    'Path=/',
    'SameSite=Lax',
  ]

  if (options.secure) {
    attributes.push('Secure')
  }

  return attributes.join('; ')
}

function isSafeMethod(method: string): boolean {
  const normalized = method.trim().toUpperCase()
  return normalized === 'GET'
    || normalized === 'HEAD'
    || normalized === 'OPTIONS'
    || normalized === 'TRACE'
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

function matchesPathPattern(pathname: string, pattern: string): boolean {
  const source = `^${escapeRegex(pattern).replaceAll('*', '.*')}$`
  return new RegExp(source).test(pathname)
}

function isExcludedPath(request: Request): boolean {
  const { except } = getSecurityRuntime().config.csrf
  const pathname = new URL(request.url).pathname
  return except.some(pattern => matchesPathPattern(pathname, pattern))
}

function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === 'https:'
}

function createCsrfToken(): string {
  return randomBytes(32).toString('base64url')
}

function getCsrfSigningKey(): string {
  const configured = getSecurityRuntime().csrfSigningKey?.trim()
  if (configured) {
    return configured
  }

  throw new Error('[@holo-js/security] CSRF signing key is not configured.')
}

function signCsrfNonce(nonce: string): string {
  return createHmac('sha256', getCsrfSigningKey())
    .update(nonce)
    .digest('base64url')
}

function encodeCsrfToken(nonce: string): string {
  return `${nonce}.${signCsrfNonce(nonce)}`
}

function decodeCsrfToken(token: string): { readonly nonce: string, readonly signature: string } | null {
  const separator = token.indexOf('.')
  if (separator <= 0 || separator === token.length - 1) {
    return null
  }

  return Object.freeze({
    nonce: token.slice(0, separator),
    signature: token.slice(separator + 1),
  })
}

function isValidSignedCsrfToken(token: string): boolean {
  const decoded = decodeCsrfToken(token)
  if (!decoded) {
    return false
  }

  const expected = Buffer.from(signCsrfNonce(decoded.nonce))
  const received = Buffer.from(decoded.signature)
  if (expected.length !== received.length) {
    return false
  }

  return timingSafeEqual(expected, received)
}

function getCookieToken(request: Request): string | undefined {
  const { cookie } = getSecurityRuntime().config.csrf
  return parseCookieHeader(request.headers.get('cookie'))[cookie]
}

async function readFormToken(request: Request): Promise<string | undefined> {
  const { field } = getSecurityRuntime().config.csrf
  try {
    const formData = await request.clone().formData()
    const value = formData.get(field)
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

async function getRequestToken(request: Request): Promise<string | undefined> {
  const { header } = getSecurityRuntime().config.csrf
  const headerToken = request.headers.get(header)?.trim()
  if (headerToken) {
    return headerToken
  }

  return await readFormToken(request)
}

async function verifyRequest(
  request: Request,
  options: { readonly allowExcludedPath: boolean },
): Promise<void> {
  if (isSafeMethod(request.method)) {
    return
  }

  if (options.allowExcludedPath && isExcludedPath(request)) {
    return
  }

  const cookieToken = getCookieToken(request)
  const requestToken = await getRequestToken(request)
  if (
    !cookieToken
    || !requestToken
    || cookieToken !== requestToken
    || !isValidSignedCsrfToken(cookieToken)
  ) {
    throw new SecurityCsrfError()
  }
}

function resolveShouldProtect(request: Request, options: SecurityProtectOptions = {}): boolean {
  if (options.csrf === false) {
    return false
  }

  if (isSafeMethod(request.method)) {
    return false
  }

  if (options.csrf === true) {
    return true
  }

  const { enabled } = getSecurityRuntime().config.csrf
  if (!enabled) {
    return false
  }

  if (isExcludedPath(request)) {
    return false
  }

  return true
}

export async function token(request: Request): Promise<string> {
  const cookieToken = getCookieToken(request)
  if (cookieToken && isValidSignedCsrfToken(cookieToken)) {
    return cookieToken
  }

  const cached = generatedTokenCache.get(request)
  if (cached) {
    return cached
  }

  const created = encodeCsrfToken(createCsrfToken())
  generatedTokenCache.set(request, created)
  return created
}

export async function field(request: Request): Promise<SecurityCsrfField> {
  const config = getSecurityRuntime().config.csrf
  return Object.freeze({
    name: config.field,
    value: await token(request),
  })
}

export async function cookie(request: Request, explicitToken?: string): Promise<string> {
  const config = getSecurityRuntime().config.csrf
  const value = explicitToken
    ? (isValidSignedCsrfToken(explicitToken) ? explicitToken : encodeCsrfToken(explicitToken))
    : await token(request)
  return serializeCookie(config.cookie, value, {
    secure: isSecureRequest(request),
  })
}

export async function verify(request: Request): Promise<void> {
  await verifyRequest(request, { allowExcludedPath: true })
}

export async function protect(request: Request, options: SecurityProtectOptions = {}): Promise<void> {
  if (!resolveShouldProtect(request, options)) {
    if (typeof options.throttle !== 'string') {
      return
    }
  } else {
    await verifyRequest(request, {
      allowExcludedPath: options.csrf !== true,
    })
  }

  if (typeof options.throttle === 'string') {
    await rateLimit(options.throttle, { request })
  }
}

export const csrf = Object.freeze({
  token,
  field,
  cookie,
  verify,
}) satisfies SecurityCsrfFacade

export const csrfInternals = {
  createCsrfToken,
  generatedTokenCache,
  getCookieToken,
  getRequestToken,
  isExcludedPath,
  isSafeMethod,
  matchesPathPattern,
  parseCookieHeader,
  serializeCookie,
  decodeCsrfToken,
  encodeCsrfToken,
  getCsrfSigningKey,
  isValidSignedCsrfToken,
}
