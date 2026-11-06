import { randomUUID } from 'node:crypto'
import { createMySQLAdapter } from '@holo-js/db-mysql'
import { createPostgresAdapter } from '@holo-js/db-postgres'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { describe, expect, it, onTestFinished } from 'vitest'
import { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { DB, clearGeneratedTables, onDatabaseDependencyInvalidated, column, configureDB, createConnectionManager, createDatabase, createDialect, createSchemaService, defineGeneratedTable, defineModel, registerGeneratedTables, unsafeSql } from '../src'
import { integrationDrivers, mysqlTestConnection, openDatabase, postgresTestConnection, tableSpellings } from './support/database'
import { runWithoutGeneratedSchema } from '../src/schema/generated'
import type { TestDriver as Driver } from '../../../tests/support/real-database'

const security = { allowUnsafeRawSql: true }
const uniqueName = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
const quote = (driver: Driver, identifier: string) => driver === 'mysql' ? `\`${identifier}\`` : `"${identifier}"`
const quotePath = (driver: Driver, path: string) => path.split('.').map(part => quote(driver, part)).join('.')

function useMemoryCache() {
  configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
  onTestFinished(() => resetCacheRuntime())
}

function useGeneratedTables(tables: Parameters<typeof registerGeneratedTables>[0]) {
  registerGeneratedTables(tables)
  onTestFinished(() => clearGeneratedTables())
}

const cachedNames = async (tableName: string) => (await DB.table(tableName).orderBy('id').cache(60).get()).map(row => row.name)

for (const driver of integrationDrivers(['sqlite', 'postgres'] as const)) {
  describe(`${driver} table identity after raw DDL`, () => {
    it('refreshes a cached bare read after a write through the qualified name of a table raw SQL created', async () => {
      const { db, schema } = await openDatabase(driver, { security })
      useMemoryCache()
      const name = uniqueName('holo_raw')
      const { qualified } = tableSpellings(driver, name)
      onTestFinished(() => schema.dropTable(qualified))
      await expect(cachedNames(qualified)).rejects.toThrow()

      await db.unsafeExecute(unsafeSql(`CREATE TABLE ${quotePath(driver, qualified)} (${quote(driver, 'id')} INTEGER PRIMARY KEY, ${quote(driver, 'name')} VARCHAR(255) NOT NULL)`))
      expect(await cachedNames(name)).toEqual([])
      await DB.table(qualified).insert({ id: 1, name: 'first' })

      expect(await cachedNames(name)).toEqual(['first'])
    })
  })
}

for (const driver of integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)) {
  describe(`${driver} table identity after raw reads and writes`, () => {
    it('keeps resolved identities across raw statements that cannot change the schema', async () => {
      const lookups: string[] = []
      const { db, table } = await openDatabase(driver, { security, logger: { onQueryStart: (entry) => { if (entry.source?.includes('tableIdentity')) lookups.push(entry.sql) } } })
      useMemoryCache()
      const { qualified } = tableSpellings(driver, table.tableName)
      expect(await cachedNames(qualified)).toEqual([])

      await db.unsafeQuery(unsafeSql(`SELECT ${quote(driver, 'id')} FROM ${quotePath(driver, qualified)}`))
      await db.unsafeExecute(unsafeSql(`INSERT INTO ${quotePath(driver, qualified)} (${quote(driver, 'id')}, ${quote(driver, 'name')}) VALUES (1, 'raw')`))
      await db.unsafeExecute(unsafeSql(`UPDATE ${quotePath(driver, qualified)} SET ${quote(driver, 'name')} = 'raw' WHERE ${quote(driver, 'id')} = 1`))
      await DB.table(qualified).insert({ id: 2, name: 'second' })

      expect(await cachedNames(qualified)).toEqual(['raw', 'second'])
      expect(lookups).toHaveLength(1)
    })
  })

  describe(`${driver} column listing after raw DDL`, () => {
    it('accepts a column that raw SQL added to a guarded untyped model table', async () => {
      const { db, table } = await openDatabase(driver, { connectionName: 'reporting', security })
      const app = createDatabase({ connectionName: 'app', adapter: createSQLiteAdapter({ filename: ':memory:' }), dialect: createDialect('sqlite') })
      onTestFinished(() => app.disconnect())
      configureDB(createConnectionManager({ defaultConnection: 'app', connections: { app, reporting: db } }))
      const tableName = `${table.tableName}_events`
      await createSchemaService(db).createTable(tableName, (columns) => {
        columns.id()
        columns.string('name')
      })
      onTestFinished(() => createSchemaService(db).dropTable(tableName))
      const Event = defineModel(tableName, { connectionName: 'reporting', guarded: ['admin'], timestamps: false })
      expect((await Event.create({ name: 'first' })).get('name')).toBe('first')
      await expect(Event.create({ name: 'early', nickname: 'early' })).rejects.toThrow('Column "nickname" is not writable')

      await db.unsafeExecute(unsafeSql(`ALTER TABLE ${quotePath(driver, tableName)} ADD COLUMN ${quote(driver, 'nickname')} VARCHAR(255)`))

      expect((await Event.create({ name: 'late', nickname: 'late' })).get('nickname')).toBe('late')
    })
  })
}

async function openSingleSession(driver: 'postgres' | 'mysql') {
  const adapter = driver === 'postgres'
    ? createPostgresAdapter({ config: { ...postgresTestConnection(), max: 1 } })
    : createMySQLAdapter({ config: { ...mysqlTestConnection(), connectionLimit: 1 } })
  const db = createDatabase({ connectionName: 'default', adapter, dialect: createDialect(driver), security })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
  const tenant = uniqueName('holo_tenant')
  const name = uniqueName('holo_session')
  const home = driver === 'postgres' ? 'public' : mysqlTestConnection().database
  const dropTenant = driver === 'postgres' ? `DROP SCHEMA IF EXISTS "${tenant}" CASCADE` : `DROP DATABASE IF EXISTS \`${tenant}\``
  onTestFinished(async () => {
    try {
      await db.getAdapter().execute(dropTenant)
      await createSchemaService(db).dropTable(`${home}.${name}`)
    } finally {
      await db.disconnect()
    }
  })
  await db.getAdapter().execute(driver === 'postgres' ? `CREATE SCHEMA "${tenant}"` : `CREATE DATABASE \`${tenant}\``)
  const schema = createSchemaService(db)
  for (const owner of [home, tenant]) {
    await schema.createTable(`${owner}.${name}`, (table) => {
      table.integer('id').primaryKey()
      table.string('name')
    })
  }
  const switchTo = (owner: string) => db.unsafeExecute(unsafeSql(driver === 'postgres' ? `SET search_path TO "${owner}"` : `USE \`${owner}\``))
  return { db, tenant, name, home, switchTo }
}

for (const driver of integrationDrivers(['postgres', 'mysql'] as const)) {
  describe(`${driver} table identity after a session schema change`, () => {
    it(`refreshes a cached bare read after a write through the qualified name once ${driver === 'postgres' ? 'search_path' : 'USE'} points the bare name at it`, async () => {
      const { tenant, name, switchTo } = await openSingleSession(driver)
      useMemoryCache()
      expect(await cachedNames(`${tenant}.${name}`)).toEqual([])

      await switchTo(tenant)
      expect(await cachedNames(name)).toEqual([])
      await DB.table(`${tenant}.${name}`).insert({ id: 1, name: 'tenant' })

      expect(await cachedNames(name)).toEqual(['tenant'])
    })
  })
}

for (const driver of integrationDrivers(['postgres', 'mysql'] as const)) {
  describe(`${driver} bare table name after a session schema change`, () => {
    it('stops serving a cached bare read once the bare name points at another schema', async () => {
      const { name, home, tenant, switchTo } = await openSingleSession(driver)
      useMemoryCache()
      await DB.table(`${home}.${name}`).insert({ id: 1, name: 'home' })
      expect(await cachedNames(name)).toEqual(['home'])

      await switchTo(tenant)

      expect(await cachedNames(name)).toEqual([])
    })
  })
}

describe.each(integrationDrivers(['sqlite'] as const))('%s bare table name after a temp table shadows it', (driver) => {
  it('stops serving a cached bare read once a temp table shadows the bare name', async () => {
    const { db, table } = await openDatabase(driver)
    useMemoryCache()
    const { bare } = tableSpellings(driver, table.tableName)
    await DB.table(bare).insert({ id: 1, name: 'main', active: false })
    expect(await cachedNames(bare)).toEqual(['main'])

    await db.executeSchemaStatement({ sql: `CREATE TEMP TABLE "${bare}" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)`, source: 'schema' })

    expect(await cachedNames(bare)).toEqual([])
  })
})

describe.each(integrationDrivers(['sqlite'] as const))('%s cached reads after the schema changes', (driver) => {
  it('stops serving a cached bare read inside the transaction whose temp table shadows the bare name', async () => {
    const { table } = await openDatabase(driver, { security })
    useMemoryCache()
    const { bare } = tableSpellings(driver, table.tableName)
    await DB.table(bare).insert({ id: 1, name: 'main', active: false })
    expect(await cachedNames(bare)).toEqual(['main'])

    await DB.transaction(async (transaction) => {
      await transaction.unsafeExecute(unsafeSql(`CREATE TEMP TABLE "${bare}" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)`))
      expect(await cachedNames(bare)).toEqual([])
    })
  })

  it('lets an invalidation listener reread the table whose identity refresh notified it', async () => {
    const { db, table } = await openDatabase(driver)
    useMemoryCache()
    const { bare, qualified } = tableSpellings(driver, table.tableName)
    await DB.table(qualified).insert({ id: 1, name: 'first', active: false })
    expect(await cachedNames(qualified)).toEqual(['first'])
    const reread: unknown[][] = []
    const stop = onDatabaseDependencyInvalidated(async () => { reread.push(await cachedNames(qualified)) })
    onTestFinished(stop)

    await db.executeSchemaStatement({ sql: `CREATE TEMP TABLE "${bare}" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)`, source: 'schema' })

    expect(await cachedNames(qualified)).toEqual(['first'])
    expect(reread.length).toBeGreaterThan(0)
    expect(reread.every(names => names.length === 1 && names[0] === 'first')).toBe(true)
  }, 10_000)

  it('notifies invalidation listeners of an identity change inside a transaction only after it commits', async () => {
    const { db, table } = await openDatabase(driver)
    useMemoryCache()
    const { bare, qualified } = tableSpellings(driver, table.tableName)
    await DB.table(qualified).insert({ id: 1, name: 'first', active: false })
    expect(await cachedNames(qualified)).toEqual(['first'])
    let inside = false
    const notifiedInside: unknown[] = []
    const stop = onDatabaseDependencyInvalidated((event) => { if (inside) notifiedInside.push(event) })
    onTestFinished(stop)

    await expect(DB.transaction(async (transaction) => {
      inside = true
      await transaction.table(qualified).where('id', 1).update({ name: 'uncommitted' })
      await transaction.executeSchemaStatement({ sql: `CREATE TEMP TABLE "${bare}" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)`, source: 'schema' })
      await transaction.table(qualified).orderBy('id').cache(60).get()
      inside = false
      throw new RollbackRequested()
    })).rejects.toThrow(RollbackRequested)
    inside = false

    expect(notifiedInside).toEqual([])
  })

  it('does not notify invalidation listeners when an unrelated schema change leaves a table identity unchanged', async () => {
    const { schema, table } = await openDatabase(driver)
    useMemoryCache()
    const { bare, qualified } = tableSpellings(driver, table.tableName)
    await DB.table(qualified).insert({ id: 1, name: 'first', active: false })
    expect(await cachedNames(bare)).toEqual(['first'])
    expect(await cachedNames(qualified)).toEqual(['first'])
    const notified: unknown[] = []
    const stop = onDatabaseDependencyInvalidated((event) => { notified.push(event) })
    onTestFinished(stop)

    await schema.createTable(`${qualified}_unrelated`, (columns) => { columns.integer('id').primaryKey() })
    onTestFinished(() => schema.dropTable(`${qualified}_unrelated`))

    expect(await cachedNames(bare)).toEqual(['first'])
    expect(await cachedNames(qualified)).toEqual(['first'])
    expect(notified).toEqual([])
  })

  it('reads a model defined by the qualified name from that table after a temp table shadows the bare name', async () => {
    const { db, table } = await openDatabase(driver)
    const { bare, qualified } = tableSpellings(driver, table.tableName)
    useGeneratedTables({ items: defineGeneratedTable(bare, itemColumns) })
    await DB.table(qualified).insert({ id: 1, name: 'main', active: false })
    const Item = defineModel(qualified, { timestamps: false })
    expect((await Item.findOrFail(1)).get('name')).toBe('main')

    await db.executeSchemaStatement({ sql: `CREATE TEMP TABLE "${bare}" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "active" INTEGER NOT NULL, "settings" TEXT)`, source: 'schema' })
    await db.getAdapter().execute(`INSERT INTO "temp"."${bare}" ("id", "name", "active") VALUES (1, 'temporary', 0)`)

    expect((await Item.findOrFail(1)).get('name')).toBe('main')
  })

  it('still expires a replaced table on the retry after a failed identity refresh', async () => {
    let failLookup = false
    const { db, table } = await openDatabase(driver, {
      security,
      wrapAdapter: adapter => new Proxy(adapter, {
        get(target, property) {
          const query = target.query.bind(target)
          if (property !== 'query') return Reflect.get(target, property, target)
          return async (...args: Parameters<typeof query>) => {
            if (failLookup && args[0].includes('pragma_table_list')) {
              failLookup = false
              throw new Error('lookup failed')
            }
            return query(...args)
          }
        },
      }),
    })
    useMemoryCache()
    const { bare, qualified } = tableSpellings(driver, table.tableName)
    await DB.table(qualified).insert({ id: 1, name: 'old', active: false })
    expect(await cachedNames(qualified)).toEqual(['old'])
    await db.unsafeExecute(unsafeSql(`DROP TABLE "${bare}"`))
    await db.unsafeExecute(unsafeSql(`CREATE TABLE "${bare}" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)`))

    failLookup = true
    await expect(cachedNames(qualified)).rejects.toThrow('lookup failed')

    expect(await cachedNames(qualified)).toEqual([])
  })

  it('stops serving cached bare reads to concurrent readers once a temp table shadows the bare name', async () => {
    const { db, table } = await openDatabase(driver)
    useMemoryCache()
    const { bare } = tableSpellings(driver, table.tableName)
    await DB.table(bare).insert({ id: 1, name: 'main', active: false })
    expect(await cachedNames(bare)).toEqual(['main'])

    await db.executeSchemaStatement({ sql: `CREATE TEMP TABLE "${bare}" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)`, source: 'schema' })

    expect(await Promise.all([cachedNames(bare), cachedNames(bare)])).toEqual([[], []])
  })

})

for (const driver of integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)) {
  describe(`${driver} cached reads after raw SQL replaces a table`, () => {
    it('stops serving a cached qualified read once raw SQL replaces the table at the same path', async () => {
      const { db, table } = await openDatabase(driver, { security })
      useMemoryCache()
      const { qualified } = tableSpellings(driver, table.tableName)
      await DB.table(qualified).insert({ id: 1, name: 'old', active: false })
      expect(await cachedNames(qualified)).toEqual(['old'])

      await db.unsafeExecute(unsafeSql(`DROP TABLE ${quotePath(driver, qualified)}`))
      await db.unsafeExecute(unsafeSql(`CREATE TABLE ${quotePath(driver, qualified)} (${quote(driver, 'id')} INTEGER PRIMARY KEY, ${quote(driver, 'name')} VARCHAR(255) NOT NULL, ${quote(driver, 'active')} BOOLEAN NOT NULL, ${quote(driver, 'settings')} TEXT)`))

      expect(await cachedNames(qualified)).toEqual([])
    })
  })
}

for (const driver of integrationDrivers(['postgres', 'mysql'] as const)) {
  describe(`${driver} concurrent cached reads after a session schema change`, () => {
    it('stops serving cached bare reads to concurrent readers once the bare name points at another schema', async () => {
      const { name, home, tenant, switchTo } = await openSingleSession(driver)
      useMemoryCache()
      await DB.table(`${home}.${name}`).insert({ id: 1, name: 'home' })
      expect(await cachedNames(name)).toEqual(['home'])

      await switchTo(tenant)

      expect(await Promise.all([cachedNames(name), cachedNames(name)])).toEqual([[], []])
    })
  })
}

describe.each(integrationDrivers(['postgres'] as const))('%s model after a temp table shadows the bare name', (driver) => {
  it('reads a model defined by the qualified name from that table after a temp table shadows the bare name', async () => {
    const { db, name, home } = await openSingleSession(driver)
    useGeneratedTables({ shadowed: defineGeneratedTable(name, { id: column.integer().primaryKey(), name: column.string() }) })
    await DB.table(`${home}.${name}`).insert({ id: 1, name: 'home' })
    const Shadowed = defineModel(`${home}.${name}`, { timestamps: false })
    expect((await Shadowed.findOrFail(1)).get('name')).toBe('home')

    await db.executeSchemaStatement({ sql: `CREATE TEMP TABLE "${name}" ("id" INTEGER PRIMARY KEY, "name" VARCHAR(255) NOT NULL)`, source: 'schema' })
    await db.getAdapter().execute(`INSERT INTO pg_temp."${name}" ("id", "name") VALUES (1, 'temporary')`)

    expect((await Shadowed.findOrFail(1)).get('name')).toBe('home')
  })
})

type NamedRow = { get: (key: string) => unknown }

async function openDisagreeingRecords() {
  const records = uniqueName('records')
  const { db } = await openDatabase('sqlite')
  await db.getAdapter().execute(`ATTACH DATABASE ':memory:' AS "aux"`)
  await db.getAdapter().execute(`CREATE TABLE "main"."${records}" ("code" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)`)
  await db.getAdapter().execute(`CREATE TABLE "aux"."${records}" ("other_key" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)`)
  await db.getAdapter().execute(`INSERT INTO "main"."${records}" ("code", "name") VALUES (7, 'main')`)
  useGeneratedTables({
    mainRecords: defineGeneratedTable(`main.${records}`, { code: column.integer().primaryKey(), name: column.string() }),
    auxRecords: defineGeneratedTable(`aux.${records}`, { other_key: column.integer().primaryKey(), name: column.string() }),
  })
  return { db, records }
}

describe('sqlite model keyed by a generated table whose spellings disagree on the primary key', () => {
  it('force-deletes a model defined by the bare name by the key of the table SQLite resolves it to before any other query', async () => {
    const { db, records } = await openDisagreeingRecords()

    await defineModel(records, { timestamps: false, name: uniqueName('DeletedRecord') }).forceDelete(7)

    expect((await db.getAdapter().query(`SELECT "code" FROM "main"."${records}"`)).rows).toEqual([])
  })

  it('traverses a model defined by the bare name by the key of the table SQLite resolves it to before any other query', async () => {
    const traversals: Record<string, (query: ReturnType<ReturnType<typeof defineModel>['query']>) => Promise<unknown[]>> = {
      chunk: async (query) => { const names: unknown[] = []; await query.chunk(10, (rows: readonly NamedRow[]) => { names.push(...rows.map(row => row.get('name'))) }); return names },
      chunkById: async (query) => { const names: unknown[] = []; await query.chunkById(10, (rows: readonly NamedRow[]) => { names.push(...rows.map(row => row.get('name'))) }); return names },
      chunkByIdDesc: async (query) => { const names: unknown[] = []; await query.chunkByIdDesc(10, (rows: readonly NamedRow[]) => { names.push(...rows.map(row => row.get('name'))) }); return names },
      eachById: async (query) => { const names: unknown[] = []; await query.eachById((row: NamedRow) => { names.push(row.get('name')) }); return names },
      lazy: async (query) => { const names: unknown[] = []; for await (const row of query.lazy()) names.push(row.get('name')); return names },
      lazyById: async (query) => { const names: unknown[] = []; for await (const row of query.lazyById()) names.push(row.get('name')); return names },
      lazyByIdDesc: async (query) => { const names: unknown[] = []; for await (const row of query.lazyByIdDesc()) names.push(row.get('name')); return names },
      cursorPaginate: async query => (await query.cursorPaginate(10)).data.map((row: NamedRow) => row.get('name')),
    }
    for (const [name, traverse] of Object.entries(traversals)) {
      const { records } = await openDisagreeingRecords()
      expect([name, await traverse(defineModel(records, { timestamps: false, name: uniqueName(`Traversed${name}`) }).query())]).toEqual([name, ['main']])
      clearGeneratedTables()
    }
  })

  it('filters a model defined by the bare name by the key of the table SQLite resolves it to before any other query', async () => {
    const filters: Record<string, (model: ReturnType<typeof defineModel>) => Promise<unknown>> = {
      whereKey: async model => (await model.query().whereKey(7).first())?.get('name'),
      whereKeyList: async model => (await model.query().whereKey([7]).first())?.get('name'),
      whereKeyNot: async model => (await model.query().whereKeyNot(8).first())?.get('name'),
      whereKeyNotList: async model => (await model.query().whereKeyNot([8]).first())?.get('name'),
      whereKeyNotNull: async model => (await model.query().whereKeyNot(null).first())?.get('name'),
      whereKeyNull: async model => (await model.query().whereKey(null).first())?.get('name') ?? 'main',
    }
    for (const qualify of [(records: string) => records, (records: string) => `MAIN.${records}`]) {
      for (const [name, filter] of Object.entries(filters)) {
        const { records } = await openDisagreeingRecords()
        const spelling = qualify(records)
        expect([spelling, name, await filter(defineModel(spelling, { timestamps: false, name: uniqueName(`Filtered${name}`) }))]).toEqual([spelling, name, 'main'])
        clearGeneratedTables()
      }
    }
  })

  it('finds a model defined by the bare name by the key of the table SQLite resolves it to before any other query', async () => {
    const { records } = await openDisagreeingRecords()

    expect((await defineModel(records, { timestamps: false }).find(7))?.get('name')).toBe('main')
    expect((await defineModel(records, { timestamps: false, name: uniqueName('QueriedRecord') }).query().find(7))?.get('name')).toBe('main')
    expect((await defineModel(records, { timestamps: false, name: uniqueName('ManyRecord') }).findMany([7])).map(record => record.get('name'))).toEqual(['main'])
  })
})

describe('sqlite model on a connection outside the generated schema', () => {
  it('stays untyped after resolving a spelling that matches a generated table of another connection', async () => {
    const { db } = await openDatabase('sqlite', { connectionName: 'primary' })
    await createSchemaService(db).createTable('users', (columns) => {
      columns.integer('id').primaryKey()
      columns.string('name')
    })
    const reporting = createDatabase({ connectionName: 'reporting', adapter: createSQLiteAdapter({ filename: ':memory:' }), dialect: createDialect('sqlite') })
    onTestFinished(() => reporting.disconnect())
    await createSchemaService(reporting).createTable('users', (columns) => {
      columns.integer('code').primaryKey()
      columns.string('label')
    })
    configureDB(createConnectionManager({ defaultConnection: 'primary', connections: { primary: db, reporting } }))
    useGeneratedTables({ users: defineGeneratedTable('users', { id: column.integer().primaryKey(), name: column.string() }) })
    useMemoryCache()
    const ReportUser = defineModel('main.users', { connectionName: 'reporting', primaryKey: 'code', timestamps: false })

    expect(await DB.connection('reporting').table('main.users').cache(60).get()).toEqual([])

    expect(ReportUser.definition.untyped).toBe(true)
  })
})

class RollbackRequested extends Error {}

describe.each(integrationDrivers(['postgres'] as const))('%s table identity after a rolled-back search_path change', (driver) => {
  it('refreshes a cached bare read after a write through the qualified name once the rollback restores search_path', async () => {
    const { tenant, name, home } = await openSingleSession(driver)
    useMemoryCache()
    await expect(DB.transaction(async (transaction) => {
      await transaction.unsafeExecute(unsafeSql(`SET LOCAL search_path TO "${tenant}"`))
      expect(await cachedNames(`${home}.${name}`)).toEqual([])
      throw new RollbackRequested()
    })).rejects.toThrow(RollbackRequested)

    expect(await cachedNames(name)).toEqual([])
    await DB.table(`${home}.${name}`).insert({ id: 1, name: 'home' })

    expect(await cachedNames(name)).toEqual(['home'])
  })
})

async function hasCaseInsensitiveTableNames(driver: Driver, db: Awaited<ReturnType<typeof openDatabase>>['db']): Promise<boolean> {
  if (driver === 'sqlite') return true
  if (driver === 'postgres') return false
  const { rows } = await db.getAdapter().query<{ value: number | string }>('SELECT @@lower_case_table_names AS value')
  return Number(rows[0]?.value) !== 0
}

for (const driver of integrationDrivers(['sqlite', 'mysql'] as const)) {
  describe(`${driver} table identity across case variants`, () => {
    it('refreshes a cached read through an upper-case spelling after a write through the lower-case one', async (context) => {
      const { db, table } = await openDatabase(driver)
      if (!await hasCaseInsensitiveTableNames(driver, db)) context.skip()
      useMemoryCache()
      await DB.table(table.tableName).insert({ id: 1, name: 'first', active: false })
      const { bare } = tableSpellings(driver, table.tableName)
      const shouting = bare.toUpperCase()
      expect(await cachedNames(shouting)).toEqual(['first'])

      await DB.table(bare).insert({ id: 2, name: 'second', active: false })
      expect(await cachedNames(shouting)).toEqual(['first', 'second'])

      await DB.table(`${tableSpellings(driver, table.tableName).qualified.split('.')[0]}.${shouting}`).insert({ id: 3, name: 'third', active: false })
      expect(await cachedNames(bare)).toEqual(['first', 'second', 'third'])
    })
  })
}

describe.each(integrationDrivers(['postgres'] as const))('%s table identity across case variants', (driver) => {
  it('keeps quoted case variants of a table name as separate tables', async () => {
    const { schema } = await openDatabase(driver)
    useMemoryCache()
    const lower = uniqueName('holo_case')
    const upper = lower.toUpperCase()
    for (const name of [lower, upper]) {
      await schema.createTable(name, (table) => {
        table.integer('id').primaryKey()
        table.string('name')
      })
      onTestFinished(() => schema.dropTable(name))
    }
    expect(await cachedNames(upper)).toEqual([])

    await DB.table(lower).insert({ id: 1, name: 'lower' })
    await DB.table(`public.${lower}`).insert({ id: 2, name: 'qualified' })

    expect(await cachedNames(upper)).toEqual([])
    expect(await cachedNames(lower)).toEqual(['lower', 'qualified'])
  })
})

const itemColumns = {
  id: column.integer().primaryKey(),
  name: column.string(),
  active: column.boolean(),
  settings: column.json().nullable(),
}

const storedJson = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value

for (const driver of integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)) {
  describe(`${driver} generated table identity before the first query`, () => {
    it('casts the attributes of a model defined by the qualified name of a table generated by its bare name', async () => {
      const { table } = await openDatabase(driver)
      const { bare, qualified } = tableSpellings(driver, table.tableName)
      useGeneratedTables({ items: defineGeneratedTable(bare, itemColumns) })
      const Item = defineModel(qualified, { timestamps: false, fillable: ['id', 'name', 'active', 'settings'] })

      await Item.create({ id: 1, name: 'first', active: true, settings: { theme: 'dark' } })

      expect(storedJson(await DB.table(bare).where('id', 1).value('settings'))).toEqual({ theme: 'dark' })
      expect((await Item.findOrFail(1)).get('settings')).toEqual({ theme: 'dark' })
    })

    it('reads a model defined by the qualified name of a table generated by its bare name through a where() on a cast column', async () => {
      const { table } = await openDatabase(driver)
      const { bare, qualified } = tableSpellings(driver, table.tableName)
      const items = defineGeneratedTable(bare, itemColumns)
      useGeneratedTables({ items })
      await DB.table(items).insert({ id: 1, name: 'first', active: true, settings: { theme: 'dark' } })
      const Item = defineModel(qualified, { timestamps: false })

      const item = await Item.where('settings', { theme: 'dark' }).firstOrFail()

      expect(item.get('settings')).toEqual({ theme: 'dark' })
      expect(item.get('active')).toBe(true)
    })

    it('guards the generated primary key of a model defined by the qualified name before and after its identity resolves', async () => {
      const { db, schema } = await openDatabase(driver, { security })
      const name = uniqueName('holo_keyed')
      const { qualified } = tableSpellings(driver, name)
      await schema.createTable(qualified, (columns) => {
        columns.string('code').primaryKey()
        columns.string('name')
      })
      onTestFinished(() => schema.dropTable(qualified))
      useGeneratedTables({ keyed: defineGeneratedTable(name, { code: column.string().primaryKey(), name: column.string() }) })
      const Keyed = defineModel(qualified, { timestamps: false, fillable: ['*'] })
      expect(() => Keyed.make({ code: 'spoofed' })).toThrow('is not writable')
      expect(Keyed.make({ name: 'unsaved' }).get('name')).toBe('unsaved')
      const Fillable = defineModel(qualified, { timestamps: false, fillable: ['code', 'name'] })
      expect(Fillable.make({ code: 'natural', name: 'natural' }).get('code')).toBe('natural')

      expect(await Keyed.query().first()).toBeUndefined()
      await db.unsafeExecute(unsafeSql(`CREATE TABLE ${quotePath(driver, `${qualified}_other`)} (${quote(driver, 'id')} INTEGER PRIMARY KEY)`))
      onTestFinished(() => schema.dropTable(`${qualified}_other`))

      expect(() => Keyed.make({ code: 'spoofed' })).toThrow('Column "code" is not writable')
    })

    it('copies rows selected by a where() value on the qualified name of a table generated by its bare name', async () => {
      const { table, schema } = await openDatabase(driver)
      const { bare, qualified } = tableSpellings(driver, table.tableName)
      const items = defineGeneratedTable(bare, itemColumns)
      useGeneratedTables({ items })
      const copies = `${qualified}_copies`
      await schema.createTable(copies, (columns) => { columns.integer('id').primaryKey() })
      onTestFinished(() => schema.dropTable(copies))
      await DB.table(items).insert([{ id: 1, name: 'first', active: true, settings: { theme: 'dark' } }, { id: 2, name: 'second', active: true, settings: { theme: 'light' } }])

      await DB.table(copies).insertUsing(['id'], DB.table(qualified).where('settings', { theme: 'dark' }).select('id') as never)

      expect(await DB.table(copies).pluck('id')).toEqual([1])
    })

    it('inserts through the qualified name of a table generated by its bare name with a non-id primary key', async () => {
      const { schema } = await openDatabase(driver)
      const name = uniqueName('holo_coded')
      const { qualified } = tableSpellings(driver, name)
      await schema.createTable(qualified, (columns) => {
        columns.integer('code').primaryKey()
        columns.string('name')
      })
      onTestFinished(() => schema.dropTable(qualified))
      useGeneratedTables({ coded: defineGeneratedTable(name, { code: column.integer().primaryKey(), name: column.string() }) })

      await DB.table(qualified).insertGetId({ code: 7, name: 'seven' })

      expect(await DB.table(qualified).pluck('code')).toEqual([7])
    })

    it('finds a model defined by the qualified name by its generated primary key before any other query', async () => {
      const { schema } = await openDatabase(driver)
      const name = uniqueName('holo_found')
      const { qualified } = tableSpellings(driver, name)
      await schema.createTable(qualified, (columns) => {
        columns.integer('code').primaryKey()
        columns.string('name')
      })
      onTestFinished(() => schema.dropTable(qualified))
      const found = defineGeneratedTable(name, { code: column.integer().primaryKey(), name: column.string() })
      useGeneratedTables({ found })
      const Found = defineModel(qualified, { timestamps: false })

      expect(await Found.find(7)).toBeUndefined()
      await schema.getTables()
      expect(Found.definition.primaryKey).toBe('code')
    })

    it('binds the generated definition of a bare spelling registered by its qualified name after an unrelated cached read', async () => {
      const { table, schema } = await openDatabase(driver)
      const { bare, qualified } = tableSpellings(driver, table.tableName)
      const other = `${bare}_other`
      await schema.createTable(other, (columns) => {
        columns.integer('id').primaryKey()
        columns.string('name')
      })
      onTestFinished(() => schema.dropTable(other))
      const items = defineGeneratedTable(qualified, itemColumns)
      useGeneratedTables({ items, other: defineGeneratedTable(other, { id: column.integer().primaryKey(), name: column.string() }) })
      await DB.table(items).insert({ id: 1, name: 'first', active: true, settings: { theme: 'dark' } })
      useMemoryCache()
      expect(await cachedNames(other)).toEqual([])

      expect(await DB.table(bare).where('settings', { theme: 'dark' }).value('id')).toBe(1)
      expect((await defineModel(bare, { timestamps: false }).firstOrFail()).get('settings')).toEqual({ theme: 'dark' })
    })

    it('compares a JSON value through its toJSON() whether or not the where() is deferred', async () => {
      const { db, table } = await openDatabase(driver)
      const { bare, qualified } = tableSpellings(driver, table.tableName)
      const items = defineGeneratedTable(bare, itemColumns)
      useGeneratedTables({ items })
      const serialized = Object.defineProperty({ theme: 'dark' }, 'toJSON', { value: () => ({ theme: 'light' }), enumerable: false })
      const serializedList = Object.defineProperty(['dark'], 'toJSON', { value: () => ['light'], enumerable: false })
      const serializedDate = Object.defineProperty(new Date('2026-01-01T00:00:00Z'), 'toJSON', { value: () => 'light', enumerable: false })
      await DB.table(items).insert([
        { id: 1, name: 'object', active: true, settings: serialized },
        { id: 2, name: 'list', active: true, settings: serializedList },
        { id: 3, name: 'date', active: true, settings: serializedDate },
      ])

      for (const [value, id] of [[serialized, 1], [serializedList, 2], [serializedDate, 3]] as const) {
        await db.executeSchemaStatement({ sql: 'SELECT 1', source: 'schema' })
        expect(await DB.table(qualified).where('settings', value).value('id')).toBe(id)
        expect(await DB.table(items).where('settings', value).value('id')).toBe(id)
      }
    })

    it('keeps the values a deferred whereIn() and whereBetween() were built with', async () => {
      const { table } = await openDatabase(driver)
      const { bare, qualified } = tableSpellings(driver, table.tableName)
      const items = defineGeneratedTable(bare, itemColumns)
      useGeneratedTables({ items })
      await DB.table(items).insert([1, 2, 3].map(id => ({ id, name: `item ${id}`, active: true, settings: { theme: id === 1 ? 'dark' : 'light' } })))
      const ids = [1]
      const settings = { theme: 'dark' }
      const objectQuery = DB.table(qualified).where('settings', settings)
      const range: [number, number] = [1, 1]
      const inQuery = DB.table(qualified).whereIn('id', ids)
      const betweenQuery = DB.table(qualified).whereBetween('id', range)
      const operatorInQuery = DB.table(qualified).where('id', 'in', ids)
      const operatorBetweenQuery = DB.table(qualified).where('id', 'between', range)

      ids.push(2)
      range[1] = 3
      settings.theme = 'light'

      expect(await inQuery.pluck('id')).toEqual([1])
      expect(await betweenQuery.pluck('id')).toEqual([1])
      expect(await operatorInQuery.pluck('id')).toEqual([1])
      expect(await operatorBetweenQuery.pluck('id')).toEqual([1])
      expect(await objectQuery.pluck('id')).toEqual([1])
    })

    it('compiles a runnable statement synchronously for a where() on the qualified name before the generated definition binds', async () => {
      const { db, table } = await openDatabase(driver)
      const { bare, qualified } = tableSpellings(driver, table.tableName)
      const items = defineGeneratedTable(bare, itemColumns)
      useGeneratedTables({ items })
      await DB.table(items).insert({ id: 1, name: 'first', active: true, settings: null })

      const statement = DB.table(qualified).where('active', true).select('id').toSQL()

      expect(statement.bindings).toEqual([1])
      expect((await db.queryCompiled(statement)).rows.map(row => Number(row.id))).toEqual([1])
    })

    it('normalizes a deferred where() value once its generated definition binds', async () => {
      const { table } = await openDatabase(driver)
      const { bare, qualified } = tableSpellings(driver, table.tableName)
      const items = defineGeneratedTable(bare, itemColumns)
      useGeneratedTables({ items })
      let serializations = 0
      const versioned = Object.defineProperty({}, 'toJSON', { value: () => ({ version: ++serializations }), enumerable: false })
      const query = DB.table(qualified).where('settings', versioned).select('id')
      await DB.table(qualified).where('id', 0).get()

      const first = query.toSQL()
      const second = query.toSQL()
      await query.get()

      expect(second.bindings).toEqual(first.bindings)
      expect(serializations).toBe(1)
    })

    it('keeps an untyped model on its declared primary key while the generated schema is suspended', async () => {
      const { table } = await openDatabase(driver)
      const { bare, qualified } = tableSpellings(driver, table.tableName)
      useGeneratedTables({ items: defineGeneratedTable(bare, { code: column.integer().primaryKey(), name: column.string() }) })

      const primaryKey = runWithoutGeneratedSchema(() => defineModel(qualified, { timestamps: false, fillable: ['*'], name: uniqueName('SuspendedItem') }).definition.primaryKey)
      const writable = runWithoutGeneratedSchema(() => defineModel(qualified, { timestamps: false, fillable: ['*'], name: uniqueName('SuspendedWritable') }).make({ code: 1 }).get('code'))

      expect(primaryKey).toBe('id')
      expect(writable).toBe(1)
    })

    it('normalizes a where() value on the qualified name again after an unrelated schema change', async () => {
      const { table, schema } = await openDatabase(driver)
      const { bare, qualified } = tableSpellings(driver, table.tableName)
      const items = defineGeneratedTable(bare, itemColumns)
      useGeneratedTables({ items })
      await DB.table(items).insert({ id: 1, name: 'first', active: true, settings: { theme: 'dark' } })
      expect(await DB.table(qualified).where('settings', { theme: 'dark' }).value('id')).toBe(1)

      await schema.createTable(`${qualified}_unrelated`, (columns) => { columns.integer('id').primaryKey() })
      onTestFinished(() => schema.dropTable(`${qualified}_unrelated`))

      expect(await DB.table(qualified).where('settings', { theme: 'dark' }).value('id')).toBe(1)
    })

    it('normalizes a where() value on the qualified name of a table generated by its bare name', async () => {
      const { table } = await openDatabase(driver)
      const { bare, qualified } = tableSpellings(driver, table.tableName)
      const items = defineGeneratedTable(bare, itemColumns)
      useGeneratedTables({ items })
      await DB.table(items).insert({ id: 1, name: 'first', active: true, settings: { theme: 'dark' } })

      expect(await DB.table(qualified).where('settings', { theme: 'dark' }).value('id')).toBe(1)
    })
  })
}
