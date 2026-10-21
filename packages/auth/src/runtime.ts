import { reportError } from '@holo-js/kernel/error-reporting'
import { syncHostedIdentity } from './runtime/hostedIdentitySync'
import { clearSessionRevocationReads, loginRevocationMetadata, validSessionPayloads } from './runtime/sessionRevocations'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { normalizeAuthConfig } from './config'
import { isAuthError } from './contracts'
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
  AuthMultiFactorCodeInput,
  AuthMultiFactorCredentialRecord,
  AuthMultiFactorEnrollment,
  AuthMultiFactorFacade,
  AuthMultiFactorRecoveryCodes,
  AuthMultiFactorStore,
  AuthMultiFactorVerificationInput,
  AuthMultiFactorVerificationState,
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
  AuthSessionRuntime,
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
  authRequestScope,
  captureAuthRequestContext,
  getCapturedAuthContext,
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
} from './runtime/optionalSecurity'
import {
  COOKIE_WRITE_UNAVAILABLE,
  appendResponseCookies,
  assertResponseCookiesWritable,
  isAuthResponseInterrupt,
  parseBearerToken,
  redirectResponse,
  resolveRequestCookie,
  resolveRequestHeader,
  responseCookiesWritable,
} from './runtime/requestAccess'
import { authJwtInternals } from './runtime/jwt'
import { normalizeRequestInput, resolveClientAddress } from './runtime/requestNormalization'
import {
  isTokenExpired,
  normalizeTokenRecord,
  parsePlainTextToken,
  tokenHasAbility,
} from './runtime/tokens'
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
import { AUTH_TIMEBOX_MILLISECONDS, callTimebox } from './runtime/timebox'
import {
  createRememberToken,
  decodeRememberRecaller,
  encodeRememberRecaller,
  hashPasswordForRemember,
  parseRememberCookie,
  rememberSecretsMatch,
  serializeRememberCookie,
} from './runtime/rememberMe'
import {
  readSessionPayload,
  readSessionPayloads,
  resolveSessionPayloadProvider,
  stripImpersonation,
  toSessionPayload,
  writeSessionPayloads,
  type SerializedAuthUser,
  type SessionAuthPayload,
  type SessionAuthPayloadMap,
  type SessionImpersonationPayload,
} from './runtime/sessionPayloads'
import {
  createMultiFactorRecoveryCodes,
  createMultiFactorSecret,
  decryptMultiFactorValue,
  encryptMultiFactorValue,
  hashMultiFactorRecoveryCode,
  matchingTotpCounters,
  multiFactorInternals,
  multiFactorOtpAuthUri,
} from './runtime/multiFactor'

const AUTH_PROVIDER_MARKER = Symbol.for('holo-js.auth.provider')
const MAX_MULTI_FACTOR_CHALLENGE_ATTEMPTS = 5
const NEVER_AUTHENTICATED_AT = new Date(0).toISOString()

export {
  createAsyncAuthContext,
  createMemoryAuthContext,
} from './runtime/context'

type ErasedAuthProviderAdapter = {
  findById(id: string | number): Promise<unknown | null>
  findByCredentials(credentials: Readonly<Record<string, unknown>>): Promise<unknown | null>
  create(input: Readonly<Record<string, unknown>>): Promise<unknown>
  delete?(id: string | number): Promise<void>
  update?(user: unknown, input: Readonly<Record<string, unknown>>): Promise<unknown>
  matchesUser?(user: unknown): boolean
  getId(user: unknown): string | number
  getPasswordHash?(user: unknown): string | null | undefined
  getRememberToken?(user: unknown): string | null | undefined
  updateRememberToken?(user: unknown, token: string): Promise<void>
  getEmailVerifiedAt?(user: unknown): Date | string | null | undefined
  serialize?(user: unknown): Record<string, unknown>
}

type RuntimeConfigurationBindings = Omit<AuthRuntimeBindings, 'providers'> & {
  readonly providers: Readonly<Record<string, ErasedAuthProviderAdapter>>
}

type RuntimeBindings = {
  readonly config: ReturnType<typeof normalizeAuthConfig>
  readonly sessionRevocations?: AuthRuntimeBindings['sessionRevocations']
  readonly session: AuthRuntimeBindings['session']
  readonly providers: Readonly<Record<string, ErasedAuthProviderAdapter>>
  readonly tokens?: AuthTokenStore
  readonly emailVerificationTokens?: EmailVerificationTokenStore
  readonly passwordResetTokens?: PasswordResetTokenStore
  readonly multiFactor?: AuthMultiFactorStore
  readonly multiFactorEncryptionKey?: string
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
  const configured = getAuthRuntimeState().bindings
  if (!configured) {
    throwUnconfigured()
  }
  const context = getCapturedAuthContext()
  const bindings = context ? { ...configured, context } : configured

  if (hasContextActivator(bindings.context)) {
    bindings.context.activate()
  }

  return bindings
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
    reportError(error, { capability: 'auth', operation: 'passwordReset.clearReservation' })
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

async function resolveHoloCookie(bindings: RuntimeBindings, emptySetCookie: string): Promise<string | undefined> {
  const { name } = parseSetCookieDefinition(emptySetCookie)!
  const value = await resolveRequestCookie(bindings, name)
  return value ? bindings.session.decryptCookie(name, value) : undefined
}

const requestRememberEntries = new WeakMap<object, Promise<Map<string, string>>>()
const requestRememberLoads = new WeakMap<object, Promise<void>>()
const requestRememberHydrations = new WeakMap<object, Map<string, Promise<void>>>()
const requestSessionQueues = new WeakMap<object, Promise<unknown>>()
const requestOnlyGuards = new WeakMap<object, Set<string>>()

function queueRequestSession<TValue>(bindings: RuntimeBindings, operation: () => Promise<TValue>): Promise<TValue> {
  const scope = authRequestScope(bindings.context)
  if (!scope) return operation()
  const previous = requestSessionQueues.get(scope) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(operation)
  requestSessionQueues.set(scope, next)
  return next
}

function setRequestOnlyGuard(bindings: RuntimeBindings, guardName: string, requestOnly: boolean): void {
  const scope = authRequestScope(bindings.context)
  if (!scope) return
  const guards = requestOnlyGuards.get(scope) ?? new Set<string>()
  if (requestOnly) guards.add(guardName)
  else guards.delete(guardName)
  requestOnlyGuards.set(scope, guards)
}

function isRequestOnlyGuard(bindings: RuntimeBindings, guardName: string): boolean {
  const scope = authRequestScope(bindings.context)
  return scope ? requestOnlyGuards.get(scope)?.has(guardName) ?? false : false
}


function readRememberCookieEntries(bindings: RuntimeBindings): Promise<Map<string, string>> {
  const key = authRequestScope(bindings.context)
  const existing = key ? requestRememberEntries.get(key) : undefined
  if (existing) return existing
  const entries = resolveHoloCookie(bindings, bindings.session.rememberMeCookie('')).then(parseRememberCookie)
  if (key) requestRememberEntries.set(key, entries)
  return entries
}

function loadRememberCookies(bindings: RuntimeBindings): Promise<void> {
  const key = authRequestScope(bindings.context)
  const existing = key ? requestRememberLoads.get(key) : undefined
  if (existing) return existing
  const load = (async () => {
    for (const [name, recaller] of await readRememberCookieEntries(bindings)) {
      if (sessionGuardNames(bindings).includes(name)) bindings.context.setRememberToken?.(name, recaller)
    }
  })()
  if (key) requestRememberLoads.set(key, load)
  return load
}

async function getRememberRecaller(bindings: RuntimeBindings, guardName: string): Promise<string | undefined> {
  await loadRememberCookies(bindings)
  return bindings.context.getRememberToken && bindings.context.setRememberToken
    ? bindings.context.getRememberToken(guardName)
    : (await readRememberCookieEntries(bindings)).get(guardName)
}

async function setRememberRecaller(bindings: RuntimeBindings, guardName: string, recaller?: string): Promise<void> {
  const entries = await readRememberCookieEntries(bindings)
  if (recaller) entries.set(guardName, recaller)
  else entries.delete(guardName)
  bindings.context.setRememberToken?.(guardName, recaller)
}

function sessionGuardNames(bindings: RuntimeBindings): readonly string[] {
  return Object.entries(bindings.config.guards)
    .filter(([, guard]) => guard.driver === 'session')
    .map(([name]) => name)
}

function requireRememberWriteScope(bindings: RuntimeBindings): void {
  if (!authRequestScope(bindings.context)) {
    throwAuthError('runtime_unconfigured', 'Remember-cookie writes require a request-scoped auth context. Provide getRequestScope().')
  }
}

async function checkRememberWriteScope(bindings: RuntimeBindings, guardName: string, remember = false): Promise<void> {
  if (!authRequestScope(bindings.context) && (remember || await getRememberRecaller(bindings, guardName))) {
    requireRememberWriteScope(bindings)
  }
}

async function rememberCookieFor(bindings: RuntimeBindings, guardName: string, recaller?: string): Promise<string | undefined> {
  requireRememberWriteScope(bindings)
  await loadRememberCookies(bindings)
  const entries = new Map<string, string>()
  for (const name of sessionGuardNames(bindings)) {
    const current = name === guardName ? recaller : await getRememberRecaller(bindings, name)
    if (current) entries.set(name, current)
  }
  await setRememberRecaller(bindings, guardName, recaller)
  const value = serializeRememberCookie(entries)
  return value ? bindings.session.rememberMeCookie(value) : forgetDefaultRememberCookie(bindings)
}

function requireRememberTokenUpdates(
  adapter: ErasedAuthProviderAdapter,
  providerName: string,
): NonNullable<ErasedAuthProviderAdapter['updateRememberToken']> {
  if (!adapter.updateRememberToken) {
    throwAuthError('runtime_unconfigured', `Auth provider "${providerName}" cannot store remember tokens.`)
  }
  return adapter.updateRememberToken.bind(adapter)
}

function getRememberToken(adapter: ErasedAuthProviderAdapter, user: unknown): string | null {
  const value = adapter.getRememberToken
    ? adapter.getRememberToken(user)
    : requireRecordValue(user, '[@holo-js/auth] Auth provider users must be objects.').remember_token
  return typeof value === 'string' && value.length > 0 ? value : null
}

function rememberRecallerFor(adapter: ErasedAuthProviderAdapter, user: unknown, token: string): string {
  const lifetimeMinutes = getRuntimeBindings().session.rememberMeLifetimeMinutes?.()
  if (lifetimeMinutes === undefined) {
    throwAuthError('runtime_unconfigured', 'Remember-me requires a session runtime that reports its remember lifetime.')
  }
  const expiresAt = Date.now() + lifetimeMinutes * 60_000
  return encodeRememberRecaller([adapter.getId(user), token, hashPasswordForRemember(getPasswordHash(adapter, user)), expiresAt])
}

async function ensureRememberRecaller(providerName: string, userId: string | number): Promise<string> {
  const { adapter } = getProviderAdapter(providerName)
  const updateRememberToken = requireRememberTokenUpdates(adapter, providerName)
  const user = await adapter.findById(userId)
  if (!user) throwAuthError('auth_user_missing', 'The authenticated user no longer exists.')
  let token = getRememberToken(adapter, user)
  if (!token) {
    token = createRememberToken()
    await updateRememberToken(user, token)
  }
  return rememberRecallerFor(adapter, user, token)
}

async function rotateRememberToken(
  providerName: string,
  userId: string | number,
): Promise<{ readonly adapter: ErasedAuthProviderAdapter, readonly user: unknown, readonly token: string } | undefined> {
  const { adapter } = getProviderAdapter(providerName)
  const user = await adapter.findById(userId)
  if (!user || !getRememberToken(adapter, user)) return undefined
  const token = createRememberToken()
  await requireRememberTokenUpdates(adapter, providerName)(user, token)
  return { adapter, user, token }
}

async function cycleRememberToken(providerName: string, userId: string | number): Promise<string | undefined> {
  const rotated = await rotateRememberToken(providerName, userId)
  return rotated ? rememberRecallerFor(rotated.adapter, rotated.user, rotated.token) : undefined
}

async function guardHasSessionPayload(bindings: RuntimeBindings, guardName: string): Promise<boolean> {
  const sessionId = bindings.context.getSessionId(guardName)
  return Boolean(sessionId && readSessionPayloads(await bindings.session.read(sessionId))?.[guardName])
}

function restoreRememberedSession(
  bindings: RuntimeBindings,
  guardName: string,
  provider: string,
  user: SerializedAuthUser,
  stillCurrent: () => Promise<boolean>,
): Promise<boolean> {
  return queueRequestSession(bindings, () => restoreRememberedSessionNow(bindings, guardName, provider, user, stillCurrent))
}

function isCookieWriteUnavailable(error: unknown): boolean {
  return (error as { readonly code?: unknown } | null)?.code === COOKIE_WRITE_UNAVAILABLE
}

async function restoreRememberedSessionNow(
  bindings: RuntimeBindings,
  guardName: string,
  provider: string,
  user: SerializedAuthUser,
  stillCurrent: () => Promise<boolean>,
): Promise<boolean> {
  const guardNames = sessionGuardNames(bindings)
  let source: AuthSessionRecord | null = null
  for (const sessionId of new Set([guardName, ...guardNames].map(name => bindings.context.getSessionId(name)))) {
    source = sessionId ? await bindings.session.read(sessionId) : null
    if (source) break
  }
  const sourcePayloads = readSessionPayloads(source) ?? {}
  const challengePending = Object.values(sourcePayloads).some(payload => payload.multiFactorChallengeExpiresAt)
  const revocation = bindings.sessionRevocations
    ? await loginRevocationMetadata(bindings.sessionRevocations, bindings.context, { provider, userId: user.id }, challengePending ? {} : sourcePayloads)
    : undefined
  if (!await stillCurrent()) return false
  if (challengePending || !await responseCookiesWritable(bindings)) {
    setRequestOnlyGuard(bindings, guardName, true)
    bindings.context.setCachedUser(guardName, user)
    return true
  }
  for (const name of guardNames) {
    const boundSessionId = bindings.context.getSessionId(name)
    if (boundSessionId && !await bindings.session.read(boundSessionId)) bindings.context.setSessionId(name)
  }
  try {
    await establishSessionForUser(user, {
      guard: guardName,
      provider,
      preserveRemember: true,
      payload: { ...toSessionPayload(guardName, provider, user), authenticatedAt: NEVER_AUTHENTICATED_AT, viaRemember: true },
      ...(revocation ? { revocation } : {}),
    })
  } catch (error) {
    if (!isCookieWriteUnavailable(error)) throw error
    setRequestOnlyGuard(bindings, guardName, true)
    bindings.context.setCachedUser(guardName, user)
  }
  return true
}

async function restoreFromRememberRecaller(bindings: RuntimeBindings, guardName: string, encoded: string): Promise<boolean> {
  const recaller = decodeRememberRecaller(encoded)
  if (!recaller || recaller[3] <= Date.now()) return false
  const guard = getGuardConfig(guardName)
  const { adapter } = getProviderAdapter(guard.provider)
  const matchesRecaller = async (): Promise<boolean> => {
    const user = await adapter.findById(recaller[0])
    const token = user ? getRememberToken(adapter, user) : null
    return Boolean(
      user
      && token
      && rememberSecretsMatch(token, recaller[1])
      && rememberSecretsMatch(hashPasswordForRemember(getPasswordHash(adapter, user)), recaller[2]),
    )
  }
  const user = await adapter.findById(recaller[0])
  if (!user || !await matchesRecaller()) return false
  return restoreRememberedSession(
    bindings,
    guardName,
    guard.provider,
    serializeUser(adapter, user, guard.provider),
    async () => recaller[3] > Date.now() && await matchesRecaller(),
  )
}

function hydrateRememberedGuard(bindings: RuntimeBindings, guardName: string, restore: boolean): Promise<void> {
  const key = authRequestScope(bindings.context)
  let hydrations = key ? requestRememberHydrations.get(key) : undefined
  const pending = hydrations?.get(guardName)
  if (pending) return pending
  const hydration = (async () => {
    await loadRememberCookies(bindings)
    const recaller = await getRememberRecaller(bindings, guardName)
    if (!recaller) return
    if (
      restore
      && !await guardHasSessionPayload(bindings, guardName)
      && !await restoreFromRememberRecaller(bindings, guardName, recaller)
    ) {
      await setRememberRecaller(bindings, guardName)
    }
  })()
  hydrations ??= new Map()
  hydrations.set(guardName, hydration)
  if (key) requestRememberHydrations.set(key, hydrations)
  return hydration
}

async function hydrateGuardContextFromRequest(
  guardName: string,
  options: { readonly restoreRemembered?: boolean } = {},
): Promise<void> {
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
    const sessionId = await resolveHoloCookie(bindings, bindings.session.sessionCookie(''))
    if (sessionId) {
      bindings.context.setSessionId(guardName, sessionId)
    }
  }

  await hydrateRememberedGuard(bindings, guardName, options.restoreRemembered !== false)
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

const dummyPasswordDigests = new WeakMap<AuthPasswordHasher, Promise<string>>()

function dummyPasswordDigest(hasher: AuthPasswordHasher): Promise<string> {
  const cached = dummyPasswordDigests.get(hasher)
  if (cached) {
    return cached
  }

  const digest = hasher.hash(randomBytes(32).toString('hex'))
  dummyPasswordDigests.set(hasher, digest)
  digest.catch(() => dummyPasswordDigests.delete(hasher))
  return digest
}

const REHASH_PASSWORD_IF_UNCHANGED = Symbol.for('holo.auth.rehashPasswordIfUnchanged')

type RehashPasswordIfUnchanged = (user: unknown, expectedDigest: string, newDigest: string) => Promise<boolean>

function getRehashPasswordIfUnchanged(adapter: ErasedAuthProviderAdapter): RehashPasswordIfUnchanged | undefined {
  const capability: unknown = Reflect.get(adapter, REHASH_PASSWORD_IF_UNCHANGED)
  return typeof capability === 'function' ? capability as RehashPasswordIfUnchanged : undefined
}

async function rehashPasswordAfterLogin({
  adapter,
  user,
  password,
  digest,
  hasher,
}: {
  readonly adapter: ErasedAuthProviderAdapter
  readonly user: unknown
  readonly password: string
  readonly digest: string | null | undefined
  readonly hasher: AuthPasswordHasher
}): Promise<void> {
  const rehashIfUnchanged = getRehashPasswordIfUnchanged(adapter)
  if (!digest || !adapter.update || !rehashIfUnchanged) {
    return
  }

  try {
    if (!await resolveNeedsPasswordRehash(hasher, digest)) {
      return
    }

    await rehashIfUnchanged.call(adapter, user, digest, await hasher.hash(password))
  } catch (error) {
    reportError(error, { capability: 'auth', operation: 'password.rehashOnLogin' })
  }
}

async function verifyCredentialsForProvider(
  providerName: string,
  adapter: ErasedAuthProviderAdapter,
  credentials: AuthCredentials,
): Promise<Record<string, unknown> | null> {
  return await callTimebox(async (timebox) => {
    const bindings = getRuntimeBindings()
    const user = await findUserByConfiguredIdentifiers(adapter, credentials, getProviderIdentifiers(providerName))
    const passwordHash = user ? getPasswordHash(adapter, user) : null
    const passwordMatches = await bindings.passwordHasher.verify(
      credentials.password,
      passwordHash || await dummyPasswordDigest(bindings.passwordHasher),
    )
    if (!user || !passwordMatches) {
      return null
    }

    await rehashPasswordAfterLogin({
      adapter,
      user,
      password: credentials.password,
      digest: passwordHash,
      hasher: bindings.passwordHasher,
    })
    timebox.returnEarly()
    return user
  }, AUTH_TIMEBOX_MILLISECONDS)
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
  return getRuntimeBindings().config.passwords[brokerName]!
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

async function createImpersonationState(
  payload: SessionAuthPayload,
): Promise<AuthImpersonationState | null> {
  const impersonation = payload.impersonation
  if (!impersonation) {
    return null
  }

  const user = await findSerializedUserById(payload.provider, payload.userId)
  const actor = await findSerializedUserById(impersonation.actor.provider, impersonation.actor.userId)
  const original = impersonation.original
    ? await findSerializedUserById(impersonation.original.provider, impersonation.original.userId)
    : null
  if (!user || !actor || (impersonation.original && !original)) {
    return null
  }

  return Object.freeze({
    guard: payload.guard,
    actorGuard: impersonation.actor.guard,
    user,
    actor,
    originalUser: original,
    startedAt: new Date(impersonation.startedAt),
  })
}

async function findSerializedUserById(
  providerName: string,
  userId: string | number,
): Promise<SerializedAuthUser | null> {
  const { adapter } = getProviderAdapter(providerName)
  const user = await adapter.findById(userId)
  return user ? serializeUser(adapter, user, providerName) : null
}

async function authenticateAccessTokenRecord(
  plainTextToken: string,
  provider?: string,
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
  if (!tokenRecord || (provider !== undefined && tokenRecord.provider !== provider) || !verifyTokenSecret(parsed.secret, tokenRecord.tokenHash) || isTokenExpired(tokenRecord)) {
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
  if (!record || record.provider !== guard.provider || !verifyTokenSecret(parsed.secret, record.tokenHash) || isTokenExpired(record)) {
    return null
  }

  const { adapter } = getProviderAdapter(guard.provider)
  if (!await adapter.findById(record.userId)) return null

  return createCurrentAccessTokenHandle(guardName, record)
}

async function filterRevokedSessionPayloads(bindings: RuntimeBindings, record: AuthSessionRecord): Promise<SessionAuthPayloadMap | null> {
  const payloads = readSessionPayloads(record)
  if (!payloads || !bindings.sessionRevocations) return payloads
  const valid = await validSessionPayloads(bindings.sessionRevocations, bindings.context, payloads)
  if (Object.keys(valid).length === Object.keys(payloads).length) return valid
  for (const name of Object.keys(payloads)) {
    if (name in valid) continue
    const boundSessionId = bindings.context.getSessionId(name)
    if (boundSessionId && boundSessionId !== record.id) continue
    bindings.context.setSessionId(name)
    bindings.context.setCachedUser(name, null)
    await setRememberRecaller(bindings, name)
  }
  if (!Object.keys(valid).length) await bindings.session.invalidate(record.id, { store: record.store })
  else await writeExistingSession(bindings, record, writeSessionPayloads(record.data, valid))
  return valid
}

async function logoutOtherDevicesForGuard(guardName: string): Promise<void> {
  const bindings = getRuntimeBindings()
  if (!bindings.sessionRevocations) throwAuthError('runtime_unconfigured', 'Other-device logout requires a durable session revocation store.')
  await checkRememberWriteScope(bindings, guardName)
  await hydrateGuardContextFromRequest(guardName)
  const state = await readGuardSessionState(guardName, true)
  const metadata = state?.payload.revocation
  if (!state || !metadata || state.payload.multiFactorChallengeExpiresAt) throwAuthError('auth_user_missing', 'Other-device logout requires valid browser authentication.')
  if (!state.payload.impersonation && await getRememberRecaller(bindings, guardName)) await assertResponseCookiesWritable(bindings)
  const retained = await bindings.sessionRevocations.revokeOthers(state.payload, metadata)
  clearSessionRevocationReads(bindings.context)
  if (!retained) throwAuthError('auth_user_missing', 'This browser authentication has already been revoked.')
  const recaller = state.payload.impersonation ? undefined : await cycleRememberToken(state.payload.provider, state.payload.userId)
  await reissueRememberRecaller(bindings, guardName, recaller)
}

async function reissueRememberRecaller(bindings: RuntimeBindings, guardName: string, recaller: string | undefined): Promise<void> {
  if (!recaller || !await getRememberRecaller(bindings, guardName)) return
  bindings.context.setRememberToken?.(guardName, recaller)
  const cookie = await rememberCookieFor(bindings, guardName, recaller)
  if (cookie) await appendResponseCookies(bindings, [cookie])
}

async function resolveUserFromGuard(
  guardName: string,
  options: { readonly fresh?: boolean } = {},
): Promise<AuthenticatedAuthUser | null> {
  const bindings = getRuntimeBindings()
  const guard = getGuardConfig(guardName)

  await hydrateGuardContextFromRequest(guardName)

  if (options.fresh && guard.driver === 'session' && isRequestOnlyGuard(bindings, guardName)) {
    const cachedUser = bindings.context.getCachedUser(guardName)
    if (cachedUser && cachedUser.id !== undefined) {
      const { adapter } = getProviderAdapter(guard.provider)
      const freshUser = await adapter.findById(cachedUser.id)
      if (!freshUser) {
        setRequestOnlyGuard(bindings, guardName, false)
        bindings.context.setCachedUser(guardName, null)
        return null
      }
      const serialized = serializeUser(adapter, freshUser, guard.provider)
      bindings.context.setCachedUser(guardName, serialized)
      return serialized
    }
  }

  if (guard.driver === 'token') {
    const token = bindings.context.getAccessToken?.(guardName)
    if (!token) {
      bindings.context.setCachedUser(guardName, null)
      return null
    }

    const authenticated = await authenticateAccessTokenRecord(token, guard.provider)
    if (!authenticated) {
      bindings.context.setAccessToken?.(guardName)
      bindings.context.setCachedUser(guardName, null)
      return null
    }

    bindings.context.setCachedUser(guardName, authenticated.user)
    return authenticated.user
  }

  if (!options.fresh && isRequestOnlyGuard(bindings, guardName)) {
    const requestOnlyUser = bindings.context.getCachedUser(guardName)
    if (requestOnlyUser) return requestOnlyUser
  }

  const touched = await queueRequestSession(bindings, async () => {
    const sessionId = bindings.context.getSessionId(guardName)
    return sessionId ? { sessionId, record: await bindings.session.touch(sessionId) } : undefined
  })
  if (!touched) {
    bindings.context.setCachedUser(guardName, null)
    return null
  }
  const { sessionId, record } = touched
  const payloads = record ? await filterRevokedSessionPayloads(bindings, record) : null
  const payload = payloads?.[guardName]
  if (!record || !payload || payload.guard !== guardName) {
    bindings.context.setSessionId(guardName)
    bindings.context.setCachedUser(guardName, null)
    await setRememberRecaller(bindings, guardName)
    return null
  }

  if (payload.multiFactorChallengeExpiresAt) {
    bindings.context.setCachedUser(guardName, null)
    return null
  }

  if (!options.fresh) {
    const cached = bindings.context.getCachedUser(guardName)
    if (typeof cached !== 'undefined') {
      return cached
    }
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
    await setRememberRecaller(bindings, guardName)
    return null
  }

  if (payload.impersonation && !await impersonationIdentitiesExist(payload.impersonation)) {
    return await stopImpersonatingForGuard(guardName)
  }

  const serialized = serializeUser(adapter, freshUser, payload.provider)
  bindings.context.setCachedUser(guardName, serialized)
  return serialized
}

async function impersonationIdentitiesExist(impersonation: SessionImpersonationPayload): Promise<boolean> {
  if (!await findSerializedUserById(impersonation.actor.provider, impersonation.actor.userId)) return false
  if (!impersonation.original) return true
  return Boolean(await findSerializedUserById(impersonation.original.provider, impersonation.original.userId))
}

function ensureMultiFactorStore(): AuthMultiFactorStore {
  const bindings = getRuntimeBindings()
  if (!bindings.config.multiFactor.enabled || !bindings.multiFactor) {
    throwAuthError('multi_factor_runtime_unconfigured', 'Multi-factor authentication is not configured.')
  }
  return bindings.multiFactor
}

function multiFactorEncryptionKey(): string {
  const key = getRuntimeBindings().multiFactorEncryptionKey?.trim()
  if (!key) throwAuthError('multi_factor_encryption_key_missing', 'Multi-factor authentication requires an encryption key.')
  return key
}

function multiFactorChallengeLeaseKey(guardName: string): string {
  return `auth.mfa.${createHash('sha256').update(guardName).digest('hex')}.lease`
}

function multiFactorChallengeSessionRuntime(): {
  readonly flash: NonNullable<AuthSessionRuntime['flash']>
  readonly take: NonNullable<AuthSessionRuntime['take']>
} {
  const { flash, take } = getRuntimeBindings().session
  if (!flash || !take) {
    throwAuthError('multi_factor_runtime_unconfigured', 'Multi-factor authentication requires atomic session flash operations.')
  }
  return Object.freeze({ flash, take })
}

type MultiFactorRateLimit = {
  readonly key: string
  hit(options: { readonly maxAttempts: number, readonly decaySeconds: number }): ReturnType<OptionalSecurityRateLimitStore['hit']>
  clear(): Promise<boolean>
}

async function multiFactorRateLimit(provider: string, userId: string | number): Promise<MultiFactorRateLimit> {
  const security = await loadOptionalSecurityModule()
  const securityBindings = security?.getSecurityRuntimeBindings?.()
  const signingKey = securityBindings?.csrfSigningKey?.trim()
  const store = securityBindings?.rateLimitStore
  const clear = store?.clear
  if (!signingKey || !store || !clear) {
    throwAuthError('multi_factor_runtime_unconfigured', 'Multi-factor authentication requires a configured security rate-limit store.')
  }
  const subject = JSON.stringify([provider, String(userId)])
  const key = `auth:mfa:${createHmac('sha256', signingKey).update(subject).digest('hex')}`
  return Object.freeze({
    key,
    hit: (options: { readonly maxAttempts: number, readonly decaySeconds: number }) => store.hit(key, options),
    clear: () => clear.call(store, key),
  })
}

async function invalidateSessionAuthentication(
  bindings: RuntimeBindings,
  sessionId: string,
  guardNames: readonly string[],
  store?: string,
): Promise<void> {
  const failures: unknown[] = []
  try {
    await bindings.session.invalidate(sessionId, { store })
  } catch (error) {
    failures.push(error)
  }
  for (const guardName of new Set(guardNames)) {
    for (const clear of [
      () => bindings.context.setSessionId(guardName),
      () => bindings.context.setCachedUser(guardName, null),
      () => setRememberRecaller(bindings, guardName),
    ]) {
      try {
        await clear()
      } catch (error) {
        failures.push(error)
      }
    }
  }
  if (failures.length > 1) throw new AggregateError(failures, 'Failed to clear session authentication.')
  if (failures.length === 1) throw failures[0]
}

async function invalidateMultiFactorChallenge(
  guardName: string,
  sessionId: string,
  bindings: RuntimeBindings,
): Promise<void> {
  const sharedGuards = Object.entries(bindings.config.guards)
    .filter(([name, guard]) => guard.driver === 'session' && bindings.context.getSessionId(name) === sessionId)
    .map(([name]) => name)
  await invalidateSessionAuthentication(bindings, sessionId, [...sharedGuards, guardName])
}

async function establishLoginSessionForUser(
  user: SerializedAuthUser,
  options: {
    readonly guard: string
    readonly provider: string
    readonly remember?: boolean
  },
): Promise<AuthEstablishedSession> {
  const bindings = getRuntimeBindings()
  await checkRememberWriteScope(bindings, options.guard, options.remember)
  const credential = bindings.config.multiFactor.enabled
    ? await ensureMultiFactorStore().find(options.provider, user.id)
    : null
  if (!credential) return establishSessionForUser(user, options)
  multiFactorEncryptionKey()
  const challengeSession = multiFactorChallengeSessionRuntime()
  await multiFactorRateLimit(options.provider, user.id)
  const expiresAt = new Date(Date.now() + bindings.config.multiFactor.challengeTtl * 1000)
  const established = await establishSessionForUser(user, {
    guard: options.guard,
    provider: options.provider,
    preserveRemember: options.remember,
    payload: toSessionPayload(options.guard, options.provider, user, undefined, expiresAt.toISOString(), options.remember),
  })
  try {
    await challengeSession.flash(established.sessionId, multiFactorChallengeLeaseKey(options.guard), true)
  } catch (error) {
    try {
      await invalidateMultiFactorChallenge(options.guard, established.sessionId, bindings)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Failed to invalidate a multi-factor challenge after establishment failed.')
    }
    throw error
  }
  return Object.freeze({
    ...established,
    multiFactorChallenge: Object.freeze({
      expiresAt,
      recoveryAllowed: credential.recoveryCodeHashes.length > 0,
      route: bindings.config.multiFactor.challengeRoute,
    }),
  })
}

async function loginForSessionGuard(guardName: string, credentials: AuthCredentials): Promise<AuthEstablishedSession> {
  const { guard, adapter } = getGuardProviderAdapter(guardName)
  const user = await verifyCredentialsForProvider(guard.provider, adapter, credentials)
  if (!user) {
    throwAuthError('invalid_credentials', 'Invalid credentials.')
  }

  const serialized = serializeUser(adapter, user, guard.provider)
  await hydrateGuardContextFromRequest(guardName, { restoreRemembered: false })
  return establishLoginSessionForUser(serialized, {
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

  await hydrateGuardContextFromRequest(guardName, { restoreRemembered: false })
  return establishLoginSessionForUser(serialized, {
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
  touch = false,
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

  const record = touch
    ? await bindings.session.touch(sessionId)
    : await bindings.session.read(sessionId)
  if (!record) {
    return null
  }

  const payloads = await filterRevokedSessionPayloads(bindings, record)
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
      store: record.store,
      data,
    })
  }

  return bindings.session.write(Object.freeze({
    ...record,
    data,
  }))
}

type MultiFactorAuthenticatedState = NonNullable<Awaited<ReturnType<typeof readGuardSessionState>>>

async function authenticatedMultiFactorState(guardName: string): Promise<MultiFactorAuthenticatedState> {
  const guard = getGuardConfig(guardName)
  if (guard.driver !== 'session') throwAuthError('multi_factor_authentication_required', 'Multi-factor authentication requires a session guard.')
  if (!await resolveUserFromGuard(guardName)) throwAuthError('multi_factor_authentication_required', 'Authentication is required for this multi-factor operation.')
  const state = await readGuardSessionState(guardName)
  if (!state || state.payload.multiFactorChallengeExpiresAt) throwAuthError('multi_factor_authentication_required', 'Authentication is required for this multi-factor operation.')
  return state
}

function enrollmentData(record: AuthSessionRecord): Readonly<Record<string, string>> {
  const value = record.data.authMultiFactorEnrollments
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({})
  return Object.freeze(Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')))
}

async function writeEnrollment(state: MultiFactorAuthenticatedState, guardName: string, value?: string): Promise<void> {
  const enrollments = { ...enrollmentData(state.record) }
  if (value) enrollments[guardName] = value
  else delete enrollments[guardName]
  const data = { ...state.record.data } as Record<string, unknown>
  if (Object.keys(enrollments).length > 0) data.authMultiFactorEnrollments = Object.freeze(enrollments)
  else delete data.authMultiFactorEnrollments
  await writeExistingSession(getRuntimeBindings(), state.record, Object.freeze(data))
}

async function verifyCredentialTotp(credential: AuthMultiFactorCredentialRecord, code: string): Promise<AuthMultiFactorVerificationState> {
  const bindings = getRuntimeBindings()
  const secret = decryptMultiFactorValue(credential.encryptedSecret, multiFactorEncryptionKey())
  const counters = matchingTotpCounters(secret, code.trim(), bindings.config.multiFactor.allowedDriftSteps)
  for (const counter of counters) {
    const verification = await ensureMultiFactorStore().advanceCounter(credential.provider, credential.userId, counter)
    if (verification) return verification
  }
  throwAuthError('multi_factor_code_invalid', 'The multi-factor authentication code is invalid.')
}

async function verifyCredentialRecovery(credential: AuthMultiFactorCredentialRecord, code: string): Promise<AuthMultiFactorVerificationState> {
  const verification = await ensureMultiFactorStore().consumeRecoveryCode(
    credential.provider,
    credential.userId,
    hashMultiFactorRecoveryCode(code),
  )
  if (!verification) throwAuthError('multi_factor_code_invalid', 'The multi-factor recovery code is invalid.')
  return verification
}

async function verifyCredentialWithRateLimit(
  credential: AuthMultiFactorCredentialRecord,
  input: AuthMultiFactorVerificationInput,
): Promise<AuthMultiFactorVerificationState> {
  const rateLimit = await multiFactorRateLimit(credential.provider, credential.userId)
  const result = await rateLimit.hit({
    maxAttempts: MAX_MULTI_FACTOR_CHALLENGE_ATTEMPTS,
    decaySeconds: getRuntimeBindings().config.multiFactor.challengeTtl,
  })
  const attempts = result.snapshot?.attempts
  if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 1) {
    throwAuthError('multi_factor_runtime_unconfigured', 'Multi-factor authentication requires an atomic security rate-limit store.')
  }
  if (result.limited) {
    throwAuthError('multi_factor_code_invalid', 'The multi-factor authentication code is invalid.')
  }

  const verification = input.method === 'totp'
    ? await verifyCredentialTotp(credential, input.code)
    : await verifyCredentialRecovery(credential, input.code)

  try {
    await rateLimit.clear()
  } catch (error) {
    reportError(error, { capability: 'auth', operation: 'multiFactor.clearRateLimit' })
  }
  return verification
}

async function credentialForPayload(payload: SessionAuthPayload): Promise<AuthMultiFactorCredentialRecord> {
  const credential = await ensureMultiFactorStore().find(payload.provider, payload.userId)
  if (!credential) throwAuthError('multi_factor_not_enabled', 'Multi-factor authentication is not enabled.')
  return credential
}

async function completeMultiFactorChallenge(
  guardName: string,
  method: 'recovery' | 'totp',
  code: string,
): Promise<AuthEstablishedSession> {
  await assertResponseCookiesWritable(getRuntimeBindings())
  await hydrateGuardContextFromRequest(guardName)
  const state = await readGuardSessionState(guardName)
  const expiresAt = state?.payload.multiFactorChallengeExpiresAt
  if (!state || !expiresAt) throwAuthError('multi_factor_challenge_missing', 'No multi-factor challenge is pending.')
  if (new Date(expiresAt).getTime() <= Date.now()) throwAuthError('multi_factor_challenge_expired', 'The multi-factor challenge has expired.')
  const user = await findSerializedUserById(state.payload.provider, state.payload.userId)
  if (!user) throwAuthError('auth_user_missing', 'The authenticated user no longer exists.')
  const credential = await credentialForPayload(state.payload)
  const bindings = getRuntimeBindings()
  const challengeSession = multiFactorChallengeSessionRuntime()
  const leaseKey = multiFactorChallengeLeaseKey(guardName)
  const lease = await challengeSession.take<boolean>(state.sessionId, leaseKey)
  if (lease !== true) {
    throwAuthError('multi_factor_challenge_missing', 'No multi-factor challenge is pending.')
  }
  let rateLimit: Awaited<ReturnType<typeof multiFactorRateLimit>>
  let rateLimitResult: Awaited<ReturnType<typeof rateLimit.hit>>
  try {
    rateLimit = await multiFactorRateLimit(credential.provider, credential.userId)
    rateLimitResult = await rateLimit.hit({
      maxAttempts: MAX_MULTI_FACTOR_CHALLENGE_ATTEMPTS,
      decaySeconds: bindings.config.multiFactor.challengeTtl,
    })
  } catch (error) {
    await challengeSession.flash(state.sessionId, leaseKey, true)
    throw error
  }
  const attempts = rateLimitResult.snapshot?.attempts
  if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 1) {
    await challengeSession.flash(state.sessionId, leaseKey, true)
    throwAuthError('multi_factor_runtime_unconfigured', 'Multi-factor authentication requires an atomic security rate-limit store.')
  }
  if (rateLimitResult.limited) {
    await invalidateMultiFactorChallenge(guardName, state.sessionId, bindings)
    throwAuthError('multi_factor_code_invalid', 'The multi-factor authentication code is invalid.')
  }
  try {
    if (method === 'totp') await verifyCredentialTotp(credential, code)
    else await verifyCredentialRecovery(credential, code)
  } catch (error) {
    if (isAuthError(error) && error.code === 'multi_factor_code_invalid') {
      if (attempts >= MAX_MULTI_FACTOR_CHALLENGE_ATTEMPTS) {
        await invalidateMultiFactorChallenge(guardName, state.sessionId, bindings)
      } else {
        await challengeSession.flash(state.sessionId, leaseKey, true)
      }
    } else {
      await challengeSession.flash(state.sessionId, leaseKey, true)
    }
    throw error
  }
  try {
    await rateLimit.clear()
  } catch (error) {
    reportError(error, { capability: 'auth', operation: 'multiFactor.clearRateLimit' })
  }
  try {
    return await establishSessionForUser(user, {
      guard: guardName,
      provider: state.payload.provider,
      remember: state.payload.multiFactorRemember === true,
      preserveRemember: true,
      payload: toSessionPayload(guardName, state.payload.provider, user),
    })
  } catch (error) {
    let formerSession: AuthSessionRecord | null
    try {
      formerSession = await bindings.session.read(state.sessionId)
    } catch (readError) {
      throw new AggregateError([error, readError], 'Failed to inspect a multi-factor challenge after session establishment failed.')
    }
    if (!formerSession) throw error
    try {
      await challengeSession.flash(state.sessionId, leaseKey, true)
    } catch (restoreError) {
      const currentSessionId = bindings.context.getSessionId(guardName) ?? state.sessionId
      try {
        await invalidateMultiFactorChallenge(guardName, currentSessionId, bindings)
      } catch (invalidationError) {
        throw new AggregateError(
          [error, restoreError, invalidationError],
          'Failed to recover a multi-factor challenge after session establishment failed.',
        )
      }
      throw new AggregateError([error, restoreError], 'Failed to recover a multi-factor challenge after session establishment failed.')
    }
    throw error
  }
}

function recoveryResult(codes: readonly string[]): AuthMultiFactorRecoveryCodes {
  return Object.freeze({ recoveryCodes: Object.freeze([...codes]) })
}

function requireNotRememberedSession(state: MultiFactorAuthenticatedState): void {
  if (state.payload.viaRemember === true) {
    throwAuthError('multi_factor_reauthentication_required', 'Recent authentication is required to enroll multi-factor authentication.')
  }
}

function requireRecentMultiFactorAuthentication(state: MultiFactorAuthenticatedState): void {
  requireNotRememberedSession(state)
  const reauthenticationWindowMs = getRuntimeBindings().config.multiFactor.enrollmentTtl * 1000
  if (!(Date.parse(state.payload.authenticatedAt) > Date.now() - reauthenticationWindowMs)) {
    throwAuthError('multi_factor_reauthentication_required', 'Recent authentication is required to enroll multi-factor authentication.')
  }
}

function createMultiFactorFacade(guardName: string): AuthMultiFactorFacade {
  return Object.freeze({
    async status() {
      const state = await authenticatedMultiFactorState(guardName)
      const credential = await ensureMultiFactorStore().find(state.payload.provider, state.payload.userId)
      return Object.freeze({
        enabled: credential !== null,
        recoveryCodesRemaining: credential?.recoveryCodeHashes.length ?? 0,
      })
    },
    async beginEnrollment(): Promise<AuthMultiFactorEnrollment> {
      const state = await authenticatedMultiFactorState(guardName)
      requireRecentMultiFactorAuthentication(state)
      const store = ensureMultiFactorStore()
      if (await store.find(state.payload.provider, state.payload.userId)) throwAuthError('multi_factor_already_enabled', 'Multi-factor authentication is already enabled.')
      const bindings = getRuntimeBindings()
      const secret = createMultiFactorSecret()
      const expiresAt = new Date(Date.now() + bindings.config.multiFactor.enrollmentTtl * 1000)
      const encrypted = encryptMultiFactorValue(JSON.stringify({ expiresAt: expiresAt.toISOString(), secret }), multiFactorEncryptionKey())
      await writeEnrollment(state, guardName, encrypted)
      const user = await findSerializedUserById(state.payload.provider, state.payload.userId)
      const account = typeof user?.email === 'string' ? user.email : String(state.payload.userId)
      return Object.freeze({
        expiresAt,
        manualKey: secret,
        otpauthUri: multiFactorOtpAuthUri(bindings.config.multiFactor.issuer, account, secret),
      })
    },
    async confirmEnrollment(input: AuthMultiFactorCodeInput) {
      const state = await authenticatedMultiFactorState(guardName)
      requireNotRememberedSession(state)
      const encrypted = enrollmentData(state.record)[guardName]
      if (!encrypted) throwAuthError('multi_factor_enrollment_missing', 'No multi-factor enrollment is pending.')
      let pending: { readonly expiresAt: string, readonly secret: string }
      try {
        pending = JSON.parse(decryptMultiFactorValue(encrypted, multiFactorEncryptionKey())) as typeof pending
      } catch {
        throwAuthError('multi_factor_enrollment_missing', 'No multi-factor enrollment is pending.')
      }
      if (new Date(pending.expiresAt).getTime() <= Date.now()) {
        await writeEnrollment(state, guardName)
        throwAuthError('multi_factor_enrollment_expired', 'The multi-factor enrollment has expired.')
      }
      const counters = matchingTotpCounters(pending.secret, input.code.trim(), getRuntimeBindings().config.multiFactor.allowedDriftSteps)
      const counter = counters[0]
      if (typeof counter !== 'number') throwAuthError('multi_factor_code_invalid', 'The multi-factor authentication code is invalid.')
      const recoveryCodes = createMultiFactorRecoveryCodes(getRuntimeBindings().config.multiFactor.recoveryCodes)
      const now = new Date()
      const store = ensureMultiFactorStore()
      const reissue = !state.payload.impersonation && Boolean(await getRememberRecaller(getRuntimeBindings(), guardName))
      if (reissue) await assertResponseCookiesWritable(getRuntimeBindings())
      try {
        await store.save(Object.freeze({
          provider: state.payload.provider,
          userId: state.payload.userId,
          encryptedSecret: encryptMultiFactorValue(pending.secret, multiFactorEncryptionKey()),
          recoveryCodeHashes: Object.freeze(recoveryCodes.map(hashMultiFactorRecoveryCode)),
          lastUsedCounter: counter,
          enabledAt: now,
          updatedAt: now,
        }))
      } catch (error) {
        if (await store.find(state.payload.provider, state.payload.userId)) {
          throwAuthError('multi_factor_already_enabled', 'Multi-factor authentication is already enabled.', { cause: error })
        }
        throw error
      }
      try {
        const recaller = await cycleRememberToken(state.payload.provider, state.payload.userId)
        if (!state.payload.impersonation) await reissueRememberRecaller(getRuntimeBindings(), guardName, recaller)
      } catch (error) {
        try {
          await store.delete(state.payload.provider, state.payload.userId)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Failed to roll back a multi-factor enrollment after the remember token refresh failed.')
        }
        throw error
      }
      try {
        await writeEnrollment(state, guardName)
      } catch (error) {
        reportError(error, { capability: 'auth', operation: 'multiFactor.clearEnrollment' })
      }
      return recoveryResult(recoveryCodes)
    },
    challenge(input: AuthMultiFactorCodeInput) {
      return completeMultiFactorChallenge(guardName, 'totp', input.code)
    },
    recover(input: AuthMultiFactorCodeInput) {
      return completeMultiFactorChallenge(guardName, 'recovery', input.code)
    },
    async disable(input: AuthMultiFactorVerificationInput) {
      const state = await authenticatedMultiFactorState(guardName)
      const credential = await credentialForPayload(state.payload)
      await verifyCredentialWithRateLimit(credential, input)
      await ensureMultiFactorStore().delete(credential.provider, credential.userId)
    },
    async regenerateRecoveryCodes(input: AuthMultiFactorVerificationInput) {
      const state = await authenticatedMultiFactorState(guardName)
      const credential = await credentialForPayload(state.payload)
      const verification = await verifyCredentialWithRateLimit(credential, input)
      const recoveryCodes = createMultiFactorRecoveryCodes(getRuntimeBindings().config.multiFactor.recoveryCodes)
      const replaced = await ensureMultiFactorStore().replaceRecoveryCodes(
        credential.provider,
        credential.userId,
        recoveryCodes.map(hashMultiFactorRecoveryCode),
        new Date(),
        verification,
      )
      if (!replaced) throwAuthError('multi_factor_code_invalid', 'The multi-factor authentication code is invalid.')
      return recoveryResult(recoveryCodes)
    },
  })
}

async function impersonateForGuard(
  guardName: string,
  user: unknown,
  options: AuthImpersonationOptions = {},
): Promise<AuthEstablishedSession> {
  if (options.remember === true) {
    throwAuthError('impersonation_remember_unsupported', 'Impersonation cannot issue remember-me cookies.', { guard: guardName })
  }
  const actorGuard = options.actorGuard ?? guardName
  const actor = await resolveUserFromGuard(actorGuard)
  const actorState = await readGuardSessionState(actorGuard)
  if (!actor || !actorState) {
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

  const impersonation = await createImpersonationState(state.payload)
  if (state.payload.impersonation && !impersonation) {
    await stopImpersonatingForGuard(guardName)
  }
  return impersonation
}

async function stopImpersonatingForGuard(guardName: string): Promise<AuthenticatedAuthUser | null> {
  const bindings = getRuntimeBindings()
  const state = await readGuardSessionState(guardName)
  if (!state || !state.payload.impersonation) {
    return null
  }

  const nextPayloads = { ...state.payloads }
  const storedOriginal = state.payload.impersonation.original
  const originalUser = storedOriginal
    ? await findSerializedUserById(storedOriginal.provider, storedOriginal.userId)
    : null
  const restoredPayload = storedOriginal && originalUser ? {
    ...toSessionPayload(storedOriginal.guard, storedOriginal.provider, originalUser),
    ...(storedOriginal.revocation ? { revocation: storedOriginal.revocation } : {}),
  } : undefined
  const validOriginal = restoredPayload && bindings.sessionRevocations
    ? (await validSessionPayloads(bindings.sessionRevocations, bindings.context, { [guardName]: restoredPayload }))[guardName]
    : restoredPayload
  if (validOriginal && originalUser) {
    nextPayloads[guardName] = validOriginal
  } else {
    delete nextPayloads[guardName]
  }

  if (Object.keys(nextPayloads).length === 0) {
    await bindings.session.invalidate(state.sessionId)
  } else {
    await writeExistingSession(bindings, state.record, writeSessionPayloads(state.record.data, nextPayloads))
  }

  if (!validOriginal || !originalUser) {
    await setRememberRecaller(bindings, guardName)
    bindings.context.setSessionId(guardName)
    bindings.context.setCachedUser(guardName, null)
    return null
  }

  bindings.context.setSessionId(guardName, state.sessionId)
  bindings.context.setCachedUser(guardName, originalUser)
  return originalUser
}

async function logoutForGuard(guardName: string): Promise<AuthLogoutResult> {
  const bindings = getRuntimeBindings()
  const guard = getGuardConfig(guardName)

  if (guard.driver === 'token') {
    const current = await resolveCurrentAccessTokenForGuard(guardName)
    await current?.delete()
    bindings.context.setAccessToken?.(guardName)
    bindings.context.setCachedUser(guardName, null)
    return Object.freeze({
      guard: guardName,
      cookies: Object.freeze([]),
    })
  }

  await checkRememberWriteScope(bindings, guardName)
  await hydrateGuardContextFromRequest(guardName)
  if (
    buildLogoutCookies(bindings, guardName, { clearSessionCookies: false }).length > 0
    || bindings.context.getSessionId(guardName)
    || await getRememberRecaller(bindings, guardName)
  ) {
    await assertResponseCookiesWritable(bindings)
  }

  let clearSessionCookies = false
  const requestOnlyUser = isRequestOnlyGuard(bindings, guardName) ? bindings.context.getCachedUser(guardName) : undefined
  if (requestOnlyUser?.id !== undefined) {
    await cycleRememberToken(guard.provider, requestOnlyUser.id)
  }
  const sessionId = requestOnlyUser ? undefined : bindings.context.getSessionId(guardName)
  setRequestOnlyGuard(bindings, guardName, false)
  if (sessionId) {
    const record = await bindings.session.read(sessionId)
    const payloads = {
      ...(readSessionPayloads(record) ?? {}),
    }
    const payload = payloads[guardName]
    const rememberedIdentity = payload?.impersonation?.actor ?? payload
    if (rememberedIdentity && !payload?.multiFactorChallengeExpiresAt) {
      await cycleRememberToken(rememberedIdentity.provider, rememberedIdentity.userId)
    }
    if (!(guardName in payloads)) {
      await bindings.session.invalidate(sessionId)
      clearSessionCookies = true
    } else {
      delete payloads[guardName]
      if (Object.keys(payloads).length === 0) {
        await bindings.session.invalidate(sessionId)
        clearSessionCookies = true
      } else {
        await writeExistingSession(bindings, record!, writeSessionPayloads(record!.data, payloads))
      }
    }
  }

  const forgetRemember = Boolean(await getRememberRecaller(bindings, guardName))
    || (await readRememberCookieEntries(bindings)).has(guardName)
  bindings.context.setSessionId(guardName)
  bindings.context.setCachedUser(guardName, null)
  await setRememberRecaller(bindings, guardName)

  const rememberCookie = forgetRemember ? await rememberCookieFor(bindings, guardName) : undefined
  const cookies = Object.freeze([
    ...buildLogoutCookies(bindings, guardName, { clearSessionCookies }),
    ...(rememberCookie ? [rememberCookie] : []),
  ])
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

async function rotateSessionWithData(
  bindings: RuntimeBindings,
  session: AuthSessionRecord,
  data: Readonly<Record<string, unknown>>,
): Promise<AuthSessionRecord> {
  if (!bindings.session.rotate) {
    throw new Error('[@holo-js/auth] Existing auth sessions require state-preserving session rotation.')
  }
  return bindings.session.rotate(session.id, { store: session.store, data, renewLifetime: true })
}

async function establishSessionForUser(
  user: SerializedAuthUser,
  options: {
    readonly guard: string
    readonly provider: string
    readonly remember?: boolean
    readonly preserveRemember?: boolean
    readonly payload?: SessionAuthPayload
    readonly revocation?: NonNullable<SessionAuthPayload['revocation']>
  },
): Promise<AuthEstablishedSession> {
  const bindings = getRuntimeBindings()
  await assertResponseCookiesWritable(bindings)
  if (!options.preserveRemember || options.remember) {
    await checkRememberWriteScope(bindings, options.guard, options.remember)
  }
  const currentGuardSessionId = bindings.context.getSessionId(options.guard)
  const sharedSessionId = currentGuardSessionId
    ?? sessionGuardNames(bindings)
      .filter(name => name !== options.guard)
      .map(name => bindings.context.getSessionId(name))
      .find((value): value is string => typeof value === 'string' && value.length > 0)
  const existingSession = sharedSessionId
    ? await bindings.session.read(sharedSessionId)
    : null
  const existingPayloads = readSessionPayloads(existingSession) ?? {}
  const sharedGuardNames = existingSession
    ? sessionGuardNames(bindings).filter(name => (
        name in existingPayloads
        || bindings.context.getSessionId(name) === existingSession.id
      ))
    : []
  const revocation = options.revocation ?? (bindings.sessionRevocations
    ? await loginRevocationMetadata(bindings.sessionRevocations, bindings.context, { provider: options.provider, userId: user.id }, existingPayloads)
    : undefined)
  const sessionPayload = {
    ...(options.payload ?? toSessionPayload(options.guard, options.provider, user)),
    ...(revocation ? { revocation } : {}),
  }
  const sessionPayloads = {
    ...existingPayloads,
    [options.guard]: sessionPayload,
  }
  const nextSessionData = writeSessionPayloads(existingSession?.data ?? {}, sessionPayloads)
  const forgetRemember = !options.remember
    && !options.preserveRemember
    && Boolean(await getRememberRecaller(bindings, options.guard))
  const session = existingSession
    ? await rotateSessionWithData(bindings, existingSession, nextSessionData)
    : await bindings.session.create({ data: nextSessionData })

  try {
    if (existingSession) {
      for (const guardName of sharedGuardNames) {
        bindings.context.setSessionId(guardName, session.id)
      }
    }

    bindings.context.setSessionId(options.guard, session.id)
    bindings.context.setCachedUser(options.guard, user)
    const rememberToken = options.remember
      ? await ensureRememberRecaller(options.provider, user.id)
      : undefined
    const rememberCookie = rememberToken || forgetRemember
      ? await rememberCookieFor(bindings, options.guard, rememberToken)
      : undefined

    const cookies = [
      bindings.session.sessionCookie(session.id),
      ...(rememberCookie ? [rememberCookie] : []),
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
  } catch (error) {
    try {
      await invalidateSessionAuthentication(bindings, session.id, [...sharedGuardNames, options.guard], session.store)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Failed to clean up an authenticated session transition.')
    }
    throw error
  }

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
  return await updateLoadedUserRecord(providerName, userId, await adapter.findById(userId), input)
}

async function updateLoadedUserRecord(
  providerName: string,
  userId: string | number,
  user: unknown,
  input: Parameters<typeof updateUserRecord>[2],
): Promise<AuthenticatedAuthUser> {
  const { adapter } = getProviderAdapter(providerName)
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

async function verifyIssuedEmail(record: EmailVerificationTokenRecord): Promise<AuthenticatedAuthUser | null> {
  const { adapter } = getProviderAdapter(record.provider)
  const user = await adapter.findById(record.userId)
  if (user) {
    const current = serializeUser(adapter, user, record.provider)
    if (typeof current.email !== 'string' || current.email.trim() !== record.email) {
      return null
    }
  }

  return await updateLoadedUserRecord(record.provider, record.userId, user, {
    email_verified_at: new Date(),
  })
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
    async resend(options: { readonly guard?: string, readonly expiresAt?: Date } = {}): Promise<EmailVerificationTokenResult> {
      return unwrapExpectedAuthResult(await captureExpectedAuthResult(async () => {
        const guardName = options.guard ?? getDefaultGuardName()
        const currentUser = await resolveUserFromGuard(guardName, { fresh: true })
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

        const updated = await store.redeem(record, () => verifyIssuedEmail(record))
        if (!updated) {
          throwAuthError('email_verification_token_expired', 'Invalid or expired email verification token.')
        }
        return updated
      }, EXPECTED_EMAIL_VERIFICATION_CONSUME_ERRORS, createEmailVerificationConsumeFailure))
    },
  })
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

    const password = await getRuntimeBindings().passwordHasher.hash(input.password)
    const updated = await store.redeem(record, async () => {
      await store.deleteByEmail(record.provider, record.email, { table: record.table })
      const { adapter } = getProviderAdapter(record.provider)
      const user = await adapter.findByCredentials({ email: record.email })
      if (!user) {
        throwAuthError('password_reset_user_missing', 'Password reset token user no longer exists.', {
          provider: record.provider,
          email: record.email,
        })
      }
      const userId = requireUserId(adapter, user, '[@holo-js/auth] Password reset token user is invalid.')
      const resetUser = await updateUserRecord(record.provider, userId, { password })
      await rotateRememberToken(record.provider, userId)
      return resetUser
    })
    if (!updated) {
      throwAuthError('password_reset_token_expired', 'Invalid or expired password reset token.')
    }
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
    async revokeOthers(options: { readonly guard?: string } = {}): Promise<number> {
      const guardName = options.guard ?? getRuntimeBindings().config.defaults.guard
      const current = await resolveCurrentAccessTokenForGuard(guardName)
      if (!current) {
        throw new Error('[@holo-js/auth] Revoking other personal access tokens requires a valid current token guard.')
      }
      return ensureTokenStore().deleteByUserId(current.provider, current.userId, { exceptId: current.id })
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

async function activeSessionIdForGuard(guardName: string): Promise<string | undefined> {
  const bindings = getRuntimeBindings()
  if (getGuardConfig(guardName).driver !== 'session') return undefined
  if (!await resolveUserFromGuard(guardName)) return undefined
  return bindings.context.getSessionId(guardName)
}

async function flashForGuard(guardName: string, key: string, value: unknown): Promise<void> {
  const sessionId = await activeSessionIdForGuard(guardName)
  if (!sessionId) return
  const flash = getRuntimeBindings().session.flash
  if (!flash) throw new Error('[@holo-js/auth] The configured session runtime does not support atomic flash operations.')
  await flash(sessionId, key, value)
}

async function takeForGuard<TValue = unknown>(guardName: string, key: string): Promise<TValue | undefined> {
  const sessionId = await activeSessionIdForGuard(guardName)
  if (!sessionId) return undefined
  const take = getRuntimeBindings().session.take
  if (!take) throw new Error('[@holo-js/auth] The configured session runtime does not support atomic flash operations.')
  return take<TValue>(sessionId, key)
}

async function findUserByIdForGuard(
  guardName: string,
  userId: string | number,
): Promise<AuthenticatedAuthUser | null> {
  const guard = getGuardConfig(guardName)
  const { adapter } = getProviderAdapter(guard.provider)
  const found = await adapter.findById(userId)
  return found ? serializeUser(adapter, found, guard.provider) : null
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
    async findUserById(userId: string | number) {
      return findUserByIdForGuard(guardName, userId)
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
    logoutOtherDevices() {
      return logoutOtherDevicesForGuard(guardName)
    },
    multiFactor: createMultiFactorFacade(guardName),
    flash(key: string, value: unknown) {
      return flashForGuard(guardName, key, value)
    },
    take<TValue = unknown>(key: string) {
      return takeForGuard<TValue>(guardName, key)
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
  }) as AuthSessionGuardFacade
}

export function configureAuthRuntime(bindings?: AuthRuntimeBindings): void {
  configureRuntime(bindings)
}

function configureRuntime(bindings?: RuntimeConfigurationBindings): void {
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
    sessionRevocations: bindings.sessionRevocations,
    providers: bindings.providers,
    tokens: bindings.tokens,
    emailVerificationTokens: bindings.emailVerificationTokens,
    passwordResetTokens: bindings.passwordResetTokens,
    multiFactor: bindings.multiFactor,
    multiFactorEncryptionKey: bindings.multiFactorEncryptionKey,
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
  const multiFactor = createMultiFactorFacade(getDefaultGuardName())

  const facade: AuthFacade = {
    logoutOtherDevices() {
      return logoutOtherDevicesForGuard(getDefaultGuardName())
    },
    multiFactor,
    check() {
      return checkForGuard(getDefaultGuardName())
    },
    user() {
      return userForGuard(getDefaultGuardName())
    },
    refreshUser() {
      return refreshUserForGuard(getDefaultGuardName())
    },
    findUserById(userId: string | number) {
      return findUserByIdForGuard(getDefaultGuardName(), userId)
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
    flash(key: string, value: unknown) {
      return flashForGuard(getDefaultGuardName(), key, value)
    },
    take<TValue = unknown>(key: string) {
      return takeForGuard<TValue>(getDefaultGuardName(), key)
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
      return unwrapExpectedAuthResult(await callTimebox(() => requestPasswordResetUsingRuntime(input, options), AUTH_TIMEBOX_MILLISECONDS))
    },
    async resetPassword<TInput extends AuthPasswordResetInput>(input: TInput) {
      return unwrapExpectedAuthResult(await resetPasswordUsingRuntime(input))
    },
    verifyEmail(token: string) {
      return verification.consume(token)
    },
    sendEmailVerification(options?: AuthEmailVerificationSendOptions) {
      return verification.resend(options)
    },
    resendEmailVerification(options?: AuthEmailVerificationSendOptions) {
      return verification.resend(options)
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
    return readMarkedProvider(authenticatedUser)!
  }

  const sessionId = bindings.context.getSessionId(guardName)
  if (!sessionId) return guard.provider

  const payload = readSessionPayload(await bindings.session.read(sessionId), guardName)

  return payload ? resolveSessionPayloadProvider(payload) : guard.provider
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

export function sendEmailVerification(options?: AuthEmailVerificationSendOptions): Promise<EmailVerificationTokenResult> {
  return getAuthRuntime().verification.resend(options)
}

export function resendEmailVerification(options?: AuthEmailVerificationSendOptions): Promise<EmailVerificationTokenResult> {
  return getAuthRuntime().verification.resend(options)
}

export const authRuntimeInternals = {
  captureRequestContext() {
    const bindings = getAuthRuntimeState().bindings
    return captureAuthRequestContext(bindings ? getRuntimeBindings().context : undefined, Object.keys(bindings?.config.guards ?? {}))
  },
  configureRuntime,
  createAsyncAuthContext,
  createDefaultPasswordHasher,
  createMemoryAuthContext,
  createPersonalAccessTokenId,
  createPersonalAccessTokenSecret,
  createCurrentAccessTokenHandle,
  establishSessionForUser,
  getPasswordHash,
  getProviderIdentifiers,
  getRuntimeBindings,
  hashTokenSecret,
  isResponseInterrupt: isAuthResponseInterrupt,
  jwt: authJwtInternals,
  normalizeRequestInput,
  multiFactor: multiFactorInternals,
  parsePlainTextToken,
  parseSetCookieDefinition,
  readSessionPayload,
  redirectResponse,
  resolveClientAddress,
  serializeCookie,
  syncHostedIdentity,
  toLookupCredentials,
  toPlainTextTokenResult,
  tokenHasAbility,
  throwUnconfigured,
  updateUserRecord,
  verifyTokenSecret,
  writeSessionPayloads,
}
