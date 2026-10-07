import {
  resolveCacheKey,
  type CacheDependencyDescriptor,
  type CacheDependencyIndex,
  type CacheFlexibleTtlInput,
  type CacheKeyInput,
  type CacheLockContract,
  type CacheQueryBridge,
  type CacheTtlInput,
  type CacheValueResolver,
} from './contracts'
import {
  createFlexibleEnvelope,
  normalizeFlexibleTtl,
  resolveFlexibleCachedValue,
  type NormalizedFlexibleTtl,
} from './flexible'
import { getCacheRuntime } from './runtime-shared'
import {
  createCacheLock,
  createIndexedKey,
  forgetCacheEntry,
  forgetNormalizedCacheEntry,
  readCacheEntry,
  resolveDriverContext,
  writeCacheEntry,
} from './entries'

type DependencyIndexState = {
  readonly keyToDependencies: Map<string, Set<CacheDependencyDescriptor>>
  readonly dependencyToKeys: Map<CacheDependencyDescriptor, Set<string>>
}

function createDependencyIndexState(): DependencyIndexState {
  return {
    keyToDependencies: new Map<string, Set<CacheDependencyDescriptor>>(),
    dependencyToKeys: new Map<CacheDependencyDescriptor, Set<string>>(),
  }
}

function createMemoryDependencyIndex(
  state: DependencyIndexState = createDependencyIndexState(),
): CacheDependencyIndex {
  return Object.freeze({
    async register(key: string, dependencies: readonly CacheDependencyDescriptor[]): Promise<void> {
      await this.removeKey(key)
      if (dependencies.length === 0) {
        return
      }

      const uniqueDependencies = new Set<CacheDependencyDescriptor>(dependencies)
      state.keyToDependencies.set(key, uniqueDependencies)

      for (const dependency of uniqueDependencies) {
        const keys = state.dependencyToKeys.get(dependency) ?? new Set<string>()
        keys.add(key)
        state.dependencyToKeys.set(dependency, keys)
      }
    },
    async listKeys(dependency: CacheDependencyDescriptor): Promise<readonly string[]> {
      return Object.freeze([...(state.dependencyToKeys.get(dependency) ?? new Set<string>())])
    },
    async listRegisteredKeys(): Promise<readonly string[]> {
      return Object.freeze([...state.keyToDependencies.keys()])
    },
    async removeKey(key: string): Promise<void> {
      const dependencies = state.keyToDependencies.get(key)
      if (!dependencies) {
        return
      }

      state.keyToDependencies.delete(key)
      for (const dependency of dependencies) {
        const keys = state.dependencyToKeys.get(dependency)
        if (!keys) {
          continue
        }

        keys.delete(key)
        if (keys.size === 0) {
          state.dependencyToKeys.delete(dependency)
        }
      }
    },
    async clear(): Promise<void> {
      state.keyToDependencies.clear()
      state.dependencyToKeys.clear()
    },
  })
}

function getQueryBridgeState(): {
  dependencyIndex?: CacheDependencyIndex
} {
  const runtime = globalThis as typeof globalThis & {
    __holoCacheQueryBridge__?: {
      dependencyIndex?: CacheDependencyIndex
    }
  }

  runtime.__holoCacheQueryBridge__ ??= {}
  return runtime.__holoCacheQueryBridge__
}

export function getOrCreateDependencyIndex(): CacheDependencyIndex {
  const state = getQueryBridgeState()
  state.dependencyIndex ??= createMemoryDependencyIndex()
  return state.dependencyIndex
}

export function resetDefaultDependencyIndex(): void {
  getQueryBridgeState().dependencyIndex = undefined
}

async function getCachedValue<TValue>(
  key: CacheKeyInput<TValue>,
  driverName?: string,
): Promise<TValue | null> {
  const entry = await readCacheEntry(key, driverName)
  return entry.hit ? entry.value : null
}

function createFlexibleLock(
  key: CacheKeyInput<unknown>,
  ttl: NormalizedFlexibleTtl,
  driverName?: string,
): CacheLockContract {
  return createCacheLock(`__flexible__:${resolveCacheKey(key)}`, Math.max(1, ttl.staleSeconds), driverName)
}

function parseIndexedKey(indexedKey: string): {
  readonly driverName: string
  readonly normalizedKey: string
} {
  const delimiterIndex = indexedKey.indexOf('\u0000')
  if (delimiterIndex === -1) {
    return Object.freeze({
      driverName: getCacheRuntime().config.default,
      normalizedKey: indexedKey,
    })
  }

  return Object.freeze({
    driverName: indexedKey.slice(0, delimiterIndex),
    normalizedKey: indexedKey.slice(delimiterIndex + 1),
  })
}

export function setGlobalDatabaseQueryCacheBridge(bridge?: CacheQueryBridge): void {
  const runtime = globalThis as typeof globalThis & {
    __holoDbQueryCacheBridge__?: {
      bridge?: CacheQueryBridge
    }
  }

  runtime.__holoDbQueryCacheBridge__ ??= {}
  runtime.__holoDbQueryCacheBridge__.bridge = bridge
}

export function createCacheQueryBridge(
  dependencyIndex: CacheDependencyIndex = getOrCreateDependencyIndex(),
): CacheQueryBridge {
  async function syncDependencies(
    indexedKey: string,
    dependencies?: readonly CacheDependencyDescriptor[],
  ): Promise<void> {
    if (dependencies && dependencies.length > 0) {
      await dependencyIndex.register(indexedKey, dependencies)
      return
    }

    await dependencyIndex.removeKey(indexedKey)
  }

  return Object.freeze({
    async get<TValue>(key: CacheKeyInput<TValue>, options?: { driver?: string }): Promise<TValue | null> {
      return getCachedValue<TValue>(key, options?.driver)
    },
    async put<TValue>(
      key: CacheKeyInput<TValue>,
      value: TValue,
      options: {
        readonly driver?: string
        readonly ttl?: CacheTtlInput
        readonly flexible?: CacheFlexibleTtlInput
        readonly dependencies?: readonly CacheDependencyDescriptor[]
      },
    ): Promise<void> {
      const indexedKey = createIndexedKey(key, options.driver)
      const resolvedTtl = typeof options.flexible === 'undefined'
        ? options.ttl
        : normalizeFlexibleTtl(options.flexible).staleSeconds

      await writeCacheEntry(key, value, resolvedTtl, options.driver)
      await syncDependencies(indexedKey, options.dependencies)
    },
    async flexible<TValue>(
      key: CacheKeyInput<TValue>,
      ttl: CacheFlexibleTtlInput,
      callback: CacheValueResolver<TValue>,
      options: {
        readonly driver?: string
        readonly dependencies?: readonly CacheDependencyDescriptor[]
      } = {},
    ): Promise<Awaited<TValue>> {
      const indexedKey = createIndexedKey(key, options.driver)

      const refreshValue = async (normalizedTtl: NormalizedFlexibleTtl): Promise<Awaited<TValue>> => {
        const value = await callback()
        const envelope = createFlexibleEnvelope(normalizedTtl, value)
        await writeCacheEntry(
          key,
          envelope,
          normalizedTtl.staleSeconds,
          options.driver,
        )
        await syncDependencies(indexedKey, options.dependencies)
        return value
      }

      return resolveFlexibleCachedValue<Awaited<TValue>>({
        ttl,
        read: async () => getCachedValue<unknown>(key, options.driver),
        refresh: normalizedTtl => refreshValue(normalizedTtl),
        createLock: normalizedTtl => createFlexibleLock(key, normalizedTtl, options.driver),
      })
    },
    async forget(key: CacheKeyInput<unknown>, options?: { driver?: string }): Promise<boolean> {
      return forgetCacheEntry(key, options?.driver, dependencyIndex)
    },
    async invalidateDependencies(
      dependencies: readonly CacheDependencyDescriptor[],
      options?: { driver?: string },
    ): Promise<void> {
      const invalidatedKeys = new Set<string>()
      const driverName = options?.driver?.trim()

      for (const dependency of dependencies) {
        const indexedKeys = await dependencyIndex.listKeys(dependency)
        for (const indexedKey of indexedKeys) {
          /* v8 ignore next 3 -- repeated dependency listings collapse after the first removeKey() call in the shared index. */
          if (invalidatedKeys.has(indexedKey)) {
            continue
          }

          invalidatedKeys.add(indexedKey)
          const parsed = parseIndexedKey(indexedKey)
          if (driverName && parsed.driverName !== driverName) {
            continue
          }

          await forgetNormalizedCacheEntry(resolveDriverContext(parsed.driverName), parsed.normalizedKey, dependencyIndex)
        }
      }
    },
  })
}

export const cacheQueryBridgeInternals = {
  createCacheQueryBridge,
  createIndexedKey,
  createMemoryDependencyIndex,
  getOrCreateDependencyIndex,
  parseIndexedKey,
  resetDefaultDependencyIndex,
  setGlobalDatabaseQueryCacheBridge,
}
