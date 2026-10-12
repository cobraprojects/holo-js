import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { ConnectionManager, DB, DatabaseContext, column, configureDB, createDialect, defineGeneratedTable, resetDB } from '@holo-js/db'
import { createPostgresAdapter } from '../../db-postgres/src'
import { defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

it.runIf(process.env.HOLO_POSTGRES_INTEGRATION === '1')('allows typed inserts with INSERT-only privileges while realtime is subscribed and keeps private reads denied', async () => {
  const name = `insert_only_${randomUUID().replaceAll('-', '')}`
  const config = {
    host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
    port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
    database: process.env.HOLO_POSTGRES_DATABASE ?? 'postgres',
  }
  const owner = new DatabaseContext({ driver: 'postgres', dialect: createDialect('postgres'), adapter: createPostgresAdapter({ config: { ...config, user: 'postgres' } }), connectionName: 'main' })
  const table = defineGeneratedTable(name, { tenant_id: column.string().primaryKey(), secret: column.string() })
  let subscription: { unsubscribe(): void } | undefined
  try {
    await owner.executeCompiled({ sql: `CREATE ROLE ${name} LOGIN NOSUPERUSER NOBYPASSRLS`, source: 'schema' })
    await owner.executeCompiled({ sql: `CREATE TABLE ${name} (tenant_id VARCHAR(255) PRIMARY KEY, secret VARCHAR(255) NOT NULL)`, source: 'schema' })
    await owner.executeCompiled({ sql: `ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${name} FORCE ROW LEVEL SECURITY;
      CREATE POLICY provision ON ${name} FOR INSERT TO ${name} WITH CHECK (true);
      GRANT INSERT ON ${name} TO ${name}`, source: 'schema' })
    configureDB(new ConnectionManager({ defaultConnection: 'main', connections: { main: owner } }))
    configureRealtimeRuntime({ db: () => owner, loadAuthModule: async () => null })
    const snapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
    subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: ({ db }) => db.table(name).get() }), {}, {
      onData: snapshot => { snapshots.push(snapshot.data) }, onError: error => { throw error },
    })
    const result = await DB.transaction(async tx => {
      await tx.executeCompiled({ sql: `SET LOCAL ROLE ${name}`, source: 'schema' })
      return tx.table(table).insert({ tenant_id: 'tenant-a', secret: 'private' })
    })
    expect(result.affectedRows).toBe(1)
    await expect(DB.transaction(async tx => {
      await tx.executeCompiled({ sql: `SET LOCAL ROLE ${name}`, source: 'schema' })
      return tx.table(table).insertOrIgnore({ tenant_id: 'tenant-a', secret: 'unchanged' })
    })).resolves.toMatchObject({ affectedRows: 0 })
    await expect(DB.transaction(async tx => {
      await tx.executeCompiled({ sql: `SET LOCAL ROLE ${name}`, source: 'schema' })
      return tx.table(table).get()
    })).rejects.toThrow('permission denied')
    await expect(owner.table(name).get()).resolves.toEqual([{ tenant_id: 'tenant-a', secret: 'private' }])
    expect(snapshots.at(-1)).toEqual([{ tenant_id: 'tenant-a', secret: 'private' }])
    await owner.executeCompiled({ sql: `GRANT SELECT (tenant_id) ON ${name} TO ${name}; CREATE POLICY read_id ON ${name} FOR SELECT TO ${name} USING (true)`, source: 'schema' })
    const id = await DB.transaction(async tx => {
      await tx.executeCompiled({ sql: `SET LOCAL ROLE ${name}`, source: 'schema' })
      return tx.table(table).insertGetId({ tenant_id: 'tenant-b', secret: 'still private' })
    })
    expect(id).toBe('tenant-b')
    await expect(DB.transaction(async tx => {
      await tx.executeCompiled({ sql: `SET LOCAL ROLE ${name}`, source: 'schema' })
      return tx.table(table).get()
    })).rejects.toThrow('permission denied')
    await owner.executeCompiled({ sql: `GRANT SELECT ON ${name} TO ${name}; ALTER POLICY read_id ON ${name} USING (false)`, source: 'schema' })
    await expect(DB.transaction(async tx => {
      await tx.executeCompiled({ sql: `SET LOCAL ROLE ${name}`, source: 'schema' })
      return tx.table(table).insert({ tenant_id: 'tenant-c', secret: 'hidden by RLS' })
    })).resolves.toMatchObject({ affectedRows: 1 })
    await expect(DB.transaction(async tx => {
      await tx.executeCompiled({ sql: `SET LOCAL ROLE ${name}`, source: 'schema' })
      return tx.table(table).get()
    })).resolves.toEqual([])
  } finally {
    subscription?.unsubscribe()
    resetRealtimeRuntime()
    resetDB()
    await owner.executeCompiled({ sql: `DROP TABLE IF EXISTS ${name}; DROP ROLE IF EXISTS ${name}`, source: 'schema' })
    await owner.disconnect()
  }
}, 20000)
