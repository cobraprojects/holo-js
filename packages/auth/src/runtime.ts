import { createHash, createHmac } from 'node:crypto'
import { normalizeAuthConfig } from '@holo-js/config'
import type {
  AuthenticatedAuthUser,
  AuthCredentials,
  AuthCurrentAccessToken,
  AuthDeliveryHook,
  AuthEmailVerificationFacade,
  AuthEmailVerificationSendOptions,
  AuthEstablishedSession,
  AuthFacade,
  AuthGuardFacade,
  AuthGuardFacadeFor,
  AuthImpersonationOptions,
  AuthImpersonationState,
  AuthLogoutResult,
  AuthPasswordResetInput,
  AuthPasswordResetRequestInput,
  AuthPasswordResetRequestOptions,
  AuthPasswordHasher,
  AuthPasswordResetConsumeErrorCode,
  AuthPasswordResetRequestErrorCode,
  AuthResult,
  AuthRegistrationInput,
  AuthSessionGuardFacade,
  AuthSessionLoginOptions,
  AuthTokenGuardFacade,
  AuthTokenFacade,
  AuthTokenStore,
  AuthUser,
  AuthRuntimeBindings,
  AuthRuntimeContext,
  AuthRuntimeFacade,
  AuthAuthorizationSubject,
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
import {
  createAsyncAuthContext,
  createMemoryAuthContext,
} from './runtime/context'
import {
  serializeCookie,
} from './runtime/cookieSerialization'
import {
  EXPECTED_EMAIL_VERIFICATION_CONSUME_ERRORS,
  EXPECTED_EMAIL_VERIFICATION_RESEND_ERRORS,
  EXPECTED_LOGIN_ERRORS,
  EXPECTED_PASSWORD_RESET_CONSUME_ERRORS,
  EXPECTED_PASSWORD_RESET_REQUEST_ERRORS,
  EXPECTED_REGISTRATION_ERRORS,
} from './runtime/expectedErrors'
import type { InputFieldName } from './runtime/failureFields'
import {
  createEmailVerificationConsumeFailure,
  createEmailVerificationResendFailure,
  createPasswordResetConsumeFailure,
  createPasswordResetRequestFailure,
} from './runtime/lifecycleFailures'
import {
  type OptionalSecurityRateLimitStore,
  loadOptionalSecurityModule,
  resetOptionalSecurityModuleCache,
} from './runtime/optionalSecurity'
import {
  appendResponseCookies,
  isAuthResponseInterrupt,
  parseBearerToken,
  redirectResponse,
  resolveRequestCookie,
  resolveRequestHeader,
} from './runtime/requestAccess'
import {
  buildLogoutCookies,
  forgetDefaultRememberCookie,
} from './runtime/responseCookies'
import { captureExpectedAuthResult, throwAuthError, unwrapExpectedAuthResult } from './runtime/result'
import { createLoginFailure, createRegistrationFailure, createTokenLoginFailure } from './runtime/sessionFailures'
import {
  createDefaultPasswordHasher,
  createPersonalAccessTokenId,
  createPersonalAccessTokenSecret,
  hashTokenSecret,
  resolveNeedsPasswordRehash,
  verifyTokenSecret,
} from './runtime/secrets'
import { parseSetCookieDefinition } from './runtime/setCookieParser'

const AUTH_PROVIDER_MARKER = Symbol.for('holo-js.auth.provider')

export {
  createAsyncAuthContext,
  createMemoryAuthContext,
} from './runtime/context'

type SerializedAuthUser = AuthenticatedAuthUser & {
  readonly id: string | number
}

type ErasedAuthProviderAdapter = {
  findById(id: string | number): Promise<unknown | null>
  findByCredentials(credentials: Readonly<Record<string, unknown>>): Promise<unknown | null>
  create(input: Readonly<Record<string, unknown>>): Promise<unknown>
  delete?(id: string | number): Promise<void>
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
  readonly authorization?: AuthRuntimeBindings['authorization']
}

type ActivatableAuthRuntimeContext = AuthRuntimeContext & {
  activate(): void
}

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

function throwUnconfigured(): never {
  throwAuthError('runtime_unconfigured', 'Auth runtime is not configured yet.')
}

function hasContextActivator(context: AuthRuntimeContext): context is ActivatableAuthRuntimeContext {
  return 'activate' in context && typeof context.activate === 'function'
}

function getRuntimeBindings(): RuntimeBindings {
  const bindings = getAuthRuntimeState().bindings
  if (!bindings) {
    throwUnconfigured()
  }

  if (hasContextActivator(bindings.context)) {
    bindings.context.activate()
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
  readonly authorization?: AuthRuntimeBindings['authorization']
} {
  const bindings = getRuntimeBindings()

  return {
    ...bindings,
    providers: bindings.providers as unknown as AuthRuntimeBindings['providers'],
  }
}

function requireRecordValue(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new Error(message)
  }

  return value as Record<string, unknown>
}

async function resolveUserAuthorization(
  user: SerializedAuthUser,
  action: string,
  target: AuthAuthorizationSubject,
): Promise<boolean> {
  const authorization = getAuthRuntimeState().bindings?.authorization
  if (!authorization) {
    return false
  }

  return await authorization.can(user, action, target)
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

async function hydrateGuardContextFromRequest(guardName: string): Promise<void> {
  const bindings = getRuntimeBindings()
  const guard = getGuardConfig(guardName)

  if (guard.driver === 'token') {
    if (!bindings.context.getAccessToken?.(guardName)) {
      const accessToken = parseBearerToken(await resolveRequestHeader(bindings, 'authorization'))
      if (accessToken) {
        bindings.context.setAccessToken?.(guardName, accessToken)
      }
    }

    return
  }

  if (!bindings.context.getSessionId(guardName)) {
    const sessionCookie = parseSetCookieDefinition(bindings.session.sessionCookie(''))
    if (sessionCookie) {
      const sessionId = await resolveRequestCookie(bindings, sessionCookie.name)
      if (sessionId) {
        bindings.context.setSessionId(guardName, sessionId)
      }
    }
  }

  if (!bindings.context.getRememberToken?.(guardName)) {
    const rememberCookie = parseSetCookieDefinition(bindings.session.rememberMeCookie(''))
    if (rememberCookie) {
      const rememberToken = await resolveRequestCookie(bindings, rememberCookie.name)
      if (rememberToken) {
        bindings.context.setRememberToken?.(guardName, rememberToken)
        if (!bindings.context.getSessionId(guardName)) {
          const rememberedSession = await bindings.session.consumeRememberMeToken?.(rememberToken)
          const payload = readSessionPayload(rememberedSession, guardName)
          if (rememberedSession && payload?.guard === guardName) {
            bindings.context.setSessionId(guardName, rememberedSession.id)
            bindings.context.setCachedUser(
              guardName,
              rehydrateSerializedUser(payload.user, payload.provider),
            )
          } else if (!rememberedSession) {
            bindings.context.setRememberToken?.(guardName)
          }
        }
      }
    }
  }
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
    throwAuthError('token_runtime_unconfigured', 'Personal access token runtime is not configured yet.')
  }

  return bindings.tokens
}

function ensureEmailVerificationTokenStore(): EmailVerificationTokenStore {
  const bindings = getRuntimeBindings()
  if (!bindings.emailVerificationTokens) {
    throwAuthError('email_verification_runtime_unconfigured', 'Email verification token runtime is not configured yet.')
  }

  return bindings.emailVerificationTokens
}

function ensurePasswordResetTokenStore(): PasswordResetTokenStore {
  const bindings = getRuntimeBindings()
  if (!bindings.passwordResetTokens) {
    throwAuthError('password_reset_runtime_unconfigured', 'Password reset token runtime is not configured yet.')
  }

  return bindings.passwordResetTokens
}

function getGuardConfig(guardName: string): RuntimeBindings['config']['guards'][string] {
  const bindings = getRuntimeBindings()
  const guard = bindings.config.guards[guardName]
  if (!guard) {
    throwAuthError('guard_not_configured', `Auth guard "${guardName}" is not configured.`, {
      guard: guardName,
    })
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
    throwAuthError('provider_not_configured', `Auth provider "${providerName}" is not configured.`, {
      provider: providerName,
    })
  }

  const adapter = bindings.providers[providerName]
  if (!adapter) {
    throwAuthError('provider_runtime_not_configured', `Auth provider runtime "${providerName}" is not configured.`, {
      provider: providerName,
    })
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
    throwAuthError('guard_session_login_unsupported', `Auth guard "${guardName}" does not support session login.`, {
      guard: guardName,
      driver: guard.driver,
    })
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
    throwAuthError('password_confirmation_mismatch', 'Password confirmation does not match.')
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
    throwAuthError(
      'credentials_identifier_missing',
      `Auth credentials must include at least one configured identifier field: ${identifiers.join(', ')}.`,
      {
        identifiers,
      },
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
  Object.defineProperty(result, 'can', {
    value: (action: string, target: AuthAuthorizationSubject) => resolveUserAuthorization(result as SerializedAuthUser, action, target),
    enumerable: false,
    configurable: true,
  })
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
  Object.defineProperty(restored, 'can', {
    value: (action: string, target: AuthAuthorizationSubject) => resolveUserAuthorization(restored as SerializedAuthUser, action, target),
    enumerable: false,
    configurable: true,
  })
  Object.defineProperty(restored, AUTH_PROVIDER_MARKER, {
    value: providerName,
    enumerable: false,
    configurable: true,
  })
  return Object.freeze(restored)
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

async function verifyCredentialsForProvider(
  providerName: string,
  adapter: ErasedAuthProviderAdapter,
  credentials: AuthCredentials,
): Promise<Record<string, unknown> | null> {
  const bindings = getRuntimeBindings()
  const user = await findUserByConfiguredIdentifiers(adapter, credentials, getProviderIdentifiers(providerName))
  const passwordHash = user ? getPasswordHash(adapter, user) : null
  const passwordMatches = await bindings.passwordHasher.verify(credentials.password, passwordHash ?? '')

  return user && passwordMatches ? user : null
}

function isEmailVerificationRequired(): boolean {
  return getRuntimeBindings().config.emailVerification.required === true
}

function getDefaultGuardName(): string {
  return getRuntimeBindings().config.defaults.guard
}

function getEmailVerificationRoute(): string {
  return getRuntimeBindings().config.emailVerification.route
}

function getPasswordBrokerConfig(brokerName: string) {
  const broker = getRuntimeBindings().config.passwords[brokerName]
  if (!broker) {
    throwAuthError('password_broker_not_configured', `Password broker "${brokerName}" is not configured.`, {
      broker: brokerName,
    })
  }

  return broker
}

function getPasswordResetRoute(brokerName: string): string {
  return getPasswordBrokerConfig(brokerName).route
}

function hasVerifiedEmail(user: Readonly<Record<string, unknown>>): boolean {
  return user.email_verified_at instanceof Date
    || typeof user.email_verified_at === 'string'
}

function createEmailVerificationRedirectRoute(user: AuthUser): string {
  const route = getEmailVerificationRoute()
  const rawEmail = (user as Readonly<Record<string, unknown>>).email
  const email = typeof rawEmail === 'string'
    ? rawEmail.trim()
    : ''

  if (!email) {
    return route
  }

  const url = new URL(route, 'http://holo.local')
  url.searchParams.set('email', email)
  return `${url.pathname}${url.search}${url.hash}`
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

function resolveSessionPayloadProvider(payload: SessionAuthPayload): string {
  const source = payload as SessionAuthPayload & {
    readonly clerk?: unknown
    readonly workos?: unknown
  }

  if (source.workos && typeof source.workos === 'object') {
    return 'workos'
  }

  if (source.clerk && typeof source.clerk === 'object') {
    return 'clerk'
  }

  return payload.provider
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

function tokenAbilityMatches(grantedAbility: string, requestedAbility: string): boolean {
  const granted = grantedAbility.trim()
  const requested = requestedAbility.trim()

  if (!granted || !requested) {
    return false
  }

  if (granted === '*') {
    return true
  }

  if (granted.endsWith('.*')) {
    const prefix = granted.slice(0, -1)
    return requested.startsWith(prefix) && requested.length > prefix.length
  }

  return granted === requested
}

function tokenHasAbility(record: PersonalAccessTokenRecord, ability: string): boolean {
  return record.abilities.some(grantedAbility => tokenAbilityMatches(grantedAbility, ability))
}

async function authenticateAccessTokenRecord(
  plainTextToken: string,
): Promise<{
  readonly token: PersonalAccessTokenRecord
  readonly user: SerializedAuthUser
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
  const normalizedRecord = normalizeTokenRecord(record)

  return Object.freeze({
    ...normalizedRecord,
    can: (ability: string) => tokenHasAbility(normalizedRecord, ability),
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

  await hydrateGuardContextFromRequest(guardName)

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
): Promise<AuthenticatedAuthUser | null> {
  const bindings = getRuntimeBindings()
  const guard = getGuardConfig(guardName)

  await hydrateGuardContextFromRequest(guardName)

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

async function loginForSessionGuard(guardName: string, credentials: AuthCredentials): Promise<AuthEstablishedSession> {
  const { guard, adapter } = getGuardProviderAdapter(guardName)
  const user = await verifyCredentialsForProvider(guard.provider, adapter, credentials)
  if (!user) {
    throwAuthError('invalid_credentials', 'Invalid credentials.')
  }

  const serialized = serializeUser(adapter, user, guard.provider)
  await hydrateGuardContextFromRequest(guardName)
  return establishSessionForUser(serialized, {
    guard: guardName,
    provider: guard.provider,
    remember: credentials.remember === true,
  })
}

async function loginForGuard(guardName: string, credentials: AuthCredentials): Promise<AuthEstablishedSession | PersonalAccessTokenResult> {
  const guard = getGuardConfig(guardName)
  if (guard.driver === 'session') {
    return loginForSessionGuard(guardName, credentials)
  }

  const { adapter } = getProviderAdapter(guard.provider)
  const user = await verifyCredentialsForProvider(guard.provider, adapter, credentials)
  if (!user) {
    throwAuthError('invalid_credentials', 'Invalid credentials.')
  }

  const serialized = serializeUser(adapter, user, guard.provider)
  return createLoginTokenForGuard(guardName, serialized)
}

function assertTrustedUserProvider(
  guardName: string,
  providerName: string,
  user: unknown,
): void {
  const markedProvider = readMarkedProvider(user)
  if (markedProvider && markedProvider !== providerName) {
    throwAuthError(
      'trusted_login_provider_mismatch',
      `Trusted login for guard "${guardName}" requires a user from provider "${providerName}", received "${markedProvider}".`,
      {
        guard: guardName,
        expectedProvider: providerName,
        receivedProvider: markedProvider,
      },
    )
  }

  const bindings = getRuntimeBindings()
  for (const [candidateProviderName, adapter] of Object.entries(bindings.providers)) {
    if (candidateProviderName === providerName) {
      continue
    }

    if (adapter.matchesUser?.(user) === true) {
      throwAuthError(
        'trusted_login_provider_mismatch',
        `Trusted login for guard "${guardName}" requires a user from provider "${providerName}", received "${candidateProviderName}".`,
        {
          guard: guardName,
          expectedProvider: providerName,
          receivedProvider: candidateProviderName,
        },
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

  const serializedRecord = serialized as unknown as Readonly<Record<string, unknown>>

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
    throwAuthError('trusted_login_user_required', 'Trusted login requires a user or user id.', {
      guard: guardName,
    })
  }

  if (typeof candidate === 'string' || typeof candidate === 'number') {
    const user = await adapter.findById(candidate)
    if (!user) {
      throwAuthError(
        'trusted_login_user_not_found',
        `Auth user "${provider}:${String(candidate)}" was not found for trusted login.`,
        {
          guard: guardName,
          provider,
          userId: candidate,
        },
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
      throwAuthError(
        'trusted_login_user_incompatible',
        `Trusted login for guard "${guardName}" requires a user value compatible with provider "${provider}".`,
        {
          guard: guardName,
          provider,
        },
      )
    }

    const user = await adapter.findById(userId)
    if (!user) {
      throwAuthError(
        'trusted_login_user_not_found',
        `Auth user "${provider}:${String(userId)}" was not found for trusted login.`,
        {
          guard: guardName,
          provider,
          userId,
        },
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
        throwAuthError(
          'trusted_login_provider_mismatch',
          `Trusted login for guard "${guardName}" requires a user from provider "${provider}". Pass a user id, a serialized auth user, or implement matchesUser() on the provider adapter.`,
          {
            guard: guardName,
            expectedProvider: provider,
          },
        )
      }

      return {
        provider,
        adapter,
        user: requireRecordValue(user, '[@holo-js/auth] Auth provider lookups must return object users.'),
      }
    }
  }

  throwAuthError(
    'trusted_login_user_incompatible',
    `Trusted login for guard "${guardName}" requires a user value compatible with provider "${provider}".`,
    {
      guard: guardName,
      provider,
    },
  )
}

async function loginUsingForGuard(
  guardName: string,
  user: unknown,
  options: AuthSessionLoginOptions = {},
): Promise<AuthEstablishedSession> {
  const resolved = await resolveTrustedUserForGuard(guardName, user)
  const serialized = serializeUser(resolved.adapter, resolved.user, resolved.provider)

  await hydrateGuardContextFromRequest(guardName)
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
    throwAuthError(
      'impersonation_actor_required',
      `Impersonation for guard "${guardName}" requires an authenticated actor on guard "${actorGuard}".`,
      {
        guard: guardName,
        actorGuard,
      },
    )
  }

  if (actorState.payload.impersonation) {
    throwAuthError('impersonation_nested_unsupported', `Nested impersonation is not supported for guard "${actorGuard}".`, {
      guard: guardName,
      actorGuard,
    })
  }

  const targetState = await readGuardSessionState(guardName)
  if (targetState?.payload.impersonation) {
    throwAuthError('impersonation_already_active', `Guard "${guardName}" is already impersonating another user.`, {
      guard: guardName,
    })
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

async function stopImpersonatingForGuard(guardName: string): Promise<AuthenticatedAuthUser | null> {
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

  await hydrateGuardContextFromRequest(guardName)

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

  const cookies = buildLogoutCookies(bindings, guardName, { clearSessionCookies })
  await appendResponseCookies(bindings, cookies)

  return Object.freeze({
    guard: guardName,
    cookies,
  })
}

async function registerUserForGuard(guardName: string, input: AuthRegistrationInput): Promise<SerializedAuthUser> {
  ensurePasswordConfirmation(input)

  const bindings = getRuntimeBindings()
  const guard = getGuardConfig(guardName)
  const { adapter } = getProviderAdapter(guard.provider)
  const identifiers = getProviderIdentifiers(guard.provider)
  const lookup = toLookupCredentials(input, identifiers)
  for (const [identifier, value] of Object.entries(lookup)) {
    const existing = await adapter.findByCredentials({
      [identifier]: value,
    })
    if (existing) {
      throwAuthError('registration_identifier_taken', `A user with this ${identifier} already exists.`, {
        identifier,
      })
    }
  }

  const password = await bindings.passwordHasher.hash(input.password)
  const user = await adapter.create(toRegistrationRecord(input, password))
  const serialized = serializeUser(adapter, user, guard.provider)
  if (isEmailVerificationRequired()) {
    try {
      await createEmailVerificationFacade().create(serialized, {
        guard: guardName,
      })
    } catch (error) {
      await bindings.emailVerificationTokens?.deleteByUserId(guard.provider, serialized.id).catch(() => undefined)
      await rollbackRegisteredUser(adapter, user, serialized).catch(() => undefined)
      throw error
    }
  }

  return serialized
}

async function registerDefaultUser(input: AuthRegistrationInput): Promise<AuthenticatedAuthUser> {
  return registerUserForGuard(getRuntimeBindings().config.defaults.guard, input)
}

async function registerForGuard(guardName: string, input: AuthRegistrationInput): Promise<AuthenticatedAuthUser | PersonalAccessTokenResult> {
  const guard = getGuardConfig(guardName)
  if (guard.driver === 'token') {
    ensureTokenStore()
    const user = await registerUserForGuard(guardName, input)
    try {
      return await createLoginTokenForGuard(guardName, user)
    } catch (error) {
      await rollbackSerializedUserForGuard(guardName, user).catch(() => undefined)
      throw error
    }
  }

  return registerUserForGuard(guardName, input)
}

async function rollbackRegisteredUser(
  adapter: ErasedAuthProviderAdapter,
  createdUser: unknown,
  serialized: SerializedAuthUser,
): Promise<void> {
  if (createdUser && typeof createdUser === 'object' && 'delete' in createdUser && typeof createdUser.delete === 'function') {
    try {
      await createdUser.delete()
      return
    } catch (deleteError) {
      if (adapter.delete) {
        try {
          await adapter.delete(serialized.id)
        } catch (adapterDeleteError) {
          throw new AggregateError(
            [deleteError, adapterDeleteError],
            'Failed to rollback the registered user.',
          )
        }
      }

      throw deleteError
    }
  }

  if (adapter.delete) {
    await adapter.delete(serialized.id)
  }
}

async function rollbackSerializedUserForGuard(guardName: string, user: SerializedAuthUser): Promise<void> {
  const guard = getGuardConfig(guardName)
  const { adapter } = getProviderAdapter(guard.provider)
  let adapterDeleteError: unknown
  if (adapter.delete) {
    try {
      await adapter.delete(user.id)
      return
    } catch (error) {
      adapterDeleteError = error
    }
  }

  const createdUser = await adapter.findById(user.id)
  if (createdUser && typeof createdUser === 'object' && 'delete' in createdUser && typeof createdUser.delete === 'function') {
    await createdUser.delete()
    return
  }

  if (adapterDeleteError) {
    throw adapterDeleteError
  }
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

  throwAuthError(
    'provider_resolution_required',
    'Unable to resolve a provider for the given user. Pass a guard explicitly when multiple auth providers are configured.',
  )
}

async function establishSessionForUser(
  user: SerializedAuthUser,
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
    ?? toSessionPayload(options.guard, options.provider, user)
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
  const shouldClearRememberCookie = !!(
    !options.remember
    && !preserveRememberSession
    && (
      existingSession?.rememberTokenHash
      || bindings.context.getRememberToken?.(options.guard)
    )
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
    ...(!rememberToken && shouldClearRememberCookie
      ? [forgetDefaultRememberCookie(bindings)].filter((cookie): cookie is string => typeof cookie === 'string')
      : []),
  ]
  await appendResponseCookies(bindings, cookies)

  return Object.freeze({
    guard: options.guard,
    provider: resolveSessionPayloadProvider(sessionPayload),
    user,
    sessionId: session.id,
    rememberToken,
    cookies: Object.freeze(cookies),
    ...(isEmailVerificationRequired() && !hasVerifiedEmail(user as unknown as Readonly<Record<string, unknown>>)
      ? {
          emailVerificationRequired: true,
          emailVerificationRoute: createEmailVerificationRedirectRoute(user),
        }
      : {}),
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

function createLoginTokenForGuard(
  guardName: string,
  user: AuthUser,
): Promise<PersonalAccessTokenResult> {
  return createTokenFacade().create(user, {
    guard: guardName,
    name: guardName,
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
): Promise<AuthenticatedAuthUser> {
  const { adapter } = getProviderAdapter(providerName)
  const user = await adapter.findById(userId)
  if (!user) {
    throwAuthError('auth_user_missing', `Auth user "${providerName}:${String(userId)}" no longer exists.`, {
      provider: providerName,
      userId,
    })
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
    throwAuthError(
      'provider_update_unsupported',
      `Auth provider "${providerName}" must implement update() to persist user changes.`,
      {
        provider: providerName,
      },
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
        throwAuthError('email_required_for_verification', 'Email verification requires a user with an email address.')
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
        route: getEmailVerificationRoute(),
      })
      return result
    },
    async resend(options: { readonly guard?: string, readonly expiresAt?: Date, readonly email?: string } = {}): Promise<EmailVerificationTokenResult> {
      return unwrapExpectedAuthResult(await captureExpectedAuthResult(async () => {
        const guardName = options.guard ?? getDefaultGuardName()
        let currentUser: AuthenticatedAuthUser | null
        if (typeof options.email === 'string' && options.email.trim().length > 0) {
          const { provider, adapter } = getGuardProviderAdapter(guardName)
          const matchedUser = await adapter.findByCredentials({
            email: options.email.trim(),
          })
          currentUser = matchedUser
            ? serializeUser(adapter, matchedUser, provider)
            : null
        } else {
          currentUser = await resolveUserFromGuard(guardName, { fresh: true })
        }

        if (!currentUser) {
          throwAuthError('email_verification_user_missing', 'Sign in before requesting another verification email.', {
            guard: guardName,
          })
        }

        if (hasVerifiedEmail(currentUser as unknown as Readonly<Record<string, unknown>>)) {
          throwAuthError('email_already_verified', 'Your email address is already verified.', {
            guard: guardName,
          })
        }

        return await this.create(currentUser, {
          guard: guardName,
          expiresAt: options.expiresAt,
        })
      }, EXPECTED_EMAIL_VERIFICATION_RESEND_ERRORS, createEmailVerificationResendFailure))
    },
    async consume(plainTextToken: string): Promise<AuthenticatedAuthUser> {
      return unwrapExpectedAuthResult(await captureExpectedAuthResult(async () => {
        const parsed = parsePlainTextToken(plainTextToken)
        if (!parsed) {
          throwAuthError('email_verification_token_invalid', 'Invalid email verification token.')
        }

        const store = ensureEmailVerificationTokenStore()
        const record = await store.findById(parsed.id)
        if (!record || !verifyTokenSecret(parsed.secret, record.tokenHash) || record.expiresAt.getTime() <= Date.now()) {
          throwAuthError('email_verification_token_expired', 'Invalid or expired email verification token.')
        }

        await store.delete(record.id)
        const updated = await updateUserRecord(record.provider, record.userId, {
          email_verified_at: new Date(),
        })
        return updated
      }, EXPECTED_EMAIL_VERIFICATION_CONSUME_ERRORS, createEmailVerificationConsumeFailure))
    },
  })
}

function createEmailVerificationResendInput(
  email?: string,
  options: AuthEmailVerificationSendOptions = {},
): { readonly guard?: string, readonly expiresAt?: Date, readonly email?: string } {
  return {
    ...options,
    ...(typeof email === 'string' ? { email } : {}),
  }
}

async function requestPasswordResetUsingRuntime<TInput extends AuthPasswordResetRequestInput>(
  input: TInput,
  options: AuthPasswordResetRequestOptions = {},
): Promise<AuthResult<void, AuthPasswordResetRequestErrorCode, Partial<Record<InputFieldName<TInput>, readonly string[]>>>> {
  return captureExpectedAuthResult(async () => {
    const normalizedEmail = input.email.trim()
    if (!normalizedEmail) {
      throwAuthError('password_reset_email_required', 'Email is required to request a password reset.')
    }

    const bindings = getRuntimeBindings()
    const brokerName = options.broker ?? bindings.config.defaults.passwords
    const broker = bindings.config.passwords[brokerName]
    if (!broker) {
      throwAuthError('password_broker_not_configured', `Password broker "${brokerName}" is not configured.`, {
        broker: brokerName,
      })
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
          broker: brokerName,
          provider: broker.provider,
          email: normalizedEmail,
          token: result,
          route: getPasswordResetRoute(brokerName),
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
  }, EXPECTED_PASSWORD_RESET_REQUEST_ERRORS, error => createPasswordResetRequestFailure(error, input))
}

async function resetPasswordUsingRuntime<TInput extends AuthPasswordResetInput>(
  input: TInput,
): Promise<AuthResult<AuthenticatedAuthUser, AuthPasswordResetConsumeErrorCode, Partial<Record<InputFieldName<TInput>, readonly string[]>>>> {
  return captureExpectedAuthResult(async () => {
    if (input.password !== input.passwordConfirmation) {
      throwAuthError('password_confirmation_mismatch', 'Password confirmation does not match.')
    }

    const parsed = parsePlainTextToken(input.token)
    if (!parsed) {
      throwAuthError('password_reset_token_invalid', 'Invalid password reset token.')
    }

    const store = ensurePasswordResetTokenStore()
    const record = await store.findById(parsed.id)
    if (!record || !verifyTokenSecret(parsed.secret, record.tokenHash) || record.expiresAt.getTime() <= Date.now()) {
      throwAuthError('password_reset_token_expired', 'Invalid or expired password reset token.')
    }

    const { adapter } = getProviderAdapter(record.provider)
    const user = await adapter.findByCredentials({
      email: record.email,
    })
    if (!user) {
      throwAuthError('password_reset_user_missing', 'Password reset token user no longer exists.', {
        provider: record.provider,
        email: record.email,
      })
    }

    const password = await getRuntimeBindings().passwordHasher.hash(input.password)
    const userId = requireUserId(
      adapter,
      user,
      '[@holo-js/auth] Password reset token user is invalid.',
    )
    await store.delete(record.id, {
      table: record.table,
    })
    await store.deleteByEmail(record.provider, record.email, {
      table: record.table,
    })
    const updated = await updateUserRecord(record.provider, userId, {
      password,
    })
    return updated
  }, EXPECTED_PASSWORD_RESET_CONSUME_ERRORS, error => createPasswordResetConsumeFailure(error, input))
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
    async authenticate(plainTextToken: string): Promise<AuthenticatedAuthUser | null> {
      const authenticated = await authenticateAccessTokenRecord(plainTextToken)
      return authenticated?.user ?? null
    },
    async can(token: string, ability: string): Promise<boolean> {
      const authenticated = await authenticateAccessTokenRecord(token)
      return authenticated ? tokenHasAbility(authenticated.token, ability) : false
    },
  })
}

function createGuardFacade(guardName: string): AuthSessionGuardFacade | AuthTokenGuardFacade {
  const guard = getGuardConfig(guardName)
  const base = {
    check() {
      return checkForGuard(guardName)
    },
    user() {
      return userForGuard(guardName)
    },
    refreshUser() {
      return refreshUserForGuard(guardName)
    },
    provider() {
      return providerForGuard(guardName)
    },
    async id() {
      return (await userForGuard(guardName))?.id ?? null
    },
    currentAccessToken() {
      return resolveCurrentAccessTokenForGuard(guardName)
    },
    async login<TCredentials extends AuthCredentials>(credentials: TCredentials) {
      return unwrapExpectedAuthResult(await captureExpectedAuthResult(
        () => loginForGuard(guardName, credentials),
        EXPECTED_LOGIN_ERRORS,
        error => guard.driver === 'token'
          ? createTokenLoginFailure(error, credentials)
          : createLoginFailure(error, credentials),
      ))
    },
    async register<TInput extends AuthRegistrationInput>(input: TInput) {
      return unwrapExpectedAuthResult(await captureExpectedAuthResult(
        () => registerForGuard(guardName, input),
        EXPECTED_REGISTRATION_ERRORS,
        error => createRegistrationFailure(error, input),
      ))
    },
    logout() {
      return logoutForGuard(guardName)
    },
  }

  if (guard.driver === 'token') {
    return Object.freeze(base) as AuthTokenGuardFacade
  }

  return Object.freeze({
    ...base,
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
  }) as AuthSessionGuardFacade
}

export function configureAuthRuntime(bindings?: AuthRuntimeBindings): void {
  if (!bindings) {
    getAuthRuntimeState().bindings = undefined
    return
  }

  const config = normalizeAuthConfig(bindings.config)
  const defaultGuard = config.guards[config.defaults.guard]
  if (defaultGuard?.driver === 'token') {
    throw new Error(
      `[@holo-js/auth] The default auth guard "${config.defaults.guard}" uses the token driver. `
      + 'Use a session-backed default guard for top-level login/register, or call auth.guard(name).login/register for token guards.',
    )
  }

  getAuthRuntimeState().bindings = {
    config,
    session: bindings.session,
    providers: bindings.providers,
    tokens: bindings.tokens,
    emailVerificationTokens: bindings.emailVerificationTokens,
    passwordResetTokens: bindings.passwordResetTokens,
    delivery: bindings.delivery ?? createDefaultDeliveryHook(),
    context: bindings.context ?? createMemoryAuthContext(),
    passwordHasher: bindings.passwordHasher ?? createDefaultPasswordHasher(),
    authorization: bindings.authorization,
  }
}

export function getAuthRuntime(): AuthRuntimeFacade {
  const getDefaultGuardName = () => getRuntimeBindings().config.defaults.guard
  const tokens = createTokenFacade()
  const verification = createEmailVerificationFacade()

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
    provider() {
      return providerForGuard(getDefaultGuardName())
    },
    async id() {
      return (await userForGuard(getDefaultGuardName()))?.id ?? null
    },
    currentAccessToken() {
      return resolveCurrentAccessTokenForGuard(getDefaultGuardName())
    },
    async login<TCredentials extends AuthCredentials>(credentials: TCredentials) {
      return unwrapExpectedAuthResult(await captureExpectedAuthResult(
        () => loginForSessionGuard(getDefaultGuardName(), credentials),
        EXPECTED_LOGIN_ERRORS,
        error => createLoginFailure(error, credentials),
      ))
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
    async register<TInput extends AuthRegistrationInput>(input: TInput) {
      return unwrapExpectedAuthResult(await captureExpectedAuthResult(
        () => registerDefaultUser(input),
        EXPECTED_REGISTRATION_ERRORS,
        error => createRegistrationFailure(error, input),
      ))
    },
    async requestPasswordReset<TInput extends AuthPasswordResetRequestInput>(input: TInput, options?: AuthPasswordResetRequestOptions) {
      return unwrapExpectedAuthResult(await requestPasswordResetUsingRuntime(input, options))
    },
    async resetPassword<TInput extends AuthPasswordResetInput>(input: TInput) {
      return unwrapExpectedAuthResult(await resetPasswordUsingRuntime(input))
    },
    verifyEmail(token: string) {
      return verification.consume(token)
    },
    sendEmailVerification(email?: string, options?: AuthEmailVerificationSendOptions) {
      return verification.resend(createEmailVerificationResendInput(email, options))
    },
    resendEmailVerification(email?: string, options?: AuthEmailVerificationSendOptions) {
      return verification.resend(createEmailVerificationResendInput(email, options))
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
    guard<TName extends string>(name: TName): string extends TName ? AuthGuardFacade : AuthGuardFacadeFor<TName> {
      return createGuardFacade(name) as string extends TName ? AuthGuardFacade : AuthGuardFacadeFor<TName>
    },
    tokens,
    verification,
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
  resetOptionalSecurityModuleCache()
}

export async function checkForGuard(guardName: string): Promise<boolean> {
  return (await userForGuard(guardName)) !== null
}

export async function userForGuard(guardName: string): Promise<AuthenticatedAuthUser | null> {
  return resolveUserFromGuard(guardName)
}

export async function refreshUserForGuard(guardName: string): Promise<AuthenticatedAuthUser | null> {
  return resolveUserFromGuard(guardName, { fresh: true })
}

export async function providerForGuard(guardName: string): Promise<string | null> {
  const bindings = getRuntimeBindings()
  const guard = getGuardConfig(guardName)
  const authenticatedUser = await resolveUserFromGuard(guardName)
  if (!authenticatedUser) {
    return null
  }

  if (guard.driver === 'token') {
    return readMarkedProvider(authenticatedUser) ?? null
  }

  const sessionId = bindings.context.getSessionId(guardName)
  if (!sessionId) {
    return null
  }

  const payload = readSessionPayload(await bindings.session.read(sessionId), guardName)

  return payload ? resolveSessionPayloadProvider(payload) : null
}

export async function check(): Promise<boolean> {
  return getAuthRuntime().check()
}

export async function user(): Promise<AuthenticatedAuthUser | null> {
  return getAuthRuntime().user()
}

export async function refreshUser(): Promise<AuthenticatedAuthUser | null> {
  return getAuthRuntime().refreshUser()
}

export async function provider(): Promise<string | null> {
  return getAuthRuntime().provider()
}

export async function id(): Promise<string | number | null> {
  return getAuthRuntime().id()
}

export async function currentAccessToken(): Promise<AuthCurrentAccessToken | null> {
  return getAuthRuntime().currentAccessToken()
}

export async function login<TCredentials extends AuthCredentials>(
  credentials: TCredentials,
): Promise<AuthEstablishedSession> {
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

export async function stopImpersonating(): Promise<AuthenticatedAuthUser | null> {
  return getAuthRuntime().stopImpersonating()
}

export async function hashPassword(password: string): Promise<string> {
  const bindings = getAuthRuntimeState().bindings
  return bindings
    ? getAuthRuntime().hashPassword(password)
    : createDefaultPasswordHasher().hash(password)
}

export async function verifyPassword(password: string, digest: string): Promise<boolean> {
  const bindings = getAuthRuntimeState().bindings
  return bindings
    ? getAuthRuntime().verifyPassword(password, digest)
    : createDefaultPasswordHasher().verify(password, digest)
}

export async function needsPasswordRehash(digest: string): Promise<boolean> {
  const bindings = getAuthRuntimeState().bindings
  return bindings
    ? getAuthRuntime().needsPasswordRehash(digest)
    : resolveNeedsPasswordRehash(createDefaultPasswordHasher(), digest)
}

export async function logout(): Promise<AuthLogoutResult> {
  return getAuthRuntime().logout()
}

export async function register<TInput extends AuthRegistrationInput>(
  input: TInput,
): Promise<AuthenticatedAuthUser> {
  return getAuthRuntime().register(input)
}

export async function requestPasswordReset<TInput extends AuthPasswordResetRequestInput>(
  input: TInput,
  options?: AuthPasswordResetRequestOptions,
): Promise<void> {
  return getAuthRuntime().requestPasswordReset(input, options)
}

export async function resetPassword<TInput extends AuthPasswordResetInput>(
  input: TInput,
): Promise<AuthenticatedAuthUser> {
  return getAuthRuntime().resetPassword(input)
}

export function verifyEmail(
  token: string,
): Promise<AuthenticatedAuthUser> {
  return getAuthRuntime().verifyEmail(token)
}

export function sendEmailVerification(): Promise<EmailVerificationTokenResult>
export function sendEmailVerification(email: string): Promise<EmailVerificationTokenResult>
export function sendEmailVerification(email: string | undefined): Promise<EmailVerificationTokenResult>
export function sendEmailVerification(email: string | undefined, options: AuthEmailVerificationSendOptions): Promise<EmailVerificationTokenResult>
export function sendEmailVerification(
  email?: string,
  options?: AuthEmailVerificationSendOptions,
): Promise<EmailVerificationTokenResult> {
  return getAuthRuntime().verification.resend(createEmailVerificationResendInput(email, options))
}

export function resendEmailVerification(): Promise<EmailVerificationTokenResult>
export function resendEmailVerification(email: string): Promise<EmailVerificationTokenResult>
export function resendEmailVerification(email: string | undefined): Promise<EmailVerificationTokenResult>
export function resendEmailVerification(email: string | undefined, options: AuthEmailVerificationSendOptions): Promise<EmailVerificationTokenResult>
export function resendEmailVerification(
  email?: string,
  options?: AuthEmailVerificationSendOptions,
): Promise<EmailVerificationTokenResult> {
  return getAuthRuntime().verification.resend(createEmailVerificationResendInput(email, options))
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
  resend(options?: { readonly guard?: string, readonly expiresAt?: Date, readonly email?: string }) {
    return getAuthRuntime().verification.resend(options)
  },
  consume(plainTextToken: string) {
    return getAuthRuntime().verification.consume(plainTextToken)
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
  isResponseInterrupt: isAuthResponseInterrupt,
  parsePlainTextToken,
  parseSetCookieDefinition,
  readSessionPayload,
  redirectResponse,
  serializeCookie,
  toLookupCredentials,
  toPlainTextTokenResult,
  tokenHasAbility,
  throwUnconfigured,
  updateUserRecord,
  verifyTokenSecret,
  writeSessionPayloads,
}
