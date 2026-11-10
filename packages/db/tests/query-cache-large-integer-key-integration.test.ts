import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { column, defineGeneratedTable } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

describe.each(drivers)('query cache large integer keys on %s', (driver) => {
  it.each(['declared', 'name-only'] as const)('preserves the %s row cache across writes to other ids', async (mode) => {
    const name = `large_key_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    let reads = 0
    const { db, schema } = await openDatabase(driver, {
      security: { debugSqlInLogs: true },
      logger: { onQuerySuccess: event => {
        if (event.kind === 'query' && event.sql?.startsWith('SELECT') && event.sql.includes(name)) reads += 1
      } },
    })
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
    await schema.createTable(name, table => {
      table.id()
      table.string('name')
    })
    onTestFinished(async () => {
      resetCacheRuntime()
      await schema.dropTable(name)
    })
    const table = defineGeneratedTable(name, { id: column.id(), name: column.string() })
    await db.table(table).insert({ id: 20000001, name: 'first' })
    const id = driver === 'postgres' && mode === 'name-only' ? '20000001' : 20000001
    const read = () => db.table(mode === 'declared' ? table : name).where('id', 20000001).cache(60).get()
    expect(await read()).toEqual([{ id, name: 'first' }])
    const initialReads = reads
    expect(await read()).toEqual([{ id, name: 'first' }])
    expect(reads).toBe(initialReads)

    await db.table(table).insert({ id: 20000002, name: 'other' })
    const readsAfterInsert = reads

    expect(await read()).toEqual([{ id, name: 'first' }])
    expect(reads).toBe(readsAfterInsert)

    await db.table(table).where('id', 20000001).update({ name: 'changed' })

    expect(await read()).toEqual([{ id, name: 'changed' }])
  })
})
