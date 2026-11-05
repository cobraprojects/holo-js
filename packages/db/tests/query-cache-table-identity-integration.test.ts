import { describe, expect, it, onTestFinished } from 'vitest'
import { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { DB } from '../src'
import { integrationDrivers, mysqlTestConnection, openDatabase } from './support/database'

type Driver = 'sqlite' | 'postgres' | 'mysql'

function tableSpellings(driver: Driver, tableName: string) {
  const bare = tableName.split('.').at(-1)!
  const schema = driver === 'sqlite' ? 'main' : driver === 'postgres' ? 'public' : mysqlTestConnection().database
  return { bare, qualified: `${schema}.${bare}` }
}

async function openCachedTable(driver: Driver) {
  const opened = await openDatabase(driver)
  configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
  onTestFinished(() => resetCacheRuntime())
  await opened.db.table(opened.table.tableName).insert({ id: 1, name: 'first', active: false })
  return { ...opened, ...tableSpellings(driver, opened.table.tableName) }
}

const cachedNames = async (tableName: string) => (await DB.table(tableName).orderBy('id').cache(60).get()).map(row => row.name)
const cachedName = async (tableName: string, id: number) => (await DB.table(tableName).where('id', id).cache(60).first())?.name

for (const driver of integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)) {
  describe(`${driver} query cache table identity`, () => {
    it('refreshes a cached unqualified read after an insert through the qualified spelling', async () => {
      const { bare, qualified } = await openCachedTable(driver)
      expect(await cachedNames(bare)).toEqual(['first'])

      await DB.table(qualified).insert({ id: 2, name: 'second', active: false })

      expect(await cachedNames(bare)).toEqual(['first', 'second'])
    })

    it('refreshes a cached qualified read after an insert through the unqualified spelling', async () => {
      const { bare, qualified } = await openCachedTable(driver)
      expect(await cachedNames(qualified)).toEqual(['first'])

      await DB.table(bare).insert({ id: 2, name: 'second', active: false })

      expect(await cachedNames(qualified)).toEqual(['first', 'second'])
    })

    it('refreshes cached reads by key after updates and deletes through the other spelling', async () => {
      const { bare, qualified } = await openCachedTable(driver)
      expect(await cachedName(bare, 1)).toBe('first')
      expect(await cachedName(qualified, 1)).toBe('first')

      await DB.table(qualified).where('id', 1).update({ name: 'renamed' })
      expect(await cachedName(bare, 1)).toBe('renamed')

      await DB.table(bare).where('id', 1).update({ name: 'again' })
      expect(await cachedName(qualified, 1)).toBe('again')

      await DB.table(bare).where('id', 1).delete()
      expect(await cachedName(qualified, 1)).toBeUndefined()
    })
  })
}

describe('sqlite query cache table identity across temp and attached schemas', () => {
  it('matches an unqualified table that SQLite resolves to an attached database', async () => {
    const { db } = await openCachedTable('sqlite')
    await db.getAdapter().execute(`ATTACH DATABASE ':memory:' AS "aux"`)
    await db.getAdapter().execute('CREATE TABLE "aux"."ledgers" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)')
    await db.getAdapter().execute(`INSERT INTO "aux"."ledgers" ("id", "name") VALUES (1, 'first')`)
    expect(await cachedNames('ledgers')).toEqual(['first'])
    expect(await cachedNames('aux.ledgers')).toEqual(['first'])

    await DB.table('aux.ledgers').insert({ id: 2, name: 'second' })
    expect(await cachedNames('ledgers')).toEqual(['first', 'second'])

    await DB.table('ledgers').insert({ id: 3, name: 'third' })
    expect(await cachedNames('aux.ledgers')).toEqual(['first', 'second', 'third'])
  })

  it('keeps a temp table that shadows a main table separate from the main table', async () => {
    const { db, bare, qualified } = await openCachedTable('sqlite')
    await db.getAdapter().execute(`CREATE TEMP TABLE "${bare}" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)`)
    await db.getAdapter().execute(`INSERT INTO "temp"."${bare}" ("id", "name") VALUES (1, 'temporary')`)
    expect(await cachedNames(bare)).toEqual(['temporary'])
    expect(await cachedNames(`temp.${bare}`)).toEqual(['temporary'])
    expect(await cachedNames(qualified)).toEqual(['first'])

    await DB.table(`temp.${bare}`).insert({ id: 2, name: 'scratch' })
    expect(await cachedNames(bare)).toEqual(['temporary', 'scratch'])

    await DB.table(qualified).insert({ id: 2, name: 'second', active: false })
    expect(await cachedNames(qualified)).toEqual(['first', 'second'])
    expect(await cachedNames(bare)).toEqual(['temporary', 'scratch'])
  })
})
