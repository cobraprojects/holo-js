import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPostgresAdapter } from '@holo-js/db-postgres'
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

type SharedDriver = 'sqlite' | 'postgres'

function createSharedAdapter(driver: SharedDriver, filename: string) {
  if (driver === 'sqlite') {
    return createSQLiteAdapter({ filename })
  }

  return createPostgresAdapter({ config: {
    host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
    port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
    user: process.env.HOLO_POSTGRES_USER ?? 'postgres',
    password: process.env.HOLO_POSTGRES_PASSWORD,
    database: process.env.HOLO_POSTGRES_DATABASE ?? 'postgres',
  } })
}

async function openSharedDatabase(driver: SharedDriver) {
  const directory = await mkdtemp(join(tmpdir(), 'holo-guarded-columns-'))
  const filename = join(directory, 'analytics.sqlite')
  await writeFile(filename, '')
  const analyticsAdapter = createSharedAdapter(driver, filename)
  const maintenanceAdapter = createSharedAdapter(driver, filename)
  const defaultAdapter = createSQLiteAdapter({ filename: ':memory:' })
  const analytics = createDatabase({ connectionName: 'analytics', adapter: analyticsAdapter, dialect: createDialect(driver) })
  const maintenance = createDatabase({ connectionName: 'maintenance', adapter: maintenanceAdapter, dialect: createDialect(driver) })
  const tableName = `events_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  onTestFinished(async () => {
    try {
      await createSchemaService(maintenance).dropTable(tableName)
    } finally {
      await Promise.all([analyticsAdapter.disconnect(), maintenanceAdapter.disconnect(), defaultAdapter.disconnect()])
      await rm(directory, { recursive: true, force: true })
    }
  })
  await createSchemaService(maintenance).createTable(tableName, (table) => {
    table.id()
    table.string('title').nullable()
    table.string('note').nullable()
    table.string('admin').nullable()
  })
  const db = createDatabase({ adapter: defaultAdapter, dialect: createDialect('sqlite') })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db, analytics } }))
  const SharedEvent = defineModel(tableName, { connectionName: 'analytics', name: 'Event', guarded: ['admin'], timestamps: false })
  return { tableName, maintenance, SharedEvent }
}

class RollbackRequested extends Error {}

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

  describe.each<SharedDriver>(['sqlite', 'postgres'])('on %s', (driver) => {
    const skip = driver === 'postgres' && process.env.HOLO_POSTGRES_INTEGRATION !== '1'

    it.skipIf(skip)('forgets columns a rolled-back transaction dropped', async () => {
      const { tableName, SharedEvent } = await openSharedDatabase(driver)
      expect((await SharedEvent.create({ title: 'before' })).get('title')).toBe('before')

      await expect(DB.transaction(async (transaction) => {
        await createSchemaService(transaction).table(tableName, (table) => {
          table.dropColumn('title')
        })
        await expect(SharedEvent.create({ title: 'inside' })).rejects.toThrow('Column "title" is not writable')
        await SharedEvent.create({ note: 'inside' })
        throw new RollbackRequested()
      }, 'analytics')).rejects.toThrow(RollbackRequested)

      expect((await SharedEvent.create({ title: 'after' })).get('title')).toBe('after')
    })

    it.skipIf(skip)('forgets columns a rolled-back savepoint dropped', async () => {
      const { tableName, SharedEvent } = await openSharedDatabase(driver)
      expect((await SharedEvent.create({ title: 'before' })).get('title')).toBe('before')

      await DB.transaction(async (transaction) => {
        await expect(transaction.transaction(async (savepoint) => {
          await createSchemaService(savepoint).table(tableName, (table) => {
            table.dropColumn('title')
          })
          await SharedEvent.create({ note: 'inside' })
          throw new RollbackRequested()
        })).rejects.toThrow(RollbackRequested)

        expect((await SharedEvent.create({ title: 'after' })).get('title')).toBe('after')
      }, 'analytics')
    })

    it.skipIf(skip)('sees a column another connection to the same database added', async () => {
      const { tableName, maintenance, SharedEvent } = await openSharedDatabase(driver)
      await expect(SharedEvent.create({ summary: 'before' })).rejects.toThrow('Column "summary" is not writable')

      await createSchemaService(maintenance).table(tableName, (table) => {
        table.string('summary').nullable()
      })

      expect((await SharedEvent.create({ summary: 'after' })).get('summary')).toBe('after')
    })
  })
})
