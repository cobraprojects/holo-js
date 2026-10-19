import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { runProjectDependencyInstall } from '../src/package-manager'

const LOCKFILES = {
  npm: { name: 'package-lock.json', contents: '{"name":"native-install-app","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{}}' },
  pnpm: { name: 'pnpm-lock.yaml', contents: "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n" },
  yarn: { name: 'yarn.lock', contents: '' },
} as const

it.each(['npm', 'pnpm', 'yarn'] as const)('installs a local dependency through %s on this platform', async manager => {
  const root = await mkdtemp(join(tmpdir(), `holo-native-${manager}-install-`))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const dependency = join(root, 'dependency')
  await mkdir(dependency)
  await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'native-dependency', version: '1.0.0', main: 'index.cjs' }))
  await writeFile(join(dependency, 'index.cjs'), "module.exports = 'installed dependency'")
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'native-install-app',
    private: true,
    dependencies: { 'native-dependency': 'file:./dependency' },
  }))
  await writeFile(join(root, '.npmrc'), 'registry=http://127.0.0.1:1\nfetch-retries=0\n')
  await writeFile(join(root, LOCKFILES[manager].name), LOCKFILES[manager].contents)

  await runProjectDependencyInstall({ cwd: root, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }, root)

  expect(await readFile(join(root, 'node_modules/native-dependency/index.cjs'), 'utf8')).toBe("module.exports = 'installed dependency'")
}, 120000)
