import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { authRuntimeInternals } from '@holo-js/auth'
import type { AuthEstablishedSession } from '@holo-js/auth'
import { parseCookieHeader } from '@holo-js/session'
import type { AuthProviderAdapter, AuthUserLike } from '@holo-js/auth'
import type { AuthClerkProviderConfig } from '@holo-js/config'

export interface ClerkEmailAddress {
  readonly id?: string
  readonly emailAddress: string
  readonly verificationStatus?: 'verified' | 'unverified' | 'pending'
}

export interface ClerkUserProfile {
  readonly id: string
  readonly email?: string
  readonly emailVerified?: boolean
  readonly firstName?: string
  readonly lastName?: string
  readonly name?: string
  readonly imageUrl?: string
  readonly primaryEmailAddressId?: string
  readonly emailAddresses?: readonly ClerkEmailAddress[]
  readonly raw?: unknown
}

export interface ClerkVerifiedSession {
  readonly sessionId: string
  readonly user: ClerkUserProfile
  readonly actor?: {
    readonly id?: string
    readonly type?: string
  }
  readonly raw?: unknown
}

export interface ClerkVerifyRequestContext {
  readonly provider: string
  readonly request: Request
  readonly config: AuthClerkProviderConfig
}

export interface ClerkVerifySessionContext {
  readonly provider: string
  readonly token: string
  readonly config: AuthClerkProviderConfig
}

export interface ClerkProviderRuntime {
  verifyRequest?(context: ClerkVerifyRequestContext): Promise<ClerkVerifiedSession | null>
  verifySession?(context: ClerkVerifySessionContext): Promise<ClerkVerifiedSession | null>
}

type JwkKey = Readonly<Record<string, unknown>> & {
  readonly kid?: string
}

export interface HostedIdentityRecord {
  readonly provider: string
  readonly providerUserId: string
  readonly guard: string
  readonly authProvider: string
  readonly userId: string | number
  readonly email?: string
  readonly emailVerified: boolean
  readonly profile: Readonly<Record<string, unknown>>
  readonly linkedAt: Date
  readonly updatedAt: Date
}

export interface HostedIdentityStore {
  findByProviderUserId(provider: string, providerUserId: string): Promise<HostedIdentityRecord | null>
  findByUserId(provider: string, authProvider: string, userId: string | number): Promise<HostedIdentityRecord | null>
  save(record: HostedIdentityRecord): Promise<void>
}

export type ClerkSyncStatus = 'created' | 'updated' | 'linked' | 'relinked'

export interface ClerkAuthenticationResult {
  readonly provider: string
  readonly guard: string
  readonly authProvider: string
  readonly status: ClerkSyncStatus
  readonly user: AuthUserLike
  readonly identity: HostedIdentityRecord
  readonly session: ClerkVerifiedSession
  readonly authSession?: AuthEstablishedSession
}

export interface ClerkAuthBindings {
  readonly providers: Readonly<Record<string, ClerkProviderRuntime>>
  readonly identityStore: HostedIdentityStore
}

export interface ConfigureClerkAuthRuntimeOptions {
  readonly providers?: Readonly<Record<string, ClerkProviderRuntime>>
  readonly identityStore?: HostedIdentityStore
}

export interface ClerkAuthFacade {
  verifyRequest(request: Request, provider?: string): Promise<ClerkVerifiedSession | null>
  verifySession(token: string, provider?: string): Promise<ClerkVerifiedSession | null>
  syncIdentity(session: ClerkVerifiedSession, provider?: string): Promise<ClerkAuthenticationResult>
  authenticate(request: Request, provider?: string): Promise<ClerkAuthenticationResult | null>
}

export class ClerkAuthConflictError extends Error {
  readonly code = 'clerk_identity_conflict'
  readonly provider: string
  readonly clerkUserId: string
  readonly email?: string

  constructor(options: {
    readonly provider: string
    readonly clerkUserId: string
    readonly email?: string
    readonly message: string
  }) {
    super(options.message)
    this.name = 'ClerkAuthConflictError'
    this.provider = options.provider
    this.clerkUserId = options.clerkUserId
    this.email = options.email
  }
}

let clerkBindings: ConfigureClerkAuthRuntimeOptions | undefined
const CLERK_API_BASE_URL = 'https://api.clerk.com'
const clerkDefaultProviderRuntimeCache = new Map<string, ClerkProviderRuntime>()
const clerkJwksCache = new Map<string, Promise<readonly JwkKey[]>>()
const AUTH_PROVIDER_MARKER = Symbol.for('holo-js.auth.provider')

function throwUnconfigured(): never {
  throw new Error('[@holo-js/auth-clerk] Clerk auth runtime is not configured yet.')
}

function getBindings(): ClerkAuthBindings {
  if (!clerkBindings?.identityStore) {
    throwUnconfigured()
  }

  return {
    providers: clerkBindings.providers ?? {},
    identityStore: clerkBindings.identityStore,
  }
}

function decodeJwtSegment<T>(value: string, label: string): T {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T
  } catch {
    throw new Error(`[@holo-js/auth-clerk] Clerk token ${label} was not valid JSON.`)
  }
}

function parseJwt(token: string): {
  readonly header: Readonly<Record<string, unknown>>
  readonly payload: Readonly<Record<string, unknown>>
  readonly signature: Buffer
  readonly signingInput: Buffer
} {
  const segments = token.split('.')
  if (segments.length !== 3 || !segments[0] || !segments[1] || !segments[2]) {
    throw new Error('[@holo-js/auth-clerk] Clerk token was not a valid JWT.')
  }

  return {
    header: decodeJwtSegment<Readonly<Record<string, unknown>>>(segments[0], 'header'),
    payload: decodeJwtSegment<Readonly<Record<string, unknown>>>(segments[1], 'payload'),
    signature: Buffer.from(segments[2], 'base64url'),
    signingInput: Buffer.from(`${segments[0]}.${segments[1]}`, 'utf8'),
  }
}

function verifyJwtSignatureWithJwk(
  token: ReturnType<typeof parseJwt>,
  jwk: JwkKey,
): boolean {
  const algorithm = typeof token.header.alg === 'string' ? token.header.alg : ''
  const key = createPublicKey({ key: jwk as never, format: 'jwk' })

  switch (algorithm) {
    case 'RS256':
      return verifySignature('RSA-SHA256', token.signingInput, key, token.signature)
    case 'RS384':
      return verifySignature('RSA-SHA384', token.signingInput, key, token.signature)
    case 'RS512':
      return verifySignature('RSA-SHA512', token.signingInput, key, token.signature)
    default:
      throw new Error(`[@holo-js/auth-clerk] Unsupported Clerk JWT algorithm "${algorithm || 'unknown'}".`)
  }
}

function verifyJwtSignatureWithPem(
  token: ReturnType<typeof parseJwt>,
  pem: string,
): boolean {
  const algorithm = typeof token.header.alg === 'string' ? token.header.alg : ''
  const key = createPublicKey(pem.replace(/\\n/g, '\n'))

  switch (algorithm) {
    case 'RS256':
      return verifySignature('RSA-SHA256', token.signingInput, key, token.signature)
    case 'RS384':
      return verifySignature('RSA-SHA384', token.signingInput, key, token.signature)
    case 'RS512':
      return verifySignature('RSA-SHA512', token.signingInput, key, token.signature)
    default:
      throw new Error(`[@holo-js/auth-clerk] Unsupported Clerk JWT algorithm "${algorithm || 'unknown'}".`)
  }
}

function resolveClerkJwksUrl(config: AuthClerkProviderConfig): string {
  const frontendApi = config.frontendApi?.trim()
  if (frontendApi) {
    return `${frontendApi.replace(/\/$/, '')}/.well-known/jwks.json`
  }

  const apiUrl = config.apiUrl?.trim() || CLERK_API_BASE_URL
  return `${apiUrl.replace(/\/$/, '')}/v1/jwks`
}

async function fetchClerkJwks(jwksUrl: string, options: {
  readonly refresh?: boolean
} = {}): Promise<readonly JwkKey[]> {
  if (options.refresh) {
    clerkJwksCache.delete(jwksUrl)
  }
  const existing = clerkJwksCache.get(jwksUrl)
  if (existing) {
    return existing
  }

  const pending = (async () => {
    const response = await fetch(jwksUrl, {
      headers: {
        accept: 'application/json',
      },
    })
    if (!response.ok) {
      throw new Error(`[@holo-js/auth-clerk] Failed to load Clerk JWKS from "${jwksUrl}".`)
    }

    const payload = await response.json() as { keys?: readonly JwkKey[] }
    return payload.keys ?? []
  })()

  clerkJwksCache.set(jwksUrl, pending)
  try {
    return await pending
  } catch (error) {
    clerkJwksCache.delete(jwksUrl)
    throw error
  }
}

async function verifyClerkSessionToken(
  token: string,
  config: AuthClerkProviderConfig,
  authorizedParties: readonly string[] = [],
): Promise<Readonly<Record<string, unknown>>> {
  const parsed = parseJwt(token)
  const verified = (() => {
    const pem = config.jwtKey?.trim()
    if (pem) {
      return verifyJwtSignatureWithPem(parsed, pem)
    }

    return undefined
  })()

  if (verified === false) {
    throw new Error('[@holo-js/auth-clerk] Clerk token signature verification failed.')
  }

  if (typeof verified === 'undefined') {
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
  return Object.freeze({
    id: String(user.id ?? ''),
    email: typeof user.email === 'string' ? user.email : undefined,
    emailVerified: user.emailVerified === true || user.email_verified === true,
    firstName: typeof user.firstName === 'string'
      ? user.firstName
      : typeof user.first_name === 'string'
        ? user.first_name
        : undefined,
    lastName: typeof user.lastName === 'string'
      ? user.lastName
      : typeof user.last_name === 'string'
        ? user.last_name
        : undefined,
    name: typeof user.name === 'string' ? user.name : undefined,
    imageUrl: typeof user.imageUrl === 'string'
      ? user.imageUrl
      : typeof user.image_url === 'string'
        ? user.image_url
        : undefined,
    primaryEmailAddressId: typeof user.primaryEmailAddressId === 'string'
      ? user.primaryEmailAddressId
      : typeof user.primary_email_address_id === 'string'
        ? user.primary_email_address_id
        : undefined,
    emailAddresses: Array.isArray(user.emailAddresses)
      ? user.emailAddresses.map(entry => normalizeClerkEmailAddress(entry as Readonly<Record<string, unknown>>))
      : Array.isArray(user.email_addresses)
        ? user.email_addresses.map(entry => normalizeClerkEmailAddress(entry as Readonly<Record<string, unknown>>))
        : undefined,
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
    config.jwtKey ?? '',
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

  const configuredProviders = Object.keys(bindings.config.clerk)
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

function getConfiguredProviderConfig(provider?: string): {
  readonly name: string
  readonly publishableKey?: string
  readonly secretKey?: string
  readonly jwtKey?: string
  readonly apiUrl?: string
  readonly frontendApi?: string
  readonly sessionCookie: string
  readonly authorizedParties: readonly string[]
  readonly guard?: string
  readonly mapToProvider?: string
} {
  const providerName = resolveConfiguredProviderName(provider)
  const authBindings = authRuntimeInternals.getRuntimeBindings()
  const configured = authBindings.config.clerk[providerName]
  if (!configured) {
    throw new Error(`[@holo-js/auth-clerk] Clerk provider "${providerName}" is not configured in auth.clerk.`)
  }

  return {
    name: providerName,
    publishableKey: configured.publishableKey,
    secretKey: configured.secretKey,
    jwtKey: configured.jwtKey,
    apiUrl: configured.apiUrl,
    frontendApi: configured.frontendApi,
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

function resolveGuardAndProvider(provider?: string): {
  readonly guard: string
  readonly authProvider: string
  readonly adapter: AuthProviderAdapter
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

function serializeLocalUser(adapter: AuthProviderAdapter, user: unknown, providerName: string): AuthUserLike {
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

  return Object.freeze(result)
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

function resolveDisplayName(profile: ClerkUserProfile): string | undefined {
  if (profile.name?.trim()) {
    return profile.name.trim()
  }

  const fullName = [profile.firstName?.trim(), profile.lastName?.trim()].filter(Boolean).join(' ').trim()
  return fullName || undefined
}

function resolveEmailForCreation(profile: ClerkUserProfile): string {
  const primary = resolvePrimaryEmail(profile).email
  if (primary) {
    return primary
  }

  return `${profile.id}@clerk.hosted.local`
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
  adapter: AuthProviderAdapter,
  email: string | undefined,
): Promise<unknown | null> {
  if (!email?.trim()) {
    return null
  }

  return adapter.findByCredentials({ email: email.trim() })
}

async function updateLocalUser(
  adapter: AuthProviderAdapter,
  user: unknown,
  input: {
    readonly name?: string
    readonly email?: string
    readonly avatar?: string
    readonly emailVerified?: boolean
  },
): Promise<{
  readonly user: unknown
  readonly changed: boolean
}> {
  const nextInput = {
    name: input.name,
    email: input.email,
    avatar: typeof input.avatar === 'undefined' ? undefined : input.avatar,
    email_verified_at: input.emailVerified === true ? new Date() : undefined,
  }

  const current = user as {
    name?: string
    email?: string
    avatar?: string | null
    email_verified_at?: Date | string | null
  }

  const changed = (
    (typeof nextInput.name !== 'undefined' && nextInput.name !== current.name)
    || (typeof nextInput.email !== 'undefined' && nextInput.email !== current.email)
    || (typeof nextInput.avatar !== 'undefined' && nextInput.avatar !== (current.avatar ?? undefined))
    || (input.emailVerified === true && !current.email_verified_at)
  )

  if (!changed) {
    return { user, changed: false }
  }

  if (adapter.update) {
    return {
      user: await adapter.update(user, nextInput),
      changed: true,
    }
  }

  throw new Error(
    '[@holo-js/auth-clerk] Auth provider adapters must implement update() to persist profile changes.',
  )
}

async function ensureNoUnexpectedEmailCollision(
  adapter: AuthProviderAdapter,
  authProvider: string,
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

  if (adapter.getId(matched) !== currentUserId) {
    throw new ClerkAuthConflictError({
      provider: 'clerk',
      clerkUserId: profile.id,
      email: resolvedEmail,
      message: `[@holo-js/auth-clerk] Clerk email "${resolvedEmail}" collides with a different local user.`,
    })
  }
}

async function assertUserLinkAvailable(
  providerName: string,
  authProvider: string,
  adapter: AuthProviderAdapter,
  user: unknown,
  clerkUserId: string,
): Promise<void> {
  const existing = await getBindings().identityStore.findByUserId(providerName, authProvider, adapter.getId(user))
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
  authenticated: Pick<ClerkAuthenticationResult, 'guard' | 'authProvider' | 'user'>,
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

  bindings.context.setCachedUser(authenticated.guard, authenticated.user)
  return Object.freeze({
    guard: authenticated.guard,
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

export async function verifyRequest(request: Request, provider?: string): Promise<ClerkVerifiedSession | null> {
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

  const requestOrigin = new URL(request.url).origin
  const defaultRuntime = createDefaultProviderRuntime(providerConfig.name, {
    ...providerConfig,
    authorizedParties: Object.freeze([
      ...new Set([
        ...(providerConfig.authorizedParties ?? []),
        requestOrigin,
      ]),
    ]),
  })
  if (!defaultRuntime.verifySession) {
    throw new Error(`[@holo-js/auth-clerk] Clerk provider runtime "${providerConfig.name}" does not implement verifySession().`)
  }

  return defaultRuntime.verifySession({
    provider: providerConfig.name,
    token,
    config: {
      ...providerConfig,
      authorizedParties: Object.freeze([
        ...new Set([
          ...(providerConfig.authorizedParties ?? []),
          requestOrigin,
        ]),
      ]),
    },
  })
}

export async function syncIdentity(
  session: ClerkVerifiedSession,
  provider?: string,
): Promise<ClerkAuthenticationResult> {
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

  const identityStore = getBindings().identityStore
  const existingIdentity = await identityStore.findByProviderUserId(providerName, profile.id)

  if (existingIdentity) {
    let linkedUser = await adapter.findById(existingIdentity.userId)

    if (!linkedUser) {
      linkedUser = verifiedEmail
        ? await findUserByEmail(adapter, verifiedEmail)
        : null

      if (linkedUser) {
        await assertUserLinkAvailable(providerName, authProvider, adapter, linkedUser, profile.id)
      }

      if (!linkedUser) {
        linkedUser = await adapter.create({
          name: resolveDisplayName(profile),
          email: resolveEmailForCreation(profile),
          password: null,
          avatar: profile.imageUrl ?? null,
          email_verified_at: resolvedEmail.emailVerified ? new Date() : null,
        })
      }

      const relinked = await updateLocalUser(adapter, linkedUser, {
        name: resolveDisplayName(profile),
        email: resolvedEmail.email,
        avatar: profile.imageUrl,
        emailVerified: resolvedEmail.emailVerified,
      })
      const relinkedUser = relinked.user
      const identity = createIdentityRecord({
        provider: providerName,
        guard,
        authProvider,
        userId: adapter.getId(relinkedUser),
        profile,
        previous: existingIdentity,
      })
      await identityStore.save(identity)

      return Object.freeze({
        provider: providerName,
        guard,
        authProvider,
        status: 'relinked',
        user: serializeLocalUser(adapter, relinkedUser, authProvider),
        identity,
        session,
      })
    }

    await ensureNoUnexpectedEmailCollision(adapter, authProvider, profile, adapter.getId(linkedUser))
    const updated = await updateLocalUser(adapter, linkedUser, {
      name: resolveDisplayName(profile),
      email: resolvedEmail.email,
      avatar: profile.imageUrl,
      emailVerified: resolvedEmail.emailVerified,
    })
    const identity = createIdentityRecord({
      provider: providerName,
      guard,
      authProvider,
      userId: adapter.getId(updated.user),
      profile,
      previous: existingIdentity,
    })
    await identityStore.save(identity)

    return Object.freeze({
      provider: providerName,
      guard,
      authProvider,
      status: updated.changed ? 'updated' : 'linked',
      user: serializeLocalUser(adapter, updated.user, authProvider),
      identity,
      session,
    })
  }

  let localUser = verifiedEmail
    ? await findUserByEmail(adapter, verifiedEmail)
    : null

  if (localUser) {
    await assertUserLinkAvailable(providerName, authProvider, adapter, localUser, profile.id)
    const linked = await updateLocalUser(adapter, localUser, {
      name: resolveDisplayName(profile),
      email: resolvedEmail.email,
      avatar: profile.imageUrl,
      emailVerified: resolvedEmail.emailVerified,
    })
    const identity = createIdentityRecord({
      provider: providerName,
      guard,
      authProvider,
      userId: adapter.getId(linked.user),
      profile,
    })
    await identityStore.save(identity)

    return Object.freeze({
      provider: providerName,
      guard,
      authProvider,
      status: 'linked',
      user: serializeLocalUser(adapter, linked.user, authProvider),
      identity,
      session,
    })
  }

  localUser = await adapter.create({
    name: resolveDisplayName(profile),
    email: resolveEmailForCreation(profile),
    password: null,
    avatar: profile.imageUrl ?? null,
    email_verified_at: resolvedEmail.emailVerified ? new Date() : null,
  })
  const identity = createIdentityRecord({
    provider: providerName,
    guard,
    authProvider,
    userId: adapter.getId(localUser),
    profile,
  })
  await identityStore.save(identity)

  return Object.freeze({
    provider: providerName,
    guard,
    authProvider,
    status: 'created',
    user: serializeLocalUser(adapter, localUser, authProvider),
    identity,
    session,
  })
}

export async function authenticate(request: Request, provider?: string): Promise<ClerkAuthenticationResult | null> {
  const session = await verifyRequest(request, provider)
  if (!session) {
    return null
  }

  const authenticated = await syncIdentity(session, provider)
  const authSession = await reuseExistingHoloSession(request, authenticated)
    ?? await authRuntimeInternals.establishSessionForUser(authenticated.user, {
      guard: authenticated.guard,
      provider: authenticated.authProvider,
    })
  return Object.freeze({
    ...authenticated,
    authSession,
  })
}

export function configureClerkAuthRuntime(bindings?: ConfigureClerkAuthRuntimeOptions): void {
  if (!bindings) {
    clerkBindings = undefined
    return
  }

  clerkBindings = Object.freeze({
    providers: bindings.providers ?? clerkBindings?.providers,
    identityStore: bindings.identityStore ?? clerkBindings?.identityStore,
  })
}

export function resetClerkAuthRuntime(): void {
  clerkBindings = undefined
}

export const clerkAuth = Object.freeze({
  authenticate,
  syncIdentity,
  verifyRequest,
  verifySession,
})

export const clerkAuthInternals = {
  getBindings,
  getConfiguredProviderConfig,
  getSessionTokenFromRequest,
  normalizeHostedProfile,
  resolveConfiguredProviderName,
  resolveDisplayName,
  resolveEmailForCreation,
  resolveGuardAndProvider,
  resolvePrimaryEmail,
}
