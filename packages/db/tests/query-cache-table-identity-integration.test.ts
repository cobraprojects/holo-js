import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { DB, queryCacheInternals } from '../src'
import { resolveTableIdentity } from '../src/query/tableIdentity'
import { integrationDrivers, openDatabase, tableSpellings } from './support/database'
import type { TestDriver as Driver } from '../../../tests/support/real-database'

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

    it('refreshes a cached read whose explicit invalidation names the other spelling', async () => {
      const { bare, qualified } = await openCachedTable(driver)
      const cachedWithExplicitDependency = async () => (await DB.table(bare).orderBy('id').cache({ ttl: 60, invalidate: [qualified] }).get()).map(row => row.name)
      expect(await cachedWithExplicitDependency()).toEqual(['first'])

      await DB.table(bare).insert({ id: 2, name: 'second', active: false })

      expect(await cachedWithExplicitDependency()).toEqual(['first', 'second'])
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

  it('refreshes a cached qualified read after a temp table starts shadowing it', async () => {
    const { db, bare, qualified } = await openCachedTable('sqlite')
    expect(await cachedNames(qualified)).toEqual(['first'])

    await db.executeSchemaStatement({ sql: `CREATE TEMP TABLE "${bare}" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)`, source: 'schema' })
    await DB.table(qualified).insert({ id: 2, name: 'second', active: false })

    expect(await cachedNames(qualified)).toEqual(['first', 'second'])
  })

  it('refreshes cached unqualified reads after a transaction starts shadowing the table with a temp table', async () => {
    const { db, bare, qualified } = await openCachedTable('sqlite')
    expect(await cachedNames(bare)).toEqual(['first'])
    expect(await cachedNames(qualified)).toEqual(['first'])

    await db.transaction(async (trx) => {
      await trx.executeSchemaStatement({ sql: `CREATE TEMP TABLE "${bare}" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)`, source: 'schema' })
      await trx.table(qualified).insert({ id: 2, name: 'second', active: false })
    })

    expect(await cachedNames(bare)).toEqual([])
    expect(await cachedNames(qualified)).toEqual(['first', 'second'])
  })

  it('refreshes cached unqualified reads when a rolled-back savepoint resolved the shadowed identity first', async () => {
    const { db, bare, qualified } = await openCachedTable('sqlite')
    expect(await cachedNames(bare)).toEqual(['first'])
    expect(await cachedNames(qualified)).toEqual(['first'])
    const createShadow = { sql: `CREATE TEMP TABLE "${bare}" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL)`, source: 'schema' }
    const rollback = new Error('rollback')

    await db.transaction(async (trx) => {
      await trx.transaction(async (savepoint) => {
        await savepoint.executeSchemaStatement(createShadow)
        await savepoint.table(qualified).insert({ id: 3, name: 'discarded', active: false })
        throw rollback
      }).catch((error: unknown) => {
        if (error !== rollback) throw error
      })
      await trx.executeSchemaStatement(createShadow)
      await trx.table(qualified).insert({ id: 2, name: 'second', active: false })
    })

    expect(await cachedNames(bare)).toEqual([])
    expect(await cachedNames(qualified)).toEqual(['first', 'second'])
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

const collectedDependencies = async (tableName: string) => (await queryCacheInternals.collectDatabaseQueryDependencies(() => DB.table(tableName).get())).dependencies

describe.each(integrationDrivers(['postgres'] as const))('%s query cache table identity across schemas', (driver) => {
  it('keys a table on a non-public search_path by its bare name and keeps a same-named public table apart', async () => {
    const schemaName = 'holo_t575_app'
    const { schema } = await openDatabase(driver, { schemaName })
    const name = `holo_identity_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, (table) => { table.integer('id').primaryKey() })
    await schema.createTable(`public.${name}`, (table) => { table.integer('id').primaryKey() })
    try {
      expect(await collectedDependencies(`${schemaName}.${name}`)).toEqual(await collectedDependencies(name))
      expect(await collectedDependencies(`public.${name}`)).toEqual([`db:default:public.${name}`])
      expect(await collectedDependencies(name)).toEqual([`db:default:${name}`])
    } finally {
      await schema.dropTable(`${schemaName}.${name}`)
      await schema.dropTable(`public.${name}`)
    }
  })

  it('keeps the identity a transaction sees after its own uncommitted DDL out of other connections', async () => {
    const schemaName = 'holo_t575_app'
    const { db, schema } = await openDatabase(driver, { schemaName })
    const name = `holo_identity_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const qualified = `${schemaName}.${name}`
    await schema.createTable(name, (table) => { table.integer('id').primaryKey() })
    try {
      expect(await resolveTableIdentity(db, qualified)).toBe(name)
      let markDropped!: () => void
      let release!: () => void
      const dropped = new Promise<void>((resolve) => { markDropped = resolve })
      const released = new Promise<void>((resolve) => { release = resolve })
      const outside = dropped.then(() => resolveTableIdentity(db, qualified))
      const rollback = new Error('rollback')
      const transaction = db.transaction(async (trx) => {
        await trx.executeSchemaStatement({ sql: `DROP TABLE "${schemaName}"."${name}"`, source: 'schema' })
        expect(await resolveTableIdentity(trx, qualified)).toBe(qualified)
        markDropped()
        await released
        throw rollback
      }).catch((error: unknown) => {
        if (error !== rollback) throw error
      })
      try {
        expect(await outside).toBe(name)
      } finally {
        release()
        await transaction
      }
    } finally {
      await schema.dropTable(qualified)
    }
  })
})
