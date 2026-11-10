import { randomUUID } from 'node:crypto'
import { column, defineGeneratedTable } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

describe.each(drivers)('insert SQL comparisons on %s', (driver) => {
  it.each(['declared', 'name-only'] as const)('skips unrelated inserts for a large %s primary key', async (mode) => {
    const { db, schema } = await openDatabase(driver)
    const name = `large_id_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, table => { table.id() })
    onTestFinished(async () => {
      resetRealtimeRuntime()
      await schema.dropTable(name)
    })
    const table = defineGeneratedTable(name, { id: column.id() })
    await db.table(table).insert({ id: 20000001 })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    let runs = 0
    const handler = async () => {
      runs += 1
      return db.table(mode === 'declared' ? table : name).where('id', 20000001).get()
    }
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(table).insert({ id: 20000002 }) }))

    expect(runs).toBe(1)
    const id = driver === 'postgres' && mode === 'name-only' ? '20000001' : 20000001
    expect(subscription.current.data).toEqual([{ id }])
  })

  it('refreshes fractional predicates on an undeclared column even when exactly representable in float32', async () => {
    const { db, schema } = await openDatabase(driver)
    const name = `fractional_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await db.executeCompiled({ sql: `CREATE TABLE ${name} (id INTEGER PRIMARY KEY, value REAL)`, source: 'schema' })
    onTestFinished(async () => {
      resetRealtimeRuntime()
      await schema.dropTable(name)
    })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    let runs = 0
    const handler = async () => {
      runs += 1
      return db.table(name).where('value', 0.5).get()
    }
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(name).insert({ id: 1, value: 0.25 }) }))

    expect(runs).toBe(2)
    expect(subscription.current.data).toEqual(await handler())
  })

  it.each([1.1, 16777217])('keeps a REAL equality subscription fresh for %s', async (value) => {
    const { db, schema } = await openDatabase(driver)
    const name = `real_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await db.executeCompiled({ sql: `CREATE TABLE ${name} (id INTEGER PRIMARY KEY, value REAL)`, source: 'schema' })
    onTestFinished(async () => {
      resetRealtimeRuntime()
      await schema.dropTable(name)
    })
    const table = defineGeneratedTable(name, { id: column.integer().primaryKey(), value: column.real() })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const handler = () => db.table(table).where('value', value).get()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(table).insert({ id: 1, value }) }))

    const fresh = await handler()
    expect(fresh).toHaveLength(1)
    expect(subscription.current.data).toEqual(fresh)
  })

  it.runIf(driver === 'postgres').each([NaN, Infinity, -Infinity])('keeps PostgreSQL non-finite equality fresh for %s', async (value) => {
    const { db, schema } = await openDatabase(driver)
    const name = `nan_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await db.executeCompiled({ sql: `CREATE TABLE ${name} (id INTEGER PRIMARY KEY, value REAL)`, source: 'schema' })
    onTestFinished(async () => {
      resetRealtimeRuntime()
      await schema.dropTable(name)
    })
    const table = defineGeneratedTable(name, { id: column.integer().primaryKey(), value: column.real() })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const handler = () => db.table(table).where('value', value).get()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(table).insert({ id: 1, value }) }))

    const fresh = await handler()
    expect(fresh).toHaveLength(1)
    expect(subscription.current.data).toEqual(fresh)
  })

  it.runIf(driver === 'mysql')('refreshes after coercion when a table has no key for insert read-back', async () => {
    const { db, schema } = await openDatabase(driver)
    const name = `coerced_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await db.executeCompiled({ sql: `CREATE TABLE ${name} (value TINYINT UNSIGNED)`, source: 'schema' })
    onTestFinished(async () => {
      resetRealtimeRuntime()
      await schema.dropTable(name)
    })
    const table = defineGeneratedTable(name, { value: column.integer() })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const handler = () => db.table(table).where('value', 255).get()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(table).insertOrIgnore({ value: 256 }) }))

    const fresh = await handler()
    expect(fresh).toEqual([{ value: 255 }])
    expect(subscription.current.data).toEqual(fresh)
  })

  it('reads generated columns and defaults before deciding whether an insert contradicts a query', async () => {
    const { db, schema } = await openDatabase(driver)
    const name = `generated_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await db.executeCompiled({ sql: `CREATE TABLE ${name} (id INTEGER PRIMARY KEY, owner INTEGER DEFAULT 2, doubled INTEGER GENERATED ALWAYS AS (owner * 2) STORED)`, source: 'schema' })
    onTestFinished(async () => {
      resetRealtimeRuntime()
      await schema.dropTable(name)
    })
    const table = defineGeneratedTable(name, { id: column.integer().primaryKey(), owner: column.integer(), doubled: column.integer() })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const handler = () => db.table(table).where('owner', 2).where('doubled', 4).get()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(table).insert({ id: 1 }) }))

    const fresh = await handler()
    expect(fresh).toEqual([{ id: 1, owner: 2, doubled: 4 }])
    expect(subscription.current.data).toEqual(fresh)
  })

  it.runIf(driver === 'postgres')('refreshes rounded REAL comparisons without a declared column type', async () => {
    const { db, schema } = await openDatabase(driver)
    const name = `unknown_real_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await db.executeCompiled({ sql: `CREATE TABLE ${name} (id INTEGER PRIMARY KEY, value REAL)`, source: 'schema' })
    onTestFinished(async () => {
      resetRealtimeRuntime()
      await schema.dropTable(name)
    })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const handler = () => db.table(name).where('value', 1.00000006).get()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(name).insert({ id: 1, value: 1.00000006 }) }))

    const fresh = await handler()
    expect(fresh).toEqual([{ id: 1, value: 1.0000001 }])
    expect(subscription.current.data).toEqual(fresh)
  })

  it.runIf(driver === 'mysql')('uses stored truncated and padded strings for insert invalidation', async () => {
    const { db, schema } = await openDatabase(driver)
    const name = `strings_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await db.executeCompiled({ sql: `CREATE TABLE ${name} (id INTEGER PRIMARY KEY, shortened VARCHAR(3), padded CHAR(3))`, source: 'schema' })
    onTestFinished(async () => {
      resetRealtimeRuntime()
      await schema.dropTable(name)
    })
    const table = defineGeneratedTable(name, { id: column.integer().primaryKey(), shortened: column.string(), padded: column.string() })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const handler = () => db.table(table).where('shortened', 'abc').where('padded', 'a').get()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(table).insertOrIgnore({ id: 1, shortened: 'abcdef', padded: 'a  ' }) }))

    const fresh = await handler()
    expect(fresh).toHaveLength(1)
    expect(subscription.current.data).toEqual(fresh)
  })
})
