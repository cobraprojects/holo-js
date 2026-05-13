import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { authRuntimeInternals, getAuthRuntime } from '@holo-js/auth'
import type { AuthEstablishedSession, AuthUserLike } from '@holo-js/auth'
import { parseCookieHeader } from '@holo-js/session'
import type { NormalizedAuthWorkosProviderConfig } from '@holo-js/config'
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
  WorkosCompleteAuthResult,
  WorkosIdentityProfile,
  WorkosJsonValue,
  WorkosLogoutResult,
  WorkosLogoutSession,
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
  type WorkosCompleteAuthResult,
  type WorkosIdentityProfile,
  type WorkosJsonValue,
  type WorkosLogoutResult,
  type WorkosLogoutSession,
  type WorkosProviderRuntime,
  type WorkosVerifiedSession,
  type WorkosVerifySessionContext,
} from './contracts'

type JwkKey = Readonly<Record<string, unknown>> & {
  readonly kid?: string
}

type RuntimeAuthProviderAdapter = ReturnType<typeof authRuntimeInternals.getRuntimeBindings>['providers'][string]

type WorkosUserAttributeValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | readonly WorkosUserAttributeValue[]
  | { readonly [key: string]: WorkosUserAttributeValue }

type WorkosUserAttributes = Readonly<Record<string, WorkosUserAttributeValue>>

type WorkosDefaultUserAttributes = {
  readonly email: string
  readonly name: string
}

type CompleteWorkosAuthOptions<TUserAttributes extends WorkosUserAttributes = WorkosDefaultUserAttributes> = {
  readonly provider?: string
  readonly user?: (workosUser: WorkosIdentityProfile) => TUserAttributes
}

type WorkosRequestHeaders =
  | Headers
  | ReadonlyArray<readonly [string, string]>
  | Record<string, string | readonly string[] | undefined>
  | {
    readonly get?: (name: string) => string | null | undefined
    readonly forEach?: (callback: (value: string, key: string) => void) => void
    readonly entries?: () => Iterable<readonly [string, string]>
  }

type WorkosRequestLike = {
  readonly method?: string
  readonly path?: string
  readonly url?: string | URL
  readonly headers?: WorkosRequestHeaders
  readonly request?: Request
  readonly req?: Request | {
    readonly method?: string
    readonly url?: string
    readonly headers?: WorkosRequestHeaders
  }
  readonly node?: {
    readonly req?: {
      readonly method?: string
      readonly url?: string
      readonly headers?: WorkosRequestHeaders
    }
  }
  readonly web?: {
    readonly request?: Request
  }
}

type WorkosRequestInput = Request | WorkosRequestLike

type SerializedWorkosAuthUser = AuthUserLike & {
  readonly id: string | number
}

type WorkosSessionPayload = {
  readonly guard: string
  readonly provider: string
  readonly userId: string | number
  readonly user: SerializedWorkosAuthUser
  readonly workos: WorkosLogoutSession
}

interface WorkosRuntimeState {
  bindings?: ConfigureWorkosAuthRuntimeOptions
}

const WORKOS_RUNTIME_STATE_KEY = '__holoJsAuthWorkosRuntime'
const WORKOS_API_BASE_URL = 'https://api.workos.com'
const WORKOS_AUTHORIZE_URL = `${WORKOS_API_BASE_URL}/user_management/authorize`
const WORKOS_AUTHENTICATE_URL = `${WORKOS_API_BASE_URL}/user_management/authenticate`
const WORKOS_LOGOUT_URL = `${WORKOS_API_BASE_URL}/user_management/sessions/logout`
const workosDefaultProviderRuntimeCache = new Map<string, WorkosProviderRuntime>()
const workosJwksCache = new Map<string, Promise<readonly JwkKey[]>>()
const AUTH_PROVIDER_MARKER = Symbol.for('holo-js.auth.provider')

function getRuntimeState(): WorkosRuntimeState {
  const runtimeGlobal = globalThis as typeof globalThis & {
    [WORKOS_RUNTIME_STATE_KEY]?: WorkosRuntimeState
  }
  if (!runtimeGlobal[WORKOS_RUNTIME_STATE_KEY]) {
    Object.defineProperty(runtimeGlobal, WORKOS_RUNTIME_STATE_KEY, {
      value: {},
      enumerable: false,
      configurable: true,
      writable: true,
    })
  }

  return runtimeGlobal[WORKOS_RUNTIME_STATE_KEY]!
}

function throwUnconfigured(): never {
  throw new Error('[@holo-js/auth-workos] WorkOS auth runtime is not configured yet.')
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

function hasHeaderForEach(input: WorkosRequestHeaders): input is { readonly forEach: (callback: (value: string, key: string) => void) => void } {
  return !Array.isArray(input) && 'forEach' in input && typeof input.forEach === 'function'
}

function hasHeaderEntries(input: WorkosRequestHeaders): input is { readonly entries: () => Iterable<readonly [string, string]> } {
  return !Array.isArray(input) && 'entries' in input && typeof input.entries === 'function'
}

function hasHeaderGet(input: WorkosRequestHeaders): input is { readonly get: (name: string) => string | null | undefined } {
  return !Array.isArray(input) && 'get' in input && typeof input.get === 'function'
}

function normalizeRequestHeaders(input: WorkosRequestHeaders | undefined): Headers {
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

function getRequestFromLikeInput(input: WorkosRequestLike): Request | undefined {
  return input.request ?? input.web?.request ?? (input.req instanceof Request ? input.req : undefined)
}

function getRequestLikeHeaders(input: WorkosRequestLike) {
  return input.headers
    ?? (typeof input.req === 'object' && !(input.req instanceof Request) ? input.req.headers : undefined)
    ?? input.node?.req?.headers
}

function getRequestLikeMethod(input: WorkosRequestLike): string {
  return input.method
    ?? (typeof input.req === 'object' && !(input.req instanceof Request) ? input.req.method : undefined)
    ?? input.node?.req?.method
    ?? 'GET'
}

function getRequestLikeUrl(input: WorkosRequestLike, headers: Headers): string {
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

function normalizeWorkosRequest(input: WorkosRequestInput): Request {
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

function getBindings(): WorkosAuthBindings {
  const workosBindings = getRuntimeState().bindings
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

function getJwtStringClaim(token: string, claim: string): string | undefined {
  try {
    const value = parseJwt(token).payload[claim]
    return typeof value === 'string' && value.trim() ? value : undefined
  } catch {
    return undefined
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
  config: NormalizedAuthWorkosProviderConfig,
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

function toWorkosJsonValue(value: unknown): WorkosJsonValue | undefined {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value
  }

  if (Array.isArray(value)) {
    return value
      .map(item => toWorkosJsonValue(item))
      .filter((item): item is WorkosJsonValue => typeof item !== 'undefined')
  }

  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, toWorkosJsonValue(item)] as const)
        .filter((entry): entry is readonly [string, WorkosJsonValue] => typeof entry[1] !== 'undefined'),
    ))
  }

  return undefined
}

function toWorkosJsonObject(value: unknown): Readonly<Record<string, WorkosJsonValue>> {
  const normalized = toWorkosJsonValue(value)
  return normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized as Readonly<Record<string, WorkosJsonValue>>
    : Object.freeze({})
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
    : [firstName, lastName].filter(Boolean).join(' ').trim()
  const email = typeof user.email === 'string' ? user.email.trim() : ''

  return Object.freeze({
    id: String(user.id ?? ''),
    email,
    emailVerified: user.emailVerified === true || user.email_verified === true,
    firstName,
    lastName,
    name: name || email || String(user.id ?? ''),
    profilePictureUrl: typeof user.profilePictureUrl === 'string'
      ? user.profilePictureUrl
      : typeof user.profile_picture_url === 'string'
        ? user.profile_picture_url
        : undefined,
    externalId: typeof user.externalId === 'string'
      ? user.externalId
      : typeof user.external_id === 'string'
        ? user.external_id
        : undefined,
    organizationId: typeof user.organizationId === 'string'
      ? user.organizationId
      : typeof user.organization_id === 'string'
        ? user.organization_id
        : undefined,
    metadata: toWorkosJsonObject(user.metadata),
    createdAt: typeof user.createdAt === 'string'
      ? user.createdAt
      : typeof user.created_at === 'string'
        ? user.created_at
        : undefined,
    updatedAt: typeof user.updatedAt === 'string'
      ? user.updatedAt
      : typeof user.updated_at === 'string'
        ? user.updated_at
        : undefined,
    raw: toWorkosJsonObject(user),
  })
}

async function fetchWorkosUserProfile(
  userId: string,
  config: NormalizedAuthWorkosProviderConfig,
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

function createDefaultProviderRuntime(providerName: string, config: NormalizedAuthWorkosProviderConfig): WorkosProviderRuntime {
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

  const configuredDefaultProvider = typeof bindings.config.workos.provider === 'string'
    ? bindings.config.workos.provider.trim()
    : ''
  if (configuredDefaultProvider) {
    return configuredDefaultProvider
  }

  const configuredProviders = Object.entries(bindings.config.workos).flatMap(([name, value]) => (
    name !== 'provider' && typeof value === 'object' && value !== null
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

  throw new Error('[@holo-js/auth-workos] WorkOS provider name is required when multiple auth.workos entries exist.')
}

function getConfiguredProviderConfig(provider?: string): {
  readonly name: string
} & NormalizedAuthWorkosProviderConfig {
  const providerName = resolveConfiguredProviderName(provider)
  const authBindings = authRuntimeInternals.getRuntimeBindings()
  const configured = authBindings.config.workos[providerName]
  if (!configured || typeof configured !== 'object') {
    throw new Error(`[@holo-js/auth-workos] WorkOS provider "${providerName}" is not configured in auth.workos.`)
  }

  return {
    name: providerName,
    clientId: configured.clientId,
    apiKey: configured.apiKey,
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

function requireWorkosClientConfig(config: NormalizedAuthWorkosProviderConfig): {
  readonly clientId: string
  readonly apiKey: string
  readonly redirectUri: string
} {
  const clientId = config.clientId?.trim()
  const apiKey = config.apiKey?.trim()
  const redirectUri = config.redirectUri?.trim()
  if (!clientId) {
    throw new Error('[@holo-js/auth-workos] WorkOS AuthKit requires clientId to be configured.')
  }
  if (!apiKey) {
    throw new Error('[@holo-js/auth-workos] WorkOS AuthKit requires apiKey to be configured.')
  }
  if (!redirectUri) {
    throw new Error('[@holo-js/auth-workos] WorkOS AuthKit requires redirectUri to be configured.')
  }

  return { clientId, apiKey, redirectUri }
}

function createAuthorizationUrl(config: NormalizedAuthWorkosProviderConfig, screenHint: 'sign-in' | 'sign-up'): string {
  const { clientId, redirectUri } = requireWorkosClientConfig(config)
  const url = new URL(WORKOS_AUTHORIZE_URL)
  url.searchParams.set('provider', 'authkit')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('screen_hint', screenHint)

  return url.toString()
}

function createLogoutUrl(sessionId: string, request: Request, returnTo?: string): string {
  const url = new URL(WORKOS_LOGOUT_URL)
  url.searchParams.set('session_id', sessionId)
  if (returnTo?.trim()) {
    url.searchParams.set('return_to', new URL(returnTo, request.url).toString())
  }

  return url.toString()
}

function createWorkosErrorResponse(error: unknown, code: string): Response {
  return Response.json({
    ok: false,
    code,
    message: getErrorMessage(error),
  } as const, {
    status: error instanceof WorkosAuthConflictError ? 409 : 422,
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

function requireSerializedUser(user: AuthUserLike, message: string): SerializedWorkosAuthUser {
  if (typeof user.id === 'string' || typeof user.id === 'number') {
    return user as SerializedWorkosAuthUser
  }

  throw new Error(message)
}

function createWorkosSessionPayload(
  authenticated: Pick<WorkosAuthenticationResult, 'guard' | 'authProvider' | 'provider' | 'user'>,
  session: WorkosVerifiedSession,
): WorkosSessionPayload {
  const user = requireSerializedUser(
    authenticated.user,
    '[@holo-js/auth-workos] WorkOS-authenticated local users must expose a serializable id.',
  )

  return Object.freeze({
    guard: authenticated.guard,
    provider: authenticated.authProvider,
    userId: user.id,
    user,
    workos: Object.freeze({
      provider: authenticated.provider,
      sessionId: session.sessionId,
    }),
  })
}

function getWorkosLogoutSession(payload: unknown, providerName: string): WorkosLogoutSession | null {
  if (!payload || typeof payload !== 'object' || !('workos' in payload)) {
    return null
  }

  const workos = (payload as { readonly workos?: unknown }).workos
  if (!workos || typeof workos !== 'object') {
    return null
  }

  const provider = (workos as { readonly provider?: unknown }).provider
  const sessionId = (workos as { readonly sessionId?: unknown }).sessionId
  if (provider !== providerName || typeof sessionId !== 'string' || !sessionId.trim()) {
    return null
  }

  return Object.freeze({
    provider,
    sessionId,
  })
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

function resolveDisplayName(profile: WorkosIdentityProfile): string {
  if (typeof profile.name === 'string' && profile.name.trim()) {
    return profile.name.trim()
  }

  const fullName = [profile.firstName?.trim(), profile.lastName?.trim()].filter(Boolean).join(' ').trim()
  return fullName || profile.email || profile.id
}

function resolveEmailForCreation(profile: WorkosIdentityProfile): string {
  const normalized = typeof profile.email === 'string' ? profile.email.trim() : ''
  if (normalized) {
    return normalized
  }

  return `${profile.id}@workos.hosted.local`
}

function toAdapterInput(input: WorkosUserAttributes): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(input).filter((entry) => typeof entry[1] !== 'undefined'),
  ))
}

function withRequiredUserFields(input: WorkosUserAttributes, profile: WorkosIdentityProfile): WorkosUserAttributes {
  return Object.freeze({
    ...input,
    email: typeof input.email === 'undefined' ? resolveEmailForCreation(profile) : input.email,
    name: typeof input.name === 'undefined' ? resolveDisplayName(profile) : input.name,
  })
}

function resolveCreateUserInput<TUserAttributes extends WorkosUserAttributes>(
  profile: WorkosIdentityProfile,
  mapper?: (workosUser: WorkosIdentityProfile) => TUserAttributes,
): Readonly<Record<string, unknown>> {
  return toAdapterInput(withRequiredUserFields({
    password: null,
    avatar: profile.profilePictureUrl ?? null,
    email_verified_at: profile.emailVerified ? new Date() : null,
    ...(mapper?.(profile) ?? {}),
  }, profile))
}

function resolveUpdateUserInput<TUserAttributes extends WorkosUserAttributes>(
  profile: WorkosIdentityProfile,
  mapper?: (workosUser: WorkosIdentityProfile) => TUserAttributes,
): Readonly<Record<string, unknown>> {
  return toAdapterInput(withRequiredUserFields({
    email: typeof profile.email === 'string' ? profile.email.trim() || undefined : undefined,
    avatar: profile.profilePictureUrl,
    email_verified_at: profile.emailVerified ? new Date() : undefined,
    ...(mapper?.(profile) ?? {}),
  }, profile))
}

function normalizeHostedProfile(profile: WorkosIdentityProfile): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: profile.id,
    email: profile.email,
    emailVerified: profile.emailVerified === true,
    firstName: profile.firstName,
    lastName: profile.lastName,
    name: resolveDisplayName(profile),
    profilePictureUrl: profile.profilePictureUrl,
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
  const email = typeof profile.email === 'string' ? profile.email.trim() : ''
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
  authenticated: Pick<WorkosAuthenticationResult, 'guard' | 'authProvider' | 'provider' | 'user'>,
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
    readonly workos?: {
      readonly provider?: unknown
    }
  }
  if (source.workos && typeof source.workos === 'object') {
    if (typeof source.workos.provider !== 'string' || source.workos.provider !== authenticated.provider) {
      return null
    }
  }

  bindings.context.setCachedUser(authenticated.guard, authenticated.user)
  return Object.freeze({
    guard: authenticated.guard,
    provider: source.workos && typeof source.workos === 'object' ? 'workos' : payload.provider,
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

export async function verifyRequest(input: WorkosRequestInput, provider?: string): Promise<WorkosVerifiedSession | null> {
  const request = normalizeWorkosRequest(input)
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

function getStringField(input: Readonly<Record<string, unknown>>, ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = input[name]
    const normalized = typeof value === 'string' ? value.trim() : ''
    if (normalized) {
      return normalized
    }
  }

  return undefined
}

function getRecordField(input: Readonly<Record<string, unknown>>, name: string): Readonly<Record<string, unknown>> | undefined {
  const value = input[name]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function getRequestIpAddress(request: Request): string | undefined {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || undefined
}

async function authenticateWorkosCode(
  request: Request,
  code: string,
  config: NormalizedAuthWorkosProviderConfig,
): Promise<WorkosVerifiedSession> {
  const { clientId, apiKey } = requireWorkosClientConfig(config)
  const body = {
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: apiKey,
    code,
    ip_address: getRequestIpAddress(request),
    user_agent: request.headers.get('user-agent')?.trim() || undefined,
  }

  const response = await fetch(WORKOS_AUTHENTICATE_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json() as Readonly<Record<string, unknown>>
  if (!response.ok) {
    const message = getStringField(payload, 'message', 'error_description', 'error')
      ?? `WorkOS callback authentication failed with status ${response.status}.`
    throw new Error(message)
  }

  const user = getRecordField(payload, 'user')
  if (!user) {
    throw new Error('[@holo-js/auth-workos] WorkOS callback did not return a user.')
  }

  const accessToken = getStringField(payload, 'accessToken', 'access_token')
  const session = getRecordField(payload, 'session')
  const sessionId = getStringField(session ?? {}, 'id')
    ?? getStringField(payload, 'sessionId', 'session_id')
    ?? (accessToken ? getJwtStringClaim(accessToken, 'sid') : undefined)
    ?? accessToken
    ?? code

  return Object.freeze({
    sessionId,
    identity: normalizeWorkosUserProfile({
      ...user,
      organizationId: getStringField(payload, 'organizationId', 'organization_id') ?? user.organizationId ?? user.organization_id,
    }),
    accessToken,
    raw: toWorkosJsonObject(payload),
  })
}

export async function syncIdentity(
  session: WorkosVerifiedSession,
  provider?: string,
  options: {
    readonly user?: (workosUser: WorkosIdentityProfile) => WorkosUserAttributes
  } = {},
): Promise<WorkosAuthenticationResult> {
  const providerConfig = getConfiguredProviderConfig(provider)
  const providerName = providerConfig.name
  const profile = session.identity
  const { guard, authProvider, adapter } = resolveGuardAndProvider(providerName)
  const verificationRequired = isEmailVerificationRequired()
  const profileEmail = typeof profile.email === 'string' ? profile.email.trim() : ''
  const verifiedEmail = profile.emailVerified === true && profileEmail
    ? profileEmail
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
        linkedUser = requireUserRecord(
          await adapter.create(resolveCreateUserInput(profile, options.user)),
          '[@holo-js/auth-workos] Auth provider create() must return an object user.',
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
    const updated = await updateLocalUser(adapter, linkedUser, resolveUpdateUserInput(profile, options.user))
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
    const linked = await updateLocalUser(adapter, localUser, resolveUpdateUserInput(profile, options.user))
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

  localUser = requireUserRecord(
    await adapter.create(resolveCreateUserInput(profile, options.user)),
    '[@holo-js/auth-workos] Auth provider create() must return an object user.',
  )
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

export async function authenticate(input: WorkosRequestInput, provider?: string): Promise<WorkosAuthenticationResult | null> {
  const request = normalizeWorkosRequest(input)
  const session = await verifyRequest(request, provider)
  if (!session) {
    return null
  }

  const authenticated = await syncIdentity(session, provider)
  const authSession = await reuseExistingHoloSession(request, authenticated)
    ?? await authRuntimeInternals.establishSessionForUser(authenticated.user, {
      guard: authenticated.guard,
      provider: authenticated.authProvider,
      payload: createWorkosSessionPayload(authenticated, session),
    })
  return Object.freeze({
    ...authenticated,
    authSession,
  })
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'WorkOS authentication failed.'
}

export async function loginWithWorkos(
  _input: WorkosRequestInput,
  options: {
    readonly provider?: string
  } = {},
): Promise<Response> {
  try {
    const providerConfig = getConfiguredProviderConfig(options.provider)
    return Response.redirect(createAuthorizationUrl(providerConfig, 'sign-in'), 302)
  } catch (error) {
    return createWorkosErrorResponse(error, 'workos_login_failed')
  }
}

export async function registerWithWorkos(
  _input: WorkosRequestInput,
  options: {
    readonly provider?: string
  } = {},
): Promise<Response> {
  try {
    const providerConfig = getConfiguredProviderConfig(options.provider)
    return Response.redirect(createAuthorizationUrl(providerConfig, 'sign-up'), 302)
  } catch (error) {
    return createWorkosErrorResponse(error, 'workos_register_failed')
  }
}

async function readCurrentWorkosLogoutSession(guard: string, providerName: string): Promise<WorkosLogoutSession | null> {
  const bindings = authRuntimeInternals.getRuntimeBindings()
  const sessionId = bindings.context.getSessionId(guard)
  if (!sessionId) {
    return null
  }

  const record = await bindings.session.read(sessionId)
  return getWorkosLogoutSession(authRuntimeInternals.readSessionPayload(record, guard), providerName)
}

export async function logoutWithWorkos(
  input: WorkosRequestInput,
  options: {
    readonly provider?: string
    readonly returnTo?: string
  } = {},
): Promise<WorkosLogoutResult> {
  const request = normalizeWorkosRequest(input)
  try {
    const providerConfig = getConfiguredProviderConfig(options.provider)
    const providerName = providerConfig.name
    const { guard } = resolveGuardAndProvider(providerName)
    const requestSessionId = getHoloSessionIdFromRequest(request)
    if (requestSessionId) {
      authRuntimeInternals.getRuntimeBindings().context.setSessionId(guard, requestSessionId)
    }
    const workosSession = await readCurrentWorkosLogoutSession(guard, providerName)
    if (!workosSession) {
      return Object.freeze({
        ok: false,
        code: 'workos_session_missing',
        message: 'The current Holo session was not created by WorkOS.',
      } as const)
    }

    const local = await getAuthRuntime().guard(guard).logout()
    return Object.freeze({
      ok: true,
      url: createLogoutUrl(workosSession.sessionId, request, options.returnTo),
      local,
    } as const)
  } catch (error) {
    return Object.freeze({
      ok: false,
      code: 'workos_logout_failed',
      message: getErrorMessage(error),
    } as const)
  }
}

export async function completeWorkosAuth<TUserAttributes extends WorkosUserAttributes = WorkosDefaultUserAttributes>(
  input: WorkosRequestInput,
  options: CompleteWorkosAuthOptions<TUserAttributes> = {},
): Promise<WorkosCompleteAuthResult> {
  try {
    const request = normalizeWorkosRequest(input)
    const url = new URL(request.url)
    const callbackError = url.searchParams.get('error')?.trim()
    if (callbackError) {
      return Object.freeze({
        ok: false,
        code: callbackError,
        message: url.searchParams.get('error_description')?.trim() || 'WorkOS authentication failed.',
      } as const)
    }

    const code = url.searchParams.get('code')?.trim()
    if (!code) {
      return Object.freeze({
        ok: false,
        code: 'workos_code_required',
        message: 'WorkOS callback did not include an authorization code.',
      } as const)
    }

    const providerConfig = getConfiguredProviderConfig(options.provider)
    const session = await authenticateWorkosCode(request, code, providerConfig)
    const authenticated = await syncIdentity(session, providerConfig.name, {
      user: options.user,
    })
    const authSession = await authRuntimeInternals.establishSessionForUser(authenticated.user, {
      guard: authenticated.guard,
      provider: authenticated.authProvider,
      payload: createWorkosSessionPayload(authenticated, session),
    })

    return Object.freeze({
      ok: true,
      provider: authenticated.provider,
      guard: authenticated.guard,
      authProvider: authenticated.authProvider,
      status: authenticated.status,
      user: authenticated.user,
      identity: authenticated.identity,
      session,
      authSession,
    } as const)
  } catch (error) {
    return Object.freeze({
      ok: false,
      code: error instanceof WorkosAuthConflictError ? error.code : 'workos_auth_failed',
      message: getErrorMessage(error),
    } as const)
  }
}

export function configureWorkosAuthRuntime(bindings?: ConfigureWorkosAuthRuntimeOptions): void {
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

export function resetWorkosAuthRuntime(): void {
  getRuntimeState().bindings = undefined
  workosDefaultProviderRuntimeCache.clear()
  workosJwksCache.clear()
}

export const workosAuth = Object.freeze({
  authenticate,
  completeWorkosAuth,
  loginWithWorkos,
  logoutWithWorkos,
  registerWithWorkos,
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
