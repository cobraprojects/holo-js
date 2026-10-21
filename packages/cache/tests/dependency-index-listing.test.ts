import { afterEach, expect, it, vi } from 'vitest'
import { cacheQueryBridgeInternals } from '../src/query-bridge'

afterEach(() => {
  vi.restoreAllMocks()
})

it('warns once when a remote table invalidation reaches a dependency index without listDependencies, and clears nothing', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const dependencyIndex = { ...cacheQueryBridgeInternals.createMemoryDependencyIndex(), listDependencies: undefined }
  const bridge = cacheQueryBridgeInternals.createCacheQueryBridge(dependencyIndex)

  await bridge.invalidateDependencyTables?.(['db:main:users'])
  await bridge.invalidateDependencyTables?.(['db:main:posts'])

  expect(warn).toHaveBeenCalledTimes(1)
  expect(warn.mock.calls[0]?.[0]).toContain('listDependencies()')
})
