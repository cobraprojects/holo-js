import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { runProjectDependencyInstall } from '../src/package-manager'

it.each(['successful', 'failed'] as const)('runs the actual package manager for a %s dependency installation', async outcome => {
  const root = await mkdtemp(join(tmpdir(), 'holo-native-dependency-install-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const dependency = join(root, 'dependency')
  await mkdir(dependency)
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'native-dependency', version: '1.0.0', main: 'index.cjs' }))
  await writeFile(join(dependency, 'index.cjs'), "module.exports = 'installed dependency'")
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'native-install-app', private: true, packageManager: 'npm@10.0.0',
    dependencies: { 'native-dependency': 'file:./dependency' },
    scripts: { preinstall: outcome === 'failed' ? 'node -e "console.error(\'native install rejected\'); process.exit(1)"' : 'node -e "console.log(\'native install completed\')"' },
  }))
  const installation = runProjectDependencyInstall({ cwd: root, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }, root)
  if (outcome === 'failed') {
    await expect(installation).rejects.toThrow('native install rejected')
    return
  }
  await installation
  const installed = JSON.parse(await readFile(join(root, 'node_modules/native-dependency/package.json'), 'utf8'))
  expect(installed).toMatchObject({ name: 'native-dependency', version: '1.0.0' })
  expect(await readFile(join(root, 'node_modules/native-dependency/index.cjs'), 'utf8')).toBe("module.exports = 'installed dependency'")
}, 30000)
