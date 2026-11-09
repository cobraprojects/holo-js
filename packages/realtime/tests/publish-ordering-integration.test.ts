import { randomUUID } from 'node:crypto'
import { configureDB, configureDatabaseQueryCacheBridge, createConnectionManager, createDatabase, createDialect, resetDB, resetDatabaseDependencyInvalidationListeners, resetDatabaseQueryCacheBridge, type DatabaseLogger, type DriverAdapter } from '@holo-js/db'
import { createMySQLAdapter } from '../../db-mysql/src'
import { createPostgresAdapter } from '../../db-postgres/src'
import { createSQLiteAdapter } from '../../db-sqlite/src'
import { integrationDrivers, mysqlTestConnection, postgresTestConnection } from '../../../tests/support/real-database'
import { createHeldPublicationBridge } from '../../db/tests/support/held-publication'
import { describe, expect, it, onTestFinished } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

type Driver = 'mysql' | 'postgres' | 'sqlite'

function createAdapter(driver: Driver): DriverAdapter {
  if (driver === 'sqlite') return createSQLiteAdapter({ filename: ':memory:' })
  return driver === 'postgres'
    ? createPostgresAdapter({ config: postgresTestConnection() })
    : createMySQLAdapter({ config: mysqlTestConnection() })
}

function holdScoreReads(statement: string) {
  let hold: { reached: () => void, release: Promise<void> } | undefined
  const logger: DatabaseLogger = {
    async onQuerySuccess(event) {
      const sql = event.sql
      const current = hold
      if (current && sql === statement) {
        hold = undefined
        current.reached()
        await current.release
      }
    },
  }
  const holdNextRead = async (write: () => Promise<unknown>) => {
    let reached!: () => void
    let release!: () => void
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve })
    hold = { reached, release: new Promise<void>((resolve) => { release = resolve }) }
    const pending = write()
    await Promise.race([
      reachedPromise,
      pending.then(() => { throw new Error('The write finished without reading scores.') }),
    ])
    return async () => {
      release()
      await pending
    }
  }
  return { logger, holdNextRead }
}

async function createItems(driver: Driver) {
  const adapter = createAdapter(driver)
  const otherAdapter = driver === 'sqlite' ? adapter : createAdapter(driver)
  const tableName = `items_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const reads = holdScoreReads(`SELECT * FROM ${createDialect(driver).quoteIdentifier(tableName)}`)
  const db = createDatabase({ adapter, dialect: createDialect(driver), connectionName: 'main', security: { debugSqlInLogs: true }, logger: reads.logger })
  const otherDb = driver === 'sqlite' ? db : createDatabase({ adapter: otherAdapter, dialect: createDialect(driver), connectionName: 'main' })
  await adapter.initialize()
  if (otherAdapter !== adapter) await otherAdapter.initialize()
  const publication = createHeldPublicationBridge()
  onTestFinished(async () => {
    resetRealtimeRuntime()
    resetDatabaseDependencyInvalidationListeners()
    resetDatabaseQueryCacheBridge()
    resetDB()
    await adapter.execute(`DROP TABLE IF EXISTS ${tableName}`)
    await adapter.disconnect()
    if (otherAdapter !== adapter) await otherAdapter.disconnect()
  })
  await adapter.execute(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, label VARCHAR(64) NOT NULL, score INTEGER DEFAULT 0)`)
  await adapter.execute(`INSERT INTO ${tableName} (id, label, score) VALUES (1, 'initial', 10), (2, 'other', 20)`)
  configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  configureDatabaseQueryCacheBridge(publication.bridge)

  const normalize = (rows: readonly Readonly<Record<string, unknown>>[]) => rows.map(row => ({ id: Number(row.id), label: row.label }))
  const read = async () => normalize(await db.table(tableName).orderBy('id').get())
  let queryRuns = 0
  const subscribe = async () => {
    const snapshots: unknown[] = []
    const query = defineRealtimeQuery({ access: 'public', handler: ({ db }) => {
      queryRuns += 1
      return db.table(tableName).orderBy('id').get()
    } })
    await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push(normalize(snapshot.data as readonly Readonly<Record<string, unknown>>[])) }, onError: (error) => { throw error } })
    return snapshots
  }
  const readTotal = async () => Number(await db.table(tableName).sum('score'))
  const readAverage = async () => Number(await db.table(tableName).avg('score'))
  const subscribeAggregate = async (aggregate: 'avg' | 'sum') => {
    const snapshots: number[] = []
    const query = defineRealtimeQuery({ access: 'public', handler: ({ db }) => aggregate === 'avg' ? db.table(tableName).avg('score') : db.table(tableName).sum('score') })
    await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push(Number(snapshot.data)) }, onError: (error) => { throw error } })
    return snapshots
  }
  const subscribeTotal = () => subscribeAggregate('sum')
  const normalizeGroups = (rows: readonly Readonly<Record<string, unknown>>[]) => rows.map(row => ({ label: row.label, total: row.total === null ? null : Number(row.total) }))
  const readGroupedTotals = async () => normalizeGroups(await db.table(tableName).select('label').addSelectSum('total', 'score').groupBy('label').orderBy('label').get())
  const subscribeGroupedTotals = async () => {
    const snapshots: unknown[] = []
    const query = defineRealtimeQuery({ access: 'public', handler: ({ db }) => db.table(tableName).select('label').addSelectSum('total', 'score').groupBy('label').orderBy('label').get() })
    await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push(normalizeGroups(snapshot.data as readonly Readonly<Record<string, unknown>>[])) }, onError: (error) => { throw error } })
    return snapshots
  }
  const mutate = (handler: Parameters<typeof defineRealtimeMutation>[0]['handler']) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))

  return {
    commitFirstPublishLast: async (first: () => Promise<unknown>, second: () => Promise<unknown>) => {
      const finishFirst = await publication.heldWrite(first)
      await second()
      await finishFirst()
    },
    heldWrite: publication.heldWrite,
    holdNextScoreRead: reads.holdNextRead,
    queryRuns: () => queryRuns,
    read,
    readAverage,
    readTotal,
    insertScore: (id: number, score: number | null, label = 'scored') => mutate(({ db }) => db.table(tableName).insert({ id, label, score })),
    readGroupedTotals,
    scoreOrNull: (id: number, score: number | null) => mutate(({ db }) => db.table(tableName).where('id', id).update({ score })),
    subscribeGroupedTotals,
    removeRow: (id: number) => mutate(({ db }) => db.table(tableName).where('id', id).delete()),
    score: (id: number, score: number) => mutate(({ db }) => db.table(tableName).where('id', id).update({ score })),
    subscribe,
    subscribeAggregate,
    subscribeTotal,
    first: {
      insert: (id: number, label: string) => mutate(({ db }) => db.table(tableName).insert({ id, label })),
      update: (id: number, label: string) => mutate(({ db }) => db.table(tableName).where('id', id).update({ label })),
      updateInTransaction: (id: number, label: string) => db.transaction(async transaction => await transaction.table(tableName).where('id', id).update({ label })),
      upsert: (id: number, label: string) => mutate(({ db }) => db.table(tableName).upsert({ id, label }, ['id'], ['label'])),
    },
    second: {
      delete: (id: number) => otherDb.table(tableName).where('id', id).delete(),
      update: (id: number, label: string) => otherDb.table(tableName).where('id', id).update({ label }),
      upsert: (id: number, label: string) => otherDb.table(tableName).upsert({ id, label }, ['id'], ['label']),
    },
  }
}

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('%s publish ordering', (driver) => {
  it('does not apply a sum delta again when a re-run already read the held write', async () => {
    const items = await createItems(driver)
    const totals = await items.subscribeTotal()

    const finishA = await items.heldWrite(() => items.score(1, 11))
    const finishB = await items.heldWrite(() => items.score(2, 21))
    await items.score(2, 22)
    await finishB()
    await finishA()

    expect(await items.readTotal()).toBe(33)
    expect(totals.at(-1)).toBe(33)
  })

  it('does not apply an average delta again after a backfill that left the average unchanged read the held write', async () => {
    const items = await createItems(driver)
    const averages = await items.subscribeAggregate('avg')

    const finish = await items.heldWrite(() => items.insertScore(3, 15))
    await items.insertScore(4, null)
    await finish()
    await items.removeRow(1)

    expect(await items.readAverage()).toBe(17.5)
    expect(averages.at(-1)).toBe(17.5)
  })

  it('does not apply a grouped sum delta again after a backfill that left the group unchanged read the held write', async () => {
    const items = await createItems(driver)
    await items.first.update(2, 'initial')
    const totals = await items.subscribeGroupedTotals()

    const finish = await items.heldWrite(() => items.insertScore(3, 20, 'initial'))
    await items.scoreOrNull(2, null)
    await finish()

    expect(await items.readGroupedTotals()).toEqual([{ label: 'initial', total: 30 }])
    expect(totals.at(-1)).toEqual(await items.readGroupedTotals())
  })

  it('does not apply a sum delta again when a subscription started while the write was held', async () => {
    const items = await createItems(driver)
    await items.subscribe()

    const finish = await items.heldWrite(() => items.score(1, 11))
    const totals = await items.subscribeTotal()
    await finish()

    expect(await items.readTotal()).toBe(31)
    expect(totals.at(-1)).toBe(31)
  })

  it('converges to a fresh read when an earlier update publishes after a later one on another connection', async () => {
    const items = await createItems(driver)
    const snapshots = await items.subscribe()

    await items.commitFirstPublishLast(() => items.first.update(1, 'earlier'), () => items.second.update(1, 'later'))

    expect(await items.read()).toEqual([{ id: 1, label: 'later' }, { id: 2, label: 'other' }])
    expect(snapshots.at(-1)).toEqual(await items.read())
  })

  it('converges to a fresh read when an earlier update publishes after a later one through the same database', async () => {
    const items = await createItems(driver)
    const snapshots = await items.subscribe()

    await items.commitFirstPublishLast(() => items.first.update(1, 'earlier'), () => items.first.update(1, 'later'))

    expect(await items.read()).toEqual([{ id: 1, label: 'later' }, { id: 2, label: 'other' }])
    expect(snapshots.at(-1)).toEqual(await items.read())
  })

  it('converges to a fresh read when an earlier transaction publishes after a later update on another connection', async () => {
    const items = await createItems(driver)
    const snapshots = await items.subscribe()

    await items.commitFirstPublishLast(() => items.first.updateInTransaction(1, 'earlier'), () => items.second.update(1, 'later'))

    expect(await items.read()).toEqual([{ id: 1, label: 'later' }, { id: 2, label: 'other' }])
    expect(snapshots.at(-1)).toEqual(await items.read())
  })

  it('converges to a fresh read when an earlier upsert publishes after a later one on another connection', async () => {
    const items = await createItems(driver)
    const snapshots = await items.subscribe()

    await items.commitFirstPublishLast(() => items.first.upsert(1, 'earlier'), () => items.second.upsert(1, 'later'))

    expect(await items.read()).toEqual([{ id: 1, label: 'later' }, { id: 2, label: 'other' }])
    expect(snapshots.at(-1)).toEqual(await items.read())
  })

  it('converges to a fresh read when an insert publishes after a later delete of the same row on another connection', async () => {
    const items = await createItems(driver)
    const snapshots = await items.subscribe()

    await items.commitFirstPublishLast(() => items.first.insert(3, 'inserted'), () => items.second.delete(3))

    expect(await items.read()).toEqual([{ id: 1, label: 'initial' }, { id: 2, label: 'other' }])
    expect(snapshots.at(-1)).toEqual(await items.read())
  })

  it('still patches writes to other rows that overlap, and writes that do not overlap', async () => {
    const items = await createItems(driver)
    const snapshots = await items.subscribe()

    await items.commitFirstPublishLast(() => items.first.update(1, 'first'), () => items.first.update(2, 'second'))
    await items.first.update(1, 'third')

    expect(snapshots.at(-1)).toEqual([{ id: 1, label: 'third' }, { id: 2, label: 'second' }])
  })
})

describe.each(integrationDrivers(['postgres', 'mysql'] as const))('%s concurrent aggregate refreshes', (driver) => {
  it('does not let an older aggregate refresh overwrite a newer one', async () => {
    const items = await createItems(driver)
    const averages = await items.subscribeAggregate('avg')

    const finish = await items.holdNextScoreRead(() => items.insertScore(3, null))
    await items.insertScore(4, 15)
    await finish()
    await items.removeRow(1)

    expect(await items.readAverage()).toBe(17.5)
    expect(averages.at(-1)).toBe(17.5)
  })
})
