import { randomUUID } from 'node:crypto'
import { clearGeneratedTables, column, configureDB, createConnectionManager, createDatabase, createDialect, defineGeneratedTable, defineModel, hasOne, resetDB, resetDatabaseDependencyInvalidationListeners, type DriverAdapter } from '@holo-js/db'
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
    clearGeneratedTables()
    await adapter.execute(`DROP TABLE IF EXISTS ${tableName}`)
    await adapter.execute(`DROP TABLE IF EXISTS ${tableName}_profiles`)
    await adapter.disconnect()
  })
  await adapter.execute(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, title VARCHAR(64) NOT NULL)`)
  await adapter.execute(`INSERT INTO ${tableName} (id, title) VALUES (1, 'First'), (2, 'Second')`)
  configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { adapter, db, tableName }
}

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('a first() subscription on %s', (driver) => {
  it.each([
    ['ordered by id', true],
    ['without an order', false],
  ] as const)('%s follows deletes of its loaded row to a fresh read', async (_label, ordered) => {
    const { tableName } = await createPosts(driver)
    const read = async (db: Parameters<Parameters<typeof defineRealtimeQuery>[0]['handler']>[0]['db']) => {
      const query = db.table(tableName).select('id', 'title')
      return await (ordered ? query.orderBy('id') : query).first()
    }
    const snapshots: unknown[] = []
    const query = defineRealtimeQuery({ access: 'public', handler: async ({ db }) => await read(db) })
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
})

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('a hasOne relation subscription on %s', (driver) => {
  it('follows deletes of its loaded related row to a fresh read', async () => {
    const { adapter, db, tableName } = await createPosts(driver)
    const profilesTable = `${tableName}_profiles`
    await adapter.execute(`CREATE TABLE ${profilesTable} (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL, bio VARCHAR(64) NOT NULL)`)
    await adapter.execute(`INSERT INTO ${profilesTable} (id, post_id, bio) VALUES (1, 1, 'One'), (2, 1, 'Two')`)
    const Profile = defineModel(defineGeneratedTable(profilesTable, { id: column.id(), post_id: column.integer(), bio: column.string() }), { timestamps: false })
    const Post = defineModel(defineGeneratedTable(tableName, { id: column.id(), title: column.string() }), {
      timestamps: false,
      relations: { profile: hasOne(() => Profile, 'post_id') },
    })
    const read = () => db.model(Post).query().with('profile').where('id', 1).getJson()
    const snapshots: unknown[] = []
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: read }), {}, { onData: (snapshot) => { snapshots.push(snapshot.data) }, onError: (error) => { throw error } })
    const deleteLoadedProfile = () => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: async () => {
      const [post] = snapshots.at(-1) as Array<{ profile: { id: number } }>
      await db.table(profilesTable).where('id', post!.profile.id).delete()
    } }))

    const [initial] = snapshots[0] as Array<{ profile: { id: number } }>
    await deleteLoadedProfile()
    expect(snapshots.at(-1)).toEqual([{ id: 1, title: 'First', profile: initial!.profile.id === 1 ? { id: 2, post_id: 1, bio: 'Two' } : { id: 1, post_id: 1, bio: 'One' } }])

    await deleteLoadedProfile()
    expect(snapshots.at(-1)).toEqual([{ id: 1, title: 'First', profile: null }])
    expect(snapshots).toHaveLength(3)
  })
})
