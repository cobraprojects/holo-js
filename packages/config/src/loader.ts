import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  normalizeAppConfig,
  normalizeBroadcastConfig,
  normalizeAuthConfig,
  normalizeDatabaseConfig,
  normalizeMailConfig,
  normalizeNotificationsConfig,
  normalizeRedisConfig,
  normalizeQueueConfigForHolo,
  normalizeSecurityConfig,
  normalizeSessionConfig,
  normalizeStorageConfig,
} from './defaults'
import {
  configureEnvRuntime,
  loadEnvironment,
  resolveAppEnvironment,
  resolveEnvPlaceholders,
} from './env'
import type {
  ConfigFileName,
  DefineConfigValue,
  LoadedHoloConfig,
  HoloAppConfig,
  HoloBroadcastConfig,
  HoloAuthConfig,
  HoloConfigMap,
  HoloDatabaseConfig,
  HoloMailConfig,
  HoloMediaConfig,
  HoloNotificationsConfig,
  HoloRedisConfig,
  HoloQueueConfig,
  HoloSecurityConfig,
  HoloSessionConfig,
  HoloStorageConfig,
} from './types'

const CONFIG_EXTENSION_PRIORITY = ['.ts', '.mts', '.js', '.mjs', '.cts', '.cjs'] as const
const SUPPORTED_CONFIG_EXTENSIONS = new Set<string>(CONFIG_EXTENSION_PRIORITY)
const HOLO_CONFIG_CACHE_VERSION = 3
const HOLO_CONFIG_CACHE_PATH = join('.holo-js', 'generated', 'config-cache.json')
const TRANSIENT_CONFIG_IMPORT_MARKER = '.__holo_import_'
const LEGACY_TRANSIENT_CONFIG_IMPORT_MARKERS = [TRANSIENT_CONFIG_IMPORT_MARKER, '.__native_test__']
/* v8 ignore next -- This is a test-runtime toggle evaluated at module load time. */
const USE_TRANSIENT_IMPORTS = process.env.VITEST === 'true' || process.env.VITEST === '1'

type RawConfigMap = Record<string, unknown>

type ConfigCachePayload = {
  readonly version: number
  readonly environment: {
    readonly name: string
    readonly loadedFiles: readonly string[]
    readonly warnings: readonly string[]
  }
  readonly configFiles: readonly string[]
  readonly config: RawConfigMap
  readonly deferredConfigNames: readonly ConfigFileName[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function resolveConfigExport<TConfig extends object>(moduleValue: unknown): TConfig {
  if (isObject(moduleValue) && isObject(moduleValue.default)) {
    return moduleValue.default as TConfig
  }

  if (isObject(moduleValue) && isObject(moduleValue.config)) {
    return moduleValue.config as TConfig
  }

  if (isObject(moduleValue) && ('default' in moduleValue || 'config' in moduleValue)) {
    return {} as TConfig
  }

  if (isObject(moduleValue)) {
    return moduleValue as TConfig
  }

  return {} as TConfig
}

function getConfigName(fileName: string): ConfigFileName {
  return fileName.slice(0, fileName.length - extname(fileName).length)
}

let configImportNonce = 0

async function importConfigModule(filePath: string): Promise<unknown> {
  configImportNonce += 1
  if (USE_TRANSIENT_IMPORTS) {
    const extension = extname(filePath)
    const transientPath = `${filePath.slice(0, filePath.length - extension.length)}${TRANSIENT_CONFIG_IMPORT_MARKER}${configImportNonce}${extension}`
    const source = await readFile(filePath, 'utf8')
    await writeFile(transientPath, source, 'utf8')

    try {
      return await import(/* webpackIgnore: true */ pathToFileURL(transientPath).href)
    } finally {
      await rm(transientPath, { force: true })
    }
  }

  return import(/* webpackIgnore: true */ `${pathToFileURL(filePath).href}?t=${configImportNonce}`)
}

async function writeFileIfChanged(filePath: string, contents: string): Promise<void> {
  const existing = await readFile(filePath, 'utf8').catch(() => undefined)
  if (existing === contents) {
    return
  }

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, contents, 'utf8')
}

function getConfigExtensionPriority(fileName: string): number {
  const extension = extname(fileName)
  const index = CONFIG_EXTENSION_PRIORITY.indexOf(extension as (typeof CONFIG_EXTENSION_PRIORITY)[number])
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER
}

async function collectConfigEntries(configDir: string): Promise<Array<{ configName: ConfigFileName, filePath: string }>> {
  const entries = await readdir(configDir, { withFileTypes: true }).catch(() => [])
  const selectedByName = new Map<ConfigFileName, { filePath: string, priority: number }>()

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }

    if (LEGACY_TRANSIENT_CONFIG_IMPORT_MARKERS.some(marker => entry.name.includes(marker))) {
      if (!USE_TRANSIENT_IMPORTS) {
        await rm(join(configDir, entry.name), { force: true })
      }
      continue
    }

    const extension = extname(entry.name)
    if (!SUPPORTED_CONFIG_EXTENSIONS.has(extension)) {
      continue
    }

    const configName = getConfigName(entry.name)
    const filePath = join(configDir, entry.name)
    const priority = getConfigExtensionPriority(entry.name)
    const current = selectedByName.get(configName)

    if (!current || priority < current.priority) {
      selectedByName.set(configName, { filePath, priority })
    }
  }

  return [...selectedByName.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([configName, entry]) => ({
      configName,
      filePath: entry.filePath,
    }))
}

async function collectRawConfig(
  configDir: string,
  environmentValues: Readonly<Record<string, string>>,
  options: {
    captureEnvPlaceholders?: boolean
    onlyConfigNames?: readonly ConfigFileName[]
  } = {},
): Promise<{ rawConfig: RawConfigMap, loadedFiles: readonly string[] }> {
  const rawConfig: RawConfigMap = {}
  const loadedFiles: string[] = []
  const configEntries = await collectConfigEntries(configDir)
  const allowedConfigNames = options.onlyConfigNames
    ? new Set(options.onlyConfigNames)
    : undefined

  const previousEnvEntries = new Map<string, string | undefined>()

  try {
    configureEnvRuntime(environmentValues, {
      mode: options.captureEnvPlaceholders ? 'capture' : 'resolve',
    })
    for (const [key, value] of Object.entries(environmentValues)) {
      previousEnvEntries.set(key, process.env[key])
      process.env[key] = value
    }
    previousEnvEntries.set('HOLO_CAPTURE_ENV', process.env.HOLO_CAPTURE_ENV)
    if (options.captureEnvPlaceholders) {
      process.env.HOLO_CAPTURE_ENV = '1'
    } else {
      Reflect.deleteProperty(process.env, 'HOLO_CAPTURE_ENV')
    }

    for (const entry of configEntries) {
      if (allowedConfigNames && !allowedConfigNames.has(entry.configName)) {
        continue
      }

      rawConfig[entry.configName] = resolveConfigExport(await importConfigModule(entry.filePath))
      loadedFiles.push(entry.filePath)
    }
  } finally {
    configureEnvRuntime(undefined)
    for (const [key, value] of previousEnvEntries) {
      if (typeof value === 'string') {
        process.env[key] = value
        continue
      }

      Reflect.deleteProperty(process.env, key)
    }
  }

  return {
    rawConfig,
    loadedFiles: Object.freeze([...loadedFiles]),
  }
}

function mergeLoadedFiles(
  cachedFiles: readonly string[],
  liveFiles: readonly string[],
  deferredConfigNames: readonly ConfigFileName[],
): readonly string[] {
  const deferredNames = new Set(deferredConfigNames)
  const retainedCachedFiles = cachedFiles.filter((filePath) => {
    return !deferredNames.has(getConfigName(basename(filePath)))
  })

  return Object.freeze([
    ...retainedCachedFiles,
    ...liveFiles,
  ])
}

function normalizeLoadedConfig<TCustom extends HoloConfigMap = HoloConfigMap>(
  rawConfig: RawConfigMap,
  options: {
    environment: LoadedHoloConfig<TCustom>['environment']
    loadedFiles: readonly string[]
  },
): LoadedHoloConfig<TCustom> {
  const resolvedRawConfig = resolveEnvPlaceholders(rawConfig, options.environment.values)
  const app = normalizeAppConfig(resolvedRawConfig.app as HoloAppConfig | undefined)
  const database = normalizeDatabaseConfig(resolvedRawConfig.database as HoloDatabaseConfig | undefined)
  const redis = normalizeRedisConfig(resolvedRawConfig.redis as HoloRedisConfig | undefined)
  const resolvedRedisConfig = typeof resolvedRawConfig.redis === 'undefined'
    ? undefined
    : redis
  const storage = normalizeStorageConfig(resolvedRawConfig.storage as HoloStorageConfig | undefined)
  const queue = normalizeQueueConfigForHolo(resolvedRawConfig.queue as HoloQueueConfig | undefined, resolvedRedisConfig)
  const broadcast = normalizeBroadcastConfig(resolvedRawConfig.broadcast as HoloBroadcastConfig | undefined)
  const mail = normalizeMailConfig(resolvedRawConfig.mail as HoloMailConfig | undefined)
  const notifications = normalizeNotificationsConfig(resolvedRawConfig.notifications as HoloNotificationsConfig | undefined)
  const media = Object.freeze({ ...((resolvedRawConfig.media as HoloMediaConfig | undefined) ?? {}) })
  const session = normalizeSessionConfig(resolvedRawConfig.session as HoloSessionConfig | undefined, resolvedRedisConfig)
  const security = normalizeSecurityConfig(resolvedRawConfig.security as HoloSecurityConfig | undefined, resolvedRedisConfig)
  const auth = normalizeAuthConfig(resolvedRawConfig.auth as HoloAuthConfig | undefined)

  const customEntries = Object.entries(resolvedRawConfig).filter(([key]) => {
    return key !== 'app'
      && key !== 'database'
      && key !== 'redis'
      && key !== 'storage'
      && key !== 'queue'
      && key !== 'broadcast'
      && key !== 'mail'
      && key !== 'notifications'
      && key !== 'media'
      && key !== 'session'
      && key !== 'security'
      && key !== 'auth'
  })
  const custom = Object.freeze(Object.fromEntries(customEntries)) as Readonly<TCustom>
  const all = Object.freeze({
    app,
    database,
    redis,
    storage,
    queue,
    broadcast,
    mail,
    notifications,
    media,
    session,
    security,
    auth,
    ...custom,
  }) as Readonly<LoadedHoloConfig<TCustom>['all']>

  return {
    app,
    database,
    redis,
    storage,
    queue,
    broadcast,
    mail,
    notifications,
    media,
    session,
    security,
    auth,
    custom,
    all,
    environment: options.environment,
    loadedFiles: Object.freeze([...options.loadedFiles]),
    warnings: options.environment.warnings,
  }
}

function isSerializableConfigValue(value: unknown): boolean {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return true
  }

  if (Array.isArray(value)) {
    return value.every(entry => isSerializableConfigValue(entry))
  }

  if (isObject(value)) {
    return Object.values(value).every(entry => isSerializableConfigValue(entry))
  }

  return false
}

function splitCacheableConfig(rawConfig: RawConfigMap): {
  readonly cacheableConfig: RawConfigMap
  readonly deferredConfigNames: readonly ConfigFileName[]
} {
  const cacheableConfig: RawConfigMap = {}
  const deferredConfigNames: ConfigFileName[] = []

  for (const [name, value] of Object.entries(rawConfig) as Array<[ConfigFileName, unknown]>) {
    if (isSerializableConfigValue(value)) {
      cacheableConfig[name] = value
      continue
    }

    if (name === 'security') {
      deferredConfigNames.push(name)
      continue
    }

    throw new TypeError('Holo config cache only supports plain JSON-serializable config values.')
  }

  return {
    cacheableConfig,
    deferredConfigNames: Object.freeze([...deferredConfigNames]),
  }
}

function getDeferredConfigNames(payload: ConfigCachePayload): readonly ConfigFileName[] {
  return Array.isArray(payload.deferredConfigNames)
    ? payload.deferredConfigNames
    : Object.freeze([])
}

function isCachePayload(value: unknown): value is ConfigCachePayload {
  return isObject(value)
    && (value.version === 1 || value.version === HOLO_CONFIG_CACHE_VERSION)
    && isObject(value.environment)
    && typeof value.environment.name === 'string'
    && Array.isArray(value.environment.loadedFiles)
    && Array.isArray(value.environment.warnings)
    && Array.isArray(value.configFiles)
    && isObject(value.config)
    && (typeof value.deferredConfigNames === 'undefined' || Array.isArray(value.deferredConfigNames))
}

export function resolveConfigCachePath(projectRoot: string): string {
  return join(resolve(projectRoot), HOLO_CONFIG_CACHE_PATH)
}

async function readConfigCache(projectRoot: string): Promise<ConfigCachePayload | undefined> {
  const cachePath = resolveConfigCachePath(projectRoot)
  const contents = await readFile(cachePath, 'utf8').catch(() => undefined)
  if (!contents) {
    return undefined
  }

  try {
    const parsed = JSON.parse(contents) as unknown
    return isCachePayload(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export async function writeConfigCache(
  projectRoot: string,
  options: { envName?: string, processEnv?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const root = resolve(projectRoot)
  const configDir = join(root, 'config')
  const environment = await loadEnvironment({
    cwd: root,
    envName: options.envName,
    processEnv: options.processEnv,
  })
  const { rawConfig, loadedFiles } = await collectRawConfig(configDir, environment.values, {
    captureEnvPlaceholders: true,
  })
  const {
    cacheableConfig,
    deferredConfigNames,
  } = splitCacheableConfig(rawConfig)

  const cachePath = resolveConfigCachePath(root)
  const contents = `${JSON.stringify({
    version: HOLO_CONFIG_CACHE_VERSION,
    environment: {
      name: environment.name,
      loadedFiles: environment.loadedFiles,
      warnings: environment.warnings,
    },
    configFiles: loadedFiles,
    config: cacheableConfig,
    deferredConfigNames,
  } satisfies ConfigCachePayload, null, 2)}\n`
  await writeFileIfChanged(cachePath, contents)

  return cachePath
}

export async function clearConfigCache(projectRoot: string): Promise<boolean> {
  const cachePath = resolveConfigCachePath(projectRoot)
  const exists = await readFile(cachePath, 'utf8').then(() => true).catch(() => false)
  if (!exists) {
    return false
  }

  await rm(cachePath, { force: true })
  return true
}

export async function loadConfigDirectory<TCustom extends HoloConfigMap = HoloConfigMap>(
  projectRoot: string,
  options: { envName?: string, processEnv?: NodeJS.ProcessEnv, preferCache?: boolean } = {},
): Promise<LoadedHoloConfig<TCustom>> {
  const root = resolve(projectRoot)
  const configDir = join(root, 'config')
  const envName = options.envName
    ? resolveAppEnvironment({ ...options.processEnv, HOLO_ENV: options.envName })
    : resolveAppEnvironment(options.processEnv)
  const preferCache = options.preferCache ?? envName === 'production'
  if (preferCache) {
    const cached = await readConfigCache(root)
    if (cached?.environment.name === envName) {
      const environment = await loadEnvironment({
        cwd: root,
        envName,
        processEnv: options.processEnv,
      })
      const deferredConfigNames = getDeferredConfigNames(cached)
      let rawConfig = cached.config
      let loadedFiles = cached.configFiles

      if (deferredConfigNames.length > 0) {
        const live = await collectRawConfig(configDir, environment.values, {
          onlyConfigNames: deferredConfigNames,
        })
        rawConfig = {
          ...cached.config,
          ...live.rawConfig,
        }
        loadedFiles = mergeLoadedFiles(cached.configFiles, live.loadedFiles, deferredConfigNames)
      }

      return normalizeLoadedConfig<TCustom>(rawConfig, {
        environment,
        loadedFiles,
      })
    }
  }

  const environment = await loadEnvironment({
    cwd: root,
    envName,
    processEnv: options.processEnv,
  })
  const { rawConfig, loadedFiles } = await collectRawConfig(configDir, environment.values)

  return normalizeLoadedConfig<TCustom>(rawConfig, {
    environment,
    loadedFiles,
  })
}

export function defineConfig<TConfig extends object>(config: TConfig): DefineConfigValue<TConfig> {
  return Object.freeze({ ...config })
}

export function defineAppConfig<TConfig extends HoloAppConfig>(config: TConfig): DefineConfigValue<TConfig> {
  return defineConfig(config)
}

export function defineDatabaseConfig<TConfig extends HoloDatabaseConfig>(config: TConfig): DefineConfigValue<TConfig> {
  return defineConfig(config)
}

export function defineRedisConfig<TConfig extends HoloRedisConfig>(config: TConfig): DefineConfigValue<TConfig> {
  return defineConfig(config)
}

export function defineStorageConfig<TConfig extends HoloStorageConfig>(config: TConfig): DefineConfigValue<TConfig> {
  return defineConfig(config)
}

export function defineQueueConfig<TConfig extends HoloQueueConfig>(config: TConfig): DefineConfigValue<TConfig> {
  return defineConfig(config)
}

export function defineBroadcastConfig<TConfig extends HoloBroadcastConfig>(config: TConfig): DefineConfigValue<TConfig> {
  return defineConfig(config)
}

export function defineMailConfig<TConfig extends HoloMailConfig>(config: TConfig): DefineConfigValue<TConfig> {
  return defineConfig(config)
}

export function defineNotificationsConfig<TConfig extends HoloNotificationsConfig>(config: TConfig): DefineConfigValue<TConfig> {
  return defineConfig(config)
}

export function defineMediaConfig<TConfig extends HoloMediaConfig>(config: TConfig): DefineConfigValue<TConfig> {
  return defineConfig(config)
}

export function defineSessionConfig<TConfig extends HoloSessionConfig>(config: TConfig): DefineConfigValue<TConfig> {
  return defineConfig(config)
}

export function defineSecurityConfig<TConfig extends HoloSecurityConfig>(config: TConfig): DefineConfigValue<TConfig> {
  return defineConfig(config)
}

export function defineAuthConfig<TConfig extends HoloAuthConfig>(config: TConfig): DefineConfigValue<TConfig> {
  return defineConfig(config)
}

export const loaderInternals = {
  getDeferredConfigNames,
  getConfigExtensionPriority,
  resolveConfigExport,
  splitCacheableConfig,
}
