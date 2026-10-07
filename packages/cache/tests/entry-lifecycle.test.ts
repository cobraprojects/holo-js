import { afterEach, describe, expect, it } from 'vitest'
import cache, {
  cacheQueryBridgeInternals,
  configureCacheRuntime,
  getCacheRuntime,
  resetCacheRuntime,
} from '../src'
import { createMemoryCacheDriver } from '../src/memory'

afterEach(() => resetCacheRuntime())

describe('cache entry lifecycle', () => {
  it.each(['repository', 'query bridge'] as const)('keeps a surviving entry invalidatable after %s deletion fails', async (consumer) => {
    const driver = createMemoryCacheDriver({ name: 'memory' })
    let deletionFails = true
    configureCacheRuntime({
      config: { default: 'memory', drivers: { memory: { driver: 'memory' } } },
      drivers: new Map([['memory', {
        ...driver,
        async forget(key: string) {
          if (deletionFails) throw new Error('Storage deletion failed')
          return driver.forget(key)
        },
      }]]),
    })
    const bridge = getCacheRuntime().queryBridge
    if (!bridge) throw new Error('Query cache is not configured')
    await bridge.put('users', ['Alice'], { dependencies: ['db:main:users'] })

    await expect(consumer === 'repository' ? cache.forget('users') : bridge.forget('users')).rejects.toThrow('Storage deletion failed')
    expect(await cache.get('users')).toEqual(['Alice'])
    deletionFails = false
    await bridge.invalidateDependencies(['db:main:users'])
    expect(await cache.get('users')).toBeNull()
  })

  it('retains an independently injected bridge index when the runtime index changes', async () => {
    configureCacheRuntime({
      config: { default: 'memory', prefix: 'app:', drivers: { memory: { driver: 'memory' } } },
    })
    const independent = cacheQueryBridgeInternals.createCacheQueryBridge(cacheQueryBridgeInternals.createMemoryDependencyIndex())
    const runtime = getCacheRuntime().queryBridge
    if (!runtime) throw new Error('Query cache is not configured')
    await independent.put('independent', { value: 1 }, { dependencies: ['db:main:users'] })
    await runtime.put('runtime', { value: 2 }, { dependencies: ['db:main:users'] })

    await independent.invalidateDependencies(['db:main:users'])
    expect(await cache.get('independent')).toBeNull()
    expect(await cache.get('runtime')).toEqual({ value: 2 })
  })
})
