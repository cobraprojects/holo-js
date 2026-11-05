import { randomUUID } from 'node:crypto'
import { belongsTo, clearGeneratedTables, column, defineModel, hasMany, configureDB, createConnectionManager, createDatabase, createDialect, defineGeneratedTable, registerGeneratedTables, resetDB, resetDatabaseDependencyInvalidationListeners } from '@holo-js/db'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { createMySQLAdapter } from '../../db-mysql/src'
import { mysqlTestConnection } from '../../../tests/support/real-database'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

type Row = Readonly<Record<string, unknown>>

const adapter = createSQLiteAdapter({ filename: ':memory:' })

beforeEach(async () => {
  await adapter.initialize()
  const db = createDatabase({ adapter, dialect: createDialect('sqlite'), connectionName: 'main' })
  configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
})

afterEach(async () => {
  resetRealtimeRuntime()
  resetDB()
  clearGeneratedTables()
  resetDatabaseDependencyInvalidationListeners()
  await adapter.disconnect()
})

function mutate(handler: Parameters<typeof defineRealtimeMutation>[0]['handler']) {
  return executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
}

async function subscribe<TResult>(read: (db: Parameters<Parameters<typeof defineRealtimeQuery>[0]['handler']>[0]['db']) => Promise<TResult>) {
  const snapshots: TResult[] = []
  let reads = 0
  const query = defineRealtimeQuery({ access: 'public', handler: async ({ db }) => {
    reads += 1
    return await read(db)
  } })
  await subscribeRealtimeQuery(query, {}, { onData: (snapshot) => { snapshots.push(snapshot.data as TResult) }, onError: (error) => { throw error } })
  return { snapshots, reads: () => reads }
}

describe('a Generated-schema table keyed on code', () => {
  beforeEach(async () => {
    registerGeneratedTables({
      countries: defineGeneratedTable('countries', {
        code: column.string().primaryKey(),
        id: column.integer(),
        name: column.string(),
      }),
    })
    await adapter.execute('CREATE TABLE countries (code TEXT PRIMARY KEY, id INTEGER NOT NULL, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO countries VALUES ('DE', 1, 'Germany'), ('FR', 1, 'France'), ('IT', 2, 'Italy')")
  })

  it('patches the changed row of a list subscription', async () => {
    const live = await subscribe(db => db.table('countries').orderBy('code').get())
    await mutate(async ({ db }) => {
      await db.table('countries').where('code', 'FR').update({ name: 'République' })
    })
    await mutate(async ({ db }) => {
      await db.table('countries').where('code', 'DE').delete()
    })

    expect(live.snapshots).toEqual([
      [
        { code: 'DE', id: 1, name: 'Germany' },
        { code: 'FR', id: 1, name: 'France' },
        { code: 'IT', id: 2, name: 'Italy' },
      ],
      [
        { code: 'DE', id: 1, name: 'Germany' },
        { code: 'FR', id: 1, name: 'République' },
        { code: 'IT', id: 2, name: 'Italy' },
      ],
      [
        { code: 'FR', id: 1, name: 'République' },
        { code: 'IT', id: 2, name: 'Italy' },
      ],
    ])
    expect(live.reads()).toBe(1)
  })

  it('patches the changed row of a projected list subscription', async () => {
    const live = await subscribe(db => db.table('countries').select('code', 'name').orderBy('code').get())
    await mutate(async ({ db }) => {
      await db.table('countries').where('code', 'FR').update({ name: 'République' })
    })

    expect(live.snapshots.at(-1)).toEqual([
      { code: 'DE', name: 'Germany' },
      { code: 'FR', name: 'République' },
      { code: 'IT', name: 'Italy' },
    ])
    expect(live.reads()).toBe(1)
  })

  it('shows inserted rows in a list subscription', async () => {
    const live = await subscribe(db => db.table('countries').orderBy('code').get())
    await mutate(async ({ db }) => {
      await db.table('countries').insert({ code: 'ES', id: 1, name: 'Spain' })
    })

    expect(live.snapshots.at(-1)).toEqual([
      { code: 'DE', id: 1, name: 'Germany' },
      { code: 'ES', id: 1, name: 'Spain' },
      { code: 'FR', id: 1, name: 'France' },
      { code: 'IT', id: 2, name: 'Italy' },
    ])
  })

  it('patches the subscribed row of a detail subscription and ignores other rows', async () => {
    const live = await subscribe(db => db.table('countries').where('code', 'FR').first())
    await mutate(async ({ db }) => {
      await db.table('countries').where('code', 'DE').update({ name: 'Deutschland' })
    })
    await mutate(async ({ db }) => {
      await db.table('countries').where('code', 'FR').update({ name: 'République' })
    })

    expect(live.snapshots).toEqual([
      { code: 'FR', id: 1, name: 'France' },
      { code: 'FR', id: 1, name: 'République' },
    ])
    expect(live.reads()).toBe(1)
  })

  it('keeps a detail subscription on its row when another row sharing its id value changes', async () => {
    const live = await subscribe(db => db.table('countries').where('id', 1).where('name', 'France').first())
    await mutate(async ({ db }) => {
      await db.table('countries').where('code', 'DE').update({ name: 'France' })
    })
    await mutate(async ({ db }) => {
      await db.table('countries').where('code', 'DE').delete()
    })

    expect(live.snapshots.at(-1)).toEqual({ code: 'FR', id: 1, name: 'France' })
  })

  it('patches the changed row of a paginated subscription', async () => {
    const live = await subscribe(db => db.table('countries').orderBy('code').paginate(10))
    await mutate(async ({ db }) => {
      await db.table('countries').where('code', 'DE').delete()
    })

    expect((live.snapshots.at(-1) as { data: unknown }).data).toEqual([
      { code: 'FR', id: 1, name: 'France' },
      { code: 'IT', id: 2, name: 'Italy' },
    ])
  })

  it('patches the eager-loaded parent of a model subscription by its key', async () => {
    await adapter.execute('CREATE TABLE cities (code TEXT PRIMARY KEY, country_code TEXT NOT NULL, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO cities VALUES ('PAR', 'FR', 'Paris'), ('ROM', 'IT', 'Rome')")
    const Country = defineModel('countries', { timestamps: false })
    const City = defineModel(defineGeneratedTable('cities', { code: column.string().primaryKey(), country_code: column.string(), name: column.string() }), {
      timestamps: false,
      relations: { country: belongsTo(() => Country, 'country_code', 'code') },
    })
    const live = await subscribe(db => db.model(City).query().with('country').orderBy('code').get())
    await mutate(async ({ db }) => {
      await db.table('countries').where('code', 'DE').update({ name: 'Deutschland' })
    })
    await mutate(async ({ db }) => {
      await db.table('countries').where('code', 'FR').update({ name: 'République' })
    })

    expect(JSON.parse(JSON.stringify(live.snapshots.at(-1)))).toEqual([
      { code: 'PAR', country_code: 'FR', name: 'Paris', country: { code: 'FR', id: 1, name: 'République' } },
      { code: 'ROM', country_code: 'IT', name: 'Rome', country: { code: 'IT', id: 2, name: 'Italy' } },
    ])
  })

  it('patches the eager-loaded children of a model subscription by their key', async () => {
    await adapter.execute('CREATE TABLE cities (code TEXT PRIMARY KEY, id INTEGER NOT NULL, country_code TEXT NOT NULL, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO cities VALUES ('LYO', 1, 'FR', 'Lyon'), ('PAR', 1, 'FR', 'Paris')")
    const City = defineModel(defineGeneratedTable('cities', { code: column.string().primaryKey(), id: column.integer(), country_code: column.string(), name: column.string() }), { timestamps: false })
    const Country = defineModel('countries', {
      timestamps: false,
      relations: { cities: hasMany(() => City, 'country_code', 'code') },
    })
    const live = await subscribe(db => db.model(Country).query().where('code', 'FR').with('cities').get())
    await mutate(async ({ db }) => {
      await db.table('cities').where('code', 'PAR').delete()
    })

    expect(JSON.parse(JSON.stringify(live.snapshots.at(-1)))).toEqual([
      { code: 'FR', id: 1, name: 'France', cities: [{ code: 'LYO', id: 1, country_code: 'FR', name: 'Lyon' }] },
    ])
  })

  it('moves a row in a list subscription when an update changes its key', async () => {
    const live = await subscribe(db => db.table('countries').orderBy('code').get())
    await mutate(async ({ db }) => {
      await db.table('countries').where('code', 'DE').update({ code: 'ES' })
    })

    expect(live.snapshots.at(-1)).toEqual([
      { code: 'ES', id: 1, name: 'Germany' },
      { code: 'FR', id: 1, name: 'France' },
      { code: 'IT', id: 2, name: 'Italy' },
    ])
  })

  it('does not take an aliased column for the key of a detail subscription', async () => {
    const live = await subscribe(db => db.table('countries').select('name as code').where('code', 'FR').first())
    await mutate(async ({ db }) => {
      await db.table('countries').where('code', 'FR').update({ name: 'République' })
    })

    expect(live.snapshots.at(-1)).toEqual({ code: 'République' })

    const colliding = await subscribe(db => db.table('countries').select('code', 'name as code').where('code', 'IT').first())
    await mutate(async ({ db }) => {
      await db.table('countries').where('code', 'IT').update({ name: 'Italia' })
    })

    expect(colliding.snapshots.at(-1)).toEqual({ code: 'Italia' })
  })

  it('patches a list subscription when the changed row is matched by its id column', async () => {
    const live = await subscribe(db => db.table('countries').orderBy('code').get())
    await mutate(async ({ db }) => {
      await db.table('countries').where('id', 2).update({ name: 'Italia' })
    })

    expect(live.snapshots.at(-1)).toEqual([
      { code: 'DE', id: 1, name: 'Germany' },
      { code: 'FR', id: 1, name: 'France' },
      { code: 'IT', id: 2, name: 'Italia' },
    ])
  })
})

describe('Generated-schema tables without a single-column primary key', () => {
  it('re-runs a composite-key list subscription instead of patching', async () => {
    registerGeneratedTables({
      seats: defineGeneratedTable('seats', {
        id: column.integer(),
        row_no: column.integer().primaryKey(),
        seat_no: column.integer().primaryKey(),
        label: column.string(),
      }),
    })
    await adapter.execute('CREATE TABLE seats (id INTEGER NOT NULL, row_no INTEGER NOT NULL, seat_no INTEGER NOT NULL, label TEXT NOT NULL, PRIMARY KEY (row_no, seat_no))')
    await adapter.execute("INSERT INTO seats VALUES (1, 1, 1, 'aisle'), (1, 1, 2, 'window')")
    const live = await subscribe(db => db.table('seats').orderBy('seat_no').get())
    await mutate(async ({ db }) => {
      await db.table('seats').where('row_no', 1).where('seat_no', 2).update({ label: 'middle' })
    })

    expect(live.snapshots.at(-1)).toEqual([
      { id: 1, row_no: 1, seat_no: 1, label: 'aisle' },
      { id: 1, row_no: 1, seat_no: 2, label: 'middle' },
    ])
    expect(live.reads()).toBe(2)
  })

  it('re-runs a keyless list subscription instead of patching', async () => {
    registerGeneratedTables({
      events: defineGeneratedTable('events', {
        id: column.integer(),
        name: column.string(),
      }, { primaryKeyColumns: [] }),
    })
    await adapter.execute('CREATE TABLE events (id INTEGER NOT NULL, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO events VALUES (1, 'opened'), (2, 'closed')")
    const live = await subscribe(db => db.table('events').orderBy('name').get())
    await mutate(async ({ db }) => {
      await db.table('events').where('name', 'opened').update({ name: 'reopened' })
    })

    expect(live.snapshots.at(-1)).toEqual([
      { id: 2, name: 'closed' },
      { id: 1, name: 'reopened' },
    ])
    expect(live.reads()).toBe(2)
  })
})

describe('a model whose primaryKey option differs from the table schema key', () => {
  beforeEach(async () => {
    registerGeneratedTables({
      ledger: defineGeneratedTable('ledger', {
        id: column.integer(),
        entry_no: column.string(),
        amount: column.integer(),
      }, { primaryKeyColumns: [] }),
    })
    await adapter.execute('CREATE TABLE ledger (id INTEGER NOT NULL, entry_no TEXT NOT NULL, amount INTEGER NOT NULL)')
    await adapter.execute("INSERT INTO ledger VALUES (1, 'A', 10), (1, 'B', 20), (2, 'C', 30)")
  })

  it('patches a model list subscription by the model primary key', async () => {
    const Entry = defineModel('ledger', { timestamps: false, primaryKey: 'entry_no', fillable: ['amount'] })
    const live = await subscribe(db => db.model(Entry).query().orderBy('entry_no').get())
    await mutate(async ({ db }) => {
      await db.model(Entry).query().where('entry_no', 'B').update({ amount: 25 })
    })
    await mutate(async ({ db }) => {
      await db.model(Entry).query().where('entry_no', 'A').delete()
    })

    expect(JSON.parse(JSON.stringify(live.snapshots.at(-1)))).toEqual([
      { id: 1, entry_no: 'B', amount: 25 },
      { id: 2, entry_no: 'C', amount: 30 },
    ])
    expect(live.reads()).toBe(1)
  })

  it('patches each incremented row of a model list subscription by the model primary key', async () => {
    const Entry = defineModel('ledger', { timestamps: false, primaryKey: 'entry_no', fillable: ['amount'] })
    const live = await subscribe(db => db.model(Entry).query().orderBy('entry_no').get())
    await mutate(async ({ db }) => {
      await db.model(Entry).query().where('amount', '<', 30).increment('amount', 1)
    })

    expect(JSON.parse(JSON.stringify(live.snapshots.at(-1)))).toEqual([
      { id: 1, entry_no: 'A', amount: 11 },
      { id: 1, entry_no: 'B', amount: 21 },
      { id: 2, entry_no: 'C', amount: 30 },
    ])
  })

  it('keeps the model primary key when a model query names its table with from()', async () => {
    const Entry = defineModel('ledger', { timestamps: false, primaryKey: 'entry_no', fillable: ['amount'] })
    const live = await subscribe(db => db.model(Entry).query().from('ledger').orderBy('entry_no').get())
    await mutate(async ({ db }) => {
      await db.model(Entry).query().where('entry_no', 'B').update({ amount: 25 })
    })

    expect(JSON.parse(JSON.stringify(live.snapshots.at(-1)))).toEqual([
      { id: 1, entry_no: 'A', amount: 10 },
      { id: 1, entry_no: 'B', amount: 25 },
      { id: 2, entry_no: 'C', amount: 30 },
    ])
    expect(live.reads()).toBe(1)
  })

  it('patches a related count of a model whose related model sets primaryKey on a keyless table', async () => {
    await adapter.execute('CREATE TABLE owners (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO owners VALUES (1, 'Ada')")
    await adapter.execute('ALTER TABLE ledger ADD COLUMN owner_id INTEGER NOT NULL DEFAULT 1')
    registerGeneratedTables({
      owners: defineGeneratedTable('owners', { id: column.id(), name: column.string() }),
      ledger: defineGeneratedTable('ledger', {
        id: column.integer(),
        entry_no: column.string(),
        amount: column.integer(),
        owner_id: column.integer(),
      }, { primaryKeyColumns: [] }),
    })
    const Entry = defineModel('ledger', { timestamps: false, primaryKey: 'entry_no' })
    const Owner = defineModel('owners', { timestamps: false, relations: { entries: hasMany(() => Entry, 'owner_id') } })
    const live = await subscribe(db => db.model(Owner).query().withCount('entries').get())
    await mutate(async ({ db }) => {
      await db.table('ledger').insert({ id: 3, entry_no: 'D', amount: 40, owner_id: 1 })
    })

    expect(JSON.parse(JSON.stringify(live.snapshots.at(-1)))).toEqual([{ id: 1, name: 'Ada', entries_count: 4 }])
    expect(live.reads()).toBe(1)
  })

  it('re-runs a DB.table() list subscription on the same keyless table', async () => {
    const live = await subscribe(db => db.table('ledger').orderBy('entry_no').get())
    await mutate(async ({ db }) => {
      await db.table('ledger').where('entry_no', 'B').update({ amount: 25 })
    })

    expect(live.snapshots.at(-1)).toEqual([
      { id: 1, entry_no: 'A', amount: 10 },
      { id: 1, entry_no: 'B', amount: 25 },
      { id: 2, entry_no: 'C', amount: 30 },
    ])
    expect(live.reads()).toBe(2)
  })
})

describe('a Generated-schema table keyed on id', () => {
  it('keeps patching rows by id', async () => {
    registerGeneratedTables({
      posts: defineGeneratedTable('posts', { id: column.id(), title: column.string() }),
    })
    await adapter.execute('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL)')
    await adapter.execute("INSERT INTO posts VALUES (1, 'First'), (2, 'Second')")
    const live = await subscribe(db => db.table('posts').orderBy('id').get())
    await mutate(async ({ db }) => {
      await db.table('posts').where('id', 2).update({ title: 'Updated' })
    })

    expect(live.snapshots.at(-1)).toEqual([{ id: 1, title: 'First' }, { id: 2, title: 'Updated' }])
    expect(live.reads()).toBe(1)
  })
})

describe('a Generated-schema table with a numeric key that is not id', () => {
  beforeEach(async () => {
    registerGeneratedTables({
      items: defineGeneratedTable('items', { item_no: column.integer().primaryKey(), status: column.string(), name: column.string() }),
    })
    await adapter.execute('CREATE TABLE items (item_no INTEGER PRIMARY KEY, status TEXT NOT NULL, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO items VALUES (1, 'active', 'First'), (2, 'active', 'Second')")
  })

  it('patches a scalar subscription when an update moves another row onto the subscribed key', async () => {
    const live = await subscribe(db => db.table('items').where('item_no', 3).value('name'))
    await mutate(async ({ db }) => {
      await db.table('items').where('item_no', 2).update({ item_no: 3 })
    })

    expect(live.snapshots.at(-1)).toBe('Second')
  })

  it('moves a row in a list subscription when an upsert changes its key', async () => {
    registerGeneratedTables({
      tags: defineGeneratedTable('tags', { code: column.integer().primaryKey(), id: column.integer(), name: column.string() }),
    })
    await adapter.execute('CREATE TABLE tags (code INTEGER PRIMARY KEY, id INTEGER NOT NULL UNIQUE, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO tags VALUES (1, 11, 'First'), (2, 12, 'Second')")
    const live = await subscribe(db => db.table('tags').orderBy('code').get())
    await mutate(async ({ db }) => {
      await db.table('tags').upsert({ code: 3, id: 12, name: 'Second' }, ['id'], ['code'])
    })

    expect(live.snapshots.at(-1)).toEqual([
      { code: 1, id: 11, name: 'First' },
      { code: 3, id: 12, name: 'Second' },
    ])
  })

  it('moves a row in a list subscription when an upsert matches a differently cased unique value', async () => {
    registerGeneratedTables({
      tags: defineGeneratedTable('tags', { code: column.integer().primaryKey(), id: column.string(), name: column.string() }),
    })
    await adapter.execute('CREATE TABLE tags (code INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO tags VALUES (1, 'BB', 'First'), (2, 'AA', 'Second')")
    const live = await subscribe(db => db.table('tags').orderBy('code').get())
    await mutate(async ({ db }) => {
      await db.table('tags').upsert({ code: 3, id: 'aa', name: 'Second' }, ['id'], ['code'])
    })

    expect(live.snapshots.at(-1)).toEqual([
      { code: 1, id: 'BB', name: 'First' },
      { code: 3, id: 'AA', name: 'Second' },
    ])
  })

  it('moves a row in a list subscription when an upsert matches a unique value of another type', async () => {
    registerGeneratedTables({
      tags: defineGeneratedTable('tags', { code: column.integer().primaryKey(), id: column.integer(), name: column.string() }),
    })
    await adapter.execute('CREATE TABLE tags (code INTEGER PRIMARY KEY, id INTEGER NOT NULL UNIQUE, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO tags VALUES (1, 11, 'First'), (2, 12, 'Second')")
    const live = await subscribe(db => db.table('tags').orderBy('code').get())
    await mutate(async ({ db }) => {
      await db.table('tags').upsert({ code: 3, id: '12', name: 'Second' }, ['id'], ['code'])
    })

    expect(live.snapshots.at(-1)).toEqual([
      { code: 1, id: 11, name: 'First' },
      { code: 3, id: 12, name: 'Second' },
    ])
  })

  it('moves a row in a list subscription when a batch upsert changes its key through an intermediate row', async () => {
    registerGeneratedTables({
      tags: defineGeneratedTable('tags', { code: column.integer().primaryKey(), id: column.integer(), name: column.string() }),
    })
    await adapter.execute('CREATE TABLE tags (code INTEGER PRIMARY KEY, id INTEGER NOT NULL UNIQUE, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO tags VALUES (1, 11, 'First'), (2, 12, 'Second')")
    const live = await subscribe(db => db.table('tags').orderBy('code').get())
    await mutate(async ({ db }) => {
      await db.table('tags').upsert([{ code: 2, id: 12, name: 'Second' }, { code: 3, id: 12, name: 'Second' }], ['id'], ['code'])
    })

    expect(live.snapshots.at(-1)).toEqual([
      { code: 1, id: 11, name: 'First' },
      { code: 3, id: 12, name: 'Second' },
    ])
  })

  it('applies every filter of detail subscriptions refreshed together', async () => {
    const first = await subscribe(db => db.table('items').select('name').where('item_no', 1).where('status', 'active').first())
    const second = await subscribe(db => db.table('items').select('name').where('item_no', 2).where('status', 'active').first())
    await mutate(async ({ db }) => {
      await db.table('items').where('status', 'active').update({ status: 'archived' })
    })

    expect([first.snapshots.at(-1), second.snapshots.at(-1)]).toEqual([undefined, undefined])
  })
})

describe('a Generated-schema table with a case-insensitive string key', () => {
  it('removes a row deleted through a differently cased key', async () => {
    registerGeneratedTables({
      regions: defineGeneratedTable('regions', { code: column.string().primaryKey(), name: column.string() }),
    })
    await adapter.execute('CREATE TABLE regions (code TEXT PRIMARY KEY COLLATE NOCASE, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO regions VALUES ('DE', 'Germany'), ('FR', 'France')")
    const live = await subscribe(db => db.table('regions').orderBy('code').get())
    await mutate(async ({ db }) => {
      await db.table('regions').where('code', 'de').delete()
    })

    expect(live.snapshots.at(-1)).toEqual([{ code: 'FR', name: 'France' }])
  })

  it('keeps a projected detail subscription when an update recases its key', async () => {
    registerGeneratedTables({
      regions: defineGeneratedTable('regions', { code: column.string().primaryKey(), name: column.string() }),
    })
    await adapter.execute('CREATE TABLE regions (code TEXT PRIMARY KEY COLLATE NOCASE, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO regions VALUES ('DE', 'Germany'), ('FR', 'France')")
    const live = await subscribe(db => db.table('regions').select('code', 'name').where('code', 'DE').first())
    await mutate(async ({ db }) => {
      await db.table('regions').where('code', 'DE').update({ code: 'de' })
    })

    expect(live.snapshots.at(-1)).toEqual({ code: 'de', name: 'Germany' })
  })

  it('follows a detail subscription through a recased key to later updates', async () => {
    registerGeneratedTables({
      regions: defineGeneratedTable('regions', { code: column.string().primaryKey(), name: column.string() }),
    })
    await adapter.execute('CREATE TABLE regions (code TEXT PRIMARY KEY COLLATE NOCASE, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO regions VALUES ('DE', 'Germany'), ('FR', 'France')")
    const live = await subscribe(db => db.table('regions').where('code', 'DE').first())
    await mutate(async ({ db }) => {
      await db.table('regions').where('code', 'DE').update({ code: 'de' })
    })
    await mutate(async ({ db }) => {
      await db.table('regions').where('code', 'DE').update({ name: 'Deutschland' })
    })

    expect(live.snapshots.at(-1)).toEqual({ code: 'de', name: 'Deutschland' })
  })

  it('keeps grouped detail subscriptions when an update recases one of their keys', async () => {
    registerGeneratedTables({
      regions: defineGeneratedTable('regions', { code: column.string().primaryKey(), name: column.string() }),
    })
    await adapter.execute('CREATE TABLE regions (code TEXT PRIMARY KEY COLLATE NOCASE, name TEXT NOT NULL)')
    await adapter.execute("INSERT INTO regions VALUES ('DE', 'Germany'), ('FR', 'France')")
    const live = await subscribe(async db => ({
      germany: await db.table('regions').select('code', 'name').where('code', 'DE').first(),
      france: await db.table('regions').select('code', 'name').where('code', 'FR').first(),
    }))
    const ordered = await subscribe(async db => ({
      germany: await db.table('regions').select('code', 'name').where('code', 'DE').orderBy('code').first(),
      france: await db.table('regions').select('code', 'name').where('code', 'FR').orderBy('code').first(),
    }))
    await mutate(async ({ db }) => {
      await db.table('regions').where('code', 'DE').update({ code: 'de' })
    })

    expect(live.snapshots.at(-1)).toEqual({
      germany: { code: 'de', name: 'Germany' },
      france: { code: 'FR', name: 'France' },
    })
    expect(ordered.snapshots.at(-1)).toEqual({
      germany: { code: 'de', name: 'Germany' },
      france: { code: 'FR', name: 'France' },
    })
  })
})

describe('a MySQL table whose key the database generates without auto-increment', () => {
  it.runIf(process.env.HOLO_MYSQL_INTEGRATION === '1')('re-runs a list subscription when an inserted row arrives without its key', async () => {
    const name = `regions_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const mysql = createMySQLAdapter({ config: mysqlTestConnection() })
    const db = createDatabase({ adapter: mysql, dialect: createDialect('mysql'), connectionName: 'main' })
    configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    registerGeneratedTables({ [name]: defineGeneratedTable(name, { code: column.string().primaryKey(), name: column.string() }) })
    await mysql.execute(`CREATE TABLE ${name} (code VARCHAR(8) PRIMARY KEY DEFAULT 'XX', name VARCHAR(32) NOT NULL)`)
    try {
      const live = await subscribe(db => db.table(name).orderBy('name').get())
      await mutate(async ({ db }) => {
        await db.table(name).insert({ name: 'North' })
      })

      expect(live.snapshots.at(-1)).toEqual([{ code: 'XX', name: 'North' }])
    } finally {
      await mysql.execute(`DROP TABLE ${name}`)
      await mysql.disconnect()
    }
  })
})
