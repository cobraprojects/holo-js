import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { authRuntimeInternals } from '@holo-js/auth'
import type { AuthUserLike } from '@holo-js/auth'
import type { AuthSocialProviderConfig } from '@holo-js/config'

export interface SocialProviderProfile {
  readonly id: string
  readonly email?: string
  readonly emailVerified?: boolean
  readonly name?: string
  readonly avatar?: string
}

export interface SocialProviderTokens {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt?: Date
  readonly [key: string]: unknown
}

export interface SocialRedirectContext {
  readonly provider: string
  readonly request: Request
  readonly state: string
  readonly codeVerifier: string
  readonly codeChallenge: string
  readonly config: AuthSocialProviderConfig
}

export interface SocialCallbackContext {
  readonly provider: string
  readonly request: Request
  readonly code: string
  readonly codeVerifier: string
  readonly config: AuthSocialProviderConfig
}

export interface SocialProviderRuntime {
  buildAuthorizationUrl(context: SocialRedirectContext): Promise<string> | string
  exchangeCode(context: SocialCallbackContext): Promise<{
    readonly profile: SocialProviderProfile
    readonly tokens: SocialProviderTokens
  }>
}

export type SocialRequestHeaders =
  | Headers
  | ReadonlyArray<readonly [string, string]>
  | Record<string, string | readonly string[] | undefined>
  | {
    readonly get?: (name: string) => string | null | undefined
    readonly forEach?: (callback: (value: string, key: string) => void) => void
    readonly entries?: () => Iterable<readonly [string, string]>
  }

export type SocialRequestLike = {
  readonly method?: string
  readonly path?: string
  readonly url?: string | URL
  readonly headers?: SocialRequestHeaders
  readonly request?: Request
  readonly req?: Request | {
    readonly method?: string
    readonly url?: string
    readonly headers?: SocialRequestHeaders
  }
  readonly node?: {
    readonly req?: {
      readonly method?: string
      readonly url?: string
      readonly headers?: SocialRequestHeaders
    }
  }
  readonly web?: {
    readonly request?: Request
  }
}

export type SocialRequestInput = Request | SocialRequestLike

export interface SocialPendingStateRecord {
  readonly provider: string
  readonly state: string
  readonly codeVerifier: string
  readonly guard: string
  readonly browserBinding?: string
  readonly createdAt: Date
}

export interface SocialPendingStateStore {
  create(record: SocialPendingStateRecord): Promise<void>
  read(provider: string, state: string): Promise<SocialPendingStateRecord | null>
  delete(provider: string, state: string): Promise<void>
}

export interface SocialIdentityRecord {
  readonly provider: string
  readonly providerUserId: string
  readonly guard: string
  readonly authProvider: string
  readonly userId: string | number
  readonly email?: string
  readonly emailVerified: boolean
  readonly profile: Readonly<Record<string, unknown>>
  readonly tokens?: unknown
  readonly linkedAt: Date
  readonly updatedAt: Date
}

export interface SocialIdentityStore {
  findByProviderUserId(provider: string, providerUserId: string): Promise<SocialIdentityRecord | null>
  save(record: SocialIdentityRecord): Promise<void>
}

export interface SocialAuthBindings {
  readonly providers: Readonly<Record<string, SocialProviderRuntime>>
  readonly stateStore: SocialPendingStateStore
  readonly identityStore: SocialIdentityStore
  readonly encryptionKey?: string
}

export interface SocialAuthFacade {
  redirect(provider: string, request: SocialRequestInput): Promise<Response>
  callback(provider: string, request: SocialRequestInput): Promise<SocialCallbackResult>
}

export type SocialCallbackResult = SocialCallbackSuccess | SocialCallbackFailure

export interface SocialCallbackSuccess {
  readonly ok: true
  readonly guard: string
  readonly authProvider: string
  readonly provider: string
  readonly user: AuthUserLike
}

export interface SocialCallbackFailure {
  readonly ok: false
  readonly status: 400
  readonly message: string
}

const SOCIAL_BINDINGS_KEY = '__holoAuthSocialBindings__'
const AUTH_PROVIDER_MARKER = Symbol.for('holo-js.auth.provider')
const GET_ONLY_REQUEST_HEADER_NAMES = ['authorization', 'cookie', 'host', 'x-forwarded-host', 'x-forwarded-proto'] as const
type RuntimeAuthProviderAdapter = ReturnType<typeof authRuntimeInternals.getRuntimeBindings>['providers'][string]
type SocialRuntimeGlobal = typeof globalThis & {
  [SOCIAL_BINDINGS_KEY]?: SocialAuthBindings
}

function getSocialRuntimeGlobal(): SocialRuntimeGlobal {
  return globalThis as SocialRuntimeGlobal
}

function isPlainHeaderRecord(value: unknown): value is Record<string, string | readonly string[] | undefined> {
  return Boolean(value) && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
}

// Header-like objects that only expose get() cannot be enumerated. OAuth needs only auth, cookie, host, and forwarded
// host/proto metadata here; every other header is ignored unless this input path grows full iteration support.
function appendKnownHeaders(headers: Headers, input: { readonly get?: (name: string) => string | null | undefined }): void {
  for (const name of GET_ONLY_REQUEST_HEADER_NAMES) {
    const value = input.get?.(name)
    if (typeof value === 'string' && value) {
      headers.set(name, value)
    }
  }
}

function hasHeaderForEach(input: SocialRequestHeaders): input is { readonly forEach: (callback: (value: string, key: string) => void) => void } {
  return !Array.isArray(input) && 'forEach' in input && typeof input.forEach === 'function'
}

function hasHeaderEntries(input: SocialRequestHeaders): input is { readonly entries: () => Iterable<readonly [string, string]> } {
  return !Array.isArray(input) && 'entries' in input && typeof input.entries === 'function'
}

function hasHeaderGet(input: SocialRequestHeaders): input is { readonly get: (name: string) => string | null | undefined } {
  return !Array.isArray(input) && 'get' in input && typeof input.get === 'function'
}

function normalizeRequestHeaders(input: SocialRequestHeaders | undefined): Headers {
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

function getRequestFromLikeInput(input: SocialRequestLike): Request | undefined {
  return input.request ?? input.web?.request ?? (input.req instanceof Request ? input.req : undefined)
}

function getRequestLikeHeaders(input: SocialRequestLike): SocialRequestHeaders | undefined {
  return input.headers
    ?? (typeof input.req === 'object' && !(input.req instanceof Request) ? input.req.headers : undefined)
    ?? input.node?.req?.headers
}

function getRequestLikeMethod(input: SocialRequestLike): string {
  return input.method
    ?? (typeof input.req === 'object' && !(input.req instanceof Request) ? input.req.method : undefined)
    ?? input.node?.req?.method
    ?? 'GET'
}

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production'
}

function createRelativeRequestBaseUrl(headers: Headers): string {
  const forwardedProtocol = headers.get('x-forwarded-proto')
  const forwardedHost = headers.get('x-forwarded-host')
  if (isProductionRuntime() && (!forwardedProtocol || !forwardedHost)) {
    throw new Error('[@holo-js/auth-social] Relative request URLs require x-forwarded-proto and x-forwarded-host headers in production.')
  }

  const protocol = forwardedProtocol ?? 'http'
  const host = forwardedHost ?? headers.get('host') ?? 'localhost'
  return `${protocol}://${host}`
}

function getRequestLikeUrl(input: SocialRequestLike, headers: Headers): string {
  const url = (typeof input.url === 'string' ? input.url : input.url?.toString())
    ?? (typeof input.req === 'object' && !(input.req instanceof Request) ? input.req.url : undefined)
    ?? input.node?.req?.url
    ?? input.path
    ?? '/'

  try {
    return new URL(url).toString()
  } catch {
    return new URL(url, createRelativeRequestBaseUrl(headers)).toString()
  }
}

function normalizeSocialRequest(input: SocialRequestInput): Request {
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

function requireUserRecord(user: unknown, message: string): Record<string, unknown> {
  if (user == null) {
    throw new Error(message)
  }

  if (typeof user !== 'object') {
    throw new Error(message)
  }

  return user as Record<string, unknown>
}

function resolveUserRecord(user: unknown, message: string): Record<string, unknown> | null {
  if (user == null) {
    return null
  }

  return requireUserRecord(user, message)
}

function requireUserId(
  adapter: RuntimeAuthProviderAdapter,
  user: unknown,
  message: string,
): string | number {
  const userRecord = requireUserRecord(user, message)
  const userId = adapter.getId(userRecord)

  if (typeof userId === 'string') {
    const normalized = userId.trim()
    if (!normalized) {
      throw new Error(message)
    }

    return normalized
  }

  if (typeof userId === 'number' && Number.isFinite(userId)) {
    return userId
  }

  throw new Error(message)
}

function throwUnconfigured(): never {
  throw new Error('[@holo-js/auth-social] Social auth runtime is not configured yet.')
}

function getBindings(): SocialAuthBindings {
  const socialBindings = getSocialRuntimeGlobal()[SOCIAL_BINDINGS_KEY]
  if (!socialBindings) {
    throwUnconfigured()
  }

  return socialBindings
}

function createState(): string {
  return randomBytes(24).toString('base64url')
}

function createBrowserBindingNonce(): string {
  return createState()
}

function hashBrowserBinding(nonce: string): string {
  return createHash('sha256').update(nonce).digest('base64url')
}

function createCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

function createCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function getStateCookieName(provider: string): string {
  const suffix = provider.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `holo_oauth_state_${suffix}`
}

function serializeStateCookie(provider: string, state: string, nonce: string, request: Request): string {
  const secure = new URL(request.url).protocol === 'https:'
  const attributes = [
    `${getStateCookieName(provider)}=${state}.${nonce}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=600',
  ]
  if (secure) {
    attributes.push('Secure')
  }

  return attributes.join('; ')
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie')
  if (!header) {
    return undefined
  }

  for (const entry of header.split(';')) {
    const separatorIndex = entry.indexOf('=')
    if (separatorIndex < 0) {
      continue
    }

    const cookieName = entry.slice(0, separatorIndex).trim()
    if (cookieName !== name) {
      continue
    }

    return entry.slice(separatorIndex + 1).trim()
  }

  return undefined
}

function readStateCookie(request: Request, provider: string): { readonly state: string, readonly nonce: string } | null {
  const value = readCookie(request, getStateCookieName(provider))
  if (!value) {
    return null
  }

  const separatorIndex = value.indexOf('.')
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return null
  }

  return {
    state: value.slice(0, separatorIndex),
    nonce: value.slice(separatorIndex + 1),
  }
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function verifyBrowserBinding(
  provider: string,
  state: string,
  pending: SocialPendingStateRecord,
  request: Request,
): boolean {
  if (!pending.browserBinding) {
    return false
  }

  const cookie = readStateCookie(request, provider)
  if (!cookie || cookie.state !== state) {
    return false
  }

  return timingSafeStringEqual(hashBrowserBinding(cookie.nonce), pending.browserBinding)
}

function encryptTokens(value: unknown, encryptionKey?: string): unknown {
  if (typeof encryptionKey !== 'string' || !encryptionKey.trim()) {
    throw new Error('[@holo-js/auth-social] encryptionKey is required when encryptTokens is enabled.')
  }

  const key = createHash('sha256').update(encryptionKey).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const payload = Buffer.from(JSON.stringify(value), 'utf8')
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()])
  const tag = cipher.getAuthTag()

  return {
    iv: iv.toString('base64url'),
    tag: tag.toString('base64url'),
    ciphertext: encrypted.toString('base64url'),
  }
}

export function decryptTokens(value: unknown, encryptionKey: string): unknown {
  if (
    !value
    || typeof value !== 'object'
    || !('iv' in value)
    || !('tag' in value)
    || !('ciphertext' in value)
  ) {
    return value
  }

  const record = value as { iv: string, tag: string, ciphertext: string }
  const key = createHash('sha256').update(encryptionKey).digest()
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(record.tag, 'base64url'))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(record.ciphertext, 'base64url')),
    decipher.final(),
  ])
  return JSON.parse(decrypted.toString('utf8')) as unknown
}

function getConfiguredProviderConfig(provider: string): {
  readonly name: string
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
  readonly scopes: readonly string[]
  readonly guard?: string
  readonly mapToProvider?: string
  readonly encryptTokens: boolean
} {
  const authBindings = authRuntimeInternals.getRuntimeBindings()
  const configured = authBindings.config.social[provider]
  if (!configured) {
    throw new Error(`[@holo-js/auth-social] Social provider "${provider}" is not configured in auth.social.`)
  }

  return {
    name: provider,
    clientId: configured.clientId ?? '',
    clientSecret: configured.clientSecret ?? '',
    redirectUri: configured.redirectUri ?? '',
    scopes: [...(configured.scopes ?? [])],
    guard: configured.guard,
    mapToProvider: configured.mapToProvider,
    encryptTokens: configured.encryptTokens,
  }
}

function getProviderRuntime(provider: string): SocialProviderRuntime {
  const runtime = getBindings().providers[provider]
  if (!runtime) {
    throw new Error(`[@holo-js/auth-social] Social provider runtime "${provider}" is not configured.`)
  }

  return runtime
}

function resolveGuardAndProvider(provider: string): {
  readonly guard: string
  readonly authProvider: string
  readonly adapter: RuntimeAuthProviderAdapter
} {
  const authBindings = authRuntimeInternals.getRuntimeBindings()
  const providerConfig = getConfiguredProviderConfig(provider)
  const guardName = providerConfig.guard ?? authBindings.config.defaults.guard
  const guard = authBindings.config.guards[guardName]
  if (!guard) {
    throw new Error(`[@holo-js/auth-social] Guard "${guardName}" is not configured for social provider "${provider}".`)
  }

  const authProvider = providerConfig.mapToProvider ?? guard.provider
  const adapter = authBindings.providers[authProvider]
  if (!adapter) {
    throw new Error(`[@holo-js/auth-social] Auth provider runtime "${authProvider}" is not configured.`)
  }

  return {
    guard: guardName,
    authProvider,
    adapter,
  }
}

function serializeLocalUser(
  adapter: RuntimeAuthProviderAdapter,
  user: Record<string, unknown>,
  providerName: string,
): AuthUserLike {
  const id = requireUserId(
    adapter,
    user,
    '[@holo-js/auth-social] Auth provider users must resolve to a non-empty string or numeric id.',
  )
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

async function findUserByEmail(
  adapter: RuntimeAuthProviderAdapter,
  email: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (!email) {
    return null
  }

  const user = await adapter.findByCredentials({ email })
  return resolveUserRecord(user, '[@holo-js/auth-social] Auth provider lookups must return object users.')
}

function resolveEmailForCreation(
  provider: string,
  profile: SocialProviderProfile,
  options: { readonly trustEmail?: boolean } = {},
): string {
  const normalized = options.trustEmail === false
    ? undefined
    : profile.email?.trim()
  if (normalized) {
    return normalized
  }

  return `${profile.id}@${provider}.social.local`
}

async function resolveLinkedUser(
  provider: string,
  profile: SocialProviderProfile,
  tokens: SocialProviderTokens,
): Promise<{
  readonly guard: string
  readonly authProvider: string
  readonly user: AuthUserLike
}> {
  const bindings = getBindings()
  const existingIdentity = await bindings.identityStore.findByProviderUserId(provider, profile.id)
  const authBindings = authRuntimeInternals.getRuntimeBindings()
  const verificationRequired = authBindings.config.emailVerification.required === true

  if (existingIdentity) {
    if (!authBindings.config.guards[existingIdentity.guard]) {
      throw new Error(`[@holo-js/auth-social] Guard "${existingIdentity.guard}" is not configured for linked social identity "${provider}:${profile.id}".`)
    }

    const storedAdapter = authBindings.providers[existingIdentity.authProvider]
    if (!storedAdapter) {
      throw new Error(`[@holo-js/auth-social] Auth provider runtime "${existingIdentity.authProvider}" is not configured for linked social identity "${provider}:${profile.id}".`)
    }

    const linkedUser = resolveUserRecord(
      await storedAdapter.findById(existingIdentity.userId),
      `[@holo-js/auth-social] Linked social identity "${provider}:${profile.id}" references a missing local user.`,
    )
    if (!linkedUser) {
      throw new Error(`[@holo-js/auth-social] Linked social identity "${provider}:${profile.id}" references a missing local user.`)
    }

    const serialized = serializeLocalUser(storedAdapter, linkedUser, existingIdentity.authProvider)
    await bindings.identityStore.save({
      ...existingIdentity,
      email: profile.email,
      emailVerified: profile.emailVerified === true,
      profile: {
        id: profile.id,
        email: profile.email,
        name: profile.name,
        avatar: profile.avatar,
      },
      tokens: getConfiguredProviderConfig(provider).encryptTokens
        ? encryptTokens(tokens, bindings.encryptionKey)
        : tokens,
      updatedAt: new Date(),
    })
    return {
      guard: existingIdentity.guard,
      authProvider: existingIdentity.authProvider,
      user: serialized,
    }
  }

  const { guard, authProvider, adapter } = resolveGuardAndProvider(provider)
  const hasVerifiedEmail = profile.emailVerified === true && typeof profile.email === 'string' && profile.email.trim().length > 0
  if (!hasVerifiedEmail && verificationRequired) {
    throw new Error(`[@holo-js/auth-social] Social sign-in with "${provider}" requires a verified email address.`)
  }

  const trustedEmail = hasVerifiedEmail ? profile.email?.trim() : undefined
  let localUser = await findUserByEmail(adapter, trustedEmail)
  if (!localUser) {
    localUser = requireUserRecord(await adapter.create({
      name: profile.name,
      email: resolveEmailForCreation(provider, profile, {
        trustEmail: hasVerifiedEmail,
      }),
      password: null,
      avatar: profile.avatar,
      email_verified_at: hasVerifiedEmail ? new Date() : null,
    }), '[@holo-js/auth-social] Auth provider create() must return an object user.')
  }

  const serialized = serializeLocalUser(adapter, localUser, authProvider)
  await bindings.identityStore.save({
    provider,
    providerUserId: profile.id,
    guard,
    authProvider,
    userId: serialized.id!,
    email: profile.email,
    emailVerified: profile.emailVerified === true,
    profile: {
      id: profile.id,
      email: profile.email,
      name: profile.name,
      avatar: profile.avatar,
    },
    tokens: getConfiguredProviderConfig(provider).encryptTokens
      ? encryptTokens(tokens, bindings.encryptionKey)
      : tokens,
    linkedAt: new Date(),
    updatedAt: new Date(),
  })

  return {
    guard,
    authProvider,
    user: serialized,
  }
}

export async function redirect(provider: string, input: SocialRequestInput): Promise<Response> {
  const request = normalizeSocialRequest(input)
  const providerConfig = getConfiguredProviderConfig(provider)
  const runtime = getProviderRuntime(provider)
  const { guard } = resolveGuardAndProvider(provider)
  const state = createState()
  const browserNonce = createBrowserBindingNonce()
  const codeVerifier = createCodeVerifier()
  const codeChallenge = createCodeChallenge(codeVerifier)

  await getBindings().stateStore.create({
    provider,
    state,
    codeVerifier,
    guard,
    browserBinding: hashBrowserBinding(browserNonce),
    createdAt: new Date(),
  })

  const authorizationUrl = await runtime.buildAuthorizationUrl({
    provider,
    request,
    state,
    codeVerifier,
    codeChallenge,
    config: providerConfig,
  })

  const headers = new Headers({
    location: authorizationUrl,
  })
  headers.append('set-cookie', serializeStateCookie(provider, state, browserNonce, request))

  return new Response(null, {
    status: 302,
    headers,
  })
}

async function readCallbackParameters(request: Request): Promise<{
  readonly state?: string
  readonly code?: string
}> {
  const url = new URL(request.url)
  const queryState = url.searchParams.get('state')?.trim()
  const queryCode = url.searchParams.get('code')?.trim()
  if (queryState && queryCode) {
    return {
      state: queryState,
      code: queryCode,
    }
  }

  if (request.method.toUpperCase() !== 'POST') {
    return {
      state: queryState,
      code: queryCode,
    }
  }

  const formData = await request.clone().formData().catch(() => undefined)
  const stateValue = formData?.get('state')
  const codeValue = formData?.get('code')
  const formState = typeof stateValue === 'string'
    ? stateValue.trim()
    : undefined
  const formCode = typeof codeValue === 'string'
    ? codeValue.trim()
    : undefined

  return {
    state: formState ?? queryState,
    code: formCode ?? queryCode,
  }
}

export async function callback(provider: string, input: SocialRequestInput): Promise<SocialCallbackResult> {
  const request = normalizeSocialRequest(input)
  const { state, code } = await readCallbackParameters(request)
  if (!state || !code) {
    return {
      ok: false,
      status: 400,
      message: 'Missing OAuth state or code.',
    }
  }

  const pending = await getBindings().stateStore.read(provider, state)
  if (!pending) {
    return {
      ok: false,
      status: 400,
      message: 'Invalid or expired OAuth state.',
    }
  }

  if (!verifyBrowserBinding(provider, state, pending, request)) {
    return {
      ok: false,
      status: 400,
      message: 'Invalid or expired OAuth state.',
    }
  }

  await getBindings().stateStore.delete(provider, state)
  const runtime = getProviderRuntime(provider)
  const providerConfig = getConfiguredProviderConfig(provider)

  const exchanged = await runtime.exchangeCode({
    provider,
    request,
    code,
    codeVerifier: pending.codeVerifier,
    config: providerConfig,
  })

  const linked = await resolveLinkedUser(provider, exchanged.profile, exchanged.tokens)

  return {
    ok: true,
    guard: linked.guard,
    authProvider: linked.authProvider,
    provider,
    user: linked.user,
  }
}

export function configureSocialAuthRuntime(bindings?: SocialAuthBindings): void {
  getSocialRuntimeGlobal()[SOCIAL_BINDINGS_KEY] = bindings
}

export function resetSocialAuthRuntime(): void {
  delete getSocialRuntimeGlobal()[SOCIAL_BINDINGS_KEY]
}

export const socialAuth = Object.freeze({
  redirect,
  callback,
})

export const socialAuthInternals = {
  createCodeChallenge,
  createCodeVerifier,
  createState,
  decryptTokens,
  encryptTokens,
  getBindings,
  resolveEmailForCreation,
  resolveLinkedUser,
}
