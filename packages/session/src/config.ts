import {
  resolveNormalizedRedisConnection,
  type NormalizedHoloRedisClusterNodeConfig,
  type NormalizedHoloRedisConfig,
} from '@holo-js/kernel'
import type {} from '@holo-js/config'
import { registerConfigNormalizer } from '@holo-js/config/registry'

export type SessionCookieSameSite = 'lax' | 'strict' | 'none'

declare module '@holo-js/config' {
  interface HoloConfigRegistry {
    session: NormalizedHoloSessionConfig
  }
}

export interface HoloSessionCookieConfig {
  readonly name?: string
  readonly path?: string
  readonly domain?: string
  readonly secure?: boolean
  readonly httpOnly?: boolean
  readonly sameSite?: SessionCookieSameSite
  readonly partitioned?: boolean
  readonly maxAge?: number | string
}

export interface SessionFileStoreConfig { readonly driver: 'file', readonly path?: string }
export interface SessionDatabaseStoreConfig { readonly driver: 'database', readonly connection?: string, readonly table?: string }
export interface SessionRedisStoreConfig { readonly driver: 'redis', readonly connection?: string, readonly prefix?: string }
export type SessionStoreConfig = SessionFileStoreConfig | SessionDatabaseStoreConfig | SessionRedisStoreConfig

export interface HoloSessionConfig {
  readonly driver?: string
  readonly stores?: Readonly<Record<string, SessionStoreConfig>>
  readonly cookie?: HoloSessionCookieConfig
  readonly idleTimeout?: number | string
  readonly absoluteLifetime?: number | string
  readonly rememberMeLifetime?: number | string
}

export interface NormalizedHoloSessionCookieConfig {
  readonly name: string
  readonly path: string
  readonly domain?: string
  readonly secure: boolean
  readonly httpOnly: boolean
  readonly sameSite: SessionCookieSameSite
  readonly partitioned: boolean
  readonly maxAge: number
}

export interface NormalizedSessionFileStoreConfig { readonly name: string, readonly driver: 'file', readonly path: string }
export interface NormalizedSessionDatabaseStoreConfig { readonly name: string, readonly driver: 'database', readonly connection: string, readonly table: string }
export interface NormalizedSessionRedisStoreConfig {
  readonly name: string
  readonly driver: 'redis'
  readonly connection: string
  readonly url?: string
  readonly clusters?: readonly NormalizedHoloRedisClusterNodeConfig[]
  readonly host: string
  readonly port: number
  readonly username?: string
  readonly password?: string
  readonly db: number
  readonly prefix: string
}
export type NormalizedSessionStoreConfig = NormalizedSessionFileStoreConfig | NormalizedSessionDatabaseStoreConfig | NormalizedSessionRedisStoreConfig

export interface NormalizedHoloSessionConfig {
  readonly driver: string
  readonly stores: Readonly<Record<string, NormalizedSessionStoreConfig>>
  readonly cookie: NormalizedHoloSessionCookieConfig
  readonly idleTimeout: number
  readonly absoluteLifetime: number
  readonly rememberMeLifetime: number
}

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
    database: Object.freeze({ name: 'database', driver: 'database' as const, connection: DEFAULT_SESSION_DATABASE_CONNECTION, table: DEFAULT_SESSION_DATABASE_TABLE }),
    file: Object.freeze({ name: 'file', driver: 'file' as const, path: DEFAULT_SESSION_FILE_PATH }),
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

function normalizeStoreName(value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error('[Holo Session] Session store name must be a non-empty string.')
  return normalized
}

function parseInteger(value: number | string | undefined, fallback: number, label: string): number {
  const normalized = typeof value === 'undefined' ? fallback : typeof value === 'number' ? value : value.trim() ? Number.parseInt(value, 10) : Number.NaN
  if (!Number.isFinite(normalized) || !Number.isInteger(normalized)) throw new Error(`[Holo Session] ${label} must be an integer.`)
  if (normalized < 0) throw new Error(`[Holo Session] ${label} must be greater than or equal to 0.`)
  return normalized
}

function normalizeStore(name: string, config: SessionStoreConfig, redisConfig?: NormalizedHoloRedisConfig): NormalizedSessionStoreConfig {
  switch (config.driver) {
    case 'database':
      return Object.freeze({ name, driver: 'database', connection: config.connection?.trim() || DEFAULT_SESSION_DATABASE_CONNECTION, table: config.table?.trim() || DEFAULT_SESSION_DATABASE_TABLE })
    case 'file':
      return Object.freeze({ name, driver: 'file', path: config.path?.trim() || DEFAULT_SESSION_FILE_PATH })
    case 'redis': {
      const connectionName = config.connection?.trim() || redisConfig?.default
      if (!connectionName) throw new Error(`[@holo-js/session] Redis store "${name}" requires a top-level Redis default or an explicit connection.`)
      if (!redisConfig) throw new Error(`[@holo-js/session] Redis store "${name}" references shared connection "${connectionName}" without top-level Redis config.`)
      const connection = resolveNormalizedRedisConnection(redisConfig, connectionName, 'Session Redis store')
      return Object.freeze({
        name,
        driver: 'redis',
        connection: connection.name,
        ...(typeof connection.url === 'undefined' ? {} : { url: connection.url }),
        ...(typeof connection.clusters === 'undefined' ? {} : { clusters: connection.clusters }),
        host: connection.host,
        port: connection.port,
        username: connection.username,
        password: connection.password,
        db: connection.db,
        prefix: config.prefix?.trim() || '',
      })
    }
    default:
      throw new Error(`[Holo Session] Unsupported session store driver "${String((config as { readonly driver?: string }).driver)}" on store "${name}".`)
  }
}

export function normalizeSessionConfig(config: HoloSessionConfig = {}, redisConfig?: NormalizedHoloRedisConfig): NormalizedHoloSessionConfig {
  const stores = !config.stores || Object.keys(config.stores).length === 0
    ? holoSessionDefaults.stores
    : Object.freeze(Object.fromEntries(Object.entries(config.stores).map(([name, store]) => {
        const normalizedName = normalizeStoreName(name)
        return [normalizedName, normalizeStore(normalizedName, store, redisConfig)]
      })))
  const driver = config.driver?.trim() || (DEFAULT_SESSION_DRIVER in stores ? DEFAULT_SESSION_DRIVER : Object.keys(stores)[0]!)
  if (!(driver in stores)) throw new Error(`[Holo Session] default session driver "${driver}" is not configured.`)
  const cookie = config.cookie ?? {}
  const sameSite = cookie.sameSite ?? DEFAULT_SESSION_COOKIE_SAME_SITE
  if (sameSite !== 'lax' && sameSite !== 'strict' && sameSite !== 'none') throw new Error('[Holo Session] cookie sameSite must be "lax", "strict", or "none".')
  const secure = cookie.secure ?? false
  const partitioned = cookie.partitioned ?? false
  if (sameSite === 'none' && !secure) throw new Error('[Holo Session] cookie SameSite=None requires secure: true.')
  if (partitioned && !secure) throw new Error('[Holo Session] partitioned cookies require secure: true.')
  const idleTimeout = parseInteger(config.idleTimeout, DEFAULT_SESSION_IDLE_TIMEOUT, 'session idleTimeout')
  const absoluteLifetime = parseInteger(config.absoluteLifetime, DEFAULT_SESSION_ABSOLUTE_LIFETIME, 'session absoluteLifetime')
  const rememberMeLifetime = parseInteger(config.rememberMeLifetime, DEFAULT_SESSION_REMEMBER_ME_LIFETIME, 'session rememberMeLifetime')
  return Object.freeze({
    driver,
    stores,
    cookie: Object.freeze({
      name: cookie.name?.trim() || DEFAULT_SESSION_COOKIE_NAME,
      path: cookie.path?.trim() || DEFAULT_SESSION_COOKIE_PATH,
      domain: cookie.domain?.trim() || undefined,
      secure,
      httpOnly: cookie.httpOnly ?? true,
      sameSite,
      partitioned,
      maxAge: parseInteger(cookie.maxAge, absoluteLifetime, 'session cookie maxAge'),
    }),
    idleTimeout,
    absoluteLifetime,
    rememberMeLifetime,
  })
}

export function defineSessionConfig<TConfig extends HoloSessionConfig>(config: TConfig): Readonly<TConfig> {
  return Object.freeze({ ...config })
}

registerConfigNormalizer<HoloSessionConfig, NormalizedHoloSessionConfig>({
  name: 'session',
  dependencies: ['redis'],
  normalize(config, context) {
    return normalizeSessionConfig(config, context.has('redis') ? context.get<NormalizedHoloRedisConfig>('redis') : undefined)
  },
})
