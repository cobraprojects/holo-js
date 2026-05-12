import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  loadConfigDirectory,
  holoAppDefaults,
  holoDatabaseDefaults,
  loadEnvironment,
  normalizeAppConfig,
  normalizeDatabaseConfig,
} from '@holo-js/config'
import {
  DEFAULT_HOLO_PROJECT_PATHS,
  normalizeHoloProjectConfig,
  renderGeneratedSchemaPlaceholder,
  type NormalizedHoloProjectConfig,
} from '@holo-js/db'
import type { LoadedProjectConfig } from '../types'
import { loadGeneratedProjectRegistry } from './registry'
import {
  APP_CONFIG_FILE_NAMES,
  DATABASE_CONFIG_FILE_NAMES,
  pathExists,
} from './shared'
import {
  isModulePackage,
  readTextFile,
  resolveFirstExistingPath,
} from './runtime'

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

type ProjectConfigImportState = {
  readonly hash: string
  readonly nonce: number
}

const projectConfigImportStates = new Map<string, ProjectConfigImportState>()
let projectConfigImportLock = Promise.resolve()
let projectConfigImportNonce = 0

async function withProjectConfigImportLock<TValue>(callback: () => Promise<TValue>): Promise<TValue> {
  const previousLock = projectConfigImportLock
  let releaseLock = (): void => {}
  projectConfigImportLock = new Promise<void>((resolveLock) => {
    releaseLock = resolveLock
  })

  await previousLock

  try {
    return await callback()
  } finally {
    releaseLock()
  }
}

function hashProjectConfigImportInputs(
  fileContents: string,
  environmentValues: Readonly<Record<string, string>>,
): string {
  const hash = createHash('sha256').update(fileContents).update('\0')
  const keys = Object.keys(environmentValues).sort()
  for (const key of keys) {
    hash.update(key).update('\0').update(environmentValues[key] ?? '').update('\0')
  }

  return hash.digest('hex').slice(0, 16)
}

async function resolveProjectConfigImportUrl(
  filePath: string,
  environmentValues: Readonly<Record<string, string>>,
): Promise<string> {
  const fileUrl = pathToFileURL(filePath).href
  const hash = hashProjectConfigImportInputs(await readFile(filePath, 'utf8'), environmentValues)
  const previous = projectConfigImportStates.get(filePath)
  if (previous?.hash === hash) {
    return `${fileUrl}?t=${previous.nonce}`
  }

  projectConfigImportNonce += 1
  const next = {
    hash,
    nonce: projectConfigImportNonce,
  }
  projectConfigImportStates.set(filePath, next)

  return `${fileUrl}?t=${next.nonce}`
}

async function importProjectConfigFile<TConfig extends object>(
  filePath: string,
  environmentValues: Readonly<Record<string, string>>,
): Promise<TConfig> {
  return withProjectConfigImportLock(async () => {
    const previousEnvEntries = new Map<string, string | undefined>()
    const importUrl = await resolveProjectConfigImportUrl(filePath, environmentValues)

    try {
      for (const [key, value] of Object.entries(environmentValues)) {
        previousEnvEntries.set(key, process.env[key])
        process.env[key] = value
      }

      return resolveConfigExport<TConfig>(await import(importUrl))
    } finally {
      for (const [key, value] of previousEnvEntries) {
        if (typeof value === 'string') {
          process.env[key] = value
          continue
        }

        Reflect.deleteProperty(process.env, key)
      }
    }
  })
}

export async function loadProjectConfig(
  projectRoot: string,
  options: { required?: boolean } = {},
): Promise<LoadedProjectConfig> {
  const appConfigPath = await resolveFirstExistingPath(projectRoot, APP_CONFIG_FILE_NAMES)
  if (!appConfigPath) {
    if (options.required) {
      throw new Error(`Missing config/app.(ts|mts|js|mjs) in ${projectRoot}. Run a generator command first to create it.`)
    }

    return {
      config: normalizeHoloProjectConfig(),
    }
  }

  const databaseConfigPath = await resolveFirstExistingPath(projectRoot, DATABASE_CONFIG_FILE_NAMES)
  const environment = await loadEnvironment({
    cwd: projectRoot,
    processEnv: process.env,
  })
  const app = normalizeAppConfig(await importProjectConfigFile(appConfigPath, environment.values))
  const database = normalizeDatabaseConfig(databaseConfigPath
    ? await importProjectConfigFile(databaseConfigPath, environment.values)
    : undefined)
  const baseConfig = normalizeHoloProjectConfig({
    paths: app.paths,
    database,
  })
  const registry = await loadGeneratedProjectRegistry(projectRoot)

  return {
    manifestPath: appConfigPath,
    config: registry
      ? normalizeHoloProjectConfig({
          paths: baseConfig.paths,
          models: registry.models.map(entry => entry.sourcePath),
          migrations: registry.migrations.map(entry => entry.sourcePath),
          seeders: registry.seeders.map(entry => entry.sourcePath),
          database,
        })
      : baseConfig,
  }
}

export async function serializeProjectConfig(
  projectRoot: string,
  config: NormalizedHoloProjectConfig,
  manifestPath: string,
): Promise<string> {
  const loaded = await loadConfigDirectory(projectRoot, {
    processEnv: process.env,
  }).catch(() => undefined)
  const appConfig = loaded?.app ?? holoAppDefaults
  const contents = JSON.stringify({
    name: appConfig.name,
    key: appConfig.key,
    url: appConfig.url,
    debug: appConfig.debug,
    env: appConfig.env,
    paths: config.paths,
  }, null, 2)

  const extension = extname(manifestPath)
  const isCommonJs = extension === '.js' && !(await isModulePackage(projectRoot))

  if (isCommonJs) {
    return [
      'const { defineAppConfig } = require(\'@holo-js/config\')',
      '',
      'module.exports = defineAppConfig(',
      contents,
      ')',
      '',
    ].join('\n')
  }

  return [
    'import { defineAppConfig } from \'@holo-js/config\'',
    '',
    'export default defineAppConfig(',
    contents,
    ')',
    '',
  ].join('\n')
}

export async function serializeDatabaseConfig(
  projectRoot: string,
  _targetPath: string,
): Promise<string> {
  const loaded = await loadConfigDirectory(projectRoot, {
    processEnv: process.env,
  }).catch(() => undefined)
  const databaseConfig = loaded?.database ?? holoDatabaseDefaults
  const contents = JSON.stringify({
    defaultConnection: databaseConfig.defaultConnection,
    connections: databaseConfig.connections,
  }, null, 2)

  return [
    'import { defineDatabaseConfig } from \'@holo-js/config\'',
    '',
    'export default defineDatabaseConfig(',
    contents,
    ')',
    '',
  ].join('\n')
}

export async function writeProjectConfig(
  projectRoot: string,
  config: NormalizedHoloProjectConfig,
  manifestPath?: string,
): Promise<string> {
  const targetPath = manifestPath ?? join(projectRoot, 'config/app.ts')
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, await serializeProjectConfig(projectRoot, config, targetPath), 'utf8')
  return targetPath
}

export function resolveGeneratedSchemaPath(
  projectRoot: string,
  config: NormalizedHoloProjectConfig,
): string {
  return resolve(projectRoot, config.paths.generatedSchema)
}

export async function ensureGeneratedSchemaPlaceholder(
  projectRoot: string,
  config: NormalizedHoloProjectConfig,
): Promise<string> {
  const filePath = resolveGeneratedSchemaPath(projectRoot, config)
  if (await pathExists(filePath)) {
    return filePath
  }

  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, renderGeneratedSchemaPlaceholder(), 'utf8')
  return filePath
}

export async function ensureProjectConfig(projectRoot: string): Promise<LoadedProjectConfig> {
  const loaded = await loadProjectConfig(projectRoot)
  /* v8 ignore next 3 */
  if (loaded.manifestPath) {
    await ensureDatabaseConfig(projectRoot)
    return loaded
  }

  const manifestPath = await writeProjectConfig(projectRoot, normalizeHoloProjectConfig())
  await ensureDatabaseConfig(projectRoot)
  return {
    manifestPath,
    config: normalizeHoloProjectConfig(),
  }
}

async function ensureDatabaseConfig(projectRoot: string): Promise<string> {
  const existingPath = await resolveFirstExistingPath(projectRoot, DATABASE_CONFIG_FILE_NAMES)
  if (existingPath) {
    return existingPath
  }

  const targetPath = join(projectRoot, 'config/database.ts')
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, await serializeDatabaseConfig(projectRoot, targetPath), 'utf8')
  return targetPath
}

export function defaultProjectConfig(): NormalizedHoloProjectConfig {
  return normalizeHoloProjectConfig({
    paths: DEFAULT_HOLO_PROJECT_PATHS,
    models: [],
    migrations: [],
    seeders: [],
  })
}

export {
  readTextFile,
}
