import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { authRuntimeInternals } from '@holo-js/auth'
import type { AuthEstablishedSession, AuthUserLike } from '@holo-js/auth'
import { parseCookieHeader } from '@holo-js/session'
import type { AuthWorkosProviderConfig } from '@holo-js/config'
export {
  WorkosAuthConflictError,
} from './contracts'
export type {
  ConfigureWorkosAuthRuntimeOptions,
  HostedIdentityRecord,
  HostedIdentityStore,
  WorkosAuthBindings,
  WorkosAuthFacade,
  WorkosAuthenticationResult,
  WorkosIdentityProfile,
  WorkosProviderRuntime,
  WorkosSyncStatus,
  WorkosVerifiedSession,
  WorkosVerifyRequestContext,
  WorkosVerifySessionContext,
} from './contracts'
import {
  WorkosAuthConflictError,
  type ConfigureWorkosAuthRuntimeOptions,
  type HostedIdentityRecord,
  type WorkosAuthBindings,
  type WorkosAuthenticationResult,
  type WorkosIdentityProfile,
  type WorkosProviderRuntime,
  type WorkosVerifiedSession,
  type WorkosVerifySessionContext,
} from './contracts'

type JwkKey = Readonly<Record<string, unknown>> & {
  readonly kid?: string
}

type RuntimeAuthProviderAdapter = ReturnType<typeof authRuntimeInternals.getRuntimeBindings>['providers'][string]

let workosBindings: ConfigureWorkosAuthRuntimeOptions | undefined
const WORKOS_API_BASE_URL = 'https://api.workos.com'
const workosDefaultProviderRuntimeCache = new Map<string, WorkosProviderRuntime>()
const workosJwksCache = new Map<string, Promise<readonly JwkKey[]>>()
const AUTH_PROVIDER_MARKER = Symbol.for('holo-js.auth.provider')

function throwUnconfigured(): never {
  throw new Error('[@holo-js/auth-workos] WorkOS auth runtime is not configured yet.')
}

function getBindings(): WorkosAuthBindings {
  if (!workosBindings?.identityStore) {
    throwUnconfigured()
  }

  return {
    providers: workosBindings.providers ?? {},
    identityStore: workosBindings.identityStore,
  }
}

function decodeJwtSegment<T>(value: string, label: string): T {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T
  } catch {
    throw new Error(`[@holo-js/auth-workos] WorkOS token ${label} was not valid JSON.`)
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
    throw new Error('[@holo-js/auth-workos] WorkOS token was not a valid JWT.')
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
      throw new Error(`[@holo-js/auth-workos] Unsupported WorkOS JWT algorithm "${algorithm || 'unknown'}".`)
  }
}

async function fetchWorkosJwks(clientId: string, options: {
  readonly refresh?: boolean
} = {}): Promise<readonly JwkKey[]> {
  const normalizedClientId = clientId.trim()
  if (options.refresh) {
    workosJwksCache.delete(normalizedClientId)
  }
  const existing = workosJwksCache.get(normalizedClientId)
  if (existing) {
    return existing
  }

  const pending = (async () => {
    const response = await fetch(`${WORKOS_API_BASE_URL}/sso/jwks/${encodeURIComponent(normalizedClientId)}`, {
      headers: {
        accept: 'application/json',
      },
    })
    if (!response.ok) {
      throw new Error(`[@holo-js/auth-workos] Failed to load WorkOS JWKS for "${normalizedClientId}".`)
    }

    const payload = await response.json() as { keys?: readonly JwkKey[] }
    return payload.keys ?? []
  })()

  workosJwksCache.set(normalizedClientId, pending)
  try {
    return await pending
  } catch (error) {
    workosJwksCache.delete(normalizedClientId)
    throw error
  }
}

async function verifyWorkosSessionToken(
  token: string,
  config: AuthWorkosProviderConfig,
): Promise<Readonly<Record<string, unknown>>> {
  const clientId = config.clientId?.trim()
  if (!clientId) {
    throw new Error('[@holo-js/auth-workos] WorkOS verification requires clientId to be configured.')
  }

  const parsed = parseJwt(token)
  const headerKid = typeof parsed.header.kid === 'string' ? parsed.header.kid : undefined
  const resolveKey = async (refresh = false): Promise<JwkKey | undefined> => {
    const keys = await fetchWorkosJwks(clientId, { refresh })
    return headerKid
      ? keys.find(candidate => candidate.kid === headerKid)
      : keys[0]
  }

  let key = await resolveKey()
  if (!key || !verifyJwtSignatureWithJwk(parsed, key)) {
    key = await resolveKey(true)
  }
  if (!key || !verifyJwtSignatureWithJwk(parsed, key)) {
    throw new Error('[@holo-js/auth-workos] WorkOS token signature verification failed.')
  }

  const exp = typeof parsed.payload.exp === 'number' ? parsed.payload.exp : undefined
  if (typeof exp === 'number' && (exp * 1000) <= Date.now()) {
    throw new Error('[@holo-js/auth-workos] WorkOS token has expired.')
  }

  const nbf = typeof parsed.payload.nbf === 'number' ? parsed.payload.nbf : undefined
  if (typeof nbf === 'number' && (nbf * 1000) > Date.now()) {
    throw new Error('[@holo-js/auth-workos] WorkOS token is not valid yet.')
  }

  return parsed.payload
}

function normalizeWorkosUserProfile(user: Readonly<Record<string, unknown>>): WorkosIdentityProfile {
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
  const name = typeof user.name === 'string'
    ? user.name
    : [firstName, lastName].filter(Boolean).join(' ').trim() || undefined

  return Object.freeze({
    id: String(user.id ?? ''),
    email: typeof user.email === 'string' ? user.email : undefined,
    emailVerified: user.emailVerified === true || user.email_verified === true,
    firstName,
    lastName,
    name,
    avatar: typeof user.profilePictureUrl === 'string'
      ? user.profilePictureUrl
      : typeof user.profile_picture_url === 'string'
        ? user.profile_picture_url
        : undefined,
    organizationId: typeof user.organizationId === 'string'
      ? user.organizationId
      : typeof user.organization_id === 'string'
        ? user.organization_id
        : undefined,
    raw: user,
  })
}

async function fetchWorkosUserProfile(
  userId: string,
  config: AuthWorkosProviderConfig,
): Promise<WorkosIdentityProfile> {
  const apiKey = config.apiKey?.trim()
  if (!apiKey) {
    throw new Error('[@holo-js/auth-workos] WorkOS verification requires apiKey to be configured.')
  }

  const response = await fetch(`${WORKOS_API_BASE_URL}/user_management/users/${encodeURIComponent(userId)}`, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
  })
  if (!response.ok) {
    throw new Error(`[@holo-js/auth-workos] Failed to load WorkOS user "${userId}".`)
  }

  return normalizeWorkosUserProfile(await response.json() as Readonly<Record<string, unknown>>)
}

function createDefaultProviderRuntime(providerName: string, config: AuthWorkosProviderConfig): WorkosProviderRuntime {
  const cacheKey = JSON.stringify([
    providerName,
    config.clientId ?? '',
    config.apiKey ?? '',
  ])
  const existing = workosDefaultProviderRuntimeCache.get(cacheKey)
  if (existing) {
    return existing
  }

  const runtime = Object.freeze({
    async verifySession({ token }: WorkosVerifySessionContext): Promise<WorkosVerifiedSession | null> {
      const claims = await verifyWorkosSessionToken(token, config)
      const userId = typeof claims.sub === 'string' ? claims.sub : ''
      if (!userId) {
        throw new Error('[@holo-js/auth-workos] WorkOS token did not include a subject.')
      }

      const profile = await fetchWorkosUserProfile(userId, config)
      const sessionId = typeof claims.sid === 'string'
        ? claims.sid
        : typeof claims.session_id === 'string'
          ? claims.session_id
          : token

      return Object.freeze({
        sessionId,
        identity: profile,
        accessToken: token,
        expiresAt: typeof claims.exp === 'number' ? new Date(claims.exp * 1000) : undefined,
        raw: Object.freeze({
          claims,
          user: profile.raw,
        }),
      })
    },
  }) satisfies WorkosProviderRuntime

  workosDefaultProviderRuntimeCache.set(cacheKey, runtime)
  return runtime
}

function resolveConfiguredProviderName(provider?: string): string {
  const bindings = authRuntimeInternals.getRuntimeBindings()

  if (provider?.trim()) {
    return provider.trim()
  }

  const configuredProviders = Object.keys(bindings.config.workos)
  if (configuredProviders.length === 0) {
    return 'default'
  }

  if (configuredProviders.length === 1) {
    return configuredProviders[0]!
  }

  if (configuredProviders.includes('default')) {
    return 'default'
  }

  throw new Error('[@holo-js/auth-workos] WorkOS provider name is required when multiple auth.workos entries exist.')
}

function getConfiguredProviderConfig(provider?: string): {
  readonly name: string
  readonly clientId?: string
  readonly apiKey?: string
  readonly cookiePassword?: string
  readonly redirectUri?: string
  readonly sessionCookie: string
  readonly guard?: string
  readonly mapToProvider?: string
} {
  const providerName = resolveConfiguredProviderName(provider)
  const authBindings = authRuntimeInternals.getRuntimeBindings()
  const configured = authBindings.config.workos[providerName]
  if (!configured) {
    throw new Error(`[@holo-js/auth-workos] WorkOS provider "${providerName}" is not configured in auth.workos.`)
  }

  return {
    name: providerName,
    clientId: configured.clientId,
    apiKey: configured.apiKey,
    cookiePassword: configured.cookiePassword,
    redirectUri: configured.redirectUri,
    sessionCookie: configured.sessionCookie,
    guard: configured.guard,
    mapToProvider: configured.mapToProvider,
  }
}

function getProviderRuntime(provider?: string): WorkosProviderRuntime {
  const providerName = resolveConfiguredProviderName(provider)
  return getBindings().providers[providerName]
    ?? createDefaultProviderRuntime(providerName, getConfiguredProviderConfig(providerName))
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
    throw new Error(`[@holo-js/auth-workos] Guard "${guardName}" is not configured for WorkOS provider "${providerConfig.name}".`)
  }
  if (guard.driver !== 'session') {
    throw new Error(`[@holo-js/auth-workos] WorkOS sign-in requires auth guard "${guardName}" to use the session driver.`)
  }

  const authProvider = providerConfig.mapToProvider ?? guard.provider
  const adapter = authBindings.providers[authProvider]
  if (!adapter) {
    throw new Error(`[@holo-js/auth-workos] Auth provider runtime "${authProvider}" is not configured.`)
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

function serializeLocalUser(
  adapter: RuntimeAuthProviderAdapter,
  user: Record<string, unknown>,
  providerName: string,
): AuthUserLike {
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

function resolveDisplayName(profile: WorkosIdentityProfile): string | undefined {
  if (profile.name?.trim()) {
    return profile.name.trim()
  }

  const fullName = [profile.firstName?.trim(), profile.lastName?.trim()].filter(Boolean).join(' ').trim()
  return fullName || undefined
}

function resolveEmailForCreation(profile: WorkosIdentityProfile): string {
  const normalized = profile.email?.trim()
  if (normalized) {
    return normalized
  }

  return `${profile.id}@workos.hosted.local`
}

function normalizeHostedProfile(profile: WorkosIdentityProfile): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: profile.id,
    email: profile.email,
    emailVerified: profile.emailVerified === true,
    firstName: profile.firstName,
    lastName: profile.lastName,
    name: resolveDisplayName(profile),
    avatar: profile.avatar,
    organizationId: profile.organizationId,
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
    ? requireUserRecord(user, '[@holo-js/auth-workos] Auth provider lookups must return object users.')
    : null
}

async function updateLocalUser(
  adapter: RuntimeAuthProviderAdapter,
  user: Record<string, unknown>,
  input: {
    readonly name?: string
    readonly email?: string
    readonly avatar?: string
    readonly emailVerified?: boolean
  },
): Promise<{
  readonly user: Record<string, unknown>
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
      user: requireUserRecord(
        await adapter.update(user, nextInput),
        '[@holo-js/auth-workos] Auth provider updates must return object users.',
      ),
      changed: true,
    }
  }

  throw new Error(
    '[@holo-js/auth-workos] Auth provider adapters must implement update() to persist profile changes.',
  )
}

async function ensureNoUnexpectedEmailCollision(
  adapter: RuntimeAuthProviderAdapter,
  authProvider: string,
  profile: WorkosIdentityProfile,
  currentUserId: string | number,
): Promise<void> {
  const email = profile.email?.trim()
  if (!email) {
    return
  }

  const matched = await findUserByEmail(adapter, email)
  if (!matched) {
    return
  }

  if (
    requireUserId(
      adapter,
      matched,
      '[@holo-js/auth-workos] Matched local users must expose a serializable id.',
    ) !== currentUserId
  ) {
    throw new WorkosAuthConflictError({
      provider: 'workos',
      workosUserId: profile.id,
      email,
      message: `[@holo-js/auth-workos] WorkOS email "${email}" collides with a different local user.`,
    })
  }
}

async function assertUserLinkAvailable(
  providerName: string,
  authProvider: string,
  adapter: RuntimeAuthProviderAdapter,
  user: Record<string, unknown>,
  workosUserId: string,
): Promise<void> {
  const existing = await getBindings().identityStore.findByUserId(
    providerName,
    authProvider,
    requireUserId(adapter, user, '[@holo-js/auth-workos] Linked users must expose a serializable id.'),
  )
  if (existing && existing.providerUserId !== workosUserId) {
    throw new WorkosAuthConflictError({
      provider: providerName,
      workosUserId,
      email: existing.email,
      message: `[@holo-js/auth-workos] Local user is already linked to WorkOS identity "${existing.providerUserId}".`,
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
  readonly profile: WorkosIdentityProfile
  readonly previous?: HostedIdentityRecord
}): HostedIdentityRecord {
  const now = new Date()

  return Object.freeze({
    provider: input.provider,
    providerUserId: input.profile.id,
    guard: input.guard,
    authProvider: input.authProvider,
    userId: input.userId,
    email: input.profile.email,
    emailVerified: input.profile.emailVerified === true,
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
  authenticated: Pick<WorkosAuthenticationResult, 'guard' | 'authProvider' | 'user'>,
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

export async function verifySession(token: string, provider?: string): Promise<WorkosVerifiedSession | null> {
  const providerConfig = getConfiguredProviderConfig(provider)
  const runtime = getProviderRuntime(providerConfig.name)
  if (!runtime.verifySession) {
    throw new Error(`[@holo-js/auth-workos] WorkOS provider runtime "${providerConfig.name}" does not implement verifySession().`)
  }

  return runtime.verifySession({
    provider: providerConfig.name,
    token,
    config: providerConfig,
  })
}

export async function verifyRequest(request: Request, provider?: string): Promise<WorkosVerifiedSession | null> {
  const providerConfig = getConfiguredProviderConfig(provider)
  const runtime = getProviderRuntime(providerConfig.name)

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

  return verifySession(token, providerConfig.name)
}

export async function syncIdentity(
  session: WorkosVerifiedSession,
  provider?: string,
): Promise<WorkosAuthenticationResult> {
  const providerConfig = getConfiguredProviderConfig(provider)
  const providerName = providerConfig.name
  const profile = session.identity
  const { guard, authProvider, adapter } = resolveGuardAndProvider(providerName)
  const verificationRequired = isEmailVerificationRequired()
  const verifiedEmail = profile.emailVerified === true && profile.email?.trim()
    ? profile.email.trim()
    : undefined

  if (verificationRequired && !verifiedEmail) {
    throw new Error(`[@holo-js/auth-workos] WorkOS identity "${profile.id}" must provide a verified email address.`)
  }

  const identityStore = getBindings().identityStore
  const existingIdentity = await identityStore.findByProviderUserId(providerName, profile.id)

  if (existingIdentity) {
    const existingLinkedUser = await adapter.findById(existingIdentity.userId)
    let linkedUser = existingLinkedUser
      ? requireUserRecord(existingLinkedUser, '[@holo-js/auth-workos] Auth provider lookups must return object users.')
      : null

    if (!linkedUser) {
      linkedUser = verifiedEmail
        ? await findUserByEmail(adapter, verifiedEmail)
        : null

      if (linkedUser) {
        await assertUserLinkAvailable(providerName, authProvider, adapter, linkedUser, profile.id)
      }

      if (!linkedUser) {
        linkedUser = requireUserRecord(await adapter.create({
          name: resolveDisplayName(profile),
          email: resolveEmailForCreation(profile),
          password: null,
          avatar: profile.avatar ?? null,
          email_verified_at: profile.emailVerified === true ? new Date() : null,
        }), '[@holo-js/auth-workos] Auth provider create() must return an object user.')
      }

      const relinked = await updateLocalUser(adapter, linkedUser, {
        name: resolveDisplayName(profile),
        email: profile.email?.trim(),
        avatar: profile.avatar,
        emailVerified: profile.emailVerified === true,
      })
      const relinkedUser = relinked.user
      const identity = createIdentityRecord({
        provider: providerName,
        guard,
        authProvider,
        userId: requireUserId(
          adapter,
          relinkedUser,
          '[@holo-js/auth-workos] Relinked local users must expose a serializable id.',
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
        user: serializeLocalUser(adapter, relinkedUser, authProvider),
        identity,
        session,
      })
    }

    await ensureNoUnexpectedEmailCollision(
      adapter,
      authProvider,
      profile,
      requireUserId(
        adapter,
        linkedUser,
        '[@holo-js/auth-workos] Linked local users must expose a serializable id.',
      ),
    )
    const updated = await updateLocalUser(adapter, linkedUser, {
      name: resolveDisplayName(profile),
      email: profile.email?.trim(),
      avatar: profile.avatar,
      emailVerified: profile.emailVerified === true,
    })
    const identity = createIdentityRecord({
      provider: providerName,
      guard,
      authProvider,
      userId: requireUserId(
        adapter,
        updated.user,
        '[@holo-js/auth-workos] Updated local users must expose a serializable id.',
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
      email: profile.email?.trim(),
      avatar: profile.avatar,
      emailVerified: profile.emailVerified === true,
    })
    const identity = createIdentityRecord({
      provider: providerName,
      guard,
      authProvider,
      userId: requireUserId(
        adapter,
        linked.user,
        '[@holo-js/auth-workos] Linked local users must expose a serializable id.',
      ),
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

  localUser = requireUserRecord(await adapter.create({
    name: resolveDisplayName(profile),
    email: resolveEmailForCreation(profile),
    password: null,
    avatar: profile.avatar ?? null,
    email_verified_at: profile.emailVerified === true ? new Date() : null,
  }), '[@holo-js/auth-workos] Auth provider create() must return an object user.')
  const identity = createIdentityRecord({
    provider: providerName,
    guard,
    authProvider,
    userId: requireUserId(
      adapter,
      localUser,
      '[@holo-js/auth-workos] Created local users must expose a serializable id.',
    ),
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

export async function authenticate(request: Request, provider?: string): Promise<WorkosAuthenticationResult | null> {
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

export function configureWorkosAuthRuntime(bindings?: ConfigureWorkosAuthRuntimeOptions): void {
  if (!bindings) {
    workosBindings = undefined
    return
  }

  workosBindings = Object.freeze({
    providers: bindings.providers ?? workosBindings?.providers,
    identityStore: bindings.identityStore ?? workosBindings?.identityStore,
  })
}

export function resetWorkosAuthRuntime(): void {
  workosBindings = undefined
}

export const workosAuth = Object.freeze({
  authenticate,
  syncIdentity,
  verifyRequest,
  verifySession,
})

export const workosAuthInternals = {
  getBindings,
  getConfiguredProviderConfig,
  getSessionTokenFromRequest,
  normalizeHostedProfile,
  resolveConfiguredProviderName,
  resolveDisplayName,
  resolveEmailForCreation,
  resolveGuardAndProvider,
}
