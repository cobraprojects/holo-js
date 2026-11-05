import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateArchitecture } from './validate-architecture.mjs'

async function createPackage(root, name, dependencies = {}, source = '') {
  const directory = name.slice('@holo-js/'.length)
  const packageRoot = join(root, 'packages', directory)
  await mkdir(join(packageRoot, 'src'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name,
    exports: { '.': './dist/index.mjs', './public': './dist/public.mjs' },
    dependencies,
  }))
  await writeFile(join(packageRoot, 'src/index.ts'), source)
}

test('architecture validator accepts one-way declared public imports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-architecture-'))
  await createPackage(root, '@holo-js/kernel')
  await createPackage(root, '@holo-js/feature', { '@holo-js/kernel': 'catalog:' }, "export { value } from '@holo-js/kernel/public'")
  assert.deepEqual(validateArchitecture(root), [])
})

test('architecture validator reports cycles, undeclared imports, internal paths, and invalid layers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-architecture-'))
  await createPackage(root, '@holo-js/kernel', { '@holo-js/feature': 'catalog:' })
  await createPackage(root, '@holo-js/feature', { '@holo-js/kernel': 'catalog:' }, "import '@holo-js/missing'; import('@holo-js/kernel/internal')")
  await createPackage(root, '@holo-js/db', { '@holo-js/db-postgres': 'catalog:' })
  await createPackage(root, '@holo-js/db-postgres', { '@holo-js/db': 'catalog:' })
  await createPackage(root, '@holo-js/config', { '@holo-js/feature': 'catalog:' }, "import '@holo-js/feature/public'")
  const failures = validateArchitecture(root).join('\n')
  assert.match(failures, /kernel must not depend/)
  assert.match(failures, /imports undeclared dependency @holo-js\/missing/)
  assert.match(failures, /imports non-exported subpath @holo-js\/kernel\/internal/)
  assert.match(failures, /must not depend on concrete package/)
  assert.match(failures, /config must not depend on feature package/)
  assert.match(failures, /config\/src\/index.ts imports feature package/)
  assert.match(failures, /Workspace dependency cycle/)
})

async function writeTestFile(root, path, source) {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), source)
}

test('architecture validator accepts real-database tests that use the shared gated helpers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-architecture-'))
  await createPackage(root, '@holo-js/kernel')
  await writeTestFile(root, 'tests/support/real-database.ts', "export const database = process.env.HOLO_POSTGRES_DATABASE\n")
  await writeTestFile(root, 'tests/native-library-suite.mjs', "const client = new pg.Client({ host: '127.0.0.1', database: 'postgres' })\n")
  await writeTestFile(root, 'tests/example-app-matrix.mjs', "const host = process.env.HOLO_MYSQL_HOST\n")
  await writeTestFile(root, 'packages/kernel/tests/gated.test.ts', [
    "import { integrationDrivers, postgresIntegration, postgresTestConnection } from '../../../tests/support/real-database'",
    "import { openDatabase } from './support/database'",
    '',
    "it.each(integrationDrivers(['sqlite', 'postgres']))('runs on %s', async driver => {",
    '  await openDatabase(driver)',
    '})',
    '',
    "describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('mysql', () => {",
    "  it('opens mysql', async () => {",
    "    await openDatabase('mysql')",
    '  })',
    '})',
    '',
    "it.runIf(postgresIntegration)('connects', async () => {",
    '  createPostgresAdapter({ config: { ...postgresTestConnection(), max: 1 } })',
    '})',
    '',
    "it('opens sqlite', async () => {",
    "  await openDatabase('sqlite')",
    '  await openDatabase()',
    '})',
    '',
    "it('refuses without the flag', async () => {",
    "  vi.stubEnv('HOLO_POSTGRES_INTEGRATION', undefined)",
    '  expect(() => postgresTestConnection()).toThrow()',
    '})',
    '',
    "describe.each(['sqlite', 'postgres'] as const)('%s values', driver => {",
    "  const enabled = driver === 'sqlite' || process.env[`HOLO_${driver.toUpperCase()}_INTEGRATION`] === '1'",
    '',
    '  it.runIf(enabled)(\'round trips\', async () => {',
    '    await openDatabase(driver)',
    '  })',
    '})',
    '',
    "function registerScenario(driver: 'postgres' | 'mysql') {",
    "  it('loads rows', async () => {",
    '    await openDatabase(driver)',
    '  })',
    '}',
    '',
    "describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('on postgres', () => {",
    "  registerScenario('postgres')",
    '})',
    '',
    "describe('on sqlite', () => {",
    "  registerScenario('sqlite')",
    '})',
    '',
  ].join('\n'))
  assert.deepEqual(validateArchitecture(root), [])
})

test('architecture validator rejects real-database tests that bypass the shared helpers or their integration gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-architecture-'))
  await createPackage(root, '@holo-js/kernel')
  await writeTestFile(root, 'packages/kernel/tests/env.test.ts', "const database = process.env.HOLO_POSTGRES_DATABASE ?? 'postgres'\nconst port = process.env['HOLO_MYSQL_PORT']\nconst url = process.env[`HOLO_${driver}_URL`]\n")
  await writeTestFile(root, 'packages/kernel/tests/system.test.ts', "const config = { database: 'mysql' }\n")
  await writeTestFile(root, 'packages/kernel/tests/direct.test.ts', "it.runIf(gate)('x', () => {\n  createPostgresAdapter({ config: { host: '127.0.0.1', port: 5432, database: 'holo' } })\n  createMySQLAdapter({ uri: 'mysql://root@127.0.0.1/holo' })\n})\n")
  await writeTestFile(root, 'packages/kernel/tests/ungated.test.ts', [
    "import { postgresTestConnection } from '../../../tests/support/real-database'",
    '',
    "it.each(['sqlite', 'postgres', 'mysql'] as const)('runs on %s', async driver => {",
    '  await openDatabase(driver)',
    '})',
    '',
    "describe('postgres', () => {",
    "  it('opens postgres', async () => {",
    "    await openDatabase('postgres')",
    '  })',
    '})',
    '',
    "for (const driver of ['postgres', 'mysql'] as const) {",
    "  it('connects', () => {",
    '    createPostgresAdapter({ config: postgresTestConnection() })',
    '  })',
    '}',
    '',
    "function registerScenario(driver: 'postgres' | 'mysql') {",
    "  it('loads rows', async () => {",
    '    await openDatabase(driver)',
    '  })',
    '}',
    '',
    "describe('on mysql', () => {",
    "  registerScenario('mysql')",
    '})',
    '',
  ].join('\n'))
  const failures = validateArchitecture(root).join('\n')
  assert.match(failures, /packages\/kernel\/tests\/env\.test\.ts reads HOLO_POSTGRES_DATABASE from process\.env; use postgresTestConnection\(\) or mysqlTestConnection\(\) from tests\/support\/real-database\.ts/)
  assert.match(failures, /env\.test\.ts reads HOLO_MYSQL_PORT from process\.env/)
  assert.match(failures, /env\.test\.ts reads HOLO_\$\{driver\}_URL from process\.env/)
  assert.match(failures, /env\.test\.ts names the postgres system database/)
  assert.match(failures, /system\.test\.ts names the mysql system database/)
  assert.match(failures, /direct\.test\.ts:2 opens a real database with createPostgresAdapter without the shared helpers; build its connection with postgresTestConnection\(\), mysqlTestConnection\(\) or testConnectionUrl\(\) from tests\/support\/real-database\.ts/)
  assert.match(failures, /direct\.test\.ts:3 opens a real database with createMySQLAdapter/)
  assert.match(failures, /ungated\.test\.ts:4 reaches a real database outside an integration gate; gate it with integrationDrivers\(\), postgresIntegration or mysqlIntegration from tests\/support\/real-database\.ts/)
  assert.match(failures, /ungated\.test\.ts:9 reaches a real database outside an integration gate/)
  assert.match(failures, /ungated\.test\.ts:15 reaches a real database outside an integration gate/)
  assert.match(failures, /ungated\.test\.ts:21 reaches a real database outside an integration gate/)
  assert.doesNotMatch(failures, /real-database\.ts reads|native-library-suite|example-app-matrix/)
})
