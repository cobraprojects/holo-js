import { randomUUID } from 'node:crypto'
import { HydrationError, column, defineGeneratedTable, defineModel } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

function mutate(handler: () => Promise<unknown>) {
  return executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
}

async function openFixture(driver: typeof drivers[number]) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  const name = `holo_bigint_counters_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await schema.createTable(name, (table) => {
    table.id()
    table.bigInteger('n')
    table.string('label')
  })
  onTestFinished(() => schema.dropTable(name))
  const counters = defineGeneratedTable(name, { id: column.id(), n: column.bigInteger(), label: column.string() })
  await db.table(counters).insert([{ id: 1, n: 0, label: 'zero' }, { id: 2, n: 1, label: 'one' }, { id: 3, n: 2, label: 'two' }])
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  const Counter = defineModel(counters, { timestamps: false, fillable: ['n', 'label'] })
  return { db, counters, Counter }
}

async function subscribeAll(queries: Record<string, () => Promise<unknown>>) {
  const subscriptions = await Promise.all(Object.values(queries).map(handler => subscribeRealtimeQuery(
    defineRealtimeQuery({ access: 'public', handler }),
    {},
    { onData: () => {}, onError: (error) => { throw error } },
  )))
  return async () => {
    const fresh = await Promise.all(Object.values(queries).map(handler => handler()))
    for (const [index, name] of Object.keys(queries).entries()) {
      expect(subscriptions[index]!.current.data, name).toEqual(fresh[index])
    }
  }
}

describe.each(drivers)('realtime BigInt values on %s', (driver) => {
  it('keeps subscriptions filtered by BigInt predicates equal to a fresh query', async () => {
    const { db, counters, Counter } = await openFixture(driver)
    const expectFresh = await subscribeAll({
      rows: () => db.table(counters).where('n', 0n).orderBy('id').get(),
      first: () => db.table(counters).where('n', 1n).first(),
      among: () => db.table(counters).whereIn('n', [1n, 2n]).orderBy('id').get(),
      count: () => db.table(counters).where('n', 0n).count(),
      models: () => db.model(Counter).query().where('n', 0n).orderBy('id').getJson(),
      twos: () => db.model(Counter).query().where('n', 2n).orderBy('id').getJson(),
    })

    await mutate(() => db.table(counters).insert({ id: 4, n: 0, label: 'another zero' }))
    await expectFresh()
    await mutate(() => db.table(counters).where('id', 2).update({ n: 0 }))
    await expectFresh()
    await mutate(() => db.table(counters).where('n', 2n).update({ n: 1n }))
    await expectFresh()
    await mutate(() => db.table(counters).insert({ id: 8, n: 2n, label: 'new two' }))
    await expectFresh()
    await mutate(() => db.table(counters.tableName).insert({ id: 9, n: '2', label: 'text two' }))
    await expectFresh()
    await mutate(() => db.table(counters).where('n', 0n).delete())
    await expectFresh()
  })

  it('keeps subscriptions filtered by an unsafe BigInt predicate equal to a fresh query', async () => {
    const { db, counters } = await openFixture(driver)
    await db.table(counters.tableName).insert([{ id: 6, n: '9007199254740993', label: 'huge' }, { id: 7, n: '9007199254740992', label: 'near' }])
    const expectFresh = await subscribeAll({
      exact: () => db.table(counters).select('id', 'label').where('n', 9007199254740993n).orderBy('id').get(),
      near: () => db.table(counters).select('id', 'label').where('n', 9007199254740992n).orderBy('id').get(),
    })

    await mutate(() => db.table(counters).where('n', 9007199254740993n).update({ label: 'renamed huge' }))
    await expectFresh()
    await mutate(() => db.table(counters).where('n', 9007199254740992n).update({ label: 'renamed near' }))
    await expectFresh()
  })

  it('keeps subscriptions on BigInt primary keys equal to a fresh query after writes by number', async () => {
    const { db, counters } = await openFixture(driver)
    const expectFresh = await subscribeAll({
      rows: () => db.table(counters).where('id', 1n).get(),
      first: () => db.table(counters).where('id', 2n).first(),
      all: () => db.table(counters).orderBy('id').get(),
    })

    await mutate(() => db.table(counters).where('id', 1).update({ n: 7 }))
    await expectFresh()
    await mutate(() => db.table(counters).where('id', 2).update({ label: 'renamed' }))
    await expectFresh()
    await mutate(() => db.table(counters).where('id', 1n).delete())
    await expectFresh()
    await mutate(() => db.table(counters).where('id', 2n).update({ n: 8n }))
    await expectFresh()
  })

  it('keeps typed subscriptions equal to a fresh query after writes by table name of integer text the database accepts', async () => {
    const { db, counters, Counter } = await openFixture(driver)
    const expectFresh = await subscribeAll({
      rows: () => db.table(counters).orderBy('id').get(),
      first: () => db.table(counters).where('id', 1).first(),
      models: () => db.model(Counter).query().orderBy('id').getJson(),
    })

    await mutate(() => db.table(counters.tableName).where('id', 1).update({ n: '+7' }))
    await expectFresh()
    await mutate(() => db.table(counters.tableName).insert({ id: 6, n: '+8', label: 'plus' }))
    await expectFresh()
    await mutate(() => db.table(counters.tableName).where('id', 2).update({ n: '007' }))
    await expectFresh()
  })

  it('keeps cached queries filtered by BigInt predicates equal to a fresh query', async () => {
    const { db, counters } = await openFixture(driver)
    const { configureCacheRuntime, resetCacheRuntime } = await import('../../cache/src')
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
    onTestFinished(() => resetCacheRuntime())
    const cached = () => db.table(counters).where('n', 1n).orderBy('id').cache(60).get()
    const fresh = () => db.table(counters).where('n', 1n).orderBy('id').get()

    expect(await cached()).toEqual(await fresh())
    await db.table(counters).insert({ id: 4, n: 1, label: 'another one' })
    expect(await cached()).toEqual(await fresh())
    await db.table(counters).where('n', 1n).update({ label: 'renamed' })
    expect(await cached()).toEqual(await fresh())
    expect(await cached()).toHaveLength(2)
  })

  it('invalidates cached queries and subscriptions on unsafe primary keys written as numbers or BigInts', async () => {
    const { db, counters } = await openFixture(driver)
    const { configureCacheRuntime, resetCacheRuntime } = await import('../../cache/src')
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
    onTestFinished(() => resetCacheRuntime())
    await db.table(counters.tableName).insert([
      { id: '9007199254740992', n: 1, label: 'before' },
      { id: '1000000000000000100', n: 2, label: 'before' },
      { id: '1000000000000000128', n: 3, label: 'before' },
    ])
    const queries = {
      byBigInt: () => db.table(counters).select('label').where('id', 9007199254740992n).get(),
      byNumber: () => db.table(counters).select('label').where('id', 1000000000000000100).get(),
      byExactBigInt: () => db.table(counters).select('label').where('id', 1000000000000000100n).get(),
    }
    const cached = {
      byBigInt: () => db.table(counters).select('label').where('id', 9007199254740992n).cache(60).get(),
      byNumber: () => db.table(counters).select('label').where('id', 1000000000000000100).cache(60).get(),
      byExactBigInt: () => db.table(counters).select('label').where('id', 1000000000000000100n).cache(60).get(),
    }
    const expectFresh = await subscribeAll(queries)
    const expectCachedFresh = async (label: string) => {
      for (const name of Object.keys(queries) as (keyof typeof queries)[]) {
        const fresh = await queries[name]()
        expect(fresh, name).toHaveLength(1)
        expect(await cached[name](), name).toEqual(fresh)
      }
      expect(await queries.byBigInt()).toEqual([{ label }])
    }
    await expectCachedFresh('before')

    await mutate(() => db.table(counters).where('id', 9007199254740992).update({ label: 'after' }))
    await expectFresh()
    await expectCachedFresh('after')
    await mutate(() => db.table(counters).where('id', 1000000000000000100n).update({ label: 'after exact' }))
    await expectFresh()
    await expectCachedFresh('after')
    await mutate(() => db.table(counters).where('id', 1000000000000000128n).update({ label: 'after rounded' }))
    await expectFresh()
    await expectCachedFresh('after')
    await mutate(() => db.table(counters).where('id', 1000000000000000100).update({ label: 'after number' }))
    await expectFresh()
    await expectCachedFresh('after')
  })

  it('keeps subscriptions by table name on unsafe primary keys equal to a fresh query after writes by the other representation', async () => {
    const { db, counters } = await openFixture(driver)
    await db.table(counters.tableName).insert([
      { id: '1000000000000000100', n: 2, label: 'exact' },
      { id: '1000000000000000128', n: 3, label: 'rounded' },
    ])
    const expectFresh = await subscribeAll({
      byNumber: () => db.table(counters.tableName).select('id', 'label').where('id', 1000000000000000100).get(),
      byBigInt: () => db.table(counters.tableName).select('id', 'label').where('id', 1000000000000000128n).get(),
    })

    await mutate(() => db.table(counters.tableName).where('id', 1000000000000000100n).delete())
    await expectFresh()
    await mutate(() => db.table(counters.tableName).where('id', 1000000000000000128).delete())
    await expectFresh()
  })

  it('keeps subscriptions comparing an unsafe BigInt with a floating-point column equal to a fresh query', async () => {
    const { db, schema } = await openDatabase(driver)
    onTestFinished(() => resetRealtimeRuntime())
    const name = `holo_bigint_floats_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, (table) => {
      table.id()
      table.real('n')
      table.string('label')
    })
    if (driver === 'postgres') {
      await db.executeCompiled({ sql: `ALTER TABLE "${name}" ALTER COLUMN "n" TYPE DOUBLE PRECISION`, source: 'schema' })
    }
    if (driver === 'mysql') {
      await db.executeCompiled({ sql: `ALTER TABLE \`${name}\` MODIFY \`n\` DOUBLE`, source: 'schema' })
    }
    onTestFinished(() => schema.dropTable(name))
    await db.table(name).insert({ id: 1, n: 9007199254740992, label: 'before' })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const expectFresh = await subscribeAll({
      rows: () => db.table(name).select('id', 'label').where('n', 9007199254740993n).get(),
      others: () => db.table(name).select('id', 'label').where('n', '!=', 9007199254740993n).get(),
    })

    await mutate(() => db.table(name).where('id', 1).update({ label: 'after' }))
    await expectFresh()
  })

  it('keeps cached queries on a text column by BigInt apart from the same query by number', async () => {
    const { configureCacheRuntime, resetCacheRuntime } = await import('../../cache/src')
    for (const order of [[1n, 1], [1, 1n]] as const) {
      const { db, counters } = await openFixture(driver)
      configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
      onTestFinished(() => resetCacheRuntime())
      await db.table(counters.tableName).insert([{ id: 6, n: 1, label: '1' }, { id: 7, n: 1, label: '01' }])
      const read = (value: bigint | number, cache: boolean) => {
        const query = db.table(counters.tableName).select('id').where('label', value).orderBy('id')
        return (cache ? query.cache(60) : query).get()
      }

      for (const value of order) {
        expect(await read(value, true)).toEqual(await read(value, false))
      }
      resetCacheRuntime()
    }
  })

  it('keeps cached queries on an unsafe BigInt apart from the unequal number with the same digits', async () => {
    const { db, counters } = await openFixture(driver)
    const { configureCacheRuntime, resetCacheRuntime } = await import('../../cache/src')
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
    onTestFinished(() => resetCacheRuntime())
    await db.table(counters.tableName).insert([{ id: 6, n: '1000000000000000100', label: 'bigint' }, { id: 7, n: '1000000000000000128', label: 'number' }])
    const read = (value: bigint | number, cache: boolean) => {
      const query = db.table(counters).select('id').where('n', value)
      return (cache ? query.cache(60) : query).get()
    }

    expect(await read(1000000000000000100n, true)).toEqual(await read(1000000000000000100n, false))
    expect(await read(1000000000000000100, true)).toEqual(await read(1000000000000000100, false))
  })

  it('re-runs a typed subscription when a write by table name stores an integer a typed read rejects', async () => {
    const { db, counters, Counter } = await openFixture(driver)
    const queries: Record<string, () => Promise<unknown>> = {
      rows: () => db.table(counters).orderBy('id').get(),
      first: () => db.table(counters).where('id', 5).first(),
      models: () => db.model(Counter).query().orderBy('id').getJson(),
    }
    const results = await Promise.all(Object.values(queries).map(async (handler) => {
      const errors: unknown[] = []
      let runs = 0
      const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: () => {
        runs += 1
        return handler()
      } }), {}, { onData: () => {}, onError: (error) => {
        errors.push(error)
      } })
      return { subscription, errors, runs: () => runs }
    }))

    const expectRejected = async (expectedRuns: number) => {
      for (const [index, handler] of Object.values(queries).entries()) {
        const fresh = await handler().then(() => undefined, (error: unknown) => error)
        expect(fresh).toBeInstanceOf(HydrationError)
        const { subscription, errors, runs } = results[index]!
        expect(runs()).toBe(expectedRuns)
        expect(errors.at(-1)).toBeInstanceOf(HydrationError)
        expect(String(errors.at(-1))).toBe(String(fresh))
        expect(String(JSON.stringify(subscription.current.data))).not.toContain('9007199254740993')
      }
    }
    const expectFresh = async () => {
      for (const [index, handler] of Object.values(queries).entries()) {
        expect(results[index]!.subscription.current.data).toEqual(await handler())
      }
    }

    await mutate(() => db.table(counters.tableName).insert({ id: 5, n: '9007199254740993', label: 'huge' }))
    await expectRejected(2)
    await mutate(() => db.table(counters.tableName).where('id', 5).update({ n: '7' }))
    await expectFresh()
    const runsAfterRecovery = results.map(result => result.runs())
    await mutate(() => db.table(counters).where('id', 1).update({ label: 'patched' }))
    await expectFresh()
    expect(results.map(result => result.runs())).toEqual(runsAfterRecovery)
    await mutate(() => db.table(counters.tableName).where('id', 5).update({ n: '9007199254740993' }))
    await expectRejected(4)
    await mutate(() => db.table(counters.tableName).where('id', 5).delete())
    await expectFresh()
    expect(results.map(result => result.errors.length)).toEqual([2, 2, 2])
  })
})
