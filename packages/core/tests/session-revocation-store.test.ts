import { execFile, execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ConnectionManager, DatabaseContext, configureDB, createDialect, createSchemaService, resetDB, type DatabaseLogger } from '@holo-js/db'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { createPostgresAdapter } from '@holo-js/db-postgres'
import { createMySQLAdapter } from '@holo-js/db-mysql'
import migration from '../../../apps/blog-next/server/db/migrations/2026_10_08_000001_create_auth_session_revocations'
import { createCoreSessionRevocationStore } from '../src/portable/authSessionRevocations'

const directories: string[] = []
const connections: DatabaseContext[] = []
const schema = 'CREATE TABLE auth_session_revocations (provider VARCHAR(255) NOT NULL, user_id VARCHAR(255) NOT NULL, generation INTEGER NOT NULL DEFAULT 0, retained_session_id VARCHAR(255), PRIMARY KEY (provider, user_id))'

function connect(filename: string, logger?: DatabaseLogger): DatabaseContext {
  const connection = new DatabaseContext({ driver: 'sqlite', dialect: createDialect('sqlite'), adapter: createSQLiteAdapter({ filename }), logger })
  connections.push(connection)
  return connection
}

async function database(logger?: DatabaseLogger): Promise<{ readonly filename: string, readonly connection: DatabaseContext }> {
  const directory = await mkdtemp(join(tmpdir(), 'core-revocations-'))
  directories.push(directory)
  const filename = join(directory, 'revocations.sqlite')
  const connection = connect(filename, logger)
  await connection.initialize()
  await connection.executeCompiled({ sql: schema, source: 'schema' })
  configureDB(new ConnectionManager({ defaultConnection: 'main', connections: { main: connection } }))
  return { filename, connection }
}

afterEach(async () => {
  resetDB()
  await Promise.all(connections.splice(0).map(connection => connection.disconnect()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

it('atomically retains one competing browser across independent processes and never revives a stale caller', async () => {
  const { filename } = await database()
  const store = createCoreSessionRevocationStore()
  const identity = { provider: 'users', userId: 1 }
  const sessions = [{ id: 'first-browser', generation: 0 }, { id: 'second-browser', generation: 0 }]
  const results = await Promise.all(sessions.map(async session => {
    const script = `
      import { ConnectionManager, DatabaseContext, configureDB, createDialect } from '@holo-js/db'
      import { createSQLiteAdapter } from '@holo-js/db-sqlite'
      import { createCoreSessionRevocationStore } from ${JSON.stringify(resolve(import.meta.dirname, '../src/portable/authSessionRevocations.ts'))}
      const connection = new DatabaseContext({ driver: 'sqlite', dialect: createDialect('sqlite'), adapter: createSQLiteAdapter({ filename: ${JSON.stringify(filename)} }) })
      configureDB(new ConnectionManager({ defaultConnection: 'main', connections: { main: connection } }))
      console.log(JSON.stringify(await createCoreSessionRevocationStore().revokeOthers(${JSON.stringify(identity)}, ${JSON.stringify(session)})))
      await connection.disconnect()
    `
    const { stdout } = await promisify(execFile)(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', script], { cwd: resolve(import.meta.dirname, '..') })
    return JSON.parse(stdout) as boolean
  }))
  expect(results.filter(Boolean)).toHaveLength(1)
  const winner = sessions[results.indexOf(true)]
  const loser = sessions[results.indexOf(false)]
  if (!winner || !loser) throw new Error('Expected one successful revocation and one invalid caller')
  await expect(store.revokeOthers(identity, loser)).resolves.toBe(false)
  await expect(store.revokeOthers(identity, winner)).resolves.toBe(true)
  await expect(store.revokeOthers({ provider: 'never-authenticated', userId: 1 }, { id: 'stale-absent', generation: 9 })).resolves.toBe(false)
  await expect(store.readMany([identity, { provider: 'never-authenticated', userId: 1 }])).resolves.toEqual([
    { ...identity, generation: 2, retainedSessionId: winner.id },
    { provider: 'never-authenticated', userId: 1, generation: 0 },
  ])
})

it('reads each distinct requested identity in one batch and preserves provider and user isolation', async () => {
  let reads = 0
  await database({ onQuerySuccess(entry) { if (entry.kind === 'query') reads++ } })
  const store = createCoreSessionRevocationStore()
  await store.revokeOthers({ provider: 'users', userId: 1 }, { id: 'browser', generation: 0 })
  reads = 0
    await expect(store.readMany([
      { provider: 'users', userId: 1 }, { provider: 'admins', userId: 1 },
      { provider: 'users', userId: 2 }, { provider: 'users', userId: '1' },
    ])).resolves.toEqual([
      { provider: 'users', userId: '1', generation: 1, retainedSessionId: 'browser' },
      { provider: 'admins', userId: 1, generation: 0 },
      { provider: 'users', userId: 2, generation: 0 },
    ])
    expect(reads).toBe(1)
})

it('preserves revocation state when a fresh process reconnects to the durable database', async () => {
  const { filename, connection } = await database()
  await createCoreSessionRevocationStore().revokeOthers({ provider: 'users', userId: 1 }, { id: 'retained', generation: 0 })
  await connection.disconnect()
  const script = `
    import { ConnectionManager, DatabaseContext, configureDB, createDialect } from '@holo-js/db'
    import { createSQLiteAdapter } from '@holo-js/db-sqlite'
    import { createCoreSessionRevocationStore } from ${JSON.stringify(resolve(import.meta.dirname, '../src/portable/authSessionRevocations.ts'))}
    const connection = new DatabaseContext({ driver: 'sqlite', dialect: createDialect('sqlite'), adapter: createSQLiteAdapter({ filename: ${JSON.stringify(filename)} }) })
    configureDB(new ConnectionManager({ defaultConnection: 'main', connections: { main: connection } }))
    console.log(JSON.stringify(await createCoreSessionRevocationStore().readMany([{ provider: 'users', userId: 1 }])))
    await connection.disconnect()
  `
  const result = execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', script], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' })
  expect(JSON.parse(result)).toEqual([{ provider: 'users', userId: 1, generation: 1, retainedSessionId: 'retained' }])
})

for (const driver of ['postgres', 'mysql'] as const) {
  const databaseName = driver === 'postgres' ? process.env.HOLO_AUTH_REDEMPTION_POSTGRES_DATABASE : process.env.HOLO_AUTH_REDEMPTION_MYSQL_DATABASE
  it.skipIf(!databaseName)(`preserves exact string identities and competing revocation validity in native ${driver}`, async () => {
    const connection = new DatabaseContext({
      driver, dialect: createDialect(driver),
      adapter: driver === 'postgres'
        ? createPostgresAdapter({ config: { host: process.env.HOLO_AUTH_REDEMPTION_POSTGRES_HOST ?? '127.0.0.1', port: Number(process.env.HOLO_AUTH_REDEMPTION_POSTGRES_PORT ?? 54383), user: process.env.PGUSER ?? 'postgres', password: process.env.PGPASSWORD, database: databaseName } })
        : createMySQLAdapter({ config: { host: '127.0.0.1', port: Number(process.env.HOLO_AUTH_REDEMPTION_MYSQL_PORT ?? 33183), user: process.env.MYSQL_USER ?? 'root', password: process.env.MYSQL_PASSWORD, database: databaseName } }),
    })
    connections.push(connection)
    await connection.initialize()
    const context = { db: connection, schema: createSchemaService(connection) }
    await migration.up(context)
    configureDB(new ConnectionManager({ defaultConnection: 'main', connections: { main: connection } }))
    const store = createCoreSessionRevocationStore()
    try {
      const identity = { provider: 'users', userId: 'alice' }
      const sessions = [{ id: 'browser', generation: 0 }, { id: 'other-browser', generation: 0 }]
      const results = await Promise.all(sessions.map(session => store.revokeOthers(identity, session)))
      expect(results.filter(Boolean)).toHaveLength(1)
      const winner = sessions[results.indexOf(true)]
      if (!winner) throw new Error('Expected a retained browser')
      await expect(store.revokeOthers(identity, { id: winner.id.toUpperCase(), generation: 0 })).resolves.toBe(false)
      await expect(store.revokeOthers(identity, { id: `${winner.id} `, generation: 0 })).resolves.toBe(false)
      await expect(store.readMany([identity, { provider: 'Users', userId: 'alice' }, { provider: 'users ', userId: 'alice' }, { provider: 'users', userId: 'Alice' }, { provider: 'users', userId: 'alice ' }])).resolves.toEqual([
        { ...identity, generation: 1, retainedSessionId: winner.id },
        { provider: 'Users', userId: 'alice', generation: 0 },
        { provider: 'users ', userId: 'alice', generation: 0 },
        { provider: 'users', userId: 'Alice', generation: 0 },
        { provider: 'users', userId: 'alice ', generation: 0 },
      ])
      await expect(store.revokeOthers({ provider: 'Users', userId: 'alice' }, { id: 'separate-provider', generation: 0 })).resolves.toBe(true)
      await expect(store.readMany([identity])).resolves.toEqual([{ ...identity, generation: 1, retainedSessionId: winner.id }])
    } finally {
      await migration.down(context)
    }
  })
}
