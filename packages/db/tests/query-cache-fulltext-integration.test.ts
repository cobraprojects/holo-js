import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { DB, clearGeneratedTables, column, defineGeneratedTable, registerGeneratedTables } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

const gatedDrivers = integrationDrivers(['postgres', 'mysql'] as const)

async function createDocuments(driver: typeof gatedDrivers[number]) {
  const name = `docs_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  let reads = 0
  const { schema, db } = await openDatabase(driver, { security: { debugSqlInLogs: true }, logger: { onQuerySuccess: event => {
    if (event.kind === 'query' && event.sql?.startsWith('SELECT') && event.sql.includes(name)) reads += 1
  } } })
  configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
  registerGeneratedTables({ docs: defineGeneratedTable(name, { id: column.id(), body: column.text() }) })
  await schema.createTable(name, (table) => {
    table.id()
    table.text('body')
  })
  onTestFinished(async () => {
    clearGeneratedTables()
    resetCacheRuntime()
    await schema.dropTable(name)
  })
  if (driver === 'mysql') {
    await db.executeCompiled({ sql: `ALTER TABLE \`${name}\` ADD FULLTEXT (body)`, source: 'schema' })
  }
  await DB.table(name).insert([{ id: 1, body: 'quasar' }, { id: 2, body: 'other' }, { id: 3, body: 'other' }])
  const cachedIds = async () => (await DB.table(name).where('id', 1).whereFullText('body', 'quasar').cache(60).get()).map(row => row.id)
  return { cachedIds, name, reads: () => reads }
}

for (const driver of ['postgres', 'mysql'] as const) {
  describe.runIf(gatedDrivers.includes(driver))(`query cache full-text invalidation on ${driver}`, () => {
    it('evicts a cached full-text read after an update of its matching row', async () => {
      const { cachedIds, name } = await createDocuments(driver)
      expect(await cachedIds()).toEqual([1])

      await DB.table(name).where('id', 1).update({ body: 'other' })

      expect(await cachedIds()).toEqual([])
    })

    it('evicts a cached full-text read after a delete of its matching row', async () => {
      const { cachedIds, name } = await createDocuments(driver)
      expect(await cachedIds()).toEqual([1])

      await DB.table(name).where('id', 1).delete()

      expect(await cachedIds()).toEqual([])
    })

    it('evicts a primary-key-pinned cached read when another row is inserted', async () => {
      const { cachedIds, name, reads } = await createDocuments(driver)
      expect(await cachedIds()).toEqual([1])
      const initialReads = reads()
      expect(await cachedIds()).toEqual([1])
      expect(reads()).toBe(initialReads)

      await DB.table(name).insert({ id: 4, body: 'other' })
      const readsAfterInsert = reads()

      expect(await cachedIds()).toEqual([1])
      expect(reads()).toBe(readsAfterInsert + 1)
    })
  })
}
