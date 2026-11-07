import { randomUUID } from 'node:crypto'
import { belongsToMany, column, defineGeneratedTable, defineModel, hasMany, type DriverAdapter } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

type Driver = typeof drivers[number]

function mutate(handler: () => Promise<unknown>) {
  return executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
}

function uniqueName(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

async function subscribeAll(queries: Record<string, () => Promise<unknown>>) {
  const errors: unknown[] = []
  const subscriptions = await Promise.all(Object.values(queries).map(handler => subscribeRealtimeQuery(
    defineRealtimeQuery({ access: 'public', handler }),
    {},
    { onData: () => {}, onError: (error) => { errors.push(error) } },
  )))
  return async () => {
    const fresh = await Promise.all(Object.values(queries).map(handler => handler()))
    expect(errors.map(error => String(error))).toEqual([])
    expect(Object.fromEntries(Object.keys(queries).map((name, index) => [name, JSON.parse(JSON.stringify(subscriptions[index]!.current.data))])))
      .toEqual(Object.fromEntries(Object.keys(queries).map((name, index) => [name, JSON.parse(JSON.stringify(fresh[index]))])))
  }
}

async function alterToScaledDecimals(driver: Driver, db: Awaited<ReturnType<typeof openDatabase>>['db'], name: string, columns: readonly string[]) {
  if (driver !== 'postgres') return
  await db.executeCompiled({ sql: `ALTER TABLE "${name}" ${columns.map(name => `ALTER COLUMN "${name}" TYPE NUMERIC(10, 2)`).join(', ')}`, source: 'schema' })
}

describe.each(drivers)('realtime read-back edge cases on %s', (driver) => {
  it('keeps filtered subscriptions equal to a fresh query after writing integer text padded with spaces', async () => {
    const { db, schema } = await openDatabase(driver)
    onTestFinished(() => resetRealtimeRuntime())
    const name = uniqueName('holo_padded')
    await schema.createTable(name, (table) => {
      table.id()
      table.bigInteger('group_id')
      table.string('label')
    })
    onTestFinished(() => schema.dropTable(name))
    const items = defineGeneratedTable(name, { id: column.id(), group_id: column.bigInteger(), label: column.string() })
    await db.table(items).insert({ id: 1, group_id: 1, label: 'first' })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const expectFresh = await subscribeAll({
      rows: () => db.table(items).orderBy('id').get(),
      grouped: () => db.table(items).where('group_id', 2).orderBy('id').get(),
      first: () => db.table(items).where('group_id', 2).orderBy('id').first(),
      count: () => db.table(items).where('group_id', 2).count(),
    })

    await mutate(() => db.table(items).insert({ id: 2, group_id: '2 ', label: 'second' }))
    await expectFresh()
    await mutate(() => db.table(items).insert({ id: 3, group_id: ' 2', label: 'third' }))
    await expectFresh()
    await mutate(() => db.table(items).where('id', 1).update({ group_id: '2 ' }))
    await expectFresh()
    await mutate(() => db.table(items).where('id', 2).update({ group_id: ' 1 ' }))
    await expectFresh()
    expect(await db.table(items).where('group_id', 2).orderBy('id').get()).toEqual([
      { id: 1, group_id: 2, label: 'first' },
      { id: 3, group_id: 2, label: 'third' },
    ])
  })

  it('reads back only the written key tuples of a table keyed by a decimal and an integer column', async () => {
    const { db, schema } = await openDatabase(driver)
    onTestFinished(() => resetRealtimeRuntime())
    const name = uniqueName('holo_tuples')
    await schema.createTable(name, (table) => {
      table.decimal('code')
      table.integer('line')
      table.decimal('rate')
      table.primary(['code', 'line'])
    })
    await alterToScaledDecimals(driver, db, name, ['code', 'rate'])
    onTestFinished(() => schema.dropTable(name))
    const prices = defineGeneratedTable(name, { code: column.decimal().primaryKey(), line: column.integer().primaryKey(), rate: column.decimal() })
    await db.table(prices).insert([{ code: '1.50', line: 2, rate: '7.00' }, { code: '2.50', line: 1, rate: '8.00' }])
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const expectFresh = await subscribeAll({
      rows: () => db.table(prices).orderBy('code').orderBy('line').get(),
      count: () => db.table(prices).count(),
      line: () => db.table(prices).where('line', 1).orderBy('code').get(),
    })

    await mutate(() => db.table(prices).insert([{ code: '1.5', line: 1, rate: '1.5' }, { code: '2.5', line: 2, rate: '2.5' }]))
    await expectFresh()
    await mutate(() => db.table(prices).where('line', 2).update({ rate: '3.5' }))
    await expectFresh()
    await mutate(() => db.table(prices).upsert([{ code: '1.5', line: 1, rate: '4.5' }, { code: '3.5', line: 3, rate: '5' }], ['code', 'line'], ['rate']))
    await expectFresh()
    expect(await db.table(prices).count()).toBe(5)
  })

  it('keeps a committed insert and refreshes subscriptions when the inserted rows cannot be read back', async () => {
    let failReadBack = false
    let failedReads = 0
    let inserted = false
    const tableName = uniqueName('holo_unread')
    const failingQuery = (adapter: DriverAdapter): DriverAdapter => new Proxy(adapter, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver)
        if (property === 'execute' || property === 'query') {
          return async (sql: string, ...rest: unknown[]) => {
            if (failReadBack && /^\s*insert/i.test(sql) && sql.includes(tableName)) {
              inserted = true
            }
            else if (failReadBack && inserted && /^\s*select \* from/i.test(sql) && /\bin \(/i.test(sql) && sql.includes(tableName)) {
              failedReads += 1
              throw new Error('read-back denied')
            }
            return (value as (...args: unknown[]) => Promise<unknown>).call(target, sql, ...rest)
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const { db, schema } = await openDatabase(driver, { wrapAdapter: failingQuery })
    onTestFinished(() => resetRealtimeRuntime())
    await schema.createTable(tableName, (table) => {
      table.id()
      table.bigInteger('group_id')
      table.decimal('rate')
    })
    await alterToScaledDecimals(driver, db, tableName, ['rate'])
    onTestFinished(() => schema.dropTable(tableName))
    const rates = defineGeneratedTable(tableName, { id: column.id(), group_id: column.bigInteger(), rate: column.decimal() })
    await db.table(rates).insert({ id: 1, group_id: 1, rate: '1.00' })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const handlers: Record<string, () => Promise<unknown>> = {
      rows: () => db.table(rates).orderBy('id').get(),
      count: () => db.table(rates).where('group_id', 2).count(),
    }
    const expectFresh = await subscribeAll(handlers)

    const write = async () => {
      failReadBack = true
      try {
        return await db.table(rates).insert({ id: 2, group_id: 2, rate: '9.5' })
      } finally {
        failReadBack = false
      }
    }
    expect((await mutate(write)).data).toMatchObject({ affectedRows: 1 })

    await expectFresh()
    expect(await db.table(rates).where('id', 2).first()).toEqual({ id: 2, group_id: 2, rate: '9.50' })
    expect(failedReads).toBe(driver === 'mysql' ? 1 : 0)
  })

  it('refreshes cached reads of the new key when an update changes a decimal key the database rescales', async () => {
    const { db, schema } = await openDatabase(driver)
    onTestFinished(() => resetRealtimeRuntime())
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
    onTestFinished(() => resetCacheRuntime())
    const name = uniqueName('holo_rescaled')
    await schema.createTable(name, (table) => {
      table.decimal('code').primaryKey()
      table.decimal('rate')
      table.string('label')
    })
    await alterToScaledDecimals(driver, db, name, ['code', 'rate'])
    onTestFinished(() => schema.dropTable(name))
    const prices = defineGeneratedTable(name, { code: column.decimal().primaryKey(), rate: column.decimal(), label: column.string() })
    await db.table(prices).insert({ code: '1.00', rate: '1.00', label: 'moved' })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const expectFresh = await subscribeAll({ rows: () => db.table(prices).orderBy('code').get() })
    const cachedLabel = async (code: string) => (await db.table(prices).where('code', code).cache(60).first())?.label
    const cachedByLabel = async () => (await db.table(prices).where('label', 'moved').cache(60).first())?.code
    expect(await cachedLabel('2.50')).toBeUndefined()
    expect(await cachedLabel('2.5')).toBeUndefined()
    expect(await cachedByLabel()).toBe('1.00')

    await mutate(() => db.table(prices).where('code', '1.00').update({ code: '2.5', rate: '3.5' }))

    await expectFresh()
    expect(await cachedLabel('1.00')).toBeUndefined()
    expect(await cachedLabel('2.50')).toBe('moved')
    expect(await cachedLabel('2.5')).toBe('moved')
    expect(await cachedByLabel()).toBe('2.50')
  })

  it('removes a pivot row an update moves to another parent from a constrained belongsToMany subscription', async () => {
    const { db, schema } = await openDatabase(driver)
    onTestFinished(() => resetRealtimeRuntime())
    const groupsName = uniqueName('holo_mv_groups')
    const tagsName = uniqueName('holo_mv_tags')
    const pivotName = uniqueName('holo_mv_pivot')
    await schema.createTable(groupsName, (table) => {
      table.id()
      table.string('name')
    })
    await schema.createTable(tagsName, (table) => {
      table.id()
      table.string('name')
    })
    await schema.createTable(pivotName, (table) => {
      table.id()
      table.bigInteger('group_id')
      table.bigInteger('tag_id')
      table.string('note')
    })
    onTestFinished(async () => {
      await schema.dropTable(pivotName)
      await schema.dropTable(tagsName)
      await schema.dropTable(groupsName)
    })
    const groups = defineGeneratedTable(groupsName, { id: column.id(), name: column.string() })
    const tags = defineGeneratedTable(tagsName, { id: column.id(), name: column.string() })
    const pivot = defineGeneratedTable(pivotName, { id: column.id(), group_id: column.bigInteger(), tag_id: column.bigInteger(), note: column.string() })
    await db.table(groups).insert([{ id: 1, name: 'first' }, { id: 2, name: 'second' }])
    await db.table(tags).insert([{ id: 1, name: 'sale' }, { id: 2, name: 'new' }])
    await db.table(pivot).insert([{ id: 1, group_id: 1, tag_id: 1, note: 'a' }, { id: 2, group_id: 1, tag_id: 2, note: 'b' }])
    const Tag = defineModel(tags, { timestamps: false })
    const Group = defineModel(groups, { timestamps: false, relations: { tags: belongsToMany(() => Tag, pivot, 'group_id', 'tag_id').withPivot('id', 'note') } })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const expectFresh = await subscribeAll({
      first: () => db.model(Group).query().where('id', 1).with('tags').getJson(),
      all: () => db.model(Group).query().with('tags').orderBy('id').getJson(),
      sale: () => db.model(Group).query().with({ tags: query => query.where('name', 'sale').orderBy('id') }).orderBy('id').getJson(),
    })

    await mutate(() => db.table(pivot).where('id', 1).update({ group_id: 2, note: 'moved' }))
    await expectFresh()
    await mutate(() => db.table(pivot).where('id', 2).update({ tag_id: 1, note: 'a' }))
    await expectFresh()
    await mutate(() => db.table(pivot).where('note', 'a').update({ group_id: 2 }))
    await expectFresh()
    expect(await db.model(Group).query().where('id', 1).with('tags').getJson()).toEqual([expect.objectContaining({ id: 1, tags: [] })])
  })

  it('keeps relation aggregates of a parent with a null key equal to a fresh query after an insert without rows', async () => {
    const { db, schema } = await openDatabase(driver)
    onTestFinished(() => resetRealtimeRuntime())
    const groupsName = uniqueName('holo_null_groups')
    const scoresName = uniqueName('holo_null_scores')
    await schema.createTable(groupsName, (table) => {
      table.id()
      table.integer('code').nullable()
    })
    await schema.createTable(scoresName, (table) => {
      table.id()
      table.integer('group_id').nullable()
      table.integer('points')
    })
    onTestFinished(async () => {
      await schema.dropTable(scoresName)
      await schema.dropTable(groupsName)
    })
    const groups = defineGeneratedTable(groupsName, { id: column.id(), code: column.integer().nullable() })
    const scores = defineGeneratedTable(scoresName, { id: column.id(), group_id: column.integer().nullable(), points: column.integer() })
    const Score = defineModel(scores, { timestamps: false })
    const Group = defineModel(groups, { timestamps: false, relations: { scores: hasMany(() => Score, 'group_id', 'code') } })
    await db.table(groups).insert([{ id: 1, code: 1 }, { id: 2, code: null }])
    await db.table(scores).insert([{ group_id: 1, points: 2 }, { group_id: null, points: 4 }])
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const expectFresh = await subscribeAll({
      aggregates: async () => (await Group.query().withCount('scores').withSum('scores', 'points').withMax('scores', 'points').orderBy('id').get()).toJSON(),
      nullParent: async () => (await Group.query().where('id', 2).withCount('scores').withSum('scores', 'points').get()).toJSON(),
    })

    await mutate(() => db.table(scores).insertUsing(['group_id', 'points'], db.table(scores).select('group_id', 'points').whereNull('group_id')))
    await expectFresh()
    await mutate(() => db.table(scores).insertUsing(['group_id', 'points'], db.table(scores).select('group_id', 'points').where('group_id', 1)))
    await expectFresh()
    expect(await db.table(scores).whereNull('group_id').count()).toBe(2)
  })
})
