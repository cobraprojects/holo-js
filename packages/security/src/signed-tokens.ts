import { createHmac, timingSafeEqual } from 'node:crypto'
import { getSecurityRuntime } from './runtime'

export type SecuritySignedTokenPrimitive
  = boolean | number | string | null

export type SecuritySignedTokenValue
  = SecuritySignedTokenPrimitive
    | readonly SecuritySignedTokenValue[]
    | { readonly [key: string]: SecuritySignedTokenValue }

export type SecuritySignedTokenPayload
  = Readonly<Record<string, SecuritySignedTokenValue>>

export interface SecuritySignedTokenOptions {
  readonly expiresAt: Date
  readonly purpose: string
}

type SecuritySignedTokenEnvelope = {
  readonly expiresAt: number
  readonly payload: SecuritySignedTokenPayload
  readonly version: 1
}

const MAX_SIGNED_TOKEN_DEPTH = 32
const MAX_SIGNED_TOKEN_BODY_BYTES = 64 * 1024
const MAX_SIGNED_TOKEN_CHARACTERS = Math.ceil(MAX_SIGNED_TOKEN_BODY_BYTES * 4 / 3) + 44

function signingKey(): string {
  const key = getSecurityRuntime().csrfSigningKey?.trim()
  if (!key) {
    throw new Error('[@holo-js/security] Signed tokens require an application signing key.')
  }

  return key
}

function normalizePurpose(purpose: string): string {
  const normalized = purpose.trim()
  if (!normalized) {
    throw new TypeError('[@holo-js/security] Signed token purpose must be a non-empty string.')
  }

  return normalized
}

function isSignedTokenValue(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
): value is SecuritySignedTokenValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object') return false
  if (depth >= MAX_SIGNED_TOKEN_DEPTH || ancestors.has(value)) return false

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value)
      if (ownKeys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key)))) return false
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !('value' in descriptor) || !isSignedTokenValue(descriptor.value, ancestors, depth + 1)) return false
      }
      return true
    }

    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return false
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor) || !isSignedTokenValue(descriptor.value, ancestors, depth + 1)) return false
    }
    return true
  } finally {
    ancestors.delete(value)
  }
}

function assertPayload(payload: SecuritySignedTokenPayload): void {
  if (!isSignedTokenValue(payload) || Array.isArray(payload) || payload === null) {
    throw new TypeError('[@holo-js/security] Signed token payload must contain only JSON-safe values.')
  }
}

function signature(body: string, purpose: string): Buffer {
  return createHmac('sha256', signingKey())
    .update('holo-signed-token-v1\0')
    .update(purpose)
    .update('\0')
    .update(body)
    .digest()
}

function decodeEnvelope(body: string): SecuritySignedTokenEnvelope | null {
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const envelope = value as Partial<SecuritySignedTokenEnvelope>
    if (envelope.version !== 1 || !Number.isSafeInteger(envelope.expiresAt)) return null
    if (!isSignedTokenValue(envelope.payload) || Array.isArray(envelope.payload) || envelope.payload === null) return null
    return envelope as SecuritySignedTokenEnvelope
  } catch {
    return null
  }
}

export function createSignedToken<
  TPayload extends SecuritySignedTokenPayload,
>(
  payload: TPayload,
  options: SecuritySignedTokenOptions,
): string {
  assertPayload(payload)
  const purpose = normalizePurpose(options.purpose)
  const expiresAt = options.expiresAt.getTime()
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    throw new TypeError('[@holo-js/security] Signed token expiry must be a valid future date.')
  }

  const encodedEnvelope = JSON.stringify({
    expiresAt,
    payload,
    version: 1,
  } satisfies SecuritySignedTokenEnvelope)
  if (Buffer.byteLength(encodedEnvelope, 'utf8') > MAX_SIGNED_TOKEN_BODY_BYTES) {
    throw new TypeError('[@holo-js/security] Signed token payload exceeds 64 KiB.')
  }
  const body = Buffer.from(encodedEnvelope).toString('base64url')
  return `${body}.${signature(body, purpose).toString('base64url')}`
}

export function verifySignedToken<
  TPayload extends SecuritySignedTokenPayload,
>(
  token: string,
  options: {
    readonly now?: Date
    readonly purpose: string
  },
): TPayload | null {
  if (token.length > MAX_SIGNED_TOKEN_CHARACTERS) return null
  const purpose = normalizePurpose(options.purpose)
  const separator = token.lastIndexOf('.')
  if (separator <= 0 || separator === token.length - 1) return null

  const body = token.slice(0, separator)
  const encodedSignature = token.slice(separator + 1)
  if (!/^[A-Za-z0-9_-]{43}$/u.test(encodedSignature)) return null
  const providedSignature = Buffer.from(encodedSignature, 'base64url')
  if (providedSignature.toString('base64url') !== encodedSignature) return null
  const expectedSignature = signature(body, purpose)
  if (providedSignature.length !== expectedSignature.length || !timingSafeEqual(providedSignature, expectedSignature)) return null

  const envelope = decodeEnvelope(body)
  const now = options.now?.getTime() ?? Date.now()
  if (!envelope || !Number.isFinite(now) || envelope.expiresAt <= now) return null
  return envelope.payload as TPayload
}
