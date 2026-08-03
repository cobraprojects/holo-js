import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type {
  CookieSerializeOptions,
  CreateSessionInput,
  ReadSessionOptions,
  RememberTokenOptions,
  RotateSessionOptions,
  SessionRecord,
  SessionRuntimeBindings,
  SessionRuntimeFacade,
  SessionStore,
  TouchSessionOptions,
} from './contracts'

const FLASH_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/
const FLASH_VALUE_MAX_BYTES = 65_536
const FLASH_VALUE_MAX_DEPTH = 32
const UNSAFE_FLASH_KEYS = new Set(['constructor', 'prototype'])

function getSessionRuntimeState(): {
  bindings?: SessionRuntimeBindings
} {
  const runtime = globalThis as typeof globalThis & {
    __holoSessionRuntime__?: {
      bindings?: SessionRuntimeBindings
    }
  }

  runtime.__holoSessionRuntime__ ??= {}
  return runtime.__holoSessionRuntime__
}

function getSessionRuntimeBindings(): SessionRuntimeBindings {
  const bindings = getSessionRuntimeState().bindings
  if (!bindings) {
    throw new Error('[@holo-js/session] Session runtime is not configured yet.')
  }

  return bindings
}

function getStore(name?: string): { name: string, store: SessionStore, config: SessionRuntimeBindings['config'] } {
  const bindings = getSessionRuntimeBindings()
  const storeName = name?.trim() || bindings.config.driver
  const store = bindings.stores[storeName]
  if (!store) {
    throw new Error(`[@holo-js/session] Session store "${storeName}" is not configured.`)
  }

  return { name: storeName, store, config: bindings.config }
}

function ensureDate(value: Date): Date {
  return new Date(value.getTime())
}

function now(): Date {
  return new Date()
}

function createExpiryDate(minutes: number): Date {
  return new Date(Date.now() + (minutes * 60_000))
}

function hashRememberToken(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

function createSessionId(): string {
  return randomUUID()
}

function normalizeSessionKey(input: CreateSessionInput): string {
  return input.name?.trim() || input.id?.trim() || createSessionId()
}

function normalizeSessionData(input: CreateSessionInput): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...(input.value ?? input.data ?? {}),
  })
}

function normalizeFlashKey(key: string): string {
  if (!FLASH_KEY_PATTERN.test(key) || UNSAFE_FLASH_KEYS.has(key)) {
    throw new Error('[@holo-js/session] Flash keys must be 1-128 safe alphanumeric, dot, colon, dash, or underscore characters and start with a letter.')
  }
  return key
}

function normalizeFlashValue(value: unknown): unknown {
  const ancestors = new Set<object>()
  const normalize = (candidate: unknown, depth = 0): unknown => {
    if (candidate === null || typeof candidate === 'boolean' || typeof candidate === 'string') return candidate
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new Error('[@holo-js/session] Flash values require finite JSON numbers.')
      return candidate
    }
    if (typeof candidate !== 'object') throw new Error('[@holo-js/session] Flash values must contain only JSON-safe values.')
    if (ancestors.has(candidate)) throw new Error('[@holo-js/session] Flash values cannot contain circular references.')
    if (depth >= FLASH_VALUE_MAX_DEPTH) throw new Error('[@holo-js/session] Flash values cannot exceed 32 levels of nesting.')
    const prototype = Object.getPrototypeOf(candidate)
    if (!Array.isArray(candidate) && prototype !== Object.prototype && prototype !== null) {
      throw new Error('[@holo-js/session] Flash values cannot contain class instances.')
    }
    ancestors.add(candidate)
    try {
      if (Array.isArray(candidate)) {
        const normalized: unknown[] = []
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index))
          if (!descriptor) throw new Error('[@holo-js/session] Flash values cannot contain sparse arrays.')
          if (!('value' in descriptor)) throw new Error('[@holo-js/session] Flash values cannot contain accessors.')
          normalized.push(normalize(descriptor.value, depth + 1))
        }
        return normalized
      }

      const entries: Array<readonly [string, unknown]> = []
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key !== 'string') throw new Error('[@holo-js/session] Flash values must contain only JSON-safe values.')
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key)
        if (!descriptor?.enumerable) continue
        if (!('value' in descriptor)) throw new Error('[@holo-js/session] Flash values cannot contain accessors.')
        entries.push([key, normalize(descriptor.value, depth + 1)])
      }
      return Object.fromEntries(entries)
    } finally {
      ancestors.delete(candidate)
    }
  }
  const encoded = JSON.stringify(normalize(value))
  if (encoded === undefined) throw new Error('[@holo-js/session] Flash values must contain only JSON-safe values.')
  if (new TextEncoder().encode(encoded).byteLength > FLASH_VALUE_MAX_BYTES) {
    throw new Error('[@holo-js/session] Flash values cannot exceed 64 KiB.')
  }
  return JSON.parse(encoded) as unknown
}

function createRememberSecret(): string {
  return randomBytes(24).toString('base64url')
}

function createRememberTokenIssuedAt(): string {
  return Date.now().toString(36)
}

function parseRememberTokenIssuedAt(value: string): number | null {
  const parsed = Number.parseInt(value, 36)
  return Number.isFinite(parsed) ? parsed : null
}

function parseRememberMeToken(
  token: string,
): {
  readonly sessionId: string
  readonly secretPayload: string
  readonly issuedAt?: number
} | null {
  const firstSeparator = token.indexOf('.')
  if (firstSeparator <= 0) {
    return null
  }

  const secondSeparator = token.indexOf('.', firstSeparator + 1)
  if (secondSeparator <= firstSeparator + 1) {
    const sessionId = token.slice(0, firstSeparator)
    const secret = token.slice(firstSeparator + 1)
    return sessionId && secret
      ? { sessionId, secretPayload: secret }
      : null
  }

  const sessionId = token.slice(0, firstSeparator)
  const issuedAtRaw = token.slice(firstSeparator + 1, secondSeparator)
  const secret = token.slice(secondSeparator + 1)
  const issuedAt = parseRememberTokenIssuedAt(issuedAtRaw)
  if (!sessionId || !issuedAtRaw || !secret || issuedAt === null) {
    return null
  }

  return {
    sessionId,
    secretPayload: `${issuedAtRaw}.${secret}`,
    issuedAt,
  }
}

function decodeCookiePart(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function normalizeCookieOptions(options: CookieSerializeOptions = {}): Required<Omit<CookieSerializeOptions, 'domain' | 'expires'>> & Pick<CookieSerializeOptions, 'domain' | 'expires'> {
  const config = getSessionRuntimeState().bindings?.config.cookie
  return {
    path: options.path ?? config?.path ?? '/',
    domain: options.domain ?? config?.domain,
    secure: options.secure ?? config?.secure ?? false,
    httpOnly: options.httpOnly ?? config?.httpOnly ?? true,
    sameSite: options.sameSite ?? config?.sameSite ?? 'lax',
    partitioned: options.partitioned ?? config?.partitioned ?? false,
    maxAge: options.maxAge ?? ((config?.maxAge ?? 0) * 60),
    expires: options.expires,
  }
}

function containsInvalidCookieAttributeCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!
    return character === ';' || codePoint <= 31 || codePoint === 127
  })
}

export function serializeCookie(name: string, value: string, options: CookieSerializeOptions = {}): string {
  if (!name.trim()) {
    throw new Error('[@holo-js/session] Cookie name must be a non-empty string.')
  }

  const normalized = normalizeCookieOptions(options)
  if (!normalized.path.startsWith('/') || containsInvalidCookieAttributeCharacter(normalized.path)) {
    throw new Error('[@holo-js/session] Cookie path must start with "/" and must not contain control characters or semicolons.')
  }
  if (normalized.domain && (!/^\.?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(normalized.domain) || normalized.domain.includes('..'))) {
    throw new Error('[@holo-js/session] Cookie domain must be a valid hostname.')
  }
  if (normalized.sameSite === 'none' && !normalized.secure) {
    throw new Error('[@holo-js/session] SameSite=None cookies must use Secure.')
  }
  if (normalized.partitioned && !normalized.secure) {
    throw new Error('[@holo-js/session] Partitioned cookies must use Secure.')
  }
  if (name.startsWith('__Secure-') && !normalized.secure) {
    throw new Error('[@holo-js/session] __Secure- cookies must use Secure.')
  }
  if (name.startsWith('__Host-') && (!normalized.secure || normalized.domain || normalized.path !== '/')) {
    throw new Error('[@holo-js/session] __Host- cookies must use Secure, Path=/, and no Domain.')
  }
  const attributes = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    `Path=${normalized.path}`,
  ]

  if (normalized.domain) {
    attributes.push(`Domain=${normalized.domain}`)
  }
  if (normalized.maxAge > 0 || options.maxAge === 0) {
    attributes.push(`Max-Age=${normalized.maxAge}`)
  }
  if (normalized.expires) {
    attributes.push(`Expires=${normalized.expires.toUTCString()}`)
  }
  if (normalized.secure) {
    attributes.push('Secure')
  }
  if (normalized.httpOnly) {
    attributes.push('HttpOnly')
  }
  attributes.push(`SameSite=${normalized.sameSite[0]!.toUpperCase()}${normalized.sameSite.slice(1)}`)
  if (normalized.partitioned) {
    attributes.push('Partitioned')
  }

  return attributes.join('; ')
}

export function parseCookieHeader(header: string | null | undefined): Readonly<Record<string, string>> {
  if (!header) {
    return Object.freeze({})
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
      if (key === null || value === null) {
        return undefined
      }

      return [key, value] as const
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry))

  return Object.freeze(Object.fromEntries(entries))
}

function isExpired(record: SessionRecord): boolean {
  return record.expiresAt.getTime() <= Date.now()
}

async function readRecordFromStore(
  sessionId: string,
  store: SessionStore,
): Promise<SessionRecord | null> {
  const record = await store.read(sessionId)
  if (!record) {
    return null
  }

  if (isExpired(record)) {
    await store.delete(sessionId)
    return null
  }

  return record
}

async function readRecord(sessionId: string, options?: ReadSessionOptions): Promise<SessionRecord | null> {
  const { store } = getStore(options?.store)
  return readRecordFromStore(sessionId, store)
}

async function locateRecord(
  sessionId: string,
): Promise<{
  readonly record: SessionRecord
  readonly store: SessionStore
} | null> {
  const bindings = getSessionRuntimeBindings()

  for (const store of Object.values(bindings.stores)) {
    const record = await readRecordFromStore(sessionId, store)
    if (record) {
      return {
        record,
        store,
      }
    }
  }

  return null
}

export async function createSession(input: CreateSessionInput = {}): Promise<SessionRecord> {
  const { name, store, config } = getStore(input.store)
  const currentTime = now()
  const idleExpiry = createExpiryDate(config.idleTimeout)
  const absoluteExpiry = createExpiryDate(config.absoluteLifetime)
  const record: SessionRecord = Object.freeze({
    id: normalizeSessionKey(input),
    store: name,
    data: normalizeSessionData(input),
    createdAt: ensureDate(currentTime),
    lastActivityAt: ensureDate(currentTime),
    expiresAt: idleExpiry.getTime() < absoluteExpiry.getTime() ? idleExpiry : absoluteExpiry,
  })

  await store.write(record)
  return record
}

export async function writeSession(record: SessionRecord): Promise<SessionRecord> {
  const { name, store } = getStore(record.store)
  const nextRecord: SessionRecord = Object.freeze({
    ...record,
    store: name,
    data: Object.freeze({ ...record.data }),
    createdAt: ensureDate(record.createdAt),
    lastActivityAt: ensureDate(record.lastActivityAt),
    expiresAt: ensureDate(record.expiresAt),
  })

  await store.write(nextRecord)
  return nextRecord
}

export async function readSession(sessionId: string, options?: ReadSessionOptions): Promise<SessionRecord | null> {
  return readRecord(sessionId, options)
}

export async function touchSession(sessionId: string, options?: TouchSessionOptions): Promise<SessionRecord | null> {
  const record = await readRecord(sessionId, options)
  if (!record) {
    return null
  }

  const { store, config } = getStore(options?.store ?? record.store)
  const idleExpiry = createExpiryDate(config.idleTimeout)
  const absoluteExpiry = new Date(record.createdAt.getTime() + (config.absoluteLifetime * 60_000))
  const touched: SessionRecord = Object.freeze({
    ...record,
    lastActivityAt: now(),
    expiresAt: idleExpiry.getTime() < absoluteExpiry.getTime() ? idleExpiry : absoluteExpiry,
  })
  await store.write(touched)
  return touched
}

export async function rotateSession(sessionId: string, options: RotateSessionOptions = {}): Promise<SessionRecord> {
  const located = await locateRecord(sessionId)
  if (!located) {
    throw new Error(`[@holo-js/session] Session "${sessionId}" was not found.`)
  }

  const { store, name } = getStore(options.store ?? located.record.store)
  const rotated: SessionRecord = Object.freeze({
    ...located.record,
    id: options.newId?.trim() || createSessionId(),
    store: name,
  })
  if (located.store !== store) {
    if (located.store.flash || located.store.take) {
      throw new Error('[@holo-js/session] Sessions with private flash state cannot be rotated between stores.')
    }
    await store.write(rotated)
    await located.store.delete(sessionId)
    return rotated
  }
  if (rotated.id !== sessionId) {
    if (!store.rotate) {
      if (store.flash || store.take) {
        throw new Error(`[@holo-js/session] Session store "${name}" does not support private-state-preserving rotation.`)
      }
      await store.write(rotated)
      await store.delete(sessionId)
      return rotated
    }
    await store.rotate(sessionId, rotated)
    return rotated
  }
  await store.write(rotated)
  return rotated
}

export async function invalidateSession(sessionId: string, options?: ReadSessionOptions): Promise<void> {
  const { store } = getStore(options?.store)
  await store.delete(sessionId)
}

export async function flashSession(sessionId: string, key: string, value: unknown, options?: ReadSessionOptions): Promise<void> {
  const { name, store } = getStore(options?.store)
  if (!store.flash) throw new Error(`[@holo-js/session] Session store "${name}" does not support atomic flash operations.`)
  await store.flash(sessionId, normalizeFlashKey(key), normalizeFlashValue(value))
}

export async function takeSession<TValue = unknown>(sessionId: string, key: string, options?: ReadSessionOptions): Promise<TValue | undefined> {
  const { name, store } = getStore(options?.store)
  if (!store.take) throw new Error(`[@holo-js/session] Session store "${name}" does not support atomic flash operations.`)
  const result = await store.take(sessionId, normalizeFlashKey(key))
  if (!result.found) return undefined
  return normalizeFlashValue(result.value) as TValue
}

export async function issueRememberMeToken(sessionId: string, options?: RememberTokenOptions): Promise<string> {
  const record = await readRecord(sessionId, options)
  if (!record) {
    throw new Error(`[@holo-js/session] Session "${sessionId}" was not found.`)
  }

  const { store } = getStore(options?.store ?? record.store)
  const issuedAt = createRememberTokenIssuedAt()
  const secret = createRememberSecret()
  const updated: SessionRecord = Object.freeze({
    ...record,
    rememberTokenHash: hashRememberToken(`${issuedAt}.${secret}`),
  })
  await store.write(updated)
  return `${record.id}.${issuedAt}.${secret}`
}

export async function consumeRememberMeToken(token: string, options?: RememberTokenOptions): Promise<SessionRecord | null> {
  const parsed = parseRememberMeToken(token)
  if (!parsed) {
    return null
  }

  const bindings = getSessionRuntimeBindings()
  const stores = options?.store
    ? [getStore(options.store).store]
    : Object.values(bindings.stores)

  if (parsed.issuedAt) {
    const rememberExpiry = parsed.issuedAt + (getSessionRuntimeBindings().config.rememberMeLifetime * 60_000)
    if (rememberExpiry <= Date.now()) {
      return null
    }
  }

  const tokenHash = hashRememberToken(parsed.secretPayload)
  for (const store of stores) {
    const record = await readRecordFromStore(parsed.sessionId, store)
    if (record?.rememberTokenHash === tokenHash) {
      return record
    }
  }

  return null
}

export const cookies = Object.freeze({
  make(name: string, value: string, options?: CookieSerializeOptions): string {
    return serializeCookie(name, value, options)
  },
  forget(name: string, options: CookieSerializeOptions = {}): string {
    return serializeCookie(name, '', {
      ...options,
      expires: new Date(0),
      maxAge: 0,
    })
  },
})

export function cookie(name: string, value: string, options?: CookieSerializeOptions): string {
  return cookies.make(name, value, options)
}

export function sessionCookie(value: string, options?: CookieSerializeOptions): string {
  const name = getSessionRuntimeState().bindings?.config.cookie.name ?? 'holo_session'
  return cookie(name, value, options)
}

export function rememberMeCookie(value: string, options?: CookieSerializeOptions): string {
  const bindings = getSessionRuntimeState().bindings
  const name = `${bindings?.config.cookie.name ?? 'holo_session'}_remember`
  const maxAge = options?.maxAge ?? ((bindings?.config.rememberMeLifetime ?? 0) * 60)
  return cookie(name, value, {
    ...options,
    maxAge,
  })
}

export function configureSessionRuntime(bindings?: SessionRuntimeBindings): void {
  getSessionRuntimeState().bindings = bindings
}

export function getSessionRuntime(): SessionRuntimeFacade {
  return {
    create: createSession,
    write: writeSession,
    read: readSession,
    rotate: rotateSession,
    invalidate: invalidateSession,
    touch: touchSession,
    issueRememberMeToken,
    consumeRememberMeToken,
    flash: flashSession,
    take: takeSession,
    cookie,
    sessionCookie,
    rememberMeCookie,
  }
}

export function resetSessionRuntime(): void {
  getSessionRuntimeState().bindings = undefined
}

export const sessionRuntimeInternals = {
  createRememberSecret,
  createSessionId,
  getSessionRuntimeBindings,
  hashRememberToken,
  isExpired,
  normalizeFlashKey,
  normalizeFlashValue,
  normalizeCookieOptions,
}
