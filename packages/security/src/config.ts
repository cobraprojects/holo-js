import {
  DEFAULT_REDIS_DB,
  DEFAULT_REDIS_HOST,
  DEFAULT_REDIS_PORT,
  resolveNormalizedRedisConnection,
  type HoloRedisClusterNodeConfig,
  type NormalizedHoloRedisClusterNodeConfig,
  type NormalizedHoloRedisConfig,
} from '@holo-js/kernel'
import type {} from '@holo-js/config'
import { registerConfigNormalizer } from '@holo-js/config/registry'

export interface HoloCorsConfig {
  readonly paths?: readonly string[]
  readonly origins?: readonly string[]
  readonly methods?: readonly string[]
  readonly headers?: readonly string[]
  readonly credentials?: boolean
  readonly maxAge?: number | string
  readonly statefulDomains?: readonly string[]
}

declare module '@holo-js/config' {
  interface HoloConfigRegistry {
    cors: NormalizedHoloCorsConfig
    security: NormalizedHoloSecurityConfig
  }
}

export interface NormalizedHoloCorsConfig {
  readonly paths: readonly string[]
  readonly origins: readonly string[]
  readonly methods: readonly string[]
  readonly headers: readonly string[]
  readonly credentials: boolean
  readonly maxAge: number
  readonly statefulDomains: readonly string[]
}

export type SecurityRateLimitDriver = 'memory' | 'file' | 'redis'

export interface HoloSecurityCsrfConfig {
  readonly enabled?: boolean
  readonly field?: string
  readonly header?: string
  readonly cookie?: string
  readonly except?: readonly string[]
}

export interface NormalizedHoloSecurityCsrfConfig {
  readonly enabled: boolean
  readonly field: string
  readonly header: string
  readonly cookie: string
  readonly except: readonly string[]
}

export interface SecurityRateLimitContext<
  TValues extends Readonly<Record<string, unknown>> | undefined = Readonly<Record<string, unknown>> | undefined,
> {
  readonly request: Request
  readonly values?: TValues
}

export interface SecurityRateLimitKeyResolver<
  TValues extends Readonly<Record<string, unknown>> | undefined = Readonly<Record<string, unknown>> | undefined,
> {
  (context: SecurityRateLimitContext<TValues>): string | Promise<string>
}

export interface SecurityLimiterConfig<
  TValues extends Readonly<Record<string, unknown>> | undefined = Readonly<Record<string, unknown>> | undefined,
> {
  readonly maxAttempts: number | string
  readonly decaySeconds: number | string
  readonly key?: SecurityRateLimitKeyResolver<TValues>
}

export interface NormalizedSecurityLimiterConfig<
  TValues extends Readonly<Record<string, unknown>> | undefined = Readonly<Record<string, unknown>> | undefined,
> {
  readonly name: string
  readonly maxAttempts: number
  readonly decaySeconds: number
  readonly key?: SecurityRateLimitKeyResolver<TValues>
}

export interface SecurityRateLimitMemoryConfig {
  readonly driver?: 'memory'
}

export interface SecurityRateLimitFileConfig {
  readonly path?: string
}

export interface SecurityRateLimitRedisConnectionConfig {
  readonly url?: string
  readonly clusters?: readonly HoloRedisClusterNodeConfig[]
  readonly host?: string
  readonly port?: number | string
  readonly password?: string
  readonly username?: string
  readonly db?: number | string
}

export interface SecurityRateLimitRedisConfig {
  readonly connection?: string
  readonly prefix?: string
}

export interface HoloSecurityRateLimitConfig {
  readonly driver?: SecurityRateLimitDriver
  readonly memory?: SecurityRateLimitMemoryConfig
  readonly file?: SecurityRateLimitFileConfig
  readonly redis?: SecurityRateLimitRedisConfig
  readonly limiters?: Readonly<Record<string, SecurityLimiterConfig>>
}

export interface NormalizedSecurityRateLimitMemoryConfig {
  readonly driver: 'memory'
}

export interface NormalizedSecurityRateLimitFileConfig {
  readonly path: string
}

export interface NormalizedSecurityRateLimitRedisConfig {
  readonly url?: string
  readonly clusters?: readonly NormalizedHoloRedisClusterNodeConfig[]
  readonly host: string
  readonly port: number
  readonly password?: string
  readonly username?: string
  readonly db: number
  readonly connection: string
  readonly prefix: string
}

export interface NormalizedHoloSecurityRateLimitConfig {
  readonly driver: SecurityRateLimitDriver
  readonly memory: NormalizedSecurityRateLimitMemoryConfig
  readonly file: NormalizedSecurityRateLimitFileConfig
  readonly redis: NormalizedSecurityRateLimitRedisConfig
  readonly limiters: Readonly<Record<string, NormalizedSecurityLimiterConfig>>
}

export interface HoloSecurityConfig {
  readonly csrf?: boolean | HoloSecurityCsrfConfig
  readonly rateLimit?: HoloSecurityRateLimitConfig
}

export interface NormalizedHoloSecurityConfig {
  readonly csrf: NormalizedHoloSecurityCsrfConfig
  readonly rateLimit: NormalizedHoloSecurityRateLimitConfig
}

export const DEFAULT_CORS_PATHS = Object.freeze(['/api/*'] as const)
export const DEFAULT_CORS_METHODS = Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const)
export const DEFAULT_CORS_HEADERS = Object.freeze(['Content-Type', 'Authorization', 'X-CSRF-TOKEN', 'X-Requested-With'] as const)
export const DEFAULT_CORS_MAX_AGE = 7200

export const holoCorsDefaults: Readonly<NormalizedHoloCorsConfig> = Object.freeze({
  paths: DEFAULT_CORS_PATHS,
  origins: Object.freeze([]),
  methods: DEFAULT_CORS_METHODS,
  headers: DEFAULT_CORS_HEADERS,
  credentials: false,
  maxAge: DEFAULT_CORS_MAX_AGE,
  statefulDomains: Object.freeze([]),
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

function parseScopedInteger(
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
        ? Number(value.trim())
        : Number.NaN
  if (!Number.isFinite(normalized) || !Number.isInteger(normalized)) throw new Error(`[${namespace}] ${label} must be an integer.`)
  if (typeof options.minimum === 'number' && normalized < options.minimum) throw new Error(`[${namespace}] ${label} must be greater than or equal to ${options.minimum}.`)
  return normalized
}

function normalizeScopedName(value: string | undefined, namespace: string, label: string): string {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`[${namespace}] ${label} must be a non-empty string.`)
  return normalized
}

function parseSecurityInteger(
  value: number | string | undefined,
  fallback: number,
  label: string,
  options: { minimum?: number } = {},
): number {
  return parseScopedInteger(value, fallback, 'Holo Security', label, options)
}

function normalizeSecurityName(value: string | undefined, label: string): string {
  return normalizeScopedName(value, 'Holo Security', label)
}

function normalizeSecurityOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

function normalizeCorsStringList(
  values: readonly string[] | undefined,
  defaults: readonly string[],
  label: string,
): readonly string[] {
  if (!values) {
    return defaults
  }

  return Object.freeze(values.map((value, index) => {
    const normalized = value.trim()
    if (!normalized) {
      throw new Error(`[Holo CORS] ${label} entry at index ${index} must be a non-empty string.`)
    }

    return normalized
  }))
}

function normalizeCorsMethods(values: readonly string[] | undefined): readonly string[] {
  return Object.freeze(normalizeCorsStringList(values, DEFAULT_CORS_METHODS, 'methods')
    .map(value => value.toUpperCase()))
}

function normalizeCorsMaxAge(value: number | string | undefined): number {
  return parseSecurityInteger(value ?? DEFAULT_CORS_MAX_AGE, DEFAULT_CORS_MAX_AGE, 'cors maxAge', {
    minimum: 0,
  })
}

export function normalizeCorsConfig(config: HoloCorsConfig = {}): NormalizedHoloCorsConfig {
  return Object.freeze({
    paths: normalizeCorsStringList(config.paths, DEFAULT_CORS_PATHS, 'paths'),
    origins: normalizeCorsStringList(config.origins, holoCorsDefaults.origins, 'origins'),
    methods: normalizeCorsMethods(config.methods),
    headers: normalizeCorsStringList(config.headers, DEFAULT_CORS_HEADERS, 'headers'),
    credentials: config.credentials ?? holoCorsDefaults.credentials,
    maxAge: normalizeCorsMaxAge(config.maxAge),
    statefulDomains: normalizeCorsStringList(config.statefulDomains, holoCorsDefaults.statefulDomains, 'statefulDomains'),
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
                `[@holo-js/security] Rate-limit Redis config references shared connection "${connectionName}" without top-level Redis config.`,
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

export function defineSecurityConfig<TConfig extends HoloSecurityConfig>(config: TConfig): Readonly<TConfig> {
  return Object.freeze({ ...config })
}

export function defineCorsConfig<TConfig extends HoloCorsConfig>(config: TConfig): Readonly<TConfig> {
  return Object.freeze({ ...config })
}

registerConfigNormalizer<HoloCorsConfig, NormalizedHoloCorsConfig>({
  name: 'cors',
  normalize: normalizeCorsConfig,
})

registerConfigNormalizer<HoloSecurityConfig, NormalizedHoloSecurityConfig>({
  name: 'security',
  dependencies: ['redis'],
  normalize(config, context) {
    return normalizeSecurityConfig(config, context.has('redis') ? context.get<NormalizedHoloRedisConfig>('redis') : undefined)
  },
})
