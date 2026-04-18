import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetOptionalStorageRuntime, storageRuntimeInternals } from '../src/storageRuntime'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('@holo-js/core storage runtime optional imports', () => {
  it('resets the storage runtime through the dynamic loader', async () => {
    const resetStorageRuntime = vi.fn()
    vi.spyOn(storageRuntimeInternals, 'importOptionalModule').mockResolvedValueOnce({
      resetStorageRuntime,
    })

    await resetOptionalStorageRuntime()

    expect(resetStorageRuntime).toHaveBeenCalledTimes(1)
  })

  it('treats missing storage runtime modules as optional during reset', async () => {
    vi.spyOn(storageRuntimeInternals, 'importOptionalModule').mockResolvedValueOnce(undefined)
    await expect(resetOptionalStorageRuntime()).resolves.toBeUndefined()
  })

  it('rethrows non-missing storage runtime import failures during reset', async () => {
    vi.spyOn(storageRuntimeInternals, 'importOptionalModule').mockRejectedValueOnce(new Error('boom'))
    await expect(resetOptionalStorageRuntime()).rejects.toThrow('boom')
  })
})
