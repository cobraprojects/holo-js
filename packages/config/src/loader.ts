import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createJiti } from 'jiti'
import {
  normalizeRedisConfig,
  type HoloRedisConfig,
} from '@holo-js/kernel'
import {
  normalizeAppConfig,
} from './defaults'
import {
  configEvaluationInternals,
} from './env'
import { composeRegisteredConfig, configRegistryInternals } from './registry'
import type {
  ConfigFileName,
  DefineConfigValue,
  LoadedEnvironment,
  LoadedHoloConfig,
  HoloAppConfig,
  HoloConfigMap,
  HoloConfigValues,
} from './types'

const CONFIG_EXTENSION_PRIORITY = ['.ts', '.mts', '.js', '.mjs', '.cts', '.cjs'] as const
const SUPPORTED_CONFIG_EXTENSIONS = new Set<string>(CONFIG_EXTENSION_PRIORITY)
const HOLO_CONFIG_CACHE_VERSION = 7
const CONFIG_CACHE_UNDEFINED_MARKER = '__holoUndefined'
const HOLO_CONFIG_CACHE_PATH = join('.holo-js', 'generated', 'config-cache.json')
const TRANSIENT_CONFIG_IMPORT_MARKER = '.__holo_import_'
const LEGACY_TRANSIENT_CONFIG_IMPORT_MARKERS = [TRANSIENT_CONFIG_IMPORT_MARKER, '.__native_test__']

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
  readonly envSnapshot: Readonly<Record<string, string | null>>
  readonly deferredConfigNames: readonly ConfigFileName[]
  readonly normalizerConfigNames?: readonly ConfigFileName[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function resolveConfigExportValue(moduleValue: unknown): object | undefined {
  if (isObject(moduleValue) && isObject(moduleValue.default)) {
    return moduleValue.default
  }

  if (isObject(moduleValue) && isObject(moduleValue.config)) {
    return moduleValue.config
  }

  if (isObject(moduleValue) && ('default' in moduleValue || 'config' in moduleValue)) {
    return undefined
  }

  if (isObject(moduleValue)) {
    return moduleValue
  }

  return undefined
}

function resolveConfigExport<TConfig extends object>(moduleValue: unknown): TConfig {
  return (resolveConfigExportValue(moduleValue) ?? {}) as TConfig
}

function getConfigName(fileName: string): ConfigFileName {
  return fileName.slice(0, fileName.length - extname(fileName).length)
}

const importConfig = createJiti(import.meta.url, { moduleCache: false, interopDefault: false })
let configImportNonce = 0

async function importConfigModule(filePath: string, importKey?: string): Promise<unknown> {
  const key = importKey ?? String(++configImportNonce)
  const extension = extname(filePath)
  if (extension === '.ts' || extension === '.mts') {
    return importConfig.import(filePath)
  }

  if (extension === '.cts') {
    // jiti returns a CommonJS file's module.exports itself. Exports that already hold the config under an object
    // `default` or `config` key resolve as they are. Wrap the rest as import() wraps a .cjs file, so a config whose
    // own `default` is a name, such as a Redis config's default connection, isn't read as a module namespace.
    const exports = await importConfig.import(filePath)
    return isObject(exports) && (isObject(exports.default) || isObject(exports.config)) ? exports : { default: exports }
  }

  if (extension === '.js' || extension === '.cjs') {
    const requireConfig = createRequire(filePath)
    delete requireConfig.cache[requireConfig.resolve(filePath)]
  }

  return import(/* webpackIgnore: true */ `${pathToFileURL(filePath).href}?t=${key}`)
}

const CONFIG_CACHE_FILE_MODE = 0o600

async function writeConfigCacheFile(filePath: string, contents: string): Promise<void> {
  const existing = await readFile(filePath, 'utf8').catch(() => undefined)
  if (existing === contents) {
    await chmod(filePath, CONFIG_CACHE_FILE_MODE)
    return
  }

  await mkdir(dirname(filePath), { recursive: true })
  const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: CONFIG_CACHE_FILE_MODE, flag: 'wx' })
    await rename(temporaryPath, filePath)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

function encodeConfigCacheValue(value: unknown): unknown {
  if (value === undefined) {
    return { [CONFIG_CACHE_UNDEFINED_MARKER]: true }
  }

  if (Array.isArray(value)) {
    return value.map(entry => encodeConfigCacheValue(entry))
  }

  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeConfigCacheValue(entry)]))
  }

  return value
}

function decodeConfigCacheValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(entry => decodeConfigCacheValue(entry))
  }

  if (isObject(value)) {
    const keys = Object.keys(value)
    if (keys.length === 1 && value[CONFIG_CACHE_UNDEFINED_MARKER] === true) {
      return undefined
    }

    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeConfigCacheValue(entry)]))
  }

  return value
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
      await rm(join(configDir, entry.name), { force: true })
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
  options: {
    onlyConfigNames?: readonly ConfigFileName[]
    envReads?: Map<ConfigFileName, Map<string, string | null>>
  } = {},
): Promise<{ rawConfig: RawConfigMap, loadedFiles: readonly string[] }> {
  const rawConfig: RawConfigMap = {}
  const loadedFiles: string[] = []
  const configEntries = await collectConfigEntries(configDir)
  const entriesByName = new Map(configEntries.map(entry => [entry.configName, entry]))
  const selectedEntries = options.onlyConfigNames
    ? [...new Set(options.onlyConfigNames)].flatMap((name) => {
        const entry = entriesByName.get(name)
        return entry ? [entry] : []
      })
    : configEntries

  for (const entry of selectedEntries) {
    if (options.envReads) {
      const recorded = await configEvaluationInternals.recordEnvReads(() => importConfigModule(entry.filePath))
      rawConfig[entry.configName] = resolveConfigExport(recorded.value)
      options.envReads.set(entry.configName, recorded.reads)
    } else {
      rawConfig[entry.configName] = resolveConfigExport(await importConfigModule(entry.filePath))
    }
    loadedFiles.push(entry.filePath)
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
    environment: LoadedEnvironment
    loadedFiles: readonly string[]
  },
): LoadedHoloConfig<TCustom> {
  const rawApp = rawConfig.app as HoloAppConfig | undefined
  const app = normalizeAppConfig({ ...rawApp, env: rawApp?.env ?? options.environment.name })
  const redis = normalizeRedisConfig(rawConfig.redis as HoloRedisConfig | undefined)
  const firstPartyConfig = composeRegisteredConfig(rawConfig, {
    app,
    redis,
  }) as HoloConfigValues<TCustom>
  const firstPartyConfigKeys = new Set(Object.keys(firstPartyConfig))
  const customEntries = Object.entries(rawConfig).filter(([key]) => {
    return !firstPartyConfigKeys.has(key)
  })
  const custom = Object.freeze(Object.fromEntries(customEntries)) as Readonly<TCustom>
  const all = Object.freeze({
    ...firstPartyConfig,
    ...custom,
  }) as HoloConfigValues<TCustom>

  return {
    ...firstPartyConfig,
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
    return !Object.hasOwn(value, CONFIG_CACHE_UNDEFINED_MARKER)
      && Object.values(value).every(entry => entry === undefined || isSerializableConfigValue(entry))
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

    if (name === 'app' || name === 'security' || name === 'database') {
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

function getNormalizerConfigNames(payload: Pick<ConfigCachePayload, 'normalizerConfigNames'>): readonly ConfigFileName[] {
  return payload.normalizerConfigNames ?? Object.freeze([])
}

function isCachePayload(value: unknown): value is ConfigCachePayload {
  return isObject(value)
    && value.version === HOLO_CONFIG_CACHE_VERSION
    && isObject(value.environment)
    && typeof value.environment.name === 'string'
    && Array.isArray(value.environment.loadedFiles)
    && Array.isArray(value.environment.warnings)
    && Array.isArray(value.configFiles)
    && isObject(value.config)
    && isObject(value.envSnapshot)
    && (typeof value.deferredConfigNames === 'undefined' || Array.isArray(value.deferredConfigNames))
    && (typeof value.normalizerConfigNames === 'undefined' || Array.isArray(value.normalizerConfigNames))
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
    if (!isCachePayload(parsed)) {
      return undefined
    }

    return { ...parsed, config: decodeConfigCacheValue(parsed.config) as RawConfigMap }
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
  const { environment, rawConfig, loadedFiles, envReads } = await configEvaluationInternals.evaluate({
    cwd: root,
    ...options,
  }, async (environment) => {
    const envReads = new Map<ConfigFileName, Map<string, string | null>>()
    return { environment, ...await collectRawConfig(configDir, { envReads }), envReads }
  })
  const {
    cacheableConfig,
    deferredConfigNames,
  } = splitCacheableConfig(rawConfig)
  const normalizerConfigNames = configRegistryInternals
    .getRegisteredNames()
    .filter(name => Object.hasOwn(rawConfig, name))
  const liveConfigNames = new Set<string>([...deferredConfigNames, ...normalizerConfigNames])
  const envSnapshot: Record<string, string | null> = {}
  for (const [configName, reads] of envReads) {
    if (!liveConfigNames.has(configName)) {
      continue
    }

    for (const [key, value] of reads) {
      envSnapshot[key] = value
    }
  }

  const cachePath = resolveConfigCachePath(root)
  const contents = `${JSON.stringify({
    version: HOLO_CONFIG_CACHE_VERSION,
    environment: {
      name: environment.name,
      loadedFiles: environment.loadedFiles,
      warnings: environment.warnings,
    },
    configFiles: loadedFiles,
    config: encodeConfigCacheValue(cacheableConfig) as RawConfigMap,
    envSnapshot,
    deferredConfigNames,
    normalizerConfigNames,
  } satisfies ConfigCachePayload, null, 2)}\n`
  await writeConfigCacheFile(cachePath, contents)

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
  const { environment, rawConfig, loadedFiles } = await configEvaluationInternals.evaluate({
    cwd: root,
    envName: options.envName,
    processEnv: options.processEnv,
  }, async (environment) => {
    const preferCache = options.preferCache ?? environment.name === 'production'
    const cached = preferCache ? await readConfigCache(root) : undefined
    if (cached?.environment.name !== environment.name) {
      return { environment, ...await collectRawConfig(configDir) }
    }

    const deferredConfigNames = getDeferredConfigNames(cached)
    const deferredNames = new Set(deferredConfigNames)
    const evaluationNames = [
      ...getNormalizerConfigNames(cached).filter(name => !deferredNames.has(name)),
      ...deferredConfigNames,
    ]
    if (evaluationNames.length === 0) {
      return { environment, rawConfig: cached.config, loadedFiles: cached.configFiles }
    }

    const live = await configEvaluationInternals.withEnvSnapshot(
      cached.envSnapshot,
      () => collectRawConfig(configDir, { onlyConfigNames: evaluationNames }),
    )
    return {
      environment,
      rawConfig: {
        ...cached.config,
        ...Object.fromEntries(Object.entries(live.rawConfig).filter(([name]) => deferredNames.has(name))),
      },
      loadedFiles: mergeLoadedFiles(
        cached.configFiles,
        live.loadedFiles.filter(filePath => deferredNames.has(getConfigName(basename(filePath)))),
        deferredConfigNames,
      ),
    }
  })

  return normalizeLoadedConfig<TCustom>(rawConfig, { environment, loadedFiles })
}

export function defineConfig<TConfig extends object>(config: TConfig): DefineConfigValue<TConfig> {
  return Object.freeze({ ...config })
}

export function defineAppConfig<TConfig extends HoloAppConfig>(config: TConfig): DefineConfigValue<TConfig> {
  return defineConfig(config)
}

export const loaderInternals = {
  collectConfigEntries,
  configExtensionPriority: CONFIG_EXTENSION_PRIORITY,
  importConfigModule,
  getDeferredConfigNames,
  getNormalizerConfigNames,
  getConfigExtensionPriority,
  resolveConfigExport,
  resolveConfigExportValue,
  splitCacheableConfig,
}
