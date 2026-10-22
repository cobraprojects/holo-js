import { cookieEncryptionInternals, resolveRequestUrl } from '@holo-js/kernel'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  SecurityCsrfError,
  type SecurityCsrfFacade,
  type SecurityCsrfField,
  type SecurityCsrfInput,
  type SecurityCsrfSessionAccessor,
  type SecurityProtectOptions,
} from './contracts'
import { SECURITY_XSRF_HEADER } from './client-config'
import { rateLimit } from './rate-limit'
import { getSecurityRuntime } from './runtime'

const requestTokenCache = new WeakMap<Request, string>()
const persistedTokens = new WeakMap<Request, string>()

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
  return cookieEncryptionInternals.encryptCookieValue(csrfCookieName(), token, getSecurityRuntime().csrfSigningKey)
}

function decryptCsrfToken(value: string): string | undefined {
  return cookieEncryptionInternals.decryptCookieValue(csrfCookieName(), value, getSecurityRuntime().csrfSigningKey)
}

function tokensMatch(expected: string, submitted: string | undefined): boolean {
  if (!submitted) {
    return false
  }

  const expectedBytes = Buffer.from(expected)
  const submittedBytes = Buffer.from(submitted)
  return expectedBytes.length === submittedBytes.length && timingSafeEqual(expectedBytes, submittedBytes)
}

function csrfSession(): SecurityCsrfSessionAccessor {
  const session = getSecurityRuntime().csrfSession
  if (!session) {
    throw new Error('[@holo-js/security] CSRF protection requires a session. Install and configure @holo-js/session.')
  }

  return session
}

async function readSessionToken(request: Request): Promise<string | undefined> {
  const stored = await csrfSession().read(request)
  if (stored) {
    persistedTokens.set(request, stored)
  }

  return stored
}

async function getSessionToken(request: Request): Promise<string | undefined> {
  return persistedTokens.get(request) ?? requestTokenCache.get(request) ?? await readSessionToken(request)
}

function getHeaderToken(request: Request): string | undefined {
  const { header } = getSecurityRuntime().config.csrf
  if (header.toLowerCase() === SECURITY_XSRF_HEADER.toLowerCase()) {
    return undefined
  }

  return request.headers.get(header)?.trim() || undefined
}

function getXsrfHeaderToken(request: Request): string | undefined {
  const value = request.headers.get(SECURITY_XSRF_HEADER)?.trim()
  return value ? decryptCsrfToken(value) : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

async function readBodyToken(request: Request, field: string): Promise<string | undefined> {
  try {
    const contentType = request.headers.get('content-type') ?? ''
    if (/[/+]json\b/i.test(contentType)) {
      const body: unknown = await request.clone().json()
      return body && typeof body === 'object' && !Array.isArray(body) && Object.hasOwn(body, field)
        ? nonEmptyString((body as Readonly<Record<string, unknown>>)[field])
        : undefined
    }

    return nonEmptyString((await request.clone().formData()).get(field))
  } catch {
    return undefined
  }
}

async function readInputToken(request: Request): Promise<string | undefined> {
  const { field } = getSecurityRuntime().config.csrf
  return await readBodyToken(request, field) ?? nonEmptyString(new URL(request.url).searchParams.get(field))
}

async function getSubmittedToken(request: Request): Promise<string | undefined> {
  const token = await readInputToken(request) ?? getHeaderToken(request)
  return token ? decryptCsrfToken(token) ?? token : getXsrfHeaderToken(request)
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

  const sessionToken = await getSessionToken(request)
  if (!sessionToken || !tokensMatch(sessionToken, await getSubmittedToken(request))) {
    throw new SecurityCsrfError()
  }
}

async function ensureSessionToken(request: Request): Promise<{
  readonly token: string
  readonly sessionCookies: readonly string[]
}> {
  const stored = persistedTokens.get(request) ?? await readSessionToken(request)
  if (stored) {
    return { token: stored, sessionCookies: [] }
  }

  const token = requestTokenCache.get(request) ?? createCsrfToken()
  const written = await csrfSession().write(request, token)
  requestTokenCache.set(request, written.token)
  persistedTokens.set(request, written.token)
  return { token: written.token, sessionCookies: written.cookies }
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
  const sessionToken = await getSessionToken(request)
  if (sessionToken) {
    return sessionToken
  }

  const created = createCsrfToken()
  requestTokenCache.set(request, created)
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

function rememberSessionToken(request: Request, token: string): void {
  persistedTokens.set(request, token)
}

export const csrfInternals = {
  createCsrfToken,
  rememberSessionToken,
  ensureSessionToken,
  requestTokenCache,
  getHeaderToken,
  getXsrfHeaderToken,
  isSecureRequest,
  readInputToken,
  isExcludedPath,
  isSafeMethod,
  matchesPathPattern,
  serializeCookie,
  decryptCsrfToken,
  encryptCsrfToken,
}
