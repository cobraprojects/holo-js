export interface HoloRedisConnectionConfig {
  readonly url?: string
  readonly clusters?: readonly HoloRedisClusterNodeConfig[]
  readonly socketPath?: string
  readonly host?: string
  readonly port?: number | string
  readonly username?: string
  readonly password?: string
  readonly db?: number | string
}

export interface HoloRedisClusterNodeConfig {
  readonly url?: string
  readonly socketPath?: string
  readonly host?: string
  readonly port?: number | string
}

export interface HoloRedisConfig {
  readonly default?: string
  readonly connections?: Readonly<Record<string, HoloRedisConnectionConfig>>
}

export interface NormalizedHoloRedisConnectionConfig {
  readonly name: string
  readonly url?: string
  readonly clusters?: readonly NormalizedHoloRedisClusterNodeConfig[]
  readonly socketPath?: string
  readonly host: string
  readonly port: number
  readonly username?: string
  readonly password?: string
  readonly db: number
}

export interface NormalizedHoloRedisClusterNodeConfig {
  readonly url?: string
  readonly socketPath?: string
  readonly host: string
  readonly port: number
}

export interface NormalizedHoloRedisConfig {
  readonly default: string
  readonly connections: Readonly<Record<string, NormalizedHoloRedisConnectionConfig>>
}

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

function normalizeName(value: string | undefined, label: string): string {
  const normalized = value?.trim()
  if (!normalized) {
    throw new Error(`[Holo Redis] ${label} must be a non-empty string.`)
  }

  return normalized
}

function parseInteger(
  value: number | string | undefined,
  fallback: number,
  label: string,
  minimum: number,
): number {
  if (typeof value === 'undefined') {
    return fallback
  }

  const normalized = typeof value === 'number'
    ? value
    : /^\d+$/.test(value.trim())
      ? Number.parseInt(value.trim(), 10)
      : Number.NaN
  if (!Number.isSafeInteger(normalized)) {
    throw new Error(`[Holo Redis] ${label} must be an integer.`)
  }
  if (normalized < minimum) {
    throw new Error(`[Holo Redis] ${label} must be greater than or equal to ${minimum}.`)
  }

  return normalized
}

function normalizeUrl(value: string | undefined, label: string): string | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  const normalized = normalizeName(value, label)
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

function parseDatabaseFromUrl(
  url: string | undefined,
  label: string,
  allowPath: boolean,
): number | undefined {
  if (typeof url === 'undefined') {
    return undefined
  }

  try {
    const pathname = new URL(url).pathname.replace(/^\/+/, '')
    if (!pathname) {
      return undefined
    }
    if (!allowPath) {
      throw new Error(`[Holo Redis] ${label} cannot include a database path in cluster mode.`)
    }

    const [databaseSegment] = pathname.split('/')
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

function normalizeClusterNode(
  connectionName: string,
  index: number,
  config: HoloRedisClusterNodeConfig,
): NormalizedHoloRedisClusterNodeConfig {
  const label = `redis connection "${connectionName}" cluster node ${index + 1}`
  const url = normalizeUrl(config.url, `${label} url`)
  const socketPath = config.socketPath?.trim()
  const hostValue = config.host?.trim()
  if (socketPath || hostValue?.startsWith('unix://') || hostValue?.startsWith('/')) {
    throw new Error(`[Holo Redis] ${label} cannot use socketPath in cluster mode.`)
  }

  parseDatabaseFromUrl(url, `${label} url`, false)
  return Object.freeze({
    ...(typeof url === 'undefined' ? {} : { url }),
    host: hostValue || DEFAULT_REDIS_HOST,
    port: parseInteger(config.port, DEFAULT_REDIS_PORT, `${label} port`, 1),
  })
}

function normalizeConnection(
  name: string,
  config: HoloRedisConnectionConfig,
): NormalizedHoloRedisConnectionConfig {
  const url = normalizeUrl(config.url, `redis connection "${name}" url`)
  const clusters = config.clusters?.length
    ? Object.freeze(config.clusters.map((node, index) => normalizeClusterNode(name, index, node)))
    : undefined
  const explicitSocketPath = config.socketPath?.trim()
  const hostValue = config.host?.trim()
  const socketPath = explicitSocketPath
    || (hostValue?.startsWith('unix://') ? hostValue.slice('unix://'.length) : undefined)
    || (hostValue?.startsWith('/') ? hostValue : undefined)
  const targetCount = [url, clusters, socketPath].filter(value => typeof value !== 'undefined').length
  if (targetCount > 1) {
    throw new Error(`[Holo Redis] redis connection "${name}" must configure exactly one target mode: url, clusters, or socketPath.`)
  }

  const database = parseInteger(
    config.db ?? parseDatabaseFromUrl(url, `redis connection "${name}" url`, true),
    DEFAULT_REDIS_DB,
    `redis connection "${name}" db`,
    0,
  )
  if (clusters && database !== 0) {
    throw new Error(`[Holo Redis] redis connection "${name}" cannot select redis.db=${database} in cluster mode; Redis Cluster only supports database 0.`)
  }

  return Object.freeze({
    name,
    ...(typeof url === 'undefined' ? {} : { url }),
    ...(typeof clusters === 'undefined' ? {} : { clusters }),
    ...(typeof socketPath === 'undefined' ? {} : { socketPath }),
    host: hostValue || socketPath || DEFAULT_REDIS_HOST,
    port: parseInteger(config.port, DEFAULT_REDIS_PORT, `redis connection "${name}" port`, 1),
    username: config.username?.trim() || undefined,
    password: config.password?.trim() || undefined,
    db: database,
  })
}

export function resolveNormalizedRedisConnection(
  config: NormalizedHoloRedisConfig,
  connectionName: string,
  label: string,
): NormalizedHoloRedisConnectionConfig {
  const connection = config.connections[connectionName]
  if (!connection) {
    throw new Error(`[Holo Redis] ${label} "${connectionName}" is not configured.`)
  }

  return connection
}

export function normalizeRedisConfig(config: HoloRedisConfig = {}): NormalizedHoloRedisConfig {
  const connections = !config.connections || Object.keys(config.connections).length === 0
    ? holoRedisDefaults.connections
    : Object.freeze(Object.fromEntries(Object.entries(config.connections).map(([name, connection]) => {
        const normalizedName = normalizeName(name, 'Redis connection name')
        return [normalizedName, normalizeConnection(normalizedName, connection)] as const
      })))
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

export function defineRedisConfig<TConfig extends HoloRedisConfig>(config: TConfig): Readonly<TConfig> {
  return Object.freeze({ ...config })
}
