import {
  normalizeRedisConfig,
  type HoloRedisConfig,
  type NormalizedHoloRedisConfig,
  type NormalizedHoloRedisConnectionConfig,
} from '@holo-js/config'
import {
  CacheDriverResolutionError,
  CacheOptionalPackageError,
  type CacheDriverContract,
  type CacheDriverGetResult,
  type CacheLockContract,
} from './contracts'

type RedisCacheDriverOptions = {
  readonly name: string
  readonly connectionName: string
  readonly prefix: string
  readonly redis: NormalizedHoloRedisConnectionConfig
}

type RedisCacheDriverModule = {
  createRedisCacheDriver(options: RedisCacheDriverOptions): CacheDriverContract
}

type RedisDriverModuleLoader = () => Promise<RedisCacheDriverModule>

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

function isModuleNotFoundError(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
}

function normalizeRedisModuleLoadError(error: unknown): CacheOptionalPackageError | unknown {
  if (isModuleNotFoundError(error)) {
    return new CacheOptionalPackageError(
      '[@holo-js/cache] Redis cache support requires @holo-js/cache-redis to be installed.',
      { cause: error },
    )
  }

  return error
}

/* v8 ignore start -- optional-peer loading failures are covered through normalizeRedisModuleLoadError in this monorepo test graph. */
async function loadRedisDriverModule(): Promise<RedisCacheDriverModule> {
  try {
    const specifier = '@holo-js/cache-redis' as string
    return await import(specifier) as RedisCacheDriverModule
  } catch (error) {
    throw normalizeRedisModuleLoadError(error)
  }
}
/* v8 ignore stop */

let redisDriverModuleLoader: RedisDriverModuleLoader = loadRedisDriverModule

function setRedisDriverModuleLoader(loader: RedisDriverModuleLoader): void {
  redisDriverModuleLoader = loader
}

function resetRedisDriverModuleLoader(): void {
  redisDriverModuleLoader = loadRedisDriverModule
}

class LazyRedisCacheDriver implements CacheDriverContract {
  readonly driver = 'redis' as const

  private driverInstance?: CacheDriverContract
  private pending?: Promise<CacheDriverContract>

  constructor(private readonly options: RedisCacheDriverOptions) {}

  get name(): string {
    return this.options.name
  }

  private async resolveDriver(): Promise<CacheDriverContract> {
    if (this.driverInstance) return this.driverInstance

    this.pending ??= redisDriverModuleLoader().then((module) => {
      const driver = module.createRedisCacheDriver(this.options)
      this.driverInstance = driver
      return driver
    }).finally(() => {
      this.pending = undefined
    })

    return this.pending
  }

  private async withDriver<TValue>(
    callback: (driver: CacheDriverContract) => Promise<TValue> | TValue,
  ): Promise<TValue> {
    return callback(await this.resolveDriver())
  }

  private createLockProxy(name: string, seconds: number): CacheLockContract {
    let lockPromise: Promise<CacheLockContract> | undefined

    const resolveLock = async (): Promise<CacheLockContract> => {
      lockPromise ??= this.withDriver((driver) => driver.lock(name, seconds))
      return lockPromise
    }

    return {
      name,
      async get<TValue>(callback?: () => TValue | Promise<TValue>): Promise<boolean | TValue> {
        return (await resolveLock()).get(callback)
      },
      async release(): Promise<boolean> {
        return (await resolveLock()).release()
      },
      async block<TValue>(waitSeconds: number, callback?: () => TValue | Promise<TValue>): Promise<boolean | TValue> {
        return (await resolveLock()).block(waitSeconds, callback)
      },
    }
  }

  async get(key: string): Promise<CacheDriverGetResult> {
    return this.withDriver((driver) => driver.get(key))
  }

  async put(input: Parameters<CacheDriverContract['put']>[0]): Promise<boolean> {
    return this.withDriver((driver) => driver.put(input))
  }

  async add(input: Parameters<CacheDriverContract['add']>[0]): Promise<boolean> {
    return this.withDriver((driver) => driver.add(input))
  }

  async forget(key: string): Promise<boolean> {
    return this.withDriver((driver) => driver.forget(key))
  }

  async flush(): Promise<void> {
    await this.withDriver((driver) => driver.flush())
  }

  async increment(key: string, amount: number): Promise<number> {
    return this.withDriver((driver) => driver.increment(key, amount))
  }

  async decrement(key: string, amount: number): Promise<number> {
    return this.withDriver((driver) => driver.decrement(key, amount))
  }

  lock(name: string, seconds: number): CacheLockContract {
    return this.createLockProxy(name, seconds)
  }
}

function createRedisCacheDriver(
  options: RedisCacheDriverOptions,
): CacheDriverContract {
  return new LazyRedisCacheDriver(options)
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
