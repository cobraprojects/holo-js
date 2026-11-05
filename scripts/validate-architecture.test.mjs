import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { runArchitectureValidation, validateArchitecture } from './validate-architecture.mjs'

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

test('architecture validator accepts real-database tests that connect through the shared helpers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-architecture-'))
  await createPackage(root, '@holo-js/kernel')
  await writeTestFile(root, 'tests/support/real-database.ts', "export const database = process.env.HOLO_POSTGRES_DATABASE\n")
  await writeTestFile(root, 'tests/native-library-suite.mjs', "const client = new pg.Client({ host: '127.0.0.1', database: 'postgres' })\n")
  await writeTestFile(root, 'tests/example-app-matrix.mjs', "const host = process.env.HOLO_MYSQL_HOST\n")
  await writeTestFile(root, 'packages/db/tests/support/database.ts', "function createTestAdapter(connection) {\n  return createPostgresAdapter({ config: connection })\n}\n")
  await writeTestFile(root, 'packages/db/tests/support-database.test.ts', "vi.stubEnv('HOLO_POSTGRES_DATABASE', 'holo_scratch')\n")
  await writeTestFile(root, 'packages/kernel/tests/local-names.test.ts', [
    'function createConnection(logger?: Logger) {',
    "  return createDatabase({ adapter: createSQLiteAdapter({ filename: ':memory:' }) })",
    '}',
    '',
    "it('migrates', () => {",
    '  createConnection()',
    '  const client = new Client({ host: \'example.test\' })',
    '})',
    '',
  ].join('\n'))
  await writeTestFile(root, 'packages/kernel/tests/helpers.test.ts', [
    "import { postgresTestConnection, testConnectionUrl } from '../../../tests/support/real-database'",
    '',
    "it.runIf(postgresIntegration)('connects', async () => {",
    '  createPostgresAdapter({ config: { ...postgresTestConnection(), max: 1 } })',
    '  const { user, password, ...config } = postgresTestConnection()',
    '  createPostgresAdapter({ config: { ...config, user, password } })',
    "  createPostgresAdapter({ connectionString: testConnectionUrl('postgresql', postgresTestConnection()).toString() })",
    '  const client = new Client(postgresTestConnection())',
    '  const connect = (database: string) => createMySQLAdapter({ config: { ...mysqlTestConnection(), database } })',
    '  const scratch = mysqlTestConnection()',
    '  createMySQLAdapter({ config: { ...scratch, connectionLimit: 2 } })',
    "  mysqlDatabaseDriverFactory.create({ url: liveUrl(), ssl: true })",
    "  createPostgresAdapter({ connectionString: rawPathUrl('holo_x') })",
    '})',
    '',
    "it('uses fakes', () => {",
    "  createPostgresAdapter({ config: { options: '-c statement_timeout=5000', Client: FakeClient as never } })",
    "  createMySQLAdapter({ config: { host: 'fake.test' }, createPoolInstance: () => fakePool })",
    '  createPostgresAdapter({ client: fakeClient })',
    '  createMySQLAdapter({ pool: fakePool })',
    "  process.env.HOLO_POSTGRES_INTEGRATION = '1'",
    '})',
    '',
    '',
    'function liveUrl() {',
    "  return testConnectionUrl('mysql', mysqlTestConnection()).toString()",
    '}',
    '',
    'function rawPathUrl(database: string) {',
    "  const url = testConnectionUrl('postgresql', postgresTestConnection())",
    '  url.pathname = `/${database}`',
    '  return url.toString()',
    '}',
    '',
  ].join('\n'))
  assert.deepEqual(validateArchitecture(root), [])
})

test('architecture validator rejects tests that read connection settings or connect around the shared helpers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-architecture-'))
  await createPackage(root, '@holo-js/kernel')
  await writeTestFile(root, 'packages/kernel/tests/env.test.ts', [
    "const database = process.env.HOLO_POSTGRES_DATABASE ?? 'postgres'",
    "const port = process.env['HOLO_MYSQL_PORT']",
    'const url = process.env[`HOLO_${driver}_URL`]',
    'const { HOLO_POSTGRES_PASSWORD } = process.env',
    '',
  ].join('\n'))
  await writeTestFile(root, 'packages/kernel/tests/system.test.ts', "const config = { database: 'mysql' }\nconst url = testConnectionUrl('postgresql', { ...postgresTestConnection(), database: 'template1' })\nconst other = { database: 'information_schema' }\n")
  await writeTestFile(root, 'packages/kernel/tests/scopes.test.ts', [
    "import { Client as PgClient } from 'pg'",
    "import { createConnection as connectMySQL } from 'mysql2/promise'",
    "import pg from 'pg'",
    '',
    "it('first', () => {",
    '  const config = postgresTestConnection()',
    '  createPostgresAdapter({ config })',
    '})',
    '',
    "it('second', () => {",
    "  const config = { host: 'localhost', user: 'postgres' }",
    '  createPostgresAdapter({ config })',
    '})',
    '',
    "it('aliases', async () => {",
    "  new PgClient({ host: 'localhost', user: 'postgres' })",
    '  await connectMySQL({})',
    '  new pg.Pool({})',
    '})',
    '',
    "it('defaults', () => {",
    "  const user = 'postgres'",
    '  new PgClient({ user })',
    '  createMySQLAdapter({ config: {} })',
    '})',
    '',
  ].join('\n'))
  await writeTestFile(root, 'packages/kernel/tests/hoisting.test.ts', [
    "const config = { host: 'localhost', user: 'postgres' }",
    '',
    "it('local', () => {",
    '  const config = postgresTestConnection()',
    '  createPostgresAdapter({ config })',
    '})',
    '',
    "it('top level', () => {",
    '  createPostgresAdapter({ config })',
    '})',
    '',
  ].join('\n'))
  await writeTestFile(root, 'packages/kernel/tests/combined.test.ts', [
    "import pg, { Client } from 'pg'",
    "import mysql, { createPool as pool } from 'mysql2/promise'",
    '',
    "it('combined', async () => {",
    '  new Client({})',
    '  new pg.Pool({})',
    '  pool({})',
    '  mysql.createConnection({})',
    "  const { Client: Dynamic } = await import('pg')",
    '  new Dynamic({})',
    "  const { createConnection } = require('mysql2')",
    '  createConnection({})',
    "  const { default: dynamicMysql } = await import('mysql2/promise')",
    '  await dynamicMysql.createConnection({})',
    "  const pgModule = await import('pg')",
    '  const { Pool: StagedPool } = pgModule',
    '  new StagedPool({})',
    '})',
    '',
  ].join('\n'))
  await writeTestFile(root, 'packages/kernel/tests/keys.test.ts', [
    "it('helper', () => {",
    '  const config = postgresTestConnection()',
    '  createPostgresAdapter({ config })',
    '})',
    "it('literal', () => {",
    "  createPostgresAdapter({ config: { host: 'localhost', database: 'holo' } })",
    "  createPostgresAdapter({ config: settings.config })",
    '})',
    '',
  ].join('\n'))
  await writeTestFile(root, 'packages/kernel/tests/direct.test.ts', [
    "import { Client, Pool } from 'pg'",
    '',
    "it('x', async () => {",
    "  await openDatabase('sqlite')",
    "  createPostgresAdapter({ config: { host: '127.0.0.1', port: 5432, database: 'holo' } })",
    "  createMySQLAdapter({ uri: 'mysql://root@127.0.0.1/holo' })",
    "  const client = new Client({ host: 'localhost', user: 'postgres' })",
    "  const settings = { host: 'localhost', user: 'postgres' }",
    '  const pool = new Pool(settings)',
    '  const bare = new Client()',
    '})',
    '',
  ].join('\n'))
  const failures = validateArchitecture(root).join('\n')
  assert.match(failures, /packages\/kernel\/tests\/env\.test\.ts reads HOLO_POSTGRES_DATABASE; use postgresTestConnection\(\) or mysqlTestConnection\(\) from tests\/support\/real-database\.ts/)
  assert.match(failures, /env\.test\.ts reads HOLO_MYSQL_PORT; use/)
  assert.match(failures, /env\.test\.ts reads HOLO_\$\{driver\}_URL; use/)
  assert.match(failures, /env\.test\.ts reads HOLO_POSTGRES_PASSWORD; use/)
  assert.match(failures, /env\.test\.ts names the postgres system database/)
  assert.match(failures, /system\.test\.ts names the mysql system database/)
  assert.match(failures, /system\.test\.ts names the template1 system database/)
  assert.match(failures, /system\.test\.ts names the information_schema system database/)
  for (const [line, constructor] of [[12, 'createPostgresAdapter'], [16, 'new PgClient'], [17, 'connectMySQL'], [18, 'new pg.Pool'], [23, 'new PgClient'], [24, 'createMySQLAdapter']]) {
    assert.match(failures, new RegExp(`scopes\\.test\\.ts:${line} opens a real database with ${constructor} outside the shared helpers`))
  }
  assert.doesNotMatch(failures, /scopes\.test\.ts:7 /)
  assert.match(failures, /keys\.test\.ts:6 opens a real database with createPostgresAdapter outside the shared helpers/)
  assert.match(failures, /keys\.test\.ts:7 opens a real database with createPostgresAdapter outside the shared helpers/)
  assert.doesNotMatch(failures, /keys\.test\.ts:3 /)
  assert.match(failures, /hoisting\.test\.ts:9 opens a real database with createPostgresAdapter outside the shared helpers/)
  assert.doesNotMatch(failures, /hoisting\.test\.ts:5 /)
  for (const [line, constructor] of [[5, 'new Client'], [6, 'new pg.Pool'], [7, 'pool'], [8, 'mysql.createConnection'], [10, 'new Dynamic'], [12, 'createConnection'], [14, 'dynamicMysql.createConnection'], [17, 'new StagedPool']]) {
    assert.match(failures, new RegExp(`combined\\.test\\.ts:${line} opens a real database with ${constructor} outside the shared helpers`))
  }
  for (const [line, constructor] of [[5, 'createPostgresAdapter'], [6, 'createMySQLAdapter'], [7, 'new Client'], [9, 'new Pool'], [10, 'new Client']]) {
    assert.match(failures, new RegExp(`direct\\.test\\.ts:${line} opens a real database with ${constructor} outside the shared helpers; build its connection with postgresTestConnection\\(\\), mysqlTestConnection\\(\\) or testConnectionUrl\\(\\) from tests/support/real-database\\.ts`))
  }
  assert.doesNotMatch(failures, /real-database\.ts reads|native-library-suite|example-app-matrix/)
})

test('architecture validation points real-database failures at the authoritative runtime gating job', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-architecture-'))
  await createPackage(root, '@holo-js/kernel')
  await writeTestFile(root, 'packages/kernel/tests/env.test.ts', 'const database = process.env.HOLO_MYSQL_DATABASE\n')
  assert.throws(() => runArchitectureValidation(root), /This static check is a best-effort first line\. The Real-database gating CI job \(bun run test:real-database-gating\) is the authoritative check/)
  const clean = await mkdtemp(join(tmpdir(), 'holo-architecture-'))
  await createPackage(clean, '@holo-js/kernel')
  await createPackage(clean, '@holo-js/feature', {}, "import '@holo-js/kernel'")
  assert.throws(() => runArchitectureValidation(clean), error => !/Real-database gating/.test(error.message))
})
