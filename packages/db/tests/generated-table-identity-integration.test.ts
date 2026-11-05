import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, clearGeneratedTables, column, defineGeneratedTable, registerGeneratedTables } from '../src'
import { integrationDrivers, openDatabase, tableSpellings } from './support/database'
import type { TestDriver as Driver } from '../../../tests/support/real-database'

const itemColumns = {
  id: column.integer().primaryKey(),
  name: column.string(),
  active: column.boolean(),
  settings: column.json().nullable(),
  amount: column.decimal(),
}

const storedJson = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value

async function openRegisteredItems(driver: Driver, register: 'bare' | 'qualified') {
  const { table, schema } = await openDatabase(driver)
  await schema.table(table.tableName, (columns) => {
    columns.decimal('amount').default('0')
  })
  const spellings = tableSpellings(driver, table.tableName)
  const items = defineGeneratedTable(spellings[register], itemColumns)
  registerGeneratedTables({ items })
  onTestFinished(() => clearGeneratedTables())
  return { ...spellings, items, schema }
}

async function openOrders(schema: Awaited<ReturnType<typeof openDatabase>>['schema'], bare: string) {
  const ordersName = `${bare}_orders`
  await schema.createTable(ordersName, (table) => {
    table.integer('id').primaryKey()
    table.integer('item_id')
  })
  onTestFinished(() => schema.dropTable(ordersName))
  const orders = defineGeneratedTable(ordersName, { id: column.integer().primaryKey(), item_id: column.integer() })
  await DB.table(orders).insert({ id: 1, item_id: 1 })
  return { orders, ordersName }
}

for (const driver of integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)) {
  describe(`${driver} generated table identity`, () => {
    it('writes through the qualified spelling with the definition registered by the unqualified name', async () => {
      const { qualified, items } = await openRegisteredItems(driver, 'bare')

      await DB.table(qualified).insert({ id: 1, name: 'first', active: true, settings: { theme: 'dark' } })
      await DB.table(qualified).where('id', 1).update({ settings: { theme: 'light' } })

      expect(storedJson(await DB.table(items).where('id', 1).value('settings'))).toEqual({ theme: 'light' })
    })

    it('writes through the unqualified spelling with the definition registered by the qualified name', async () => {
      const { bare, items } = await openRegisteredItems(driver, 'qualified')

      await DB.table(bare).insert({ id: 1, name: 'first', active: true, settings: { theme: 'dark' } })
      await DB.table(bare).where('id', 1).update({ settings: { theme: 'light' } })

      expect(storedJson(await DB.table(items).where('id', 1).value('settings'))).toEqual({ theme: 'light' })
    })

    it('converts columns of a table joined by the other spelling of its registered name', async () => {
      const { bare, qualified, items, schema } = await openRegisteredItems(driver, 'bare')
      await DB.table(items).insert({ id: 1, name: 'first', active: true, settings: null, amount: '12.30' })
      const { orders, ordersName } = await openOrders(schema, bare)

      expect(await DB.table(orders)
        .join(qualified, `${ordersName}.item_id` as never, '=', `${bare}.id` as never)
        .select(`${bare}.amount` as never)
        .first()).toEqual({ amount: '12.30' })
    })
  })
}

describe('sqlite generated table identity across attached schemas', () => {
  it('writes to an attached table SQLite resolves the registered unqualified name to', async () => {
    const { db } = await openDatabase('sqlite')
    await db.getAdapter().execute(`ATTACH DATABASE ':memory:' AS "aux"`)
    await db.getAdapter().execute('CREATE TABLE "aux"."ledgers" ("id" INTEGER PRIMARY KEY, "active" INTEGER NOT NULL, "settings" TEXT)')
    const ledgers = defineGeneratedTable('ledgers', { id: column.integer().primaryKey(), active: column.boolean(), settings: column.json().nullable() })
    registerGeneratedTables({ ledgers })
    onTestFinished(() => clearGeneratedTables())

    await DB.table('aux.ledgers').insert({ id: 1, active: true, settings: { theme: 'dark' } })

    expect(storedJson(await DB.table(ledgers).where('id', 1).value('settings'))).toEqual({ theme: 'dark' })
  })
})
