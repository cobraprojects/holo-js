import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
const CACHE_DRIVER_DISPOSE_SYMBOL = Symbol.for('holo.cache.driver.dispose')

type DisposableCacheDriver = CacheDriverContract & {
  readonly [CACHE_DRIVER_DISPOSE_SYMBOL]?: () => void
}

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
  if (!error || typeof error !== 'object') {
    return false
  }

  const message = 'message' in error && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : ''
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined
  const escapedSpecifier = escapeRegExp(expectedSpecifier)

  if (
    (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND')
    && [
      new RegExp(`Cannot find package ['"]${escapedSpecifier}['"]`),
      new RegExp(`Cannot find module ['"]${escapedSpecifier}['"]`),
      new RegExp(`Could not resolve ['"]${escapedSpecifier}['"]`),
      new RegExp(`Failed to load url\\s+(?:['"\`]${escapedSpecifier}['"\`]|${escapedSpecifier}(?=[\\s(]|$))`),
    ].some(pattern => pattern.test(message))
  ) {
    return true
  }

  if ('cause' in error) {
    return isModuleNotFoundError((error as { cause?: unknown }).cause, expectedSpecifier)
  }

  return false
}

function normalizeRedisModuleLoadError(
  error: unknown,
  expectedSpecifier = '@holo-js/cache-redis',
): CacheOptionalPackageError | unknown {
  if (isModuleNotFoundError(error, expectedSpecifier)) {
    return new CacheOptionalPackageError(
      '[@holo-js/cache] Redis cache support requires @holo-js/cache-redis to be installed.',
      { cause: error },
    )
  }

  return error
}

/* v8 ignore start -- optional-peer loading failures are covered through normalizeRedisModuleLoadError in this monorepo test graph. */
async function importRedisDriverModuleFromProject(specifier: string): Promise<RedisCacheDriverModule> {
  const projectRequire = createRequire(join(process.cwd(), 'package.json'))
  return await import(pathToFileURL(projectRequire.resolve(specifier)).href) as RedisCacheDriverModule
}

async function loadRedisDriverModule(): Promise<RedisCacheDriverModule> {
  const specifier = '@holo-js/cache-redis' as string
  try {
    return await import(/* webpackIgnore: true */ specifier) as RedisCacheDriverModule
  } catch (error) {
    if (!isModuleNotFoundError(error, specifier)) {
      throw normalizeRedisModuleLoadError(error, specifier)
    }

    try {
      return await importRedisDriverModuleFromProject(specifier)
    } catch (fallbackError) {
      throw normalizeRedisModuleLoadError(fallbackError, specifier)
    }
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
  private disposalGeneration = 0

  constructor(private readonly options: RedisCacheDriverOptions) {}

  get name(): string {
    return this.options.name
  }

  private async resolveDriver(): Promise<CacheDriverContract> {
    if (this.driverInstance) return this.driverInstance

    const pendingGeneration = this.disposalGeneration
    this.pending ??= redisDriverModuleLoader().then((module) => {
      const driver = module.createRedisCacheDriver(this.options)
      if (this.disposalGeneration === pendingGeneration) {
        this.driverInstance = driver
      }
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

  [CACHE_DRIVER_DISPOSE_SYMBOL](): void {
    const pending = this.pending
    const driverInstance = this.driverInstance

    this.disposalGeneration += 1
    this.driverInstance = undefined
    this.pending = undefined

    if (driverInstance) {
      const disposable = driverInstance as DisposableCacheDriver
      disposable[CACHE_DRIVER_DISPOSE_SYMBOL]?.()
      return
    }

    pending?.then((driver) => {
      const disposable = driver as DisposableCacheDriver
      disposable[CACHE_DRIVER_DISPOSE_SYMBOL]?.()
    }).catch(() => {})
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
