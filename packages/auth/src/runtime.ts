import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, createHmac, randomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { normalizeAuthConfig } from '@holo-js/config'
import type {
  AuthCredentials,
  AuthCurrentAccessToken,
  AuthDeliveryHook,
  AuthEmailVerificationFacade,
  AuthEstablishedSession,
  AuthFacade,
  AuthGuardFacade,
  AuthImpersonationOptions,
  AuthImpersonationState,
  AuthLogoutResult,
  AuthPasswordResetFacade,
  AuthPasswordHasher,
  AuthRegistrationInput,
  AuthSessionLoginOptions,
  AuthTokenFacade,
  AuthTokenStore,
  AuthUser,
  AuthRuntimeBindings,
  AuthRuntimeContext,
  AuthRuntimeFacade,
  AuthSessionRecord,
  EmailVerificationTokenRecord,
  EmailVerificationTokenResult,
  EmailVerificationTokenStore,
  PersonalAccessTokenCreationOptions,
  PersonalAccessTokenRecord,
  PersonalAccessTokenResult,
  PasswordResetTokenRecord,
  PasswordResetTokenStore,
} from './contracts'

const scrypt = promisify(nodeScrypt)
const SCRYPT_PREFIX = 'scrypt'
const TOKEN_HASH_PREFIX = 'sha256'
const AUTH_PROVIDER_MARKER = Symbol.for('holo-js.auth.provider')

type SerializedAuthUser = AuthUser & {
  readonly id: string | number
}

type ErasedAuthProviderAdapter = {
  findById(id: string | number): Promise<unknown | null>
  findByCredentials(credentials: Readonly<Record<string, unknown>>): Promise<unknown | null>
  create(input: Readonly<Record<string, unknown>>): Promise<unknown>
  update?(user: unknown, input: Readonly<Record<string, unknown>>): Promise<unknown>
  matchesUser?(user: unknown): boolean
  getId(user: unknown): string | number
  getPasswordHash?(user: unknown): string | null | undefined
  getEmailVerifiedAt?(user: unknown): Date | string | null | undefined
  serialize?(user: unknown): AuthUser
}

type SessionIdentityPayload = {
  readonly guard: string
  readonly provider: string
  readonly userId: string | number
  readonly user: SerializedAuthUser
}

type SessionImpersonationPayload = {
  readonly actor: SessionIdentityPayload
  readonly original?: SessionIdentityPayload
  readonly startedAt: string
}

type SessionAuthPayload = SessionIdentityPayload & {
  readonly impersonation?: SessionImpersonationPayload
}

type SessionAuthPayloadMap = Readonly<Record<string, SessionAuthPayload>>

type MemoryAuthContext = AuthRuntimeContext & {
  readonly sessionIds: Map<string, string>
  readonly cachedUsers: Map<string, AuthUser | null>
  readonly accessTokens: Map<string, string>
  readonly rememberTokens: Map<string, string>
  getAccessToken(guardName: string): string | undefined
  setAccessToken(guardName: string, token?: string): void
  getRememberToken(guardName: string): string | undefined
  setRememberToken(guardName: string, token?: string): void
}

type AsyncAuthContext = AuthRuntimeContext & {
  activate(): void
}

type RuntimeBindings = {
  readonly config: ReturnType<typeof normalizeAuthConfig>
  readonly session: AuthRuntimeBindings['session']
  readonly providers: Readonly<Record<string, ErasedAuthProviderAdapter>>
  readonly tokens?: AuthTokenStore
  readonly emailVerificationTokens?: EmailVerificationTokenStore
  readonly passwordResetTokens?: PasswordResetTokenStore
  readonly delivery: AuthDeliveryHook
  readonly context: AuthRuntimeContext
  readonly passwordHasher: AuthPasswordHasher
}

type OptionalSecurityRateLimitStore = {
  hit(
    key: string,
    options: { readonly maxAttempts: number, readonly decaySeconds: number },
  ): Promise<{ readonly limited: boolean }>
  clear?(key: string): Promise<boolean>
}

type OptionalSecurityModule = {
  getSecurityRuntimeBindings?(): {
    readonly rateLimitStore?: OptionalSecurityRateLimitStore
    readonly csrfSigningKey?: string
  } | undefined
}

let optionalSecurityModulePromise: Promise<OptionalSecurityModule | undefined> | undefined

function getAuthRuntimeState(): {
  bindings?: RuntimeBindings
  sharedPasswordResetThrottleFailures?: Set<string>
} {
  const runtime = globalThis as typeof globalThis & {
    __holoAuthRuntime__?: {
      bindings?: RuntimeBindings
      sharedPasswordResetThrottleFailures?: Set<string>
    }
  }

  runtime.__holoAuthRuntime__ ??= {}
  return runtime.__holoAuthRuntime__
}

function getOptionalSecurityModuleOverride(): OptionalSecurityModule | undefined {
  const runtime = globalThis as typeof globalThis & {
    __holoAuthSecurityModule__?: OptionalSecurityModule
  }

  return runtime.__holoAuthSecurityModule__
}

function getOptionalSecurityImportOverride(): (() => Promise<unknown>) | undefined {
  const runtime = globalThis as typeof globalThis & {
    __holoAuthSecurityImport__?: () => Promise<unknown>
  }

  return runtime.__holoAuthSecurityImport__
}

function isMissingOptionalPackageError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message
  const mentionsSecurityPackage = message.includes('@holo-js/security')

  return mentionsSecurityPackage && (
    message.includes('Cannot find package')
    || message.includes('Cannot find module')
    || message.includes('Failed to resolve module specifier')
    || message.includes('Failed to load url')
    || message.includes('Could not resolve')
  )
}

async function loadOptionalSecurityModule(): Promise<OptionalSecurityModule | undefined> {
  const override = getOptionalSecurityModuleOverride()
  if (override) {
    return override
  }

  const importOverride = getOptionalSecurityImportOverride()
  optionalSecurityModulePromise ??= (importOverride
    ? importOverride()
    : import('@holo-js/security' as string))
    .then(module => module as OptionalSecurityModule)
    .catch(async (error) => {
      optionalSecurityModulePromise = undefined

      if (isMissingOptionalPackageError(error)) {
        return undefined
      }

      throw error
    })

  return await optionalSecurityModulePromise
}

function throwUnconfigured(): never {
  throw new Error('[@holo-js/auth] Auth runtime is not configured yet.')
}

function getRuntimeBindings(): RuntimeBindings {
  const bindings = getAuthRuntimeState().bindings
  if (!bindings) {
    throwUnconfigured()
  }

  return bindings
}

function getExposedRuntimeBindings(): {
  readonly config: RuntimeBindings['config']
  readonly session: AuthRuntimeBindings['session']
  readonly providers: AuthRuntimeBindings['providers']
  readonly tokens?: AuthTokenStore
  readonly emailVerificationTokens?: EmailVerificationTokenStore
  readonly passwordResetTokens?: PasswordResetTokenStore
  readonly delivery: AuthDeliveryHook
  readonly context: AuthRuntimeContext
  readonly passwordHasher: AuthPasswordHasher
} {
  const bindings = getRuntimeBindings()

  return {
    ...bindings,
    providers: bindings.providers as unknown as AuthRuntimeBindings['providers'],
  }
}

function createDefaultPasswordHasher(): AuthPasswordHasher {
  return {
    async hash(password: string): Promise<string> {
      const salt = randomBytes(16)
      const derived = await scrypt(password, salt, 64) as Buffer
      return `${SCRYPT_PREFIX}$${salt.toString('hex')}$${derived.toString('hex')}`
    },
    async verify(password: string, digest: string): Promise<boolean> {
      const [prefix, saltHex, hashHex] = digest.split('$')
      if (prefix !== SCRYPT_PREFIX || !saltHex || !hashHex) {
        return false
      }

      const salt = Buffer.from(saltHex, 'hex')
      const expected = Buffer.from(hashHex, 'hex')
      const derived = await scrypt(password, salt, expected.length) as Buffer
      return derived.length === expected.length && timingSafeEqual(derived, expected)
    },
    needsRehash() {
      return false
    },
  }
}

function requireRecordValue(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error(message)
  }

  return value as Record<string, unknown>
}

async function resolveNeedsPasswordRehash(
  hasher: AuthPasswordHasher,
  digest: string,
): Promise<boolean> {
  if (!hasher.needsRehash) {
    return false
  }

  return await hasher.needsRehash(digest)
}

function hashTokenSecret(secret: string): string {
  return `${TOKEN_HASH_PREFIX}$${createHash('sha256').update(secret).digest('hex')}`
}

type CookieOptions = {
  readonly path?: string
  readonly domain?: string
  readonly secure?: boolean
  readonly httpOnly?: boolean
  readonly sameSite?: 'lax' | 'strict' | 'none'
  readonly partitioned?: boolean
}

type CookieSerializationOptions = CookieOptions & {
  readonly expires?: Date
  readonly maxAge?: number
}

function verifyTokenSecret(secret: string, digest: string): boolean {
  const [prefix, hashHex] = digest.split('$')
  if (prefix !== TOKEN_HASH_PREFIX || !hashHex) {
    return false
  }

  const expected = Buffer.from(hashHex, 'hex')
  const actual = createHash('sha256').update(secret).digest()
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function createPasswordResetThrottleKey(
  namespace: string | undefined,
  brokerName: string,
  provider: string,
  table: string,
  email: string,
  csrfSigningKey?: string,
): string {
  const namespacePrefix = namespace ? `${namespace}:` : ''
  const canonicalEmail = email.trim().toLowerCase()
  const normalizedSigningKey = csrfSigningKey?.trim()
  const emailHash = normalizedSigningKey
    ? createHmac('sha256', normalizedSigningKey).update(canonicalEmail).digest('hex')
    : createHash('sha256').update(canonicalEmail).digest('hex')
  return `auth:password-reset:${namespacePrefix}${brokerName}:${provider}:${table}:${emailHash}`
}

async function clearSharedPasswordResetThrottleReservation(
  sharedReservation: {
    readonly key: string
    readonly limited: boolean
    readonly store: OptionalSecurityRateLimitStore
    readonly bypassed: boolean
  } | undefined,
): Promise<'cleared' | 'unsupported' | 'failed'> {
  if (!sharedReservation?.store.clear) {
    return 'unsupported'
  }

  try {
    await sharedReservation.store.clear(sharedReservation.key)
    return 'cleared'
  } catch (error) {
    console.warn('[@holo-js/auth] Failed to clear a password reset reservation after use.', error)
    return 'failed'
  }
}

function createPasswordResetThrottleNamespace(csrfSigningKey: string | undefined): string | undefined {
  const normalized = csrfSigningKey?.trim()
  if (!normalized) {
    return undefined
  }

  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

async function reserveSharedPasswordResetThrottle(
  brokerName: string,
  broker: { readonly provider: string, readonly table: string, readonly throttle: number },
  email: string,
): Promise<{
  readonly key: string
  readonly limited: boolean
  readonly store: OptionalSecurityRateLimitStore
  readonly bypassed: boolean
} | undefined> {
  if (broker.throttle < 1) {
    return undefined
  }

  const security = await loadOptionalSecurityModule()
  const bindings = security?.getSecurityRuntimeBindings?.()
  const store = bindings?.rateLimitStore
  if (!store) {
    return undefined
  }

  const key = createPasswordResetThrottleKey(
    createPasswordResetThrottleNamespace(bindings?.csrfSigningKey),
    brokerName,
    broker.provider,
    broker.table,
    email,
    bindings?.csrfSigningKey,
  )
  const failures = getAuthRuntimeState().sharedPasswordResetThrottleFailures ??= new Set<string>()
  if (failures.has(key)) {
    return {
      key,
      limited: false,
      store,
      bypassed: true,
    }
  }

  const result = await store.hit(key, {
    maxAttempts: 1,
    decaySeconds: broker.throttle * 60,
  })

  return {
    key,
    limited: result.limited,
    store,
    bypassed: false,
  }
}

function parseSetCookieDefinition(header: string): {
  readonly name: string
  readonly options: CookieOptions
} | null {
  const [nameValue, ...attributes] = header.split(';')
  /* v8 ignore next -- split() always yields a first string element for string input. */
  const separator = nameValue?.indexOf('=') ?? -1
  if (!nameValue || separator <= 0) {
    return null
  }

  const options: {
    path?: string
    domain?: string
    secure?: boolean
    httpOnly?: boolean
    sameSite?: 'lax' | 'strict' | 'none'
    partitioned?: boolean
  } = {}

  for (const rawAttribute of attributes) {
    const attribute = rawAttribute.trim()
    if (!attribute) {
      continue
    }

    const attributeSeparator = attribute.indexOf('=')
    const key = (attributeSeparator === -1 ? attribute : attribute.slice(0, attributeSeparator)).trim().toLowerCase()
    const value = attributeSeparator === -1 ? '' : attribute.slice(attributeSeparator + 1).trim()

    switch (key) {
      case 'path':
        options.path = value
        break
      case 'domain':
        options.domain = value
        break
      case 'secure':
        options.secure = true
        break
      case 'httponly':
        options.httpOnly = true
        break
      case 'samesite':
        if (value.toLowerCase() === 'lax' || value.toLowerCase() === 'strict' || value.toLowerCase() === 'none') {
          options.sameSite = value.toLowerCase() as CookieOptions['sameSite']
        }
        break
      case 'partitioned':
        options.partitioned = true
        break
    }
  }

  return {
    name: decodeURIComponent(nameValue.slice(0, separator)),
    options,
  }
}

function serializeCookie(
  name: string,
  value: string,
  options: CookieSerializationOptions = {},
): string {
  const attributes = [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? '/'}`,
  ]

  if (options.domain) {
    attributes.push(`Domain=${options.domain}`)
  }
  if ((options.maxAge ?? 0) > 0) {
    attributes.push(`Max-Age=${options.maxAge}`)
  }
  if (options.expires) {
    attributes.push(`Expires=${options.expires.toUTCString()}`)
  }
  if (options.secure) {
    attributes.push('Secure')
  }
  if (options.httpOnly) {
    attributes.push('HttpOnly')
  }
  if (options.sameSite) {
    attributes.push(`SameSite=${options.sameSite[0]!.toUpperCase()}${options.sameSite.slice(1)}`)
  }
  if (options.partitioned) {
    attributes.push('Partitioned')
  }

  return attributes.join('; ')
}

function forgetCookie(
  bindings: RuntimeBindings,
  name: string,
  options: CookieOptions = {},
): string {
  const cookieOptions = {
    ...options,
    expires: new Date(0),
    maxAge: 0,
  } satisfies CookieSerializationOptions

  if (bindings.session.cookie) {
    return bindings.session.cookie(name, '', cookieOptions)
  }

  return serializeCookie(name, '', cookieOptions)
}

function getHostedSessionCookieNamesForGuard(
  config: RuntimeBindings['config'],
  guardName: string,
): readonly string[] {
  const names = new Set<string>()
  for (const provider of Object.values(config.workos)) {
    if ((provider.guard ?? config.defaults.guard) === guardName) {
      names.add(provider.sessionCookie)
    }
  }
  for (const provider of Object.values(config.clerk)) {
    if ((provider.guard ?? config.defaults.guard) === guardName) {
      names.add(provider.sessionCookie)
    }
  }

  return [...names]
}

function buildLogoutCookies(
  bindings: RuntimeBindings,
  guardName: string,
  options: {
    readonly clearSessionCookies: boolean
  },
): readonly string[] {
  const cookies: string[] = []
  const defaultSessionCookie = parseSetCookieDefinition(bindings.session.sessionCookie(''))
  const defaultRememberCookie = parseSetCookieDefinition(bindings.session.rememberMeCookie(''))

  if (options.clearSessionCookies) {
    if (defaultSessionCookie) {
      cookies.push(forgetCookie(bindings, defaultSessionCookie.name, defaultSessionCookie.options))
    }
    if (defaultRememberCookie) {
      cookies.push(forgetCookie(bindings, defaultRememberCookie.name, defaultRememberCookie.options))
    }
  }

  const hostedCookieOptions: CookieOptions = {
    path: '/',
    domain: '',
  }
  for (const cookieName of getHostedSessionCookieNamesForGuard(bindings.config, guardName)) {
    cookies.push(forgetCookie(bindings, cookieName, hostedCookieOptions))
  }

  return Object.freeze([...new Set(cookies)])
}

function createPersonalAccessTokenId(): string {
  return randomUUID()
}

function createPersonalAccessTokenSecret(): string {
  return randomBytes(24).toString('base64url')
}

function createLifecycleTokenResult<TRecord extends {
  readonly id: string
  readonly provider: string
  readonly createdAt: Date
  readonly expiresAt: Date
}>(record: TRecord, plainTextToken: string): TRecord & { readonly plainTextToken: string } {
  return Object.freeze({
    ...record,
    createdAt: new Date(record.createdAt.getTime()),
    expiresAt: new Date(record.expiresAt.getTime()),
    plainTextToken,
  })
}

function createDefaultDeliveryHook(): AuthDeliveryHook {
  return {
    async sendEmailVerification(input) {
      console.warn(
        `[@holo-js/auth] Email verification delivery is not configured. ` +
        `Skipped delivery for ${input.email} using token ${input.token.id}.`,
      )
    },
    async sendPasswordReset(input) {
      console.warn(
        `[@holo-js/auth] Password reset delivery is not configured. ` +
        `Skipped delivery for ${input.email} using token ${input.token.id}.`,
      )
    },
  }
}

function ensureTokenStore(): AuthTokenStore {
  const bindings = getRuntimeBindings()
  if (!bindings.tokens) {
    throw new Error('[@holo-js/auth] Personal access token runtime is not configured yet.')
  }

  return bindings.tokens
}

function ensureEmailVerificationTokenStore(): EmailVerificationTokenStore {
  const bindings = getRuntimeBindings()
  if (!bindings.emailVerificationTokens) {
    throw new Error('[@holo-js/auth] Email verification token runtime is not configured yet.')
  }

  return bindings.emailVerificationTokens
}

function ensurePasswordResetTokenStore(): PasswordResetTokenStore {
  const bindings = getRuntimeBindings()
  if (!bindings.passwordResetTokens) {
    throw new Error('[@holo-js/auth] Password reset token runtime is not configured yet.')
  }

  return bindings.passwordResetTokens
}

export function createMemoryAuthContext(): MemoryAuthContext {
  const sessionIds = new Map<string, string>()
  const cachedUsers = new Map<string, AuthUser | null>()
  const accessTokens = new Map<string, string>()
  const rememberTokens = new Map<string, string>()

  return {
    sessionIds,
    cachedUsers,
    accessTokens,
    rememberTokens,
    getSessionId(guardName) {
      return sessionIds.get(guardName)
    },
    setSessionId(guardName, sessionId) {
      if (!sessionId) {
        sessionIds.delete(guardName)
        return
      }

      sessionIds.set(guardName, sessionId)
    },
    getCachedUser(guardName) {
      return cachedUsers.get(guardName)
    },
    setCachedUser(guardName, user) {
      cachedUsers.set(guardName, user)
    },
    getAccessToken(guardName) {
      return accessTokens.get(guardName)
    },
    setAccessToken(guardName, token) {
      if (!token) {
        accessTokens.delete(guardName)
        return
      }

      accessTokens.set(guardName, token)
    },
    getRememberToken(guardName) {
      return rememberTokens.get(guardName)
    },
    setRememberToken(guardName, token) {
      if (!token) {
        rememberTokens.delete(guardName)
        return
      }

      rememberTokens.set(guardName, token)
    },
  }
}

export function createAsyncAuthContext(): AsyncAuthContext {
  const storage = new AsyncLocalStorage<MemoryAuthContext>()
  const resolveContext = (): MemoryAuthContext => {
    const existing = storage.getStore()
    if (existing) {
      return existing
    }

    const created = createMemoryAuthContext()
    storage.enterWith(created)
    return created
  }

  return {
    activate() {
      resolveContext()
    },
    getSessionId(guardName) {
      return resolveContext().getSessionId(guardName)
    },
    setSessionId(guardName, sessionId) {
      resolveContext().setSessionId(guardName, sessionId)
    },
    getCachedUser(guardName) {
      return resolveContext().getCachedUser(guardName)
    },
    setCachedUser(guardName, user) {
      resolveContext().setCachedUser(guardName, user)
    },
    getAccessToken(guardName) {
      return resolveContext().getAccessToken?.(guardName)
    },
    setAccessToken(guardName, token) {
      resolveContext().setAccessToken?.(guardName, token)
    },
    getRememberToken(guardName) {
      return resolveContext().getRememberToken?.(guardName)
    },
    setRememberToken(guardName, token) {
      resolveContext().setRememberToken?.(guardName, token)
    },
  }
}

function getGuardConfig(guardName: string): RuntimeBindings['config']['guards'][string] {
  const bindings = getRuntimeBindings()
  const guard = bindings.config.guards[guardName]
  if (!guard) {
    throw new Error(`[@holo-js/auth] Auth guard "${guardName}" is not configured.`)
  }

  return guard
}

function getProviderAdapter(
  providerName: string,
): {
  readonly config: RuntimeBindings['config']['providers'][string]
  readonly adapter: ErasedAuthProviderAdapter
} {
  const bindings = getRuntimeBindings()
  const providerConfig = bindings.config.providers[providerName]
  if (!providerConfig) {
    throw new Error(`[@holo-js/auth] Auth provider "${providerName}" is not configured.`)
  }

  const adapter = bindings.providers[providerName]
  if (!adapter) {
    throw new Error(`[@holo-js/auth] Auth provider runtime "${providerName}" is not configured.`)
  }

  return {
    config: providerConfig,
    adapter,
  }
}

function readMarkedProvider(user: unknown): string | undefined {
  if (!user || typeof user !== 'object') {
    return undefined
  }

  const marker = (user as Record<PropertyKey, unknown>)[AUTH_PROVIDER_MARKER]
  return typeof marker === 'string' ? marker : undefined
}

function requireUserRecord(user: unknown, message: string): Record<string, unknown> {
  if (!user || typeof user !== 'object') {
    throw new Error(message)
  }

  return user as Record<string, unknown>
}

function getGuardProviderAdapter(
  guardName: string,
): {
  readonly guard: RuntimeBindings['config']['guards'][string]
  readonly adapter: ErasedAuthProviderAdapter
  readonly provider: string
} {
  const guard = getGuardConfig(guardName)
  if (guard.driver !== 'session') {
    throw new Error(`[@holo-js/auth] Auth guard "${guardName}" does not support session login.`)
  }

  const provider = guard.provider
  const { adapter } = getProviderAdapter(provider)

  return {
    guard,
    adapter,
    provider,
  }
}

function ensurePasswordConfirmation(input: AuthRegistrationInput): void {
  if (input.password !== input.passwordConfirmation) {
    throw new Error('[@holo-js/auth] Password confirmation does not match.')
  }
}

function getProviderIdentifiers(providerName: string): readonly string[] {
  const bindings = getRuntimeBindings()
  return bindings.config.providers[providerName]?.identifiers ?? ['email']
}

function toLookupCredentials(
  input: Readonly<Record<string, unknown>>,
  identifiers: readonly string[],
): Readonly<Record<string, unknown>> {
  const allowed = new Set(identifiers)
  const credentials = Object.fromEntries(
    Object.entries(input).filter(([key, value]) => (
      allowed.has(key)
      && typeof value !== 'undefined'
      && value !== null
    )),
  )

  if (Object.keys(credentials).length === 0) {
    throw new Error(
      `[@holo-js/auth] Auth credentials must include at least one configured identifier field: ${identifiers.join(', ')}.`,
    )
  }

  return Object.freeze(credentials)
}

async function findUserByConfiguredIdentifiers(
  adapter: ErasedAuthProviderAdapter,
  credentials: Readonly<Record<string, unknown>>,
  identifiers: readonly string[],
): Promise<Record<string, unknown> | null> {
  const lookup = toLookupCredentials(credentials, identifiers)

  for (const identifier of identifiers) {
    const value = lookup[identifier]
    if (typeof value === 'undefined') {
      continue
    }

    const user = await adapter.findByCredentials({
      [identifier]: value,
    })
    if (user) {
      return requireRecordValue(user, '[@holo-js/auth] Auth provider lookup must return an object user record.')
    }
  }

  return null
}

function toRegistrationRecord(input: AuthRegistrationInput, password: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...Object.fromEntries(
      Object.entries(input).filter(([key, value]) => (
        key !== 'password'
        && key !== 'passwordConfirmation'
        && key !== 'remember'
        && typeof value !== 'undefined'
      )),
    ),
    password,
    email_verified_at: null,
  })
}

function serializeUser(
  adapter: ErasedAuthProviderAdapter,
  user: unknown,
  providerName?: string,
): SerializedAuthUser {
  const serialized = adapter.serialize
    ? adapter.serialize(user)
    : requireRecordValue(
        user,
        '[@holo-js/auth] Auth provider users must be objects when serialize() is not implemented.',
      )
  const id = adapter.getId(user)
  const result = {
    ...requireRecordValue(serialized, '[@holo-js/auth] Auth provider serialize() must return an object user.'),
    id,
  }
  if (providerName) {
    Object.defineProperty(result, AUTH_PROVIDER_MARKER, {
      value: providerName,
      enumerable: false,
      configurable: true,
    })
  }

  return Object.freeze(result) as SerializedAuthUser
}

function rehydrateSerializedUser(
  user: SerializedAuthUser,
  providerName: string,
): SerializedAuthUser {
  const restored = {
    ...user,
    id: user.id,
  }
  Object.defineProperty(restored, AUTH_PROVIDER_MARKER, {
    value: providerName,
    enumerable: false,
    configurable: true,
  })
  return Object.freeze(restored)
}

function getEmailVerifiedAt(
  adapter: ErasedAuthProviderAdapter,
  user: unknown,
): Date | string | null | undefined {
  if (adapter.getEmailVerifiedAt) {
    return adapter.getEmailVerifiedAt(user)
  }

  return requireRecordValue(user, '[@holo-js/auth] Auth provider users must be objects.').email_verified_at as Date | string | null | undefined
}

function getPasswordHash(
  adapter: ErasedAuthProviderAdapter,
  user: unknown,
): string | null | undefined {
  if (adapter.getPasswordHash) {
    return adapter.getPasswordHash(user)
  }

  const value = requireRecordValue(user, '[@holo-js/auth] Auth provider users must be objects.').password
  return typeof value === 'string' ? value : null
}

function isEmailVerificationRequired(): boolean {
  return getRuntimeBindings().config.emailVerification.required === true
}

function toSessionIdentityPayload(
  guard: string,
  provider: string,
  user: SerializedAuthUser,
): SessionIdentityPayload {
  return Object.freeze({
    guard,
    provider,
    userId: user.id,
    user,
  })
}

function toSessionPayload(
  guard: string,
  provider: string,
  user: SerializedAuthUser,
  impersonation?: SessionImpersonationPayload,
): SessionAuthPayload {
  return Object.freeze({
    ...toSessionIdentityPayload(guard, provider, user),
    ...(impersonation ? { impersonation } : {}),
  })
}

function isSessionIdentityPayload(value: unknown): value is SessionIdentityPayload {
  return !!(
    value
    && typeof value === 'object'
    && 'guard' in value
    && typeof (value as { guard?: unknown }).guard === 'string'
    && 'provider' in value
    && typeof (value as { provider?: unknown }).provider === 'string'
    && 'userId' in value
    && (
      typeof (value as { userId?: unknown }).userId === 'string'
      || typeof (value as { userId?: unknown }).userId === 'number'
    )
    && 'user' in value
    && (value as { user?: unknown }).user !== null
    && typeof (value as { user?: unknown }).user === 'object'
  )
}

function isSessionImpersonationPayload(value: unknown): value is SessionImpersonationPayload {
  return !!(
    value
    && typeof value === 'object'
    && 'actor' in value
    && isSessionIdentityPayload((value as { actor?: unknown }).actor)
    && (
      !('original' in value)
      || typeof (value as { original?: unknown }).original === 'undefined'
      || isSessionIdentityPayload((value as { original?: unknown }).original)
    )
    && 'startedAt' in value
    && typeof (value as { startedAt?: unknown }).startedAt === 'string'
  )
}

function isSessionAuthPayload(value: unknown): value is SessionAuthPayload {
  return isSessionIdentityPayload(value)
    && (
      !('impersonation' in (value as Record<string, unknown>))
      || typeof (value as { impersonation?: unknown }).impersonation === 'undefined'
      || isSessionImpersonationPayload((value as { impersonation?: unknown }).impersonation)
    )
}

function readSessionPayloads(record: AuthSessionRecord | null | undefined): SessionAuthPayloadMap | null {
  if (!record) {
    return null
  }

  const payload = record.data.auth
  if (!payload) {
    return null
  }

  if (isSessionAuthPayload(payload)) {
    return Object.freeze({
      [payload.guard]: payload,
    })
  }

  if (!payload || typeof payload !== 'object') {
    return null
  }

  const entries = Object.entries(payload)
    .filter((entry): entry is [string, SessionAuthPayload] => isSessionAuthPayload(entry[1]))
    .map(([, value]) => [value.guard, value] as const)

  if (entries.length === 0) {
    return null
  }

  return Object.freeze(Object.fromEntries(entries))
}

function readSessionPayload(
  record: AuthSessionRecord | null | undefined,
  guardName?: string,
): SessionAuthPayload | null {
  const payloads = readSessionPayloads(record)
  if (!payloads) {
    return null
  }

  if (guardName) {
    return payloads[guardName] ?? null
  }

  /* v8 ignore next -- readSessionPayloads() only returns non-empty payload maps. */
  return Object.values(payloads)[0] ?? null
}

function writeSessionPayloads(
  currentData: Readonly<Record<string, unknown>>,
  payloads: SessionAuthPayloadMap,
): Readonly<Record<string, unknown>> {
  const nextData = { ...currentData } as Record<string, unknown>
  const values = Object.values(payloads)
  if (values.length === 0) {
    delete nextData.auth
  } else if (values.length === 1) {
    nextData.auth = values[0]
  } else {
    nextData.auth = Object.freeze(Object.fromEntries(values.map(value => [value.guard, value] as const)))
  }

  return Object.freeze(nextData)
}

function stripImpersonation(
  payload: SessionAuthPayload,
): SessionIdentityPayload {
  return toSessionIdentityPayload(payload.guard, payload.provider, payload.user)
}

function createImpersonationState(
  payload: SessionAuthPayload,
): AuthImpersonationState | null {
  const impersonation = payload.impersonation
  if (!impersonation) {
    return null
  }

  return Object.freeze({
    guard: payload.guard,
    actorGuard: impersonation.actor.guard,
    user: rehydrateSerializedUser(payload.user, payload.provider),
    actor: rehydrateSerializedUser(impersonation.actor.user, impersonation.actor.provider),
    originalUser: impersonation.original
      ? rehydrateSerializedUser(impersonation.original.user, impersonation.original.provider)
      : null,
    startedAt: new Date(impersonation.startedAt),
  })
}

function normalizeTokenRecord(record: PersonalAccessTokenRecord): PersonalAccessTokenRecord {
  return Object.freeze({
    ...record,
    abilities: Object.freeze([...record.abilities]),
    createdAt: new Date(record.createdAt.getTime()),
    lastUsedAt: record.lastUsedAt ? new Date(record.lastUsedAt.getTime()) : undefined,
    expiresAt: record.expiresAt ? new Date(record.expiresAt.getTime()) : record.expiresAt,
  })
}

function isTokenExpired(record: PersonalAccessTokenRecord): boolean {
  return record.expiresAt instanceof Date && record.expiresAt.getTime() <= Date.now()
}

function parsePlainTextToken(token: string): { id: string, secret: string } | null {
  const separatorIndex = token.indexOf('.')
  if (separatorIndex <= 0) {
    return null
  }

  const id = token.slice(0, separatorIndex).trim()
  const secret = token.slice(separatorIndex + 1).trim()
  if (!id || !secret) {
    return null
  }

  return { id, secret }
}

function tokenHasAbility(record: PersonalAccessTokenRecord, ability: string): boolean {
  if (!ability.trim()) {
    return false
  }

  return record.abilities.includes('*') || record.abilities.includes(ability)
}

async function authenticateAccessTokenRecord(
  plainTextToken: string,
): Promise<{
  readonly token: PersonalAccessTokenRecord
  readonly user: AuthUser
} | null> {
  const parsed = parsePlainTextToken(plainTextToken)
  if (!parsed) {
    return null
  }

  const tokenStore = ensureTokenStore()
  const tokenRecord = await tokenStore.findById(parsed.id)
  if (!tokenRecord || !verifyTokenSecret(parsed.secret, tokenRecord.tokenHash) || isTokenExpired(tokenRecord)) {
    return null
  }

  const { adapter } = getProviderAdapter(tokenRecord.provider)
  const resolvedUser = await adapter.findById(tokenRecord.userId)
  if (!resolvedUser) {
    return null
  }

  const updatedRecord = normalizeTokenRecord({
    ...tokenRecord,
    lastUsedAt: new Date(),
  })
  await tokenStore.update(updatedRecord)

  return {
    token: updatedRecord,
    user: serializeUser(adapter, resolvedUser, tokenRecord.provider),
  }
}

function createCurrentAccessTokenHandle(
  guardName: string,
  record: PersonalAccessTokenRecord,
): AuthCurrentAccessToken {
  return Object.freeze({
    ...normalizeTokenRecord(record),
    delete: async () => {
      await ensureTokenStore().delete(record.id)
      const bindings = getRuntimeBindings()
      if (bindings.context.getAccessToken?.(guardName)) {
        bindings.context.setAccessToken?.(guardName)
        bindings.context.setCachedUser(guardName, null)
      }
    },
  })
}

async function resolveCurrentAccessTokenForGuard(guardName: string): Promise<AuthCurrentAccessToken | null> {
  const bindings = getRuntimeBindings()
  const guard = getGuardConfig(guardName)
  if (guard.driver !== 'token') {
    return null
  }

  const plainTextToken = bindings.context.getAccessToken?.(guardName)
  if (!plainTextToken) {
    return null
  }

  const parsed = parsePlainTextToken(plainTextToken)
  if (!parsed) {
    return null
  }

  const record = await ensureTokenStore().findById(parsed.id)
  if (!record || !verifyTokenSecret(parsed.secret, record.tokenHash) || isTokenExpired(record)) {
    return null
  }

  return createCurrentAccessTokenHandle(guardName, record)
}

async function resolveUserFromGuard(
  guardName: string,
  options: { readonly fresh?: boolean } = {},
): Promise<AuthUser | null> {
  const bindings = getRuntimeBindings()
  const guard = getGuardConfig(guardName)

  if (guard.driver === 'token') {
    const token = bindings.context.getAccessToken?.(guardName)
    if (!token) {
      bindings.context.setCachedUser(guardName, null)
      return null
    }

    const authenticated = await authenticateAccessTokenRecord(token)
    if (!authenticated) {
      bindings.context.setAccessToken?.(guardName)
      bindings.context.setCachedUser(guardName, null)
      return null
    }

    bindings.context.setCachedUser(guardName, authenticated.user)
    return authenticated.user
  }

  const sessionId = bindings.context.getSessionId(guardName)
  if (!sessionId) {
    bindings.context.setCachedUser(guardName, null)
    return null
  }

  const record = await bindings.session.touch(sessionId)
  const payload = readSessionPayload(record, guardName)
  if (!record || !payload || payload.guard !== guardName) {
    bindings.context.setSessionId(guardName)
    bindings.context.setCachedUser(guardName, null)
    bindings.context.setRememberToken?.(guardName)
    return null
  }

  if (!options.fresh) {
    const cached = bindings.context.getCachedUser(guardName)
    if (typeof cached !== 'undefined') {
      return cached
    }

    const restoredUser = rehydrateSerializedUser(payload.user, payload.provider)
    bindings.context.setCachedUser(guardName, restoredUser)
    return restoredUser
  }

  const { adapter } = getProviderAdapter(payload.provider)
  const freshUser = await adapter.findById(payload.userId)
  if (!freshUser) {
    const remainingPayloads = {
      /* v8 ignore next -- a resolved payload guarantees readSessionPayloads(record) is non-null here. */
      ...(readSessionPayloads(record) ?? {}),
    }
    delete remainingPayloads[guardName]
    if (Object.keys(remainingPayloads).length === 0) {
      await bindings.session.invalidate(sessionId)
    } else {
      await writeExistingSession(bindings, record, writeSessionPayloads(record.data, remainingPayloads))
    }
    bindings.context.setSessionId(guardName)
    bindings.context.setCachedUser(guardName, null)
    bindings.context.setRememberToken?.(guardName)
    return null
  }

  const serialized = serializeUser(adapter, freshUser, payload.provider)
  bindings.context.setCachedUser(guardName, serialized)
  return serialized
}

async function loginForGuard(guardName: string, credentials: AuthCredentials): Promise<AuthEstablishedSession> {
  const bindings = getRuntimeBindings()
  const { guard, adapter } = getGuardProviderAdapter(guardName)
  const user = await findUserByConfiguredIdentifiers(adapter, credentials, getProviderIdentifiers(guard.provider))
  if (!user) {
    throw new Error('[@holo-js/auth] Invalid credentials.')
  }

  const passwordHash = getPasswordHash(adapter, user)
  if (!passwordHash || !(await bindings.passwordHasher.verify(credentials.password, passwordHash))) {
    throw new Error('[@holo-js/auth] Invalid credentials.')
  }

  if (isEmailVerificationRequired()) {
    const verifiedAt = getEmailVerifiedAt(adapter, user)
    if (!verifiedAt) {
      throw new Error('[@holo-js/auth] Email verification is required before login.')
    }
  }

  const serialized = serializeUser(adapter, user, guard.provider)
  return establishSessionForUser(serialized, {
    guard: guardName,
    provider: guard.provider,
    remember: credentials.remember === true,
  })
}

function assertTrustedUserProvider(
  guardName: string,
  providerName: string,
  user: unknown,
): void {
  const markedProvider = readMarkedProvider(user)
  if (markedProvider && markedProvider !== providerName) {
    throw new Error(
      `[@holo-js/auth] Trusted login for guard "${guardName}" requires a user from provider "${providerName}", `
      + `received "${markedProvider}".`,
    )
  }

  const bindings = getRuntimeBindings()
  for (const [candidateProviderName, adapter] of Object.entries(bindings.providers)) {
    if (candidateProviderName === providerName) {
      continue
    }

    if (adapter.matchesUser?.(user) === true) {
      throw new Error(
        `[@holo-js/auth] Trusted login for guard "${guardName}" requires a user from provider "${providerName}", `
        + `received "${candidateProviderName}".`,
      )
    }
  }
}

function extractUserId(
  adapter: ErasedAuthProviderAdapter,
  user: unknown,
): string | number | undefined {
  try {
    const resolved = adapter.getId(user)
    if (typeof resolved === 'string' || typeof resolved === 'number') {
      return resolved
    }
  } catch {
    // Fall through to plain-object id extraction.
  }

  if (!user || typeof user !== 'object') {
    return undefined
  }

  const value = (user as { id?: unknown }).id
  return typeof value === 'string' || typeof value === 'number'
    ? value
    : undefined
}

function requireUserId(
  adapter: ErasedAuthProviderAdapter,
  user: unknown,
  message: string,
): string | number {
  const userId = extractUserId(adapter, user)
  if (typeof userId !== 'string' && typeof userId !== 'number') {
    throw new Error(message)
  }

  return userId
}

function isCompatibleSerializedUserCandidate(
  candidate: unknown,
  serialized: SerializedAuthUser,
): boolean {
  if (!candidate || typeof candidate !== 'object') {
    return false
  }

  const serializedRecord = serialized as Readonly<Record<string, unknown>>

  for (const [key, value] of Object.entries(candidate)) {
    if (typeof value === 'undefined') {
      continue
    }

    if (!(key in serializedRecord)) {
      return false
    }

    if (serializedRecord[key] !== value) {
      return false
    }
  }

  return true
}

async function resolveTrustedUserForGuard(
  guardName: string,
  candidate: unknown,
): Promise<{
  readonly provider: string
  readonly adapter: ErasedAuthProviderAdapter
  readonly user: Record<string, unknown>
}> {
  const { provider, adapter } = getGuardProviderAdapter(guardName)

  if (candidate === null || typeof candidate === 'undefined') {
    throw new Error('[@holo-js/auth] Trusted login requires a user or user id.')
  }

  if (typeof candidate === 'string' || typeof candidate === 'number') {
    const user = await adapter.findById(candidate)
    if (!user) {
      throw new Error(
        `[@holo-js/auth] Auth user "${provider}:${String(candidate)}" was not found for trusted login.`,
      )
    }

    return {
      provider,
      adapter,
      user: requireRecordValue(user, '[@holo-js/auth] Auth provider lookups must return object users.'),
    }
  }

  assertTrustedUserProvider(guardName, provider, candidate)
  const markedProvider = readMarkedProvider(candidate)

  if (adapter.matchesUser?.(candidate) === true) {
    const userId = extractUserId(adapter, candidate)
    if (typeof userId !== 'string' && typeof userId !== 'number') {
      throw new Error(
        `[@holo-js/auth] Trusted login for guard "${guardName}" requires a user value compatible with provider "${provider}".`,
      )
    }

    const user = await adapter.findById(userId)
    if (!user) {
      throw new Error(
        `[@holo-js/auth] Auth user "${provider}:${String(userId)}" was not found for trusted login.`,
      )
    }

    return {
      provider,
      adapter,
      user: requireRecordValue(user, '[@holo-js/auth] Auth provider lookups must return object users.'),
    }
  }

  const userId = extractUserId(adapter, candidate)
  if (typeof userId === 'string' || typeof userId === 'number') {
    const user = await adapter.findById(userId)
    if (user) {
      if (
        Object.keys(getRuntimeBindings().providers).length > 1
        && !markedProvider
        && !isCompatibleSerializedUserCandidate(candidate, serializeUser(adapter, user, provider))
      ) {
        throw new Error(
          `[@holo-js/auth] Trusted login for guard "${guardName}" requires a user from provider "${provider}". `
          + 'Pass a user id, a serialized auth user, or implement matchesUser() on the provider adapter.',
        )
      }

      return {
        provider,
        adapter,
        user: requireRecordValue(user, '[@holo-js/auth] Auth provider lookups must return object users.'),
      }
    }
  }

  throw new Error(
    `[@holo-js/auth] Trusted login for guard "${guardName}" requires a user value compatible with provider "${provider}".`,
  )
}

async function loginUsingForGuard(
  guardName: string,
  user: unknown,
  options: AuthSessionLoginOptions = {},
): Promise<AuthEstablishedSession> {
  const resolved = await resolveTrustedUserForGuard(guardName, user)
  const serialized = serializeUser(resolved.adapter, resolved.user, resolved.provider)

  return establishSessionForUser(serialized, {
    guard: guardName,
    provider: resolved.provider,
    remember: options.remember === true,
  })
}

async function loginUsingIdForGuard(
  guardName: string,
  userId: string | number,
  options: AuthSessionLoginOptions = {},
): Promise<AuthEstablishedSession> {
  return loginUsingForGuard(guardName, userId, options)
}

async function readGuardSessionState(
  guardName: string,
): Promise<{
  readonly sessionId: string
  readonly record: AuthSessionRecord
  readonly payloads: SessionAuthPayloadMap
  readonly payload: SessionAuthPayload
} | null> {
  const bindings = getRuntimeBindings()
  const sessionId = bindings.context.getSessionId(guardName)
  if (!sessionId) {
    return null
  }

  const record = await bindings.session.read(sessionId)
  if (!record) {
    return null
  }

  const payloads = readSessionPayloads(record)
  const payload = payloads?.[guardName]
  if (!payloads || !payload) {
    return null
  }

  return {
    sessionId,
    record,
    payloads,
    payload,
  }
}

async function writeExistingSession(
  bindings: RuntimeBindings,
  record: AuthSessionRecord,
  data: Readonly<Record<string, unknown>>,
): Promise<AuthSessionRecord> {
  if (!bindings.session.write) {
    return bindings.session.create({
      id: record.id,
      data,
    })
  }

  return bindings.session.write(Object.freeze({
    ...record,
    data,
  }))
}

async function renewExistingSession(
  bindings: RuntimeBindings,
  record: AuthSessionRecord,
  data: Readonly<Record<string, unknown>>,
): Promise<AuthSessionRecord> {
  const renewed = await bindings.session.create({
    id: record.id,
    data,
  })

  if (!record.rememberTokenHash) {
    return renewed
  }

  if (!bindings.session.write) {
    return renewed
  }

  return bindings.session.write(Object.freeze({
    ...renewed,
    rememberTokenHash: record.rememberTokenHash,
  }))
}

async function impersonateForGuard(
  guardName: string,
  user: unknown,
  options: AuthImpersonationOptions = {},
): Promise<AuthEstablishedSession> {
  const actorGuard = options.actorGuard ?? guardName
  const actorState = await readGuardSessionState(actorGuard)
  if (!actorState) {
    throw new Error(`[@holo-js/auth] Impersonation for guard "${guardName}" requires an authenticated actor on guard "${actorGuard}".`)
  }

  if (actorState.payload.impersonation) {
    throw new Error(`[@holo-js/auth] Nested impersonation is not supported for guard "${actorGuard}".`)
  }

  const targetState = await readGuardSessionState(guardName)
  if (targetState?.payload.impersonation) {
    throw new Error(`[@holo-js/auth] Guard "${guardName}" is already impersonating another user.`)
  }

  const resolved = await resolveTrustedUserForGuard(guardName, user)
  const serialized = serializeUser(resolved.adapter, resolved.user, resolved.provider)
  const impersonation = Object.freeze({
    actor: stripImpersonation(actorState.payload),
    ...(targetState?.payload ? { original: stripImpersonation(targetState.payload) } : {}),
    startedAt: new Date().toISOString(),
  }) satisfies SessionImpersonationPayload

  return establishSessionForUser(serialized, {
    guard: guardName,
    provider: resolved.provider,
    remember: options.remember === true,
    preserveRemember: true,
    payload: toSessionPayload(guardName, resolved.provider, serialized, impersonation),
  })
}

async function impersonateByIdForGuard(
  guardName: string,
  userId: string | number,
  options: AuthImpersonationOptions = {},
): Promise<AuthEstablishedSession> {
  return impersonateForGuard(guardName, userId, options)
}

async function impersonationForGuard(guardName: string): Promise<AuthImpersonationState | null> {
  const state = await readGuardSessionState(guardName)
  if (!state) {
    return null
  }

  return createImpersonationState(state.payload)
}

async function stopImpersonatingForGuard(guardName: string): Promise<AuthUser | null> {
  const bindings = getRuntimeBindings()
  const state = await readGuardSessionState(guardName)
  if (!state || !state.payload.impersonation) {
    return null
  }

  const nextPayloads = { ...state.payloads }
  const original = state.payload.impersonation.original
  if (original) {
    nextPayloads[guardName] = toSessionPayload(original.guard, original.provider, original.user)
  } else {
    delete nextPayloads[guardName]
  }

  if (Object.keys(nextPayloads).length === 0) {
    await bindings.session.invalidate(state.sessionId)
  } else {
    await writeExistingSession(bindings, state.record, writeSessionPayloads(state.record.data, nextPayloads))
  }

  bindings.context.setRememberToken?.(guardName)
  if (!original) {
    bindings.context.setSessionId(guardName)
    bindings.context.setCachedUser(guardName, null)
    return null
  }

  const restored = rehydrateSerializedUser(original.user, original.provider)
  bindings.context.setSessionId(guardName, state.sessionId)
  bindings.context.setCachedUser(guardName, restored)
  return restored
}

async function logoutForGuard(guardName: string): Promise<AuthLogoutResult> {
  const bindings = getRuntimeBindings()
  const guard = getGuardConfig(guardName)

  if (guard.driver === 'token') {
    bindings.context.setAccessToken?.(guardName)
    bindings.context.setCachedUser(guardName, null)
    return Object.freeze({
      guard: guardName,
      cookies: Object.freeze([]),
    })
  }

  let clearSessionCookies = false
  const sessionId = bindings.context.getSessionId(guardName)
  if (sessionId) {
    const record = await bindings.session.read(sessionId)
    const payloads = {
      ...(readSessionPayloads(record) ?? {}),
    }
    if (!(guardName in payloads)) {
      await bindings.session.invalidate(sessionId)
      clearSessionCookies = true
    } else {
      delete payloads[guardName]
      if (Object.keys(payloads).length === 0) {
        await bindings.session.invalidate(sessionId)
        clearSessionCookies = true
      } else if (record) {
        await writeExistingSession(bindings, record, writeSessionPayloads(record.data, payloads))
      }
    }
  }

  bindings.context.setSessionId(guardName)
  bindings.context.setCachedUser(guardName, null)
  bindings.context.setRememberToken?.(guardName)

  return Object.freeze({
    guard: guardName,
    cookies: buildLogoutCookies(bindings, guardName, { clearSessionCookies }),
  })
}

async function registerDefaultUser(input: AuthRegistrationInput): Promise<AuthUser> {
  ensurePasswordConfirmation(input)

  const bindings = getRuntimeBindings()
  const defaultGuard = bindings.config.defaults.guard
  const guard = getGuardConfig(defaultGuard)
  const { adapter } = getProviderAdapter(guard.provider)
  const identifiers = getProviderIdentifiers(guard.provider)
  const lookup = toLookupCredentials(input, identifiers)
  for (const [identifier, value] of Object.entries(lookup)) {
    const existing = await adapter.findByCredentials({
      [identifier]: value,
    })
    if (existing) {
      throw new Error(`[@holo-js/auth] A user with this ${identifier} already exists.`)
    }
  }

  const password = await bindings.passwordHasher.hash(input.password)
  const user = await adapter.create(toRegistrationRecord(input, password))

  return serializeUser(adapter, user, guard.provider)
}

function findProviderNameForUser(user: unknown): string {
  const bindings = getRuntimeBindings()
  const providerNames = Object.keys(bindings.providers)
  const markedProvider = user && typeof user === 'object'
    ? (user as Record<PropertyKey, unknown>)[AUTH_PROVIDER_MARKER]
    : undefined

  if (typeof markedProvider === 'string' && markedProvider in bindings.providers) {
    return markedProvider
  }

  if (providerNames.length === 1) {
    return providerNames[0]!
  }

  for (const [providerName, adapter] of Object.entries(bindings.providers)) {
    if (adapter.matchesUser?.(user) === true) {
      return providerName
    }
  }

  throw new Error(
    '[@holo-js/auth] Unable to resolve a provider for the given user. '
    + 'Pass a guard explicitly when multiple auth providers are configured.',
  )
}

async function establishSessionForUser(
  user: AuthUser,
  options: {
    readonly guard: string
    readonly provider: string
    readonly remember?: boolean
    readonly preserveRemember?: boolean
    readonly payload?: SessionAuthPayload
  },
): Promise<AuthEstablishedSession> {
  const bindings = getRuntimeBindings()
  const sessionGuardNames = Object.entries(bindings.config.guards)
    .filter(([, guard]) => guard.driver === 'session')
    .map(([name]) => name)
  const currentGuardSessionId = bindings.context.getSessionId(options.guard)
  const sharedGuardNames = currentGuardSessionId
    ? sessionGuardNames.filter(name => bindings.context.getSessionId(name) === currentGuardSessionId)
    : []
  const sharedSessionId = currentGuardSessionId
    ?? sessionGuardNames
      .filter(name => name !== options.guard)
      .map(name => bindings.context.getSessionId(name))
      .find((value): value is string => typeof value === 'string' && value.length > 0)
  const existingSession = sharedSessionId
    ? await bindings.session.read(sharedSessionId)
    : null
  const existingPayloads = readSessionPayloads(existingSession) ?? {}
  const rotateCurrentGuardSession = !!(
    currentGuardSessionId
    && existingPayloads[options.guard]
  )
  const sessionPayload = options.payload
    ?? toSessionPayload(options.guard, options.provider, user as SerializedAuthUser)
  const sessionPayloads = {
    ...existingPayloads,
    [options.guard]: sessionPayload,
  }
  const nextSessionData = writeSessionPayloads(existingSession?.data ?? {}, sessionPayloads)
  const preserveRememberSession = !!(
    rotateCurrentGuardSession
    && existingSession?.rememberTokenHash
    && options.preserveRemember
    && !options.remember
  )
  const session = rotateCurrentGuardSession
    ? await bindings.session.create({
      data: nextSessionData,
    })
    : existingSession
      ? await renewExistingSession(bindings, existingSession, nextSessionData)
      : await bindings.session.create({
        data: nextSessionData,
      })

  if (rotateCurrentGuardSession && currentGuardSessionId && currentGuardSessionId !== session.id) {
    await bindings.session.invalidate(currentGuardSessionId)
    for (const guardName of sharedGuardNames) {
      bindings.context.setSessionId(guardName, session.id)
    }
  }

  bindings.context.setSessionId(options.guard, session.id)
  bindings.context.setCachedUser(options.guard, user)
  let rememberToken: string | undefined
  if (options.remember) {
    rememberToken = await bindings.session.issueRememberMeToken(session.id)
    bindings.context.setRememberToken?.(options.guard, rememberToken)
  } else if (preserveRememberSession) {
    rememberToken = await bindings.session.issueRememberMeToken(session.id)
    bindings.context.setRememberToken?.(options.guard, rememberToken)
  } else {
    bindings.context.setRememberToken?.(options.guard)
  }

  const cookies = [
    bindings.session.sessionCookie(session.id),
    ...(rememberToken ? [bindings.session.rememberMeCookie(rememberToken)] : []),
  ]

  return Object.freeze({
    guard: options.guard,
    user,
    sessionId: session.id,
    rememberToken,
    cookies: Object.freeze(cookies),
  })
}

function toPlainTextTokenResult(
  record: PersonalAccessTokenRecord,
  plainTextToken: string,
): PersonalAccessTokenResult {
  return Object.freeze({
    id: record.id,
    provider: record.provider,
    userId: record.userId,
    name: record.name,
    abilities: Object.freeze([...record.abilities]),
    createdAt: new Date(record.createdAt.getTime()),
    lastUsedAt: record.lastUsedAt ? new Date(record.lastUsedAt.getTime()) : undefined,
    expiresAt: record.expiresAt ? new Date(record.expiresAt.getTime()) : record.expiresAt,
    plainTextToken,
  })
}

async function updateUserRecord(
  providerName: string,
  userId: string | number,
  input: {
    readonly name?: string
    readonly email?: string
    readonly avatar?: string | null
    readonly email_verified_at?: Date | null
    readonly password?: string | null
  },
): Promise<AuthUser> {
  const { adapter } = getProviderAdapter(providerName)
  const user = await adapter.findById(userId)
  if (!user) {
    throw new Error(`[@holo-js/auth] Auth user "${providerName}:${String(userId)}" no longer exists.`)
  }

  let updated: unknown = user
  if (adapter.update) {
    updated = await adapter.update(user, input)
  } else if (
    typeof input.name !== 'undefined'
    || typeof input.email !== 'undefined'
    || typeof input.avatar !== 'undefined'
    || typeof input.email_verified_at !== 'undefined'
    || typeof input.password !== 'undefined'
  ) {
    throw new Error(
      `[@holo-js/auth] Auth provider "${providerName}" must implement update() to persist user changes.`,
    )
  }

  return serializeUser(adapter, updated, providerName)
}

function createEmailVerificationFacade(): AuthEmailVerificationFacade {
  return Object.freeze({
    async create(user: unknown, options: { readonly guard?: string, readonly expiresAt?: Date } = {}): Promise<EmailVerificationTokenResult> {
      const providerName = options.guard
        ? getGuardConfig(options.guard).provider
        : findProviderNameForUser(user)
      const { adapter } = getProviderAdapter(providerName)
      const serialized = serializeUser(
        adapter,
        requireUserRecord(user, '[@holo-js/auth] Email verification requires a serializable user object.'),
        providerName,
      )
      const email = typeof serialized.email === 'string' ? serialized.email.trim() : ''
      if (!email) {
        throw new Error('[@holo-js/auth] Email verification requires a user with an email address.')
      }

      const store = ensureEmailVerificationTokenStore()
      await store.deleteByUserId(providerName, serialized.id!)
      const id = createPersonalAccessTokenId()
      const secret = createPersonalAccessTokenSecret()
      const record: EmailVerificationTokenRecord = Object.freeze({
        id,
        provider: providerName,
        userId: serialized.id!,
        email,
        tokenHash: hashTokenSecret(secret),
        createdAt: new Date(),
        expiresAt: options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
      })
      await store.create(record)
      const plainTextToken = `${id}.${secret}`
      const result = createLifecycleTokenResult(record, plainTextToken)
      await getRuntimeBindings().delivery.sendEmailVerification({
        provider: providerName,
        user: serialized,
        email,
        token: result,
      })
      return result
    },
    async consume(plainTextToken: string): Promise<AuthUser> {
      const parsed = parsePlainTextToken(plainTextToken)
      if (!parsed) {
        throw new Error('[@holo-js/auth] Invalid email verification token.')
      }

      const store = ensureEmailVerificationTokenStore()
      const record = await store.findById(parsed.id)
      if (!record || !verifyTokenSecret(parsed.secret, record.tokenHash) || record.expiresAt.getTime() <= Date.now()) {
        throw new Error('[@holo-js/auth] Invalid or expired email verification token.')
      }

      const updated = await updateUserRecord(record.provider, record.userId, {
        email_verified_at: new Date(),
      })
      await store.delete(record.id)
      return updated
    },
  })
}

function createPasswordResetFacade(): AuthPasswordResetFacade {
  return Object.freeze({
    async request(email: string, options: { readonly broker?: string, readonly expiresAt?: Date } = {}): Promise<void> {
      const normalizedEmail = email.trim()
      if (!normalizedEmail) {
        throw new Error('[@holo-js/auth] Email is required to request a password reset.')
      }

      const bindings = getRuntimeBindings()
      const brokerName = options.broker ?? bindings.config.defaults.passwords
      const broker = bindings.config.passwords[brokerName]
      if (!broker) {
        throw new Error(`[@holo-js/auth] Password broker "${brokerName}" is not configured.`)
      }

      const store = ensurePasswordResetTokenStore()
      const existing = await store.findLatestByEmail(broker.provider, normalizedEmail, {
        table: broker.table,
      })
      if (existing && (existing.createdAt.getTime() + (broker.throttle * 60 * 1000)) > Date.now()) {
        return
      }

      let sharedReservation: {
        readonly key: string
        readonly limited: boolean
        readonly store: OptionalSecurityRateLimitStore
        readonly bypassed: boolean
      } | undefined

      try {
        sharedReservation = await reserveSharedPasswordResetThrottle(brokerName, broker, normalizedEmail)
        if (sharedReservation?.limited) {
          return
        }

        const { adapter } = getProviderAdapter(broker.provider)
        const user = await adapter.findByCredentials({
          email: normalizedEmail,
        })
        if (!user) {
          await clearSharedPasswordResetThrottleReservation(sharedReservation)
          return
        }

        const id = createPersonalAccessTokenId()
        const secret = createPersonalAccessTokenSecret()
        const record: PasswordResetTokenRecord = Object.freeze({
          id,
          provider: broker.provider,
          email: normalizedEmail,
          table: broker.table,
          tokenHash: hashTokenSecret(secret),
          createdAt: new Date(),
          expiresAt: options.expiresAt ?? new Date(Date.now() + broker.expire * 60 * 1000),
        })
        await store.deleteByEmail(broker.provider, normalizedEmail, {
          table: broker.table,
        })
        await store.create(record)
        const result = createLifecycleTokenResult(record, `${id}.${secret}`)
        try {
          await bindings.delivery.sendPasswordReset({
            provider: broker.provider,
            email: normalizedEmail,
            token: result,
          })
        } catch (error) {
          try {
            await store.delete(record.id, {
              table: broker.table,
            })
          } catch (cleanupError) {
            void cleanupError
          }
          throw error
        }
        if (sharedReservation?.bypassed) {
          getAuthRuntimeState().sharedPasswordResetThrottleFailures?.delete(sharedReservation.key)
        }
      } catch (error) {
        const cleared = await clearSharedPasswordResetThrottleReservation(sharedReservation)
        if (cleared === 'unsupported' && sharedReservation) {
          const failures = getAuthRuntimeState().sharedPasswordResetThrottleFailures ??= new Set<string>()
          failures.add(sharedReservation.key)
        }

        throw error
      }
    },
    async consume(input: {
      readonly token: string
      readonly password: string
      readonly passwordConfirmation: string
    }): Promise<AuthUser> {
      if (input.password !== input.passwordConfirmation) {
        throw new Error('[@holo-js/auth] Password confirmation does not match.')
      }

      const parsed = parsePlainTextToken(input.token)
      if (!parsed) {
        throw new Error('[@holo-js/auth] Invalid password reset token.')
      }

      const store = ensurePasswordResetTokenStore()
      const record = await store.findById(parsed.id)
      if (!record || !verifyTokenSecret(parsed.secret, record.tokenHash) || record.expiresAt.getTime() <= Date.now()) {
        throw new Error('[@holo-js/auth] Invalid or expired password reset token.')
      }

      const { adapter } = getProviderAdapter(record.provider)
      const user = await adapter.findByCredentials({
        email: record.email,
      })
      if (!user) {
        throw new Error('[@holo-js/auth] Password reset token user no longer exists.')
      }

      const password = await getRuntimeBindings().passwordHasher.hash(input.password)
      const updated = await updateUserRecord(record.provider, adapter.getId(user), {
        password,
      })
      await store.delete(record.id, {
        table: record.table,
      })
      await store.deleteByEmail(record.provider, record.email, {
        table: record.table,
      })
      return updated
    },
  })
}

function createTokenFacade(): AuthTokenFacade {
  return Object.freeze({
    async create(user: unknown, options: PersonalAccessTokenCreationOptions): Promise<PersonalAccessTokenResult> {
      const tokenStore = ensureTokenStore()
      const providerName = options.guard
        ? getGuardConfig(options.guard).provider
        : findProviderNameForUser(user)
      const { adapter } = getProviderAdapter(providerName)
      const userId = requireUserId(
        adapter,
        user,
        '[@holo-js/auth] Personal access token creation requires a user with a serializable id.',
      )
      const id = createPersonalAccessTokenId()
      const secret = createPersonalAccessTokenSecret()
      const record = normalizeTokenRecord({
        id,
        provider: providerName,
        userId,
        name: options.name,
        abilities: options.abilities
          ? [...options.abilities]
          : [...getRuntimeBindings().config.personalAccessTokens.defaultAbilities],
        tokenHash: hashTokenSecret(secret),
        createdAt: new Date(),
        expiresAt: options.expiresAt ?? null,
      })

      await tokenStore.create(record)
      return toPlainTextTokenResult(record, `${id}.${secret}`)
    },
    async list(user: unknown, options: { readonly guard?: string } = {}): Promise<readonly PersonalAccessTokenRecord[]> {
      const tokenStore = ensureTokenStore()
      const providerName = options.guard
        ? getGuardConfig(options.guard).provider
        : findProviderNameForUser(user)
      const { adapter } = getProviderAdapter(providerName)
      const userId = requireUserId(
        adapter,
        user,
        '[@holo-js/auth] Listing personal access tokens requires a user with a serializable id.',
      )
      const records = await tokenStore.listByUserId(providerName, userId)
      return records.map(normalizeTokenRecord)
    },
    async revoke(options: { readonly guard?: string } = {}): Promise<void> {
      const guardName = options.guard ?? getRuntimeBindings().config.defaults.guard
      const current = await resolveCurrentAccessTokenForGuard(guardName)
      await current?.delete()
    },
    async revokeAll(user: unknown, options: { readonly guard?: string } = {}): Promise<number> {
      const tokenStore = ensureTokenStore()
      const providerName = options.guard
        ? getGuardConfig(options.guard).provider
        : findProviderNameForUser(user)
      const { adapter } = getProviderAdapter(providerName)
      const userId = requireUserId(
        adapter,
        user,
        '[@holo-js/auth] Revoking personal access tokens requires a user with a serializable id.',
      )
      return tokenStore.deleteByUserId(providerName, userId)
    },
    async authenticate(plainTextToken: string): Promise<AuthUser | null> {
      const authenticated = await authenticateAccessTokenRecord(plainTextToken)
      return authenticated?.user ?? null
    },
    async can(token: string, ability: string): Promise<boolean> {
      const authenticated = await authenticateAccessTokenRecord(token)
      return authenticated ? tokenHasAbility(authenticated.token, ability) : false
    },
  })
}

function createGuardFacade(guardName: string): AuthGuardFacade {
  return Object.freeze({
    check() {
      return checkForGuard(guardName)
    },
    user() {
      return userForGuard(guardName)
    },
    refreshUser() {
      return refreshUserForGuard(guardName)
    },
    async id() {
      return (await userForGuard(guardName))?.id ?? null
    },
    currentAccessToken() {
      return resolveCurrentAccessTokenForGuard(guardName)
    },
    login(credentials: AuthCredentials) {
      return loginForGuard(guardName, credentials)
    },
    loginUsing(user: unknown, options?: AuthSessionLoginOptions) {
      return loginUsingForGuard(guardName, user, options)
    },
    loginUsingId(userId: string | number, options?: AuthSessionLoginOptions) {
      return loginUsingIdForGuard(guardName, userId, options)
    },
    impersonate(user: unknown, options?: AuthImpersonationOptions) {
      return impersonateForGuard(guardName, user, options)
    },
    impersonateById(userId: string | number, options?: AuthImpersonationOptions) {
      return impersonateByIdForGuard(guardName, userId, options)
    },
    impersonation() {
      return impersonationForGuard(guardName)
    },
    stopImpersonating() {
      return stopImpersonatingForGuard(guardName)
    },
    logout() {
      return logoutForGuard(guardName)
    },
  })
}

export function configureAuthRuntime(bindings?: AuthRuntimeBindings): void {
  if (!bindings) {
    getAuthRuntimeState().bindings = undefined
    return
  }

  getAuthRuntimeState().bindings = {
    config: normalizeAuthConfig(bindings.config),
    session: bindings.session,
    providers: bindings.providers,
    tokens: bindings.tokens,
    emailVerificationTokens: bindings.emailVerificationTokens,
    passwordResetTokens: bindings.passwordResetTokens,
    delivery: bindings.delivery ?? createDefaultDeliveryHook(),
    context: bindings.context ?? createMemoryAuthContext(),
    passwordHasher: bindings.passwordHasher ?? createDefaultPasswordHasher(),
  }
}

export function getAuthRuntime(): AuthRuntimeFacade {
  const getDefaultGuardName = () => getRuntimeBindings().config.defaults.guard
  const tokens = createTokenFacade()
  const verification = createEmailVerificationFacade()
  const passwords = createPasswordResetFacade()

  const facade: AuthFacade = {
    check() {
      return checkForGuard(getDefaultGuardName())
    },
    user() {
      return userForGuard(getDefaultGuardName())
    },
    refreshUser() {
      return refreshUserForGuard(getDefaultGuardName())
    },
    async id() {
      return (await userForGuard(getDefaultGuardName()))?.id ?? null
    },
    currentAccessToken() {
      return resolveCurrentAccessTokenForGuard(getDefaultGuardName())
    },
    login(credentials) {
      return loginForGuard(getDefaultGuardName(), credentials)
    },
    loginUsing(user, options) {
      return loginUsingForGuard(getDefaultGuardName(), user, options)
    },
    loginUsingId(userId, options) {
      return loginUsingIdForGuard(getDefaultGuardName(), userId, options)
    },
    impersonate(user, options) {
      return impersonateForGuard(getDefaultGuardName(), user, options)
    },
    impersonateById(userId, options) {
      return impersonateByIdForGuard(getDefaultGuardName(), userId, options)
    },
    impersonation() {
      return impersonationForGuard(getDefaultGuardName())
    },
    stopImpersonating() {
      return stopImpersonatingForGuard(getDefaultGuardName())
    },
    logout() {
      return logoutForGuard(getDefaultGuardName())
    },
    register(input) {
      return registerDefaultUser(input)
    },
    hashPassword(password: string) {
      return getRuntimeBindings().passwordHasher.hash(password)
    },
    verifyPassword(password: string, digest: string) {
      return getRuntimeBindings().passwordHasher.verify(password, digest)
    },
    needsPasswordRehash(digest: string) {
      return resolveNeedsPasswordRehash(getRuntimeBindings().passwordHasher, digest)
    },
    guard(name: string) {
      return createGuardFacade(name)
    },
    tokens,
    verification,
    passwords,
  }

  return Object.freeze({
    ...facade,
    logoutAll(guardName?: string) {
      if (guardName) {
        return logoutForGuard(guardName).then(result => Object.freeze([result]))
      }

      return Object.keys(getRuntimeBindings().config.guards).reduce<Promise<AuthLogoutResult[]>>(
        async (resultsPromise, name) => {
          const results = await resultsPromise
          results.push(await logoutForGuard(name))
          return results
        },
        Promise.resolve([]),
      ).then(results => Object.freeze(results))
    },
  })
}

export function resetAuthRuntime(): void {
  const state = getAuthRuntimeState()
  state.bindings = undefined
  state.sharedPasswordResetThrottleFailures = undefined
  optionalSecurityModulePromise = undefined
}

export async function checkForGuard(guardName: string): Promise<boolean> {
  return (await userForGuard(guardName)) !== null
}

export async function userForGuard(guardName: string): Promise<AuthUser | null> {
  return resolveUserFromGuard(guardName)
}

export async function refreshUserForGuard(guardName: string): Promise<AuthUser | null> {
  return resolveUserFromGuard(guardName, { fresh: true })
}

export async function check(): Promise<boolean> {
  return getAuthRuntime().check()
}

export async function user(): Promise<AuthUser | null> {
  return getAuthRuntime().user()
}

export async function refreshUser(): Promise<AuthUser | null> {
  return getAuthRuntime().refreshUser()
}

export async function id(): Promise<string | number | null> {
  return getAuthRuntime().id()
}

export async function currentAccessToken(): Promise<AuthCurrentAccessToken | null> {
  return getAuthRuntime().currentAccessToken()
}

export async function login(credentials: AuthCredentials): Promise<AuthEstablishedSession> {
  return getAuthRuntime().login(credentials)
}

export async function loginUsing(
  user: unknown,
  options?: AuthSessionLoginOptions,
): Promise<AuthEstablishedSession> {
  return getAuthRuntime().loginUsing(user, options)
}

export async function loginUsingId(
  userId: string | number,
  options?: AuthSessionLoginOptions,
): Promise<AuthEstablishedSession> {
  return getAuthRuntime().loginUsingId(userId, options)
}

export async function impersonate(
  user: unknown,
  options?: AuthImpersonationOptions,
): Promise<AuthEstablishedSession> {
  return getAuthRuntime().impersonate(user, options)
}

export async function impersonateById(
  userId: string | number,
  options?: AuthImpersonationOptions,
): Promise<AuthEstablishedSession> {
  return getAuthRuntime().impersonateById(userId, options)
}

export async function impersonation(): Promise<AuthImpersonationState | null> {
  return getAuthRuntime().impersonation()
}

export async function stopImpersonating(): Promise<AuthUser | null> {
  return getAuthRuntime().stopImpersonating()
}

export async function hashPassword(password: string): Promise<string> {
  return getAuthRuntime().hashPassword(password)
}

export async function verifyPassword(password: string, digest: string): Promise<boolean> {
  return getAuthRuntime().verifyPassword(password, digest)
}

export async function needsPasswordRehash(digest: string): Promise<boolean> {
  return getAuthRuntime().needsPasswordRehash(digest)
}

export async function logout(): Promise<AuthLogoutResult> {
  return getAuthRuntime().logout()
}

export async function register(input: AuthRegistrationInput): Promise<AuthUser> {
  return getAuthRuntime().register(input)
}

export const tokens: AuthTokenFacade = Object.freeze({
  create(user: unknown, options: PersonalAccessTokenCreationOptions) {
    return getAuthRuntime().tokens.create(user, options)
  },
  list(user: unknown, options?: { readonly guard?: string }) {
    return getAuthRuntime().tokens.list(user, options)
  },
  revoke(options?: { readonly guard?: string }) {
    return getAuthRuntime().tokens.revoke(options)
  },
  revokeAll(user: unknown, options?: { readonly guard?: string }) {
    return getAuthRuntime().tokens.revokeAll(user, options)
  },
  authenticate(plainTextToken: string) {
    return getAuthRuntime().tokens.authenticate(plainTextToken)
  },
  can(token: string, ability: string) {
    return getAuthRuntime().tokens.can(token, ability)
  },
})

export const verification: AuthEmailVerificationFacade = Object.freeze({
  create(user: unknown, options?: { readonly guard?: string, readonly expiresAt?: Date }) {
    return getAuthRuntime().verification.create(user, options)
  },
  consume(plainTextToken: string) {
    return getAuthRuntime().verification.consume(plainTextToken)
  },
})

export const passwords: AuthPasswordResetFacade = Object.freeze({
  request(email: string, options?: { readonly broker?: string, readonly expiresAt?: Date }) {
    return getAuthRuntime().passwords.request(email, options)
  },
  consume(input: {
    readonly token: string
    readonly password: string
    readonly passwordConfirmation: string
  }) {
    return getAuthRuntime().passwords.consume(input)
  },
})

export const authRuntimeInternals = {
  createAsyncAuthContext,
  createDefaultPasswordHasher,
  createMemoryAuthContext,
  createPersonalAccessTokenId,
  createPersonalAccessTokenSecret,
  createCurrentAccessTokenHandle,
  establishSessionForUser,
  getPasswordHash,
  getProviderIdentifiers,
  getRuntimeBindings: getExposedRuntimeBindings,
  hashTokenSecret,
  parsePlainTextToken,
  parseSetCookieDefinition,
  readSessionPayload,
  serializeCookie,
  toLookupCredentials,
  toPlainTextTokenResult,
  tokenHasAbility,
  throwUnconfigured,
  updateUserRecord,
  verifyTokenSecret,
  writeSessionPayloads,
}
