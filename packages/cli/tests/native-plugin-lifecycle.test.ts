import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { stagePublishedPackage, symlinkPackageDependency } from '../../../tests/support/published-package'

const execute = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '../../..')
const holoPackageNames = ['@holo-js/cli', '@holo-js/core', '@holo-js/db-sqlite', '@holo-js/kernel', '@holo-js/security', '@holo-js/session']

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
    const holoVersion = (JSON.parse(await readFile(join(repoRoot, 'packages/cli/package.json'), 'utf8')) as { version: string }).version
    const holoDependencies = Object.fromEntries(holoPackageNames.map(name => [name, `^${holoVersion}`]))
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'native-plugin-app', private: true, type: 'module', packageManager: 'npm@10.0.0', dependencies: { ...holoDependencies, 'holo-plugin-native': `file:${pluginRoot}` } }))
    for (const name of holoPackageNames) {
      const directory = join(repoRoot, 'packages', name.slice('@holo-js/'.length))
      await stagePublishedPackage(directory, join(root, 'node_modules', name), join(directory, 'dist'))
    }
    await symlinkPackageDependency(join(root, 'node_modules'), 'holo-plugin-native', pluginRoot)
    const cli = join(root, 'node_modules/@holo-js/cli/dist/bin/holo.mjs')
    const manifest = await readFile(join(root, 'package.json'), 'utf8')
    if (mode === 'broken') {
      await expect(execute(process.execPath, [cli, 'plugin:add', 'holo-plugin-native'], { cwd: root })).rejects.toThrow('native prepare rejected')
      expect(await readFile(join(root, 'config/app.mjs'), 'utf8')).toBe(appConfig)
      await expect(readFile(join(root, 'config/security.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(manifest)
      await expect(readFile(join(root, '.holo-js/generated/native/message.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      return
    }
    await execute(process.execPath, [cli, 'plugin:add', 'holo-plugin-native'], { cwd: root })
    expect(await readFile(join(root, '.holo-js/generated/native/message.txt'), 'utf8')).toBe('prepared by the installed plugin')
    expect(await readFile(join(root, 'config/security.ts'), 'utf8')).toContain('defineSecurityConfig')
    const listed = await execute(process.execPath, [cli, 'plugin:list'], { cwd: root })
    expect(listed.stdout).toContain('holo-plugin-native')
    const inspected = await execute(process.execPath, [cli, 'plugin:info', 'holo-plugin-native'], { cwd: root })
    expect(inspected.stdout).toContain('Native Plugin')
    const diagnosed = await execute(process.execPath, [cli, 'plugin:doctor'], { cwd: root })
    expect(diagnosed.stdout).toContain('holo-plugin-native')
    await execute(process.execPath, [cli, 'plugin:remove', 'holo-plugin-native'], { cwd: root })
    const inactive = await execute(process.execPath, [cli, 'plugin:list'], { cwd: root })
    expect(inactive.stdout).not.toContain('holo-plugin-native')
    await expect(readFile(join(root, '.holo-js/generated/native/message.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 120000)
