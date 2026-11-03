import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { DB, configureDB, createConnectionManager, createDatabase, createDialect, createSchemaService, defineModel, resetDB } from '../src'

async function openAnalytics(columnName: string) {
  const defaultAdapter = createSQLiteAdapter({ filename: ':memory:' })
  const analyticsAdapter = createSQLiteAdapter({ filename: ':memory:' })
  await analyticsAdapter.initialize()
  onTestFinished(() => defaultAdapter.disconnect())
  onTestFinished(() => analyticsAdapter.disconnect())
  const db = createDatabase({ adapter: defaultAdapter, dialect: createDialect('sqlite') })
  const analytics = createDatabase({ connectionName: 'analytics', adapter: analyticsAdapter, dialect: createDialect('sqlite') })
  await createSchemaService(analytics).createTable('events', (table) => {
    table.id()
    table.string(columnName).nullable()
    table.string('admin').nullable()
  })
  return { db, analytics }
}

function configureAnalytics({ db, analytics }: Awaited<ReturnType<typeof openAnalytics>>) {
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db, analytics } }))
}

const Event = defineModel('events', { connectionName: 'analytics', guarded: ['admin'], timestamps: false })

describe('guarded model column listing', () => {
  afterEach(() => {
    resetDB()
  })

  it('reads the columns of the database a reconfigured connection now points at', async () => {
    const first = await openAnalytics('title')
    const second = await openAnalytics('label')
    configureAnalytics(first)
    expect((await Event.create({ title: 'first' })).get('title')).toBe('first')

    resetDB()
    configureAnalytics(second)

    expect((await Event.create({ label: 'second' })).get('label')).toBe('second')
    await expect(Event.create({ title: 'stale' })).rejects.toThrow('Column "title" is not writable')
  })

  it('refreshes the listing after a schema change made inside a transaction', async () => {
    const connections = await openAnalytics('title')
    configureAnalytics(connections)
    await expect(Event.create({ summary: 'early' })).rejects.toThrow('Column "summary" is not writable')

    await DB.transaction(async (transaction) => {
      await createSchemaService(transaction).table('events', (table) => {
        table.string('summary').nullable()
      })
      expect((await Event.create({ summary: 'inside' })).get('summary')).toBe('inside')
    }, 'analytics')

    expect((await Event.create({ summary: 'after' })).get('summary')).toBe('after')
    await createSchemaService(connections.analytics).table('events', (table) => {
      table.dropColumn('summary')
    })
    await expect(Event.create({ summary: 'gone' })).rejects.toThrow('Column "summary" is not writable')
  })
})
