import { resolve } from 'node:path'
import {
  addImports,
  addServerHandler,
  addServerImportsDir,
  addServerPlugin,
  createResolver,
  defineNuxtModule,
} from '@nuxt/kit'
import { loadConfigDirectory, type LoadedHoloConfig, type HoloConfigMap } from '@holo-js/config'
import {
  applyNitroStorageConfig,
  hasPublicLocalDisk,
  mergeModuleOptions,
  normalizeModuleOptions,
  type ModuleOptions as StorageModuleOptions,
  type HoloStorageRuntimeConfig,
} from '@holo-js/storage'

export type ModuleOptions = Record<string, never>

interface NuxtHookContext {
  hook: (
    name: string,
    callback: (payload: { references: Array<{ types: string }> }) => void,
  ) => void
}

interface NuxtOptionsWithNitro {
  nitro: {
    storage: Record<string, unknown>
    [key: string]: unknown
  }
  runtimeConfig: {
    holoStorage?: HoloStorageRuntimeConfig
    [key: string]: unknown
  }
  build: { transpile: string[] }
  srcDir: string
  rootDir?: string
  _holoStorageModuleOptions?: StorageModuleOptions
  _holoStorageFinalizeRegistered?: boolean
  _holoStorageRuntimeRegistered?: boolean
  _holoCoreRuntimeRegistered?: boolean
  _holoTypesRegistered?: boolean
}

function toStorageModuleOptions(
  loaded: LoadedHoloConfig<HoloConfigMap>,
): StorageModuleOptions {
  return {
    defaultDisk: loaded.storage.defaultDisk,
    routePrefix: loaded.storage.routePrefix,
    disks: { ...loaded.storage.disks },
  }
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: '@holo-js/adapter-nuxt',
  },
  async setup(_options: ModuleOptions, rawNuxt: unknown) {
    const nuxt = rawNuxt as NuxtHookContext & { options: NuxtOptionsWithNitro }
    const resolver = createResolver(import.meta.url)
    const opts = nuxt.options as unknown as NuxtOptionsWithNitro
    const rootDir = opts.rootDir ?? opts.srcDir ?? process.cwd()
    const sourceDir = opts.srcDir ?? rootDir
    const loaded = await loadConfigDirectory(rootDir, {
      preferCache: process.env.NODE_ENV === 'production',
      processEnv: process.env,
    })
    const loadedStorageOptions = toStorageModuleOptions(loaded)
    const s3Driver = resolver.resolve('./runtime/drivers/s3.js')

    opts.nitro = opts.nitro || { storage: {} }
    opts.nitro.storage = opts.nitro.storage || {}
    opts.runtimeConfig = opts.runtimeConfig || {}
    opts.runtimeConfig.holo = {
      appUrl: loaded.app.url,
      appEnv: loaded.app.env,
      appDebug: loaded.app.debug,
      projectRoot: rootDir,
    }
    opts.runtimeConfig.db = loaded.database

    const mergedStorageOptions = mergeModuleOptions(undefined, loadedStorageOptions)
    const normalizedStorage = normalizeModuleOptions(mergedStorageOptions)
    opts._holoStorageModuleOptions = mergedStorageOptions
    opts.runtimeConfig.holoStorage = normalizedStorage

    if (!opts._holoCoreRuntimeRegistered) {
      addServerPlugin(resolver.resolve('./runtime/plugins/init'))
      addImports([
        { name: 'holo', as: 'holo', from: resolver.resolve('./runtime/composables') },
        { name: 'useHoloDb', as: 'useHoloDb', from: resolver.resolve('./runtime/composables') },
        { name: 'useHoloEnv', as: 'useHoloEnv', from: resolver.resolve('./runtime/composables') },
        { name: 'useHoloDebug', as: 'useHoloDebug', from: resolver.resolve('./runtime/composables') },
        { name: 'useStorage', as: 'useStorage', from: resolver.resolve('./runtime/composables') },
        { name: 'Storage', as: 'Storage', from: resolver.resolve('./runtime/composables') },
      ])
      addServerImportsDir(resolver.resolve('./runtime/server/imports'))
      addServerImportsDir(resolve(sourceDir, 'server/models'))
      opts._holoCoreRuntimeRegistered = true
    }

    if (!opts._holoStorageRuntimeRegistered) {
      addServerPlugin(resolver.resolve('./runtime/plugins/storage'))
      opts._holoStorageRuntimeRegistered = true
    }

    if (!opts.nitro.storage || Object.keys(opts.nitro.storage).every(key => !key.startsWith('holo:'))) {
      applyNitroStorageConfig(opts, normalizedStorage, s3Driver)
    }

    const runtimePath = resolver.resolve('./runtime')
    if (!opts.build.transpile.includes(runtimePath)) {
      opts.build.transpile.push(runtimePath)
    }

    if (!opts._holoStorageFinalizeRegistered) {
      opts._holoStorageFinalizeRegistered = true
      nuxt.hook('modules:done', () => {
        const finalNormalized = normalizeModuleOptions(opts._holoStorageModuleOptions as StorageModuleOptions)
        opts.runtimeConfig = opts.runtimeConfig || {}
        opts.runtimeConfig.holoStorage = finalNormalized
        applyNitroStorageConfig(opts, finalNormalized, s3Driver)

        if (hasPublicLocalDisk(finalNormalized)) {
          addServerHandler({
            route: `${finalNormalized.routePrefix}/**`,
            handler: resolver.resolve('./runtime/server/routes/storage.get'),
          })
        }
      })
    }

    if (!opts._holoTypesRegistered) {
      opts._holoTypesRegistered = true
      nuxt.hook('prepare:types', ({ references }) => {
        references.push({ types: '@holo-js/adapter-nuxt' })
      })
    }
  },
})

export const adapterNuxtInternals = {
  toStorageModuleOptions,
}
