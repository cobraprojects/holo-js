import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicFileInternals } from './atomicFile'
import { NUXT_TSCONFIG_SNAPSHOT_PATH, runtimeModuleInternals } from './runtimeModule'

const {
  absoluteCompilerOptions,
  parseTsconfigText,
  readProjectTsconfig,
  usesNuxtBuildTsconfig,
  writeLoaderTsconfig,
} = runtimeModuleInternals

const NITRO_ROOT_ALIASES = ['~', '~/*', '@', '@/*', '~~', '~~/*', '@@', '@@/*']

type JsonObject = Record<string, unknown>

interface NuxtPrepareTypesTsconfigs {
  readonly tsConfig?: unknown
  readonly serverTsConfig?: unknown
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compilerOptionsOf(tsConfig: unknown): JsonObject {
  return isRecord(tsConfig) && isRecord(tsConfig.compilerOptions) ? tsConfig.compilerOptions : {}
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function missingNuxtTsconfigSnapshot(projectRoot: string): Promise<boolean> {
  const config = await readProjectTsconfig(projectRoot)
  if (!config || !usesNuxtBuildTsconfig(projectRoot, config)) return false
  return !await pathExists(join(projectRoot, NUXT_TSCONFIG_SNAPSHOT_PATH))
}

function serverCompilerOptions(tsconfigs: NuxtPrepareTypesTsconfigs): JsonObject {
  const appOptions = compilerOptionsOf(tsconfigs.tsConfig)
  if (!isRecord(tsconfigs.serverTsConfig)) return appOptions
  const serverOptions = compilerOptionsOf(tsconfigs.serverTsConfig)
  const appPaths = isRecord(appOptions.paths) ? appOptions.paths : {}
  const rootAliases = Object.fromEntries(NITRO_ROOT_ALIASES.flatMap(alias => alias in appPaths ? [[alias, appPaths[alias]]] : []))
  return { ...serverOptions, paths: { ...rootAliases, ...(isRecord(serverOptions.paths) ? serverOptions.paths : {}) } }
}

async function writeNuxtTsconfigSnapshot(
  projectRoot: string,
  typesDirectory: string,
  tsconfigs: NuxtPrepareTypesTsconfigs,
): Promise<void> {
  const contents = `${JSON.stringify({ compilerOptions: absoluteCompilerOptions(serverCompilerOptions(tsconfigs), typesDirectory) }, null, 2)}\n`
  const snapshotPath = join(projectRoot, NUXT_TSCONFIG_SNAPSHOT_PATH)
  if (await readFile(snapshotPath, 'utf8').catch(() => undefined) === contents) return
  await atomicFileInternals.writeTextFile(snapshotPath, contents)
}

export const projectTsconfigInternals = {
  NUXT_TSCONFIG_SNAPSHOT_PATH,
  missingNuxtTsconfigSnapshot,
  parseTsconfigText,
  writeLoaderTsconfig,
  writeNuxtTsconfigSnapshot,
}
