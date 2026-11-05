import { randomUUID } from 'node:crypto'
import { column, defineGeneratedTable, defineModel, hasMany } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

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

describe.each(drivers)('realtime boolean columns on %s', (driver) => {
  it('keeps row, filtered and grouped subscriptions over a boolean column equal to fresh reads after mutations', async () => {
    const { db, flags } = await openFlags(driver)
    const queries: Record<string, () => Promise<unknown>> = {
      rows: () => db.table(flags).select('id', 'enabled').orderBy('id').get(),
      enabledRows: () => db.table(flags).where('enabled', true).orderBy('id').get(),
      orderedByFlag: () => db.table(flags).select('id', 'enabled').orderBy('enabled').orderBy('id').get(),
      groupedByFlag: () => db.table(flags).select('enabled').addSelectCount('total').groupBy('enabled').orderBy('enabled').get(),
    }
    const subscriptions = await Promise.all(Object.values(queries).map(handler => subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )))
    const expectCurrent = async () => {
      const fresh = await Promise.all(Object.values(queries).map(handler => handler()))
      expect(subscriptions.map(subscription => subscription.current.data)).toEqual(fresh)
    }

    await expectCurrent()
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).insert({ id: 3, group_id: 1, enabled: true }) }))
    await expectCurrent()
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).where('id', 2).update({ enabled: true }) }))
    await expectCurrent()
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).where('id', 1).update({ enabled: false }) }))
    await expectCurrent()
    expect(subscriptions[0]!.current.data).toEqual([{ id: 1, enabled: false }, { id: 2, enabled: true }, { id: 3, enabled: true }])
  })

  it('keeps patching subscriptions that read no boolean column', async () => {
    const { db, flags } = await openFlags(driver)
    let handlerRuns = 0
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: () => {
      handlerRuns += 1
      return db.table(flags).select('group_id').addSelectCount('total').groupBy('group_id').orderBy('group_id').get()
    } }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).insert({ id: 3, group_id: 1, enabled: true }) }))

    expect(subscription.current.data).toEqual([{ group_id: 1, total: 2 }, { group_id: 2, total: 1 }])
    expect(handlerRuns).toBe(1)
  })

  it('keeps model subscriptions over a boolean column equal to fresh reads after an insert', async () => {
    const { db, flags, schema } = await openFlags(driver)
    const groupsName = `holo_live_flag_groups_${randomUUID().replaceAll('-', '').slice(0, 12)}`
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
      models: () => db.model(Flag).query().orderBy('id').getJson(),
      eager: () => db.model(Group).query().with({ flags: query => query.orderBy('id') }).orderBy('id').getJson(),
    }
    const subscriptions = await Promise.all(Object.values(queries).map(handler => subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )))

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(flags).insert({ id: 3, group_id: 1, enabled: true }) }))

    expect(subscriptions.map(subscription => subscription.current.data)).toEqual(await Promise.all(Object.values(queries).map(handler => handler())))
    expect(JSON.stringify(subscriptions[0]!.current.data)).toContain('"id":3,"group_id":1,"enabled":true')
  })
})
