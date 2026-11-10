import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { DB, clearGeneratedTables, column, defineGeneratedTable, registerGeneratedTables } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

const gated = integrationDrivers(['postgres'] as const).length > 0

async function createEmbeddings() {
  const name = `embeddings_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  let reads = 0
  const { schema, db } = await openDatabase('postgres', { security: { debugSqlInLogs: true }, logger: { onQuerySuccess: event => {
    if (event.kind === 'query' && event.sql?.startsWith('SELECT') && event.sql.includes(name)) reads += 1
  } } })
  configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
  onTestFinished(async () => {
    clearGeneratedTables()
    resetCacheRuntime()
    await schema.dropTable(name)
  })
  await db.executeCompiled({ sql: 'CREATE EXTENSION IF NOT EXISTS vector', source: 'schema' })
  await db.executeCompiled({ sql: `CREATE TABLE ${name} (id INTEGER PRIMARY KEY, embedding vector(3))`, source: 'schema' })
  registerGeneratedTables({ embeddings: defineGeneratedTable(name, { id: column.id(), embedding: column.text() }) })
  await DB.table(name).insert([{ id: 1, embedding: '[1,0,0]' }, { id: 2, embedding: '[0,0,1]' }])
  const cachedIds = async () => (await DB.table(name).where('id', 1).whereVectorSimilarTo('embedding', [1, 0, 0], 0.9).orderBy('id').cache(60).get()).map(row => row.id)
  return { cachedIds, name, reads: () => reads }
}

describe.runIf(gated)('query cache vector invalidation on postgres', () => {
  it('evicts a cached vector read after an update of its matching row', async () => {
    const { cachedIds, name } = await createEmbeddings()
    expect(await cachedIds()).toEqual([1])

    await DB.table(name).where('id', 1).update({ embedding: '[0,1,0]' })

    expect(await cachedIds()).toEqual([])
  })

  it('evicts a cached vector read after a delete of its matching row', async () => {
    const { cachedIds, name } = await createEmbeddings()
    expect(await cachedIds()).toEqual([1])

    await DB.table(name).where('id', 1).delete()

    expect(await cachedIds()).toEqual([])
  })

  it('evicts a primary-key-pinned cached read when another row is inserted', async () => {
    const { cachedIds, name, reads } = await createEmbeddings()
    expect(await cachedIds()).toEqual([1])
    const initialReads = reads()
    expect(await cachedIds()).toEqual([1])
    expect(reads()).toBe(initialReads)

    await DB.table(name).insert({ id: 4, embedding: '[0,1,0]' })
    const readsAfterInsert = reads()

    expect(await cachedIds()).toEqual([1])
    expect(reads()).toBe(readsAfterInsert + 1)
  })
})
