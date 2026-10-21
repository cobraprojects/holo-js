import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { ConnectionManager, DatabaseContext, configureDB, createDialect, createSchemaService, resetDB } from '@holo-js/db'
import { createMySQLAdapter } from '@holo-js/db-mysql'
import { createDatabaseSessionStore, type SessionRecord } from '@holo-js/session'
import migration from '../../../apps/blog-next/server/db/migrations/2026_04_25_044033_create_sessions'
import { createCoreDatabaseSessionAdapter } from '../src/portable/sessionPersistence'

it.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('persists concurrent new MySQL sessions without deadlocking and retains private flashes on rewrites', async () => {
  const name = `session_${randomUUID().replaceAll('-', '')}`
  const config = {
    host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
    user: process.env.HOLO_MYSQL_USER ?? 'root',
    password: process.env.HOLO_MYSQL_PASSWORD,
  }
  const connect = (database: string): DatabaseContext => new DatabaseContext({
    driver: 'mysql', dialect: createDialect('mysql'), adapter: createMySQLAdapter({ config: { ...config, database } }),
  })
  const admin = connect('mysql')
  const connection = connect(name)
  try {
    await admin.executeCompiled({ sql: `CREATE DATABASE ${name}`, source: 'schema' })
    await migration.up({ db: connection, schema: createSchemaService(connection) })
    configureDB(new ConnectionManager({ defaultConnection: 'main', connections: { main: connection } }))
    const store = createDatabaseSessionStore(createCoreDatabaseSessionAdapter('sessions', 'main'))
    const now = new Date(Math.floor(Date.now() / 1000) * 1000)
    const first: SessionRecord = {
      id: 'a', store: 'database', data: { owner: 'a' }, createdAt: now, lastActivityAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    }
    const records = [first, { ...first, id: 'b', data: { owner: 'b' } }]
    await connection.executeCompiled({
      sql: `CREATE TRIGGER pause_session_insert BEFORE INSERT ON sessions FOR EACH ROW BEGIN
        DO GET_LOCK(CONCAT('${name}', NEW.id), 0);
        DO GET_LOCK('${name}', 10);
        DO RELEASE_LOCK('${name}');
        DO RELEASE_LOCK(CONCAT('${name}', NEW.id));
      END`,
      source: 'schema',
    })
    const results = await admin.transaction(async control => {
      await control.queryCompiled({ sql: 'SELECT GET_LOCK(?, 10)', bindings: [name], source: 'sessions' })
      const writes = Promise.allSettled(records.map(record => store.write(record)))
      try {
        await vi.waitUntil(async () => {
          const { rows } = await control.queryCompiled<{ arrived: number }>({
            sql: 'SELECT IS_USED_LOCK(?) IS NOT NULL AND IS_USED_LOCK(?) IS NOT NULL AS arrived',
            bindings: [`${name}a`, `${name}b`], source: 'sessions',
          })
          return rows[0]?.arrived === 1
        }, { timeout: 5000, interval: 10 }).catch(error => {
          throw new Error('Both native session inserts must reach the database barrier', { cause: error })
        })
      } finally {
        await control.queryCompiled({ sql: 'SELECT RELEASE_LOCK(?)', bindings: [name], source: 'sessions' })
        await writes
      }
      return writes
    })
    for (const result of results) if (result.status === 'rejected') throw result.reason
    await connection.executeCompiled({ sql: 'DROP TRIGGER pause_session_insert', source: 'schema' })
    for (const record of records) await expect(store.read(record.id)).resolves.toEqual(record)
    await store.flash?.('a', 'notice', 'retained')
    await store.write({ ...first, data: { owner: 'updated' } })
    await expect(store.read('a')).resolves.toMatchObject({ data: { owner: 'updated' } })
    await expect(store.take?.('a', 'notice')).resolves.toEqual({ found: true, value: 'retained' })
    await expect(store.take?.('a', 'notice')).resolves.toEqual({ found: false })
  } finally {
    resetDB()
    await connection.disconnect()
    await admin.executeCompiled({ sql: `DROP DATABASE IF EXISTS ${name}`, source: 'schema' })
    await admin.disconnect()
  }
}, 20000)
