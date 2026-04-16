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
  BroadcastConnectionOptionsConfig,
  BroadcastWorkerConfig,
  HoloBroadcastConfig,
  HoloBroadcastConnection,
  HoloAuthConfig,
  HoloMailAddressConfig,
  HoloMailConfig,
  HoloMailMailerConfig,
  HoloMailQueueConfig,
  NormalizedQueueConnectionConfig,
  NormalizedAuthGuardConfig,
  NormalizedAuthClerkProviderConfig,
  NormalizedAuthPasswordBrokerConfig,
  NormalizedAuthProviderConfig,
  NormalizedAuthSocialProviderConfig,
  NormalizedAuthWorkosProviderConfig,
  NormalizedBroadcastConnectionOptionsConfig,
  NormalizedBroadcastWorkerConfig,
  NormalizedHoloBroadcastConfig,
  NormalizedHoloBroadcastConnection,
  NormalizedHoloAuthConfig,
  NormalizedHoloMailAddressConfig,
  NormalizedHoloMailConfig,
  NormalizedHoloMailMailerConfig,
  NormalizedHoloMailQueueConfig,
  NormalizedQueueDatabaseConnectionConfig,
  NormalizedQueueFailedStoreConfig,
  NormalizedHoloAppConfig,
  NormalizedHoloDatabaseConfig,
  NormalizedHoloNotificationsConfig,
  NormalizedHoloQueueConfig,
  NormalizedHoloSessionConfig,
  NormalizedHoloStorageConfig,
  HoloAppConfig,
  HoloAppEnv,
  HoloDatabaseConfig,
  HoloNotificationsConfig,
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

export const DEFAULT_NOTIFICATIONS_TABLE = 'notifications'
export const DEFAULT_BROADCAST_CONNECTION = 'null'
export const DEFAULT_BROADCAST_HOST = '127.0.0.1'
export const DEFAULT_BROADCAST_HTTP_PORT = 80
export const DEFAULT_BROADCAST_HTTPS_PORT = 443
export const DEFAULT_BROADCAST_PORT = DEFAULT_BROADCAST_HTTPS_PORT
export const DEFAULT_BROADCAST_WORKER_HOST = '0.0.0.0'
export const DEFAULT_BROADCAST_WORKER_PORT = 8080
export const DEFAULT_BROADCAST_WORKER_PATH = '/app'
export const DEFAULT_BROADCAST_HEALTH_PATH = '/health'
export const DEFAULT_BROADCAST_STATS_PATH = '/stats'

export const holoNotificationsDefaults: Readonly<NormalizedHoloNotificationsConfig> = Object.freeze({
  table: DEFAULT_NOTIFICATIONS_TABLE,
  queue: Object.freeze({
    connection: undefined,
    queue: undefined,
    afterCommit: false,
  }),
})

export const holoBroadcastDefaults: Readonly<NormalizedHoloBroadcastConfig> = Object.freeze({
  default: DEFAULT_BROADCAST_CONNECTION,
  connections: Object.freeze({
    log: Object.freeze({
      name: 'log',
      driver: 'log',
      clientOptions: Object.freeze({}),
    }),
    null: Object.freeze({
      name: 'null',
      driver: 'null',
      clientOptions: Object.freeze({}),
    }),
  }),
  worker: Object.freeze({
    host: DEFAULT_BROADCAST_WORKER_HOST,
    port: DEFAULT_BROADCAST_WORKER_PORT,
    path: DEFAULT_BROADCAST_WORKER_PATH,
    publicHost: undefined,
    publicPort: undefined,
    publicScheme: 'https',
    healthPath: DEFAULT_BROADCAST_HEALTH_PATH,
    statsPath: DEFAULT_BROADCAST_STATS_PATH,
    scaling: false,
  }),
})

export const DEFAULT_MAILER_NAME = 'preview'
export const DEFAULT_MAIL_PREVIEW_PATH = '.holo-js/runtime/mail-preview'
export const DEFAULT_SMTP_HOST = '127.0.0.1'
export const DEFAULT_SMTP_PORT = 1025

const DEFAULT_MAIL_QUEUE_CONFIG: Readonly<NormalizedHoloMailQueueConfig> = Object.freeze({
  queued: false,
  connection: undefined,
  queue: undefined,
  afterCommit: false,
})

export const holoMailDefaults: Readonly<NormalizedHoloMailConfig> = Object.freeze({
  default: DEFAULT_MAILER_NAME,
  from: undefined,
  replyTo: undefined,
  queue: DEFAULT_MAIL_QUEUE_CONFIG,
  preview: Object.freeze({
    allowedEnvironments: Object.freeze(['development'] as const),
  }),
  markdown: Object.freeze({
    wrapper: undefined,
  }),
  mailers: Object.freeze({
    preview: Object.freeze({
      name: 'preview',
      driver: 'preview' as const,
      from: undefined,
      replyTo: undefined,
      queue: DEFAULT_MAIL_QUEUE_CONFIG,
      path: DEFAULT_MAIL_PREVIEW_PATH,
    }),
    log: Object.freeze({
      name: 'log',
      driver: 'log' as const,
      from: undefined,
      replyTo: undefined,
      queue: DEFAULT_MAIL_QUEUE_CONFIG,
      logBodies: false,
    }),
    fake: Object.freeze({
      name: 'fake',
      driver: 'fake' as const,
      from: undefined,
      replyTo: undefined,
      queue: DEFAULT_MAIL_QUEUE_CONFIG,
    }),
    smtp: Object.freeze({
      name: 'smtp',
      driver: 'smtp' as const,
      from: undefined,
      replyTo: undefined,
      queue: DEFAULT_MAIL_QUEUE_CONFIG,
      host: DEFAULT_SMTP_HOST,
      port: DEFAULT_SMTP_PORT,
      secure: false,
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
export const DEFAULT_AUTH_IDENTIFIERS = Object.freeze(['email'] as const)
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

function normalizeOptionalBroadcastString(
  value: string | number | undefined,
  label: string,
): string | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  const normalized = String(value).trim()
  if (!normalized) {
    throw new Error(`[Holo Broadcast] ${label} must be a non-empty string when provided.`)
  }

  return normalized
}

function normalizeBroadcastPort(
  value: string | number | undefined,
  fallback: number,
  label: string,
): number {
  const normalized = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value.trim())
      : fallback

  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`[Holo Broadcast] ${label} must be a positive number.`)
  }

  return normalized
}

function normalizeBroadcastScheme(
  value: string | undefined,
  fallback: 'http' | 'https',
  label: string,
): 'http' | 'https' {
  const normalized = normalizeOptionalBroadcastString(value, label)?.toLowerCase()
  if (typeof normalized === 'undefined') {
    return fallback
  }

  if (normalized !== 'http' && normalized !== 'https') {
    throw new Error(`[Holo Broadcast] ${label} must be "http" or "https".`)
  }

  return normalized
}

function normalizeBroadcastConnectionOptions(
  options: BroadcastConnectionOptionsConfig | undefined,
  fallbackHost: string,
  fallbackPort: number,
  label: string,
): NormalizedBroadcastConnectionOptionsConfig {
  const scheme = normalizeBroadcastScheme(options?.scheme, 'https', `${label} scheme`)
  const resolvedFallbackPort = scheme === 'http' ? DEFAULT_BROADCAST_HTTP_PORT : fallbackPort

  return Object.freeze({
    host: normalizeOptionalBroadcastString(options?.host, `${label} host`) ?? fallbackHost,
    port: normalizeBroadcastPort(options?.port, resolvedFallbackPort, `${label} port`),
    scheme,
    useTLS: options?.useTLS ?? scheme === 'https',
    cluster: normalizeOptionalBroadcastString(options?.cluster, `${label} cluster`) ?? undefined,
  })
}

function normalizeBroadcastWorkerConfig(
  worker: BroadcastWorkerConfig | undefined,
): NormalizedBroadcastWorkerConfig {
  const scaling = worker?.scaling
  const publicScheme = normalizeBroadcastScheme(worker?.publicScheme, 'https', 'Broadcast worker public scheme')
  if (scaling && scaling.driver !== 'redis') {
    throw new Error('[Holo Broadcast] Broadcast worker scaling driver must be "redis".')
  }

  return Object.freeze({
    host: normalizeOptionalBroadcastString(worker?.host, 'Broadcast worker host') ?? DEFAULT_BROADCAST_WORKER_HOST,
    port: normalizeBroadcastPort(worker?.port, DEFAULT_BROADCAST_WORKER_PORT, 'Broadcast worker port'),
    path: normalizeOptionalBroadcastString(worker?.path, 'Broadcast worker path') ?? DEFAULT_BROADCAST_WORKER_PATH,
    publicHost: normalizeOptionalBroadcastString(worker?.publicHost, 'Broadcast worker public host') ?? undefined,
    publicPort: typeof worker?.publicPort === 'undefined'
      ? (publicScheme === 'http' ? DEFAULT_BROADCAST_HTTP_PORT : undefined)
      : normalizeBroadcastPort(
          worker.publicPort,
          /* v8 ignore next -- defensive HTTPS port default; tests only exercise HTTP scheme */
          publicScheme === 'http' ? DEFAULT_BROADCAST_HTTP_PORT : DEFAULT_BROADCAST_HTTPS_PORT,
          'Broadcast worker public port',
        ),
    publicScheme,
    healthPath: normalizeOptionalBroadcastString(worker?.healthPath, 'Broadcast worker health path') ?? DEFAULT_BROADCAST_HEALTH_PATH,
    statsPath: normalizeOptionalBroadcastString(worker?.statsPath, 'Broadcast worker stats path') ?? DEFAULT_BROADCAST_STATS_PATH,
    scaling: scaling && typeof scaling === 'object'
        ? Object.freeze({
            driver: 'redis' as const,
            connection: normalizeOptionalBroadcastString(scaling.connection, 'Broadcast worker scaling connection') ?? 'default',
          })
        : holoBroadcastDefaults.worker.scaling,
  })
}

function normalizeBroadcastConnection(
  name: string,
  connection: HoloBroadcastConnection,
): NormalizedHoloBroadcastConnection {
  const normalizedName = normalizeOptionalBroadcastString(name, 'Broadcast connection name')
  const driver = normalizeOptionalBroadcastString(connection.driver, `Broadcast connection "${name}" driver`)

  if (!normalizedName || !driver) {
    throw new Error('[Holo Broadcast] Broadcast connections must define a name and driver.')
  }

  const clientOptions = Object.freeze({
    ...((connection.clientOptions as Record<string, unknown> | undefined) ?? {}),
  })

  if (driver === 'holo') {
    return Object.freeze({
      name: normalizedName,
      driver: 'holo' as const,
      key: normalizeOptionalBroadcastString((connection as { key?: string }).key, `Broadcast connection "${name}" key`)
        ?? (() => { throw new Error(`[Holo Broadcast] Broadcast connection "${name}" must define a key.`) })(),
      secret: normalizeOptionalBroadcastString((connection as { secret?: string }).secret, `Broadcast connection "${name}" secret`)
        ?? (() => { throw new Error(`[Holo Broadcast] Broadcast connection "${name}" must define a secret.`) })(),
      appId: normalizeOptionalBroadcastString((connection as { appId?: string | number }).appId, `Broadcast connection "${name}" appId`)
        ?? (() => { throw new Error(`[Holo Broadcast] Broadcast connection "${name}" must define an appId.`) })(),
      options: normalizeBroadcastConnectionOptions(connection.options, DEFAULT_BROADCAST_HOST, DEFAULT_BROADCAST_HTTPS_PORT, `Broadcast connection "${name}" options`),
      clientOptions,
    })
  }

  if (driver === 'pusher') {
    const cluster = normalizeOptionalBroadcastString(connection.options?.cluster, `Broadcast connection "${name}" cluster`) ?? undefined

    return Object.freeze({
      name: normalizedName,
      driver: 'pusher' as const,
      key: normalizeOptionalBroadcastString((connection as { key?: string }).key, `Broadcast connection "${name}" key`)
        ?? (() => { throw new Error(`[Holo Broadcast] Broadcast connection "${name}" must define a key.`) })(),
      secret: normalizeOptionalBroadcastString((connection as { secret?: string }).secret, `Broadcast connection "${name}" secret`)
        ?? (() => { throw new Error(`[Holo Broadcast] Broadcast connection "${name}" must define a secret.`) })(),
      appId: normalizeOptionalBroadcastString((connection as { appId?: string | number }).appId, `Broadcast connection "${name}" appId`)
        ?? (() => { throw new Error(`[Holo Broadcast] Broadcast connection "${name}" must define an appId.`) })(),
      options: normalizeBroadcastConnectionOptions(
        {
          ...connection.options,
          cluster,
        },
        normalizeOptionalBroadcastString(connection.options?.host, `Broadcast connection "${name}" host`) ?? (cluster ? `api-${cluster}.pusher.com` : 'api-mt1.pusher.com'),
        DEFAULT_BROADCAST_HTTPS_PORT,
        `Broadcast connection "${name}" options`,
      ),
      clientOptions,
    })
  }

  if (driver === 'log') {
    return Object.freeze({
      name: normalizedName,
      driver: 'log' as const,
      clientOptions,
    })
  }

  if (driver === 'null') {
    return Object.freeze({
      name: normalizedName,
      driver: 'null' as const,
      clientOptions,
    })
  }

  if (driver === 'ably') {
    throw new Error('[Holo Broadcast] Broadcast driver "ably" is not supported yet.')
  }

  const {
    driver: _ignoredDriver,
    clientOptions: _ignoredClientOptions,
    ...customConfig
  } = connection as Record<string, unknown>

  return Object.freeze({
    driver,
    clientOptions,
    ...customConfig,
    name: normalizedName,
  })
}

export function normalizeBroadcastConfig(
  config: HoloBroadcastConfig = {},
): NormalizedHoloBroadcastConfig {
  const normalizedConnections = Object.fromEntries(
    Object.entries(config.connections ?? holoBroadcastDefaults.connections)
      .map(([name, connection]) => [name, normalizeBroadcastConnection(name, connection)]),
  ) as Record<string, NormalizedHoloBroadcastConnection>

  const defaultConnection = normalizeOptionalBroadcastString(config.default, 'Default broadcast connection')
    ?? holoBroadcastDefaults.default

  if (!normalizedConnections[defaultConnection]) {
    throw new Error(
      `[Holo Broadcast] default broadcast connection "${defaultConnection}" is not configured. `
      + `Available connections: ${Object.keys(normalizedConnections).join(', ')}`,
    )
  }

  return Object.freeze({
    default: defaultConnection,
    connections: Object.freeze(normalizedConnections),
    worker: normalizeBroadcastWorkerConfig(config.worker),
  })
}

function normalizeOptionalMailString(
  value: string | undefined,
  label: string,
): string | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`[Holo Mail] ${label} must be a non-empty string when provided.`)
  }

  return normalized
}

function isValidMailAddress(email: string): boolean {
  if (email.includes(' ')) {
    return false
  }

  const parts = email.split('@')
  return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0
}

function normalizeMailAddress(
  address: HoloMailAddressConfig | undefined,
  label: string,
): NormalizedHoloMailAddressConfig | undefined {
  if (!address) {
    return undefined
  }

  const email = normalizeOptionalMailString(address.email, `${label} email`)?.toLowerCase()
  if (!email || !isValidMailAddress(email)) {
    throw new Error(`[Holo Mail] ${label} email must be a valid email address.`)
  }

  const name = normalizeOptionalMailString(address.name, `${label} name`)

  return Object.freeze({
    email,
    ...(name ? { name } : {}),
  })
}

function normalizeMailQueueConfig(
  queue: HoloMailQueueConfig | undefined,
  fallback: NormalizedHoloMailQueueConfig = holoMailDefaults.queue,
): NormalizedHoloMailQueueConfig {
  return Object.freeze({
    queued: queue?.queued ?? fallback.queued,
    connection: normalizeOptionalMailString(queue?.connection, 'Mail queue connection') ?? fallback.connection,
    queue: normalizeOptionalMailString(queue?.queue, 'Mail queue name') ?? fallback.queue,
    afterCommit: queue?.afterCommit ?? fallback.afterCommit,
  })
}

function normalizeMailPreviewEnvironments(
  environments: readonly HoloAppEnv[] | undefined,
): readonly HoloAppEnv[] {
  if (typeof environments === 'undefined') {
    return holoMailDefaults.preview.allowedEnvironments
  }

  const normalized = new Set<HoloAppEnv>()
  for (const environment of environments) {
    if (environment !== 'development' && environment !== 'production' && environment !== 'test') {
      throw new Error('[Holo Mail] Mail preview environments must be development, production, or test.')
    }

    normalized.add(environment)
  }

  return Object.freeze([...normalized])
}

function normalizeMailMailerConfig(
  name: string,
  config: HoloMailMailerConfig,
  fallback: NormalizedHoloMailMailerConfig | undefined,
): NormalizedHoloMailMailerConfig {
  const normalizedName = normalizeOptionalMailString(name, 'Mail mailer name')
  const driver = normalizeOptionalMailString(config.driver, `Mail mailer "${name}" driver`)
  if (!normalizedName || !driver) {
    throw new Error('[Holo Mail] Mailers must define a name and driver.')
  }

  const base = {
    name: normalizedName,
    driver,
    from: normalizeMailAddress(config.from, `Mail mailer "${name}" from`) ?? fallback?.from,
    replyTo: normalizeMailAddress(config.replyTo, `Mail mailer "${name}" replyTo`) ?? fallback?.replyTo,
    queue: normalizeMailQueueConfig(config.queue, fallback?.queue ?? holoMailDefaults.queue),
  } satisfies NormalizedHoloMailMailerConfig

  if (driver === 'preview') {
    const previewFallback = fallback?.driver === 'preview'
      ? fallback as Extract<NormalizedHoloMailMailerConfig, { readonly driver: 'preview' }>
      : undefined

    return Object.freeze({
      ...base,
      driver: 'preview' as const,
      path: normalizeOptionalMailString((config as { path?: string }).path, `Mail mailer "${name}" preview path`)
        ?? previewFallback?.path
        ?? DEFAULT_MAIL_PREVIEW_PATH,
    })
  }

  if (driver === 'log') {
    const logFallback = fallback?.driver === 'log'
      ? fallback as Extract<NormalizedHoloMailMailerConfig, { readonly driver: 'log' }>
      : undefined

    return Object.freeze({
      ...base,
      driver: 'log' as const,
      logBodies: (config as { logBodies?: boolean }).logBodies ?? logFallback?.logBodies ?? false,
    })
  }

  if (driver === 'fake') {
    return Object.freeze({
      ...base,
      driver: 'fake' as const,
    })
  }

  if (driver === 'smtp') {
    const smtpFallback = fallback?.driver === 'smtp'
      ? fallback as Extract<NormalizedHoloMailMailerConfig, { readonly driver: 'smtp' }>
      : undefined
    const rawPort = (config as { port?: string | number }).port
    const normalizedPort = typeof rawPort === 'number'
      ? rawPort
      : typeof rawPort === 'string' && rawPort.trim()
        ? Number(rawPort.trim())
        : smtpFallback?.port
          ?? DEFAULT_SMTP_PORT

    if (!Number.isFinite(normalizedPort) || normalizedPort <= 0) {
      throw new Error(`[Holo Mail] Mail mailer "${name}" SMTP port must be a positive number.`)
    }

    return Object.freeze({
      ...base,
      driver: 'smtp' as const,
      host: normalizeOptionalMailString((config as { host?: string }).host, `Mail mailer "${name}" SMTP host`)
        ?? smtpFallback?.host
        ?? DEFAULT_SMTP_HOST,
      port: normalizedPort,
      secure: (config as { secure?: boolean }).secure ?? smtpFallback?.secure ?? false,
      user: normalizeOptionalMailString((config as { user?: string }).user, `Mail mailer "${name}" SMTP user`)
        ?? smtpFallback?.user
        ?? undefined,
      password: normalizeOptionalMailString((config as { password?: string }).password, `Mail mailer "${name}" SMTP password`)
        ?? smtpFallback?.password
        ?? undefined,
    })
  }

  const customFields = Object.fromEntries(
    Object.entries(config).filter(([key]) => key !== 'driver' && key !== 'from' && key !== 'replyTo' && key !== 'queue'),
  )

  return Object.freeze({
    ...base,
    ...customFields,
  })
}

export function normalizeMailConfig(
  config: HoloMailConfig = {},
): NormalizedHoloMailConfig {
  const mergedMailers = {
    ...(holoMailDefaults.mailers as Record<string, NormalizedHoloMailMailerConfig>),
  }

  for (const [name, mailer] of Object.entries(config.mailers ?? {})) {
    mergedMailers[name] = normalizeMailMailerConfig(name, mailer, mergedMailers[name])
  }

  const defaultMailer = normalizeOptionalMailString(config.default, 'Default mailer')
    ?? holoMailDefaults.default

  if (!mergedMailers[defaultMailer]) {
    throw new Error(
      `[Holo Mail] default mailer "${defaultMailer}" is not configured. `
      + `Available mailers: ${Object.keys(mergedMailers).join(', ')}`,
    )
  }

  return Object.freeze({
    default: defaultMailer,
    from: normalizeMailAddress(config.from, 'Mail from') ?? holoMailDefaults.from,
    replyTo: normalizeMailAddress(config.replyTo, 'Mail replyTo') ?? holoMailDefaults.replyTo,
    queue: normalizeMailQueueConfig(config.queue),
    preview: Object.freeze({
      allowedEnvironments: normalizeMailPreviewEnvironments(config.preview?.allowedEnvironments),
    }),
    markdown: Object.freeze({
      wrapper: normalizeOptionalMailString(config.markdown?.wrapper, 'Mail markdown wrapper') ?? holoMailDefaults.markdown.wrapper,
    }),
    mailers: Object.freeze(mergedMailers),
  })
}

function normalizeOptionalNotificationsString(
  value: string | undefined,
  label: string,
): string | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`[Holo Notifications] ${label} must be a non-empty string when provided.`)
  }

  return normalized
}

export function normalizeNotificationsConfig(
  config: HoloNotificationsConfig = {},
): NormalizedHoloNotificationsConfig {
  return Object.freeze({
    table: normalizeOptionalNotificationsString(config.table, 'Notifications table')
      ?? DEFAULT_NOTIFICATIONS_TABLE,
    queue: Object.freeze({
      connection: normalizeOptionalNotificationsString(config.queue?.connection, 'Notifications queue connection'),
      queue: normalizeOptionalNotificationsString(config.queue?.queue, 'Notifications queue name'),
      afterCommit: config.queue?.afterCommit === true,
    }),
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
