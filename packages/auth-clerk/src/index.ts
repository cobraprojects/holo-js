import { authRuntimeInternals, getAuthRuntime } from '@holo-js/auth'
import type { AuthenticatedAuthUser, AuthEstablishedSession, AuthUserLike } from '@holo-js/auth'
import { parseCookieHeader } from '@holo-js/session'
import type { AuthClerkProviderConfig, NormalizedAuthClerkProviderConfig } from '@holo-js/config'
export {
  ClerkAuthConflictError,
} from './contracts'
export type {
  ClerkAuthBindings,
  ClerkAuthFacade,
  ClerkAuthenticatedUser,
  ClerkAuthenticationResult,
  ClerkCompleteAuthData,
  ClerkCompleteAuthResult,
  ClerkEmailAddress,
  ClerkHostedAuthFailureFields,
  ClerkLogoutData,
  ClerkLogoutErrorCode,
  ClerkLogoutResult,
  ClerkLogoutSession,
  ClerkProviderRuntime,
  ClerkRequestHeaders,
  ClerkRequestInput,
  ClerkRequestLike,
  ClerkSyncStatus,
  ClerkUserAttributes,
  ClerkUserAttributeValue,
  ClerkUserProfile,
  ClerkVerifiedSession,
  ClerkVerifyRequestContext,
  ClerkVerifySessionContext,
  ConfigureClerkAuthRuntimeOptions,
  HostedIdentityRecord,
  HostedIdentityStore,
} from './contracts'
import {
  ClerkAuthConflictError,
  type ClerkAuthBindings,
  type ClerkAuthenticationResult,
  type ClerkCompleteAuthResult,
  type ClerkEmailAddress,
  type ClerkLogoutResult,
  type ClerkLogoutSession,
  type ClerkProviderRuntime,
  type ClerkRequestHeaders,
  type ClerkRequestInput,
  type ClerkRequestLike,
  type ClerkUserAttributes,
  type ClerkUserProfile,
  type ClerkVerifiedSession,
  type ClerkVerifySessionContext,
  type ConfigureClerkAuthRuntimeOptions,
  type HostedIdentityRecord,
  type HostedIdentityStore,
} from './contracts'
import {
  CLERK_API_BASE_URL,
  fetchClerkJwks,
  parseJwt,
  resolveClerkJwksUrl,
  type JwkKey,
  verifyJwtSignatureWithJwk,
} from './jwt'

type RuntimeAuthProviderAdapter = ReturnType<typeof authRuntimeInternals.getRuntimeBindings>['providers'][string]

type ClerkDefaultUserAttributes = {
  readonly email: string
  readonly name: string
}

type CompleteClerkAuthOptions<TUserAttributes extends ClerkUserAttributes = ClerkDefaultUserAttributes> = {
  readonly provider?: string
  readonly user?: (clerkUser: ClerkUserProfile) => TUserAttributes
}

type SerializedClerkAuthUser = AuthenticatedAuthUser & {
  readonly id: string | number
}

type ClerkSessionPayload = {
  readonly guard: string
  readonly provider: string
  readonly userId: string | number
  readonly user: SerializedClerkAuthUser
  readonly clerk: ClerkLogoutSession
}

interface ClerkRuntimeState {
  bindings?: ConfigureClerkAuthRuntimeOptions
}

const CLERK_RUNTIME_STATE_KEY = '__holoJsAuthClerkRuntime'

type ClerkRuntimeStateHost = {
  [CLERK_RUNTIME_STATE_KEY]?: ClerkRuntimeState
}

const clerkDefaultProviderRuntimeCache = new Map<string, ClerkProviderRuntime>()
const clerkIdentitySyncLocks = new Map<string, Promise<void>>()
const AUTH_PROVIDER_MARKER = Symbol.for('holo-js.auth.provider')

function getRuntimeState(): ClerkRuntimeState {
  const runtimeGlobal = globalThis as typeof globalThis & {
    readonly process?: ClerkRuntimeStateHost
  } & ClerkRuntimeStateHost
  const runtimeHost: ClerkRuntimeStateHost = runtimeGlobal.process ?? runtimeGlobal

  if (!runtimeHost[CLERK_RUNTIME_STATE_KEY]) {
    Object.defineProperty(runtimeHost, CLERK_RUNTIME_STATE_KEY, {
      value: {},
      enumerable: false,
      configurable: true,
      writable: true,
    })
  }

  return runtimeHost[CLERK_RUNTIME_STATE_KEY]!
}

function throwUnconfigured(): never {
  throw new Error('[@holo-js/auth-clerk] Clerk auth runtime is not configured yet.')
}

function isPlainHeaderRecord(value: unknown): value is Record<string, string | readonly string[] | undefined> {
  return Boolean(value) && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
}

function appendKnownHeaders(headers: Headers, input: { readonly get?: (name: string) => string | null | undefined }): void {
  for (const name of ['authorization', 'cookie', 'host', 'x-forwarded-host', 'x-forwarded-proto']) {
    const value = input.get?.(name)
    if (typeof value === 'string' && value) {
      headers.set(name, value)
    }
  }
}

function hasHeaderForEach(input: ClerkRequestHeaders): input is { readonly forEach: (callback: (value: string, key: string) => void) => void } {
  return !Array.isArray(input) && 'forEach' in input && typeof input.forEach === 'function'
}

function hasHeaderEntries(input: ClerkRequestHeaders): input is { readonly entries: () => Iterable<readonly [string, string]> } {
  return !Array.isArray(input) && 'entries' in input && typeof input.entries === 'function'
}

function hasHeaderGet(input: ClerkRequestHeaders): input is { readonly get: (name: string) => string | null | undefined } {
  return !Array.isArray(input) && 'get' in input && typeof input.get === 'function'
}

function normalizeRequestHeaders(input: ClerkRequestHeaders | undefined): Headers {
  const headers = new Headers()
  if (!input) {
    return headers
  }

  if (input instanceof Headers || Array.isArray(input)) {
    new Headers(input).forEach((value, name) => headers.append(name, value))
    return headers
  }

  if (hasHeaderForEach(input)) {
    input.forEach((value, name) => headers.append(name, value))
    return headers
  }

  if (hasHeaderEntries(input)) {
    for (const [name, value] of input.entries()) {
      headers.append(name, value)
    }
    return headers
  }

  if (hasHeaderGet(input)) {
    appendKnownHeaders(headers, input)
    return headers
  }

  if (isPlainHeaderRecord(input)) {
    for (const [name, value] of Object.entries(input)) {
      if (typeof value === 'string') {
        headers.append(name, value)
        continue
      }

      if (Array.isArray(value)) {
        const separator = name.toLowerCase() === 'cookie' ? '; ' : ','
        const joined = value.filter((entry): entry is string => typeof entry === 'string').join(separator)
        if (joined) {
          headers.append(name, joined)
        }
      }
    }
  }

  return headers
}

function getRequestFromLikeInput(input: ClerkRequestLike): Request | undefined {
  return input.request ?? input.web?.request ?? (input.req instanceof Request ? input.req : undefined)
}

function getRequestLikeHeaders(input: ClerkRequestLike) {
  return input.headers
    ?? (typeof input.req === 'object' && !(input.req instanceof Request) ? input.req.headers : undefined)
    ?? input.node?.req?.headers
}

function getRequestLikeMethod(input: ClerkRequestLike): string {
  return input.method
    ?? (typeof input.req === 'object' && !(input.req instanceof Request) ? input.req.method : undefined)
    ?? input.node?.req?.method
    ?? 'GET'
}

function getRequestLikeUrl(input: ClerkRequestLike, headers: Headers): string {
  const url = (typeof input.url === 'string' ? input.url : input.url?.toString())
    ?? (typeof input.req === 'object' && !(input.req instanceof Request) ? input.req.url : undefined)
    ?? input.node?.req?.url
    ?? input.path
    ?? '/'

  try {
    return new URL(url).toString()
  } catch {
    const protocol = headers.get('x-forwarded-proto') ?? 'http'
    const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? 'localhost'
    return new URL(url, `${protocol}://${host}`).toString()
  }
}

function normalizeClerkRequest(input: ClerkRequestInput): Request {
  if (input instanceof Request) {
    return input
  }

  const request = getRequestFromLikeInput(input)
  if (request) {
    return request
  }

  const headers = normalizeRequestHeaders(getRequestLikeHeaders(input))
  return new Request(getRequestLikeUrl(input, headers), {
    method: getRequestLikeMethod(input),
    headers,
  })
}

function getBindings(): ClerkAuthBindings {
  const clerkBindings = getRuntimeState().bindings
  if (!clerkBindings?.identityStore) {
    throwUnconfigured()
  }

  return {
    providers: clerkBindings.providers ?? {},
    identityStore: clerkBindings.identityStore,
  }
}

async function verifyClerkSessionToken(
  token: string,
  config: AuthClerkProviderConfig,
  authorizedParties: readonly string[] = [],
): Promise<Readonly<Record<string, unknown>>> {
  const parsed = parseJwt(token)
  const headerKid = typeof parsed.header.kid === 'string' ? parsed.header.kid : undefined
  const jwksUrl = resolveClerkJwksUrl(config)
  const resolveKey = async (refresh = false): Promise<JwkKey | undefined> => {
    const keys = await fetchClerkJwks(jwksUrl, { refresh })
    return headerKid
      ? keys.find(candidate => candidate.kid === headerKid)
      : keys[0]
  }

  let key = await resolveKey()
  if (!key || !verifyJwtSignatureWithJwk(parsed, key)) {
    key = await resolveKey(true)
  }
  if (!key || !verifyJwtSignatureWithJwk(parsed, key)) {
    throw new Error('[@holo-js/auth-clerk] Clerk token signature verification failed.')
  }

  const exp = typeof parsed.payload.exp === 'number' ? parsed.payload.exp : undefined
  if (typeof exp === 'number' && (exp * 1000) <= Date.now()) {
    throw new Error('[@holo-js/auth-clerk] Clerk token has expired.')
  }

  const nbf = typeof parsed.payload.nbf === 'number' ? parsed.payload.nbf : undefined
  if (typeof nbf === 'number' && (nbf * 1000) > Date.now()) {
    throw new Error('[@holo-js/auth-clerk] Clerk token is not valid yet.')
  }

  const azp = typeof parsed.payload.azp === 'string' ? parsed.payload.azp.trim() : ''
  if (azp) {
    const allowedAuthorizedParties = authorizedParties
      .map(value => value.trim())
      .filter(Boolean)
    if (allowedAuthorizedParties.length > 0 && !allowedAuthorizedParties.includes(azp)) {
      throw new Error(`[@holo-js/auth-clerk] Clerk token authorized party "${azp}" is not allowed.`)
    }
  }

  return parsed.payload
}

function normalizeClerkEmailAddress(value: Readonly<Record<string, unknown>>): ClerkEmailAddress {
  const verification = value.verification && typeof value.verification === 'object'
    ? value.verification as Readonly<Record<string, unknown>>
    : undefined

  return Object.freeze({
    id: typeof value.id === 'string' ? value.id : undefined,
    emailAddress: typeof value.emailAddress === 'string'
      ? value.emailAddress
      : typeof value.email_address === 'string'
        ? value.email_address
        : '',
    verificationStatus: typeof value.verificationStatus === 'string'
      ? value.verificationStatus as ClerkEmailAddress['verificationStatus']
      : typeof verification?.status === 'string'
        ? verification.status as ClerkEmailAddress['verificationStatus']
        : undefined,
  })
}

function normalizeClerkUserProfile(user: Readonly<Record<string, unknown>>): ClerkUserProfile {
  const emailAddresses = Array.isArray(user.emailAddresses)
    ? user.emailAddresses.map(entry => normalizeClerkEmailAddress(entry as Readonly<Record<string, unknown>>))
    : Array.isArray(user.email_addresses)
      ? user.email_addresses.map(entry => normalizeClerkEmailAddress(entry as Readonly<Record<string, unknown>>))
      : undefined
  const primaryEmailAddressId = typeof user.primaryEmailAddressId === 'string'
    ? user.primaryEmailAddressId
    : typeof user.primary_email_address_id === 'string'
      ? user.primary_email_address_id
      : undefined
  const email = typeof user.email === 'string' && user.email.trim()
    ? user.email.trim()
    : (
        emailAddresses?.find((entry) => entry.id === primaryEmailAddressId)
        ?? emailAddresses?.[0]
      )?.emailAddress.trim()
      ?? ''
  const emailVerified = user.emailVerified === true
    || user.email_verified === true
    || (
      emailAddresses?.find((entry) => entry.id === primaryEmailAddressId)
      ?? emailAddresses?.[0]
    )?.verificationStatus === 'verified'
  const firstName = typeof user.firstName === 'string'
    ? user.firstName
    : typeof user.first_name === 'string'
      ? user.first_name
      : undefined
  const lastName = typeof user.lastName === 'string'
    ? user.lastName
    : typeof user.last_name === 'string'
      ? user.last_name
      : undefined
  const explicitName = typeof user.name === 'string' ? user.name.trim() : ''
  const name = explicitName || [firstName?.trim(), lastName?.trim()].filter(Boolean).join(' ').trim()

  return Object.freeze({
    id: String(user.id ?? ''),
    email,
    emailVerified,
    firstName,
    lastName,
    name: name || email || String(user.id ?? ''),
    imageUrl: typeof user.imageUrl === 'string'
      ? user.imageUrl
      : typeof user.image_url === 'string'
        ? user.image_url
        : undefined,
    primaryEmailAddressId,
    emailAddresses,
    raw: user,
  })
}

async function fetchClerkUserProfile(
  userId: string,
  config: AuthClerkProviderConfig,
): Promise<ClerkUserProfile> {
  const secretKey = config.secretKey?.trim()
  if (!secretKey) {
    throw new Error('[@holo-js/auth-clerk] Clerk verification requires secretKey to be configured.')
  }

  const apiBase = config.apiUrl?.trim() || CLERK_API_BASE_URL
  const response = await fetch(`${apiBase.replace(/\/$/, '')}/v1/users/${encodeURIComponent(userId)}`, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${secretKey}`,
    },
  })
  if (!response.ok) {
    throw new Error(`[@holo-js/auth-clerk] Failed to load Clerk user "${userId}".`)
  }

  return normalizeClerkUserProfile(await response.json() as Readonly<Record<string, unknown>>)
}

function createDefaultProviderRuntime(providerName: string, config: AuthClerkProviderConfig): ClerkProviderRuntime {
  const cacheKey = JSON.stringify([
    providerName,
    config.apiUrl ?? '',
    config.frontendApi ?? '',
    config.secretKey ?? '',
    [...(config.authorizedParties ?? [])].sort(),
  ])
  const existing = clerkDefaultProviderRuntimeCache.get(cacheKey)
  if (existing) {
    return existing
  }

  const runtime = Object.freeze({
    async verifySession({ token }: ClerkVerifySessionContext): Promise<ClerkVerifiedSession | null> {
      const claims = await verifyClerkSessionToken(token, config, config.authorizedParties)
      const userId = typeof claims.sub === 'string' ? claims.sub : ''
      if (!userId) {
        throw new Error('[@holo-js/auth-clerk] Clerk token did not include a subject.')
      }

      const profile = await fetchClerkUserProfile(userId, config)
      const sessionId = typeof claims.sid === 'string'
        ? claims.sid
        : typeof claims.session_id === 'string'
          ? claims.session_id
          : token

      return Object.freeze({
        sessionId,
        user: profile,
        accessToken: token,
        raw: Object.freeze({
          claims,
          user: profile.raw,
        }),
      })
    },
  }) satisfies ClerkProviderRuntime

  clerkDefaultProviderRuntimeCache.set(cacheKey, runtime)
  return runtime
}

function resolveConfiguredProviderName(provider?: string): string {
  const bindings = authRuntimeInternals.getRuntimeBindings()

  if (provider?.trim()) {
    return provider.trim()
  }

  const configuredDefaultProvider = typeof bindings.config.clerk.provider === 'string'
    ? bindings.config.clerk.provider.trim()
    : ''
  if (configuredDefaultProvider) {
    return configuredDefaultProvider
  }

  const configuredProviders = Object.entries(bindings.config.clerk).flatMap(([name, value]) => (
    name !== 'provider' && name !== 'identityStore' && isNormalizedClerkProviderConfig(value)
      ? [name]
      : []
  ))
  if (configuredProviders.length === 0) {
    return 'default'
  }

  if (configuredProviders.length === 1) {
    return configuredProviders[0]!
  }

  if (configuredProviders.includes('default')) {
    return 'default'
  }

  throw new Error('[@holo-js/auth-clerk] Clerk provider name is required when multiple auth.clerk entries exist.')
}

function isNormalizedClerkProviderConfig(value: unknown): value is NormalizedAuthClerkProviderConfig {
  return value !== null
    && typeof value === 'object'
    && 'sessionCookie' in value
    && typeof (value as { sessionCookie?: unknown }).sessionCookie === 'string'
    && 'authorizedParties' in value
    && Array.isArray((value as { authorizedParties?: unknown }).authorizedParties)
}

function getConfiguredProviderConfig(provider?: string): {
  readonly name: string
} & NormalizedAuthClerkProviderConfig {
  const providerName = resolveConfiguredProviderName(provider)
  const authBindings = authRuntimeInternals.getRuntimeBindings()
  const configured = authBindings.config.clerk[providerName]
  if (!isNormalizedClerkProviderConfig(configured)) {
    throw new Error(`[@holo-js/auth-clerk] Clerk provider "${providerName}" is not configured in auth.clerk.`)
  }

  return {
    name: providerName,
    publishableKey: configured.publishableKey,
    secretKey: configured.secretKey,
    apiUrl: configured.apiUrl,
    frontendApi: configured.frontendApi,
    redirectUri: configured.redirectUri,
    sessionCookie: configured.sessionCookie,
    authorizedParties: configured.authorizedParties ?? [],
    guard: configured.guard,
    mapToProvider: configured.mapToProvider,
  }
}

function getProviderRuntime(provider?: string): ClerkProviderRuntime {
  const providerName = resolveConfiguredProviderName(provider)
  return getBindings().providers[providerName]
    ?? createDefaultProviderRuntime(providerName, getConfiguredProviderConfig(providerName))
}

function requireClerkHostedConfig(config: NormalizedAuthClerkProviderConfig): {
  readonly frontendApi: string
  readonly redirectUri: string
} {
  const frontendApi = config.frontendApi?.trim()
  const redirectUri = config.redirectUri?.trim()
  if (!frontendApi) {
    throw new Error('[@holo-js/auth-clerk] Clerk hosted auth requires frontendApi to be configured.')
  }
  if (!redirectUri) {
    throw new Error('[@holo-js/auth-clerk] Clerk hosted auth requires redirectUri to be configured.')
  }

  return { frontendApi, redirectUri }
}

function resolveClerkAccountPortalUrl(frontendApi: string): string {
  const url = new URL(frontendApi)
  if (url.hostname.endsWith('.clerk.accounts.dev')) {
    url.hostname = `${url.hostname.slice(0, -'.clerk.accounts.dev'.length)}.accounts.dev`
  } else if (url.hostname.startsWith('clerk.')) {
    url.hostname = `accounts.${url.hostname.slice('clerk.'.length)}`
  }
  url.pathname = '/'
  url.search = ''
  url.hash = ''

  return url.toString()
}

function createAuthorizationUrl(config: NormalizedAuthClerkProviderConfig, page: 'sign-in' | 'sign-up'): string {
  const { frontendApi, redirectUri } = requireClerkHostedConfig(config)
  const portalBaseUrl = resolveClerkAccountPortalUrl(frontendApi)
  const url = new URL(page, portalBaseUrl)
  url.searchParams.set('redirect_url', redirectUri)

  return url.toString()
}

function createClerkReturnUrl(request: Request, returnTo?: string): string {
  const requestUrl = new URL(request.url)
  const safeDefault = new URL('/', requestUrl).toString()
  const trimmed = returnTo?.trim()
  if (!trimmed || hasControlCharacter(trimmed)) {
    return safeDefault
  }

  try {
    const parsed = new URL(trimmed, requestUrl)
    const isRelativePath = trimmed.startsWith('/') && !trimmed.startsWith('//')
    const isAbsoluteUrl = /^[a-z][a-z\d+.-]*:/iu.test(trimmed)
    if (parsed.origin !== requestUrl.origin || !parsed.pathname.startsWith('/') || (!isRelativePath && !isAbsoluteUrl)) {
      return safeDefault
    }

    return parsed.toString()
  } catch {
    return safeDefault
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (typeof codePoint === 'number' && (codePoint < 32 || codePoint === 127)) {
      return true
    }
  }

  return false
}

function createClerkErrorResponse(error: unknown, code: string): Response {
  return Response.json({
    ok: false,
    code,
    message: getErrorMessage(error),
  } as const, {
    status: error instanceof ClerkAuthConflictError ? 409 : 422,
  })
}

function resolveGuardAndProvider(provider?: string): {
  readonly guard: string
  readonly authProvider: string
  readonly adapter: RuntimeAuthProviderAdapter
} {
  const authBindings = authRuntimeInternals.getRuntimeBindings()
  const providerConfig = getConfiguredProviderConfig(provider)
  const guardName = providerConfig.guard ?? authBindings.config.defaults.guard
  const guard = authBindings.config.guards[guardName]
  if (!guard) {
    throw new Error(`[@holo-js/auth-clerk] Guard "${guardName}" is not configured for Clerk provider "${providerConfig.name}".`)
  }
  if (guard.driver !== 'session') {
    throw new Error(`[@holo-js/auth-clerk] Clerk sign-in requires auth guard "${guardName}" to use the session driver.`)
  }

  const authProvider = providerConfig.mapToProvider ?? guard.provider
  const adapter = authBindings.providers[authProvider]
  if (!adapter) {
    throw new Error(`[@holo-js/auth-clerk] Auth provider runtime "${authProvider}" is not configured.`)
  }

  return {
    guard: guardName,
    authProvider,
    adapter,
  }
}

function requireUserId(
  adapter: RuntimeAuthProviderAdapter,
  user: unknown,
  message: string,
): string | number {
  if (!user || typeof user !== 'object') {
    throw new Error(message)
  }

  const userId = adapter.getId(user as Record<string, unknown>)
  if (typeof userId !== 'string' && typeof userId !== 'number') {
    throw new Error(message)
  }

  return userId
}

function requireUserRecord(user: unknown, message: string): Record<string, unknown> {
  if (!user || typeof user !== 'object') {
    throw new Error(message)
  }

  return user as Record<string, unknown>
}

function requireSerializedUser(user: AuthUserLike, message: string): SerializedClerkAuthUser {
  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user as SerializedClerkAuthUser
  }

  throw new Error(message)
}

function createClerkSessionPayload(
  authenticated: Pick<ClerkAuthenticationResult, 'guard' | 'authProvider' | 'provider' | 'user'>,
  session: ClerkVerifiedSession,
): ClerkSessionPayload {
  const user = requireSerializedUser(
    authenticated.user,
    '[@holo-js/auth-clerk] Clerk-authenticated local users must expose a serializable id.',
  )

  return Object.freeze({
    guard: authenticated.guard,
    provider: authenticated.authProvider,
    userId: user.id,
    user,
    clerk: Object.freeze({
      provider: authenticated.provider,
      sessionId: session.sessionId,
    }),
  })
}

function getClerkLogoutSession(payload: unknown, providerName: string): ClerkLogoutSession | null {
  if (!payload || typeof payload !== 'object' || !('clerk' in payload)) {
    return null
  }

  const clerk = (payload as { readonly clerk?: unknown }).clerk
  if (!clerk || typeof clerk !== 'object') {
    return null
  }

  const provider = (clerk as { readonly provider?: unknown }).provider
  const sessionId = (clerk as { readonly sessionId?: unknown }).sessionId
  if (provider !== providerName || typeof sessionId !== 'string' || !sessionId.trim()) {
    return null
  }

  return Object.freeze({
    provider,
    sessionId,
  })
}

function serializeLocalUser<TUserAttributes extends ClerkUserAttributes = ClerkDefaultUserAttributes>(
  adapter: RuntimeAuthProviderAdapter,
  user: Record<string, unknown>,
  providerName: string,
): SerializedClerkAuthUser & TUserAttributes {
  const id = adapter.getId(user)
  const serialized = adapter.serialize
    ? adapter.serialize(user)
    : { ...(user as Record<string, unknown>) }

  const result = {
    ...serialized,
    id,
  }
  Object.defineProperty(result, AUTH_PROVIDER_MARKER, {
    value: providerName,
    enumerable: false,
    configurable: true,
  })
  Object.defineProperty(result, 'can', {
    value: () => false,
    enumerable: false,
    configurable: true,
  })

  return Object.freeze(result) as SerializedClerkAuthUser & TUserAttributes
}

function resolvePrimaryEmail(profile: ClerkUserProfile): { email?: string, emailVerified: boolean } {
  if (profile.email?.trim()) {
    return {
      email: profile.email.trim(),
      emailVerified: profile.emailVerified === true,
    }
  }

  const primary = profile.emailAddresses?.find((entry) => entry.id === profile.primaryEmailAddressId)
    ?? profile.emailAddresses?.[0]

  if (!primary?.emailAddress?.trim()) {
    return {
      email: undefined,
      emailVerified: false,
    }
  }

  return {
    email: primary.emailAddress.trim(),
    emailVerified: primary.verificationStatus === 'verified',
  }
}

function resolveDisplayName(profile: ClerkUserProfile): string {
  if (profile.name?.trim()) {
    return profile.name.trim()
  }

  const fullName = [profile.firstName?.trim(), profile.lastName?.trim()].filter(Boolean).join(' ').trim()
  return fullName || profile.email || profile.id
}

function resolveEmailForCreation(profile: ClerkUserProfile): string {
  const primary = resolvePrimaryEmail(profile).email
  if (primary) {
    return primary
  }

  return `${profile.id}@clerk.hosted.local`
}

function toAdapterInput(input: ClerkUserAttributes): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(input).filter((entry) => typeof entry[1] !== 'undefined'),
  ))
}

function withRequiredUserFields(input: ClerkUserAttributes, profile: ClerkUserProfile): ClerkUserAttributes {
  return Object.freeze({
    ...input,
    email: typeof input.email === 'undefined' ? resolveEmailForCreation(profile) : input.email,
    name: typeof input.name === 'undefined' ? resolveDisplayName(profile) : input.name,
  })
}

function resolveCreateUserInput<TUserAttributes extends ClerkUserAttributes>(
  profile: ClerkUserProfile,
  mapper?: (clerkUser: ClerkUserProfile) => TUserAttributes,
): Readonly<Record<string, unknown>> {
  return toAdapterInput(withRequiredUserFields({
    password: null,
    avatar: profile.imageUrl ?? null,
    email_verified_at: profile.emailVerified ? new Date() : null,
    ...(mapper?.(profile) ?? {}),
  }, profile))
}

function resolveUpdateUserInput<TUserAttributes extends ClerkUserAttributes>(
  profile: ClerkUserProfile,
  mapper?: (clerkUser: ClerkUserProfile) => TUserAttributes,
): Readonly<Record<string, unknown>> {
  return toAdapterInput(withRequiredUserFields({
    email: profile.email.trim() || undefined,
    avatar: profile.imageUrl,
    email_verified_at: profile.emailVerified ? new Date() : undefined,
    ...(mapper?.(profile) ?? {}),
  }, profile))
}

function normalizeHostedProfile(profile: ClerkUserProfile): Readonly<Record<string, unknown>> {
  const resolvedEmail = resolvePrimaryEmail(profile)

  return Object.freeze({
    id: profile.id,
    email: resolvedEmail.email,
    emailVerified: resolvedEmail.emailVerified,
    firstName: profile.firstName,
    lastName: profile.lastName,
    name: resolveDisplayName(profile),
    imageUrl: profile.imageUrl,
    primaryEmailAddressId: profile.primaryEmailAddressId,
    emailAddresses: profile.emailAddresses ? [...profile.emailAddresses] : undefined,
    raw: profile.raw,
  })
}

async function findUserByEmail(
  adapter: RuntimeAuthProviderAdapter,
  email: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (!email?.trim()) {
    return null
  }

  const user = await adapter.findByCredentials({ email: email.trim() })
  return user
    ? requireUserRecord(user, '[@holo-js/auth-clerk] Auth provider lookups must return object users.')
    : null
}

async function updateLocalUser(
  adapter: RuntimeAuthProviderAdapter,
  user: Record<string, unknown>,
  input: Readonly<Record<string, unknown>>,
): Promise<{
  readonly user: Record<string, unknown>
  readonly changed: boolean
}> {
  const current = user as {
    name?: string
    email?: string
    avatar?: string | null
    email_verified_at?: Date | string | null
  }

  const changed = Object.entries(input).some(([key, value]) => {
    if (key === 'email_verified_at') {
      return value instanceof Date && !current.email_verified_at
    }

    return !Object.is(value, user[key])
  })

  if (!changed) {
    return { user, changed: false }
  }

  if (adapter.update) {
    return {
      user: requireUserRecord(
        await adapter.update(user, input),
        '[@holo-js/auth-clerk] Auth provider updates must return object users.',
      ),
      changed: true,
    }
  }

  throw new Error(
    '[@holo-js/auth-clerk] Auth provider adapters must implement update() to persist profile changes.',
  )
}

async function ensureNoUnexpectedEmailCollision(
  adapter: RuntimeAuthProviderAdapter,
  providerName: string,
  profile: ClerkUserProfile,
  currentUserId: string | number,
): Promise<void> {
  const resolvedEmail = resolvePrimaryEmail(profile).email
  if (!resolvedEmail) {
    return
  }

  const matched = await findUserByEmail(adapter, resolvedEmail)
  if (!matched) {
    return
  }

  if (
    requireUserId(
      adapter,
      matched,
      '[@holo-js/auth-clerk] Matched local users must expose a serializable id.',
    ) !== currentUserId
  ) {
    throw new ClerkAuthConflictError({
      provider: providerName,
      clerkUserId: profile.id,
      email: resolvedEmail,
      message: `[@holo-js/auth-clerk] Clerk email "${resolvedEmail}" collides with a different local user.`,
    })
  }
}

async function assertUserLinkAvailable(
  providerName: string,
  authProvider: string,
  adapter: RuntimeAuthProviderAdapter,
  user: Record<string, unknown>,
  clerkUserId: string,
): Promise<void> {
  const existing = await getBindings().identityStore.findByUserId(
    providerName,
    authProvider,
    requireUserId(adapter, user, '[@holo-js/auth-clerk] Linked users must expose a serializable id.'),
  )
  if (existing && existing.providerUserId !== clerkUserId) {
    throw new ClerkAuthConflictError({
      provider: providerName,
      clerkUserId,
      email: existing.email,
      message: `[@holo-js/auth-clerk] Local user is already linked to Clerk identity "${existing.providerUserId}".`,
    })
  }
}

function isEmailVerificationRequired(): boolean {
  return authRuntimeInternals.getRuntimeBindings().config.emailVerification.required === true
}

function createIdentityRecord(input: {
  readonly provider: string
  readonly guard: string
  readonly authProvider: string
  readonly userId: string | number
  readonly profile: ClerkUserProfile
  readonly previous?: HostedIdentityRecord
}): HostedIdentityRecord {
  const now = new Date()
  const resolvedEmail = resolvePrimaryEmail(input.profile)

  return Object.freeze({
    provider: input.provider,
    providerUserId: input.profile.id,
    guard: input.guard,
    authProvider: input.authProvider,
    userId: input.userId,
    email: resolvedEmail.email,
    emailVerified: resolvedEmail.emailVerified,
    profile: normalizeHostedProfile(input.profile),
    linkedAt: input.previous?.linkedAt ?? now,
    updatedAt: now,
  })
}

async function withIdentitySyncLock<TResult>(key: string, callback: () => Promise<TResult>): Promise<TResult> {
  const previous = clerkIdentitySyncLocks.get(key) ?? Promise.resolve()
  let release: () => void = () => {}
  const current = previous.then(() => new Promise<void>((resolve) => {
    release = resolve
  }))
  clerkIdentitySyncLocks.set(key, current)

  await previous

  try {
    return await callback()
  } finally {
    release()
    if (clerkIdentitySyncLocks.get(key) === current) {
      clerkIdentitySyncLocks.delete(key)
    }
  }
}

async function claimNewIdentity(
  identityStore: HostedIdentityStore,
  identity: HostedIdentityRecord,
): Promise<HostedIdentityRecord> {
  if (identityStore.claim) {
    return await identityStore.claim(identity)
  }

  await identityStore.save(identity)
  return identity
}

function sameUserId(left: string | number, right: string | number): boolean {
  return String(left) === String(right)
}

async function resolveClaimedIdentityUser(
  adapter: RuntimeAuthProviderAdapter,
  identity: HostedIdentityRecord,
  fallback: {
    readonly user: Record<string, unknown>
    readonly userId: string | number
    readonly deleteOnMismatch?: boolean
  },
): Promise<Record<string, unknown>> {
  if (sameUserId(identity.userId, fallback.userId)) {
    return fallback.user
  }

  const claimedUser = requireUserRecord(
    await adapter.findById(identity.userId),
    '[@holo-js/auth-clerk] Claimed Clerk identities must reference an existing local user.',
  )

  if (fallback.deleteOnMismatch && adapter.delete) {
    await adapter.delete(fallback.userId)
  }

  return claimedUser
}

function getSessionTokenFromRequest(request: Request, sessionCookie: string): string | null {
  const authorization = request.headers.get('authorization')?.trim()
  if (authorization) {
    const [scheme, token] = authorization.split(/\s+/, 2)
    if (scheme?.toLowerCase() === 'bearer' && token?.trim()) {
      return token.trim()
    }
  }

  const cookies = parseCookieHeader(request.headers.get('cookie'))
  return cookies[sessionCookie] ?? null
}

function hasClerkCallbackState(request: Request): boolean {
  const url = new URL(request.url)
  return [...url.searchParams.keys()].some(key => key.startsWith('__clerk'))
}

function hasClerkHandshakeAttempt(request: Request): boolean {
  const url = new URL(request.url)
  if (
    url.searchParams.has('__clerk_handshake')
    || url.searchParams.has('__clerk_handshake_nonce')
    || url.searchParams.has('__clerk_synced')
  ) {
    return true
  }

  const cookies = parseCookieHeader(request.headers.get('cookie'))
  const redirectCount = cookies.__clerk_redirect_count
  return typeof redirectCount === 'string' && redirectCount !== '' && redirectCount !== '0'
}

function isConfiguredClerkRedirectRequest(
  request: Request,
  config: NormalizedAuthClerkProviderConfig,
): boolean {
  const redirectUri = config.redirectUri?.trim()
  if (!redirectUri) {
    return hasClerkCallbackState(request)
  }

  try {
    const requestUrl = new URL(request.url)
    const configuredUrl = new URL(redirectUri, requestUrl.origin)
    return requestUrl.origin === configuredUrl.origin && requestUrl.pathname === configuredUrl.pathname
  } catch {
    return false
  }
}

function splitSetCookieHeader(value: string): readonly string[] {
  return value
    .split(/,(?=\s*[^;,=\s]+=)/g)
    .map(cookie => cookie.trim())
    .filter(Boolean)
}

function getSetCookieHeaders(headers: Headers): readonly string[] {
  const withGetSetCookie = headers as Headers & {
    readonly getSetCookie?: () => string[]
  }
  const explicit = withGetSetCookie.getSetCookie?.()
  if (explicit?.length) {
    return explicit
  }

  const combined = headers.get('set-cookie')
  return combined ? splitSetCookieHeader(combined) : []
}

async function appendClerkResponseCookies(headers: Headers): Promise<void> {
  const append = authRuntimeInternals.getRuntimeBindings().context.appendResponseCookie
  if (!append) {
    return
  }

  for (const cookie of getSetCookieHeaders(headers)) {
    await append(cookie)
  }
}

function getHoloSessionIdFromRequest(request: Request): string | null {
  const cookieHeader = authRuntimeInternals.getRuntimeBindings().session.sessionCookie('')
  const separator = cookieHeader.indexOf('=')
  const cookieName = separator > 0
    ? decodeURIComponent(cookieHeader.slice(0, separator))
    : ''
  if (!cookieName) {
    return null
  }

  const cookies = parseCookieHeader(request.headers.get('cookie'))
  return cookies[cookieName] ?? null
}

async function reuseExistingHoloSession(
  request: Request,
  authenticated: Pick<ClerkAuthenticationResult, 'guard' | 'authProvider' | 'provider' | 'user'>,
): Promise<AuthEstablishedSession | null> {
  const bindings = authRuntimeInternals.getRuntimeBindings()
  const sessionId = getHoloSessionIdFromRequest(request)
  if (!sessionId) {
    return null
  }

  bindings.context.setSessionId(authenticated.guard, sessionId)
  const record = await bindings.session.read(sessionId)
  const payload = authRuntimeInternals.readSessionPayload(record, authenticated.guard)
  if (
    !payload
    || payload.guard !== authenticated.guard
    || payload.provider !== authenticated.authProvider
    || String(payload.userId) !== String(authenticated.user.id)
  ) {
    return null
  }

  const source = payload as typeof payload & {
    readonly clerk?: {
      readonly provider?: unknown
    }
  }
  if (source.clerk && typeof source.clerk === 'object') {
    if (typeof source.clerk.provider !== 'string' || source.clerk.provider !== authenticated.provider) {
      return null
    }
  }

  bindings.context.setCachedUser(authenticated.guard, authenticated.user)
  return Object.freeze({
    guard: authenticated.guard,
    provider: source.clerk && typeof source.clerk === 'object' ? 'clerk' : payload.provider,
    user: authenticated.user,
    sessionId,
    cookies: Object.freeze([]),
  })
}

export async function verifySession(token: string, provider?: string): Promise<ClerkVerifiedSession | null> {
  const providerConfig = getConfiguredProviderConfig(provider)
  const runtime = getProviderRuntime(providerConfig.name)
  if (!runtime.verifySession) {
    throw new Error(`[@holo-js/auth-clerk] Clerk provider runtime "${providerConfig.name}" does not implement verifySession().`)
  }

  return runtime.verifySession({
    provider: providerConfig.name,
    token,
    config: providerConfig,
  })
}

function resolveRequestAuthorizedParties(
  config: NormalizedAuthClerkProviderConfig,
  request: Request,
): readonly string[] {
  return Object.freeze([
    ...new Set([
      ...(config.authorizedParties ?? []),
      new URL(request.url).origin,
    ]),
  ])
}

async function verifyDefaultSessionToken(
  token: string,
  providerConfig: { readonly name: string } & NormalizedAuthClerkProviderConfig,
  authorizedParties: readonly string[],
): Promise<ClerkVerifiedSession | null> {
  const config = {
    ...providerConfig,
    authorizedParties,
  }
  const defaultRuntime = createDefaultProviderRuntime(providerConfig.name, config)
  if (!defaultRuntime.verifySession) {
    throw new Error(`[@holo-js/auth-clerk] Clerk provider runtime "${providerConfig.name}" does not implement verifySession().`)
  }

  return defaultRuntime.verifySession({
    provider: providerConfig.name,
    token,
    config,
  })
}

async function verifyRequestWithClerkBackendSdk(
  request: Request,
  providerConfig: { readonly name: string } & NormalizedAuthClerkProviderConfig,
): Promise<ClerkVerifiedSession | null> {
  const publishableKey = providerConfig.publishableKey?.trim()
  const secretKey = providerConfig.secretKey?.trim()
  if (!publishableKey || !secretKey) {
    return null
  }

  const { createClerkClient } = await import('@clerk/backend')
  const client = createClerkClient({
    apiUrl: providerConfig.apiUrl,
    publishableKey,
    secretKey,
  })
  const authenticateOptions = {
    apiUrl: providerConfig.apiUrl,
    authorizedParties: [...resolveRequestAuthorizedParties(providerConfig, request)],
    publishableKey,
    secretKey,
  }
  const requestState = await client.authenticateRequest(request, authenticateOptions)

  await appendClerkResponseCookies(requestState.headers)
  if (requestState.status === 'handshake') {
    const redirectUrl = requestState.headers.get('location')
    if (redirectUrl && !hasClerkHandshakeAttempt(request)) {
      await authRuntimeInternals.redirectResponse(
        authRuntimeInternals.getRuntimeBindings(),
        new URL(redirectUrl, request.url).toString(),
        307,
      )
    }
    return null
  }

  if (requestState.status !== 'signed-in') {
    return null
  }

  return verifyDefaultSessionToken(
    requestState.token,
    providerConfig,
    resolveRequestAuthorizedParties(providerConfig, request),
  )
}

export async function verifyRequest(input: ClerkRequestInput, provider?: string): Promise<ClerkVerifiedSession | null> {
  const request = normalizeClerkRequest(input)
  const providerConfig = getConfiguredProviderConfig(provider)
  const configuredRuntime = getBindings().providers[providerConfig.name]
  const runtime = configuredRuntime ?? getProviderRuntime(providerConfig.name)

  if (runtime.verifyRequest) {
    return runtime.verifyRequest({
      provider: providerConfig.name,
      request,
      config: providerConfig,
    })
  }

  const token = getSessionTokenFromRequest(request, providerConfig.sessionCookie)
  if (!configuredRuntime && (hasClerkCallbackState(request) || isConfiguredClerkRedirectRequest(request, providerConfig))) {
    const clerkSession = await verifyRequestWithClerkBackendSdk(request, providerConfig)
    if (clerkSession) {
      return clerkSession
    }
  }

  if (!token) {
    return null
  }

  if (configuredRuntime) {
    if (!configuredRuntime.verifySession) {
      throw new Error(`[@holo-js/auth-clerk] Clerk provider runtime "${providerConfig.name}" does not implement verifySession().`)
    }

    return configuredRuntime.verifySession({
      provider: providerConfig.name,
      token,
      config: providerConfig,
    })
  }

  return verifyDefaultSessionToken(token, providerConfig, resolveRequestAuthorizedParties(providerConfig, request))
}

export async function syncIdentity<TUserAttributes extends ClerkUserAttributes = ClerkDefaultUserAttributes>(
  session: ClerkVerifiedSession,
  provider?: string,
  options: {
    readonly user?: (clerkUser: ClerkUserProfile) => TUserAttributes
  } = {},
): Promise<ClerkAuthenticationResult<TUserAttributes>> {
  const providerConfig = getConfiguredProviderConfig(provider)
  const providerName = providerConfig.name
  const profile = session.user
  const { guard, authProvider, adapter } = resolveGuardAndProvider(providerName)
  const verificationRequired = isEmailVerificationRequired()
  const resolvedEmail = resolvePrimaryEmail(profile)
  const verifiedEmail = resolvedEmail.emailVerified ? resolvedEmail.email : undefined

  if (verificationRequired && !verifiedEmail) {
    throw new Error(`[@holo-js/auth-clerk] Clerk identity "${profile.id}" must provide a verified email address.`)
  }

  return await withIdentitySyncLock(`${providerName}:${profile.id}`, async () => {
    const identityStore = getBindings().identityStore
    const existingIdentity = await identityStore.findByProviderUserId(providerName, profile.id)

    if (existingIdentity) {
      const existingLinkedUser = await adapter.findById(existingIdentity.userId)
      let linkedUser = existingLinkedUser
        ? requireUserRecord(existingLinkedUser, '[@holo-js/auth-clerk] Auth provider lookups must return object users.')
        : null

      if (!linkedUser) {
        linkedUser = verifiedEmail
          ? await findUserByEmail(adapter, verifiedEmail)
          : null

        if (linkedUser) {
          await assertUserLinkAvailable(providerName, authProvider, adapter, linkedUser, profile.id)
        }

        if (!linkedUser) {
          linkedUser = requireUserRecord(
            await adapter.create(resolveCreateUserInput(profile, options.user)),
            '[@holo-js/auth-clerk] Auth provider create() must return an object user.',
          )
        }

        const relinked = await updateLocalUser(adapter, linkedUser, resolveUpdateUserInput(profile, options.user))
        const relinkedUser = relinked.user
        const identity = createIdentityRecord({
          provider: providerName,
          guard,
          authProvider,
          userId: requireUserId(
            adapter,
            relinkedUser,
            '[@holo-js/auth-clerk] Relinked local users must expose a serializable id.',
          ),
          profile,
          previous: existingIdentity,
        })
        await identityStore.save(identity)

        return Object.freeze({
          provider: providerName,
          guard,
          authProvider,
          status: 'relinked',
          user: serializeLocalUser<TUserAttributes>(adapter, relinkedUser, authProvider),
          identity,
          session,
        })
      }

      await ensureNoUnexpectedEmailCollision(
        adapter,
        providerName,
        profile,
        requireUserId(
          adapter,
          linkedUser,
          '[@holo-js/auth-clerk] Linked local users must expose a serializable id.',
        ),
      )
      const updated = await updateLocalUser(adapter, linkedUser, resolveUpdateUserInput(profile, options.user))
      const identity = createIdentityRecord({
        provider: providerName,
        guard,
        authProvider,
        userId: requireUserId(
          adapter,
          updated.user,
          '[@holo-js/auth-clerk] Updated local users must expose a serializable id.',
        ),
        profile,
        previous: existingIdentity,
      })
      await identityStore.save(identity)

      return Object.freeze({
        provider: providerName,
        guard,
        authProvider,
        status: updated.changed ? 'updated' : 'linked',
        user: serializeLocalUser<TUserAttributes>(adapter, updated.user, authProvider),
        identity,
        session,
      })
    }

    let localUser = verifiedEmail
      ? await findUserByEmail(adapter, verifiedEmail)
      : null

    if (localUser) {
      await assertUserLinkAvailable(providerName, authProvider, adapter, localUser, profile.id)
      const linked = await updateLocalUser(adapter, localUser, resolveUpdateUserInput(profile, options.user))
      const identity = createIdentityRecord({
        provider: providerName,
        guard,
        authProvider,
        userId: requireUserId(
          adapter,
          linked.user,
          '[@holo-js/auth-clerk] Linked local users must expose a serializable id.',
        ),
        profile,
      })
      const claimedIdentity = await claimNewIdentity(identityStore, identity)
      const claimedUser = await resolveClaimedIdentityUser(adapter, claimedIdentity, {
        user: linked.user,
        userId: identity.userId,
      })

      return Object.freeze({
        provider: providerName,
        guard,
        authProvider,
        status: 'linked',
        user: serializeLocalUser<TUserAttributes>(adapter, claimedUser, authProvider),
        identity: claimedIdentity,
        session,
      })
    }

    localUser = requireUserRecord(
      await adapter.create(resolveCreateUserInput(profile, options.user)),
      '[@holo-js/auth-clerk] Auth provider create() must return an object user.',
    )
    const identity = createIdentityRecord({
      provider: providerName,
      guard,
      authProvider,
      userId: requireUserId(
        adapter,
        localUser,
        '[@holo-js/auth-clerk] Created local users must expose a serializable id.',
      ),
      profile,
    })
    const claimedIdentity = await claimNewIdentity(identityStore, identity)
    const claimedUser = await resolveClaimedIdentityUser(adapter, claimedIdentity, {
      user: localUser,
      userId: identity.userId,
      deleteOnMismatch: true,
    })
    const claimedStatus = sameUserId(claimedIdentity.userId, identity.userId) ? 'created' : 'linked'

    return Object.freeze({
      provider: providerName,
      guard,
      authProvider,
      status: claimedStatus,
      user: serializeLocalUser<TUserAttributes>(adapter, claimedUser, authProvider),
      identity: claimedIdentity,
      session,
    })
  })
}

export async function authenticate(input: ClerkRequestInput, provider?: string): Promise<ClerkAuthenticationResult | null> {
  const request = normalizeClerkRequest(input)
  const session = await verifyRequest(request, provider)
  if (!session) {
    return null
  }

  const authenticated = await syncIdentity(session, provider)
  const authSession = await reuseExistingHoloSession(request, authenticated)
    ?? await authRuntimeInternals.establishSessionForUser(authenticated.user, {
      guard: authenticated.guard,
      provider: authenticated.authProvider,
      payload: createClerkSessionPayload(authenticated, session),
    })
  return Object.freeze({
    ...authenticated,
    authSession,
  })
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Clerk authentication failed.'
}

function createHostedAuthSuccess<TData>(data: TData) {
  return Object.freeze({
    data,
    error: null,
  } as const)
}

function createHostedAuthFailure<TCode extends string>(code: TCode, message: string, status: number) {
  return Object.freeze({
    data: null,
    error: Object.freeze({
      code,
      message,
      status,
      fields: Object.freeze({
        _root: Object.freeze([message]),
      }),
    }),
  } as const)
}

export async function loginWithClerk(
  _input: ClerkRequestInput,
  options: {
    readonly provider?: string
  } = {},
): Promise<Response> {
  try {
    const providerConfig = getConfiguredProviderConfig(options.provider)
    return Response.redirect(createAuthorizationUrl(providerConfig, 'sign-in'), 302)
  } catch (error) {
    return createClerkErrorResponse(error, 'clerk_login_failed')
  }
}

export async function registerWithClerk(
  _input: ClerkRequestInput,
  options: {
    readonly provider?: string
  } = {},
): Promise<Response> {
  try {
    const providerConfig = getConfiguredProviderConfig(options.provider)
    return Response.redirect(createAuthorizationUrl(providerConfig, 'sign-up'), 302)
  } catch (error) {
    return createClerkErrorResponse(error, 'clerk_register_failed')
  }
}

async function readCurrentClerkLogoutSession(guard: string, providerName: string): Promise<ClerkLogoutSession | null> {
  const bindings = authRuntimeInternals.getRuntimeBindings()
  const sessionId = bindings.context.getSessionId(guard)
  if (!sessionId) {
    return null
  }

  const record = await bindings.session.read(sessionId)
  return getClerkLogoutSession(authRuntimeInternals.readSessionPayload(record, guard), providerName)
}

async function revokeClerkSession(config: NormalizedAuthClerkProviderConfig, sessionId: string): Promise<void> {
  const secretKey = config.secretKey?.trim()
  if (!secretKey) {
    throw new Error('[@holo-js/auth-clerk] Clerk logout requires secretKey to be configured.')
  }

  const apiBase = config.apiUrl?.trim() || CLERK_API_BASE_URL
  const response = await fetch(`${apiBase.replace(/\/$/, '')}/v1/sessions/${encodeURIComponent(sessionId)}/revoke`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${secretKey}`,
    },
  })
  if (!response.ok) {
    throw new Error(`[@holo-js/auth-clerk] Failed to revoke Clerk session "${sessionId}".`)
  }
}

export async function logoutWithClerk(
  input: ClerkRequestInput,
  options: {
    readonly provider?: string
    readonly returnTo?: string
  } = {},
): Promise<ClerkLogoutResult> {
  const request = normalizeClerkRequest(input)
  try {
    const providerConfig = getConfiguredProviderConfig(options.provider)
    const providerName = providerConfig.name
    const { guard } = resolveGuardAndProvider(providerName)
    const requestSessionId = getHoloSessionIdFromRequest(request)
    if (requestSessionId) {
      authRuntimeInternals.getRuntimeBindings().context.setSessionId(guard, requestSessionId)
    }
    const clerkSession = await readCurrentClerkLogoutSession(guard, providerName)
    if (!clerkSession) {
      return createHostedAuthFailure(
        'clerk_session_missing',
        'The current Holo session was not created by Clerk.',
        422,
      )
    }

    await revokeClerkSession(providerConfig, clerkSession.sessionId)
    const local = await getAuthRuntime().guard(guard).logout()
    return createHostedAuthSuccess(Object.freeze({
      url: createClerkReturnUrl(request, options.returnTo),
      local,
    } as const))
  } catch {
    return createHostedAuthFailure('clerk_logout_failed', 'Unable to complete Clerk logout.', 500)
  }
}

export async function completeClerkAuth<TUserAttributes extends ClerkUserAttributes = ClerkDefaultUserAttributes>(
  input: ClerkRequestInput,
  options: CompleteClerkAuthOptions<TUserAttributes> = {},
): Promise<ClerkCompleteAuthResult<TUserAttributes>> {
  try {
    const request = normalizeClerkRequest(input)
    const url = new URL(request.url)
    const callbackError = url.searchParams.get('error')?.trim()
    if (callbackError) {
      return createHostedAuthFailure(
        callbackError,
        url.searchParams.get('error_description')?.trim() || 'Clerk authentication failed.',
        422,
      )
    }

    const providerConfig = getConfiguredProviderConfig(options.provider)
    const session = await verifyRequest(request, providerConfig.name)
    if (!session) {
      return createHostedAuthFailure(
        'clerk_session_required',
        'Clerk callback did not include an active session.',
        422,
      )
    }

    const authenticated = await syncIdentity(session, providerConfig.name, {
      user: options.user,
    })
    const authSession = await authRuntimeInternals.establishSessionForUser(authenticated.user, {
      guard: authenticated.guard,
      provider: authenticated.authProvider,
      payload: createClerkSessionPayload(authenticated, session),
    })

    return createHostedAuthSuccess(Object.freeze({
      provider: authenticated.provider,
      guard: authenticated.guard,
      authProvider: authenticated.authProvider,
      status: authenticated.status,
      user: authenticated.user,
      identity: authenticated.identity,
      session,
      authSession,
    } as const))
  } catch (error) {
    if (authRuntimeInternals.isResponseInterrupt(error)) {
      throw error
    }

    return createHostedAuthFailure(
      error instanceof ClerkAuthConflictError ? error.code : 'clerk_auth_failed',
      getErrorMessage(error),
      error instanceof ClerkAuthConflictError ? 409 : 422,
    )
  }
}

export function configureClerkAuthRuntime(bindings?: ConfigureClerkAuthRuntimeOptions): void {
  const runtimeState = getRuntimeState()
  if (!bindings) {
    runtimeState.bindings = undefined
    return
  }

  runtimeState.bindings = Object.freeze({
    providers: bindings.providers ?? runtimeState.bindings?.providers,
    identityStore: bindings.identityStore ?? runtimeState.bindings?.identityStore,
  })
}

export function resetClerkAuthRuntime(): void {
  getRuntimeState().bindings = undefined
  clerkDefaultProviderRuntimeCache.clear()
}

export const clerkAuth = Object.freeze({
  authenticate,
  completeClerkAuth,
  loginWithClerk,
  logoutWithClerk,
  registerWithClerk,
  syncIdentity,
  verifyRequest,
  verifySession,
})

export const clerkAuthInternals = {
  getBindings,
  getConfiguredProviderConfig,
  getSessionTokenFromRequest,
  normalizeClerkUserProfile,
  normalizeHostedProfile,
  resolveConfiguredProviderName,
  resolveDisplayName,
  resolveEmailForCreation,
  resolveGuardAndProvider,
  resolvePrimaryEmail,
}
