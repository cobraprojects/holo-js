import type {
  NormalizedQueueConnectionConfig,
  NormalizedQueueDatabaseConnectionConfig,
  NormalizedQueueFailedStoreConfig,
  QueueSharedRedisConfig,
  QueueSharedRedisConnectionConfig,
  NormalizedQueueRedisConnectionConfig,
  NormalizedQueueSyncConnectionConfig,
  NormalizedHoloQueueConfig,
  QueueConnectionConfig,
  QueueDatabaseConnectionConfig,
  QueueFailedStoreConfig,
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
  NormalizedHoloQueueConfig,
  QueueConnectionConfig,
  QueueDatabaseConnectionConfig,
  QueueFailedStoreConfig,
  QueueRedisConnectionConfig,
  QueueSyncConnectionConfig,
  HoloQueueConfig,
} from './contracts'

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

function normalizeRedisConnection(
  name: string,
  config: QueueRedisConnectionConfig,
  redisConfig?: QueueSharedRedisConfig,
): NormalizedQueueRedisConnectionConfig {
  const explicitConnectionName = config.connection?.trim()
  const connectionName = explicitConnectionName || redisConfig?.default
  if (!connectionName) {
    throw new Error(
      `[Holo Queue] Queue Redis connection "${name}" requires a shared Redis config with a default connection or an explicit connection name.`,
    )
  }

  if (!redisConfig) {
    throw new Error(
      `[Holo Queue] Queue Redis connection "${name}" references shared Redis connection "${connectionName}" but no shared Redis config was provided.`,
    )
  }

  const resolvedRedisConnection = resolveSharedRedisConnection(redisConfig, connectionName)

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
  redisConfig?: QueueSharedRedisConfig,
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
