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
  resetCacheRuntime(): void
  default?: CacheRepositoryModule & {
    configureCacheRuntime(options: {
      config: LoadedCacheConfig['cache']
      databaseConfig: Awaited<ReturnType<typeof loadConfigDirectory>>['database']
      redisConfig: Awaited<ReturnType<typeof loadConfigDirectory>>['redis']
    }): void
    resetCacheRuntime(): void
  }
}

type CacheMaintenanceEnvironment = {
  readonly cache: CacheRepositoryModule
  cleanup(): Promise<void>
}

function resolveCacheFacade(cacheModule: CacheCliModule): CacheRepositoryModule & Pick<CacheCliModule, 'configureCacheRuntime' | 'resetCacheRuntime'> {
  const candidate = cacheModule.default
  if (candidate) {
    return candidate
  }

  return cacheModule as CacheRepositoryModule & Pick<CacheCliModule, 'configureCacheRuntime' | 'resetCacheRuntime'>
}

export async function loadCacheCliModule(projectRoot: string): Promise<CacheCliModule> {
  return await import(resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/cache')) as CacheCliModule
}

export async function initializeCacheMaintenanceEnvironment(projectRoot: string): Promise<CacheMaintenanceEnvironment> {
  const loadedConfig = await loadConfigDirectory(projectRoot) as LoadedCacheConfig
  const cacheModule = await loadCacheCliModule(projectRoot)
  const cache = resolveCacheFacade(cacheModule)

  cache.configureCacheRuntime({
    config: loadedConfig.cache,
    databaseConfig: loadedConfig.database,
    redisConfig: loadedConfig.redis,
  })

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
  const environment = await (dependencies.initializeCache ?? initializeCacheMaintenanceEnvironment)(projectRoot)

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
  const environment = await (dependencies.initializeCache ?? initializeCacheMaintenanceEnvironment)(projectRoot)

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
