import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { DB, clearGeneratedTables, column, registerGeneratedTables } from '../src'
import { defineTable } from './support/internal'
import { openDatabase } from './support/database'

type Driver = 'sqlite' | 'postgres' | 'mysql'

async function ensurePostgresObject(create: string, exists: string) {
  const { adapter } = await openDatabase('postgres')
  try {
    await adapter.execute(create)
  } catch (error) {
    const found = await adapter.query(exists)
    if (found.rows.length === 0) {
      throw error
    }
  }
}

const ensureCitext = () => ensurePostgresObject('CREATE EXTENSION IF NOT EXISTS citext', `SELECT 1 FROM pg_extension WHERE extname = 'citext'`)
const ensureCaseInsensitiveCollation = () => ensurePostgresObject(
  `CREATE COLLATION IF NOT EXISTS holo_case_insensitive (provider = icu, locale = 'und-u-ks-level2', deterministic = false)`,
  `SELECT 1 FROM pg_collation WHERE collname = 'holo_case_insensitive'`,
)

async function createCountries(driver: Driver, postgresCodeType = 'VARCHAR(16) COLLATE "C"') {
  const { adapter } = await openDatabase(driver)
  const name = `countries_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
  registerGeneratedTables({ countries: defineTable(name, { code: column.string().primaryKey(), label: column.string() }) })
  const code = driver === 'sqlite'
    ? 'code TEXT PRIMARY KEY COLLATE NOCASE NOT NULL'
    : `code ${driver === 'mysql' ? 'VARCHAR(16) COLLATE utf8mb4_0900_ai_ci' : postgresCodeType} PRIMARY KEY NOT NULL`
  await adapter.execute(`CREATE TABLE ${name} (${code}, label VARCHAR(64) NOT NULL)`)
  onTestFinished(async () => {
    clearGeneratedTables()
    resetCacheRuntime()
    await adapter.execute(`DROP TABLE IF EXISTS ${name}`)
  })
  await adapter.execute(`INSERT INTO ${name} (code, label) VALUES ('FR', 'France'), ('DE', 'Germany')`)
  return {
    cachedLabel: async (value: string) => (await DB.table(name).where('code', value).cache(60).first())?.label,
    update: (value: string, label: string) => DB.table(name).where('code', value).update({ label }),
    upsert: (value: string, label: string) => DB.table(name).upsert({ code: value, label }, ['code'], ['label']),
    writeBehindTheCache: (value: string, label: string) => adapter.execute(`UPDATE ${name} SET label = '${label}' WHERE code = '${value}'`),
  }
}

function registerCaseInsensitiveScenarios(driver: Exclude<Driver, 'postgres'>) {
  it('refreshes a cached read by key after an update matched by a case-differing key', async () => {
    const countries = await createCountries(driver)
    expect(await countries.cachedLabel('FR')).toBe('France')

    await countries.update('fr', 'République')

    expect(await countries.cachedLabel('FR')).toBe('République')
  })

  it('refreshes a cached read by key after an upsert matched by a case-differing key', async () => {
    const countries = await createCountries(driver)
    expect(await countries.cachedLabel('DE')).toBe('Germany')

    await countries.upsert('de', 'Deutschland')

    expect(await countries.cachedLabel('DE')).toBe('Deutschland')
  })
}

async function createTickets(driver: Driver, idType: 'INTEGER' | 'NUMERIC' = 'INTEGER') {
  const { adapter } = await openDatabase(driver)
  const name = `tickets_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
  registerGeneratedTables({ tickets: defineTable(name, { id: (idType === 'INTEGER' ? column.integer() : column.decimal()).primaryKey(), label: column.string() }) })
  await adapter.execute(`CREATE TABLE ${name} (id ${idType} PRIMARY KEY, label VARCHAR(64) NOT NULL)`)
  onTestFinished(async () => {
    clearGeneratedTables()
    resetCacheRuntime()
    await adapter.execute(`DROP TABLE IF EXISTS ${name}`)
  })
  await adapter.execute(`INSERT INTO ${name} (id, label) VALUES (5, 'first'), (6, 'second')`)
  return {
    cachedLabel: async (value: number | string) => (await DB.table(name).where('id', value).cache(60).first())?.label,
    update: (value: number | string, label: string) => DB.table(name).where('id', value).update({ label }),
  }
}

function registerTextNumberScenarios(driver: Driver) {
  it('refreshes a cached read by a numeric key after an update matched by the key as text', async () => {
    const tickets = await createTickets(driver)
    expect(await tickets.cachedLabel(5)).toBe('first')

    await tickets.update('5', 'renamed')

    expect(await tickets.cachedLabel(5)).toBe('renamed')
  })

  it('refreshes a cached read by a key as text after an update matched by the numeric key', async () => {
    const tickets = await createTickets(driver)
    expect(await tickets.cachedLabel('5')).toBe('first')

    await tickets.update(5, 'renamed')

    expect(await tickets.cachedLabel('5')).toBe('renamed')
  })

  it('keeps a cached read by another numeric key after an update matched by a key as text', async () => {
    const tickets = await createTickets(driver)
    expect(await tickets.cachedLabel(6)).toBe('second')

    await tickets.update('5', 'renamed')

    expect(await tickets.cachedLabel(6)).toBe('second')
  })
}

describe('query cache invalidation by a NOCASE key on sqlite', () => {
  registerTextNumberScenarios('sqlite')
  registerCaseInsensitiveScenarios('sqlite')
})

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('query cache invalidation by a default _ci key on mysql', () => {
  registerCaseInsensitiveScenarios('mysql')
  registerTextNumberScenarios('mysql')

  it('refreshes a cached read by a key as non-numeric text after an update matched by the number mysql converts it to', async () => {
    const tickets = await createTickets('mysql')
    expect(await tickets.cachedLabel('5abc')).toBe('first')

    await tickets.update(5, 'renamed')

    expect(await tickets.cachedLabel('5abc')).toBe('renamed')
  })
})

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('query cache invalidation by a case-sensitive key on postgres', () => {
  registerTextNumberScenarios('postgres')

  it('refreshes a cached read by a numeric key as text with an exponent separator after an update matched by the number', async () => {
    const tickets = await createTickets('postgres', 'NUMERIC')
    expect(await tickets.cachedLabel('5e0_0')).toBe('first')

    await tickets.update(5, 'renamed')

    expect(await tickets.cachedLabel('5e0_0')).toBe('renamed')
  })

  it('commits a write in a transaction when reading its case-insensitive columns fails', async () => {
    const { db, adapter } = await openDatabase('postgres', {
      wrapAdapter: inner => new Proxy(inner, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver)
          if ((property === 'query' || property === 'introspect') && typeof value === 'function') {
            return (sql: string, ...rest: unknown[]) => sql.includes('FROM pg_catalog.pg_attribute')
              ? target.query('SELECT 1 / 0', [])
              : Reflect.apply(value, target, [sql, ...rest])
          }
          return typeof value === 'function' ? value.bind(target) : value
        },
      }),
    })
    const name = `countries_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
    await adapter.execute(`CREATE TABLE ${name} (code VARCHAR(16) PRIMARY KEY, label VARCHAR(64) NOT NULL)`)
    onTestFinished(async () => {
      resetCacheRuntime()
      await adapter.execute(`DROP TABLE IF EXISTS ${name}`)
    })
    await adapter.execute(`INSERT INTO ${name} (code, label) VALUES ('FR', 'France')`)

    await db.transaction(async transaction => await transaction.table(name).where('code', 'FR').update({ label: 'République' }))

    expect((await adapter.query<{ label: string }>(`SELECT label FROM ${name} WHERE code = 'FR'`)).rows[0]?.label).toBe('République')
  })

  it('refreshes a cached read by a citext key after an update matched by a case-differing key', async () => {
    await ensureCitext()
    const countries = await createCountries('postgres', 'citext')
    expect(await countries.cachedLabel('FR')).toBe('France')

    await countries.update('fr', 'République')

    expect(await countries.cachedLabel('FR')).toBe('République')
  })

  it('refreshes a cached read by a key whose domain is built on citext after an update matched by a case-differing key', async () => {
    await ensureCitext()
    const domain = `country_code_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const { adapter } = await openDatabase('postgres')
    await adapter.execute(`CREATE DOMAIN ${domain}_base AS citext`)
    await adapter.execute(`CREATE DOMAIN ${domain} AS ${domain}_base`)
    try {
      const countries = await createCountries('postgres', domain)
      expect(await countries.cachedLabel('FR')).toBe('France')

      await countries.update('fr', 'République')

      expect(await countries.cachedLabel('FR')).toBe('République')
    } finally {
      await adapter.execute(`DROP DOMAIN IF EXISTS ${domain}_base CASCADE`)
    }
  })

  it('refreshes a cached read by a citext array key after an update matched by a case-differing array', async () => {
    await ensureCitext()
    const { adapter } = await openDatabase('postgres')
    const name = `countries_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
    await adapter.execute(`CREATE TABLE ${name} (id citext[] PRIMARY KEY, label VARCHAR(64) NOT NULL)`)
    onTestFinished(async () => {
      resetCacheRuntime()
      await adapter.execute(`DROP TABLE IF EXISTS ${name}`)
    })
    await adapter.execute(`INSERT INTO ${name} (id, label) VALUES ('{FR}', 'France')`)
    const cachedLabel = async () => (await DB.table(name).where('id', ['FR']).cache(60).first())?.label
    expect(await cachedLabel()).toBe('France')

    await DB.table(name).where('id', ['fr']).update({ label: 'République' })

    expect(await cachedLabel()).toBe('République')
  })

  it('refreshes a cached read by a key with a nondeterministic collation after an update matched by a case-differing key', async () => {
    await ensureCaseInsensitiveCollation()
    const countries = await createCountries('postgres', 'VARCHAR(16) COLLATE holo_case_insensitive')
    expect(await countries.cachedLabel('FR')).toBe('France')

    await countries.update('fr', 'République')

    expect(await countries.cachedLabel('FR')).toBe('République')
  })

  it('keeps a cached read by key after an update of a case-differing key', async () => {
    const countries = await createCountries('postgres')
    expect(await countries.cachedLabel('FR')).toBe('France')
    await countries.writeBehindTheCache('FR', 'Hidden')

    await countries.update('fr', 'République')

    expect(await countries.cachedLabel('FR')).toBe('France')
  })

  it('keeps a cached read by key after an upsert of a case-differing key', async () => {
    const countries = await createCountries('postgres')
    expect(await countries.cachedLabel('DE')).toBe('Germany')
    await countries.writeBehindTheCache('DE', 'Hidden')

    await countries.upsert('de', 'Deutschland')

    expect(await countries.cachedLabel('DE')).toBe('Germany')
  })
})
