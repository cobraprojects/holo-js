import {
  DEFAULT_HOLO_PROJECT_PATHS,
  normalizeHoloProjectConfig,
} from '@holo-js/db'
import type {
  AuthGuardConfig,
  AuthClerkProviderConfig,
  AuthPasswordBrokerConfig,
  AuthProviderConfig,
  AuthSocialProviderConfig,
  AuthWorkosProviderConfig,
  HoloAuthConfig,
  NormalizedQueueConnectionConfig,
  NormalizedAuthGuardConfig,
  NormalizedAuthClerkProviderConfig,
  NormalizedAuthPasswordBrokerConfig,
  NormalizedAuthProviderConfig,
  NormalizedAuthSocialProviderConfig,
  NormalizedAuthWorkosProviderConfig,
  NormalizedHoloAuthConfig,
  NormalizedQueueDatabaseConnectionConfig,
  NormalizedQueueFailedStoreConfig,
  NormalizedHoloAppConfig,
  NormalizedHoloDatabaseConfig,
  NormalizedHoloQueueConfig,
  NormalizedHoloSessionConfig,
  NormalizedHoloStorageConfig,
  HoloAppConfig,
  HoloAppEnv,
  HoloDatabaseConfig,
  HoloSessionConfig,
  HoloQueueConfig,
  HoloStorageConfig,
  QueueConnectionConfig,
  QueueDatabaseConnectionConfig,
  QueueFailedStoreConfig,
  QueueRedisConnectionConfig,
  QueueSyncConnectionConfig,
  SessionCookieSameSite,
  SessionDatabaseStoreConfig,
  SessionFileStoreConfig,
  SessionStoreConfig,
} from './types'

export const DEFAULT_APP_NAME = 'Holo'

export const holoAppDefaults: Readonly<NormalizedHoloAppConfig> = Object.freeze({
  name: DEFAULT_APP_NAME,
  key: '',
  url: 'http://localhost:3000',
  debug: true,
  env: 'development',
  paths: Object.freeze({ ...DEFAULT_HOLO_PROJECT_PATHS }),
  models: Object.freeze([]),
  migrations: Object.freeze([]),
  seeders: Object.freeze([]),
})

export const holoDatabaseDefaults: Readonly<NormalizedHoloDatabaseConfig> = Object.freeze({
  defaultConnection: 'default',
  connections: Object.freeze({
    default: Object.freeze({
      driver: 'sqlite',
      url: './data/database.sqlite',
      schema: 'public',
      logging: false,
    }),
  }),
})

export const holoStorageDefaults: Readonly<NormalizedHoloStorageConfig> = Object.freeze({
  defaultDisk: 'local',
  routePrefix: '/storage',
  disks: Object.freeze({
    local: Object.freeze({
      driver: 'local',
      root: './storage/app',
    }),
    public: Object.freeze({
      driver: 'public',
      root: './storage/app/public',
      visibility: 'public',
    }),
  }),
})

export const DEFAULT_SESSION_DRIVER = 'file'
export const DEFAULT_SESSION_IDLE_TIMEOUT = 120
export const DEFAULT_SESSION_ABSOLUTE_LIFETIME = 120
export const DEFAULT_SESSION_REMEMBER_ME_LIFETIME = 43200
export const DEFAULT_SESSION_COOKIE_NAME = 'holo_session'
export const DEFAULT_SESSION_COOKIE_PATH = '/'
export const DEFAULT_SESSION_COOKIE_SAME_SITE: SessionCookieSameSite = 'lax'
export const DEFAULT_SESSION_DATABASE_CONNECTION = 'default'
export const DEFAULT_SESSION_DATABASE_TABLE = 'sessions'
export const DEFAULT_SESSION_FILE_PATH = './storage/framework/sessions'

export const holoSessionDefaults: Readonly<NormalizedHoloSessionConfig> = Object.freeze({
  driver: DEFAULT_SESSION_DRIVER,
  stores: Object.freeze({
    database: Object.freeze({
      name: 'database',
      driver: 'database' as const,
      connection: DEFAULT_SESSION_DATABASE_CONNECTION,
      table: DEFAULT_SESSION_DATABASE_TABLE,
    }),
    file: Object.freeze({
      name: 'file',
      driver: 'file' as const,
      path: DEFAULT_SESSION_FILE_PATH,
    }),
  }),
  cookie: Object.freeze({
    name: DEFAULT_SESSION_COOKIE_NAME,
    path: DEFAULT_SESSION_COOKIE_PATH,
    secure: false,
    httpOnly: true,
    sameSite: DEFAULT_SESSION_COOKIE_SAME_SITE,
    partitioned: false,
    maxAge: DEFAULT_SESSION_ABSOLUTE_LIFETIME,
  }),
  idleTimeout: DEFAULT_SESSION_IDLE_TIMEOUT,
  absoluteLifetime: DEFAULT_SESSION_ABSOLUTE_LIFETIME,
  rememberMeLifetime: DEFAULT_SESSION_REMEMBER_ME_LIFETIME,
})

export const DEFAULT_AUTH_GUARD = 'web'
export const DEFAULT_AUTH_PROVIDER = 'users'
export const DEFAULT_AUTH_PASSWORD_BROKER = 'users'
export const DEFAULT_AUTH_PASSWORD_RESET_TABLE = 'password_reset_tokens'
export const DEFAULT_AUTH_PASSWORD_EXPIRE = 60
export const DEFAULT_AUTH_PASSWORD_THROTTLE = 60
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
    }),
  }),
  passwords: Object.freeze({
    users: Object.freeze({
      name: 'users',
      provider: DEFAULT_AUTH_PROVIDER,
      table: DEFAULT_AUTH_PASSWORD_RESET_TABLE,
      expire: DEFAULT_AUTH_PASSWORD_EXPIRE,
      throttle: DEFAULT_AUTH_PASSWORD_THROTTLE,
    }),
  }),
  emailVerification: Object.freeze({
    required: false,
  }),
  personalAccessTokens: Object.freeze({
    defaultAbilities: Object.freeze([]),
  }),
  socialEncryptionKey: undefined,
  social: Object.freeze({}),
  workos: Object.freeze({}),
  clerk: Object.freeze({}),
})

export const DEFAULT_QUEUE_CONNECTION = 'sync'
export const DEFAULT_QUEUE_NAME = 'default'
export const DEFAULT_QUEUE_RETRY_AFTER = 90
export const DEFAULT_QUEUE_BLOCK_FOR = 5
export const DEFAULT_QUEUE_SLEEP = 1
export const DEFAULT_FAILED_JOBS_CONNECTION = 'default'
export const DEFAULT_FAILED_JOBS_TABLE = 'failed_jobs'
export const DEFAULT_DATABASE_QUEUE_TABLE = 'jobs'

const DEFAULT_QUEUE_CONFIG: Readonly<NormalizedHoloQueueConfig> = Object.freeze({
  default: DEFAULT_QUEUE_CONNECTION,
  failed: Object.freeze({
    driver: 'database' as const,
    connection: DEFAULT_FAILED_JOBS_CONNECTION,
    table: DEFAULT_FAILED_JOBS_TABLE,
  }),
  connections: Object.freeze({
    [DEFAULT_QUEUE_CONNECTION]: Object.freeze({
      name: DEFAULT_QUEUE_CONNECTION,
      driver: 'sync' as const,
      queue: DEFAULT_QUEUE_NAME,
    }),
  }),
})

function parseInteger(
  value: number | string | undefined,
  fallback: number,
  label: string,
  options: { minimum?: number } = {},
): number {
  if (typeof value === 'undefined') {
    return fallback
  }

  const normalized = typeof value === 'number'
    ? value
    : Number.parseInt(value, 10)

  if (!Number.isInteger(normalized)) {
    throw new Error(`[Holo Queue] ${label} must be an integer.`)
  }

  if (typeof options.minimum === 'number' && normalized < options.minimum) {
    throw new Error(`[Holo Queue] ${label} must be greater than or equal to ${options.minimum}.`)
  }

  return normalized
}

function normalizeNonEmptyString(value: string | undefined, label: string): string {
  const normalized = value?.trim()
  if (!normalized) {
    throw new Error(label)
  }

  return normalized
}

function normalizeConnectionName(value: string | undefined, label: string): string {
  const normalized = value?.trim()
  if (!normalized) {
    throw new Error(`[Holo Queue] ${label} must be a non-empty string.`)
  }

  return normalized
}

function normalizeQueueName(value: string | undefined): string {
  return value?.trim() || DEFAULT_QUEUE_NAME
}

function normalizeSyncConnection(
  name: string,
  config: QueueSyncConnectionConfig,
): NormalizedQueueConnectionConfig {
  return Object.freeze({
    name,
    driver: 'sync',
    queue: normalizeQueueName(config.queue),
  })
}

function normalizeRedisConnection(
  name: string,
  config: QueueRedisConnectionConfig,
): NormalizedQueueConnectionConfig {
  const redis = config.redis ?? {}

  return Object.freeze({
    name,
    driver: 'redis',
    queue: normalizeQueueName(config.queue),
    retryAfter: parseInteger(config.retryAfter, DEFAULT_QUEUE_RETRY_AFTER, `queue connection "${name}" retryAfter`, {
      minimum: 0,
    }),
    blockFor: parseInteger(config.blockFor, DEFAULT_QUEUE_BLOCK_FOR, `queue connection "${name}" blockFor`, {
      minimum: 0,
    }),
    redis: Object.freeze({
      host: redis.host?.trim() || '127.0.0.1',
      port: parseInteger(redis.port, 6379, `queue connection "${name}" redis.port`, {
        minimum: 1,
      }),
      password: redis.password?.trim() || undefined,
      username: redis.username?.trim() || undefined,
      db: parseInteger(redis.db, 0, `queue connection "${name}" redis.db`, {
        minimum: 0,
      }),
    }),
  })
}

function normalizeDatabaseConnection(
  name: string,
  config: QueueDatabaseConnectionConfig,
): NormalizedQueueDatabaseConnectionConfig {
  return Object.freeze({
    name,
    driver: 'database',
    queue: normalizeQueueName(config.queue),
    retryAfter: parseInteger(config.retryAfter, DEFAULT_QUEUE_RETRY_AFTER, `queue connection "${name}" retryAfter`, {
      minimum: 0,
    }),
    sleep: parseInteger(config.sleep, DEFAULT_QUEUE_SLEEP, `queue connection "${name}" sleep`, {
      minimum: 0,
    }),
    connection: config.connection?.trim() || DEFAULT_FAILED_JOBS_CONNECTION,
    table: config.table?.trim() || DEFAULT_DATABASE_QUEUE_TABLE,
  })
}

function normalizeConnectionConfig(
  name: string,
  config: QueueConnectionConfig,
): NormalizedQueueConnectionConfig {
  switch (config.driver) {
    case 'sync':
      return normalizeSyncConnection(name, config)
    case 'redis':
      return normalizeRedisConnection(name, config)
    case 'database':
      return normalizeDatabaseConnection(name, config)
    default:
      throw new Error(`[Holo Queue] Unsupported queue driver "${String((config as { driver?: unknown }).driver)}" on connection "${name}".`)
  }
}

function normalizeConnections(
  connections: Readonly<Record<string, QueueConnectionConfig>> | undefined,
): Readonly<Record<string, NormalizedQueueConnectionConfig>> {
  if (!connections || Object.keys(connections).length === 0) {
    return DEFAULT_QUEUE_CONFIG.connections
  }

  const normalizedEntries = Object.entries(connections).map(([name, config]) => {
    const normalizedName = normalizeConnectionName(name, 'Queue connection name')
    return [normalizedName, normalizeConnectionConfig(normalizedName, config)] as const
  })

  return Object.freeze(Object.fromEntries(normalizedEntries))
}

function normalizeFailedStore(config: false | QueueFailedStoreConfig | undefined): false | NormalizedQueueFailedStoreConfig {
  if (config === false) {
    return false
  }

  const normalized = (config ?? DEFAULT_QUEUE_CONFIG.failed) as QueueFailedStoreConfig | NormalizedQueueFailedStoreConfig

  if (normalized.driver && normalized.driver !== 'database') {
    throw new Error(`[Holo Queue] Unsupported failed job store driver "${normalized.driver}".`)
  }

  return Object.freeze({
    driver: 'database',
    connection: normalized.connection?.trim() || DEFAULT_FAILED_JOBS_CONNECTION,
    table: normalized.table?.trim() || DEFAULT_FAILED_JOBS_TABLE,
  })
}

export const holoQueueDefaultsNormalized: Readonly<NormalizedHoloQueueConfig> = DEFAULT_QUEUE_CONFIG

export function normalizeAppEnv(value: string | undefined, fallback: HoloAppEnv = 'development'): HoloAppEnv {
  if (!value) {
    return fallback
  }

  if (value === 'development' || value === 'production' || value === 'test') {
    return value
  }

  return fallback
}

export function normalizeAppConfig(
  config: HoloAppConfig = {},
): NormalizedHoloAppConfig {
  const project = normalizeHoloProjectConfig(config)
  const rawDebug = (config as { debug?: unknown }).debug
  const debug = typeof rawDebug === 'string'
    ? !['false', '0', 'off', 'no'].includes(rawDebug.trim().toLowerCase())
    : config.debug

  return Object.freeze({
    name: config.name ?? holoAppDefaults.name,
    key: config.key ?? holoAppDefaults.key,
    url: config.url ?? holoAppDefaults.url,
    debug: debug ?? holoAppDefaults.debug,
    env: normalizeAppEnv(config.env, holoAppDefaults.env),
    paths: project.paths,
    models: project.models,
    migrations: project.migrations,
    seeders: project.seeders,
  })
}

function normalizeSessionStoreConfig(
  name: string,
  config: SessionStoreConfig,
): NormalizedHoloSessionConfig['stores'][string] {
  /* v8 ignore start -- branch coverage here is mostly trim/default normalization on simple data mapping */
  switch (config.driver) {
    case 'database': {
      const databaseConfig = config as SessionDatabaseStoreConfig
      return Object.freeze({
        name,
        driver: 'database',
        connection: databaseConfig.connection?.trim() || DEFAULT_SESSION_DATABASE_CONNECTION,
        table: databaseConfig.table?.trim() || DEFAULT_SESSION_DATABASE_TABLE,
      })
    }
    case 'file': {
      const fileConfig = config as SessionFileStoreConfig
      return Object.freeze({
        name,
        driver: 'file',
        path: fileConfig.path?.trim() || DEFAULT_SESSION_FILE_PATH,
      })
    }
    case 'redis': {
      throw new Error('[Holo Session] Redis-backed session stores are not supported by the portable runtime yet.')
    }
    default:
      throw new Error(`[Holo Session] Unsupported session store driver "${String((config as { driver?: unknown }).driver)}" on store "${name}".`)
  }
  /* v8 ignore stop */
}

export function normalizeSessionConfig(
  config: HoloSessionConfig = {},
): NormalizedHoloSessionConfig {
  const stores = !config.stores || Object.keys(config.stores).length === 0
    ? holoSessionDefaults.stores
    : Object.freeze(Object.fromEntries(Object.entries(config.stores).map(([name, store]) => {
      const normalizedName = normalizeConnectionName(name, 'Session store name')
      return [normalizedName, normalizeSessionStoreConfig(normalizedName, store)]
    })))

  /* v8 ignore start -- straightforward default selection between configured, preferred, and first available stores */
  const configuredDriver = config.driver?.trim()
  const driver = configuredDriver
    || (DEFAULT_SESSION_DRIVER in stores ? DEFAULT_SESSION_DRIVER : undefined)
    || Object.keys(stores)[0]
    || DEFAULT_SESSION_DRIVER
  /* v8 ignore stop */
  if (!(driver in stores)) {
    throw new Error(`[Holo Session] default session driver "${driver}" is not configured.`)
  }

  const cookie = config.cookie ?? {}
  const sameSite = cookie.sameSite ?? DEFAULT_SESSION_COOKIE_SAME_SITE
  if (sameSite !== 'lax' && sameSite !== 'strict' && sameSite !== 'none') {
    throw new Error(`[Holo Session] cookie sameSite must be "lax", "strict", or "none".`)
  }

  const idleTimeout = parseInteger(config.idleTimeout, DEFAULT_SESSION_IDLE_TIMEOUT, 'session idleTimeout', {
    minimum: 0,
  })
  const absoluteLifetime = parseInteger(
    config.absoluteLifetime,
    DEFAULT_SESSION_ABSOLUTE_LIFETIME,
    'session absoluteLifetime',
    {
      minimum: 0,
    },
  )
  const rememberMeLifetime = parseInteger(
    config.rememberMeLifetime,
    DEFAULT_SESSION_REMEMBER_ME_LIFETIME,
    'session rememberMeLifetime',
    {
      minimum: 0,
    },
  )

  return Object.freeze({
    driver,
    stores,
    cookie: Object.freeze({
      name: cookie.name?.trim() || DEFAULT_SESSION_COOKIE_NAME,
      path: cookie.path?.trim() || DEFAULT_SESSION_COOKIE_PATH,
      domain: cookie.domain?.trim() || undefined,
      secure: cookie.secure ?? false,
      httpOnly: cookie.httpOnly ?? true,
      sameSite,
      partitioned: cookie.partitioned ?? false,
      maxAge: parseInteger(cookie.maxAge, absoluteLifetime, 'session cookie maxAge', {
        minimum: 0,
      }),
    }),
    idleTimeout,
    absoluteLifetime,
    rememberMeLifetime,
  })
}

function normalizeAuthProvider(
  name: string,
  config: AuthProviderConfig,
): NormalizedAuthProviderConfig {
  return Object.freeze({
    name,
    model: normalizeNonEmptyString(config.model, `[Holo Auth] provider "${name}" model must be a non-empty string.`),
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
    expire: parseInteger(config.expire, DEFAULT_AUTH_PASSWORD_EXPIRE, `auth password broker "${name}" expire`, {
      minimum: 0,
    }),
    throttle: parseInteger(config.throttle, DEFAULT_AUTH_PASSWORD_THROTTLE, `auth password broker "${name}" throttle`, {
      minimum: 0,
    }),
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
    cookiePassword: config.cookiePassword?.trim() || undefined,
    redirectUri: config.redirectUri?.trim() || undefined,
    sessionCookie: config.sessionCookie?.trim() || DEFAULT_WORKOS_SESSION_COOKIE,
    guard,
    mapToProvider,
  })
  /* v8 ignore stop */
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

  return Object.freeze({
    name,
    publishableKey: config.publishableKey?.trim() || undefined,
    secretKey: config.secretKey?.trim() || undefined,
    jwtKey: config.jwtKey?.trim() || undefined,
    apiUrl: config.apiUrl?.trim() || undefined,
    frontendApi: config.frontendApi?.trim() || undefined,
    sessionCookie: config.sessionCookie?.trim() || DEFAULT_CLERK_SESSION_COOKIE,
    authorizedParties: Object.freeze((config.authorizedParties ?? [])
      .map(value => value.trim())
      .filter(Boolean)),
    guard,
    mapToProvider,
  })
}

export function normalizeAuthConfig(
  config: HoloAuthConfig = {},
): NormalizedHoloAuthConfig {
  const providers = !config.providers || Object.keys(config.providers).length === 0
    ? holoAuthDefaults.providers
    : Object.freeze(Object.fromEntries(Object.entries(config.providers).map(([name, provider]) => {
      const normalizedName = normalizeConnectionName(name, 'Auth provider name')
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
      const normalizedName = normalizeConnectionName(name, 'Auth guard name')
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
      const normalizedName = normalizeConnectionName(name, 'Auth password broker name')
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
      const normalizedName = normalizeConnectionName(name, 'Auth social provider name')
      return [normalizedName, normalizeSocialProvider(normalizedName, provider, guards, providers)]
    })))

  const workos = !config.workos || Object.keys(config.workos).length === 0
    ? holoAuthDefaults.workos
    : Object.freeze(Object.fromEntries(Object.entries(config.workos).map(([name, provider]) => {
      const normalizedName = normalizeConnectionName(name, 'Auth WorkOS provider name')
      return [normalizedName, normalizeWorkosProvider(normalizedName, provider, guards, providers)]
    })))

  const clerk = !config.clerk || Object.keys(config.clerk).length === 0
    ? holoAuthDefaults.clerk
    : Object.freeze(Object.fromEntries(Object.entries(config.clerk).map(([name, provider]) => {
      const normalizedName = normalizeConnectionName(name, 'Auth Clerk provider name')
      return [normalizedName, normalizeClerkProvider(normalizedName, provider, guards, providers)]
    })))

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
    }),
    personalAccessTokens: Object.freeze({
      defaultAbilities: Object.freeze([...(config.personalAccessTokens?.defaultAbilities ?? [])]),
    }),
    socialEncryptionKey: config.socialEncryptionKey?.trim() || undefined,
    social,
    workos,
    clerk,
  })
}

export function normalizeDatabaseConfig(
  config: HoloDatabaseConfig = {},
): NormalizedHoloDatabaseConfig {
  const configuredConnections = config.connections
  const connections = configuredConnections && Object.keys(configuredConnections).length > 0
    ? Object.freeze({ ...configuredConnections })
    : holoDatabaseDefaults.connections

  const defaultConnection = config.defaultConnection
    ?? Object.keys(connections)[0]

  return Object.freeze({
    /* v8 ignore next */
    defaultConnection: defaultConnection ?? 'default',
    connections,
  })
}

export function normalizeStorageConfig(
  config: HoloStorageConfig = {},
): NormalizedHoloStorageConfig {
  return Object.freeze({
    defaultDisk: config.defaultDisk ?? holoStorageDefaults.defaultDisk,
    routePrefix: config.routePrefix ?? holoStorageDefaults.routePrefix,
    disks: Object.freeze({
      ...(holoStorageDefaults.disks as Record<string, unknown>),
      ...(config.disks ?? {}),
    }) as NormalizedHoloStorageConfig['disks'],
  })
}

export function normalizeQueueConfigForHolo(
  config: HoloQueueConfig = {},
): NormalizedHoloQueueConfig {
  const connections = normalizeConnections(config.connections)
  const connectionNames = Object.keys(connections)
  const defaultConnection = config.default?.trim()
    || connectionNames[0]!

  if (!connections[defaultConnection]) {
    throw new Error(
      `[Holo Queue] default queue connection "${defaultConnection}" is not configured. `
      + `Available connections: ${connectionNames.join(', ')}`,
    )
  }

  return Object.freeze({
    default: defaultConnection,
    failed: normalizeFailedStore(config.failed),
    connections,
  })
}
