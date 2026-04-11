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

export function serializeCookie(name: string, value: string, options: CookieSerializeOptions = {}): string {
  if (!name.trim()) {
    throw new Error('[@holo-js/session] Cookie name must be a non-empty string.')
  }

  const normalized = normalizeCookieOptions(options)
  const attributes = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    `Path=${normalized.path}`,
  ]

  if (normalized.domain) {
    attributes.push(`Domain=${normalized.domain}`)
  }
  if (normalized.maxAge > 0) {
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

      const key = decodeURIComponent(segment.slice(0, separator))
      const value = decodeURIComponent(segment.slice(separator + 1))
      return [key, value] as const
    })
    .filter((entry): entry is readonly [string, string] => !!entry)

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
  readonly storeName: string
  readonly store: SessionStore
} | null> {
  const bindings = getSessionRuntimeBindings()

  for (const [storeName, store] of Object.entries(bindings.stores)) {
    const record = await readRecordFromStore(sessionId, store)
    if (record) {
      return {
        record,
        storeName,
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
    data: Object.freeze({ ...(record.data ?? {}) }),
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
  await store.write(rotated)
  if (located.storeName !== name || rotated.id !== sessionId) {
    await located.store.delete(sessionId)
  }
  return rotated
}

export async function invalidateSession(sessionId: string, options?: ReadSessionOptions): Promise<void> {
  const { store } = getStore(options?.store)
  await store.delete(sessionId)
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
  let record: SessionRecord | null = null
  for (const store of stores) {
    record = await store.read(parsed.sessionId)
    if (record) {
      break
    }
  }

  if (!record?.rememberTokenHash) {
    return null
  }

  if (parsed.issuedAt) {
    const rememberExpiry = parsed.issuedAt + (getSessionRuntimeBindings().config.rememberMeLifetime * 60_000)
    if (rememberExpiry <= Date.now()) {
      return null
    }
  }

  return record.rememberTokenHash === hashRememberToken(parsed.secretPayload) ? record : null
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
  normalizeCookieOptions,
}
