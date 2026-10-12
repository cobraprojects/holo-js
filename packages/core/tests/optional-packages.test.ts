import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { stagePublishedPackage } from '../../../tests/support/published-package'

const execute = promisify(execFile)
const root = resolve(import.meta.dirname, '../../..')
const cases = [
  {
    name: 'queue', packageName: '@holo-js/queue', configFile: 'queue',
    config: { default: 'sync', failed: false },
    message: '[@holo-js/core] Queue support requires @holo-js/queue to be installed.',
  },
  {
    name: 'storage', packageName: '@holo-js/storage', configFile: 'storage',
    config: { defaultDisk: 'local', disks: { local: { driver: 'local', root: './storage/app' } } },
    message: '[@holo-js/core] Storage support requires @holo-js/storage to be installed.',
  },
  ...(['postgres', 'mysql'] as const).map(driver => ({
    name: `${driver} database driver`, packageName: `@holo-js/db-${driver}`, configFile: 'database',
    config: { defaultConnection: 'main', connections: { main: { driver, host: '127.0.0.1', database: 'framework' } } },
    message: `[@holo-js/core] Database driver "${driver}" requires @holo-js/db-${driver} to be installed.`,
  })),
]

it.each(cases)('reports configured $name when its package is physically absent', async scenario => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-native-optional-package-'))
  try {
    await mkdir(join(projectRoot, 'config'), { recursive: true })
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(projectRoot, 'config/app.mjs'), "export default { name: 'Optional Package App' }")
    await writeFile(join(projectRoot, 'config/database.mjs'), "export default { defaultConnection: 'main', connections: { main: { driver: 'sqlite', url: ':memory:' } } }")
    await writeFile(join(projectRoot, `config/${scenario.configFile}.mjs`), `export default ${JSON.stringify(scenario.config)}`)
    for (const name of ['core', 'db-sqlite']) {
      await stagePublishedPackage(join(root, 'packages', name), join(projectRoot, 'node_modules/@holo-js', name), join(root, 'packages', name, 'dist'))
    }

    const result = await execute(process.execPath, ['--input-type=module', '--eval', `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHolo } from '@holo-js/core'
const require = createRequire(import.meta.url)
assert.throws(() => require.resolve(${JSON.stringify(scenario.packageName)}), { code: 'MODULE_NOT_FOUND' })
await assert.rejects(async () => {
  const runtime = await createHolo(process.cwd())
  await runtime.initialize()
}, { message: ${JSON.stringify(scenario.message)} })
console.log('Native missing-package behavior passed')
`], { cwd: projectRoot })
    expect(result.stdout).toContain('Native missing-package behavior passed')
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
  }
})
