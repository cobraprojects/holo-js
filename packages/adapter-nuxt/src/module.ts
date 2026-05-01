import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, extname, relative, resolve } from 'node:path'
import {
  addImports,
  addServerHandler,
  addServerImportsDir,
  addServerPlugin,
  createResolver,
  defineNuxtModule,
} from '@nuxt/kit'
import { loadConfigDirectory, type LoadedHoloConfig, type HoloConfigMap } from '@holo-js/config'

export type ModuleOptions = Record<string, never>

type StorageDriver = 'local' | 'public' | 's3'
type StorageVisibility = 'private' | 'public'

type StorageDiskConfig = {
  driver: StorageDriver
  visibility?: StorageVisibility
  root?: string
  url?: string
  bucket?: string
  region?: string
  endpoint?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  forcePathStyleEndpoint?: boolean
  [key: string]: unknown
}

type StorageModuleOptions = {
  defaultDisk?: string
  routePrefix?: string
  disks?: Record<string, StorageDiskConfig>
}

type RuntimeDiskConfig = {
  name: string
  driver: StorageDriver
  visibility: StorageVisibility
  root?: string
  url?: string
  bucket?: string
  region?: string
  endpoint?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  forcePathStyleEndpoint?: boolean
}

type HoloStorageRuntimeConfig = {
  defaultDisk: string | undefined
  diskNames: string[]
  routePrefix: string
  disks: Record<string, RuntimeDiskConfig>
}

type StorageModule = {
  applyNitroStorageConfig(
    nitro: NuxtOptionsWithNitro,
    config: HoloStorageRuntimeConfig,
    s3Driver: string,
  ): void
  hasPublicLocalDisk(config: HoloStorageRuntimeConfig): boolean
  mergeModuleOptions(
    base: StorageModuleOptions | undefined,
    overrides: StorageModuleOptions | undefined,
  ): StorageModuleOptions
  normalizeModuleOptions(options: StorageModuleOptions | undefined): HoloStorageRuntimeConfig
}

type StorageS3Module = {
  default: unknown
}

const MODEL_FILE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'])

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasModuleNotFoundCode(error: unknown, expectedSpecifier: string): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  if ('code' in error && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND') {
    const message = 'message' in error && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : ''
    const escapedSpecifier = escapeRegExp(expectedSpecifier)
    if ([
      new RegExp(`Cannot find package ['"]${escapedSpecifier}['"]`),
      new RegExp(`Cannot find module ['"]${escapedSpecifier}['"]`),
      new RegExp(`Could not resolve ['"]${escapedSpecifier}['"]`),
      new RegExp(`Failed to load url\\s+(?:['"\`]${escapedSpecifier}['"\`]|${escapedSpecifier}(?=[\\s(]|$))`),
    ].some(pattern => pattern.test(message))) {
      return true
    }
  }

  if ('cause' in error) {
    return hasModuleNotFoundCode((error as { cause?: unknown }).cause, expectedSpecifier)
  }

  return false
}

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
    public?: {
      holo?: {
        appName?: string
        [key: string]: unknown
      }
      [key: string]: unknown
    }
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

/* v8 ignore next 15 -- optional-package absence is validated in published-package integration, not in this monorepo test graph */
async function importOptionalStorageModule(): Promise<StorageModule | undefined> {
  try {
    return await import('@holo-js/storage') as StorageModule
  } catch (error) {
    if (hasModuleNotFoundCode(error, '@holo-js/storage')) {
      return undefined
    }

    throw error
  }
}

/* v8 ignore next 15 -- optional-package absence is validated in published-package integration, not in this monorepo test graph */
async function importOptionalStorageS3Module(): Promise<StorageS3Module | undefined> {
  try {
    const storageS3 = await import('@holo-js/storage-s3' as string) as Partial<StorageS3Module>
    return typeof storageS3.default === 'undefined'
      ? undefined
      : storageS3 as StorageS3Module
  } catch (error) {
    if (hasModuleNotFoundCode(error, '@holo-js/storage-s3')) {
      return undefined
    }

    throw error
  }
}

function hasLoadedConfigFile(
  loaded: LoadedHoloConfig<HoloConfigMap>,
  configName: string,
): boolean {
  return loaded.loadedFiles.some((filePath) => {
    const normalizedPath = filePath.replaceAll('\\', '/')
    return normalizedPath.endsWith(`/config/${configName}.ts`)
      || normalizedPath.endsWith(`/config/${configName}.mts`)
      || normalizedPath.endsWith(`/config/${configName}.js`)
      || normalizedPath.endsWith(`/config/${configName}.mjs`)
      || normalizedPath.endsWith(`/config/${configName}.cts`)
      || normalizedPath.endsWith(`/config/${configName}.cjs`)
  })
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

type ServerModelImportArtifacts = {
  importDir: string
  pluginFile: string
}

async function createServerModelImports(sourceDir: string): Promise<ServerModelImportArtifacts | null> {
  const modelsDir = resolve(sourceDir, 'server/models')
  const generatedSchemaPath = resolve(sourceDir, 'server/db/schema.generated.ts')
  const modelImportDir = resolve(sourceDir, '.holo-js/generated/nuxt-server-imports')
  const modelImportFile = resolve(modelImportDir, 'models.ts')
  const modelPluginFile = resolve(modelImportDir, 'plugin.ts')

  let modelFiles: string[]
  try {
    modelFiles = (await readdir(modelsDir))
      .filter(fileName => MODEL_FILE_EXTENSIONS.has(extname(fileName)))
      .sort((left, right) => left.localeCompare(right))
  } catch {
    return null
  }

  if (modelFiles.length === 0) {
    return null
  }

  const generatedSchemaImportPath = relative(modelImportDir, generatedSchemaPath).replaceAll('\\', '/')
  const normalizedGeneratedSchemaImportPath = generatedSchemaImportPath.replace(/^(?!\.)/, './')
  const lines = [
    `import '${normalizedGeneratedSchemaImportPath.slice(0, -extname(normalizedGeneratedSchemaImportPath).length)}'`,
    '',
    ...modelFiles.map((fileName) => {
    const modelName = basename(fileName, extname(fileName))
    const importPath = relative(modelImportDir, resolve(modelsDir, fileName)).replaceAll('\\', '/')
    const normalizedImportPath = importPath.replace(/^(?!\.)/, './')
    const extension = extname(normalizedImportPath)
    return `export { default as ${modelName} } from '${normalizedImportPath.slice(0, -extension.length)}'`
    }),
  ]
  const pluginLines = [
    `import '${normalizedGeneratedSchemaImportPath.slice(0, -extname(normalizedGeneratedSchemaImportPath).length)}'`,
    "import './models'",
    '',
    'export default () => {}',
  ]

  await mkdir(modelImportDir, { recursive: true })
  await writeFile(modelImportFile, `${lines.join('\n')}\n`, 'utf8')
  await writeFile(modelPluginFile, `${pluginLines.join('\n')}\n`, 'utf8')
  return {
    importDir: modelImportDir,
    pluginFile: modelPluginFile,
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
    const storageModule = await importOptionalStorageModule()
    const loadedStorageOptions = toStorageModuleOptions(loaded)
    const s3Driver = resolver.resolve('./runtime/drivers/s3.js')

    opts.nitro = opts.nitro || { storage: {} }
    opts.nitro.storage = opts.nitro.storage || {}
    opts.runtimeConfig = opts.runtimeConfig || {}
    opts.runtimeConfig.public = opts.runtimeConfig.public || {}
    opts.runtimeConfig.public.holo = {
      ...(opts.runtimeConfig.public.holo || {}),
      appName: loaded.app.name,
    }
    opts.runtimeConfig.holo = {
      appUrl: loaded.app.url,
      appEnv: loaded.app.env,
      appDebug: loaded.app.debug,
      projectRoot: rootDir,
    }
    opts.runtimeConfig.db = loaded.database
    const storageConfigured = hasLoadedConfigFile(loaded, 'storage')
    /* v8 ignore next 3 -- exercised only when the optional package is absent outside the monorepo test graph */
    if (!storageModule && storageConfigured) {
      throw new Error('[@holo-js/adapter-nuxt] Storage config requires @holo-js/storage to be installed.')
    }

    const mergedStorageOptions = storageModule?.mergeModuleOptions(undefined, loadedStorageOptions)
    /* v8 ignore next 2 -- false branch is equivalent to the already-covered no-storage path above */
    const normalizedStorage = mergedStorageOptions ? storageModule?.normalizeModuleOptions(mergedStorageOptions) : undefined
    opts._holoStorageModuleOptions = mergedStorageOptions
    /* v8 ignore next 5 -- exercised only when the optional package is absent outside the monorepo test graph */
    if (normalizedStorage && Object.values(normalizedStorage.disks).some(disk => disk.driver === 's3')) {
      if (!await importOptionalStorageS3Module()) {
        throw new Error('[@holo-js/adapter-nuxt] S3 storage disks require @holo-js/storage-s3 to be installed.')
      }
    }
    if (normalizedStorage) {
      opts.runtimeConfig.holoStorage = normalizedStorage
    }

    if (!opts._holoCoreRuntimeRegistered) {
      const imports = [
        { name: 'holo', as: 'holo', from: resolver.resolve('./runtime/composables') },
        { name: 'useHoloDb', as: 'useHoloDb', from: resolver.resolve('./runtime/composables') },
        { name: 'useHoloEnv', as: 'useHoloEnv', from: resolver.resolve('./runtime/composables') },
        { name: 'useHoloDebug', as: 'useHoloDebug', from: resolver.resolve('./runtime/composables') },
      ]
      if (storageModule) {
        imports.push(
          { name: 'useStorage', as: 'useStorage', from: resolver.resolve('./runtime/composables/storage') },
          { name: 'Storage', as: 'Storage', from: resolver.resolve('./runtime/composables/storage') },
        )
      }
      addServerPlugin(resolver.resolve('./runtime/plugins/init'))
      addImports(imports)
      addServerImportsDir(resolver.resolve('./runtime/server/imports'))
      const serverModelImports = await createServerModelImports(sourceDir)
      if (serverModelImports) {
        addServerImportsDir(serverModelImports.importDir)
        addServerPlugin(serverModelImports.pluginFile)
      }
      opts._holoCoreRuntimeRegistered = true
    }

    if (storageModule && !opts._holoStorageRuntimeRegistered) {
      addServerPlugin(resolver.resolve('./runtime/plugins/storage'))
      opts._holoStorageRuntimeRegistered = true
    }

    if (
      storageModule
      && normalizedStorage
      && (!opts.nitro.storage || Object.keys(opts.nitro.storage).every(key => !key.startsWith('holo:')))
    ) {
      storageModule.applyNitroStorageConfig(opts, normalizedStorage, s3Driver)
    }

    const runtimePath = resolver.resolve('./runtime')
    if (!opts.build.transpile.includes(runtimePath)) {
      opts.build.transpile.push(runtimePath)
    }

    if (storageModule && !opts._holoStorageFinalizeRegistered) {
      opts._holoStorageFinalizeRegistered = true
      nuxt.hook('modules:done', () => {
        const finalNormalized = storageModule.normalizeModuleOptions(opts._holoStorageModuleOptions as StorageModuleOptions)
        opts.runtimeConfig = opts.runtimeConfig || {}
        opts.runtimeConfig.holoStorage = finalNormalized
        storageModule.applyNitroStorageConfig(opts, finalNormalized, s3Driver)

        if (storageModule.hasPublicLocalDisk(finalNormalized)) {
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

export const moduleInternals = {
  hasModuleNotFoundCode,
  hasLoadedConfigFile,
  importOptionalStorageS3Module,
}

export const adapterNuxtInternals = {
  toStorageModuleOptions,
}
