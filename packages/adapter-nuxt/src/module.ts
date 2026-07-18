import { lstatSync, readFileSync } from 'node:fs'
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
import '@holo-js/db/config'
import {
  createRealtimeClientDefinitionModule,
  createRealtimeClientDefinitionTransform,
} from './realtime-definition-transform'

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

const MODEL_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const HOLO_PACKAGE_SCOPE = '@holo-js/'
const realtimeClientDefinitionPrefix = '\0holo-realtime-client:'
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
const NITRO_RUNTIME_TRACE_IMPORTS = [
  '@holo-js/auth-clerk',
  '@holo-js/auth-social',
  '@holo-js/auth-workos',
  '@holo-js/authorization',
  '@holo-js/broadcast',
  '@holo-js/cache',
  '@holo-js/cache-db',
  '@holo-js/cache-redis',
  '@holo-js/db-mysql',
  '@holo-js/db-postgres',
  '@holo-js/db-sqlite',
  '@holo-js/events',
  '@holo-js/mail',
  '@holo-js/media',
  '@holo-js/notifications',
  '@holo-js/queue',
  '@holo-js/queue-db',
  '@holo-js/queue-redis',
  '@holo-js/security',
  '@holo-js/security/drivers/redis-adapter',
  '@holo-js/session',
  '@holo-js/session/drivers/redis-adapter',
  '@holo-js/storage',
  '@holo-js/storage/runtime',
  '@holo-js/storage-s3',
] as const
const NITRO_RUNTIME_EXTERNALS = [
  '@holo-js/auth',
  '@holo-js/auth-clerk',
  '@holo-js/auth-social',
  '@holo-js/auth-workos',
  '@holo-js/authorization',
  '@holo-js/broadcast',
  '@holo-js/cache',
  '@holo-js/cache-db',
  '@holo-js/cache-redis',
  '@holo-js/config',
  '@holo-js/core',
  '@holo-js/db',
  '@holo-js/db-mysql',
  '@holo-js/db-postgres',
  '@holo-js/db-sqlite',
  '@holo-js/events',
  '@holo-js/kernel',
  '@holo-js/mail',
  '@holo-js/media',
  '@holo-js/notifications',
  '@holo-js/queue',
  '@holo-js/queue-db',
  '@holo-js/queue-redis',
  '@holo-js/realtime',
  '@holo-js/security',
  '@holo-js/session',
  '@holo-js/storage',
  '@holo-js/storage-s3',
  '@holo-js/validation',
] as const
const NITRO_RUNTIME_INLINE_IMPORTS = [
  '@holo-js/auth/nuxt',
  '@holo-js/auth/nuxt/server',
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
  hook(
    name: 'prepare:types',
    callback: (payload: { references: Array<{ path?: string, types?: string }> }) => void,
  ): void
  hook(
    name: 'vite:extendConfig',
    callback: (config: NuxtViteOptions, context: { readonly isClient?: boolean, readonly isServer?: boolean }) => void,
  ): void
  hook(
    name: 'modules:done',
    callback: () => void,
  ): void
}

type ViteOptimizeDepsOptions = {
  include?: string[]
  [key: string]: unknown
}

type NuxtViteOptions = {
  optimizeDeps?: ViteOptimizeDepsOptions
  plugins?: unknown[]
  [key: string]: unknown
}

interface NuxtOptionsWithNitro {
  nitro: {
    storage: Record<string, unknown>
    errorHandler?: string | string[]
    externals?: {
      external?: unknown[]
      inline?: unknown[]
      trace?: boolean
      traceInclude?: string[]
      [key: string]: unknown
    }
    rollupConfig?: {
      preserveSymlinks?: boolean
      [key: string]: unknown
    }
    virtual?: Record<string, () => string>
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

function hasProjectPackage(
  rootDir: string,
  packageName: string,
  resolvePackage: (packageName: string) => string = createRequire(resolve(rootDir, 'package.json')).resolve,
): boolean {
  return typeof resolveProjectPackageEntry(rootDir, packageName, resolvePackage) === 'string'
}

function resolveProjectPackageEntry(
  rootDir: string,
  packageName: string,
  resolvePackage: (packageName: string) => string = createRequire(resolve(rootDir, 'package.json')).resolve,
): string | undefined {
  try {
    return resolvePackage(packageName)
  } catch (error) {
    if (isModuleResolutionFailure(error)) {
      return undefined
    }

    throw error
  }
}

function resolveProjectPackageTraceEntry(
  rootDir: string,
  packageName: string,
): string | undefined {
  const packageSegments = packageName.split('/')
  const packageRootName = packageName.startsWith('@')
    ? packageSegments.slice(0, 2).join('/')
    : packageSegments[0]
  if (!packageRootName) {
    return undefined
  }

  if (isProjectPackageLinked(rootDir, packageRootName)) {
    return undefined
  }

  return resolveProjectPackageEntry(rootDir, packageName)
}

function isProjectPackageLinked(rootDir: string, packageRootName: string): boolean {
  const projectPackageRoot = resolve(rootDir, 'node_modules', packageRootName)
  return lstatSync(projectPackageRoot, { throwIfNoEntry: false })?.isSymbolicLink() === true
}

function addNitroRuntimeTraceIncludes(
  opts: NuxtOptionsWithNitro,
  rootDir: string,
  pluginPackages: readonly string[] = [],
  resolvePackage: (rootDir: string, packageName: string) => string | undefined = resolveProjectPackageTraceEntry,
): void {
  const externals = opts.nitro.externals ?? {}
  const external = new Set(externals.external ?? [])
  const inline = new Set(externals.inline ?? [])
  const traceInclude = new Set(externals.traceInclude ?? [])
  for (const specifier of NITRO_RUNTIME_EXTERNALS) {
    external.add(specifier)
  }
  for (const specifier of NITRO_RUNTIME_INLINE_IMPORTS) {
    inline.add(specifier)
  }
  for (const specifier of [...NITRO_RUNTIME_TRACE_IMPORTS, ...pluginPackages]) {
    const packageEntry = resolvePackage(rootDir, specifier)
    if (packageEntry) {
      traceInclude.add(packageEntry)
    }
  }
  opts.nitro.externals = {
    ...externals,
    external: [...external],
    inline: [...inline],
    trace: isProjectPackageLinked(rootDir, '@holo-js/core')
      ? false
      : externals.trace,
    traceInclude: [...traceInclude],
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

function isRealtimeDefinitionModule(_rootDir: string, id: string): boolean {
  const [sourcePath = ''] = id.split('?')
  const normalizedId = sourcePath.replaceAll('\\', '/')
  return normalizedId.includes('/server/realtime/')
    && MODEL_FILE_EXTENSIONS.has(extname(normalizedId))
}

function resolveExistingRealtimeDefinitionFile(path: string): string | undefined {
  if (MODEL_FILE_EXTENSIONS.has(extname(path)) && existsFile(path)) {
    return path
  }

  for (const extension of MODEL_FILE_EXTENSIONS) {
    const candidate = `${path}${extension}`
    if (existsFile(candidate)) {
      return candidate
    }
  }

  return undefined
}

function existsFile(path: string): boolean {
  try {
    return readFileSync(path).length >= 0
  } catch {
    return false
  }
}

function resolveRealtimeDefinitionImport(source: string, importer: string | undefined): string | undefined {
  if (!source.includes('server/realtime') && !source.includes('server\\realtime')) {
    return undefined
  }

  const basePath = source.startsWith('.')
    ? importer
      ? resolve(dirname(importer.split('?')[0]!), source)
      : undefined
    : resolve(source)

  return basePath ? resolveExistingRealtimeDefinitionFile(basePath) : undefined
}

function createRealtimeDefinitionVitePlugin(rootDir: string): unknown {
  return {
    name: 'holo-realtime-client-definitions',
    enforce: 'pre',
    resolveId(source: string, importer: string | undefined, options?: { readonly ssr?: boolean }) {
      if (options?.ssr) {
        return null
      }

      const resolved = resolveRealtimeDefinitionImport(source, importer)
      return resolved ? `${realtimeClientDefinitionPrefix}${resolved}` : null
    },
    load(id: string) {
      if (!id.startsWith(realtimeClientDefinitionPrefix)) {
        return null
      }

      const sourcePath = id.slice(realtimeClientDefinitionPrefix.length)
      return createRealtimeClientDefinitionModule(readFileSync(sourcePath, 'utf8'))
    },
    transform(code: string, id: string, options?: { readonly ssr?: boolean }) {
      if (options?.ssr || !isRealtimeDefinitionModule(rootDir, id)) {
        return null
      }

      return createRealtimeClientDefinitionTransform(code)
    },
  }
}

function addVitePlugin(vite: NuxtViteOptions, plugin: unknown): void {
  vite.plugins = [...(vite.plugins ?? []), plugin]
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

function resolveStorageSetup(
  storageModule: StorageModule | undefined,
  loaded: LoadedHoloConfig<HoloConfigMap>,
): {
  readonly options: StorageModuleOptions | undefined
  readonly normalized: HoloStorageRuntimeConfig | undefined
} {
  if (!storageModule) {
    if (hasLoadedConfigFile(loaded, 'storage')) {
      throw new Error('[@holo-js/adapter-nuxt] Storage config requires @holo-js/storage to be installed.')
    }

    return { options: undefined, normalized: undefined }
  }

  const options = storageModule.mergeModuleOptions(undefined, toStorageModuleOptions(loaded))
  return {
    options,
    normalized: storageModule.normalizeModuleOptions(options),
  }
}

function finalizeStorageSetup(
  storageModule: StorageModule,
  opts: NuxtOptionsWithNitro,
  resolver: { resolve(path: string): string },
  s3Driver: string,
): void {
  const normalized = storageModule.normalizeModuleOptions(opts._holoStorageModuleOptions as StorageModuleOptions)
  opts.runtimeConfig = opts.runtimeConfig || {}
  opts.runtimeConfig.holoStorage = normalized
  storageModule.applyNitroStorageConfig(opts, normalized, s3Driver)

  if (storageModule.hasPublicLocalDisk(normalized)) {
    addServerHandler({
      route: `${normalized.routePrefix}/**`,
      handler: resolver.resolve('./runtime/server/routes/storage.get'),
    })
  }
}

function applyStorageRuntimeConfig(
  runtimeConfig: Record<string, unknown>,
  normalized: HoloStorageRuntimeConfig | undefined,
): void {
  if (normalized) {
    runtimeConfig.holoStorage = normalized
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
    const storageModule = await importOptionalStorageModule()
    const loaded = await loadConfigDirectory(rootDir, {
      preferCache: process.env.NODE_ENV === 'production',
      processEnv: process.env,
    })
    const storageSetup = resolveStorageSetup(storageModule, loaded)
    const s3Driver = resolver.resolve('./runtime/drivers/s3.js')

    opts.nitro = opts.nitro || { storage: {} }
    opts.nitro.storage = opts.nitro.storage || {}
    if (isProjectPackageLinked(rootDir, '@holo-js/core')) {
      opts.nitro.rollupConfig = {
        ...opts.nitro.rollupConfig,
        preserveSymlinks: true,
      }
    }
    addNitroRuntimeTraceIncludes(opts, rootDir, loaded.app.plugins)
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
    const mergedStorageOptions = storageSetup.options
    const normalizedStorage = storageSetup.normalized
    opts._holoStorageModuleOptions = mergedStorageOptions
    /* v8 ignore next 5 -- exercised only when the optional package is absent outside the monorepo test graph */
    if (normalizedStorage && Object.values(normalizedStorage.disks).some(disk => disk.driver === 's3')) {
      if (!await importOptionalStorageS3Module()) {
        throw new Error('[@holo-js/adapter-nuxt] S3 storage disks require @holo-js/storage-s3 to be installed.')
      }
    }
    applyStorageRuntimeConfig(opts.runtimeConfig, normalizedStorage)

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
      const realtimeDefinitionPlugin = createRealtimeDefinitionVitePlugin(rootDir)
      opts.vite = opts.vite || {}
      addVitePlugin(opts.vite, realtimeDefinitionPlugin)
      nuxt.hook('vite:extendConfig', (config, context) => {
        if (context.isServer) {
          return
        }

        addVitePlugin(config, realtimeDefinitionPlugin)
      })
      addPlugin({
        src: resolver.resolve('./runtime/plugins/realtime'),
        mode: 'all',
      })
      addServerHandler({
        route: '/holo/realtime/query',
        handler: resolver.resolve('./runtime/server/routes/realtime-query.post'),
      })
      addServerHandler({
        route: '/holo/realtime/mutation',
        handler: resolver.resolve('./runtime/server/routes/realtime-mutation.post'),
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
    for (const packageName of [runtimePath, '@holo-js/auth']) {
      if (!opts.build.transpile.includes(packageName)) {
        opts.build.transpile.push(packageName)
      }
    }

    if (storageModule && !opts._holoStorageFinalizeRegistered) {
      opts._holoStorageFinalizeRegistered = true
      nuxt.hook('modules:done', () => {
        finalizeStorageSetup(storageModule, opts, resolver, s3Driver)
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
  addVitePlugin,
  addNitroErrorHandler,
  addNitroRuntimeTraceIncludes,
  createRealtimeDefinitionVitePlugin,
  existsFile,
  hasProjectPackage,
  hasModuleNotFoundCode,
  hasLoadedConfigFile,
  importOptionalStorageS3Module,
  applyStorageRuntimeConfig,
  finalizeStorageSetup,
  resolveStorageSetup,
  isModuleResolutionFailure,
  resolveProjectPackageEntry,
  resolveProjectPackageTraceEntry,
  isProjectPackageLinked,
  isRealtimeDefinitionModule,
  resolveClientOptimizeDeps,
  resolveExistingRealtimeDefinitionFile,
  resolveRealtimeDefinitionImport,
}

export const adapterNuxtInternals = {
  toStorageModuleOptions,
}
