import { randomUUID } from 'node:crypto'
import { configureDB, createConnectionManager, createDatabase, createDialect, resetDB, resetDatabaseDependencyInvalidationListeners, type DriverAdapter } from '@holo-js/db'
import { createMySQLAdapter } from '../../db-mysql/src'
import { createPostgresAdapter } from '../../db-postgres/src'
import { createSQLiteAdapter } from '../../db-sqlite/src'
import { integrationDrivers, mysqlTestConnection, postgresTestConnection, type TestDriver } from '../../../tests/support/real-database'
import { describe, expect, it, onTestFinished } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

function createAdapter(driver: TestDriver): DriverAdapter {
  if (driver === 'sqlite') {
    return createSQLiteAdapter({ filename: ':memory:' })
  }

  if (driver === 'postgres') {
    return createPostgresAdapter({ config: postgresTestConnection() })
  }

  return createMySQLAdapter({ config: mysqlTestConnection() })
}

async function createPosts(driver: TestDriver) {
  const adapter = createAdapter(driver)
  const tableName = `posts_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const db = createDatabase({ adapter, dialect: createDialect(driver), connectionName: 'main' })
  await adapter.initialize()
  onTestFinished(async () => {
    resetRealtimeRuntime()
    resetDatabaseDependencyInvalidationListeners()
    resetDB()
    await adapter.execute(`DROP TABLE IF EXISTS ${tableName}`)
    await adapter.disconnect()
  })
  await adapter.execute(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, title VARCHAR(64) NOT NULL)`)
  await adapter.execute(`INSERT INTO ${tableName} (id, title) VALUES (1, 'First'), (2, 'Second')`)
  configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { adapter, tableName }
}

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('a first() subscription on %s', (driver) => {
  it.each([
    ['ordered by id', true],
    ['without an order', false],
  ] as const)('%s follows deletes of its loaded row to a fresh read', async (_label, ordered) => {
    const { tableName } = await createPosts(driver)
    const snapshots: unknown[] = []
    const query = defineRealtimeQuery({ access: 'public', handler: async ({ db }) => {
      const posts = db.table(tableName).select('id', 'title')
      return await (ordered ? posts.orderBy('id') : posts).first()
    } })
    await subscribeRealtimeQuery(query, {}, { onData: (snapshot) => { snapshots.push(snapshot.data) }, onError: (error) => { throw error } })
    const deleteLoadedRow = () => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: async ({ db }) => {
      const loaded = snapshots.at(-1) as { id: number }
      await db.table(tableName).where('id', loaded.id).delete()
    } }))

    const initial = snapshots[0] as { id: number }
    const remaining = initial.id === 1 ? { id: 2, title: 'Second' } : { id: 1, title: 'First' }
    expect(snapshots).toEqual([{ id: initial.id, title: initial.id === 1 ? 'First' : 'Second' }])
    await deleteLoadedRow()
    expect(snapshots).toEqual([snapshots[0], remaining])

    await deleteLoadedRow()
    expect(snapshots).toEqual([snapshots[0], remaining, undefined])
  })

  it('follows an update that moves its loaded row out of the filter to a fresh read', async () => {
    const { adapter, tableName } = await createPosts(driver)
    await adapter.execute(`UPDATE ${tableName} SET title = 'Open'`)
    const snapshots: unknown[] = []
    const query = defineRealtimeQuery({ access: 'public', handler: async ({ db }) => {
      return await db.table(tableName).select('id', 'title').where('title', 'Open').orderBy('id').first()
    } })
    await subscribeRealtimeQuery(query, {}, { onData: (snapshot) => { snapshots.push(snapshot.data) }, onError: (error) => { throw error } })
    const closeRow = (id: number) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: async ({ db }) => {
      await db.table(tableName).where('id', id).update({ title: 'Closed' })
    } }))

    await closeRow(1)
    await closeRow(2)
    expect(snapshots).toEqual([{ id: 1, title: 'Open' }, { id: 2, title: 'Open' }, undefined])
  })
})
