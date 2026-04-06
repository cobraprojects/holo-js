import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HoloStorageRuntimeConfig } from '@holo-js/storage'

type StoredValue = string | Uint8Array | ArrayBuffer | Buffer

function createBackend() {
  const values = new Map<string, StoredValue>()

  return {
    getItem: vi.fn(async <T>(key: string) => values.get(key) as T ?? null),
    getItemRaw: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: unknown) => {
      values.set(key, String(value))
    }),
    setItemRaw: vi.fn(async (key: string, value: StoredValue) => {
      values.set(key, value)
    }),
    hasItem: vi.fn(async (key: string) => values.has(key)),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key)
    }),
    getKeys: vi.fn(async (base = '') => Array.from(values.keys()).filter(key => key.startsWith(base))),
  }
}

describe('storage runtime plugin', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('configures storage runtime bindings from Nitro imports', async () => {
    const runtimeConfig: { holoStorage: HoloStorageRuntimeConfig, holo: { appUrl: string } } = {
      holoStorage: {
        defaultDisk: 'public',
        diskNames: ['public'],
        routePrefix: '/storage',
        disks: {
          public: {
            name: 'public',
            driver: 'public',
            visibility: 'public',
            root: './storage/app/public',
          },
        },
      },
      holo: {
        appUrl: 'https://app.test',
      },
    }
    const backend = createBackend()
    const useRuntimeConfig = vi.fn(() => runtimeConfig)
    const useNitroStorage = vi.fn(() => backend)

    vi.doMock('#imports', () => ({
      useRuntimeConfig,
      useStorage: useNitroStorage,
    }))
    vi.stubGlobal('defineNitroPlugin', (plugin: unknown) => plugin)

    const { resetStorageRuntime, useStorage } = await import('@holo-js/storage/runtime')
    resetStorageRuntime()

    const { default: initPlugin } = await import('../src/runtime/plugins/storage')
    ;(initPlugin as () => void)()

    const disk = useStorage('public')
    await expect(disk.exists('avatars/user-1.png')).resolves.toBe(false)
    expect(disk.url('avatars/user-1.png')).toBe('https://app.test/storage/avatars/user-1.png')
    expect(useRuntimeConfig).toHaveBeenCalled()
    expect(useNitroStorage).toHaveBeenCalledWith('holo:public')
  })

  it('re-exports the shared s3 runtime driver', async () => {
    const { default: adapterDriver } = await import('../src/runtime/drivers/s3')
    const { default: storageDriver } = await import('@holo-js/storage/runtime/drivers/s3')

    expect(adapterDriver).toBe(storageDriver)
  })
})
