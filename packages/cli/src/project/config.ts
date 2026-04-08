import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import {
  loadConfigDirectory,
  holoAppDefaults,
  holoDatabaseDefaults,
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

  const loaded = await loadConfigDirectory(projectRoot, {
    processEnv: process.env,
  })
  const baseConfig = normalizeHoloProjectConfig({
    paths: loaded.app.paths,
    database: loaded.database,
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
          database: loaded.database,
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
