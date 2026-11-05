import { randomUUID } from 'node:crypto'
import { clearGeneratedTables, column, configureDB, createConnectionManager, createDatabase, createDialect, defineGeneratedTable, registerGeneratedTables, resetDB, resetDatabaseDependencyInvalidationListeners, type DriverAdapter } from '@holo-js/db'
import { createMySQLAdapter } from '../../db-mysql/src'
import { createPostgresAdapter } from '../../db-postgres/src'
import { createSQLiteAdapter } from '../../db-sqlite/src'
import { describe, expect, it, onTestFinished } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

type Driver = 'sqlite' | 'mysql' | 'postgres'

function createAdapter(driver: Driver): DriverAdapter {
  if (driver === 'sqlite') {
    return createSQLiteAdapter({ filename: ':memory:' })
  }

  if (driver === 'postgres') {
    return createPostgresAdapter({ config: {
      host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
      port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
      user: process.env.HOLO_POSTGRES_USER ?? 'postgres',
      password: process.env.HOLO_POSTGRES_PASSWORD,
      database: process.env.HOLO_POSTGRES_DATABASE ?? 'postgres',
    } })
  }

  return createMySQLAdapter({ config: {
    host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
    user: process.env.HOLO_MYSQL_USER ?? 'root',
    password: process.env.HOLO_MYSQL_PASSWORD ?? '',
    database: process.env.HOLO_MYSQL_DATABASE ?? 'mysql',
  } })
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

async function createStringIdCountries(driver: Driver) {
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
  const id = driver === 'sqlite' ? 'id TEXT PRIMARY KEY COLLATE NOCASE' : `id VARCHAR(16) COLLATE ${driver === 'mysql' ? 'utf8mb4_0900_ai_ci' : '"C"'} PRIMARY KEY`
  await adapter.execute(`CREATE TABLE ${tableName} (${id}, label VARCHAR(64) NOT NULL)`)
  await adapter.execute(`INSERT INTO ${tableName} (id, label) VALUES ('FR', 'France'), ('DE', 'Germany')`)
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
  await adapter.execute(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, label VARCHAR(64) NOT NULL)`)
  await adapter.execute(`INSERT INTO ${tableName} (id, label) VALUES (5, 'France'), (6, 'Germany')`)
  registerGeneratedTables({ countries: defineGeneratedTable(tableName, { id: column.integer().primaryKey(), label: column.string() }) })
  configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  const snapshots: unknown[] = []
  await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: async ({ db }) => await db.table(tableName).where('id', 5).first() }), {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: (error) => { throw error } })
  const updateByText = (value: string, label: string) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: ({ db }) => db.table(tableName).where('id', value).update({ label }) }))
  return { snapshots, updateByText }
}

function registerTextNumberIdScenario(driver: Exclude<Driver, 'postgres'>) {
  it('refreshes a subscription by a numeric id after an update matched by the same id as text', async () => {
    const countries = await createNumericIdCountries(driver)

    await countries.updateByText('5', 'République')

    expect(countries.snapshots.at(-1)).toEqual({ id: 5, label: 'République' })
  })
}

function registerStringIdScenarios(driver: Exclude<Driver, 'postgres'>) {
  it('patches a subscription by a string id in one read after an update by the identical id', async () => {
    const countries = await createStringIdCountries(driver)
    const snapshots = await countries.subscribe(async ({ db }) => await db.table(countries.tableName).where('id', 'FR').first())

    await countries.update('FR', 'République')

    expect(snapshots.at(-1)).toEqual({ id: 'FR', label: 'République' })
    expect(countries.queryRuns()).toBe(1)
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

describe('realtime invalidation on a NOCASE column on sqlite', () => {
  registerCaseInsensitiveScenarios('sqlite')
  registerStringIdScenarios('sqlite')
  registerTextNumberIdScenario('sqlite')
})

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('realtime invalidation on a default _ci column on mysql', () => {
  registerCaseInsensitiveScenarios('mysql')
  registerStringIdScenarios('mysql')
  registerTextNumberIdScenario('mysql')
})

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('realtime invalidation on a case-sensitive column on postgres', () => {
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
