import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetOptionalStorageRuntime } from '../src/storageRuntime'

function restoreVitestEnv(originalVitest: string | undefined): void {
  if (typeof originalVitest === 'undefined') {
    delete process.env.VITEST
    return
  }

  process.env.VITEST = originalVitest
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('@holo-js/core storage runtime optional imports', () => {
  it('loads the storage runtime through the indirect loader outside Vitest', async () => {
    const originalVitest = process.env.VITEST
    const resetStorageRuntime = vi.fn()

    process.env.VITEST = ''

    try {
      const evalSpy = vi.spyOn(globalThis, 'eval').mockImplementation((source: string) => {
        expect(source).toBe(`import(${JSON.stringify('@holo-js/storage/runtime')})`)
        return Promise.resolve({
          resetStorageRuntime,
        }) as never
      })

      await resetOptionalStorageRuntime()

      expect(evalSpy).toHaveBeenCalledTimes(1)
      expect(resetStorageRuntime).toHaveBeenCalledTimes(1)
    } finally {
      restoreVitestEnv(originalVitest)
    }
  })

  it('treats missing storage runtime modules as optional during reset', async () => {
    const originalVitest = process.env.VITEST

    process.env.VITEST = ''

    try {
      vi.spyOn(globalThis, 'eval').mockRejectedValueOnce(Object.assign(new Error('missing runtime'), {
        code: 'ERR_MODULE_NOT_FOUND',
      }))

      await expect(resetOptionalStorageRuntime()).resolves.toBeUndefined()
    } finally {
      restoreVitestEnv(originalVitest)
    }
  })

  it('rethrows non-missing storage runtime import failures during reset', async () => {
    const originalVitest = process.env.VITEST

    process.env.VITEST = ''

    try {
      vi.spyOn(globalThis, 'eval').mockRejectedValueOnce(new Error('boom'))

      await expect(resetOptionalStorageRuntime()).rejects.toThrow('boom')
    } finally {
      restoreVitestEnv(originalVitest)
    }
  })
})
