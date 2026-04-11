import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { authRuntimeInternals } from '@holo-js/auth'
import type { AuthProviderAdapter, AuthUserLike } from '@holo-js/auth'
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

export interface SocialPendingStateRecord {
  readonly provider: string
  readonly state: string
  readonly codeVerifier: string
  readonly guard: string
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
  redirect(provider: string, request: Request): Promise<Response>
  callback(provider: string, request: Request): Promise<Response>
}

let socialBindings: SocialAuthBindings | undefined
const AUTH_PROVIDER_MARKER = Symbol.for('holo-js.auth.provider')

function throwUnconfigured(): never {
  throw new Error('[@holo-js/auth-social] Social auth runtime is not configured yet.')
}

function getBindings(): SocialAuthBindings {
  if (!socialBindings) {
    throwUnconfigured()
  }

  return socialBindings
}

function createState(): string {
  return randomBytes(24).toString('base64url')
}

function createCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

function createCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
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
  readonly adapter: AuthProviderAdapter
} {
  const authBindings = authRuntimeInternals.getRuntimeBindings()
  const providerConfig = getConfiguredProviderConfig(provider)
  const guardName = providerConfig.guard ?? authBindings.config.defaults.guard
  const guard = authBindings.config.guards[guardName]
  if (!guard) {
    throw new Error(`[@holo-js/auth-social] Guard "${guardName}" is not configured for social provider "${provider}".`)
  }
  if (guard.driver !== 'session') {
    throw new Error(`[@holo-js/auth-social] Social sign-in requires auth guard "${guardName}" to use the session driver.`)
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
  adapter: AuthProviderAdapter,
  user: unknown,
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

async function findUserByEmail(
  adapter: AuthProviderAdapter,
  email: string | undefined,
): Promise<unknown | null> {
  if (!email) {
    return null
  }

  return adapter.findByCredentials({ email })
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
  const { guard, authProvider, adapter } = resolveGuardAndProvider(provider)
  const existingIdentity = await bindings.identityStore.findByProviderUserId(provider, profile.id)
  const authBindings = authRuntimeInternals.getRuntimeBindings()
  const verificationRequired = authBindings.config.emailVerification.required === true

  if (existingIdentity) {
    const linkedUser = await adapter.findById(existingIdentity.userId)
    if (!linkedUser) {
      throw new Error(`[@holo-js/auth-social] Linked social identity "${provider}:${profile.id}" references a missing local user.`)
    }

    const serialized = serializeLocalUser(adapter, linkedUser, authProvider)
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
    return { guard, authProvider, user: serialized }
  }

  const hasVerifiedEmail = profile.emailVerified === true && typeof profile.email === 'string' && profile.email.trim().length > 0
  if (!hasVerifiedEmail && verificationRequired) {
    throw new Error(`[@holo-js/auth-social] Social sign-in with "${provider}" requires a verified email address.`)
  }

  const trustedEmail = hasVerifiedEmail ? profile.email?.trim() : undefined
  let localUser = await findUserByEmail(adapter, trustedEmail)
  if (!localUser) {
    localUser = await adapter.create({
      name: profile.name,
      email: resolveEmailForCreation(provider, profile, {
        trustEmail: hasVerifiedEmail,
      }),
      password: null,
      avatar: profile.avatar,
      email_verified_at: hasVerifiedEmail ? new Date() : null,
    })
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

export async function redirect(provider: string, request: Request): Promise<Response> {
  const providerConfig = getConfiguredProviderConfig(provider)
  const runtime = getProviderRuntime(provider)
  const { guard } = resolveGuardAndProvider(provider)
  const state = createState()
  const codeVerifier = createCodeVerifier()
  const codeChallenge = createCodeChallenge(codeVerifier)

  await getBindings().stateStore.create({
    provider,
    state,
    codeVerifier,
    guard,
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

  return new Response(null, {
    status: 302,
    headers: {
      location: authorizationUrl,
    },
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

export async function callback(provider: string, request: Request): Promise<Response> {
  const { state, code } = await readCallbackParameters(request)
  if (!state || !code) {
    return Response.json({
      message: 'Missing OAuth state or code.',
    }, { status: 400 })
  }

  const pending = await getBindings().stateStore.read(provider, state)
  if (!pending) {
    return Response.json({
      message: 'Invalid or expired OAuth state.',
    }, { status: 400 })
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
  const established = await authRuntimeInternals.establishSessionForUser(linked.user, {
    guard: linked.guard,
    provider: linked.authProvider,
  })
  const headers = new Headers()
  for (const cookie of established.cookies) {
    headers.append('set-cookie', cookie)
  }

  return Response.json({
    authenticated: true,
    guard: linked.guard,
    provider,
    user: linked.user,
  }, {
    status: 200,
    headers,
  })
}

export function configureSocialAuthRuntime(bindings?: SocialAuthBindings): void {
  socialBindings = bindings
}

export function resetSocialAuthRuntime(): void {
  socialBindings = undefined
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
