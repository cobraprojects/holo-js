import { decryptCookieValue, encryptCookieValue, resolveRequestUrl } from '@holo-js/kernel'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  SecurityCsrfError,
  type SecurityCsrfFacade,
  type SecurityCsrfField,
  type SecurityCsrfInput,
  type SecurityProtectOptions,
} from './contracts'
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
  return pathname === '/broadcasting/auth' || except.some(pattern => matchesPathPattern(pathname, pattern))
}

export function isSecureRequest(request: Request): boolean {
  return resolveRequestUrl(request).protocol === 'https:'
}

function createCsrfToken(): string {
  return randomBytes(32).toString('base64url')
}

function csrfCookieName(): string {
  return getSecurityRuntime().config.csrf.cookie
}

function encryptCsrfToken(token: string): string {
  return encryptCookieValue(csrfCookieName(), token, getSecurityRuntime().csrfSigningKey)
}

function decryptCsrfToken(value: string): string | undefined {
  return decryptCookieValue(csrfCookieName(), value, getSecurityRuntime().csrfSigningKey)
}

function tokensMatch(expected: string, submitted: string | undefined): boolean {
  if (!submitted) {
    return false
  }

  const plain = decryptCsrfToken(submitted) ?? submitted
  const expectedBytes = Buffer.from(expected)
  const submittedBytes = Buffer.from(plain)
  return expectedBytes.length === submittedBytes.length && timingSafeEqual(expectedBytes, submittedBytes)
}

function getCookieToken(request: Request): string | undefined {
  const value = parseCookieHeader(request.headers.get('cookie'))[csrfCookieName()]
  return value ? decryptCsrfToken(value) : undefined
}

function getHeaderToken(request: Request): string | undefined {
  const { header } = getSecurityRuntime().config.csrf
  return request.headers.get(header)?.trim() || undefined
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
  if (!cookieToken) {
    throw new SecurityCsrfError()
  }

  const submittedToken = getHeaderToken(request) ?? await readFormToken(request)
  if (!tokensMatch(cookieToken, submittedToken)) {
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
  if (cookieToken) {
    return cookieToken
  }

  const cached = generatedTokenCache.get(request)
  if (cached) {
    return cached
  }

  const created = createCsrfToken()
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

export async function input(request: Request): Promise<SecurityCsrfInput> {
  const csrfField = await field(request)

  return Object.freeze({
    type: 'hidden' as const,
    name: csrfField.name,
    value: csrfField.value,
  })
}

export async function encryptedToken(request: Request, explicitToken?: string): Promise<string> {
  return encryptCsrfToken(explicitToken || await token(request))
}

export async function cookie(request: Request, explicitToken?: string): Promise<string> {
  return serializeCookie(csrfCookieName(), await encryptedToken(request, explicitToken), {
    secure: isSecureRequest(request),
  })
}

export async function verify(request: Request): Promise<void> {
  await verifyRequest(request, { allowExcludedPath: true })
}

export async function protect(request: Request, options: SecurityProtectOptions = {}): Promise<void> {
  if (typeof options.throttle === 'string') {
    await rateLimit(options.throttle, { request })
  }

  if (resolveShouldProtect(request, options)) {
    await verifyRequest(request, {
      allowExcludedPath: options.csrf !== true,
    })
  }
}

export const csrf = Object.freeze({
  token,
  field,
  input,
  cookie,
  verify,
}) satisfies SecurityCsrfFacade

export const csrfInternals = {
  createCsrfToken,
  generatedTokenCache,
  getCookieToken,
  getHeaderToken,
  isSecureRequest,
  readFormToken,
  isExcludedPath,
  isSafeMethod,
  matchesPathPattern,
  parseCookieHeader,
  serializeCookie,
  decryptCsrfToken,
  encryptCsrfToken,
}
