export type BroadcastConnectionDriver = 'holo' | 'pusher' | 'log' | 'null'
export type BroadcastConnectionScheme = 'http' | 'https'

export interface BroadcastConnectionOptionsConfig {
  readonly host?: string
  readonly port?: number | string
  readonly scheme?: BroadcastConnectionScheme
  readonly useTLS?: boolean
  readonly cluster?: string
}

export interface BroadcastWorkerScalingConfig {
  readonly driver: 'redis'
  readonly connection?: string
}

export interface BroadcastWorkerConfig {
  readonly host?: string
  readonly port?: number | string
  readonly path?: string
  readonly publicHost?: string
  readonly publicPort?: number | string
  readonly publicScheme?: BroadcastConnectionScheme
  readonly healthPath?: string
  readonly statsPath?: string
  readonly allowedOrigins?: readonly string[]
  readonly maxRequestBytes?: number | string
  readonly maxMessageBytes?: number | string
  readonly statsEnabled?: boolean
  readonly scaling?: false | BroadcastWorkerScalingConfig
}

export type BroadcastConnectionConfigValue =
  | string
  | number
  | boolean
  | object
  | undefined

export interface BaseBroadcastConnectionConfig {
  readonly driver: BroadcastConnectionDriver | (string & {})
  readonly options?: BroadcastConnectionOptionsConfig
  readonly clientOptions?: Readonly<Record<string, unknown>>
  readonly [key: string]: BroadcastConnectionConfigValue
}

export interface HoloBroadcastConnectionConfig extends BaseBroadcastConnectionConfig {
  readonly driver: 'holo'
  readonly key?: string
  readonly secret?: string
  readonly appId?: string | number
}

export interface PusherBroadcastConnectionConfig extends BaseBroadcastConnectionConfig {
  readonly driver: 'pusher'
  readonly key?: string
  readonly secret?: string
  readonly appId?: string | number
}

export interface LogBroadcastConnectionConfig extends BaseBroadcastConnectionConfig {
  readonly driver: 'log'
}

export interface NullBroadcastConnectionConfig extends BaseBroadcastConnectionConfig {
  readonly driver: 'null'
}

export type HoloBroadcastConnection
  = HoloBroadcastConnectionConfig
  | PusherBroadcastConnectionConfig
  | LogBroadcastConnectionConfig
  | NullBroadcastConnectionConfig
  | BaseBroadcastConnectionConfig

export interface HoloBroadcastConfig {
  readonly default?: string
  readonly connections?: Readonly<Record<string, HoloBroadcastConnection>>
  readonly worker?: BroadcastWorkerConfig
}

export interface NormalizedBroadcastConnectionOptionsConfig {
  readonly host: string
  readonly port: number
  readonly scheme: BroadcastConnectionScheme
  readonly useTLS: boolean
  readonly cluster?: string
}

export interface NormalizedBroadcastWorkerScalingConfig {
  readonly driver: 'redis'
  readonly connection: string
}

export interface NormalizedBroadcastWorkerConfig {
  readonly host: string
  readonly port: number
  readonly path: string
  readonly publicHost?: string
  readonly publicPort?: number
  readonly publicScheme: BroadcastConnectionScheme
  readonly healthPath: string
  readonly statsPath: string
  readonly allowedOrigins: readonly string[]
  readonly maxRequestBytes: number
  readonly maxMessageBytes: number
  readonly statsEnabled: boolean
  readonly scaling: false | NormalizedBroadcastWorkerScalingConfig
}

export interface NormalizedBaseBroadcastConnectionConfig {
  readonly name: string
  readonly driver: string
  readonly clientOptions: Readonly<Record<string, unknown>>
}

export interface NormalizedHoloBroadcastConnectionConfig extends NormalizedBaseBroadcastConnectionConfig {
  readonly driver: 'holo'
  readonly key: string
  readonly secret: string
  readonly appId: string
  readonly options: NormalizedBroadcastConnectionOptionsConfig
}

export interface NormalizedPusherBroadcastConnectionConfig extends NormalizedBaseBroadcastConnectionConfig {
  readonly driver: 'pusher'
  readonly key: string
  readonly secret: string
  readonly appId: string
  readonly options: NormalizedBroadcastConnectionOptionsConfig
}

export interface NormalizedLogBroadcastConnectionConfig extends NormalizedBaseBroadcastConnectionConfig {
  readonly driver: 'log'
}

export interface NormalizedNullBroadcastConnectionConfig extends NormalizedBaseBroadcastConnectionConfig {
  readonly driver: 'null'
}

export type NormalizedHoloBroadcastConnection
  = NormalizedHoloBroadcastConnectionConfig
  | NormalizedPusherBroadcastConnectionConfig
  | NormalizedLogBroadcastConnectionConfig
  | NormalizedNullBroadcastConnectionConfig
  | NormalizedBaseBroadcastConnectionConfig

export interface NormalizedHoloBroadcastConfig {
  readonly default: string
  readonly connections: Readonly<Record<string, NormalizedHoloBroadcastConnection>>
  readonly worker: NormalizedBroadcastWorkerConfig
}

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
export const DEFAULT_BROADCAST_MAX_REQUEST_BYTES = 1_048_576
export const DEFAULT_BROADCAST_MAX_MESSAGE_BYTES = 65_536

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
    allowedOrigins: Object.freeze(['https://127.0.0.1']),
    maxRequestBytes: DEFAULT_BROADCAST_MAX_REQUEST_BYTES,
    maxMessageBytes: DEFAULT_BROADCAST_MAX_MESSAGE_BYTES,
    statsEnabled: false,
    scaling: false,
  }),
})

function parseInteger(value: number | string, label: string): number {
  const normalized = typeof value === 'number' ? value : value.trim() ? Number(value.trim()) : Number.NaN
  if (!Number.isFinite(normalized) || !Number.isInteger(normalized)) throw new Error(`[Holo Broadcast] ${label} must be an integer.`)
  if (normalized < 1) throw new Error(`[Holo Broadcast] ${label} must be greater than or equal to 1.`)
  return normalized
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
  connectionOptions?: NormalizedBroadcastConnectionOptionsConfig,
  configuredConnectionPort?: BroadcastConnectionOptionsConfig['port'],
): NormalizedBroadcastWorkerConfig {
  const scaling = worker?.scaling
  const publicScheme = normalizeBroadcastScheme(worker?.publicScheme, connectionOptions?.scheme ?? 'https', 'Broadcast worker public scheme')
  const fallbackPort = typeof configuredConnectionPort === 'undefined'
    ? DEFAULT_BROADCAST_WORKER_PORT
    : normalizeBroadcastPort(configuredConnectionPort, DEFAULT_BROADCAST_WORKER_PORT, 'Broadcast worker port')
  if (scaling && scaling.driver !== 'redis') {
    throw new Error('[Holo Broadcast] Broadcast worker scaling driver must be "redis".')
  }

  const publicHost = normalizeOptionalBroadcastString(worker?.publicHost, 'Broadcast worker public host') ?? undefined
  const publicPort = typeof worker?.publicPort === 'undefined'
    ? (publicScheme === 'http' ? DEFAULT_BROADCAST_HTTP_PORT : undefined)
    : normalizeBroadcastPort(
        worker.publicPort,
        publicScheme === 'http' ? DEFAULT_BROADCAST_HTTP_PORT : DEFAULT_BROADCAST_HTTPS_PORT,
        'Broadcast worker public port',
      )
  const defaultOriginPort = publicPort ?? connectionOptions?.port
  const defaultOriginHost = publicHost ?? connectionOptions?.host ?? '127.0.0.1'
  const defaultOrigin = new URL(`${publicScheme}://${defaultOriginHost}${typeof defaultOriginPort === 'number' ? `:${defaultOriginPort}` : ''}`).origin
  const allowedOrigins = worker?.allowedOrigins?.map((value, index) => {
    const normalized = value.trim()
    if (normalized === '*') {
      return normalized
    }

    let origin: string
    try {
      origin = new URL(normalized).origin
    } catch {
      throw new Error(`[Holo Broadcast] Broadcast worker allowed origin at index ${index} must be "*" or an absolute URL origin.`)
    }
    if (origin === 'null' || normalized.replace(/\/$/, '') !== origin) {
      throw new Error(`[Holo Broadcast] Broadcast worker allowed origin at index ${index} must not include a path, query, or fragment.`)
    }
    return origin
  }) ?? [defaultOrigin]

  return Object.freeze({
    host: normalizeOptionalBroadcastString(worker?.host, 'Broadcast worker host') ?? DEFAULT_BROADCAST_WORKER_HOST,
    port: normalizeBroadcastPort(worker?.port, fallbackPort, 'Broadcast worker port'),
    path: normalizeOptionalBroadcastString(worker?.path, 'Broadcast worker path') ?? DEFAULT_BROADCAST_WORKER_PATH,
    publicHost,
    publicPort,
    publicScheme,
    healthPath: normalizeOptionalBroadcastString(worker?.healthPath, 'Broadcast worker health path') ?? DEFAULT_BROADCAST_HEALTH_PATH,
    statsPath: normalizeOptionalBroadcastString(worker?.statsPath, 'Broadcast worker stats path') ?? DEFAULT_BROADCAST_STATS_PATH,
    allowedOrigins: Object.freeze(allowedOrigins),
    maxRequestBytes: parseInteger(worker?.maxRequestBytes ?? DEFAULT_BROADCAST_MAX_REQUEST_BYTES, 'broadcast worker maxRequestBytes'),
    maxMessageBytes: parseInteger(worker?.maxMessageBytes ?? DEFAULT_BROADCAST_MAX_MESSAGE_BYTES, 'broadcast worker maxMessageBytes'),
    statsEnabled: worker?.statsEnabled ?? false,
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
  const defaultBroadcastConnection = normalizedConnections[defaultConnection]
  const defaultHoloConnectionOptions = defaultBroadcastConnection
    && defaultBroadcastConnection.driver === 'holo'
    && 'options' in defaultBroadcastConnection
    ? defaultBroadcastConnection.options
    : undefined
  const configuredDefaultConnection = config.connections?.[defaultConnection]
  const configuredDefaultHoloConnectionPort = configuredDefaultConnection?.driver === 'holo'
    ? configuredDefaultConnection.options?.port
    : undefined

  return Object.freeze({
    default: defaultConnection,
    connections: Object.freeze(normalizedConnections),
    worker: normalizeBroadcastWorkerConfig(config.worker, defaultHoloConnectionOptions, configuredDefaultHoloConnectionPort),
  })
}

export function defineBroadcastConfig<TConfig extends HoloBroadcastConfig>(config: TConfig): Readonly<TConfig> {
  return Object.freeze({ ...config })
}

registerConfigNormalizer<HoloBroadcastConfig, NormalizedHoloBroadcastConfig>({
  name: 'broadcast',
  normalize: normalizeBroadcastConfig,
})
import type {} from '@holo-js/config'
import { registerConfigNormalizer } from '@holo-js/config/registry'
declare module '@holo-js/config' {
  interface HoloConfigRegistry {
    broadcast: NormalizedHoloBroadcastConfig
  }
}
