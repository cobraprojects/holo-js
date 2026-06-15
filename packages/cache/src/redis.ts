import {
  normalizeRedisConfig,
  type HoloRedisConfig,
  type NormalizedHoloRedisConfig,
  type NormalizedHoloRedisConnectionConfig,
} from '@holo-js/config'
import {
  CacheDriverResolutionError,
  type CacheDriverContract,
} from './contracts'
import {
  createLazyOptionalCacheDriver,
  createOptionalDriverModuleLoader,
  isOptionalDriverModuleNotFoundError,
  normalizeOptionalDriverModuleLoadError,
  type OptionalDriverModuleLoader,
} from './optional-driver'

type RedisCacheDriverOptions = {
  readonly name: string
  readonly connectionName: string
  readonly prefix: string
  readonly redis: NormalizedHoloRedisConnectionConfig
}

type RedisCacheDriverModule = {
  createRedisCacheDriver(options: RedisCacheDriverOptions): CacheDriverContract
}

type RedisDriverModuleLoader = OptionalDriverModuleLoader<RedisCacheDriverModule>
const REDIS_CACHE_PACKAGE = '@holo-js/cache-redis'
const REDIS_CACHE_MISSING_MESSAGE = '[@holo-js/cache] Redis cache support requires @holo-js/cache-redis to be installed.'

function isNormalizedRedisConfig(
  config: HoloRedisConfig | NormalizedHoloRedisConfig,
): config is NormalizedHoloRedisConfig {
  return typeof config.default === 'string'
    && typeof config.connections === 'object'
    && config.connections !== null
    && Object.values(config.connections).every((connection) => {
      return typeof connection === 'object'
        && connection !== null
        && 'name' in connection
        && 'host' in connection
        && 'port' in connection
        && typeof connection.name === 'string'
        && typeof connection.host === 'string'
        && typeof connection.port === 'number'
    })
}

function normalizeRuntimeRedisConfig(
  config: HoloRedisConfig | NormalizedHoloRedisConfig | undefined,
): NormalizedHoloRedisConfig | undefined {
  if (!config) return undefined
  return isNormalizedRedisConfig(config) ? config : normalizeRedisConfig(config)
}

function resolveSharedRedisConnection(
  redisConfig: NormalizedHoloRedisConfig | undefined,
  connectionName: string,
): NormalizedHoloRedisConnectionConfig {
  if (!redisConfig) {
    throw new CacheDriverResolutionError(
      `[@holo-js/cache] Redis cache driver "${connectionName}" requires a top-level redis config from config/redis.ts.`,
    )
  }

  const connection = redisConfig.connections[connectionName]
  if (connection) return connection

  const availableConnections = Object.keys(redisConfig.connections)
  throw new CacheDriverResolutionError(
    `[@holo-js/cache] Redis cache connection "${connectionName}" was not found in config/redis.ts. `
    + `Available connections: ${availableConnections.join(', ') || '(none)'}.`,
  )
}

function isModuleNotFoundError(error: unknown, expectedSpecifier = '@holo-js/cache-redis'): boolean {
  return isOptionalDriverModuleNotFoundError(error, expectedSpecifier)
}

function normalizeRedisModuleLoadError(
  error: unknown,
  expectedSpecifier = '@holo-js/cache-redis',
): ReturnType<typeof normalizeOptionalDriverModuleLoadError> {
  return normalizeOptionalDriverModuleLoadError(error, expectedSpecifier, REDIS_CACHE_MISSING_MESSAGE)
}

const loadRedisDriverModule = createOptionalDriverModuleLoader<RedisCacheDriverModule>(
  REDIS_CACHE_PACKAGE,
  REDIS_CACHE_MISSING_MESSAGE,
)

let redisDriverModuleLoader: RedisDriverModuleLoader = loadRedisDriverModule

function setRedisDriverModuleLoader(loader: RedisDriverModuleLoader): void {
  redisDriverModuleLoader = loader
}

function resetRedisDriverModuleLoader(): void {
  redisDriverModuleLoader = loadRedisDriverModule
}

function createRedisCacheDriver(
  options: RedisCacheDriverOptions,
): CacheDriverContract {
  return createLazyOptionalCacheDriver({
    name: options.name,
    driver: 'redis',
    options,
    loadModule: redisDriverModuleLoader,
    createDriver: (module, driverOptions) => module.createRedisCacheDriver(driverOptions),
    disposeDriver: true,
  })
}

export const cacheRedisInternals = {
  isModuleNotFoundError,
  isNormalizedRedisConfig,
  loadRedisDriverModule,
  normalizeRedisModuleLoadError,
  normalizeRuntimeRedisConfig,
  resolveSharedRedisConnection,
  resetRedisDriverModuleLoader,
  setRedisDriverModuleLoader,
}

export { createRedisCacheDriver }
