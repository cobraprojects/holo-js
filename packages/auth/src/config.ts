export type AuthGuardDriver = 'session' | 'token'

declare module '@holo-js/config' {
  interface HoloConfigRegistry {
    auth: NormalizedHoloAuthConfig
  }
}

export interface AuthGuardConfig {
  readonly driver: AuthGuardDriver
  readonly provider?: string
}

export interface AuthProviderConfig {
  readonly model: string
  readonly identifiers?: readonly string[]
}

export interface AuthPasswordBrokerConfig {
  readonly provider?: string
  readonly table?: string
  readonly expire?: number | string
  readonly throttle?: number | string
  readonly route?: string
}

export interface AuthEmailVerificationConfig {
  readonly required?: boolean
  readonly route?: string
}

export interface AuthMultiFactorConfiguration {
  readonly issuer?: string
  readonly challengeRoute?: string
  readonly enrollmentTtl?: number | string
  readonly challengeTtl?: number | string
  readonly recoveryCodes?: number
  readonly allowedDriftSteps?: number
}

export interface AuthPersonalAccessTokenConfig {
  readonly defaultAbilities?: readonly string[]
}

export interface AuthSocialProviderConfig {
  readonly runtime?: string
  readonly clientId?: string
  readonly clientSecret?: string
  readonly redirectUri?: string
  readonly scopes?: readonly string[]
  readonly guard?: string
  readonly mapToProvider?: string
  readonly encryptTokens?: boolean
}

export interface AuthWorkosProviderConfig {
  readonly clientId?: string
  readonly apiKey?: string
  readonly redirectUri?: string
  readonly guard?: string
  readonly mapToProvider?: string
}

export interface AuthHostedIdentityRecord {
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

export interface AuthHostedIdentityStore {
  findByProviderUserId(provider: string, providerUserId: string): Promise<AuthHostedIdentityRecord | null>
  findByUserId(provider: string, authProvider: string, userId: string | number): Promise<AuthHostedIdentityRecord | null>
  claim?(record: AuthHostedIdentityRecord): Promise<AuthHostedIdentityRecord>
  save(record: AuthHostedIdentityRecord): Promise<void>
}

export interface HoloAuthWorkosConfig {
  readonly provider?: string
  readonly identityStore?: AuthHostedIdentityStore
  readonly [provider: string]: AuthHostedIdentityStore | AuthWorkosProviderConfig | string | undefined
}

export interface AuthClerkProviderConfig {
  readonly publishableKey?: string
  readonly secretKey?: string
  readonly apiUrl?: string
  readonly frontendApi?: string
  readonly redirectUri?: string
  readonly sessionCookie?: string
  readonly authorizedParties?: readonly string[]
  readonly guard?: string
  readonly mapToProvider?: string
}

export interface HoloAuthClerkConfig {
  readonly provider?: string
  readonly identityStore?: AuthHostedIdentityStore
  readonly [provider: string]: AuthHostedIdentityStore | AuthClerkProviderConfig | string | undefined
}

export interface HoloAuthConfig {
  readonly defaults?: {
    readonly guard?: string
    readonly passwords?: string
  }
  readonly guards?: Readonly<Record<string, AuthGuardConfig>>
  readonly providers?: Readonly<Record<string, AuthProviderConfig>>
  readonly passwords?: Readonly<Record<string, AuthPasswordBrokerConfig>>
  readonly emailVerification?: boolean | AuthEmailVerificationConfig
  readonly multiFactor?: boolean | AuthMultiFactorConfiguration
  readonly personalAccessTokens?: AuthPersonalAccessTokenConfig
  readonly socialEncryptionKey?: string
  readonly social?: Readonly<Record<string, AuthSocialProviderConfig>>
  readonly workos?: HoloAuthWorkosConfig
  readonly clerk?: HoloAuthClerkConfig
}

export interface NormalizedAuthGuardConfig {
  readonly name: string
  readonly driver: AuthGuardDriver
  readonly provider: string
}

export interface NormalizedAuthProviderConfig {
  readonly name: string
  readonly model: string
  readonly identifiers: readonly string[]
}

export interface NormalizedAuthPasswordBrokerConfig {
  readonly name: string
  readonly provider: string
  readonly table: string
  readonly expire: number
  readonly throttle: number
  readonly route: string
}

export interface NormalizedAuthSocialProviderConfig {
  readonly name: string
  readonly runtime?: string
  readonly clientId?: string
  readonly clientSecret?: string
  readonly redirectUri?: string
  readonly scopes: readonly string[]
  readonly guard?: string
  readonly mapToProvider?: string
  readonly encryptTokens: boolean
}

export interface NormalizedAuthWorkosProviderConfig {
  readonly name: string
  readonly clientId?: string
  readonly apiKey?: string
  readonly redirectUri?: string
  readonly sessionCookie: string
  readonly guard?: string
  readonly mapToProvider?: string
}

export interface NormalizedHoloAuthWorkosConfig {
  readonly provider?: string
  readonly identityStore?: AuthHostedIdentityStore
  readonly [provider: string]: AuthHostedIdentityStore | NormalizedAuthWorkosProviderConfig | string | undefined
}

export interface NormalizedAuthClerkProviderConfig {
  readonly name: string
  readonly publishableKey?: string
  readonly secretKey?: string
  readonly apiUrl?: string
  readonly frontendApi?: string
  readonly redirectUri?: string
  readonly sessionCookie: string
  readonly authorizedParties: readonly string[]
  readonly guard?: string
  readonly mapToProvider?: string
}

export interface NormalizedHoloAuthClerkConfig {
  readonly provider?: string
  readonly identityStore?: AuthHostedIdentityStore
  readonly [provider: string]: AuthHostedIdentityStore | NormalizedAuthClerkProviderConfig | string | undefined
}

export interface NormalizedHoloAuthConfig {
  readonly defaults: {
    readonly guard: string
    readonly passwords: string
  }
  readonly guards: Readonly<Record<string, NormalizedAuthGuardConfig>>
  readonly providers: Readonly<Record<string, NormalizedAuthProviderConfig>>
  readonly passwords: Readonly<Record<string, NormalizedAuthPasswordBrokerConfig>>
  readonly emailVerification: {
    readonly required: boolean
    readonly route: string
  }
  readonly multiFactor: {
    readonly enabled: boolean
    readonly issuer: string
    readonly challengeRoute: string
    readonly enrollmentTtl: number
    readonly challengeTtl: number
    readonly recoveryCodes: number
    readonly allowedDriftSteps: number
  }
  readonly personalAccessTokens: {
    readonly defaultAbilities: readonly string[]
  }
  readonly socialEncryptionKey?: string
  readonly social: Readonly<Record<string, NormalizedAuthSocialProviderConfig>>
  readonly workos: NormalizedHoloAuthWorkosConfig
  readonly clerk: NormalizedHoloAuthClerkConfig
}

export const DEFAULT_AUTH_GUARD = 'web'
export const DEFAULT_AUTH_PROVIDER = 'users'
export const DEFAULT_AUTH_IDENTIFIERS = Object.freeze(['email'] as const)
export const DEFAULT_AUTH_PASSWORD_BROKER = 'users'
export const DEFAULT_AUTH_PASSWORD_RESET_TABLE = 'password_reset_tokens'
export const DEFAULT_AUTH_PASSWORD_EXPIRE = 60
export const DEFAULT_AUTH_PASSWORD_THROTTLE = 60
export const DEFAULT_AUTH_PASSWORD_RESET_ROUTE = '/reset-password'
export const DEFAULT_AUTH_EMAIL_VERIFICATION_ROUTE = '/verify-email'
export const DEFAULT_AUTH_MULTI_FACTOR_CHALLENGE_ROUTE = '/mfa-challenge'
export const DEFAULT_WORKOS_SESSION_COOKIE = 'wos-session'
export const DEFAULT_CLERK_SESSION_COOKIE = '__session'

export const holoAuthDefaults: Readonly<NormalizedHoloAuthConfig> = Object.freeze({
  defaults: Object.freeze({
    guard: DEFAULT_AUTH_GUARD,
    passwords: DEFAULT_AUTH_PASSWORD_BROKER,
  }),
  guards: Object.freeze({
    web: Object.freeze({
      name: 'web',
      driver: 'session' as const,
      provider: DEFAULT_AUTH_PROVIDER,
    }),
  }),
  providers: Object.freeze({
    users: Object.freeze({
      name: 'users',
      model: 'User',
      identifiers: DEFAULT_AUTH_IDENTIFIERS,
    }),
  }),
  passwords: Object.freeze({
    users: Object.freeze({
      name: 'users',
      provider: DEFAULT_AUTH_PROVIDER,
      table: DEFAULT_AUTH_PASSWORD_RESET_TABLE,
      expire: DEFAULT_AUTH_PASSWORD_EXPIRE,
      throttle: DEFAULT_AUTH_PASSWORD_THROTTLE,
      route: DEFAULT_AUTH_PASSWORD_RESET_ROUTE,
    }),
  }),
  emailVerification: Object.freeze({
    required: false,
    route: DEFAULT_AUTH_EMAIL_VERIFICATION_ROUTE,
  }),
  multiFactor: Object.freeze({
    enabled: false,
    issuer: 'Holo',
    challengeRoute: DEFAULT_AUTH_MULTI_FACTOR_CHALLENGE_ROUTE,
    enrollmentTtl: 600,
    challengeTtl: 300,
    recoveryCodes: 8,
    allowedDriftSteps: 1,
  }),
  personalAccessTokens: Object.freeze({
    defaultAbilities: Object.freeze(['*']),
  }),
  socialEncryptionKey: undefined,
  social: Object.freeze({}),
  workos: Object.freeze({}),
  clerk: Object.freeze({}),
})

function normalizeNonEmptyString(value: string | undefined, label: string): string {
  const normalized = value?.trim()
  if (!normalized) throw new Error(label)
  return normalized
}

function normalizeConnectionName(value: string | undefined, namespace: string, label: string): string {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`[${namespace}] ${label} must be a non-empty string.`)
  return normalized
}

function parseInteger(
  value: number | string | undefined,
  fallback: number,
  namespace: string,
  label: string,
  options: { readonly minimum?: number } = {},
): number {
  const normalized = typeof value === 'undefined'
    ? fallback
    : typeof value === 'number'
      ? value
      : value.trim()
        ? Number.parseInt(value, 10)
        : Number.NaN
  if (!Number.isFinite(normalized) || !Number.isInteger(normalized)) throw new Error(`[${namespace}] ${label} must be an integer.`)
  if (typeof options.minimum === 'number' && normalized < options.minimum) {
    throw new Error(`[${namespace}] ${label} must be greater than or equal to ${options.minimum}.`)
  }
  return normalized
}

function normalizeAuthProvider(
  name: string,
  config: AuthProviderConfig,
): NormalizedAuthProviderConfig {
  const identifiers = Object.freeze(
    Array.from(new Set((config.identifiers ?? DEFAULT_AUTH_IDENTIFIERS)
      .map(value => normalizeNonEmptyString(value, `[Holo Auth] provider "${name}" identifier entries must be non-empty strings.`)))),
  )

  if (identifiers.length === 0) {
    throw new Error(`[Holo Auth] provider "${name}" must declare at least one identifier.`)
  }

  return Object.freeze({
    name,
    model: normalizeNonEmptyString(config.model, `[Holo Auth] provider "${name}" model must be a non-empty string.`),
    identifiers,
  })
}

function normalizeAuthGuard(
  name: string,
  config: AuthGuardConfig,
  providers: Readonly<Record<string, NormalizedAuthProviderConfig>>,
): NormalizedAuthGuardConfig {
  /* v8 ignore next -- straightforward provider default normalization */
  const provider = config.provider?.trim() || DEFAULT_AUTH_PROVIDER
  if (!(provider in providers)) {
    throw new Error(`[Holo Auth] guard "${name}" references unknown provider "${provider}".`)
  }

  if (config.driver !== 'session' && config.driver !== 'token') {
    throw new Error(`[Holo Auth] Unsupported auth guard driver "${String((config as { driver?: unknown }).driver)}" on guard "${name}".`)
  }

  return Object.freeze({
    name,
    driver: config.driver,
    provider,
  })
}

function normalizePasswordBroker(
  name: string,
  config: AuthPasswordBrokerConfig,
  providers: Readonly<Record<string, NormalizedAuthProviderConfig>>,
): NormalizedAuthPasswordBrokerConfig {
  /* v8 ignore next -- straightforward provider default normalization */
  const provider = config.provider?.trim() || DEFAULT_AUTH_PROVIDER
  if (!(provider in providers)) {
    throw new Error(`[Holo Auth] password broker "${name}" references unknown provider "${provider}".`)
  }

  /* v8 ignore start -- straightforward trimming/default mapping for provider config */
  return Object.freeze({
    name,
    provider,
    table: config.table?.trim() || DEFAULT_AUTH_PASSWORD_RESET_TABLE,
    expire: parseInteger(config.expire, DEFAULT_AUTH_PASSWORD_EXPIRE, 'Holo Auth', `auth password broker "${name}" expire`, {
      minimum: 0,
    }),
    throttle: parseInteger(config.throttle, DEFAULT_AUTH_PASSWORD_THROTTLE, 'Holo Auth', `auth password broker "${name}" throttle`, {
      minimum: 0,
    }),
    route: config.route?.trim() || DEFAULT_AUTH_PASSWORD_RESET_ROUTE,
  })
  /* v8 ignore stop */
}

function normalizeSocialProvider(
  name: string,
  config: AuthSocialProviderConfig,
  guards: Readonly<Record<string, NormalizedAuthGuardConfig>>,
  providers: Readonly<Record<string, NormalizedAuthProviderConfig>>,
): NormalizedAuthSocialProviderConfig {
  const guard = config.guard?.trim()
  if (guard && !(guard in guards)) {
    throw new Error(`[Holo Auth] social provider "${name}" references unknown guard "${guard}".`)
  }

  const mapToProvider = config.mapToProvider?.trim()
  if (mapToProvider && !(mapToProvider in providers)) {
    throw new Error(`[Holo Auth] social provider "${name}" references unknown provider "${mapToProvider}".`)
  }

  /* v8 ignore start -- straightforward trimming/default mapping for provider config */
  return Object.freeze({
    name,
    runtime: config.runtime?.trim() || undefined,
    clientId: config.clientId?.trim() || undefined,
    clientSecret: config.clientSecret?.trim() || undefined,
    redirectUri: config.redirectUri?.trim() || undefined,
    scopes: Object.freeze([...(config.scopes ?? [])]),
    guard,
    mapToProvider,
    encryptTokens: config.encryptTokens === true,
  })
  /* v8 ignore stop */
}

function normalizeWorkosProvider(
  name: string,
  config: AuthWorkosProviderConfig,
  guards: Readonly<Record<string, NormalizedAuthGuardConfig>>,
  providers: Readonly<Record<string, NormalizedAuthProviderConfig>>,
): NormalizedAuthWorkosProviderConfig {
  const guard = config.guard?.trim()
  if (guard && !(guard in guards)) {
    throw new Error(`[Holo Auth] WorkOS provider "${name}" references unknown guard "${guard}".`)
  }

  const mapToProvider = config.mapToProvider?.trim()
  if (mapToProvider && !(mapToProvider in providers)) {
    throw new Error(`[Holo Auth] WorkOS provider "${name}" references unknown provider "${mapToProvider}".`)
  }

  /* v8 ignore start -- straightforward trimming/default mapping for provider config */
  return Object.freeze({
    name,
    clientId: config.clientId?.trim() || undefined,
    apiKey: config.apiKey?.trim() || undefined,
    redirectUri: config.redirectUri?.trim() || undefined,
    sessionCookie: DEFAULT_WORKOS_SESSION_COOKIE,
    guard,
    mapToProvider,
  })
  /* v8 ignore stop */
}

function isHostedIdentityStore(value: unknown): value is AuthHostedIdentityStore {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as { findByProviderUserId?: unknown }).findByProviderUserId === 'function'
    && typeof (value as { findByUserId?: unknown }).findByUserId === 'function'
    && typeof (value as { save?: unknown }).save === 'function'
}

function isWorkosProviderConfig(value: AuthHostedIdentityStore | AuthWorkosProviderConfig | string | undefined): value is AuthWorkosProviderConfig {
  return typeof value === 'object' && value !== null && !isHostedIdentityStore(value)
}

function getWorkosProviderEntries(
  config: HoloAuthWorkosConfig | undefined,
): readonly (readonly [string, AuthWorkosProviderConfig])[] {
  if (!config) {
    return Object.freeze([])
  }

  const entries: [string, AuthWorkosProviderConfig][] = []
  for (const [name, value] of Object.entries(config)) {
    if (name === 'provider') {
      if (typeof value !== 'undefined' && typeof value !== 'string') {
        throw new Error('[Holo Auth] WorkOS provider key "provider" is reserved for the default provider name.')
      }
      continue
    }
    if (name === 'identityStore') {
      if (typeof value !== 'undefined' && !isHostedIdentityStore(value)) {
        throw new Error('[Holo Auth] WorkOS identityStore must implement the hosted identity store contract.')
      }
      continue
    }
    if (!isWorkosProviderConfig(value)) {
      throw new Error(`[Holo Auth] WorkOS provider "${name}" must be an object.`)
    }
    entries.push([name, value])
  }

  return Object.freeze(entries)
}

function normalizeWorkosConfig(
  config: HoloAuthWorkosConfig | undefined,
  guards: Readonly<Record<string, NormalizedAuthGuardConfig>>,
  providers: Readonly<Record<string, NormalizedAuthProviderConfig>>,
): NormalizedHoloAuthWorkosConfig {
  const providerEntries = getWorkosProviderEntries(config)
  const provider = typeof config?.provider === 'string' ? config.provider.trim() || undefined : undefined
  if (providerEntries.length === 0) {
    if (provider) {
      throw new Error(`[Holo Auth] WorkOS provider "${provider}" is not configured.`)
    }

    if (config?.identityStore) {
      return Object.freeze({
        identityStore: config.identityStore,
      })
    }

    return holoAuthDefaults.workos
  }

  const normalizedEntries = providerEntries.map(([name, providerConfig]) => {
    const normalizedName = normalizeConnectionName(name, 'Holo Auth', 'Auth WorkOS provider name')
    return [normalizedName, providerConfig] as const
  })
  if (provider && !normalizedEntries.some(([name]) => name === provider)) {
    throw new Error(`[Holo Auth] WorkOS provider "${provider}" is not configured.`)
  }

  return Object.freeze({
    ...(typeof provider === 'undefined' ? {} : { provider }),
    ...(config?.identityStore ? { identityStore: config.identityStore } : {}),
    ...Object.fromEntries(normalizedEntries.map(([name, providerConfig]) => [
      name,
      normalizeWorkosProvider(name, providerConfig, guards, providers),
    ])),
  })
}

function normalizeClerkProvider(
  name: string,
  config: AuthClerkProviderConfig,
  guards: Readonly<Record<string, NormalizedAuthGuardConfig>>,
  providers: Readonly<Record<string, NormalizedAuthProviderConfig>>,
): NormalizedAuthClerkProviderConfig {
  const guard = config.guard?.trim()
  if (guard && !(guard in guards)) {
    throw new Error(`[Holo Auth] Clerk provider "${name}" references unknown guard "${guard}".`)
  }

  const mapToProvider = config.mapToProvider?.trim()
  if (mapToProvider && !(mapToProvider in providers)) {
    throw new Error(`[Holo Auth] Clerk provider "${name}" references unknown provider "${mapToProvider}".`)
  }
  const redirectUri = config.redirectUri?.trim()
  if (redirectUri) {
    try {
      new URL(redirectUri)
    } catch {
      throw new Error(`Invalid redirectUri in Clerk provider "${name}": ${redirectUri}`)
    }
  }

  return Object.freeze({
    name,
    publishableKey: config.publishableKey?.trim() || undefined,
    secretKey: config.secretKey?.trim() || undefined,
    apiUrl: config.apiUrl?.trim() || undefined,
    frontendApi: config.frontendApi?.trim() || undefined,
    redirectUri: redirectUri || undefined,
    sessionCookie: config.sessionCookie?.trim() || DEFAULT_CLERK_SESSION_COOKIE,
    authorizedParties: Object.freeze((config.authorizedParties ?? [])
      .map(value => value.trim())
      .filter(Boolean)),
    guard,
    mapToProvider,
  })
}

function isClerkProviderConfig(value: unknown): value is AuthClerkProviderConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>
  for (const key of ['publishableKey', 'secretKey', 'apiUrl', 'frontendApi', 'redirectUri', 'sessionCookie', 'guard', 'mapToProvider']) {
    const field = candidate[key]
    if (typeof field !== 'undefined' && typeof field !== 'string') {
      return false
    }
  }

  return typeof candidate.authorizedParties === 'undefined'
    || (Array.isArray(candidate.authorizedParties) && candidate.authorizedParties.every(value => typeof value === 'string'))
}

function getClerkProviderEntries(config: HoloAuthClerkConfig | undefined): readonly [string, AuthClerkProviderConfig][] {
  if (!config) {
    return Object.freeze([])
  }

  const entries: [string, AuthClerkProviderConfig][] = []
  for (const [name, value] of Object.entries(config)) {
    if (name === 'provider') {
      if (typeof value !== 'undefined' && typeof value !== 'string') {
        throw new Error('[Holo Auth] Clerk provider key "provider" is reserved for the default provider name.')
      }
      continue
    }
    if (name === 'identityStore') {
      if (typeof value !== 'undefined' && !isHostedIdentityStore(value)) {
        throw new Error('[Holo Auth] Clerk identityStore must implement the hosted identity store contract.')
      }
      continue
    }
    if (!isClerkProviderConfig(value)) {
      throw new Error(`[Holo Auth] Clerk provider "${name}" must be a Clerk provider config object.`)
    }
    entries.push([name, value])
  }

  return Object.freeze(entries)
}

function normalizeClerkConfig(
  config: HoloAuthClerkConfig | undefined,
  guards: Readonly<Record<string, NormalizedAuthGuardConfig>>,
  providers: Readonly<Record<string, NormalizedAuthProviderConfig>>,
): NormalizedHoloAuthClerkConfig {
  const providerEntries = getClerkProviderEntries(config)
  const provider = typeof config?.provider === 'string' ? config.provider.trim() || undefined : undefined
  if (providerEntries.length === 0) {
    if (provider) {
      throw new Error(`[Holo Auth] Clerk provider "${provider}" is not configured.`)
    }

    if (config?.identityStore) {
      return Object.freeze({
        identityStore: config.identityStore,
      })
    }

    return holoAuthDefaults.clerk
  }

  const normalizedEntries = providerEntries.map(([name, providerConfig]) => {
    const normalizedName = normalizeConnectionName(name, 'Holo Auth', 'Auth Clerk provider name')
    return [normalizedName, providerConfig] as const
  })
  if (provider && !normalizedEntries.some(([name]) => name === provider)) {
    throw new Error(`[Holo Auth] Clerk provider "${provider}" is not configured.`)
  }

  return Object.freeze({
    ...(typeof provider === 'undefined' ? {} : { provider }),
    ...(config?.identityStore ? { identityStore: config.identityStore } : {}),
    ...Object.fromEntries(normalizedEntries.map(([name, providerConfig]) => [
      name,
      normalizeClerkProvider(name, providerConfig, guards, providers),
    ])),
  })
}

function isSafeMultiFactorChallengeRoute(route: string): boolean {
  return route.startsWith('/')
    && !route.startsWith('//')
    && !route.includes('\\')
    && !route.includes('?')
    && !route.includes('#')
    && !route.split('/').some(segment => (
      segment === '.'
      || segment === '..'
      || /%(?:2e|2f|5c)/iu.test(segment)
    ))
}

function normalizeMultiFactorConfig(
  config: HoloAuthConfig['multiFactor'],
): NormalizedHoloAuthConfig['multiFactor'] {
  if (
    typeof config !== 'undefined'
    && typeof config !== 'boolean'
    && (!config || typeof config !== 'object' || Array.isArray(config))
  ) {
    throw new Error('[Holo Auth] multi-factor configuration must be a boolean or object.')
  }

  const input = config && typeof config === 'object' ? config : {}
  const explicitEnabled = 'enabled' in input && typeof input.enabled === 'boolean'
    ? input.enabled
    : undefined
  const enabled = explicitEnabled ?? (config === true || typeof config === 'object')
  const issuer = input.issuer?.trim() || holoAuthDefaults.multiFactor.issuer
  const hasControlCharacter = [...issuer].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 32 || codePoint === 127
  })
  if (issuer.length > 100 || hasControlCharacter) {
    throw new Error('[Holo Auth] multi-factor issuer must be a bounded printable string.')
  }

  const challengeRoute = input.challengeRoute?.trim() || holoAuthDefaults.multiFactor.challengeRoute
  if (!isSafeMultiFactorChallengeRoute(challengeRoute)) {
    throw new Error('[Holo Auth] multi-factor challenge route must be a safe local path.')
  }

  const enrollmentTtl = parseInteger(input.enrollmentTtl, holoAuthDefaults.multiFactor.enrollmentTtl, 'Holo Auth', 'multi-factor enrollment TTL', { minimum: 60 })
  const challengeTtl = parseInteger(input.challengeTtl, holoAuthDefaults.multiFactor.challengeTtl, 'Holo Auth', 'multi-factor challenge TTL', { minimum: 30 })
  const recoveryCodes = parseInteger(input.recoveryCodes, holoAuthDefaults.multiFactor.recoveryCodes, 'Holo Auth', 'multi-factor recovery code count', { minimum: 1 })
  const allowedDriftSteps = parseInteger(input.allowedDriftSteps, holoAuthDefaults.multiFactor.allowedDriftSteps, 'Holo Auth', 'multi-factor allowed drift steps', { minimum: 0 })
  if (enrollmentTtl > 3600 || challengeTtl > 1800 || recoveryCodes > 20 || allowedDriftSteps > 2) {
    throw new Error('[Holo Auth] multi-factor configuration exceeds its security bounds.')
  }

  return Object.freeze({
    enabled,
    issuer,
    challengeRoute,
    enrollmentTtl,
    challengeTtl,
    recoveryCodes,
    allowedDriftSteps,
  })
}

export function normalizeAuthConfig(
  config: HoloAuthConfig = {},
  _options: {
    readonly appKey?: string
  } = {},
): NormalizedHoloAuthConfig {
  const providers = !config.providers || Object.keys(config.providers).length === 0
    ? holoAuthDefaults.providers
    : Object.freeze(Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => {
      const normalizedName = normalizeConnectionName(name, 'Holo Auth', 'Auth provider name')
      return [normalizedName, normalizeAuthProvider(normalizedName, provider)]
    })))

  const guards = !config.guards || Object.keys(config.guards).length === 0
    ? Object.freeze({
      [DEFAULT_AUTH_GUARD]: normalizeAuthGuard(
        DEFAULT_AUTH_GUARD,
        holoAuthDefaults.guards[DEFAULT_AUTH_GUARD]!,
        providers,
      ),
    })
    : Object.freeze(Object.fromEntries(Object.entries(config.guards).map(([name, guard]) => {
      const normalizedName = normalizeConnectionName(name, 'Holo Auth', 'Auth guard name')
      return [normalizedName, normalizeAuthGuard(normalizedName, guard, providers)]
    })))

  const passwords = !config.passwords || Object.keys(config.passwords).length === 0
    ? Object.freeze({
      [DEFAULT_AUTH_PASSWORD_BROKER]: normalizePasswordBroker(
        DEFAULT_AUTH_PASSWORD_BROKER,
        holoAuthDefaults.passwords[DEFAULT_AUTH_PASSWORD_BROKER]!,
        providers,
      ),
    })
    : Object.freeze(Object.fromEntries(Object.entries(config.passwords).map(([name, broker]) => {
      const normalizedName = normalizeConnectionName(name, 'Holo Auth', 'Auth password broker name')
      return [normalizedName, normalizePasswordBroker(normalizedName, broker, providers)]
    })))

  const defaultGuard = config.defaults?.guard?.trim() || DEFAULT_AUTH_GUARD
  if (!(defaultGuard in guards)) {
    throw new Error(`[Holo Auth] default auth guard "${defaultGuard}" is not configured.`)
  }

  const defaultPasswords = config.defaults?.passwords?.trim() || DEFAULT_AUTH_PASSWORD_BROKER
  if (!(defaultPasswords in passwords)) {
    throw new Error(`[Holo Auth] default password broker "${defaultPasswords}" is not configured.`)
  }

  const social = !config.social || Object.keys(config.social).length === 0
    ? holoAuthDefaults.social
    : Object.freeze(Object.fromEntries(Object.entries(config.social).map(([name, provider]) => {
      const normalizedName = normalizeConnectionName(name, 'Holo Auth', 'Auth social provider name')
      return [normalizedName, normalizeSocialProvider(normalizedName, provider, guards, providers)]
    })))

  const workos = normalizeWorkosConfig(config.workos, guards, providers)

  const clerk = normalizeClerkConfig(config.clerk, guards, providers)
  const multiFactor = normalizeMultiFactorConfig(config.multiFactor)

  return Object.freeze({
    defaults: Object.freeze({
      guard: defaultGuard,
      passwords: defaultPasswords,
    }),
    guards,
    providers,
    passwords,
    emailVerification: Object.freeze({
      required: typeof config.emailVerification === 'boolean'
        ? config.emailVerification
        : config.emailVerification?.required ?? false,
      route: typeof config.emailVerification === 'boolean'
        ? DEFAULT_AUTH_EMAIL_VERIFICATION_ROUTE
        : config.emailVerification?.route?.trim() || DEFAULT_AUTH_EMAIL_VERIFICATION_ROUTE,
    }),
    multiFactor,
    personalAccessTokens: Object.freeze({
      defaultAbilities: Object.freeze([...(config.personalAccessTokens?.defaultAbilities ?? holoAuthDefaults.personalAccessTokens.defaultAbilities)]),
    }),
    socialEncryptionKey: config.socialEncryptionKey?.trim() || _options.appKey?.trim() || undefined,
    social,
    workos,
    clerk,
  })
}

export function defineAuthConfig<TConfig extends HoloAuthConfig>(config: TConfig): Readonly<TConfig> {
  return Object.freeze({ ...config })
}

function normalizeRegisteredAuthConfig(
  config: HoloAuthConfig | undefined,
  context: { get<TValue extends object>(name: string): TValue | undefined },
): NormalizedHoloAuthConfig {
  return normalizeAuthConfig(config, {
    appKey: context.get<{ readonly key: string }>('app')?.key,
  })
}

export const authConfigInternals = {
  normalizeRegisteredAuthConfig,
}

registerConfigNormalizer<HoloAuthConfig, NormalizedHoloAuthConfig>({
  name: 'auth',
  dependencies: ['app'],
  normalize: normalizeRegisteredAuthConfig,
})
import type {} from '@holo-js/config'
import { registerConfigNormalizer } from '@holo-js/config/registry'
