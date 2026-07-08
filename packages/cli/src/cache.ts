import { loadConfigDirectory } from '@holo-js/config'
import { resolveProjectPackageImportSpecifier } from './project'
import { writeLine } from './io'
import type { IoStreams } from './cli-types'

type LoadedCacheConfig = Awaited<ReturnType<typeof loadConfigDirectory>> & {
  readonly cache: {
    readonly default: string
    readonly prefix: string
    readonly drivers: Readonly<Record<string, unknown>>
  }
}

type CacheRepositoryModule = {
  driver(name: string): CacheRepositoryModule
  flush(): Promise<void>
  forget(key: string): Promise<boolean>
}

type CacheCliModule = {
  configureCacheRuntime(options: {
    config: LoadedCacheConfig['cache']
    databaseConfig: Awaited<ReturnType<typeof loadConfigDirectory>>['database']
    redisConfig: Awaited<ReturnType<typeof loadConfigDirectory>>['redis']
  }): void
  loadCachePluginDrivers?(projectRoot?: string): Promise<void>
  resetCacheRuntime(): void
  default?: CacheRepositoryModule & {
    configureCacheRuntime(options: {
      config: LoadedCacheConfig['cache']
      databaseConfig: Awaited<ReturnType<typeof loadConfigDirectory>>['database']
      redisConfig: Awaited<ReturnType<typeof loadConfigDirectory>>['redis']
    }): void
    loadCachePluginDrivers?(projectRoot?: string): Promise<void>
    resetCacheRuntime(): void
  }
}

type CacheRuntimeFacade = CacheRepositoryModule & Pick<CacheCliModule, 'configureCacheRuntime' | 'loadCachePluginDrivers' | 'resetCacheRuntime'>

type CacheMaintenanceEnvironment = {
  readonly cache: CacheRepositoryModule
  cleanup(): Promise<void>
}

const BUILT_IN_CACHE_DRIVER_NAMES = new Set(['database', 'file', 'memory', 'redis'])

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
  drivers: LoadedCacheConfig['cache']['drivers'],
  requestedDriverName: string | undefined,
  defaultDriverName: string,
): ((projectRoot?: string) => Promise<void>) | undefined {
  const loadCachePluginDrivers = ('loadCachePluginDrivers' in cache ? cache.loadCachePluginDrivers?.bind(cache) : undefined)
    ?? ('loadCachePluginDrivers' in cacheModule ? cacheModule.loadCachePluginDrivers?.bind(cacheModule) : undefined)
  const storeName = requestedDriverName?.trim() || defaultDriverName
  const driverName = resolveConfiguredCacheDriverName(drivers[storeName])

  if (!driverName || BUILT_IN_CACHE_DRIVER_NAMES.has(driverName)) {
    return undefined
  }

  if (loadCachePluginDrivers) {
    return loadCachePluginDrivers
  }

  throw new Error(
    `[Holo CLI] Cache store "${storeName}" uses plugin driver "${driverName}", `
    + 'but the installed @holo-js/cache package does not support cache plugin drivers.',
  )
}

export const cacheCommandInternals = {
  resolveCachePluginDriverLoader,
}

export async function loadCacheCliModule(projectRoot: string): Promise<CacheCliModule> {
  return await import(resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/cache')) as CacheCliModule
}

export async function initializeCacheMaintenanceEnvironment(
  projectRoot: string,
  driverName?: string,
): Promise<CacheMaintenanceEnvironment> {
  const loadedConfig = await loadConfigDirectory(projectRoot) as LoadedCacheConfig
  const cacheModule = await loadCacheCliModule(projectRoot)
  const cache = resolveCacheFacade(cacheModule)
  const loadCachePluginDrivers = resolveCachePluginDriverLoader(
    cacheModule,
    cache,
    loadedConfig.cache.drivers,
    driverName,
    loadedConfig.cache.default,
  )

  cache.configureCacheRuntime({
    config: loadedConfig.cache,
    databaseConfig: loadedConfig.database,
    redisConfig: loadedConfig.redis,
  })
  if (loadCachePluginDrivers) {
    try {
      await loadCachePluginDrivers(projectRoot)
    } catch (error) {
      cache.resetCacheRuntime()
      throw error
    }
  }

  return {
    cache,
    async cleanup() {
      cache.resetCacheRuntime()
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
