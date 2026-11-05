import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, clearGeneratedTables, column, defineModel, queryCacheInternals, registerGeneratedTables, type DatabaseDependencyInvalidationEvent } from '../src'
import type { DatabaseMutationEvent } from '../src/cache'
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
  return queryCacheInternals.createDatabaseQueryObservation(query.getPlan(), 'default', [])
}

function captureMutations(): DatabaseMutationEvent[] {
  const mutations: DatabaseMutationEvent[] = []
  onTestFinished(() => queryCacheInternals.resetDatabaseDependencyInvalidationListeners())
  queryCacheInternals.onDatabaseDependencyInvalidated((event: DatabaseDependencyInvalidationEvent & { mutations?: readonly DatabaseMutationEvent[] }) => {
    mutations.push(...event.mutations ?? [])
  })
  return mutations
}

describe('query observations and mutation events carry the table primary key', () => {
  it('identifies rows of a table keyed on code by code', async () => {
    await openTable('countries', { code: column.string().primaryKey(), id: column.integer(), name: column.string() }, {}, 'CREATE TABLE countries (code TEXT PRIMARY KEY, id INTEGER, name TEXT)')
    await DB.table('countries').insert({ code: 'FR', id: 1, name: 'France' })
    const mutations = captureMutations()

    const list = observe(DB.table('countries').orderBy('name'))
    const projected = observe(DB.table('countries').select('code', 'name').orderBy('name'))
    const projectedWithoutKey = observe(DB.table('countries').select('id', 'name').orderBy('name'))
    const detail = observe(DB.table('countries').select('name').where('code', 'FR').limit(1))
    await DB.table('countries').where('code', 'FR').update({ name: 'République' })

    expect([list, projected, projectedWithoutKey, detail].map(observation => [observation?.primaryKey, observation?.patchable])).toEqual([
      ['code', true],
      ['code', true],
      ['code', false],
      ['code', true],
    ])
    expect(mutations.map(mutation => mutation.primaryKey)).toEqual(['code'])
  })

  it('makes composite-key and keyless table observations unpatchable', async () => {
    await openTable('seats', { id: column.integer(), row_no: column.integer().primaryKey(), seat_no: column.integer().primaryKey() }, {}, 'CREATE TABLE seats (id INTEGER, row_no INTEGER, seat_no INTEGER, PRIMARY KEY (row_no, seat_no))')
    await openTable('events', { id: column.integer(), name: column.string() }, { primaryKeyColumns: [] }, 'CREATE TABLE events (id INTEGER, name TEXT)')

    expect([observe(DB.table('seats')), observe(DB.table('events'))].map(observation => [observation?.primaryKey, observation?.patchable])).toEqual([
      [undefined, false],
      [undefined, false],
    ])
  })

  it('identifies rows of a model query by the model primary key and of a DB.table() query by the schema key', async () => {
    const adapter = await openTable('ledger', { id: column.id(), entry_no: column.string(), amount: column.integer() }, {}, 'CREATE TABLE ledger (id INTEGER PRIMARY KEY, entry_no TEXT, amount INTEGER)')
    registerGeneratedTables({ seats: defineTable('seats', { row_no: column.integer().primaryKey(), seat_no: column.integer().primaryKey() }) })
    await adapter.execute('CREATE TABLE seats (row_no INTEGER, seat_no INTEGER, PRIMARY KEY (row_no, seat_no))')
    await DB.table('ledger').insert({ entry_no: 'A', amount: 10 })
    const Entry = defineModel('ledger', { timestamps: false, primaryKey: 'entry_no', fillable: ['amount'] })
    const Seat = defineModel('seats', { timestamps: false })
    const mutations = captureMutations()

    const model = observe(Entry.query().getTableQueryBuilder())
    const table = observe(DB.table('ledger'))
    const composite = observe(Seat.query().getTableQueryBuilder())
    await Entry.query().where('entry_no', 'A').update({ amount: 11 })

    expect([model, table, composite].map(observation => [observation?.primaryKey, observation?.patchable])).toEqual([
      ['entry_no', true],
      ['id', true],
      [undefined, false],
    ])
    expect(mutations.map(mutation => mutation.primaryKey)).toEqual(['entry_no'])
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

  it('keeps id as the key of tables without schema metadata', async () => {
    const { adapter } = await openDatabase('sqlite')
    await adapter.execute('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)')

    expect([observe(DB.table('notes'))].map(observation => [observation?.primaryKey, observation?.patchable])).toEqual([['id', true]])
  })

  it('publishes an inserted row under its generated auto-increment key', async () => {
    await openTable('tickets', { ticket_no: column.id(), label: column.string() }, {}, 'CREATE TABLE tickets (ticket_no INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT)')
    const mutations = captureMutations()

    await DB.table('tickets').insert({ label: 'first' })

    expect(mutations.map(mutation => [mutation.primaryKey, mutation.rows])).toEqual([['ticket_no', [{ label: 'first', ticket_no: 1 }]]])
  })

  it('publishes an inserted row without a key when the database generates a key that is not auto-increment', async () => {
    const name = `regions_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const adapter = await openTable(name, { code: column.string().primaryKey(), name: column.string() }, {}, `CREATE TABLE ${name} (code VARCHAR(8) PRIMARY KEY DEFAULT 'XX', name TEXT)`, 'mysql')
    try {
      const mutations = captureMutations()

      await DB.table(name).insert({ name: 'North' })

      expect(mutations.map(mutation => [mutation.primaryKey, mutation.rows])).toEqual([['code', [{ name: 'North' }]]])
    } finally {
      await adapter.execute(`DROP TABLE ${name}`)
    }
  })
})
