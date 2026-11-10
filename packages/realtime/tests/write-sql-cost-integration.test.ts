import { column, defineGeneratedTable, resetDB, resetDatabaseDependencyInvalidationListeners } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const modes = [
  ...integrationDrivers(['sqlite', 'postgres', 'mysql'] as const).map(driver => ({ driver, returning: driver !== 'mysql' })),
  { driver: 'sqlite' as const, returning: false },
]

describe.each(modes)('write SQL cost on $driver (returning: $returning)', ({ driver, returning }) => {
  it.each([false, true])('does not capture unread rows with a related subscription: %s', async (related) => {
    const statements: string[] = []
    const { db, table, schema } = await openDatabase(driver, {
      wrapAdapter(adapter) {
        const query = adapter.query.bind(adapter)
        const execute = adapter.execute.bind(adapter)
        const begin = adapter.beginTransaction.bind(adapter)
        const commit = adapter.commit.bind(adapter)
        adapter.query = (sql, bindings) => { statements.push(sql); return query(sql, bindings) }
        adapter.execute = (sql, bindings) => { statements.push(sql); return execute(sql, bindings) }
        adapter.beginTransaction = (options) => { statements.push('BEGIN'); return begin(options) }
        adapter.commit = (options) => { statements.push('COMMIT'); return commit(options) }
        return adapter
      },
    })
    db.getCapabilities().returning = returning
    const items = defineGeneratedTable(`${table.tableName}_items`, { id: column.integer().primaryKey(), amount: column.integer() })
    await schema.createTable(items.tableName, builder => { builder.integer('id').primaryKey(); builder.integer('amount') })
    onTestFinished(async () => {
      resetRealtimeRuntime()
      resetDatabaseDependencyInvalidationListeners()
      resetDB()
      await schema.dropTable(items.tableName)
    })
    await db.table(items).insert({ id: 1, amount: 1 })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({
      access: 'public',
      handler: async () => related ? await db.table(items).orderBy('id').get() : await db.table(table).get(),
    }), {}, { onData: () => {}, onError: error => { throw error } })
    const quote = db.getDialect().quoteIdentifier
    const target = quote(items.tableName)
    const parameter = driver === 'postgres' ? (index: number) => `$${index}` : () => '?'
    const update = `UPDATE ${target} SET ${quote('amount')} = ${parameter(1)} WHERE ${quote('id')} = ${parameter(2)}`
    const deletion = `DELETE FROM ${target} WHERE ${quote('id')} = ${parameter(1)}`
    const refresh = `SELECT * FROM ${target} ORDER BY ${quote('id')} ASC`
    const captured: Record<string, string[]> = {}
    for (const [kind, write] of [
      ['insert', () => db.table(items).insert({ id: 2, amount: 1 })],
      ['update', () => db.table(items).where('id', 1).update({ amount: 2 })],
      ['upsert', () => db.table(items).upsert({ id: 2, amount: 2 }, ['id'], ['amount'])],
      ['delete', () => db.table(items).where('id', 1).delete()],
    ] as const) {
      statements.length = 0
      await write()
      captured[kind] = [...statements]
    }
    const insertStatements = driver === 'postgres' ? 3 : driver === 'mysql' ? related ? 3 : 5 : (returning ? 1 : 2) + Number(related)
    expect.soft(captured.insert).toHaveLength(insertStatements)
    expect.soft(captured.upsert).toHaveLength((returning ? 1 : 2) + Number(related))
    expect.soft(captured.update).toEqual(related ? [update, refresh] : [update])
    expect.soft(captured.delete).toEqual(related ? [deletion, refresh] : [deletion])
    if (related) expect(subscription.current.data).toEqual([{ id: 2, amount: 2 }])
  })
})
