import { randomUUID } from 'node:crypto'
import { belongsTo, clearGeneratedTables, column, defineModel, configureDB, createConnectionManager, createDatabase, createDialect, defineGeneratedTable, registerGeneratedTables, resetDB, resetDatabaseDependencyInvalidationListeners, type DriverAdapter } from '@holo-js/db'
import { createMySQLAdapter } from '../../db-mysql/src'
import { createPostgresAdapter } from '../../db-postgres/src'
import { createSQLiteAdapter } from '../../db-sqlite/src'
import { mysqlIntegration, mysqlTestConnection, postgresIntegration, postgresTestConnection } from '../../../tests/support/real-database'
import { describe, expect, it, onTestFinished } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

type Driver = 'sqlite' | 'mysql' | 'postgres'

function createAdapter(driver: Driver): DriverAdapter {
  if (driver === 'sqlite') {
    return createSQLiteAdapter({ filename: ':memory:' })
  }

  if (driver === 'postgres') {
    return createPostgresAdapter({ config: postgresTestConnection() })
  }

  return createMySQLAdapter({ config: mysqlTestConnection() })
}

function codeColumnDefinition(driver: Driver, primaryKey: boolean): string {
  const key = primaryKey ? ' PRIMARY KEY' : ''
  if (driver === 'sqlite') {
    return `code TEXT${key} COLLATE NOCASE NOT NULL`
  }

  return `code VARCHAR(16) COLLATE ${driver === 'mysql' ? 'utf8mb4_0900_ai_ci' : '"C"'}${key} NOT NULL`
}

async function createCountries(driver: Driver, keyedByCode: boolean) {
  const adapter = createAdapter(driver)
  const tableName = `countries_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const db = createDatabase({ adapter, dialect: createDialect(driver), connectionName: 'main' })
  await adapter.initialize()
  onTestFinished(async () => {
    resetRealtimeRuntime()
    resetDatabaseDependencyInvalidationListeners()
    clearGeneratedTables()
    resetDB()
    await adapter.execute(`DROP TABLE IF EXISTS ${tableName}`)
    await adapter.disconnect()
  })
  if (keyedByCode) {
    await adapter.execute(`CREATE TABLE ${tableName} (${codeColumnDefinition(driver, true)}, label VARCHAR(64) NOT NULL)`)
    registerGeneratedTables({ countries: defineGeneratedTable(tableName, { code: column.string().primaryKey(), label: column.string() }) })
  } else {
    await adapter.execute(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, ${codeColumnDefinition(driver, false)}, label VARCHAR(64) NOT NULL)`)
  }
  await adapter.execute(keyedByCode
    ? `INSERT INTO ${tableName} (code, label) VALUES ('FR', 'France'), ('DE', 'Germany')`
    : `INSERT INTO ${tableName} (id, code, label) VALUES (1, 'FR', 'France'), (2, 'DE', 'Germany')`)
  configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })

  const subscribe = async (code: string) => {
    const snapshots: unknown[] = []
    const query = defineRealtimeQuery({ access: 'public', handler: async ({ db }) => {
      return (await db.table(tableName).where('code', code).first())?.label ?? null
    } })
    await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: (error) => { throw error } })
    return snapshots
  }
  let queryRuns = 0
  const subscribeAll = async (code: string) => {
    const snapshots: unknown[] = []
    const query = defineRealtimeQuery({ access: 'public', handler: async ({ db }) => {
      queryRuns += 1
      return (await db.table(tableName).where('code', code).get()).map(row => row.label).sort()
    } })
    await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: (error) => { throw error } })
    return snapshots
  }
  const mutate = (handler: Parameters<typeof defineRealtimeMutation>[0]['handler']) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
  const update = (code: string, label: string) => mutate(({ db }) => db.table(tableName).where('code', code).update({ label }))
  const upsert = (code: string, label: string) => mutate(({ db }) => keyedByCode
    ? db.table(tableName).upsert({ code, label }, ['code'], ['label'])
    : db.table(tableName).upsert({ id: code === 'de' || code === 'DE' ? 2 : 1, code, label }, ['id'], ['code', 'label']))
  const insert = (id: number, code: string, label: string) => mutate(({ db }) => db.table(tableName).insert({ id, code, label }))
  const writeBehindRealtime = (code: string, label: string) => adapter.execute(`UPDATE ${tableName} SET label = '${label}' WHERE code = '${code}'`)

  return { insert, queryRuns: () => queryRuns, subscribe, subscribeAll, update, upsert, writeBehindRealtime }
}

function registerCaseInsensitiveScenarios(driver: Exclude<Driver, 'postgres'>) {
  for (const keyedByCode of [true, false]) {
    const shape = keyedByCode ? 'keyed by the string column' : 'filtered by a non-key string column'

    it(`refreshes a subscription after an update matched by a case-differing value, ${shape}`, async () => {
      const countries = await createCountries(driver, keyedByCode)
      const snapshots = await countries.subscribe('FR')
      expect(snapshots.at(-1)).toBe('France')

      await countries.update('fr', 'République')

      expect(snapshots.at(-1)).toBe('République')
    })

    it(`refreshes a subscription after an upsert matched by a case-differing value, ${shape}`, async () => {
      const countries = await createCountries(driver, keyedByCode)
      const snapshots = await countries.subscribe('DE')
      expect(snapshots.at(-1)).toBe('Germany')

      await countries.upsert('de', 'Deutschland')

      expect(snapshots.at(-1)).toBe('Deutschland')
    })
  }

  it('refreshes a subscription after an insert of a case-differing value in a non-key string column', async () => {
    const countries = await createCountries(driver, false)
    const snapshots = await countries.subscribeAll('DE')
    expect(snapshots.at(-1)).toEqual(['Germany'])

    await countries.insert(3, 'de', 'Deutschland')

    expect(snapshots.at(-1)).toEqual(['Deutschland', 'Germany'])
  })

  it('re-runs a subscription after an insert of a string it cannot rule out under the collation', async () => {
    const countries = await createCountries(driver, false)
    const snapshots = await countries.subscribeAll('DE')

    await countries.insert(3, 'IT', 'Italy')

    expect(countries.queryRuns()).toBe(2)
    expect(snapshots).toEqual([['Germany']])
  })
}

async function createStringIdCountries(driver: Driver, postgresIdType = 'VARCHAR(16) COLLATE "C"') {
  const adapter = createAdapter(driver)
  const tableName = `countries_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const db = createDatabase({ adapter, dialect: createDialect(driver), connectionName: 'main' })
  await adapter.initialize()
  onTestFinished(async () => {
    resetRealtimeRuntime()
    resetDatabaseDependencyInvalidationListeners()
    clearGeneratedTables()
    resetDB()
    await adapter.execute(`DROP TABLE IF EXISTS ${tableName}`)
    await adapter.disconnect()
  })
  const id = driver === 'sqlite' ? 'id TEXT PRIMARY KEY COLLATE NOCASE' : `id ${driver === 'mysql' ? 'VARCHAR(16) COLLATE utf8mb4_0900_ai_ci' : postgresIdType} PRIMARY KEY`
  await adapter.execute(`CREATE TABLE ${tableName} (${id}, label VARCHAR(64) NOT NULL)`)
  const ids = driver === 'postgres' && postgresIdType.endsWith('[]') ? ["'{FR}'", "'{DE}'"] : ["'FR'", "'DE'"]
  await adapter.execute(`INSERT INTO ${tableName} (id, label) VALUES (${ids[0]}, 'France'), (${ids[1]}, 'Germany')`)
  registerGeneratedTables({ countries: defineGeneratedTable(tableName, { id: column.string().primaryKey(), label: column.string() }) })
  configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  let queryRuns = 0
  const subscribe = async (handler: Parameters<typeof defineRealtimeQuery>[0]['handler']) => {
    const snapshots: unknown[] = []
    const counted: typeof handler = (context) => {
      queryRuns += 1
      return handler(context)
    }
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: counted }), {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: (error) => { throw error } })
    return snapshots
  }
  const mutate = (handler: Parameters<typeof defineRealtimeMutation>[0]['handler']) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
  const update = (value: string, label: string) => mutate(({ db }) => db.table(tableName).where('id', value).update({ label }))
  const upsert = (value: string, label: string) => mutate(({ db }) => db.table(tableName).upsert({ id: value, label }, ['id'], ['label']))
  return { queryRuns: () => queryRuns, subscribe, tableName, update, upsert }
}

async function createNumericIdCountries(driver: Driver) {
  const adapter = createAdapter(driver)
  const tableName = `countries_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const db = createDatabase({ adapter, dialect: createDialect(driver), connectionName: 'main' })
  await adapter.initialize()
  onTestFinished(async () => {
    resetRealtimeRuntime()
    resetDatabaseDependencyInvalidationListeners()
    clearGeneratedTables()
    resetDB()
    await adapter.execute(`DROP TABLE IF EXISTS ${tableName}`)
    await adapter.disconnect()
  })
  await adapter.execute(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, label VARCHAR(64) NOT NULL, rank_no INTEGER NOT NULL)`)
  await adapter.execute(`INSERT INTO ${tableName} (id, label, rank_no) VALUES (5, 'France', 1), (6, 'Germany', 2)`)
  registerGeneratedTables({ countries: defineGeneratedTable(tableName, { id: column.integer().primaryKey(), label: column.string(), rank_no: column.integer() }) })
  configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  const subscribe = async (handler: Parameters<typeof defineRealtimeQuery>[0]['handler']) => {
    const snapshots: unknown[] = []
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: (error) => { throw error } })
    return snapshots
  }
  const mutate = (handler: Parameters<typeof defineRealtimeMutation>[0]['handler']) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
  return {
    subscribeById: (value: number | string) => subscribe(async ({ db }) => await db.table(tableName).where('id', value).first()),
    subscribeByRank: (value: number | string) => subscribe(async ({ db }) => (await db.table(tableName).where('rank_no', value).get()).map(row => row.label).sort()),
    update: (value: number | string, label: string) => mutate(({ db }) => db.table(tableName).where('id', value).update({ label })),
    insert: (id: number, label: string, rank: number | string) => mutate(({ db }) => db.table(tableName).insert({ id, label, rank_no: rank })),
  }
}

function registerTextNumberScenarios(driver: Driver) {
  it('refreshes a subscription by a numeric id after an update matched by the same id as text', async () => {
    const countries = await createNumericIdCountries(driver)
    const snapshots = await countries.subscribeById(5)

    await countries.update('5', 'République')

    expect(snapshots.at(-1)).toEqual({ id: 5, label: 'République', rank_no: 1 })
  })

  it('refreshes a subscription by an id as text after an update matched by the numeric id', async () => {
    const countries = await createNumericIdCountries(driver)
    const snapshots = await countries.subscribeById('5')

    await countries.update(5, 'République')

    expect(snapshots.at(-1)).toEqual({ id: 5, label: 'République', rank_no: 1 })
  })

  it('refreshes a subscription filtered by a number as text after an insert of the number', async () => {
    const countries = await createNumericIdCountries(driver)
    const snapshots = await countries.subscribeByRank('2')

    await countries.insert(7, 'Italy', 2)

    expect(snapshots.at(-1)).toEqual(['Germany', 'Italy'])
  })

  it('refreshes a subscription filtered by a number after an insert of the number as text', async () => {
    const countries = await createNumericIdCountries(driver)
    const snapshots = await countries.subscribeByRank(2)

    await countries.insert(7, 'Italy', '2')

    expect(snapshots.at(-1)).toEqual(['Germany', 'Italy'])
  })
}

function registerStringIdScenarios(driver: Exclude<Driver, 'postgres'>) {
  it('patches a subscription by a string id in one read after an update by the identical id', async () => {
    const countries = await createStringIdCountries(driver)
    const snapshots = await countries.subscribe(async ({ db }) => await db.table(countries.tableName).where('id', 'FR').first())

    await countries.update('FR', 'République')

    expect(snapshots.at(-1)).toEqual({ id: 'FR', label: 'République' })
  })

  it('refreshes a subscription by a string id after an upsert matched by a case-differing id', async () => {
    const countries = await createStringIdCountries(driver)
    const snapshots = await countries.subscribe(async ({ db }) => await db.table(countries.tableName).where('id', 'DE').first())

    await countries.upsert('de', 'Deutschland')

    expect(snapshots.at(-1)).toEqual({ id: 'DE', label: 'Deutschland' })
  })

  it('refreshes a subscription by a string id after an update matched by a case-differing id', async () => {
    const countries = await createStringIdCountries(driver)
    const snapshots = await countries.subscribe(async ({ db }) => await db.table(countries.tableName).where('id', 'FR').first())

    await countries.update('fr', 'République')

    expect(snapshots.at(-1)).toEqual({ id: 'FR', label: 'République' })
  })

  it('refreshes a subscription over all rows after an update matched by a case-differing string id', async () => {
    const countries = await createStringIdCountries(driver)
    const snapshots = await countries.subscribe(async ({ db }) => await db.table(countries.tableName).orderBy('id').get())

    await countries.update('fr', 'République')

    expect(snapshots.at(-1)).toEqual([{ id: 'DE', label: 'Germany' }, { id: 'FR', label: 'République' }])
  })
}

it('keeps refreshing an eager-loaded relation keyed by numeric text after the parent rows are patched', async () => {
  const adapter = createAdapter('sqlite')
  const db = createDatabase({ adapter, dialect: createDialect('sqlite'), connectionName: 'main' })
  await adapter.initialize()
  onTestFinished(async () => {
    resetRealtimeRuntime()
    resetDatabaseDependencyInvalidationListeners()
    clearGeneratedTables()
    resetDB()
    await adapter.disconnect()
  })
  await adapter.execute('CREATE TABLE authors (code TEXT PRIMARY KEY, name TEXT NOT NULL)')
  await adapter.execute('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL, author_code TEXT NOT NULL)')
  await adapter.execute(`INSERT INTO authors VALUES ('5', 'Ada')`)
  await adapter.execute(`INSERT INTO posts VALUES (1, 'First', '5')`)
  configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  const Author = defineModel(defineGeneratedTable('authors', { code: column.string().primaryKey(), name: column.string() }), { timestamps: false })
  const Post = defineModel(defineGeneratedTable('posts', { id: column.id(), title: column.string(), author_code: column.string() }), {
    timestamps: false,
    relations: { author: belongsTo(() => Author, 'author_code', 'code') },
  })
  const snapshots: unknown[] = []
  await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: async ({ db }) => await db.model(Post).query().with('author').orderBy('id').get() }), {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: (error) => { throw error } })
  const mutate = (handler: Parameters<typeof defineRealtimeMutation>[0]['handler']) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))

  await mutate(({ db }) => db.table('posts').where('id', 1).update({ title: 'Renamed' }))
  await mutate(({ db }) => db.table('authors').where('code', '5').update({ name: 'Grace' }))

  expect(snapshots.at(-1)).toEqual([{ id: 1, title: 'Renamed', author_code: '5', author: { code: '5', name: 'Grace' } }])
})

describe('realtime invalidation on a NOCASE column on sqlite', () => {
  registerCaseInsensitiveScenarios('sqlite')
  registerStringIdScenarios('sqlite')
  registerTextNumberScenarios('sqlite')
})

describe.skipIf(!mysqlIntegration)('realtime invalidation on a default _ci column on mysql', () => {
  registerCaseInsensitiveScenarios('mysql')
  registerStringIdScenarios('mysql')
  registerTextNumberScenarios('mysql')

  it('refreshes a subscription by an id as non-numeric text after an update matched by the number mysql converts it to', async () => {
    const countries = await createNumericIdCountries('mysql')
    const snapshots = await countries.subscribeById('5abc')

    await countries.update(5, 'République')

    expect(snapshots.at(-1)).toEqual({ id: 5, label: 'République', rank_no: 1 })
  })
})

describe.skipIf(!postgresIntegration)('realtime invalidation on a case-sensitive column on postgres', () => {
  registerTextNumberScenarios('postgres')

  it('refreshes eager-loaded relations keyed by numeric and non-numeric text after inserting the missing numeric key', async () => {
    const adapter = createAdapter('postgres')
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
    const authors = `authors_${suffix}`
    const posts = `posts_${suffix}`
    const db = createDatabase({ adapter, dialect: createDialect('postgres'), connectionName: 'main' })
    await adapter.initialize()
    onTestFinished(async () => {
      resetRealtimeRuntime()
      resetDatabaseDependencyInvalidationListeners()
      clearGeneratedTables()
      resetDB()
      await adapter.execute(`DROP TABLE IF EXISTS ${posts}`)
      await adapter.execute(`DROP TABLE IF EXISTS ${authors}`)
      await adapter.disconnect()
    })
    await adapter.execute(`CREATE TABLE ${authors} (code TEXT PRIMARY KEY, name TEXT NOT NULL)`)
    await adapter.execute(`CREATE TABLE ${posts} (id INTEGER PRIMARY KEY, title TEXT NOT NULL, author_code TEXT NOT NULL)`)
    await adapter.execute(`INSERT INTO ${authors} VALUES ('5', 'Ada'), ('abc', 'Alan')`)
    await adapter.execute(`INSERT INTO ${posts} VALUES (1, 'First', '5'), (2, 'Second', 'abc'), (3, 'Third', '7')`)
    configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const Author = defineModel(defineGeneratedTable(authors, { code: column.string().primaryKey(), name: column.string() }), { timestamps: false })
    const Post = defineModel(defineGeneratedTable(posts, { id: column.id(), title: column.string(), author_code: column.string() }), {
      timestamps: false,
      relations: { author: belongsTo(() => Author, 'author_code', 'code') },
    })
    const snapshots: unknown[] = []
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: async ({ db }) => await db.model(Post).query().with('author').orderBy('id').get() }), {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: (error) => { throw error } })
    const mutate = (handler: Parameters<typeof defineRealtimeMutation>[0]['handler']) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))

    await mutate(({ db }) => db.table(posts).where('id', 1).update({ title: 'Renamed' }))
    await mutate(({ db }) => db.table(authors).insert({ code: '7', name: 'Grace' }))

    expect(snapshots.at(-1)).toEqual([
      { id: 1, title: 'Renamed', author_code: '5', author: { code: '5', name: 'Ada' } },
      { id: 2, title: 'Second', author_code: 'abc', author: { code: 'abc', name: 'Alan' } },
      { id: 3, title: 'Third', author_code: '7', author: { code: '7', name: 'Grace' } },
    ])
  })

  it('refreshes a subscription filtered by a citext array after an update matched by a case-differing array', async () => {
    const setupAdapter = createAdapter('postgres')
    await setupAdapter.initialize()
    try {
      await setupAdapter.execute('CREATE EXTENSION IF NOT EXISTS citext')
    } catch (error) {
      if ((await setupAdapter.query(`SELECT 1 FROM pg_extension WHERE extname = 'citext'`)).rows.length === 0) {
        throw error
      }
    } finally {
      await setupAdapter.disconnect()
    }
    const adapter = createAdapter('postgres')
    const tableName = `countries_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const db = createDatabase({ adapter, dialect: createDialect('postgres'), connectionName: 'main' })
    await adapter.initialize()
    onTestFinished(async () => {
      resetRealtimeRuntime()
      resetDatabaseDependencyInvalidationListeners()
      resetDB()
      await adapter.execute(`DROP TABLE IF EXISTS ${tableName}`)
      await adapter.disconnect()
    })
    await adapter.execute(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, code citext[] NOT NULL, label VARCHAR(64) NOT NULL)`)
    await adapter.execute(`INSERT INTO ${tableName} (id, code, label) VALUES (1, '{FR}', 'France'), (2, '{DE}', 'Germany')`)
    configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const snapshots: unknown[] = []
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: async ({ db }) => await db.table(tableName).where('code', ['FR']).get() }), {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: ({ db }) => db.table(tableName).where('code', ['fr']).update({ label: 'République' }) }))

    expect((snapshots.at(-1) as readonly Readonly<Record<string, unknown>>[]).map(row => row.label)).toEqual(['République'])
  })

  it('refreshes a subscription by a citext array id after an update matched by a case-differing array', async () => {
    const setupAdapter = createAdapter('postgres')
    await setupAdapter.initialize()
    try {
      await setupAdapter.execute('CREATE EXTENSION IF NOT EXISTS citext')
    } catch (error) {
      if ((await setupAdapter.query(`SELECT 1 FROM pg_extension WHERE extname = 'citext'`)).rows.length === 0) {
        throw error
      }
    } finally {
      await setupAdapter.disconnect()
    }
    const countries = await createStringIdCountries('postgres', 'citext[]')
    const snapshots = await countries.subscribe(async ({ db }) => await db.table(countries.tableName).where('id', ['FR']).first())

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: ({ db }) => db.table(countries.tableName).where('id', ['fr']).update({ label: 'République' }) }))

    expect((snapshots.at(-1) as Readonly<Record<string, unknown>> | null)?.label).toBe('République')
  })

  for (const [type, setup, exists] of [
    ['citext', 'CREATE EXTENSION IF NOT EXISTS citext', `SELECT 1 FROM pg_extension WHERE extname = 'citext'`],
    ['VARCHAR(16) COLLATE holo_case_insensitive', `CREATE COLLATION IF NOT EXISTS holo_case_insensitive (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`, `SELECT 1 FROM pg_collation WHERE collname = 'holo_case_insensitive'`],
  ] as const) {
    it(`refreshes a subscription by a ${type} id after an update matched by a case-differing id`, async () => {
      const setupAdapter = createAdapter('postgres')
      await setupAdapter.initialize()
      try {
        await setupAdapter.execute(setup)
      } catch (error) {
        if ((await setupAdapter.query(exists)).rows.length === 0) {
          throw error
        }
      } finally {
        await setupAdapter.disconnect()
      }
      const countries = await createStringIdCountries('postgres', type)
      const snapshots = await countries.subscribe(async ({ db }) => await db.table(countries.tableName).where('id', 'FR').first())

      await countries.update('fr', 'République')

      expect(snapshots.at(-1)).toEqual({ id: 'FR', label: 'République' })
    })
  }

  for (const keyedByCode of [true, false]) {
    const shape = keyedByCode ? 'keyed by the string column' : 'filtered by a non-key string column'

    it(`does not refresh a subscription after an update of a case-differing value, ${shape}`, async () => {
      const countries = await createCountries('postgres', keyedByCode)
      const snapshots = await countries.subscribe('FR')
      await countries.writeBehindRealtime('FR', 'Hidden')

      await countries.update('fr', 'République')

      expect(snapshots).toEqual(['France'])
    })
  }

  it('does not refresh a subscription after an insert of a case-differing value in a non-key string column', async () => {
    const countries = await createCountries('postgres', false)
    const snapshots = await countries.subscribeAll('DE')
    await countries.writeBehindRealtime('DE', 'Hidden')

    await countries.insert(3, 'de', 'Deutschland')

    expect(snapshots).toEqual([['Germany']])
  })

  it('does not re-run a subscription by a string id after an update of a case-differing id', async () => {
    const countries = await createStringIdCountries('postgres')
    const snapshots = await countries.subscribe(async ({ db }) => await db.table(countries.tableName).where('id', 'FR').first())

    await countries.update('fr', 'République')

    expect(countries.queryRuns()).toBe(1)
    expect(snapshots).toEqual([{ id: 'FR', label: 'France' }])
  })

  it('does not re-run a subscription after an insert of a different string', async () => {
    const countries = await createCountries('postgres', false)
    const snapshots = await countries.subscribeAll('DE')

    await countries.insert(3, 'IT', 'Italy')

    expect(countries.queryRuns()).toBe(1)
    expect(snapshots).toEqual([['Germany']])
  })
})
