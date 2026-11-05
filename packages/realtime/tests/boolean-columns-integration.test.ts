import { randomUUID } from 'node:crypto'
import { belongsTo, clearGeneratedTables, column, defineGeneratedTable, defineModel, hasMany, hasOne, registerGeneratedTables } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'mysql'] as const)

type Driver = typeof drivers[number]

async function openFlags(driver: Driver) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  const name = `holo_live_flags_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await schema.createTable(name, (table) => {
    table.id()
    table.integer('group_id')
    table.boolean('enabled')
  })
  onTestFinished(() => schema.dropTable(name))
  const flags = defineGeneratedTable(name, { id: column.id(), group_id: column.integer(), enabled: column.boolean() })
  await db.table(flags).insert([
    { id: 1, group_id: 1, enabled: true },
    { id: 2, group_id: 2, enabled: false },
  ])
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { db, flags, schema }
}

async function subscribeCounted(queries: Record<string, () => Promise<unknown>>) {
  const runs = Object.fromEntries(Object.keys(queries).map(key => [key, 0]))
  const subscriptions = await Promise.all(Object.entries(queries).map(([key, handler]) => subscribeRealtimeQuery(
    defineRealtimeQuery({ access: 'public', handler: () => {
      runs[key]! += 1
      return handler()
    } }),
    {},
    { onData: () => {}, onError: (error) => { throw error } },
  )))
  const expectPatched = async () => {
    const current = Object.fromEntries(Object.keys(queries).map((key, index) => [key, subscriptions[index]!.current.data]))
    const fresh = Object.fromEntries(await Promise.all(Object.entries(queries).map(async ([key, handler]) => [key, await handler()])))
    expect(current).toEqual(fresh)
    expect(runs).toEqual(Object.fromEntries(Object.keys(queries).map(key => [key, 1])))
  }
  return { subscriptions, expectPatched }
}

describe.each(drivers)('realtime boolean columns on %s', (driver) => {
  it('patches row, filtered, ordered and grouped subscriptions over a boolean column to equal fresh reads', async () => {
    const { db, flags } = await openFlags(driver)
    const { subscriptions, expectPatched } = await subscribeCounted({
      rows: () => db.table(flags).select('id', 'enabled').orderBy('id').get(),
      wildcard: () => db.table(flags).orderBy('id').get(),
      enabledRows: () => db.table(flags).where('enabled', true).orderBy('id').get(),
      disabledRows: () => db.table(flags).where('enabled', false).orderBy('id').get(),
      orderedByFlag: () => db.table(flags).select('id', 'enabled').orderBy('enabled').orderBy('id').get(),
      groupedByFlag: () => db.table(flags).select('enabled').addSelectCount('total').groupBy('enabled').orderBy('enabled').get(),
      ...(driver === 'sqlite' ? { averagedByFlag: () => db.table(flags).select('enabled').addSelectAvg('average', 'group_id').groupBy('enabled').orderBy('enabled').get() } : {}),
      summedByFlag: () => db.table(flags).select('enabled').addSelectSum('total', 'group_id').groupBy('enabled').orderBy('enabled').get(),
      window: () => db.table(flags).orderBy('id').limit(2).get(),
    })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).insert({ id: 3, group_id: 1, enabled: true }) }))
    await expectPatched()
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).where('id', 2).update({ enabled: true }) }))
    await expectPatched()
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).where('id', 1).update({ enabled: false }) }))
    await expectPatched()
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).where('enabled', true).update({ group_id: 5 }) }))
    await expectPatched()
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).where('id', 1).delete() }))
    await expectPatched()
    expect(subscriptions[0]!.current.data).toEqual([{ id: 2, enabled: true }, { id: 3, enabled: true }])
  })

  it('patches a typed subscription to equal a fresh read after name-only writes', async () => {
    const { db, flags } = await openFlags(driver)
    const { expectPatched } = await subscribeCounted({
      rows: () => db.table(flags).orderBy('id').get(),
      enabledRows: () => db.table(flags).where('enabled', true).orderBy('id').get(),
    })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags.tableName).where('id', 1).update({ enabled: 0 }) }))
    await expectPatched()
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags.tableName).insert({ id: 3, group_id: 1, enabled: 1 }) }))
    await expectPatched()
  })

  it('re-runs a name-only subscription over a boolean column, which reads the values the driver returns', async () => {
    const { db, flags } = await openFlags(driver)
    registerGeneratedTables({ [flags.tableName]: flags })
    onTestFinished(() => clearGeneratedTables())
    let handlerRuns = 0
    const handler = () => db.table(flags.tableName).select('id', 'enabled').orderBy('id').get()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: () => {
      handlerRuns += 1
      return handler()
    } }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).insert({ id: 3, group_id: 1, enabled: true }) }))
    expect(subscription.current.data).toEqual(await handler())
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).where('id', 2).update({ enabled: true }) }))
    expect(subscription.current.data).toEqual(await handler())
    expect(handlerRuns).toBe(3)
  })

  it('re-runs a name-only subscription over a table whose columns are unknown', async () => {
    const { db, flags } = await openFlags(driver)
    let handlerRuns = 0
    const handler = () => db.table(flags.tableName).select('id', 'enabled').orderBy('id').get()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: () => {
      handlerRuns += 1
      return handler()
    } }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).insert({ id: 3, group_id: 1, enabled: true }) }))

    expect(subscription.current.data).toEqual(await handler())
  })

  it('keeps an aggregate subscription over a boolean column equal to a fresh read', async () => {
    const { db, flags } = await openFlags(driver)
    const handler = () => db.table(flags).sum('enabled')
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).insert({ id: 3, group_id: 1, enabled: true }) }))
    expect(subscription.current.data).toEqual(await handler())
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).where('id', 2).update({ enabled: true }) }))
    expect(subscription.current.data).toEqual(await handler())
    expect(subscription.current.data).toBe(3)
  })

  it('patches model and eager-loaded subscriptions over a boolean column to equal fresh reads', async () => {
    const { db, flags, schema } = await openFlags(driver)
    const groupsName = `holo_live_flag_groups_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(groupsName, (table) => {
      table.id()
      table.string('name')
      table.boolean('visible')
    })
    onTestFinished(() => schema.dropTable(groupsName))
    const groups = defineGeneratedTable(groupsName, { id: column.id(), name: column.string(), visible: column.boolean() })
    await db.table(groups).insert([{ id: 1, name: 'first', visible: true }, { id: 2, name: 'second', visible: false }])
    const Group = defineModel(groups, { timestamps: false })
    const Flag = defineModel(flags, { timestamps: false, relations: { group: belongsTo(() => Group, 'group_id') } })
    const GroupWithFlags = defineModel(groups, { timestamps: false, relations: { flags: hasMany(() => Flag, 'group_id'), latestFlag: hasOne(() => Flag, 'group_id') } })
    const { subscriptions, expectPatched } = await subscribeCounted({
      models: () => db.model(Flag).query().orderBy('id').getJson(),
      eager: () => db.model(GroupWithFlags).query().with({ flags: query => query.orderBy('id') }).orderBy('id').getJson(),
      parents: () => db.model(Flag).query().with('group').orderBy('id').getJson(),
      latest: () => db.model(GroupWithFlags).query().with({ latestFlag: query => query.orderBy('id', 'desc') }).orderBy('id').getJson(),
    })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).insert({ id: 3, group_id: 1, enabled: true }) }))
    await expectPatched()
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).where('id', 2).update({ enabled: true }) }))
    await expectPatched()
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).insert({ id: 4, group_id: 2, enabled: false }) }))
    await expectPatched()
    expect(JSON.stringify(subscriptions[0]!.current.data)).toContain('"id":3,"group_id":1,"enabled":true')
  })
})
