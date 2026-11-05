import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { DB, clearGeneratedTables, column, registerGeneratedTables } from '../src'
import { resolveCaseInsensitiveColumns } from '../src/schema/caseInsensitiveColumns'
import { defineTable } from './support/internal'
import { mysqlIntegration, openDatabase, postgresIntegration } from './support/database'

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

async function createCountries(driver: Driver, codeType = driver === 'postgres' ? 'VARCHAR(16) COLLATE "C"' : undefined) {
  const { adapter } = await openDatabase(driver)
  const name = `countries_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
  registerGeneratedTables({ countries: defineTable(name, { code: column.string().primaryKey(), label: column.string() }) })
  const code = codeType === undefined
    ? driver === 'sqlite' ? 'code TEXT PRIMARY KEY COLLATE NOCASE NOT NULL' : 'code VARCHAR(16) COLLATE utf8mb4_0900_ai_ci PRIMARY KEY NOT NULL'
    : `code ${codeType} PRIMARY KEY NOT NULL`
  await adapter.execute(`CREATE TABLE ${name} (${code}, label VARCHAR(64) NOT NULL)`)
  onTestFinished(async () => {
    clearGeneratedTables()
    resetCacheRuntime()
    await adapter.execute(`DROP TABLE IF EXISTS ${name}`)
  })
  await adapter.execute(`INSERT INTO ${name} (code, label) VALUES ('FR', 'France'), ('DE', 'Germany')`)
  return {
    cachedLabel: async (value: string | number) => (await DB.table(name).where('code', value).orderBy('code').cache(60).first())?.label,
    update: (value: string | number, label: string) => DB.table(name).where('code', value).update({ label }),
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

  it('refreshes a cached read by another key after an update of a case-insensitive key', async () => {
    const countries = await createCountries(driver)
    expect(await countries.cachedLabel('DE')).toBe('Germany')
    await countries.writeBehindTheCache('DE', 'Hidden')

    await countries.update('FR', 'République')

    expect(await countries.cachedLabel('DE')).toBe('Hidden')
  })
}

function registerExactCollationScenarios(driver: Exclude<Driver, 'postgres'>, codeType: string) {
  it('keeps a cached read by another key after an update of an exact key', async () => {
    const countries = await createCountries(driver, codeType)
    expect(await countries.cachedLabel('DE')).toBe('Germany')
    await countries.writeBehindTheCache('DE', 'Hidden')

    await countries.update('FR', 'République')

    expect(await countries.cachedLabel('DE')).toBe('Germany')
  })

  it('keeps a cached read by another key after an upsert of an exact key', async () => {
    const countries = await createCountries(driver, codeType)
    expect(await countries.cachedLabel('DE')).toBe('Germany')
    await countries.writeBehindTheCache('DE', 'Hidden')

    await countries.upsert('FR', 'République')

    expect(await countries.cachedLabel('DE')).toBe('Germany')
  })

  it('keeps a cached read by key after an update of a case-differing exact key', async () => {
    const countries = await createCountries(driver, codeType)
    expect(await countries.cachedLabel('FR')).toBe('France')
    await countries.writeBehindTheCache('FR', 'Hidden')

    await countries.update('fr', 'République')

    expect(await countries.cachedLabel('FR')).toBe('France')
  })

  it('refreshes a cached read by an exact key after an upsert matched through another unique column', async () => {
    const { adapter } = await openDatabase(driver)
    const name = `countries_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
    registerGeneratedTables({ countries: defineTable(name, { code: column.string().primaryKey(), region: column.string(), label: column.string() }) })
    await adapter.execute(`CREATE TABLE ${name} (code ${codeType} PRIMARY KEY NOT NULL, region VARCHAR(16) NOT NULL UNIQUE, label VARCHAR(64) NOT NULL)`)
    onTestFinished(async () => {
      clearGeneratedTables()
      resetCacheRuntime()
      await adapter.execute(`DROP TABLE IF EXISTS ${name}`)
    })
    await adapter.execute(`INSERT INTO ${name} (code, region, label) VALUES ('FR', 'Europe', 'France')`)
    const cachedLabel = async () => (await DB.table(name).where('code', 'FR').cache(60).first())?.label
    expect(await cachedLabel()).toBe('France')

    await DB.table(name).upsert({ code: 'DE', region: 'Europe', label: 'Changed' }, ['region'], ['label'])

    expect(await cachedLabel()).toBe('Changed')
  })

  it('refreshes a cached read by an exact key after an update of the same key', async () => {
    const countries = await createCountries(driver, codeType)
    expect(await countries.cachedLabel('FR')).toBe('France')

    await countries.update('FR', 'République')

    expect(await countries.cachedLabel('FR')).toBe('République')
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

describe('query cache invalidation by a BINARY key on sqlite', () => {
  registerExactCollationScenarios('sqlite', 'TEXT COLLATE BINARY')
})

describe('query cache invalidation by a key with the default collation on sqlite', () => {
  registerExactCollationScenarios('sqlite', 'TEXT')
})

describe('query cache invalidation by a temporary NOCASE key on sqlite', () => {
  it('refreshes a cached read by key after an update matched by a case-differing key on a temporary table that shadows a BINARY one', async () => {
    const { adapter } = await openDatabase('sqlite')
    const name = `countries_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
    registerGeneratedTables({ countries: defineTable(name, { code: column.string().primaryKey(), label: column.string() }) })
    onTestFinished(() => {
      clearGeneratedTables()
      resetCacheRuntime()
    })
    await adapter.execute(`CREATE TABLE ${name} (code TEXT PRIMARY KEY COLLATE BINARY NOT NULL, label VARCHAR(64) NOT NULL)`)
    await adapter.execute(`CREATE TEMP TABLE ${name} (code TEXT PRIMARY KEY COLLATE NOCASE NOT NULL, label VARCHAR(64) NOT NULL)`)
    await adapter.execute(`INSERT INTO temp.${name} (code, label) VALUES ('FR', 'France')`)
    const cachedLabel = async () => (await DB.table(name).where('code', 'FR').cache(60).first())?.label
    expect(await cachedLabel()).toBe('France')

    await DB.table(name).where('code', 'fr').update({ label: 'République' })

    expect(await cachedLabel()).toBe('République')
  })
})

describe('query cache invalidation by a key whose table-level primary key is NOCASE on sqlite', () => {
  it('refreshes a cached read by key after an upsert matched by a case-differing key through the primary key collation', async () => {
    const { adapter } = await openDatabase('sqlite')
    const name = `countries_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
    registerGeneratedTables({ countries: defineTable(name, { code: column.string().primaryKey(), label: column.string() }) })
    onTestFinished(() => {
      clearGeneratedTables()
      resetCacheRuntime()
    })
    await adapter.execute(`CREATE TABLE ${name} (code TEXT NOT NULL, label VARCHAR(64) NOT NULL, PRIMARY KEY (code COLLATE NOCASE))`)
    await adapter.execute(`INSERT INTO ${name} (code, label) VALUES ('FR', 'France')`)
    const cachedLabel = async () => (await DB.table(name).where('code', 'FR').cache(60).first())?.label
    expect(await cachedLabel()).toBe('France')

    await DB.table(name).upsert({ code: 'fr', label: 'République' }, ['code'], ['label'])

    expect(await cachedLabel()).toBe('République')
  })
})

describe('query cache invalidation by an RTRIM key on sqlite', () => {
  it('refreshes a cached read by key after an update matched by the key with trailing spaces', async () => {
    const countries = await createCountries('sqlite', 'TEXT COLLATE RTRIM')
    expect(await countries.cachedLabel('FR')).toBe('France')

    await countries.update('FR  ', 'République')

    expect(await countries.cachedLabel('FR')).toBe('République')
  })
})

describe.skipIf(!mysqlIntegration)('query cache invalidation by a utf8mb4_bin key on mysql', () => {
  registerExactCollationScenarios('mysql', 'VARCHAR(16) COLLATE utf8mb4_bin')

  it('refreshes a cached read by a text key after an update matched by a number mysql compares it with', async () => {
    const countries = await createCountries('mysql', 'VARCHAR(16) COLLATE utf8mb4_bin')
    expect(await countries.cachedLabel('FR')).toBe('France')

    await countries.update(0, 'Zero')

    expect(await countries.cachedLabel('FR')).toBe('Zero')
  })

  it('refreshes a cached read by a number after an update of text mysql converts to that number', async () => {
    const countries = await createCountries('mysql', 'VARCHAR(16) COLLATE utf8mb4_bin')
    expect(await countries.cachedLabel(0)).toBe('Germany')
    await countries.writeBehindTheCache('DE', 'Hidden')

    await countries.update('FR', 'République')

    expect(await countries.cachedLabel(0)).toBe('Hidden')
  })

  it('refreshes a cached read by a key with trailing spaces after an update matched by the key without them', async () => {
    const countries = await createCountries('mysql', 'VARCHAR(16) COLLATE utf8mb4_bin')
    expect(await countries.cachedLabel('FR  ')).toBe('France')

    await countries.update('FR', 'République')

    expect(await countries.cachedLabel('FR  ')).toBe('République')
  })

  it('refreshes a cached read by key after an update matched by the key with trailing spaces', async () => {
    const countries = await createCountries('mysql', 'VARCHAR(16) COLLATE utf8mb4_bin')
    expect(await countries.cachedLabel('FR')).toBe('France')

    await countries.update('FR  ', 'République')

    expect(await countries.cachedLabel('FR')).toBe('République')
  })
})

describe.skipIf(!mysqlIntegration)('query cache invalidation by a utf8mb4_0900_bin key on mysql', () => {
  registerExactCollationScenarios('mysql', 'VARCHAR(16) COLLATE utf8mb4_0900_bin')

  it('keeps a cached read by key after an update of the key with trailing spaces', async () => {
    const countries = await createCountries('mysql', 'VARCHAR(16) COLLATE utf8mb4_0900_bin')
    expect(await countries.cachedLabel('FR')).toBe('France')
    await countries.writeBehindTheCache('FR', 'Hidden')

    await countries.update('FR  ', 'République')

    expect(await countries.cachedLabel('FR')).toBe('France')
  })
})

describe.skipIf(!mysqlIntegration)('query cache invalidation on mysql when the column lookup fails', () => {
  it('refreshes a cached read by a text key after an update by a number when the writer cannot read collations', async () => {
    let failLookups = false
    const { db, adapter } = await openDatabase('mysql', {
      wrapAdapter: inner => new Proxy(inner, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver)
          if ((property === 'query' || property === 'introspect') && typeof value === 'function') {
            return (sql: string, ...rest: unknown[]) => failLookups && /^\s*SHOW\b|information_schema/i.test(sql)
              ? target.query('SELECT * FROM holo_missing_lookup_table', [])
              : Reflect.apply(value, target, [sql, ...rest])
          }
          return typeof value === 'function' ? value.bind(target) : value
        },
      }),
    })
    const name = `countries_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
    registerGeneratedTables({ countries: defineTable(name, { code: column.string().primaryKey(), label: column.string() }) })
    await adapter.execute(`CREATE TABLE ${name} (code VARCHAR(16) COLLATE utf8mb4_bin PRIMARY KEY NOT NULL, label VARCHAR(64) NOT NULL)`)
    onTestFinished(async () => {
      clearGeneratedTables()
      resetCacheRuntime()
      await adapter.execute(`DROP TABLE IF EXISTS ${name}`)
    })
    await adapter.execute(`INSERT INTO ${name} (code, label) VALUES ('FR', 'France')`)
    const cachedLabel = async () => (await DB.table(name).where('code', 'FR').cache(60).first())?.label
    expect(await cachedLabel()).toBe('France')
    failLookups = true
    await db.executeSchemaStatement({ sql: 'DO 0', source: 'schema' })

    await DB.table(name).where('code', 0).update({ label: 'Zero' })

    expect(await cachedLabel()).toBe('Zero')
  })
})

describe.skipIf(!mysqlIntegration)('column collation lookup on mysql', () => {
  it('treats every column as loose when a temporary table shadows a permanent one', async () => {
    const { db, adapter } = await openDatabase('mysql')
    const name = `countries_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await adapter.execute(`CREATE TABLE ${name} (code VARCHAR(16) COLLATE utf8mb4_bin PRIMARY KEY NOT NULL)`)
    onTestFinished(async () => {
      await adapter.execute(`DROP TABLE IF EXISTS ${name}`)
    })

    const columns = await db.transaction(async (transaction) => {
      await transaction.executeCompiled({ sql: `CREATE TEMPORARY TABLE ${name} (code VARCHAR(16) COLLATE utf8mb4_0900_ai_ci PRIMARY KEY NOT NULL)`, source: 'test' })
      const resolved = await resolveCaseInsensitiveColumns(transaction, name)
      await transaction.executeCompiled({ sql: `DROP TEMPORARY TABLE ${name}`, source: 'test' })
      return resolved
    })

    expect(columns).toBe('all')
  })

  it('does not reuse the collation of a temporary table for a lookup in another session', async () => {
    const { db, adapter } = await openDatabase('mysql')
    const name = `countries_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await adapter.execute(`CREATE TABLE ${name} (code VARCHAR(16) COLLATE utf8mb4_0900_ai_ci PRIMARY KEY NOT NULL)`)
    onTestFinished(async () => {
      await adapter.execute(`DROP TABLE IF EXISTS ${name}`)
    })
    await db.transaction(async (transaction) => {
      await transaction.executeCompiled({ sql: `CREATE TEMPORARY TABLE ${name} (code VARCHAR(16) COLLATE utf8mb4_bin PRIMARY KEY NOT NULL)`, source: 'test' })
      await resolveCaseInsensitiveColumns(transaction, name)
      await transaction.executeCompiled({ sql: `DROP TEMPORARY TABLE ${name}`, source: 'test' })
    })

    const columns = await resolveCaseInsensitiveColumns(db, name)

    expect(typeof columns === 'object' && 'findTextColumn' in columns ? columns.findTextColumn('code')?.exact : undefined).toBe(false)
  })
})

describe.skipIf(!mysqlIntegration)('query cache invalidation by a CHAR utf8mb4_0900_bin key on mysql', () => {
  it('refreshes a cached read by key after an upsert of the key with trailing spaces mysql strips on store', async () => {
    const countries = await createCountries('mysql', 'CHAR(16) COLLATE utf8mb4_0900_bin')
    expect(await countries.cachedLabel('FR')).toBe('France')

    await countries.upsert('FR  ', 'République')

    expect(await countries.cachedLabel('FR')).toBe('République')
  })
})

describe.skipIf(!mysqlIntegration)('query cache invalidation by a utf8mb4_0900_as_cs key on mysql', () => {
  it('refreshes a cached read by key after an update matched by the key with an ignorable character', async () => {
    const countries = await createCountries('mysql', 'VARCHAR(16) COLLATE utf8mb4_0900_as_cs')
    expect(await countries.cachedLabel('FR')).toBe('France')

    await countries.update('F\u200BR', 'République')

    expect(await countries.cachedLabel('FR')).toBe('République')
  })
})

describe.skipIf(!mysqlIntegration)('query cache invalidation by a default _ci key on mysql', () => {
  registerCaseInsensitiveScenarios('mysql')
  registerTextNumberScenarios('mysql')

  it('refreshes a cached read by a key as non-numeric text after an update matched by the number mysql converts it to', async () => {
    const tickets = await createTickets('mysql')
    expect(await tickets.cachedLabel('5abc')).toBe('first')

    await tickets.update(5, 'renamed')

    expect(await tickets.cachedLabel('5abc')).toBe('renamed')
  })
})

describe.skipIf(!postgresIntegration)('query cache invalidation by a case-sensitive key on postgres', () => {
  registerTextNumberScenarios('postgres')

  it('refreshes a cached read by a numeric key as text with an exponent separator after an update matched by the number', async () => {
    const tickets = await createTickets('postgres', 'NUMERIC')
    expect(await tickets.cachedLabel('5e0_0')).toBe('first')

    await tickets.update(5, 'renamed')

    expect(await tickets.cachedLabel('5e0_0')).toBe('renamed')
  })

  it('finishes concurrent text writes in a transaction and its savepoint on a table without a cached column lookup', async () => {
    const { db, adapter } = await openDatabase('postgres')
    const name = `countries_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
    await adapter.execute(`CREATE TABLE ${name} (code VARCHAR(16) PRIMARY KEY, label VARCHAR(64) NOT NULL)`)
    onTestFinished(async () => {
      resetCacheRuntime()
      await adapter.execute(`DROP TABLE IF EXISTS ${name}`)
    })
    await adapter.execute(`INSERT INTO ${name} (code, label) VALUES ('FR', 'France'), ('DE', 'Germany')`)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadlock = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('transaction did not finish')), 5000)
    })

    try {
      await Promise.race([
        db.transaction(async transaction => {
          await Promise.all([
            transaction.table(name).where('code', 'FR').update({ label: 'République' }),
            transaction.transaction(async savepoint => await savepoint.table(name).where('code', 'DE').update({ label: 'Deutschland' })),
          ])
        }),
        deadlock,
      ])
    } finally {
      clearTimeout(timer)
    }

    expect((await adapter.query<{ code: string, label: string }>(`SELECT code, label FROM ${name} ORDER BY code`)).rows).toEqual([
      { code: 'DE', label: 'Deutschland' },
      { code: 'FR', label: 'République' },
    ])
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
