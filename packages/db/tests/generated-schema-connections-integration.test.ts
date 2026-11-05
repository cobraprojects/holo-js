import { randomUUID } from 'node:crypto'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { DB, belongsToMany, clearGeneratedTables, column, configureDB, createConnectionManager, createDatabase, createDialect, defineGeneratedTable, defineModel, registerGeneratedTables, resetDB } from '../src'
import { openDatabase } from './support/database'

async function openConnections() {
  const { db, schema } = await openDatabase('postgres')
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const names = { users: `conn_users_${suffix}`, events: `conn_events_${suffix}`, roles: `conn_roles_${suffix}`, memberships: `conn_memberships_${suffix}` }
  onTestFinished(async () => {
    for (const name of [names.memberships, names.events, names.users]) if (await schema.hasTable(name)) await schema.dropTable(name)
  })
  await schema.createTable(names.users, (table) => {
    table.integer('id').primaryKey()
    table.boolean('active')
  })
  await schema.createTable(names.events, (table) => {
    table.uuid('code').primaryKey()
  })
  await schema.createTable(names.memberships, (table) => {
    table.integer('user_id')
    table.integer('role_id')
    table.boolean('active')
  })
  registerGeneratedTables({
    users: defineGeneratedTable(names.users, { id: column.integer().primaryKey(), active: column.boolean() }),
    events: defineGeneratedTable(names.events, { code: column.uuid().primaryKey() }),
    memberships: defineGeneratedTable(names.memberships, { user_id: column.integer(), role_id: column.integer(), active: column.boolean() }),
  })

  const analyticsAdapter = createSQLiteAdapter({ filename: ':memory:' })
  await analyticsAdapter.initialize()
  await analyticsAdapter.execute(`CREATE TABLE ${names.users} (id INTEGER PRIMARY KEY, active TEXT)`)
  await analyticsAdapter.execute(`CREATE TABLE ${names.events} (id INTEGER PRIMARY KEY)`)
  await analyticsAdapter.execute(`CREATE TABLE ${names.roles} (id INTEGER PRIMARY KEY)`)
  await analyticsAdapter.execute(`CREATE TABLE ${names.memberships} (user_id INTEGER NOT NULL, role_id INTEGER NOT NULL, active TEXT)`)
  const analytics = createDatabase({ connectionName: 'analytics', adapter: analyticsAdapter, dialect: createDialect('sqlite') })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db, analytics } }))
  return { names, analyticsAdapter }
}

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('Generated schema on a connection other than the default', () => {
  afterEach(() => {
    resetDB()
    clearGeneratedTables()
  })

  it('writes the raw value to a same-named table on another connection', async () => {
    const { names, analyticsAdapter } = await openConnections()
    try {
      await DB.table(names.users, 'analytics').insert({ id: 1, active: 'yes' })

      expect(await DB.table(names.users, 'analytics').value('active')).toBe('yes')
    } finally {
      await analyticsAdapter.disconnect()
    }
  })

  it('cursor-paginates a same-named table on another connection by its own columns', async () => {
    const { names, analyticsAdapter } = await openConnections()
    try {
      await DB.table(names.events, 'analytics').insert([{ id: 1 }, { id: 2 }, { id: 3 }])

      const first = await DB.table(names.events, 'analytics').orderBy('id').cursorPaginate(2)
      const second = await DB.table(names.events, 'analytics').orderBy('id').cursorPaginate(2, first.nextCursor)

      expect([...first.data, ...second.data].map(row => row.id)).toEqual([1, 2, 3])
    } finally {
      await analyticsAdapter.disconnect()
    }
  })

  it('writes raw pivot values for a model on another connection', async () => {
    const { names, analyticsAdapter } = await openConnections()
    try {
      const Role = defineModel(defineGeneratedTable(names.roles, { id: column.id() }), { timestamps: false, connectionName: 'analytics' })
      const User = defineModel(defineGeneratedTable(names.users, { id: column.id(), active: column.text() }), {
        timestamps: false,
        fillable: ['active'],
        connectionName: 'analytics',
        relations: { roles: belongsToMany(() => Role, names.memberships, 'user_id', 'role_id').withPivot('active') },
      })
      await DB.table(names.roles, 'analytics').insert({ id: 7 })
      const user = await User.create({ active: 'no' })

      await user.attach('roles', 7, { active: 'yes' })

      expect(await DB.table(names.memberships, 'analytics').value('active')).toBe('yes')
    } finally {
      await analyticsAdapter.disconnect()
    }
  })
})
