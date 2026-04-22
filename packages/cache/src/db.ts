import {
  normalizeDatabaseConfig,
  type HoloDatabaseConfig,
  type HoloDatabaseConnectionConfig,
  type NormalizedHoloDatabaseConfig,
} from '@holo-js/config'
import {
  CacheDriverResolutionError,
  CacheOptionalPackageError,
  type CacheDriverContract,
  type CacheDriverGetResult,
  type CacheLockContract,
} from './contracts'

type DatabaseCacheDriverOptions = {
  readonly name: string
  readonly connectionName: string
  readonly table: string
  readonly lockTable: string
  readonly prefix?: string
  readonly connection: HoloDatabaseConnectionConfig | string
}

type DatabaseCacheDriverModule = {
  createDatabaseCacheDriver(options: DatabaseCacheDriverOptions): CacheDriverContract
}

type DatabaseDriverModuleLoader = () => Promise<DatabaseCacheDriverModule>

function isNormalizedDatabaseConfig(
  config: HoloDatabaseConfig | NormalizedHoloDatabaseConfig,
): config is NormalizedHoloDatabaseConfig {
  return typeof config === 'object'
    && config !== null
    && typeof config.connections === 'object'
    && config.connections !== null
}

function normalizeRuntimeDatabaseConfig(
  config: HoloDatabaseConfig | NormalizedHoloDatabaseConfig | undefined,
): NormalizedHoloDatabaseConfig | undefined {
  if (!config) return undefined
  return normalizeDatabaseConfig(config)
}

function resolveSharedDatabaseConnection(
  databaseConfig: NormalizedHoloDatabaseConfig | undefined,
  connectionName: string,
): HoloDatabaseConnectionConfig | string {
  if (!databaseConfig) {
    throw new CacheDriverResolutionError(
      `[@holo-js/cache] Database cache driver "${connectionName}" requires a top-level database config from config/database.ts.`,
    )
  }

  const connection = databaseConfig.connections[connectionName]
  if (connection) return connection

  const availableConnections = Object.keys(databaseConfig.connections)
  throw new CacheDriverResolutionError(
    `[@holo-js/cache] Database cache connection "${connectionName}" was not found in config/database.ts. `
    + `Available connections: ${availableConnections.join(', ') || '(none)'}.`,
  )
}

function isModuleNotFoundError(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
}

function normalizeDatabaseModuleLoadError(error: unknown): CacheOptionalPackageError | unknown {
  if (isModuleNotFoundError(error)) {
    return new CacheOptionalPackageError(
      '[@holo-js/cache] Database cache support requires @holo-js/cache-db to be installed.',
      { cause: error },
    )
  }

  return error
}

/* v8 ignore start -- optional-peer loading failures are covered through normalizeDatabaseModuleLoadError in this monorepo test graph. */
async function loadDatabaseDriverModule(): Promise<DatabaseCacheDriverModule> {
  try {
    const specifier = '@holo-js/cache-db' as string
    return await import(specifier) as DatabaseCacheDriverModule
  } catch (error) {
    throw normalizeDatabaseModuleLoadError(error)
  }
}
/* v8 ignore stop */

let databaseDriverModuleLoader: DatabaseDriverModuleLoader = loadDatabaseDriverModule

function setDatabaseDriverModuleLoader(loader: DatabaseDriverModuleLoader): void {
  databaseDriverModuleLoader = loader
}

function resetDatabaseDriverModuleLoader(): void {
  databaseDriverModuleLoader = loadDatabaseDriverModule
}

class LazyDatabaseCacheDriver implements CacheDriverContract {
  readonly driver = 'database' as const

  private driverInstance?: CacheDriverContract
  private pending?: Promise<CacheDriverContract>

  constructor(private readonly options: DatabaseCacheDriverOptions) {}

  get name(): string {
    return this.options.name
  }

  private async resolveDriver(): Promise<CacheDriverContract> {
    if (this.driverInstance) return this.driverInstance

    this.pending ??= databaseDriverModuleLoader().then((module) => {
      const driver = module.createDatabaseCacheDriver(this.options)
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

function createDatabaseCacheDriver(
  options: DatabaseCacheDriverOptions,
): CacheDriverContract {
  return new LazyDatabaseCacheDriver(options)
}

export const cacheDbInternals = {
  isModuleNotFoundError,
  isNormalizedDatabaseConfig,
  loadDatabaseDriverModule,
  normalizeDatabaseModuleLoadError,
  normalizeRuntimeDatabaseConfig,
  resolveSharedDatabaseConnection,
  resetDatabaseDriverModuleLoader,
  setDatabaseDriverModuleLoader,
}

export { createDatabaseCacheDriver }
