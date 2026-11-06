import { randomUUID } from 'node:crypto'
import { belongsTo, clearGeneratedTables, column, defineGeneratedTable, defineModel, hasMany, hasOne, registerGeneratedTables } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'mysql'] as const)

type Driver = 'sqlite' | 'postgres' | 'mysql'

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

  it.runIf(driver === 'sqlite')('patches a subscription through a schema-qualified definition after name-only writes', async () => {
    const { db, flags } = await openFlags(driver)
    const qualified = defineGeneratedTable(`main.${flags.tableName}`, { id: column.id(), group_id: column.integer(), enabled: column.boolean() })
    const { expectPatched } = await subscribeCounted({
      rows: () => db.table(qualified).orderBy('id').get(),
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

  it('reads a backfilled column that two selections alias alike the way SQL does', async () => {
    const { db, flags } = await openFlags(driver)
    await db.table(flags).insert({ id: 3, group_id: 42, enabled: true })
    const handler = () => db.table(flags).select('id', 'enabled as value', 'group_id as value').orderBy('id').limit(2).get()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).where('id', 1).delete() }))

    expect(subscription.current.data).toEqual(await handler())
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

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('realtime boolean aggregates on %s', (driver) => {
  it('keeps a numeric aggregate next to a boolean one on the same table equal to a fresh read', async () => {
    const statements: string[] = []
    const { db, schema } = await openDatabase(driver, {
      wrapAdapter: adapter => new Proxy(adapter, {
        get(target, property) {
          const query = target.query.bind(target)
          if (property !== 'query') return Reflect.get(target, property, target)
          return async (...args: Parameters<typeof query>) => {
            statements.push(String(args[0]))
            return await query(...args)
          }
        },
      }),
    })
    onTestFinished(() => resetRealtimeRuntime())
    const name = `holo_live_scores_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, (table) => {
      table.id()
      table.integer('group_id')
      table.boolean('enabled')
      table.integer('amount').nullable()
    })
    onTestFinished(() => schema.dropTable(name))
    const scores = defineGeneratedTable(name, { id: column.id(), group_id: column.integer(), enabled: column.boolean(), amount: column.integer().nullable() })
    await db.table(scores).insert([{ id: 1, group_id: 1, enabled: true, amount: 5 }, { id: 2, group_id: 2, enabled: false, amount: 7 }])
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const queries: Record<string, () => Promise<unknown>> = {
      flags: () => db.table(scores).sum('enabled'),
      amounts: () => db.table(scores).sum('amount'),
      lowest: () => db.table(scores).min('amount'),
      groupFlags: () => db.table(scores).where('group_id', 2).sum('enabled'),
      groupAmounts: () => db.table(scores).where('group_id', 1).sum('amount'),
    }
    const subscriptions = await Promise.all(Object.values(queries).map(handler => subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )))

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(scores).insert({ id: 3, group_id: 1, enabled: true, amount: null }) }))
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(scores).where('id', 1).delete() }))
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(scores).whereIn('group_id', [1, 2]).update({ amount: 9 }) }))

    expect(subscriptions.map(subscription => subscription.current.data)).toEqual(await Promise.all(Object.values(queries).map(handler => handler())))
    expect(statements.filter(statement => /(?:sum|avg|min|max)\([^)]*enabled/i.test(statement))).toEqual([])
  })

  it('keeps aggregate subscriptions over a boolean column equal to fresh reads', async () => {
    const { db, flags, schema } = await openFlags(driver)
    const groupsName = `holo_live_flag_totals_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(groupsName, (table) => {
      table.id()
      table.string('name')
    })
    onTestFinished(() => schema.dropTable(groupsName))
    const groups = defineGeneratedTable(groupsName, { id: column.id(), name: column.string() })
    await db.table(groups).insert([{ id: 1, name: 'first' }, { id: 2, name: 'second' }])
    const Flag = defineModel(flags, { timestamps: false })
    const Group = defineModel(groups, { timestamps: false, relations: { flags: hasMany(() => Flag, 'group_id') } })
    const queries: Record<string, () => Promise<unknown>> = {
      sum: () => db.table(flags).sum('enabled'),
      max: () => db.table(flags).where('group_id', 2).max('enabled'),
      modelSum: () => db.model(Flag).query().sum('enabled'),
      relationSum: () => db.model(Group).query().withSum('flags', 'enabled').orderBy('id').getJson(),
    }
    const subscriptions = await Promise.all(Object.values(queries).map(handler => subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )))
    const expectCurrent = async () => {
      expect(subscriptions.map(subscription => subscription.current.data)).toEqual(await Promise.all(Object.values(queries).map(handler => handler())))
    }

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).insert({ id: 3, group_id: 1, enabled: true }) }))
    await expectCurrent()
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).where('id', 2).update({ enabled: true }) }))
    await expectCurrent()
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).where('id', 2).delete() }))
    await expectCurrent()
    expect(subscriptions[0]!.current.data).toBe(2)
  })

  it.runIf(driver !== 'postgres')('keeps subscriptions equal to fresh reads when a name-only write stores a value other than one or zero', async () => {
    const { db, flags } = await openFlags(driver)
    const queries: Record<string, () => Promise<unknown>> = {
      rows: () => db.table(flags).orderBy('id').get(),
      enabledRows: () => db.table(flags).where('enabled', true).orderBy('id').get(),
      sum: () => db.table(flags).sum('enabled'),
    }
    const subscriptions = await Promise.all(Object.values(queries).map(handler => subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )))
    const expectCurrent = async () => {
      expect(subscriptions.map(subscription => subscription.current.data)).toEqual(await Promise.all(Object.values(queries).map(handler => handler())))
    }

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags.tableName).where('id', 1).update({ enabled: 2 }) }))
    await expectCurrent()
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags.tableName).insert({ id: 3, group_id: 1, enabled: 2 }) }))
    await expectCurrent()
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).insert({ id: 4, group_id: 1, enabled: true }) }))
    await expectCurrent()
  })

  it.runIf(driver !== 'postgres')('keeps an ordered subscription that read a value other than one or zero equal to a fresh read', async () => {
    const { db, flags } = await openFlags(driver)
    await db.table(flags.tableName).where('id', 1).update({ enabled: 2 })
    const handler = () => db.table(flags).orderBy('enabled').orderBy('id').get()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).insert({ id: 3, group_id: 1, enabled: true }) }))

    expect(subscription.current.data).toEqual(await handler())
  })

  it.runIf(driver !== 'postgres')('re-runs an ordered window once a backfill loads a value other than one or zero', async () => {
    const { db, flags } = await openFlags(driver)
    await db.table(flags).where('id', 1).update({ enabled: false })
    await db.table(flags).where('id', 2).update({ enabled: true })
    await db.table(flags.tableName).insert({ id: 3, group_id: 1, enabled: 2 })
    const handler = () => db.table(flags).orderBy('enabled').orderBy('id').limit(2).get()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).where('id', 1).delete() }))
    expect(subscription.current.data).toEqual(await handler())
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).insert({ id: 4, group_id: 1, enabled: true }) }))

    expect(subscription.current.data).toEqual(await handler())
  })

  it.runIf(driver !== 'postgres')('keeps hydrated relations equal to fresh reads when a loaded related row holds a boolean other than one or zero', async () => {
    const { db, flags, schema } = await openFlags(driver)
    const groupsName = `holo_live_odd_groups_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(groupsName, (table) => {
      table.id()
      table.boolean('visible')
    })
    onTestFinished(() => schema.dropTable(groupsName))
    const groups = defineGeneratedTable(groupsName, { id: column.id(), visible: column.boolean() })
    await db.table(groups).insert([{ id: 1, visible: true }, { id: 2, visible: true }, { id: 3, visible: true }])
    const Group = defineModel(groups, { timestamps: false })
    const Flag = defineModel(flags, { timestamps: false, relations: { group: belongsTo(() => Group, 'group_id') } })
    const GroupWithFlags = defineModel(groups, { timestamps: false, relations: { flags: hasMany(() => Flag, 'group_id') } })
    const queries: Record<string, () => Promise<unknown>> = {
      parents: () => db.model(Flag).query().with('group').orderBy('id').getJson(),
      children: () => db.model(GroupWithFlags).query().with({ flags: query => query.orderBy('id') }).orderBy('id').getJson(),
    }
    const subscriptions = await Promise.all(Object.values(queries).map(handler => subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )))
    await db.executeCompiled({ sql: `UPDATE ${groupsName} SET visible = 2 WHERE id = 3`, source: 'test:boolean-columns' })
    await db.executeCompiled({ sql: `UPDATE ${flags.tableName} SET enabled = 2 WHERE id = 1`, source: 'test:boolean-columns' })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).insert({ id: 3, group_id: 3, enabled: true }) }))
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).where('id', 2).update({ group_id: 1 }) }))

    expect(subscriptions.map(subscription => subscription.current.data)).toEqual(await Promise.all(Object.values(queries).map(handler => handler())))
  })

  it.runIf(driver !== 'postgres')('reads a value other than one or zero that a window backfill loads the way a fresh read does', async () => {
    const { db, flags } = await openFlags(driver)
    await db.table(flags.tableName).insert({ id: 3, group_id: 1, enabled: 2 })
    const handler = () => db.table(flags).orderBy('id').limit(2).get()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).where('id', 1).delete() }))

    expect(subscription.current.data).toEqual(await handler())
  })
})
