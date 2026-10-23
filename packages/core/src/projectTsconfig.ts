import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicFileInternals } from './atomicFile'
import { NUXT_TSCONFIG_SNAPSHOT_PATH, runtimeModuleInternals } from './runtimeModule'

const {
  absoluteCompilerOptions,
  extendsEntries,
  isNuxtBuildExtends,
  parseTsconfigText,
  readProjectTsconfig,
  writeLoaderTsconfig,
} = runtimeModuleInternals

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
  if (!config || !extendsEntries(config).some(entry => isNuxtBuildExtends(projectRoot, entry))) return false
  return !await pathExists(join(projectRoot, NUXT_TSCONFIG_SNAPSHOT_PATH))
}

async function writeNuxtTsconfigSnapshot(
  projectRoot: string,
  typesDirectory: string,
  tsConfig: Record<string, unknown>,
): Promise<void> {
  const compilerOptions = typeof tsConfig.compilerOptions === 'object' && tsConfig.compilerOptions !== null && !Array.isArray(tsConfig.compilerOptions)
    ? tsConfig.compilerOptions as Record<string, unknown>
    : {}
  const contents = `${JSON.stringify({ compilerOptions: absoluteCompilerOptions(compilerOptions, typesDirectory) }, null, 2)}\n`
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
