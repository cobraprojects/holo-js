import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { symlinkPackageDependency } from '../../../tests/support/published-package'

const execute = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '../../..')
const npmEnv = { ...process.env, npm_config_offline: 'true', npm_config_update_notifier: 'false' }
const holoPackageNames = ['@holo-js/cli', '@holo-js/core', '@holo-js/db-sqlite', '@holo-js/kernel', '@holo-js/security', '@holo-js/session']
let stagingRoot: string
let packages: Record<string, string>
let externalDependencies: Map<string, string>
let holoVersion: string

async function listWorkspacePackageDirectories(): Promise<Map<string, string>> {
  const packagesRoot = join(repoRoot, 'packages')
  const directories = new Map<string, string>()
  for (const entry of await readdir(packagesRoot, { withFileTypes: true })) {
    const directory = join(packagesRoot, entry.name)
    if (!entry.isDirectory() || !existsSync(join(directory, 'package.json'))) continue
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: string }
    if (manifest.name) directories.set(manifest.name, directory)
  }
  return directories
}

function resolveInstalledPackage(fromDirectory: string, packageName: string): string {
  for (let directory = fromDirectory; ; directory = dirname(directory)) {
    const candidate = join(directory, 'node_modules', packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dirname(directory) === directory) break
  }
  throw new Error(`Installed dependency "${packageName}" was not found from "${fromDirectory}".`)
}

async function resolveExternalDependencies(): Promise<Map<string, string>> {
  const directories = await listWorkspacePackageDirectories()
  const externals = new Map<string, string>()
  const visited = new Set<string>()
  const pending = [...holoPackageNames]
  for (let packageName = pending.pop(); packageName !== undefined; packageName = pending.pop()) {
    if (visited.has(packageName)) continue
    visited.add(packageName)
    const directory = directories.get(packageName)
    if (!directory) throw new Error(`Workspace package "${packageName}" was not found.`)
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (dependency.startsWith('@holo-js/')) {
        pending.push(dependency)
        continue
      }
      const installed = await realpath(resolveInstalledPackage(directory, dependency))
      const previous = externals.get(dependency)
      if (previous !== undefined && previous !== installed) throw new Error(`"${dependency}" resolves to more than one installed copy.`)
      externals.set(dependency, installed)
    }
  }
  return externals
}

beforeAll(async () => {
  stagingRoot = await mkdtemp(join(tmpdir(), 'holo-native-plugin-packages-'))
  await execute(process.execPath, ['--input-type=module', '-e', `
    import { stageLocalWorkspacePackages } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'scripts/local-workspace-packages.mjs')).href)}
    await stageLocalWorkspacePackages(process.argv[1], process.argv[2])
  `, repoRoot, stagingRoot], { timeout: 120000, env: npmEnv })
  packages = JSON.parse(await readFile(join(stagingRoot, 'local-packages/workspace-packages.json'), 'utf8'))
  externalDependencies = await resolveExternalDependencies()
  holoVersion = (JSON.parse(await readFile(join(repoRoot, 'packages/cli/package.json'), 'utf8')) as { version: string }).version
}, 120000)

afterAll(async () => {
  await rm(stagingRoot, { recursive: true, force: true })
})

it.each(['valid', 'broken'] as const)('activates an actually installed %s plugin through the CLI and preserves configuration on failure', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'holo-native-plugin-lifecycle-'))
  const pluginRoot = join(root, 'extensions/native-plugin')
  const appConfig = "import { defineAppConfig } from '@holo-js/config'; export default defineAppConfig({ name: 'Native Plugins' })"
  try {
    await mkdir(pluginRoot, { recursive: true })
    await mkdir(join(root, 'config'))
    await writeFile(join(root, 'config/app.mjs'), appConfig)
    await writeFile(join(root, 'config/database.mjs'), "import { defineDatabaseConfig } from '@holo-js/db'; export default defineDatabaseConfig({ defaultConnection: 'main', connections: { main: { driver: 'sqlite', url: ':memory:' } } })")
    await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: 'holo-plugin-native', version: '1.0.0', type: 'module', holo: { plugin: './plugin.mjs' } }))
    await writeFile(join(pluginRoot, 'plugin.mjs'), "export default { id: 'native', name: 'Native Plugin', contributes: { dependencies: { holo: ['@holo-js/security'] }, project: { prepare: './prepare.mjs' } } }")
    await writeFile(join(pluginRoot, 'prepare.mjs'), mode === 'valid'
      ? "export default { apiVersion: 1, prepare: () => ({ kind: 'prepared', generatedArtifacts: [{ path: 'message.txt', contents: 'prepared by the installed plugin' }], watch: { roots: ['extensions/source'], excludes: [] } }) }"
      : "import { HoloProjectPrepareError } from '@holo-js/kernel'; export default { apiVersion: 1, prepare() { throw new HoloProjectPrepareError({ code: 'NATIVE_PREPARE_REJECTED', message: 'native prepare rejected' }) } }")
    const localHoloDependencies = Object.fromEntries(holoPackageNames.map(name => [name, `file:${packages[name]}`]))
    const appManifest = { name: 'native-plugin-app', private: true, type: 'module', packageManager: 'npm@10.0.0', dependencies: { ...localHoloDependencies, 'holo-plugin-native': `file:${pluginRoot}` } }
    await writeFile(join(root, 'package.json'), JSON.stringify(appManifest))
    for (const [dependency, installed] of externalDependencies) await symlinkPackageDependency(join(root, 'node_modules'), dependency, installed)
    await execute('npm', ['install', '--offline', '--legacy-peer-deps', '--ignore-scripts', '--no-bin-links', '--no-audit', '--no-fund'], { cwd: root, timeout: 30000, env: npmEnv })
    const registryHoloDependencies = Object.fromEntries(holoPackageNames.map(name => [name, `^${holoVersion}`]))
    await writeFile(join(root, 'package.json'), JSON.stringify({ ...appManifest, dependencies: { ...registryHoloDependencies, 'holo-plugin-native': `file:${pluginRoot}` } }))
    const cli = join(root, 'node_modules/@holo-js/cli/dist/bin/holo.mjs')
    const manifest = await readFile(join(root, 'package.json'), 'utf8')
    if (mode === 'broken') {
      await expect(execute(process.execPath, [cli, 'plugin:add', 'holo-plugin-native'], { cwd: root, timeout: 30000 })).rejects.toThrow('native prepare rejected')
      expect(await readFile(join(root, 'config/app.mjs'), 'utf8')).toBe(appConfig)
      await expect(readFile(join(root, 'config/security.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(manifest)
      await expect(readFile(join(root, '.holo-js/generated/native/message.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      return
    }
    await execute(process.execPath, [cli, 'plugin:add', 'holo-plugin-native'], { cwd: root, timeout: 30000 })
    expect(await readFile(join(root, '.holo-js/generated/native/message.txt'), 'utf8')).toBe('prepared by the installed plugin')
    expect(await readFile(join(root, 'config/security.ts'), 'utf8')).toContain('defineSecurityConfig')
    const listed = await execute(process.execPath, [cli, 'plugin:list'], { cwd: root })
    expect(listed.stdout).toContain('holo-plugin-native')
    const inspected = await execute(process.execPath, [cli, 'plugin:info', 'holo-plugin-native'], { cwd: root })
    expect(inspected.stdout).toContain('Native Plugin')
    const diagnosed = await execute(process.execPath, [cli, 'plugin:doctor'], { cwd: root })
    expect(diagnosed.stdout).toContain('holo-plugin-native')
    await execute(process.execPath, [cli, 'plugin:remove', 'holo-plugin-native'], { cwd: root, timeout: 30000 })
    const inactive = await execute(process.execPath, [cli, 'plugin:list'], { cwd: root })
    expect(inactive.stdout).not.toContain('holo-plugin-native')
    await expect(readFile(join(root, '.holo-js/generated/native/message.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 120000)
