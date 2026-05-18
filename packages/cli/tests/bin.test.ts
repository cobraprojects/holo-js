import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

type CliBinName = 'holo' | 'holo-js'

type CliBinEntries = Record<CliBinName, string>

type PackageManifest = {
  bin?: Partial<Record<CliBinName, string>>
}

type RunCliContext = {
  cwd: string
  stdin: typeof process.stdin
  stdout: typeof process.stdout
  stderr: typeof process.stderr
}

type RunCli = (args: string[], context: RunCliContext) => Promise<number>

const runCliMock = vi.hoisted(() => vi.fn<RunCli>())

vi.mock('../src/cli', () => ({
  runCli: runCliMock,
}))

const packageDir = resolve(import.meta.dirname, '..')
const repoRoot = resolve(packageDir, '../..')
const tempBuildRoots: string[] = []
let packageBuildPromise: Promise<{ packageRoot: string, binEntries: CliBinEntries }> | null = null
const originalArgv = process.argv
const originalExitCode = process.exitCode

async function createTempBuildRoot(): Promise<string> {
  const baseDir = resolve(repoRoot, '.vitest-builds')
  await mkdir(baseDir, { recursive: true })
  const root = await mkdtemp(join(baseDir, 'cli-bin-'))
  tempBuildRoots.push(root)
  return root
}

async function writeStubPackage(packageRoot: string, packageName: string, source: string): Promise<void> {
  const stubRoot = join(packageRoot, 'node_modules', ...packageName.split('/'))
  await mkdir(stubRoot, { recursive: true })
  await writeFile(
    join(stubRoot, 'package.json'),
    JSON.stringify({
      name: packageName,
      type: 'module',
      exports: './index.mjs',
    }),
  )
  await writeFile(join(stubRoot, 'index.mjs'), source)
}

async function writeCliRuntimeStubs(packageRoot: string): Promise<void> {
  await writeStubPackage(
    packageRoot,
    '@holo-js/config',
    [
      'export function clearConfigCache() { return false }',
      'export function resolveConfigCachePath(root) { return `${root}/.holo-js/config-cache.mjs` }',
      'export async function loadConfigDirectory() { return {} }',
      'export async function loadEnvironment() { return {} }',
      'export function normalizeAppConfig(config) { return config }',
      'export function normalizeDatabaseConfig(config) { return config }',
      'export const holoAppDefaults = Object.freeze({})',
      'export const holoDatabaseDefaults = Object.freeze({})',
      'export const holoStorageDefaults = Object.freeze({})',
      'export async function writeConfigCache() {}',
    ].join('\n'),
  )
  await writeStubPackage(
    packageRoot,
    '@holo-js/db',
    [
      'export const DEFAULT_HOLO_PROJECT_PATHS = Object.freeze({ models: "app/models", migrations: "database/migrations", seeders: "database/seeders", commands: "app/commands", jobs: "app/jobs", events: "app/events", listeners: "app/listeners", generatedSchema: ".holo-js/generated/schema.generated.ts" })',
      'export function normalizeHoloProjectConfig(config = {}) { return { ...config, paths: { ...DEFAULT_HOLO_PROJECT_PATHS, ...(config.paths ?? {}) } } }',
      'export function renderGeneratedSchemaRuntimeModule() { return "" }',
      'export function renderGeneratedSchemaPlaceholder() { return "" }',
      'export function normalizeMigrationSlug(value) { return value }',
      'export function createMigrationFileName(value) { return `${value}.ts` }',
      'export function generateMigrationTemplate() { return "" }',
      'export function inferMigrationTableName(value) { return value }',
      'export function inferMigrationTemplateKind() { return "blank" }',
      'export function configureDB() {}',
      'export function resetDB() {}',
      'export function resolveRuntimeConnectionManagerOptions() { return {} }',
    ].join('\n'),
  )
  await writeStubPackage(
    packageRoot,
    'esbuild',
    'export async function build() { return {} }\n',
  )
  await writeStubPackage(
    packageRoot,
    'inflection',
    'export default { pluralize: value => value.endsWith("s") ? value : `${value}s` }\n',
  )
}

function readCliBinEntries(manifest: PackageManifest): CliBinEntries {
  const holoBin = manifest.bin?.holo
  const holoJsBin = manifest.bin?.['holo-js']

  if (typeof holoBin !== 'string' || typeof holoJsBin !== 'string') {
    throw new Error('@holo-js/cli package.json must declare holo and holo-js bin entries.')
  }

  return {
    holo: holoBin,
    'holo-js': holoJsBin,
  }
}

async function runPackageBuild(): Promise<{ packageRoot: string, binEntries: CliBinEntries }> {
  if (!packageBuildPromise) {
    packageBuildPromise = (async () => {
      const buildRoot = await createTempBuildRoot()
      const packageRoot = join(buildRoot, 'package')
      const outDir = join(packageRoot, 'dist')
      await mkdir(packageRoot, { recursive: true })
      await writeFile(join(packageRoot, 'package.json'), await readFile(join(packageDir, 'package.json'), 'utf8'))

      execFileSync('bun', ['run', 'build'], {
        cwd: packageDir,
        env: {
          ...process.env,
          HOLO_BUILD_OUT_DIR: outDir,
        },
        stdio: 'pipe',
      })

      await writeCliRuntimeStubs(packageRoot)

      const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as PackageManifest

      return {
        packageRoot,
        binEntries: readCliBinEntries(manifest),
      }
    })()
  }

  return packageBuildPromise
}

afterAll(async () => {
  for (const root of tempBuildRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

afterEach(() => {
  process.argv = originalArgv
  process.exitCode = originalExitCode
  runCliMock.mockReset()
  vi.restoreAllMocks()
})

describe('holo bin', () => {
  it('sets exitCode without forcing process termination', async () => {
    process.argv = ['node', 'holo', 'list']
    runCliMock.mockResolvedValue(7)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new Error(`exit:${String(code)}`)
    }) as typeof process.exit)
    const modulePath = `../src/bin/holo.ts?run=${Date.now()}`

    await import(modulePath)

    expect(runCliMock).toHaveBeenCalledWith(['list'], {
      cwd: process.cwd(),
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    })
    expect(exitSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(7)
  })

  it('emits and executes both published bin aliases from package.json', async () => {
    const { packageRoot, binEntries } = await runPackageBuild()
    const binariesDir = join(packageRoot, 'node_modules/.bin')
    await mkdir(binariesDir, { recursive: true })

    for (const binName of ['holo', 'holo-js'] as const) {
      const binPath = resolve(packageRoot, binEntries[binName])
      const linkedBinPath = join(binariesDir, binName)
      const bin = await readFile(binPath, 'utf8')

      expect(bin.startsWith('#!/usr/bin/env node\n')).toBe(true)

      await chmod(binPath, 0o755)
      await rm(linkedBinPath, { force: true })
      await symlink(binPath, linkedBinPath)

      const output = execFileSync(linkedBinPath, ['--help'], {
        cwd: packageRoot,
        encoding: 'utf8',
        stdio: 'pipe',
      })

      expect(output).toContain('Internal Commands')
      expect(output).toContain('holo list')
    }
  }, 60000)
})
