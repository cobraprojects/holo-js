import { randomUUID } from 'node:crypto'
import { belongsTo, clearGeneratedTables, column, defineModel, hasMany, configureDB, createConnectionManager, createDatabase, createDialect, defineGeneratedTable, registerGeneratedTables, resetDB, resetDatabaseDependencyInvalidationListeners } from '@holo-js/db'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { createMySQLAdapter } from '../../db-mysql/src'
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

describe('a MySQL table whose key the database generates without auto-increment', () => {
  it('re-runs a list subscription when an inserted row arrives without its key', async () => {
    const name = `regions_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const mysql = createMySQLAdapter({ config: {
      host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
      port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
      user: process.env.HOLO_MYSQL_USER ?? 'root',
      password: process.env.HOLO_MYSQL_PASSWORD ?? '',
      database: process.env.HOLO_MYSQL_DATABASE ?? 'mysql',
    } })
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
