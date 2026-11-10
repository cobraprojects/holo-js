import { createSchemaService, onDatabaseDependencyInvalidated, resetDB, resetDatabaseDependencyInvalidationListeners, type DatabaseContext } from '@holo-js/db'
import cache, { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase, tableSpellings } from '../../db/tests/support/database'
import { defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const modes = [
  ...integrationDrivers(['sqlite', 'postgres', 'mysql'] as const).map(driver => ({ driver, returning: driver !== 'mysql' })),
  { driver: 'sqlite' as const, returning: false },
]

describe.each(modes)('raw write invalidation on $driver (returning: $returning)', ({ driver, returning }) => {
  async function fixture() {
    const { db, table } = await openDatabase(driver, { security: { allowUnsafeRawSql: true } })
    db.getCapabilities().returning = returning
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    onTestFinished(() => {
      resetRealtimeRuntime()
      resetDatabaseDependencyInvalidationListeners()
      resetCacheRuntime()
      resetDB()
    })
    await db.table(table).insert({ id: 1, name: 'initial', active: true })
    const read = () => db.table(table).where('active', true).orderBy('id').get()
    const cached = () => db.table(table).where('active', true).orderBy('id').cache({ key: 'raw.active', ttl: 60 }).get()
    const row = (id: number) => db.table(table).where('id', id).cache(60).first()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: cached }), {}, { onData: () => {}, onError: error => { throw error } })
    const initial = await cached()
    const initialRow = await row(1)
    await row(2)
    const events: unknown[] = []
    onDatabaseDependencyInvalidated(event => { events.push(event) })
    const quote = db.getDialect().quoteIdentifier
    const { qualified, bare } = tableSpellings(driver, table.tableName)
    const target = qualified.split('.').map(part => quote(part)).join('.')
    const parameter = driver === 'postgres' ? (index: number) => `$${index}` : () => '?'
    const sql = {
      update: `/* raw write */ UPDATE ${target} SET ${quote('active')} = ${parameter(1)} WHERE ${quote('id')} = 1`,
      delete: `DELETE FROM ${quote(bare)} WHERE ${quote('id')} = 1`,
      insert: `INSERT INTO ${target} (${quote('id')}, ${quote('name')}, ${quote('active')}) VALUES (2, 'inserted', ${parameter(1)})`,
    }
    const bindings = (active: boolean) => [driver === 'postgres' ? active : Number(active)]
    const opaqueUpdate = {
      sql: `WITH chosen AS (SELECT 1 AS id) ${sql.update.replace('/* raw write */ ', '')} AND id IN (SELECT id FROM chosen)`,
      bindings: bindings(false), unsafe: true as const,
    }
    const write = (connection: DatabaseContext, kind: keyof typeof sql, scoped: boolean) => {
      const statement = { sql: sql[kind], bindings: kind === 'delete' ? [] : bindings(kind === 'insert'), unsafe: true as const }
      return scoped ? connection.table(table).unsafeExecute(statement) : connection.unsafeExecute(statement)
    }
    const expectFresh = async () => {
      const fresh = await read()
      expect.soft(subscription.current.data).toEqual(fresh)
      expect.soft(await cached()).toEqual(fresh)
      for (const id of [1, 2]) expect.soft(await row(id)).toEqual(await db.table(table).where('id', id).first())
    }
    return { db, table, sql, bindings, opaqueUpdate, write, read, cached, row, subscription, initial, initialRow, events, expectFresh }
  }

  it.each((['update', 'delete', 'insert'] as const).flatMap(kind => [true, false].map(scoped => ({ kind, scoped }))))('refreshes cached handlers and exact-row reads after $kind (scoped: $scoped)', async ({ kind, scoped }) => {
    const f = await fixture()
    await f.write(f.db, kind, scoped)
    expect.soft(f.events).toHaveLength(1)
    await f.expectFresh()
  })

  it.each(['update', 'delete', 'insert'] as const)('publishes raw %s only after commit and discards it on rollback', async kind => {
    const f = await fixture()
    const primed = await cache.get('raw.active')
    const writeInTransaction = async (rollback: boolean) => f.db.transaction(async tx => {
      await f.write(tx, kind, false)
      expect(f.events).toEqual([])
      expect(f.subscription.current.data).toEqual(f.initial)
      expect(await cache.get('raw.active')).toEqual(primed)
      if (rollback) throw new Error('rollback raw write')
    })
    await expect(writeInTransaction(true)).rejects.toThrow('rollback raw write')
    expect(f.events).toEqual([])
    await f.expectFresh()
    expect(await f.row(1)).toEqual(f.initialRow)
    await writeInTransaction(false)
    expect(f.events).toHaveLength(1)
    await f.expectFresh()
  })

  it('does not publish a failed raw write', async () => {
    const f = await fixture()
    await expect(f.db.table(f.table).unsafeExecute({ sql: f.sql.insert.replace("(2, 'inserted'", "(1, 'inserted'"), bindings: f.bindings(true), unsafe: true })).rejects.toThrow()
    expect(f.events).toEqual([])
    expect(f.subscription.current.data).toEqual(f.initial)
    await f.expectFresh()
  })

  it.each([false, true])('leaves opaque CTE writes untracked even with a table label (scoped: %s)', async scoped => {
    const f = await fixture()
    const statement = {
      ...f.opaqueUpdate, source: `table:${f.table.tableName}`,
    }
    if (scoped) await f.db.table(f.table).unsafeExecute(statement)
    else await f.db.unsafeExecute(statement)
    expect(await f.read()).toEqual([])
    expect(f.events).toEqual([])
    expect(await f.cached()).toEqual(f.initial)
    expect(f.subscription.current.data).toEqual(f.initial)
  })

  it('explicitly refreshes opaque writes, including cached exact rows and handlers', async () => {
    const f = await fixture()
    await f.db.unsafeExecute(f.opaqueUpdate)
    expect(await f.cached()).toEqual(f.initial)
    expect(f.events).toEqual([])
    const { bare, qualified } = tableSpellings(driver, f.table.tableName)
    await f.db.invalidateTables([bare, qualified, bare])
    expect(f.events).toHaveLength(1)
    expect(f.events[0]).toMatchObject({ dependencies: [expect.any(String), expect.any(String)], mutations: [] })
    await f.expectFresh()
  })

  it('defers explicit invalidation until commit and discards it on rollback', async () => {
    const f = await fixture()
    const primed = await cache.get('raw.active')
    const invalidateInTransaction = (rollback: boolean) => f.db.transaction(async tx => {
      await tx.unsafeExecute(f.opaqueUpdate)
      await tx.invalidateTables([f.table.tableName])
      expect(f.events).toEqual([])
      expect(f.subscription.current.data).toEqual(f.initial)
      expect(await cache.get('raw.active')).toEqual(primed)
      if (rollback) throw new Error('rollback explicit invalidation')
    })
    await expect(invalidateInTransaction(true)).rejects.toThrow('rollback explicit invalidation')
    expect(f.events).toEqual([])
    await f.expectFresh()
    await invalidateInTransaction(false)
    expect(f.events).toHaveLength(1)
    await f.expectFresh()
  })

  it('invalidates multiple tables in one publication and can publish without a write', async () => {
    const f = await fixture()
    const second = `${f.table.tableName}_second`
    const schema = createSchemaService(f.db)
    await schema.createTable(second, table => { table.integer('id').primaryKey() })
    try {
      await f.db.table(second).insert({ id: 1 })
      const secondRead = () => f.db.table(second).cache(60).get()
      expect(await secondRead()).toEqual([{ id: 1 }])
      const secondSubscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: secondRead }), {}, { onData: () => {}, onError: error => { throw error } })
      f.events.length = 0
      await f.db.unsafeExecute(f.opaqueUpdate)
      const target = second.split('.').map(f.db.getDialect().quoteIdentifier).join('.')
      await f.db.unsafeExecute({ sql: `WITH chosen AS (SELECT 1 AS id) UPDATE ${target} SET id = 2 WHERE id IN (SELECT id FROM chosen)`, unsafe: true })
      expect(await secondRead()).toEqual([{ id: 1 }])
      expect(f.events).toEqual([])
      const names = [f.table.tableName, second]
      await f.db.invalidateTables(names)
      expect(f.events).toHaveLength(1)
      expect(f.events[0]).toMatchObject({ dependencies: Array.from({ length: 4 }, () => expect.any(String)), mutations: [] })
      await f.expectFresh()
      expect(await secondRead()).toEqual([{ id: 2 }])
      expect(secondSubscription.current.data).toEqual(await f.db.table(second).get())
      await f.db.invalidateTables(names)
      expect(f.events).toHaveLength(2)
    } finally {
      await schema.dropTable(second)
    }
  })

  it('does nothing for an empty table list', async () => {
    const f = await fixture()
    const primed = await cache.get('raw.active')
    await f.db.invalidateTables([])
    await f.db.transaction(async tx => { await tx.invalidateTables([]) })
    expect(f.events).toEqual([])
    expect(await cache.get('raw.active')).toEqual(primed)
    expect(f.subscription.current.data).toEqual(f.initial)
  })

  it('does not treat read-only SQL or logging labels as writes', async () => {
    const f = await fixture()
    await f.db.table(f.table).unsafeQuery({ sql: "SELECT 'UPDATE ignored SET value = 1' AS statement", unsafe: true })
    await f.db.unsafeExecute({ sql: "SELECT 'DELETE FROM ignored' AS statement", unsafe: true, source: `table:${f.table.tableName}` })
    expect(f.events).toEqual([])
    await f.expectFresh()
  })

  it.runIf(returning)('refreshes after raw DML returning rows through unsafeQuery', async () => {
    const f = await fixture()
    await f.db.unsafeQuery({ sql: `${f.sql.update} RETURNING id`, bindings: f.bindings(false), unsafe: true })
    expect(f.events).toHaveLength(1)
    await f.expectFresh()
  })

  it('uses the SQL target instead of the table scope or logging label', async () => {
    const f = await fixture()
    await f.db.table('unrelated_scope').unsafeExecute({ sql: f.sql.update, bindings: f.bindings(false), unsafe: true })
    expect(f.events).toHaveLength(1)
    await f.expectFresh()
  })

  it('resolves unquoted identifier casing using the SQL dialect', async () => {
    const f = await fixture()
    const bare = f.table.tableName.split('.').at(-1)!
    const target = driver === 'postgres' || driver === 'sqlite' ? bare.toUpperCase() : bare
    await f.db.unsafeExecute({ sql: `UPDATE ${target} SET active = ${driver === 'postgres' ? '$1' : '?'} WHERE id = 1`, bindings: f.bindings(false), unsafe: true })
    await f.expectFresh()
  })

  it.runIf(driver === 'postgres')('does not infer a write target from a nested leading comment', async () => {
    const f = await fixture()
    await f.db.unsafeExecute({
      sql: `/* outer /* nested */ UPDATE unrelated_scope SET active = false */ ${f.sql.update}`,
      bindings: f.bindings(false), unsafe: true,
    })
    expect(await f.read()).toEqual([])
    expect(f.events).toEqual([])
    expect(await f.cached()).toEqual(f.initial)
    expect(f.subscription.current.data).toEqual(f.initial)
  })
})
