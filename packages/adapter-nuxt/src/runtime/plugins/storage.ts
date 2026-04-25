import { configureStorageRuntime, type StorageBackend } from '@holo-js/storage/runtime'
import type { HoloStorageRuntimeConfig } from '@holo-js/storage'
import { useRuntimeConfig } from 'nitropack/runtime/config'
import { defineNitroPlugin } from 'nitropack/runtime/plugin'
import { useStorage as useNitroStorage } from 'nitropack/runtime/storage'

export default defineNitroPlugin(() => {
  configureStorageRuntime({
    getRuntimeConfig: () => useRuntimeConfig() as {
      holoStorage: HoloStorageRuntimeConfig
      holo?: { appUrl?: string }
    },
    getStorage: (base: string) => useNitroStorage(base) as StorageBackend,
  })
})
