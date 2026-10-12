import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { expect, it, onTestFinished } from 'vitest'
import cache, { CacheInvalidTtlError, configureCacheRuntime, resetCacheRuntime } from '../src'

it.each(['file', 'memory'] as const)('serves stale %s values while one real refresh owns the lock', async driver => {
  const directory = await mkdtemp(join(tmpdir(), 'holo-flexible-'))
  onTestFinished(async () => {
    resetCacheRuntime()
    await rm(directory, { recursive: true, force: true })
  })
  configureCacheRuntime({ config: { default: driver, drivers: { file: { driver: 'file', path: directory }, memory: { driver: 'memory' } } } })
  let generations = 0
  let finishRefresh: (() => void) | undefined
  const refresh = new Promise<void>(resolve => { finishRefresh = resolve })
  const generate = async () => {
    generations += 1
    if (generations === 2) await refresh
    return generations
  }
  expect(await cache.flexible('feed', [1, 5], generate)).toBe(1)
  expect(await cache.flexible('feed', { fresh: 1, stale: 5 }, generate)).toBe(1)
  expect(generations).toBe(1)
  await setTimeout(1100)
  expect(await cache.flexible('feed', [1, 5], generate)).toBe(1)
  await expect.poll(() => generations).toBe(2)
  expect(await cache.flexible('feed', [1, 5], generate)).toBe(1)
  expect(generations).toBe(2)
  if (!finishRefresh) throw new Error('Refresh did not initialize')
  finishRefresh()
  await expect.poll(() => cache.flexible('feed', [1, 5], generate)).toBe(2)
  expect(generations).toBe(2)
})

it('keeps named stores separate and reuses fresh values while rejecting invalid TTLs', async () => {
  configureCacheRuntime({
    config: { default: 'memory', drivers: { memory: { driver: 'memory' }, secondary: { driver: 'memory', prefix: 'secondary:' } } },
  })
  onTestFinished(resetCacheRuntime)
  await cache.put('profile', 'main', 60)
  await cache.driver('secondary').put('profile', 'secondary', 60)
  await expect(cache.get('profile')).resolves.toBe('main')
  await expect(cache.driver('secondary').get('profile')).resolves.toBe('secondary')
  let refreshes = 0
  const generate = () => { refreshes += 1; return 'fresh' }
  await expect(cache.flexible('fresh', { fresh: 60, stale: 300 }, generate)).resolves.toBe('fresh')
  await expect(cache.flexible('fresh', [60, 300], generate)).resolves.toBe('fresh')
  expect(refreshes).toBe(1)
  await expect(cache.flexible('invalid', [-1, 1], generate)).rejects.toBeInstanceOf(CacheInvalidTtlError)
  await expect(cache.flexible('invalid', [2, 1], generate)).rejects.toBeInstanceOf(CacheInvalidTtlError)
  await cache.forget('profile')
  await expect(cache.get('profile')).resolves.toBeNull()
  await expect(cache.driver('secondary').get('profile')).resolves.toBe('secondary')
})

it('waits for the real refresh lease and reuses its result for a concurrent cache miss', async () => {
  configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
  onTestFinished(resetCacheRuntime)
  let release: (() => void) | undefined
  const pending = new Promise<void>(resolve => { release = resolve })
  let generations = 0
  const generate = async () => {
    generations += 1
    await pending
    return 'published value'
  }
  const first = cache.flexible('concurrent', [60, 300], generate)
  await expect.poll(() => generations).toBe(1)
  const second = cache.flexible('concurrent', [60, 300], generate)
  await setTimeout(20)
  expect(generations).toBe(1)
  if (!release) throw new Error('Refresh did not initialize')
  release()
  expect(await Promise.all([first, second])).toEqual(['published value', 'published value'])
  expect(generations).toBe(1)
})
