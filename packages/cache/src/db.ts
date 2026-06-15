import {
  normalizeDatabaseConfig,
  type HoloDatabaseConfig,
  type HoloDatabaseConnectionConfig,
  type NormalizedHoloDatabaseConfig,
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

type DatabaseDriverModuleLoader = OptionalDriverModuleLoader<DatabaseCacheDriverModule>
const DATABASE_CACHE_PACKAGE = '@holo-js/cache-db'
const DATABASE_CACHE_MISSING_MESSAGE = '[@holo-js/cache] Database cache support requires @holo-js/cache-db to be installed.'

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

function isModuleNotFoundError(error: unknown, expectedSpecifier = '@holo-js/cache-db'): boolean {
  return isOptionalDriverModuleNotFoundError(error, expectedSpecifier)
}

function normalizeDatabaseModuleLoadError(
  error: unknown,
  expectedSpecifier = '@holo-js/cache-db',
): ReturnType<typeof normalizeOptionalDriverModuleLoadError> {
  return normalizeOptionalDriverModuleLoadError(error, expectedSpecifier, DATABASE_CACHE_MISSING_MESSAGE)
}

const loadDatabaseDriverModule = createOptionalDriverModuleLoader<DatabaseCacheDriverModule>(
  DATABASE_CACHE_PACKAGE,
  DATABASE_CACHE_MISSING_MESSAGE,
)

let databaseDriverModuleLoader: DatabaseDriverModuleLoader = loadDatabaseDriverModule

function setDatabaseDriverModuleLoader(loader: DatabaseDriverModuleLoader): void {
  databaseDriverModuleLoader = loader
}

function resetDatabaseDriverModuleLoader(): void {
  databaseDriverModuleLoader = loadDatabaseDriverModule
}

function createDatabaseCacheDriver(
  options: DatabaseCacheDriverOptions,
): CacheDriverContract {
  return createLazyOptionalCacheDriver({
    name: options.name,
    driver: 'database',
    options,
    loadModule: databaseDriverModuleLoader,
    createDriver: (module, driverOptions) => module.createDatabaseCacheDriver(driverOptions),
  })
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
