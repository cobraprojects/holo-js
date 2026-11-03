import type { loadConfigDirectory } from '@holo-js/config'
import { unregisterDatabaseDriverFactory } from '@holo-js/db'
import { loadProjectDatabaseDrivers } from './database-drivers'
import { resolveProjectPackageImportSpecifier } from './project'
import { writeLine } from './io'
import type { IoStreams } from './cli-types'
import { loadConfigWithNormalizers } from './project/load-config'
import { errorMessage } from './error-message'

type CacheConfig = {
  readonly default: string
  readonly prefix: string
  readonly drivers: Readonly<Record<string, unknown>>
}

type LoadedCacheConfig = Omit<Awaited<ReturnType<typeof loadConfigDirectory>>, 'cache'> & {
  readonly cache?: CacheConfig
}

type CacheLockModule = {
  get(): Promise<boolean>
  release(): Promise<boolean>
}

type CacheRepositoryModule = {
  driver(name: string): CacheRepositoryModule
  flush(): Promise<void>
  forget(key: string): Promise<boolean>
  lock(name: string, seconds: number): CacheLockModule
}

type CacheCliModule = {
  configureCacheRuntime(options: {
    config: CacheConfig
    databaseConfig: Awaited<ReturnType<typeof loadConfigDirectory>>['database']
    redisConfig: Awaited<ReturnType<typeof loadConfigDirectory>>['redis']
  }): void
  loadCachePluginDrivers?(projectRoot?: string, pluginNames?: readonly string[]): Promise<void>
  resetCacheRuntime(): void
  default?: CacheRepositoryModule & {
    configureCacheRuntime(options: {
      config: CacheConfig
      databaseConfig: Awaited<ReturnType<typeof loadConfigDirectory>>['database']
      redisConfig: Awaited<ReturnType<typeof loadConfigDirectory>>['redis']
    }): void
    loadCachePluginDrivers?(projectRoot?: string, pluginNames?: readonly string[]): Promise<void>
    resetCacheRuntime(): void
  }
}

type CacheRuntimeFacade = CacheRepositoryModule & Pick<CacheCliModule, 'configureCacheRuntime' | 'loadCachePluginDrivers' | 'resetCacheRuntime'>

export type CacheStoreDescriptor = {
  readonly name: string
  readonly driver?: string
}

type CacheMaintenanceEnvironment = {
  readonly cache: CacheRepositoryModule
  readonly store: CacheStoreDescriptor
  cleanup(): Promise<void>
}

export class CachePackageMissingError extends Error {
  constructor() {
    super('[Holo CLI] @holo-js/cache is not installed.')
    this.name = 'CachePackageMissingError'
  }
}

export class CacheStoreUnavailableError extends Error {
  readonly store: CacheStoreDescriptor

  constructor(store: CacheStoreDescriptor, message: string, options: { cause?: unknown } = {}) {
    super(message, options)
    this.name = 'CacheStoreUnavailableError'
    this.store = store
  }
}

const BUILT_IN_CACHE_DRIVER_NAMES = new Set(['database', 'file', 'memory', 'redis'])
const CONCRETE_CACHE_DRIVER_PACKAGES = {
  database: '@holo-js/cache-db',
  redis: '@holo-js/cache-redis',
} as const

type ConcreteCacheDriverName = keyof typeof CONCRETE_CACHE_DRIVER_PACKAGES

async function loadConfiguredCacheDriverPackages(
  projectRoot: string,
  drivers: CacheConfig['drivers'],
  loadPackage: (specifier: string) => Promise<unknown> = specifier => import(specifier),
): Promise<void> {
  for (const [storeName, driverConfig] of Object.entries(drivers)) {
    const driver = resolveConfiguredCacheDriverName(driverConfig)
    if (driver !== 'database' && driver !== 'redis') continue
    const packageName = CONCRETE_CACHE_DRIVER_PACKAGES[driver satisfies ConcreteCacheDriverName]
    try {
      await loadPackage(resolveProjectPackageImportSpecifier(projectRoot, packageName))
    } catch (error) {
      throw new CacheStoreUnavailableError(
        { name: storeName, driver },
        `[Holo CLI] Cache driver "${driver}" requires ${packageName} to be installed.`,
        { cause: error },
      )
    }
  }
}

function resolveCacheFacade(cacheModule: CacheCliModule): CacheRuntimeFacade {
  const candidate = cacheModule.default
  if (candidate) {
    return candidate
  }

  return cacheModule as CacheRuntimeFacade
}

function resolveConfiguredCacheDriverName(driverConfig: unknown): string | undefined {
  if (!driverConfig || typeof driverConfig !== 'object' || Array.isArray(driverConfig)) {
    return undefined
  }

  const value = (driverConfig as Readonly<Record<string, unknown>>).driver
  return typeof value === 'string' ? value : undefined
}

function resolveCachePluginDriverLoader(
  cacheModule: CacheCliModule,
  cache: CacheRuntimeFacade,
  store: CacheStoreDescriptor,
): ((projectRoot?: string, pluginNames?: readonly string[]) => Promise<void>) | undefined {
  const loadCachePluginDrivers = ('loadCachePluginDrivers' in cache ? cache.loadCachePluginDrivers?.bind(cache) : undefined)
    ?? ('loadCachePluginDrivers' in cacheModule ? cacheModule.loadCachePluginDrivers?.bind(cacheModule) : undefined)

  if (!store.driver || BUILT_IN_CACHE_DRIVER_NAMES.has(store.driver)) {
    return undefined
  }

  if (loadCachePluginDrivers) {
    return loadCachePluginDrivers
  }

  throw new CacheStoreUnavailableError(
    store,
    `[Holo CLI] Cache store "${store.name}" uses plugin driver "${store.driver}", `
    + 'but the installed @holo-js/cache package does not support cache plugin drivers.',
  )
}

function resolveCacheStore(config: CacheConfig, requestedStoreName: string | undefined): CacheStoreDescriptor {
  const name = requestedStoreName?.trim() || config.default
  return { name, driver: resolveConfiguredCacheDriverName(config.drivers[name]) }
}

export const cacheCommandInternals = {
  loadConfiguredCacheDriverPackages,
  resolveCachePluginDriverLoader,
}

export async function loadCacheCliModule(projectRoot: string): Promise<CacheCliModule> {
  return await import(resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/cache')) as CacheCliModule
}

export async function initializeCacheMaintenanceEnvironment(
  projectRoot: string,
  driverName?: string,
): Promise<CacheMaintenanceEnvironment> {
  const loadedConfig = await loadConfigWithNormalizers(projectRoot) as LoadedCacheConfig
  const cacheConfig = loadedConfig.cache
  if (!cacheConfig) {
    throw new CachePackageMissingError()
  }

  const databaseDriverFactories = await loadProjectDatabaseDrivers(projectRoot, loadedConfig.database)
  const cacheModule = await loadCacheCliModule(projectRoot)
  const cache = resolveCacheFacade(cacheModule)
  await loadConfiguredCacheDriverPackages(projectRoot, cacheConfig.drivers)
  const store = resolveCacheStore(cacheConfig, driverName)
  const loadCachePluginDrivers = resolveCachePluginDriverLoader(cacheModule, cache, store)

  cache.configureCacheRuntime({
    config: cacheConfig,
    databaseConfig: loadedConfig.database,
    redisConfig: loadedConfig.redis,
  })
  if (loadCachePluginDrivers) {
    try {
      await loadCachePluginDrivers(projectRoot, loadedConfig.app.plugins)
    } catch (error) {
      cache.resetCacheRuntime()
      throw new CacheStoreUnavailableError(store, errorMessage(error), { cause: error })
    }
  }

  return {
    cache,
    store,
    async cleanup() {
      cache.resetCacheRuntime()
      for (const factory of [...databaseDriverFactories].reverse()) {
        unregisterDatabaseDriverFactory(factory)
      }
    },
  }
}

export async function runCacheClearCommand(
  io: IoStreams,
  projectRoot: string,
  driverName?: string,
  dependencies: {
    initializeCache?: typeof initializeCacheMaintenanceEnvironment
    flush?: (repository: CacheRepositoryModule) => Promise<void>
  } = {},
): Promise<void> {
  const environment = await (dependencies.initializeCache ?? initializeCacheMaintenanceEnvironment)(projectRoot, driverName)

  try {
    const repository = driverName?.trim()
      ? environment.cache.driver(driverName)
      : environment.cache
    await (dependencies.flush ?? (async (target) => await target.flush()))(repository)
    writeLine(io.stdout, driverName?.trim()
      ? `[cache] Cleared cache store "${driverName}".`
      : '[cache] Cleared the default cache store.')
  } finally {
    await environment.cleanup()
  }
}

export async function runCacheForgetCommand(
  io: IoStreams,
  projectRoot: string,
  key: string,
  driverName?: string,
  dependencies: {
    initializeCache?: typeof initializeCacheMaintenanceEnvironment
    forget?: (repository: CacheRepositoryModule, key: string) => Promise<boolean>
  } = {},
): Promise<void> {
  const environment = await (dependencies.initializeCache ?? initializeCacheMaintenanceEnvironment)(projectRoot, driverName)

  try {
    const repository = driverName?.trim()
      ? environment.cache.driver(driverName)
      : environment.cache
    const forgotten = await (dependencies.forget ?? (async (target, targetKey) => await target.forget(targetKey)))(repository, key)
    writeLine(io.stdout, forgotten
      ? `[cache] Forgot key "${key}".`
      : `[cache] Key "${key}" was not present.`)
  } finally {
    await environment.cleanup()
  }
}
