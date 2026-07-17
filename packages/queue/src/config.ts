import type {
  NormalizedQueueConnectionConfig,
  NormalizedQueueDatabaseConnectionConfig,
  NormalizedQueueFailedStoreConfig,
  QueueSharedRedisConfig,
  QueueSharedRedisConnectionConfig,
  NormalizedQueueRedisConnectionConfig,
  NormalizedQueueSyncConnectionConfig,
  NormalizedQueuePluginConnectionConfig,
  NormalizedHoloQueueConfig,
  QueueConnectionConfig,
  QueueDatabaseConnectionConfig,
  QueueFailedStoreConfig,
  QueuePluginConnectionConfig,
  QueueRedisConnectionConfig,
  QueueSyncConnectionConfig,
  HoloQueueConfig,
} from './contracts'

export type {
  NormalizedQueueConnectionConfig,
  NormalizedQueueDatabaseConnectionConfig,
  NormalizedQueueFailedStoreConfig,
  QueueSharedRedisConfig,
  QueueSharedRedisConnectionConfig,
  NormalizedQueueRedisConnectionConfig,
  NormalizedQueueSyncConnectionConfig,
  NormalizedQueuePluginConnectionConfig,
  NormalizedHoloQueueConfig,
  QueueConnectionConfig,
  QueueDatabaseConnectionConfig,
  QueueFailedStoreConfig,
  QueuePluginConnectionConfig,
  QueueRedisConnectionConfig,
  QueueSyncConnectionConfig,
  HoloQueueConfig,
} from './contracts'

type QueueRedisInlineConfig = NonNullable<QueueRedisConnectionConfig['redis']>
type QueueRedisInlineClusterNodes = NonNullable<QueueRedisInlineConfig['clusters']>

export const DEFAULT_QUEUE_CONNECTION = 'sync'
export const DEFAULT_QUEUE_NAME = 'default'
export const DEFAULT_QUEUE_RETRY_AFTER = 90
export const DEFAULT_QUEUE_BLOCK_FOR = 5
export const DEFAULT_QUEUE_SLEEP = 1
export const DEFAULT_FAILED_JOBS_CONNECTION = 'default'
export const DEFAULT_FAILED_JOBS_TABLE = 'failed_jobs'
export const DEFAULT_DATABASE_QUEUE_TABLE = 'jobs'
export const DEFAULT_REDIS_HOST = '127.0.0.1'
export const DEFAULT_REDIS_PORT = 6379
export const DEFAULT_REDIS_DB = 0

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
    : value.trim()

  if (typeof normalized === 'string' && !/^[+-]?\d+$/.test(normalized)) {
    throw new Error(`[Holo Queue] ${label} must be an integer.`)
  }

  const integer = typeof normalized === 'number'
    ? normalized
    : Number(normalized)

  if (!Number.isInteger(integer)) {
    throw new Error(`[Holo Queue] ${label} must be an integer.`)
  }

  if (typeof options.minimum === 'number' && integer < options.minimum) {
    throw new Error(`[Holo Queue] ${label} must be greater than or equal to ${options.minimum}.`)
  }

  return integer
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

function normalizeOptionalRedisString(value: string | undefined): string | undefined {
  return value?.trim() || undefined
}

function normalizeSyncConnection(
  name: string,
  config: QueueSyncConnectionConfig,
): NormalizedQueueSyncConnectionConfig {
  return Object.freeze({
    name,
    driver: 'sync',
    queue: normalizeQueueName(config.queue),
  })
}

function resolveSharedRedisConnection(
  redisConfig: QueueSharedRedisConfig,
  connectionName: string,
): QueueSharedRedisConnectionConfig {
  const resolvedConnection = redisConfig.connections[connectionName]
  if (!resolvedConnection) {
    const availableConnections = Object.keys(redisConfig.connections)
    throw new Error(
      `[Holo Queue] Queue Redis connection "${connectionName}" was not found in shared Redis config. `
      + `Available connections: ${availableConnections.join(', ') || '(none)'}.`,
    )
  }

  return resolvedConnection
}

function parseRedisDatabaseFromUrl(url: string | undefined, label: string): number | undefined {
  if (typeof url === 'undefined') {
    return undefined
  }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (error) {
    throw new Error(`[Holo Queue] ${label} is invalid: ${String(error)}`)
  }

  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(`[Holo Queue] ${label} is invalid: unsupported protocol "${parsed.protocol}".`)
  }

  const pathname = parsed.pathname.replace(/^\/+/, '')
  if (!pathname) {
    return undefined
  }

  const [databaseSegment] = pathname.split('/')
  if (!databaseSegment || !/^\d+$/.test(databaseSegment) || pathname !== databaseSegment) {
    throw new Error(`[Holo Queue] ${label} must include at most one integer database path segment.`)
  }

  return Number(databaseSegment)
}

function normalizeRedisClusterNodes(
  connectionName: string,
  nodes: QueueRedisInlineClusterNodes | undefined,
): NormalizedQueueRedisConnectionConfig['redis']['clusters'] {
  if (!nodes || nodes.length === 0) {
    return undefined
  }

  return Object.freeze(nodes.map((node, index) => {
    const label = `queue connection "${connectionName}" redis cluster node ${index + 1}`
    const url = normalizeOptionalRedisString(node.url)

    if (typeof url !== 'undefined') {
      const database = parseRedisDatabaseFromUrl(url, `${label} url`)
      if (typeof database !== 'undefined') {
        throw new Error(`[Holo Queue] ${label} url cannot include a database path in cluster mode.`)
      }
    }

    return Object.freeze({
      ...(typeof url === 'undefined' ? {} : { url }),
      host: normalizeOptionalRedisString(node.host) ?? DEFAULT_REDIS_HOST,
      port: parseInteger(node.port, DEFAULT_REDIS_PORT, `${label} port`, {
        minimum: 1,
      }),
    })
  }))
}

function normalizeRedisOptions(
  connectionName: string,
  base: QueueSharedRedisConnectionConfig | undefined,
  overrides: QueueRedisConnectionConfig['redis'] | undefined,
): NormalizedQueueRedisConnectionConfig['redis'] {
  const hasTargetOverride = typeof overrides?.url !== 'undefined'
    || typeof overrides?.clusters !== 'undefined'
    || typeof overrides?.host !== 'undefined'
    || typeof overrides?.port !== 'undefined'
  const url = normalizeOptionalRedisString(overrides?.url) ?? (hasTargetOverride ? undefined : base?.url)
  const clusters = typeof overrides?.clusters === 'undefined'
    ? hasTargetOverride ? undefined : base?.clusters
    : normalizeRedisClusterNodes(connectionName, overrides.clusters)
  const dbFromUrl = parseRedisDatabaseFromUrl(url, `queue connection "${connectionName}" redis url`)
  const db = parseInteger(overrides?.db ?? base?.db ?? dbFromUrl, DEFAULT_REDIS_DB, `queue connection "${connectionName}" redis db`, {
    minimum: 0,
  })

  if (typeof clusters !== 'undefined' && db !== 0) {
    throw new Error(`[Holo Queue] queue connection "${connectionName}" cannot select redis.db=${db} in cluster mode; Redis Cluster only supports database 0.`)
  }

  return Object.freeze({
    ...(typeof url === 'undefined' ? {} : { url }),
    ...(typeof clusters === 'undefined' ? {} : { clusters }),
    host: normalizeOptionalRedisString(overrides?.host) ?? base?.host ?? DEFAULT_REDIS_HOST,
    port: parseInteger(overrides?.port ?? base?.port, DEFAULT_REDIS_PORT, `queue connection "${connectionName}" redis port`, {
      minimum: 1,
    }),
    password: normalizeOptionalRedisString(overrides?.password) ?? base?.password,
    username: normalizeOptionalRedisString(overrides?.username) ?? base?.username,
    db,
  })
}

function normalizeRedisConnection(
  name: string,
  config: QueueRedisConnectionConfig,
  redisConfig?: QueueSharedRedisConfig,
): NormalizedQueueRedisConnectionConfig {
  const explicitConnectionName = config.connection?.trim()
  const connectionName = explicitConnectionName || redisConfig?.default
  if (!connectionName && !config.redis) {
    throw new Error(
      `[Holo Queue] Queue Redis connection "${name}" requires a shared Redis config with a default connection or an explicit connection name.`,
    )
  }

  if (!redisConfig && !config.redis) {
    throw new Error(
      `[Holo Queue] Queue Redis connection "${name}" references shared Redis connection "${connectionName}" but no shared Redis config was provided.`,
    )
  }

  const resolvedRedisConnection = redisConfig && connectionName
    ? resolveSharedRedisConnection(redisConfig, connectionName)
    : undefined

  return Object.freeze({
    name,
    driver: 'redis',
    connection: resolvedRedisConnection?.name ?? connectionName ?? name,
    queue: normalizeQueueName(config.queue),
    retryAfter: parseInteger(config.retryAfter, DEFAULT_QUEUE_RETRY_AFTER, `queue connection "${name}" retryAfter`, {
      minimum: 0,
    }),
    blockFor: parseInteger(config.blockFor, DEFAULT_QUEUE_BLOCK_FOR, `queue connection "${name}" blockFor`, {
      minimum: 0,
    }),
    redis: normalizeRedisOptions(name, resolvedRedisConnection, config.redis),
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

function normalizePluginConnection(
  name: string,
  config: QueuePluginConnectionConfig,
): NormalizedQueuePluginConnectionConfig {
  const { driver, queue, ...options } = config

  return Object.freeze({
    ...options,
    name,
    driver: normalizeConnectionName(driver, `queue connection "${name}" driver`),
    queue: normalizeQueueName(queue),
  })
}

function normalizeConnectionConfig(
  name: string,
  config: QueueConnectionConfig,
  redisConfig?: QueueSharedRedisConfig,
): NormalizedQueueConnectionConfig {
  switch (config.driver) {
    case 'sync':
      return normalizeSyncConnection(name, config as QueueSyncConnectionConfig)
    case 'redis':
      return normalizeRedisConnection(name, config as QueueRedisConnectionConfig, redisConfig)
    case 'database':
      return normalizeDatabaseConnection(name, config as QueueDatabaseConnectionConfig)
    default:
      return normalizePluginConnection(name, config as QueuePluginConnectionConfig)
  }
}

function normalizeConnections(
  connections: Readonly<Record<string, QueueConnectionConfig>> | undefined,
  redisConfig?: QueueSharedRedisConfig,
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

export function normalizeQueueConfig(
  config: HoloQueueConfig = {},
  redisConfig?: QueueSharedRedisConfig,
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

export const holoQueueDefaults = DEFAULT_QUEUE_CONFIG

export const queueInternals = {
  parseInteger,
}

registerConfigNormalizer<HoloQueueConfig, NormalizedHoloQueueConfig>({
  name: 'queue',
  dependencies: ['redis'],
  normalize(config, context) {
    return normalizeQueueConfig(config, context.has('redis') ? context.get<QueueSharedRedisConfig>('redis') : undefined)
  },
})
import type {} from '@holo-js/config'
import { registerConfigNormalizer } from '@holo-js/config/registry'
declare module '@holo-js/config' {
  interface HoloConfigRegistry {
    queue: NormalizedHoloQueueConfig
  }
}
