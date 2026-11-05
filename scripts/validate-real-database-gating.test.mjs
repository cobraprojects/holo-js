import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { gatingEnvironment, gatingFailures, realDatabaseGatingTargets } from './validate-real-database-gating.mjs'

async function writeRepoFile(root, path, source) {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), source)
}

test('real-database gating selects every package test file that can reach PostgreSQL or MySQL', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-gating-'))
  await writeRepoFile(root, 'packages/db/package.json', '{}')
  await writeRepoFile(root, 'packages/db/tests/helpers.test.ts', "import { openDatabase } from './support/database'\n")
  await writeRepoFile(root, 'packages/db/tests/nested/shared.test.ts', "import { postgresTestConnection } from '../../../../tests/support/real-database'\n")
  await writeRepoFile(root, 'packages/db/tests/adapter.test.ts', "import { createPostgresAdapter } from '@holo-js/db-postgres'\n")
  await writeRepoFile(root, 'packages/db/tests/raw.test.ts', "import { createConnection } from 'mysql2/promise'\n")
  await writeRepoFile(root, 'packages/db/tests/pure.test.ts', "import { column } from '../src'\n")
  await writeRepoFile(root, 'packages/db/tests/support/database.ts', "import { createMySQLAdapter } from '@holo-js/db-mysql'\n")
  await writeRepoFile(root, 'packages/db/node_modules/x/tests/a.test.ts', "import pg from 'pg'\n")
  await writeRepoFile(root, 'packages/realtime/package.json', '{}')
  await writeRepoFile(root, 'packages/realtime/tests/native.test.ts', "import { createMySQLAdapter } from '../../db-mysql/src'\n")
  await writeRepoFile(root, 'packages/kernel/package.json', '{}')
  await writeRepoFile(root, 'packages/kernel/tests/kernel.test.ts', "export {}\n")
  assert.deepEqual(realDatabaseGatingTargets(root), [
    { packageDirectory: 'packages/db', files: ['tests/adapter.test.ts', 'tests/helpers.test.ts', 'tests/nested/shared.test.ts', 'tests/raw.test.ts'] },
    { packageDirectory: 'packages/realtime', files: ['tests/native.test.ts'] },
  ])
})

test('real-database gating runs without integration flags, scratch databases or reachable servers', () => {
  const environment = gatingEnvironment({
    PATH: '/bin',
    HOLO_POSTGRES_INTEGRATION: '1',
    HOLO_MYSQL_INTEGRATION: '1',
    HOLO_POSTGRES_DATABASE: 'holo_scratch',
    HOLO_MYSQL_DATABASE: 'holo_scratch',
    HOLO_POSTGRES_HOST: 'db.internal',
    PGDATABASE: 'postgres',
  })
  assert.equal(environment.PATH, '/bin')
  for (const variable of ['HOLO_POSTGRES_INTEGRATION', 'HOLO_MYSQL_INTEGRATION', 'HOLO_POSTGRES_DATABASE', 'HOLO_MYSQL_DATABASE', 'PGDATABASE']) {
    assert.equal(environment[variable], undefined)
  }
  assert.equal(environment.HOLO_POSTGRES_HOST, '127.0.0.1')
  assert.equal(environment.HOLO_MYSQL_HOST, '127.0.0.1')
  assert.equal(environment.HOLO_POSTGRES_PORT, '1')
  assert.equal(environment.HOLO_MYSQL_PORT, '1')
  assert.equal(environment.PGHOST, '127.0.0.1')
  assert.equal(environment.PGPORT, '1')
})

test('real-database gating reports every test and file that failed without integration flags', () => {
  const report = {
    testResults: [
      { name: '/repo/packages/db/tests/a.test.ts', status: 'failed', message: '', assertionResults: [
        { fullName: 'suite opens postgres', status: 'failed', failureMessages: ['Error: Real database tests must be gated on HOLO_POSTGRES_INTEGRATION=1 before they connect.\n    at x'] },
        { fullName: 'suite skips mysql', status: 'pending', failureMessages: [] },
        { fullName: 'suite passes sqlite', status: 'passed', failureMessages: [] },
      ] },
      { name: '/repo/packages/db/tests/b.test.ts', status: 'failed', message: 'Error: connect ECONNREFUSED 127.0.0.1:1\n    at y', assertionResults: [] },
      { name: '/repo/packages/db/tests/c.test.ts', status: 'passed', message: '', assertionResults: [] },
      { name: '/repo/packages/db/tests/d.test.ts', status: 'failed', message: 'Error: Real database tests must be gated on HOLO_MYSQL_INTEGRATION=1 before they connect.', assertionResults: [
        { fullName: 'hook runs', status: 'failed', failureMessages: ['Error: Real database tests must be gated on HOLO_MYSQL_INTEGRATION=1 before they connect.'] },
      ] },
      { name: '/repo/packages/db/tests/e.test.ts', status: 'failed', message: 'Error: Real database tests must be gated on HOLO_MYSQL_INTEGRATION=1 before they connect.', assertionResults: [
        { fullName: 'hook suite runs', status: 'skipped', failureMessages: [] },
      ] },
      { name: '/repo/packages/db/tests/f.test.ts', status: 'failed', message: '', assertionResults: [
        { fullName: 'hook runs', status: 'skipped', failureMessages: [] },
      ] },
    ],
  }
  assert.deepEqual(gatingFailures('packages/db', report), [
    'packages/db/tests/a.test.ts :: suite opens postgres: Error: Real database tests must be gated on HOLO_POSTGRES_INTEGRATION=1 before they connect.',
    'packages/db/tests/b.test.ts: Error: connect ECONNREFUSED 127.0.0.1:1',
    'packages/db/tests/d.test.ts :: hook runs: Error: Real database tests must be gated on HOLO_MYSQL_INTEGRATION=1 before they connect.',
    'packages/db/tests/e.test.ts: Error: Real database tests must be gated on HOLO_MYSQL_INTEGRATION=1 before they connect.',
    'packages/db/tests/f.test.ts: a suite or hook failed',
  ])
  assert.deepEqual(gatingFailures('packages/db', { success: false, testResults: [] }), ['packages/db: vitest reported a failure'])
  assert.deepEqual(gatingFailures('packages/db', { testResults: [] }), [])
  assert.deepEqual(gatingFailures('packages/db', undefined), ['packages/db: vitest produced no report'])
})
