import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { DB, clearGeneratedTables, column, registerGeneratedTables } from '../src'
import { defineTable } from './support/internal'
import { openDatabase } from './support/database'

type Driver = 'sqlite' | 'postgres' | 'mysql'

async function createCountries(driver: Driver) {
  const { adapter } = await openDatabase(driver)
  const name = `countries_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
  registerGeneratedTables({ countries: defineTable(name, { code: column.string().primaryKey(), label: column.string() }) })
  const code = driver === 'sqlite'
    ? 'code TEXT PRIMARY KEY COLLATE NOCASE NOT NULL'
    : `code VARCHAR(16) COLLATE ${driver === 'mysql' ? 'utf8mb4_0900_ai_ci' : '"C"'} PRIMARY KEY NOT NULL`
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

describe('query cache invalidation by a NOCASE key on sqlite', () => {
  registerCaseInsensitiveScenarios('sqlite')
})

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('query cache invalidation by a default _ci key on mysql', () => {
  registerCaseInsensitiveScenarios('mysql')
})

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('query cache invalidation by a case-sensitive key on postgres', () => {
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
