import { access, mkdir, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, extname, relative, resolve } from 'node:path'
import {
  addPlugin,
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
const HOLO_PACKAGE_SCOPE = '@holo-js/'
const CLIENT_OPTIMIZE_DEPS = [
  {
    packageName: `${HOLO_PACKAGE_SCOPE}forms`,
    include: `${HOLO_PACKAGE_SCOPE}forms > ${HOLO_PACKAGE_SCOPE}validation > valibot`,
  },
  {
    packageName: `${HOLO_PACKAGE_SCOPE}validation`,
    include: `${HOLO_PACKAGE_SCOPE}validation > valibot`,
  },
] as const

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

function isModuleResolutionFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  return 'code' in error
    && (
      (error as { code?: unknown }).code === 'MODULE_NOT_FOUND'
      || (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
    )
}

interface NuxtHookContext {
  hook: (
    name: string,
    callback: (payload: { references: Array<{ path?: string, types?: string }> }) => void,
  ) => void
}

type ViteOptimizeDepsOptions = {
  include?: string[]
  [key: string]: unknown
}

type NuxtViteOptions = {
  optimizeDeps?: ViteOptimizeDepsOptions
  [key: string]: unknown
}

interface NuxtOptionsWithNitro {
  nitro: {
    storage: Record<string, unknown>
    errorHandler?: string | string[]
    experimental?: {
      asyncContext?: boolean
      [key: string]: unknown
    }
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
  vite?: NuxtViteOptions
  srcDir: string
  rootDir?: string
  _holoStorageModuleOptions?: StorageModuleOptions
  _holoStorageFinalizeRegistered?: boolean
  _holoStorageRuntimeRegistered?: boolean
  _holoBroadcastAuthRouteRegistered?: boolean
  _holoRealtimeRouteRegistered?: boolean
  _holoCoreRuntimeRegistered?: boolean
  _holoTypesRegistered?: boolean
}

function hasProjectPackage(rootDir: string, packageName: string): boolean {
  const projectRequire = createRequire(resolve(rootDir, 'package.json'))
  try {
    projectRequire.resolve(packageName)
    return true
  } catch (error) {
    if (isModuleResolutionFailure(error)) {
      return false
    }

    throw error
  }
}

function resolveClientOptimizeDeps(rootDir: string): string[] {
  const projectRequire = createRequire(resolve(rootDir, 'package.json'))
  const deps: string[] = []

  for (const { packageName, include } of CLIENT_OPTIMIZE_DEPS) {
    try {
      projectRequire.resolve(packageName)
      deps.push(include)
    } catch (error) {
      /* v8 ignore next 3 -- unexpected resolver failures should fail module setup */
      if (!isModuleResolutionFailure(error)) {
        throw error
      }
    }
  }

  return deps
}

function addViteOptimizeDeps(opts: NuxtOptionsWithNitro, deps: readonly string[]): void {
  if (deps.length === 0) {
    return
  }

  opts.vite = opts.vite || {}
  opts.vite.optimizeDeps = opts.vite.optimizeDeps || {}
  opts.vite.optimizeDeps.include = [
    ...new Set([
      ...(opts.vite.optimizeDeps.include || []),
      ...deps,
    ]),
  ]
}

function addNitroErrorHandler(opts: NuxtOptionsWithNitro, handler: string): void {
  const current = opts.nitro.errorHandler
  const handlers = Array.isArray(current)
    ? current
    : typeof current === 'string'
      ? [current]
      : []

  if (!handlers.includes(handler)) {
    opts.nitro.errorHandler = [...handlers, handler]
  }
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

async function ensureModelRegistryTypesPlaceholder(path: string): Promise<void> {
  try {
    await access(path)
    return
  } catch {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '// Generated by holo prepare. Do not edit.\n\nexport {}\n', 'utf8')
  }
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

async function createServerModelImports(
  sourceDir: string,
  modelsRelativePath: string,
  generatedSchemaRelativePath: string,
): Promise<ServerModelImportArtifacts | null> {
  const modelsDir = resolve(sourceDir, modelsRelativePath)
  const generatedSchemaPath = resolve(sourceDir, generatedSchemaRelativePath)
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
    const authTypesPath = resolve(rootDir, '.holo-js/generated/auth.d.ts')
    const authorizationTypesPath = resolve(rootDir, '.holo-js/generated/authorization/types.d.ts')
    const modelRegistryTypesPath = resolve(rootDir, '.holo-js/generated/model-registry.d.ts')
    addViteOptimizeDeps(opts, resolveClientOptimizeDeps(rootDir))
    const loaded = await loadConfigDirectory(rootDir, {
      preferCache: process.env.NODE_ENV === 'production',
      processEnv: process.env,
    })
    const storageModule = await importOptionalStorageModule()
    const loadedStorageOptions = toStorageModuleOptions(loaded)
    const s3Driver = resolver.resolve('./runtime/drivers/s3.js')

    opts.nitro = opts.nitro || { storage: {} }
    opts.nitro.storage = opts.nitro.storage || {}
    addNitroErrorHandler(opts, resolver.resolve('./runtime/server/error'))
    opts.nitro.experimental = {
      ...(opts.nitro.experimental || {}),
      asyncContext: true,
    }
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
      addServerPlugin(resolver.resolve('./runtime/plugins/init'))
      addServerPlugin(resolver.resolve('./runtime/plugins/forms'))
      addServerImportsDir(resolver.resolve('./runtime/server/auto-imports'))
      const serverModelImports = await createServerModelImports(
        sourceDir,
        loaded.app.paths.models,
        loaded.app.paths.generatedSchema,
      )
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

    if (hasProjectPackage(rootDir, '@holo-js/broadcast') && !opts._holoBroadcastAuthRouteRegistered) {
      addServerHandler({
        route: '/broadcasting/config',
        handler: resolver.resolve('./runtime/server/routes/broadcast-config.get'),
      })
      addServerHandler({
        route: '/broadcasting/auth',
        handler: resolver.resolve('./runtime/server/routes/broadcast-auth.post'),
      })
      opts._holoBroadcastAuthRouteRegistered = true
    }

    if (hasProjectPackage(rootDir, '@holo-js/realtime') && !opts._holoRealtimeRouteRegistered) {
      addPlugin({
        src: resolver.resolve('./runtime/plugins/realtime.client'),
        mode: 'client',
      })
      addServerHandler({
        route: '/holo/realtime/query',
        handler: resolver.resolve('./runtime/server/routes/realtime-query.post'),
      })
      addServerHandler({
        route: '/holo/realtime/mutation',
        handler: resolver.resolve('./runtime/server/routes/realtime-mutation.post'),
      })
      addServerHandler({
        route: '/holo/realtime/stream',
        handler: resolver.resolve('./runtime/server/routes/realtime-stream.get'),
      })
      opts._holoRealtimeRouteRegistered = true
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
      await ensureModelRegistryTypesPlaceholder(authTypesPath)
      await ensureModelRegistryTypesPlaceholder(authorizationTypesPath)
      await ensureModelRegistryTypesPlaceholder(modelRegistryTypesPath)
      nuxt.hook('prepare:types', ({ references }) => {
        references.push({ types: '@holo-js/adapter-nuxt' })
        references.push({ path: authTypesPath })
        references.push({ path: authorizationTypesPath })
        references.push({ path: modelRegistryTypesPath })
      })
    }
  },
})

export const moduleInternals = {
  addViteOptimizeDeps,
  hasModuleNotFoundCode,
  hasLoadedConfigFile,
  importOptionalStorageS3Module,
  isModuleResolutionFailure,
  resolveClientOptimizeDeps,
}

export const adapterNuxtInternals = {
  toStorageModuleOptions,
}
