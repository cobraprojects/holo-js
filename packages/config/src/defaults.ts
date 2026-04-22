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
  BaseBroadcastConnectionConfig,
  BroadcastConnectionOptionsConfig,
  BroadcastWorkerConfig,
  CacheDatabaseDriverConfig,
  CacheDriverConfig,
  CacheFileDriverConfig,
  CacheMemoryDriverConfig,
  CacheRedisDriverConfig,
  HoloBroadcastConfig,
  HoloCacheConfig,
  HoloBroadcastConnection,
  HoloAuthConfig,
  HoloMailAddressConfig,
  HoloMailConfig,
  HoloMailMailerConfig,
  HoloMailQueueConfig,
  HoloRedisConfig,
  HoloRedisClusterNodeConfig,
  HoloRedisConnectionConfig,
  NormalizedQueueConnectionConfig,
  NormalizedAuthGuardConfig,
  NormalizedAuthClerkProviderConfig,
  NormalizedAuthPasswordBrokerConfig,
  NormalizedAuthProviderConfig,
  NormalizedAuthSocialProviderConfig,
  NormalizedAuthWorkosProviderConfig,
  NormalizedBroadcastConnectionOptionsConfig,
  NormalizedBroadcastWorkerConfig,
  NormalizedCacheDatabaseDriverConfig,
  NormalizedCacheDriverConfig,
  NormalizedCacheFileDriverConfig,
  NormalizedCacheMemoryDriverConfig,
  NormalizedCacheRedisDriverConfig,
  NormalizedHoloCacheConfig,
  NormalizedHoloBroadcastConfig,
  NormalizedHoloBroadcastConnection,
  NormalizedHoloAuthConfig,
  NormalizedHoloMailAddressConfig,
  NormalizedHoloMailConfig,
  NormalizedHoloMailMailerConfig,
  NormalizedHoloMailQueueConfig,
  NormalizedHoloRedisConfig,
  NormalizedHoloRedisClusterNodeConfig,
  NormalizedHoloRedisConnectionConfig,
  NormalizedQueueDatabaseConnectionConfig,
  NormalizedQueueFailedStoreConfig,
  NormalizedHoloAppConfig,
  NormalizedHoloDatabaseConfig,
  NormalizedHoloNotificationsConfig,
  NormalizedHoloQueueConfig,
  NormalizedHoloSecurityConfig,
  NormalizedHoloSecurityCsrfConfig,
  NormalizedHoloSecurityRateLimitConfig,
  NormalizedHoloSessionConfig,
  NormalizedHoloStorageConfig,
  HoloAppConfig,
  HoloAppEnv,
  HoloDatabaseConfig,
  HoloNotificationsConfig,
  HoloSessionConfig,
  HoloQueueConfig,
  HoloSecurityConfig,
  HoloSecurityRateLimitConfig,
  HoloStorageConfig,
  QueueConnectionConfig,
  QueueDatabaseConnectionConfig,
  QueueFailedStoreConfig,
  QueueRedisConnectionConfig,
  QueueSyncConnectionConfig,
  SecurityLimiterConfig,
  SecurityRateLimitDriver,
  SessionCookieSameSite,
  SecurityRateLimitFileConfig,
  SecurityRateLimitRedisConfig,
  SessionDatabaseStoreConfig,
  SessionFileStoreConfig,
  SessionRedisStoreConfig,
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

export const DEFAULT_REDIS_CONNECTION = 'default'
export const DEFAULT_REDIS_HOST = '127.0.0.1'
export const DEFAULT_REDIS_PORT = 6379
export const DEFAULT_REDIS_DB = 0

export const holoRedisDefaults: Readonly<NormalizedHoloRedisConfig> = Object.freeze({
  default: DEFAULT_REDIS_CONNECTION,
  connections: Object.freeze({
    [DEFAULT_REDIS_CONNECTION]: Object.freeze({
      name: DEFAULT_REDIS_CONNECTION,
      host: DEFAULT_REDIS_HOST,
      port: DEFAULT_REDIS_PORT,
      username: undefined,
      password: undefined,
      db: DEFAULT_REDIS_DB,
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

export const DEFAULT_CACHE_DRIVER = 'file'
export const DEFAULT_CACHE_PREFIX = ''
export const DEFAULT_CACHE_FILE_PATH = './storage/framework/cache/data'
export const DEFAULT_CACHE_REDIS_CONNECTION = 'default'
export const DEFAULT_CACHE_DATABASE_CONNECTION = 'default'
export const DEFAULT_CACHE_DATABASE_TABLE = 'cache'
export const DEFAULT_CACHE_DATABASE_LOCK_TABLE = 'cache_locks'

export const holoCacheDefaults: Readonly<NormalizedHoloCacheConfig> = Object.freeze({
  default: DEFAULT_CACHE_DRIVER,
  prefix: DEFAULT_CACHE_PREFIX,
  drivers: Object.freeze({
    file: Object.freeze({
      name: 'file',
      driver: 'file' as const,
      path: DEFAULT_CACHE_FILE_PATH,
      prefix: DEFAULT_CACHE_PREFIX,
    }),
    memory: Object.freeze({
      name: 'memory',
      driver: 'memory' as const,
      maxEntries: undefined,
      prefix: DEFAULT_CACHE_PREFIX,
    }),
  }),
})

type CacheNormalizationOptions = {
  readonly database?: NormalizedHoloDatabaseConfig
  readonly redis?: NormalizedHoloRedisConfig
}

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

export const DEFAULT_SECURITY_CSRF_FIELD = '_token'
export const DEFAULT_SECURITY_CSRF_HEADER = 'X-CSRF-TOKEN'
export const DEFAULT_SECURITY_CSRF_COOKIE = 'XSRF-TOKEN'
export const DEFAULT_SECURITY_RATE_LIMIT_DRIVER: SecurityRateLimitDriver = 'memory'
export const DEFAULT_SECURITY_RATE_LIMIT_FILE_PATH = './storage/framework/rate-limits'
export const DEFAULT_SECURITY_RATE_LIMIT_REDIS_CONNECTION = 'default'
export const DEFAULT_SECURITY_RATE_LIMIT_REDIS_PREFIX = 'holo:rate-limit:'

const DEFAULT_SECURITY_CSRF_CONFIG: Readonly<NormalizedHoloSecurityCsrfConfig> = Object.freeze({
  enabled: false,
  field: DEFAULT_SECURITY_CSRF_FIELD,
  header: DEFAULT_SECURITY_CSRF_HEADER,
  cookie: DEFAULT_SECURITY_CSRF_COOKIE,
  except: Object.freeze([]),
})

const DEFAULT_SECURITY_RATE_LIMIT_CONFIG: Readonly<NormalizedHoloSecurityRateLimitConfig> = Object.freeze({
  driver: DEFAULT_SECURITY_RATE_LIMIT_DRIVER,
  memory: Object.freeze({
    driver: 'memory',
  }),
  file: Object.freeze({
    path: DEFAULT_SECURITY_RATE_LIMIT_FILE_PATH,
  }),
  redis: Object.freeze({
    host: DEFAULT_REDIS_HOST,
    port: DEFAULT_REDIS_PORT,
    password: undefined,
    username: undefined,
    db: DEFAULT_REDIS_DB,
    connection: DEFAULT_SECURITY_RATE_LIMIT_REDIS_CONNECTION,
    prefix: DEFAULT_SECURITY_RATE_LIMIT_REDIS_PREFIX,
  }),
  limiters: Object.freeze({}),
})

export const holoSecurityDefaults: Readonly<NormalizedHoloSecurityConfig> = Object.freeze({
  csrf: DEFAULT_SECURITY_CSRF_CONFIG,
  rateLimit: DEFAULT_SECURITY_RATE_LIMIT_CONFIG,
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

function normalizeCacheName(value: string | undefined, label: string): string {
  const normalized = value?.trim()
  if (!normalized) {
    throw new Error(`[Holo Cache] ${label} must be a non-empty string.`)
  }

  return normalized
}

function normalizeCacheOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

function parseCacheInteger(
  value: number | string | undefined,
  label: string,
  options: { minimum?: number } = {},
): number | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  const normalized = typeof value === 'number'
    ? value
    : (() => {
        const trimmed = value.trim()
        if (!trimmed) {
          return Number.NaN
        }

        return Number(trimmed)
      })()

  if (!Number.isFinite(normalized) || !Number.isInteger(normalized)) {
    throw new Error(`[Holo Cache] ${label} must be an integer.`)
  }

  if (typeof options.minimum === 'number' && normalized < options.minimum) {
    throw new Error(`[Holo Cache] ${label} must be greater than or equal to ${options.minimum}.`)
  }

  return normalized
}

function resolveCachePrefix(globalPrefix: string, localPrefix: string | undefined): string {
  return normalizeCacheOptionalString(localPrefix) ?? globalPrefix
}

function normalizeCacheDriverConfig(
  name: string,
  config: CacheDriverConfig,
  globalPrefix: string,
): NormalizedCacheDriverConfig {
  switch (config.driver) {
    case 'memory': {
      const memoryConfig = config as CacheMemoryDriverConfig
      return Object.freeze({
        name,
        driver: 'memory',
        prefix: resolveCachePrefix(globalPrefix, memoryConfig.prefix),
        maxEntries: parseCacheInteger(memoryConfig.maxEntries, `cache driver "${name}" maxEntries`, {
          minimum: 1,
        }),
      } satisfies NormalizedCacheMemoryDriverConfig)
    }
    case 'file': {
      const fileConfig = config as CacheFileDriverConfig
      return Object.freeze({
        name,
        driver: 'file',
        path: normalizeCacheOptionalString(fileConfig.path) || DEFAULT_CACHE_FILE_PATH,
        prefix: resolveCachePrefix(globalPrefix, fileConfig.prefix),
      } satisfies NormalizedCacheFileDriverConfig)
    }
    case 'redis': {
      const redisConfig = config as CacheRedisDriverConfig
      return Object.freeze({
        name,
        driver: 'redis',
        connection: normalizeCacheOptionalString(redisConfig.connection) || DEFAULT_CACHE_REDIS_CONNECTION,
        prefix: resolveCachePrefix(globalPrefix, redisConfig.prefix),
      } satisfies NormalizedCacheRedisDriverConfig)
    }
    case 'database': {
      const databaseConfig = config as CacheDatabaseDriverConfig
      return Object.freeze({
        name,
        driver: 'database',
        connection: normalizeCacheOptionalString(databaseConfig.connection) || DEFAULT_CACHE_DATABASE_CONNECTION,
        table: normalizeCacheOptionalString(databaseConfig.table) || DEFAULT_CACHE_DATABASE_TABLE,
        lockTable: normalizeCacheOptionalString(databaseConfig.lockTable) || DEFAULT_CACHE_DATABASE_LOCK_TABLE,
        prefix: resolveCachePrefix(globalPrefix, databaseConfig.prefix),
      } satisfies NormalizedCacheDatabaseDriverConfig)
    }
    default:
      throw new Error(`[Holo Cache] Unsupported cache driver "${String((config as { driver?: unknown }).driver)}" on driver "${name}".`)
  }
}

export function normalizeCacheConfig(
  config: HoloCacheConfig = {},
  options: CacheNormalizationOptions = {},
): NormalizedHoloCacheConfig {
  const prefix = normalizeCacheOptionalString(config.prefix) ?? DEFAULT_CACHE_PREFIX
  const defaultRedisConnection = options.redis?.default ?? DEFAULT_CACHE_REDIS_CONNECTION
  const defaultDatabaseConnection = options.database?.defaultConnection ?? DEFAULT_CACHE_DATABASE_CONNECTION
  const drivers = !config.drivers || Object.keys(config.drivers).length === 0
    ? holoCacheDefaults.drivers
    : Object.freeze(Object.fromEntries(Object.entries(config.drivers).map(([name, driver]) => {
      const normalizedName = normalizeCacheName(name, 'Cache driver name')
      const driverConfig = (() => {
        switch (driver.driver) {
          case 'redis':
            return {
              ...driver,
              connection: normalizeCacheOptionalString(driver.connection) ?? defaultRedisConnection,
            }
          case 'database':
            return {
              ...driver,
              connection: normalizeCacheOptionalString(driver.connection) ?? defaultDatabaseConnection,
            }
          default:
            return driver
        }
      })()
      return [normalizedName, normalizeCacheDriverConfig(normalizedName, driverConfig, prefix)]
    })))

  const configuredDefault = normalizeCacheOptionalString(config.default)
  const defaultDriver = configuredDefault
    || (DEFAULT_CACHE_DRIVER in drivers ? DEFAULT_CACHE_DRIVER : undefined)
    || Object.keys(drivers)[0]

  if (!defaultDriver || !(defaultDriver in drivers)) {
    throw new Error(`[Holo Cache] default cache driver "${configuredDefault ?? ''}" is not configured.`)
  }

  return Object.freeze({
    default: defaultDriver,
    prefix,
    drivers,
  })
}

function normalizeQueueName(value: string | undefined): string {
  return value?.trim() || DEFAULT_QUEUE_NAME
}

function parseRedisInteger(
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
    : (() => {
        const trimmed = value.trim()
        if (!trimmed || !/^\d+$/.test(trimmed)) {
          return Number.NaN
        }

        return Number.parseInt(trimmed, 10)
      })()

  if (!Number.isInteger(normalized)) {
    throw new Error(`[Holo Redis] ${label} must be an integer.`)
  }

  if (typeof options.minimum === 'number' && normalized < options.minimum) {
    throw new Error(`[Holo Redis] ${label} must be greater than or equal to ${options.minimum}.`)
  }

  return normalized
}

function normalizeRedisConnectionName(value: string | undefined, label: string): string {
  const normalized = value?.trim()
  if (!normalized) {
    throw new Error(`[Holo Redis] ${label} must be a non-empty string.`)
  }

  return normalized
}

function normalizeOptionalRedisString(value: string | undefined, label: string): string | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  const normalized = normalizeRedisConnectionName(value, label)

  try {
    const parsed = new URL(normalized)
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      throw new Error(`[Holo Redis] ${label} must use the redis:// or rediss:// scheme.`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('[Holo Redis]')) {
      throw error
    }

    throw new Error(`[Holo Redis] ${label} must be a valid redis:// or rediss:// URL.`)
  }

  return normalized
}

function normalizeOptionalRedisSocketPath(value: string | undefined, label: string): string | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  return normalizeRedisConnectionName(value, label)
}

function deriveNormalizedRedisSocketPath(socketPath: string | undefined, host: string | undefined): string | undefined {
  if (socketPath) {
    return socketPath
  }

  if (typeof host === 'string' && (host.startsWith('unix://') || host.startsWith('/'))) {
    return host.startsWith('unix://')
      ? host.slice('unix://'.length)
      : host
  }

  return undefined
}

function normalizeRedisClusterNodeConfig(
  connectionName: string,
  index: number,
  config: HoloRedisClusterNodeConfig,
): NormalizedHoloRedisClusterNodeConfig {
  const label = `redis connection "${connectionName}" cluster node ${index + 1}`
  const url = normalizeOptionalRedisString(config.url, `${label} url`)
  const socketPath = normalizeOptionalRedisSocketPath(config.socketPath, `${label} socketPath`)
  const normalizedSocketPath = deriveNormalizedRedisSocketPath(socketPath, config.host?.trim())

  if (typeof normalizedSocketPath !== 'undefined') {
    throw new Error(`[Holo Redis] ${label} cannot use socketPath in cluster mode.`)
  }

  parseRedisDatabaseFromUrl(url, {
    allowPath: false,
    label: `${label} url`,
  })

  const host = config.host?.trim() || DEFAULT_REDIS_HOST

  return Object.freeze({
    ...(typeof url === 'undefined' ? {} : { url }),
    host,
    port: parseRedisInteger(config.port, DEFAULT_REDIS_PORT, `${label} port`, {
      minimum: 1,
    }),
  })
}

function normalizeRedisClusterNodes(
  connectionName: string,
  nodes: readonly HoloRedisClusterNodeConfig[] | undefined,
): readonly NormalizedHoloRedisClusterNodeConfig[] | undefined {
  if (!nodes || nodes.length === 0) {
    return undefined
  }

  return Object.freeze(nodes.map((node, index) => normalizeRedisClusterNodeConfig(connectionName, index, node)))
}

function parseRedisDatabaseFromUrl(
  url: string | undefined,
  options: {
    allowPath?: boolean
    label?: string
  } = {},
): number | undefined {
  if (typeof url === 'undefined') {
    return undefined
  }

  try {
    const parsed = new URL(url)
    const pathname = parsed.pathname.replace(/^\/+/, '')
    if (!pathname) {
      return undefined
    }

    const [databaseSegment] = pathname.split('/')
    const label = options.label ?? 'Redis URL'

    if (options.allowPath === false) {
      throw new Error(`[Holo Redis] ${label} cannot include a database path in cluster mode.`)
    }

    if (!databaseSegment || !/^\d+$/.test(databaseSegment) || pathname !== databaseSegment) {
      throw new Error(`[Holo Redis] ${label} database path must be a single integer segment.`)
    }

    return Number.parseInt(databaseSegment, 10)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('[Holo Redis]')) {
      throw error
    }

    return undefined
  }
}

function normalizeRedisConnectionConfig(
  name: string,
  config: HoloRedisConnectionConfig,
): NormalizedHoloRedisConnectionConfig {
  const url = normalizeOptionalRedisString(config.url, `redis connection "${name}" url`)
  const clusters = normalizeRedisClusterNodes(name, config.clusters)
  const socketPath = normalizeOptionalRedisSocketPath(config.socketPath, `redis connection "${name}" socketPath`)
  const normalizedSocketPath = deriveNormalizedRedisSocketPath(socketPath, config.host?.trim())
  const targetModeCount = [url, clusters, normalizedSocketPath].filter(value => typeof value !== 'undefined').length

  if (targetModeCount > 1) {
    throw new Error(`[Holo Redis] redis connection "${name}" must configure exactly one target mode: url, clusters, or socketPath.`)
  }

  const host = config.host?.trim() || normalizedSocketPath || DEFAULT_REDIS_HOST
  const databaseFromUrl = parseRedisDatabaseFromUrl(url, {
    label: `redis connection "${name}" url`,
  })
  const database = parseRedisInteger(config.db ?? databaseFromUrl, DEFAULT_REDIS_DB, `redis connection "${name}" db`, {
    minimum: 0,
  })

  if (typeof clusters !== 'undefined' && database !== 0) {
    throw new Error(`[Holo Redis] redis connection "${name}" cannot select redis.db=${database} in cluster mode; Redis Cluster only supports database 0.`)
  }

  return Object.freeze({
    name,
    ...(typeof url === 'undefined' ? {} : { url }),
    ...(typeof clusters === 'undefined' ? {} : { clusters }),
    ...(typeof normalizedSocketPath === 'undefined' ? {} : { socketPath: normalizedSocketPath }),
    host,
    port: parseRedisInteger(config.port, DEFAULT_REDIS_PORT, `redis connection "${name}" port`, {
      minimum: 1,
    }),
    username: config.username?.trim() || undefined,
    password: config.password?.trim() || undefined,
    db: database,
  })
}

function normalizeRedisConnections(
  connections: Readonly<Record<string, HoloRedisConnectionConfig>> | undefined,
): Readonly<Record<string, NormalizedHoloRedisConnectionConfig>> {
  if (!connections || Object.keys(connections).length === 0) {
    return holoRedisDefaults.connections
  }

  return Object.freeze(Object.fromEntries(
    Object.entries(connections).map(([name, config]) => {
      const normalizedName = normalizeRedisConnectionName(name, 'Redis connection name')
      return [normalizedName, normalizeRedisConnectionConfig(normalizedName, config)] as const
    }),
  ))
}

function resolveNormalizedRedisConnection(
  redisConfig: NormalizedHoloRedisConfig | undefined,
  connectionName: string,
  label: string,
): NormalizedHoloRedisConnectionConfig {
  const connections = redisConfig?.connections ?? holoRedisDefaults.connections
  const resolved = connections[connectionName]
  if (!resolved) {
    throw new Error(`[Holo Redis] ${label} "${connectionName}" is not configured.`)
  }

  return resolved
}

function parseSecurityInteger(
  value: number | string | undefined,
  fallback: number,
  label: string,
  options: { minimum?: number } = {},
): number {
  const normalized = typeof value === 'undefined'
    ? fallback
    : typeof value === 'number'
      ? value
      : (() => {
          const trimmed = value.trim()
          if (!trimmed) {
            return Number.NaN
          }

          return Number(trimmed)
        })()

  if (!Number.isFinite(normalized) || !Number.isInteger(normalized)) {
    throw new Error(`[Holo Security] ${label} must be an integer.`)
  }

  if (typeof options.minimum === 'number' && normalized < options.minimum) {
    throw new Error(`[Holo Security] ${label} must be greater than or equal to ${options.minimum}.`)
  }

  return normalized
}

function normalizeSecurityName(value: string | undefined, label: string): string {
  const normalized = value?.trim()
  if (!normalized) {
    throw new Error(`[Holo Security] ${label} must be a non-empty string.`)
  }

  return normalized
}

function normalizeSecurityOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
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
  redisConfig?: NormalizedHoloRedisConfig,
): NormalizedQueueConnectionConfig {
  const explicitConnectionName = config.connection?.trim()
  const connectionName = explicitConnectionName || redisConfig?.default
  if (!connectionName) {
    throw new Error(
      `[@holo-js/config] Queue Redis connection "${name}" requires a top-level redis config with a default connection or an explicit connection name.`,
    )
  }

  if (!redisConfig) {
    throw new Error(
      `[@holo-js/config] Queue Redis connection "${name}" references shared Redis connection "${connectionName}" but no top-level redis config is loaded.`,
    )
  }

  const resolvedRedisConnection = resolveNormalizedRedisConnection(
    redisConfig,
    connectionName,
    'Queue Redis connection',
  )

  return Object.freeze({
    name,
    driver: 'redis',
    connection: resolvedRedisConnection.name,
    queue: normalizeQueueName(config.queue),
    retryAfter: parseInteger(config.retryAfter, DEFAULT_QUEUE_RETRY_AFTER, `queue connection "${name}" retryAfter`, {
      minimum: 0,
    }),
    blockFor: parseInteger(config.blockFor, DEFAULT_QUEUE_BLOCK_FOR, `queue connection "${name}" blockFor`, {
      minimum: 0,
    }),
    redis: Object.freeze({
      ...(typeof resolvedRedisConnection.url === 'undefined' ? {} : { url: resolvedRedisConnection.url }),
      ...(typeof resolvedRedisConnection.clusters === 'undefined' ? {} : { clusters: resolvedRedisConnection.clusters }),
      host: resolvedRedisConnection.host,
      port: resolvedRedisConnection.port,
      password: resolvedRedisConnection.password,
      username: resolvedRedisConnection.username,
      db: resolvedRedisConnection.db,
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
  redisConfig?: NormalizedHoloRedisConfig,
): NormalizedQueueConnectionConfig {
  switch (config.driver) {
    case 'sync':
      return normalizeSyncConnection(name, config)
    case 'redis':
      return normalizeRedisConnection(name, config, redisConfig)
    case 'database':
      return normalizeDatabaseConnection(name, config)
    default:
      throw new Error(`[Holo Queue] Unsupported queue driver "${String((config as { driver?: unknown }).driver)}" on connection "${name}".`)
  }
}

function normalizeConnections(
  connections: Readonly<Record<string, QueueConnectionConfig>> | undefined,
  redisConfig?: NormalizedHoloRedisConfig,
): Readonly<Record<string, NormalizedQueueConnectionConfig>> {
  if (!connections || Object.keys(connections).length === 0) {
    return DEFAULT_QUEUE_CONFIG.connections
  }

  const normalizedEntries = Object.entries(connections).map(([name, config]) => {
    const normalizedName = normalizeConnectionName(name, 'Queue connection name')
    return [normalizedName, normalizeConnectionConfig(normalizedName, config, redisConfig)] as const
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
  redisConfig?: NormalizedHoloRedisConfig,
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
      const redisStoreConfig = config as SessionRedisStoreConfig
      const configuredConnection = redisStoreConfig.connection?.trim()
      const connectionName = configuredConnection || redisConfig?.default
      if (!connectionName) {
        throw new Error(
          `[@holo-js/config] Session Redis store "${name}" requires a top-level redis config with a default connection or an explicit connection name.`,
        )
      }

      if (!redisConfig) {
        throw new Error(
          `[@holo-js/config] Session Redis store "${name}" references shared Redis connection "${connectionName}" but no top-level redis config is loaded.`,
        )
      }

      const resolvedConnection = resolveNormalizedRedisConnection(
        redisConfig,
        connectionName,
        'Session Redis store',
      )

      return Object.freeze({
        name,
        driver: 'redis',
        connection: resolvedConnection.name,
        ...(typeof resolvedConnection.url === 'undefined' ? {} : { url: resolvedConnection.url }),
        ...(typeof resolvedConnection.clusters === 'undefined' ? {} : { clusters: resolvedConnection.clusters }),
        host: resolvedConnection.host,
        port: resolvedConnection.port,
        username: resolvedConnection.username,
        password: resolvedConnection.password,
        db: resolvedConnection.db,
        prefix: redisStoreConfig.prefix?.trim() || '',
      })
    }
    default:
      throw new Error(`[Holo Session] Unsupported session store driver "${String((config as { driver?: unknown }).driver)}" on store "${name}".`)
  }
  /* v8 ignore stop */
}

export function normalizeSessionConfig(
  config: HoloSessionConfig = {},
  redisConfig?: NormalizedHoloRedisConfig,
): NormalizedHoloSessionConfig {
  const stores = !config.stores || Object.keys(config.stores).length === 0
    ? holoSessionDefaults.stores
    : Object.freeze(Object.fromEntries(Object.entries(config.stores).map(([name, store]) => {
      const normalizedName = normalizeConnectionName(name, 'Session store name')
      return [normalizedName, normalizeSessionStoreConfig(normalizedName, store, redisConfig)]
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

function normalizeSecurityLimiter(
  name: string,
  config: SecurityLimiterConfig,
): NormalizedHoloSecurityRateLimitConfig['limiters'][string] {
  const key = typeof config.key === 'function'
    ? config.key
    : undefined

  if (typeof config.key !== 'undefined' && typeof config.key !== 'function') {
    throw new Error(`[Holo Security] rate limiter "${name}" key resolver must be a function when provided.`)
  }

  return Object.freeze({
    name,
    maxAttempts: parseSecurityInteger(config.maxAttempts, 0, `rate limiter "${name}" maxAttempts`, {
      minimum: 1,
    }),
    decaySeconds: parseSecurityInteger(config.decaySeconds, 0, `rate limiter "${name}" decaySeconds`, {
      minimum: 1,
    }),
    ...(key ? { key } : {}),
  })
}

function normalizeSecurityRateLimitConfig(
  config: HoloSecurityRateLimitConfig | undefined,
  redisConfig?: NormalizedHoloRedisConfig,
): NormalizedHoloSecurityRateLimitConfig {
  const driver = normalizeSecurityOptionalString(config?.driver) || DEFAULT_SECURITY_RATE_LIMIT_DRIVER
  if (driver !== 'memory' && driver !== 'file' && driver !== 'redis') {
    throw new Error(`[Holo Security] Unsupported rate limit driver "${driver}".`)
  }

  const file = (config?.file ?? {}) as SecurityRateLimitFileConfig
  const redis = (config?.redis ?? {}) as SecurityRateLimitRedisConfig
  const limiters = !config?.limiters || Object.keys(config.limiters).length === 0
    ? holoSecurityDefaults.rateLimit.limiters
    : Object.freeze(Object.fromEntries(Object.entries(config.limiters).map(([name, limiter]) => {
      const normalizedName = normalizeSecurityName(name, 'Rate limiter name')
      return [normalizedName, normalizeSecurityLimiter(normalizedName, limiter)]
    })))

  return Object.freeze({
    driver,
    memory: Object.freeze({
      driver: 'memory',
    }),
    file: Object.freeze({
      path: normalizeSecurityOptionalString(file.path) || DEFAULT_SECURITY_RATE_LIMIT_FILE_PATH,
    }),
    redis: Object.freeze((() => {
      const connectionName = normalizeSecurityOptionalString(redis.connection)
        || redisConfig?.default
        || DEFAULT_SECURITY_RATE_LIMIT_REDIS_CONNECTION
      const resolvedConnection = redisConfig
        ? resolveNormalizedRedisConnection(
            redisConfig,
            connectionName,
            'Security rate-limit Redis connection',
          )
        : driver === 'redis'
          ? (() => {
              throw new Error(
                `[@holo-js/config] Security rate-limit Redis config references shared Redis connection "${connectionName}" but no top-level redis config is loaded.`,
              )
            })()
          : {
              name: connectionName,
              host: DEFAULT_REDIS_HOST,
              port: DEFAULT_REDIS_PORT,
              password: undefined,
              username: undefined,
              db: DEFAULT_REDIS_DB,
            }

      return {
        ...(typeof resolvedConnection.url === 'undefined' ? {} : { url: resolvedConnection.url }),
        ...(typeof resolvedConnection.clusters === 'undefined' ? {} : { clusters: resolvedConnection.clusters }),
        host: resolvedConnection.host,
        port: resolvedConnection.port,
        password: resolvedConnection.password,
        username: resolvedConnection.username,
        db: resolvedConnection.db,
        connection: resolvedConnection.name,
        prefix: normalizeSecurityOptionalString(redis.prefix) || DEFAULT_SECURITY_RATE_LIMIT_REDIS_PREFIX,
      }
    })()),
    limiters,
  })
}

export function normalizeSecurityConfig(
  config: HoloSecurityConfig = {},
  redisConfig?: NormalizedHoloRedisConfig,
): NormalizedHoloSecurityConfig {
  const csrf = typeof config.csrf === 'boolean'
    ? { enabled: config.csrf }
    : (config.csrf ?? {})

  const except = csrf.except
    ? Object.freeze(csrf.except.map((value, index) => {
      const normalized = value.trim()
      if (!normalized) {
        throw new Error(`[Holo Security] csrf except entry at index ${index} must be a non-empty string.`)
      }

      return normalized
    }))
    : DEFAULT_SECURITY_CSRF_CONFIG.except

  return Object.freeze({
    csrf: Object.freeze({
      enabled: csrf.enabled ?? DEFAULT_SECURITY_CSRF_CONFIG.enabled,
      field: normalizeSecurityOptionalString(csrf.field) || DEFAULT_SECURITY_CSRF_FIELD,
      header: normalizeSecurityOptionalString(csrf.header) || DEFAULT_SECURITY_CSRF_HEADER,
      cookie: normalizeSecurityOptionalString(csrf.cookie) || DEFAULT_SECURITY_CSRF_COOKIE,
      except,
    }),
    rateLimit: normalizeSecurityRateLimitConfig(config.rateLimit, redisConfig),
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

  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`[Holo Broadcast] ${label} must be a positive integer.`)
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
  label: string,
): NormalizedBroadcastConnectionOptionsConfig {
  const scheme = normalizeBroadcastScheme(
    options?.scheme,
    options?.useTLS === false ? 'http' : 'https',
    `${label} scheme`,
  )
  const resolvedFallbackPort = scheme === 'http' ? DEFAULT_BROADCAST_HTTP_PORT : DEFAULT_BROADCAST_HTTPS_PORT

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
      options: normalizeBroadcastConnectionOptions(connection.options, DEFAULT_BROADCAST_HOST, `Broadcast connection "${name}" options`),
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
  } = connection as BaseBroadcastConnectionConfig

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

export function normalizeRedisConfig(
  config: HoloRedisConfig = {},
): NormalizedHoloRedisConfig {
  const connections = normalizeRedisConnections(config.connections)
  const connectionNames = Object.keys(connections)
  const defaultConnection = config.default?.trim() || connectionNames[0]!

  if (!connections[defaultConnection]) {
    throw new Error(
      `[Holo Redis] default redis connection "${defaultConnection}" is not configured. `
      + `Available connections: ${connectionNames.join(', ')}`,
    )
  }

  return Object.freeze({
    default: defaultConnection,
    connections,
  })
}

export function normalizeQueueConfigForHolo(
  config: HoloQueueConfig = {},
  redisConfig?: NormalizedHoloRedisConfig,
): NormalizedHoloQueueConfig {
  const connections = normalizeConnections(config.connections, redisConfig)
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
