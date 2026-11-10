import { createDatabaseQueryObservation } from '../src/cache'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, clearGeneratedTables, column, defineModel, registerGeneratedTables } from '../src'
import { defineTable } from './support/internal'
import { openDatabase } from './support/database'

async function openTable(name: string, columns: Parameters<typeof defineTable>[1], options: Parameters<typeof defineTable>[2] = {}, ddl: string, driver: 'sqlite' | 'mysql' = 'sqlite') {
  const { adapter } = await openDatabase(driver)
  registerGeneratedTables({ [name]: defineTable(name, columns, options) })
  onTestFinished(() => clearGeneratedTables())
  await adapter.execute(ddl)
  return adapter
}

function observe(query: ReturnType<typeof DB.table>) {
  return createDatabaseQueryObservation(query.getPlan(), 'default', [])
}

describe('query observations carry the table primary key', () => {
  it('identifies rows of a table keyed on code by code', async () => {
    await openTable('countries', { code: column.string().primaryKey(), id: column.integer(), name: column.string() }, {}, 'CREATE TABLE countries (code TEXT PRIMARY KEY, id INTEGER, name TEXT)')
    await DB.table('countries').insert({ code: 'FR', id: 1, name: 'France' })

    const list = observe(DB.table('countries').orderBy('name'))
    const projected = observe(DB.table('countries').select('code', 'name').orderBy('name'))
    const projectedWithoutKey = observe(DB.table('countries').select('id', 'name').orderBy('name'))
    const detail = observe(DB.table('countries').select('name').where('code', 'FR').limit(1))
    await DB.table('countries').where('code', 'FR').update({ name: 'République' })

    expect([list, projected, projectedWithoutKey, detail].map(observation => observation?.primaryKey)).toEqual([
      'code',
      'code',
      'code',
      'code',
    ])
  })

  it('leaves composite-key and keyless table observations without a primary key', async () => {
    await openTable('seats', { id: column.integer(), row_no: column.integer().primaryKey(), seat_no: column.integer().primaryKey() }, {}, 'CREATE TABLE seats (id INTEGER, row_no INTEGER, seat_no INTEGER, PRIMARY KEY (row_no, seat_no))')
    await openTable('events', { id: column.integer(), name: column.string() }, { primaryKeyColumns: [] }, 'CREATE TABLE events (id INTEGER, name TEXT)')

    expect([observe(DB.table('seats')), observe(DB.table('events'))].map(observation => observation?.primaryKey)).toEqual([
      undefined,
      undefined,
    ])
  })

  it('identifies rows of a model query by the model primary key and of a DB.table() query by the schema key', async () => {
    const adapter = await openTable('ledger', { id: column.id(), entry_no: column.string(), amount: column.integer() }, {}, 'CREATE TABLE ledger (id INTEGER PRIMARY KEY, entry_no TEXT, amount INTEGER)')
    registerGeneratedTables({ seats: defineTable('seats', { row_no: column.integer().primaryKey(), seat_no: column.integer().primaryKey() }) })
    await adapter.execute('CREATE TABLE seats (row_no INTEGER, seat_no INTEGER, PRIMARY KEY (row_no, seat_no))')
    await DB.table('ledger').insert({ entry_no: 'A', amount: 10 })
    const Entry = defineModel('ledger', { timestamps: false, primaryKey: 'entry_no', fillable: ['amount'] })
    const Seat = defineModel('seats', { timestamps: false })

    const model = observe(Entry.query().getTableQueryBuilder())
    const table = observe(DB.table('ledger'))
    const composite = observe(Seat.query().getTableQueryBuilder())
    await Entry.query().where('entry_no', 'A').update({ amount: 11 })

    expect([model, table, composite].map(observation => observation?.primaryKey)).toEqual([
      'entry_no',
      'id',
      undefined,
    ])
  })

  it('increments a limited model query by the model primary key', async () => {
    await openTable('ledger', { id: column.id(), entry_no: column.string(), amount: column.integer() }, {}, 'CREATE TABLE ledger (id INTEGER PRIMARY KEY, entry_no TEXT, amount INTEGER)')
    await DB.table('ledger').insert([{ entry_no: 'B', amount: 20 }, { entry_no: 'A', amount: 10 }])
    const Entry = defineModel('ledger', { timestamps: false, primaryKey: 'entry_no', fillable: ['amount'] })

    await Entry.query().orderBy('entry_no').limit(1).increment('amount', 1)

    expect(await DB.table('ledger').orderBy('entry_no').get()).toEqual([
      { id: 2, entry_no: 'A', amount: 11 },
      { id: 1, entry_no: 'B', amount: 20 },
    ])
  })

  it('increments through from() a table that lacks the model primary key column', async () => {
    const adapter = await openTable('ledger', { id: column.id(), entry_no: column.string(), amount: column.integer() }, {}, 'CREATE TABLE ledger (id INTEGER PRIMARY KEY, entry_no TEXT, amount INTEGER)')
    registerGeneratedTables({ archive: defineTable('archive', { id: column.id(), amount: column.integer() }) })
    await adapter.execute('CREATE TABLE archive (id INTEGER PRIMARY KEY, amount INTEGER)')
    await DB.table('archive').insert([{ amount: 10 }, { amount: 20 }])
    const Entry = defineModel('ledger', { timestamps: false, primaryKey: 'entry_no', fillable: ['amount'] })

    await Entry.query().from('archive').orderBy('id').limit(1).increment('amount', 1)
    await Entry.query().from('archive').where('id', 2).increment('amount', 1)

    expect(await DB.table('archive').orderBy('id').get()).toEqual([{ id: 1, amount: 11 }, { id: 2, amount: 21 }])
    expect(observe(Entry.query().from('archive').getTableQueryBuilder())?.primaryKey).toBe('id')
    expect(observe(Entry.query().from('ledger').getTableQueryBuilder())?.primaryKey).toBe('entry_no')
  })

  it('keeps id as the key of tables without schema metadata', async () => {
    const { adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)')

    expect([observe(DB.table('notes'))].map(observation => observation?.primaryKey)).toEqual(['id'])
  })
})
