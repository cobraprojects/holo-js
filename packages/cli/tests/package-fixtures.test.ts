import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { stageWorkspacePackagesSync } from '../../../tests/support/published-package'

it('loads transitive, optional, and peer dependencies from isolated fixture packages', () => {
  const root = mkdtempSync(join(tmpdir(), 'holo-package-graph-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  const manifests = [
    { name: '@holo-js/app', dependencies: { '@holo-js/auth': 'catalog:' }, peerDependencies: { '@holo-js/peer': 'catalog:' } },
    { name: '@holo-js/auth', dependencies: { '@holo-js/kernel': 'workspace:*' }, optionalDependencies: { '@holo-js/optional': 'catalog:' } },
    { name: '@holo-js/kernel' },
    { name: '@holo-js/optional' },
    { name: '@holo-js/peer' },
  ]
  for (const manifest of manifests) {
    const directory = join(root, 'packages', manifest.name.slice('@holo-js/'.length))
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ ...manifest, type: 'module', exports: './index.mjs', scripts: { build: 'unused' } }))
  }
  const packages = stageWorkspacePackagesSync(root, join(root, 'fixture'), ['@holo-js/app'])
  for (const { name, directory } of packages) {
    const source = name === '@holo-js/app'
      ? "import { value } from '@holo-js/auth'; import { value as peer } from '@holo-js/peer'; export { value, peer }"
      : name === '@holo-js/auth'
        ? "import { value } from '@holo-js/kernel'; import { value as optional } from '@holo-js/optional'; export { value, optional }"
        : `export const value = ${JSON.stringify(name)}`
    writeFileSync(join(directory, 'index.mjs'), source)
  }
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', "import { value, peer } from './app/index.mjs'; import { optional } from './auth/index.mjs'; console.log(JSON.stringify({value, peer, optional}))"], {
    cwd: join(root, 'fixture'),
    encoding: 'utf8',
  })
  expect(JSON.parse(output)).toEqual({ value: '@holo-js/kernel', peer: '@holo-js/peer', optional: '@holo-js/optional' })
})
