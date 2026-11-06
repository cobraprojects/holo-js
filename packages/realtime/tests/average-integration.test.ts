import { randomUUID } from 'node:crypto'
import { column, defineGeneratedTable, defineModel, hasMany } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

type Driver = typeof drivers[number]

async function openScores(driver: Driver, options: Parameters<typeof openDatabase>[1] = {}) {
  const { db, schema } = await openDatabase(driver, options)
  onTestFinished(() => resetRealtimeRuntime())
  const name = `holo_live_scores_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await schema.createTable(name, (table) => {
    table.id()
    table.integer('group_id').nullable()
    table.integer('points')
    table.decimal('amount')
    table.decimal('bonus').nullable()
    table.real('ratio').nullable()
    table.bigInteger('total').nullable()
  })
  onTestFinished(() => schema.dropTable(name))
  const scores = defineGeneratedTable(name, { id: column.id(), group_id: column.integer().nullable(), points: column.integer(), amount: column.decimal(), bonus: column.decimal().nullable(), ratio: column.real().nullable(), total: column.bigInteger().nullable() })
  await db.table(scores).insert([
    { id: 1, group_id: 1, points: 1, amount: '1.00' },
    { id: 2, group_id: 1, points: 2, amount: '2.00' },
    { id: 3, group_id: 2, points: 5, amount: '5.00' },
    { id: 5, group_id: 2, points: 3, amount: '3.01' },
  ])
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { db, name, schema, scores }
}

describe.each(drivers)('realtime averages on %s', (driver) => {
  it.each(['points', 'amount'] as const)('keeps grouped and plain averages over the %s column equal to a fresh query', async (averaged) => {
    const { db, scores } = await openScores(driver)
    const queries: Record<string, () => Promise<unknown>> = {
      grouped: () => db.table(scores).select('group_id').addSelectAvg('average', averaged).groupBy('group_id').orderBy('group_id').get(),
      selected: () => db.table(scores).selectAvg('average', averaged).get(),
      filtered: () => db.table(scores).where('group_id', 1).selectAvg('average', averaged).get(),
      plain: () => db.table(scores).avg(averaged),
    }
    const subscriptions = await Promise.all(Object.values(queries).map(handler => subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )))
    const expectCurrent = async () => {
      const fresh = await Promise.all(Object.values(queries).map(handler => handler()))
      expect(Object.fromEntries(Object.keys(queries).map((key, index) => [key, subscriptions[index]!.current.data])))
        .toEqual(Object.fromEntries(Object.keys(queries).map((key, index) => [key, fresh[index]])))
    }
    const mutate = (handler: () => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))

    await expectCurrent()
    await mutate(() => db.table(scores).insert({ id: 4, group_id: 1, points: 4, amount: '4.01' }))
    await expectCurrent()
    await mutate(() => db.table(scores).where('id', 3).update({ points: 8, amount: '7.33' }))
    await expectCurrent()
    await mutate(() => db.table(scores).where('id', 2).update({ group_id: 2 }))
    await expectCurrent()
    await mutate(() => db.table(scores).where('id', 1).delete())
    await expectCurrent()
    await mutate(() => db.table(scores).where('id', 4).delete())
    await expectCurrent()
  })
  it('keeps a plain average over a nullable column equal to a fresh query', async () => {
    const { db, scores } = await openScores(driver)
    const handler = () => db.table(scores).avg('bonus')
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })
    const mutate = (mutation: () => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: mutation }))

    await mutate(() => db.table(scores).where('id', 1).update({ bonus: '1.00' }))
    expect(subscription.current.data).toEqual(await handler())
    await mutate(() => db.table(scores).where('id', 2).update({ bonus: '2.01' }))
    expect(subscription.current.data).toEqual(await handler())
    await mutate(() => db.table(scores).insert({ id: 6, group_id: 1, points: 1, amount: '1.00', bonus: '4.00' }))
    expect(subscription.current.data).toEqual(await handler())
    await mutate(() => db.table(scores).where('id', 6).delete())
    expect(subscription.current.data).toEqual(await handler())
    expect(subscription.current.data).toBeCloseTo(1.505)
  })
  it('keeps a grouped average with a null group equal to a fresh query', async () => {
    const { db, scores } = await openScores(driver)
    await db.table(scores).insert({ id: 6, group_id: null, points: 2, amount: '2.00' })
    const handler = () => db.table(scores).select('group_id').addSelectAvg('average', 'points').groupBy('group_id').orderBy('group_id').get()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })
    const mutate = (mutation: () => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: mutation }))

    await mutate(() => db.table(scores).insert({ id: 7, group_id: null, points: 5, amount: '5.00' }))
    expect(subscription.current.data).toEqual(await handler())
    await mutate(() => db.table(scores).where('id', 1).update({ group_id: null }))
    expect(subscription.current.data).toEqual(await handler())
    await mutate(() => db.table(scores).where('id', 6).delete())
    expect(subscription.current.data).toEqual(await handler())
    expect(subscription.current.data).toContainEqual(expect.objectContaining({ group_id: null }))
  })
  it('keeps a plain decimal average equal to a fresh query when the sum is inexact in floating point', async () => {
    const { db, scores } = await openScores(driver)
    await db.table(scores).where('id', '>', 2).delete()
    await db.table(scores).where('id', 1).update({ amount: '0.01' })
    await db.table(scores).where('id', 2).update({ amount: '0.03' })
    const handler = () => db.table(scores).orderBy('id').avg('amount')
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(scores).insert({ id: 6, group_id: 1, points: 1, amount: '0.17' }) }))

    expect(subscription.current.data).toBe(await handler())
    expect(subscription.current.data).toBe(0.07)
  })
  it('keeps plain decimal averages read in opposite orders equal to their fresh queries', async () => {
    const { db, scores } = await openScores(driver)
    await db.table(scores).where('id', '>', 2).delete()
    await db.table(scores).where('id', 1).update({ amount: '0.10' })
    await db.table(scores).where('id', 2).update({ amount: '0.20' })
    const handlers = [
      () => db.table(scores).orderBy('id').avg('amount'),
      () => db.table(scores).orderBy('id', 'desc').avg('amount'),
    ]
    const subscriptions = await Promise.all(handlers.map(handler => subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })))

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(scores).insert({ id: 6, group_id: 1, points: 1, amount: '0.30' }) }))

    expect(subscriptions.map(subscription => subscription.current.data)).toEqual(await Promise.all(handlers.map(handler => handler())))
  })
  it.each(['amount', 'ratio'] as const)('keeps grouped and plain averages over the %s column equal to a fresh query when values are written as fractional numbers', async (averaged) => {
    const { db, scores } = await openScores(driver)
    await db.table(scores).where('id', '>', 0).delete()
    const queries = [
      () => db.table(scores).select('group_id').addSelectAvg('average', averaged).groupBy('group_id').orderBy('group_id').get(),
      () => db.table(scores).orderBy('id').avg(averaged),
      () => db.table(scores).where('group_id', 1).orderBy('id').avg(averaged),
    ]
    const subscriptions = await Promise.all(queries.map(handler => subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })))
    const mutate = (mutation: () => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: mutation }))
    const expectCurrent = async () => {
      expect(subscriptions.map(subscription => subscription.current.data)).toEqual(await Promise.all(queries.map(handler => handler())))
    }

    await mutate(() => db.table(scores).insert({ id: 1, group_id: 1, points: 1, amount: 0.1, ratio: 0.1 }))
    await expectCurrent()
    await mutate(() => db.table(scores).insert({ id: 2, group_id: 1, points: 2, amount: 0.2, ratio: 0.2 }))
    await expectCurrent()
    await mutate(() => db.table(scores).where('id', 1).delete())
    await expectCurrent()
    expect(subscriptions.map(subscription => subscription.current.data)).toEqual([[{ group_id: 1, average: 0.2 }], 0.2, 0.2])
    await mutate(() => db.table(scores).insert({ id: 3, group_id: 1, points: 3, amount: 0.7, ratio: 0.7 }))
    await expectCurrent()
    await mutate(() => db.table(scores).where('id', 2).update({ amount: 0.3, ratio: 0.3 }))
    await expectCurrent()
    await mutate(() => db.table(scores).where('id', 3).update({ amount: 4, ratio: 4 }))
    await expectCurrent()
    await mutate(() => db.table(scores).where('id', 2).update({ amount: 1, ratio: 1 }))
    await expectCurrent()
    await mutate(() => db.table(scores).insert({ id: 4, group_id: 1, points: 4, amount: 7, ratio: 7 }))
    await expectCurrent()
  })
  it('keeps a grouped average filtered by a group count equal to a fresh query as groups cross the threshold', async () => {
    const { db, scores } = await openScores(driver)
    const handler = () => db.table(scores).select('group_id').addSelectAvg('average', 'ratio').groupBy('group_id').having('count(*)', '>', 1).orderBy('group_id').get()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })
    const mutate = (mutation: () => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: mutation }))

    await mutate(() => db.table(scores).where('id', 1).update({ ratio: 0.1 }))
    expect(subscription.current.data).toEqual(await handler())
    await mutate(() => db.table(scores).where('id', 2).update({ group_id: 3, ratio: 2 }))
    expect(subscription.current.data).toEqual(await handler())
    await mutate(() => db.table(scores).insert({ id: 6, group_id: 3, points: 1, amount: '1.00', ratio: 4 }))
    expect(subscription.current.data).toEqual(await handler())
    await mutate(() => db.table(scores).insert({ id: 7, group_id: 1, points: 1, amount: '1.00', ratio: 0.2 }))
    expect(subscription.current.data).toEqual(await handler())
    await mutate(() => db.table(scores).where('id', 6).update({ ratio: 6 }))
    expect(subscription.current.data).toEqual(await handler())
    expect(subscription.current.data).toContainEqual(expect.objectContaining({ group_id: 3, average: 4 }))
  })
  it('keeps grouped and plain averages equal to a fresh query when sums pass the safe integer range', async () => {
    const { db, scores } = await openScores(driver)
    await db.table(scores).where('id', '>', 0).delete()
    await db.table(scores).insert([
      { id: 1, group_id: 1, points: 1, amount: '1.00', ratio: Number.MAX_SAFE_INTEGER },
      { id: 2, group_id: 1, points: 1, amount: '1.00', ratio: 2 },
      { id: 3, group_id: 2, points: 1, amount: '1.00', ratio: -Number.MAX_SAFE_INTEGER },
    ])
    const queries = [
      () => db.table(scores).select('group_id').addSelectAvg('average', 'ratio').groupBy('group_id').orderBy('group_id').get(),
      () => db.table(scores).where('group_id', 2).orderBy('id').avg('ratio'),
    ]
    const subscriptions = await Promise.all(queries.map(handler => subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })))
    const mutate = (mutation: () => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: mutation }))
    const expectCurrent = async () => {
      expect(subscriptions.map(subscription => subscription.current.data)).toEqual(await Promise.all(queries.map(handler => handler())))
    }

    await mutate(() => db.table(scores).where('id', 1).delete())
    await expectCurrent()
    await mutate(() => db.table(scores).insert([
      { id: 4, group_id: 2, points: 1, amount: '1.00', ratio: Number.MAX_SAFE_INTEGER },
      { id: 5, group_id: 2, points: 1, amount: '1.00', ratio: 2 },
    ]))
    await expectCurrent()
  })
  it('keeps grouped and plain averages equal to a fresh query when fractional values sum to a whole number', async () => {
    const { db, scores } = await openScores(driver)
    await db.table(scores).where('id', '>', 0).delete()
    await db.table(scores).insert([
      { id: 1, group_id: 1, points: 1, amount: '1.00', ratio: 1 },
      { id: 2, group_id: 1, points: 1, amount: '1.00', ratio: 0.1 },
      { id: 3, group_id: 1, points: 1, amount: '1.00', ratio: 0.2 },
      { id: 4, group_id: 1, points: 1, amount: '1.00', ratio: -0.3 },
    ])
    const queries = [
      () => db.table(scores).select('group_id').addSelectAvg('average', 'ratio').groupBy('group_id').orderBy('group_id').get(),
      () => db.table(scores).orderBy('id').avg('ratio'),
    ]
    const subscriptions = await Promise.all(queries.map(handler => subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })))

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(scores).where('id', 1).delete() }))

    expect(subscriptions.map(subscription => subscription.current.data)).toEqual(await Promise.all(queries.map(handler => handler())))
  })
  it('keeps a plain average equal to a fresh query when an intermediate sum leaves the safe integer range', async () => {
    const { db, scores } = await openScores(driver)
    await db.table(scores).where('id', '>', 0).delete()
    await db.table(scores).insert([
      { id: 1, group_id: 1, points: 1, amount: '1.00', ratio: Number.MAX_SAFE_INTEGER },
      { id: 2, group_id: 1, points: 1, amount: '1.00', ratio: 2 },
      { id: 3, group_id: 1, points: 1, amount: '1.00', ratio: -Number.MAX_SAFE_INTEGER },
    ])
    const handler = () => db.table(scores).orderBy('id').avg('ratio')
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(scores).where('id', 2).delete() }))

    expect(subscription.current.data).toBe(await handler())
  })
  it('keeps a grouped bigint average equal to a fresh query when a group sum leaves the safe integer range', async () => {
    const { db, scores } = await openScores(driver)
    await db.table(scores).where('id', '>', 0).delete()
    await db.table(scores).insert([
      { id: 1, group_id: 1, points: 1, amount: '1.00', total: Number.MAX_SAFE_INTEGER },
      { id: 2, group_id: 1, points: 1, amount: '1.00', total: 1 },
      { id: 3, group_id: 2, points: 1, amount: '1.00', total: 4 },
    ])
    const handler = () => db.table(scores).select('group_id').addSelectAvg('average', 'total').groupBy('group_id').orderBy('group_id').get()
    const errors: unknown[] = []
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { errors.push(error) } })
    const mutate = (mutation: () => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: mutation }))

    await mutate(() => db.table(scores).insert({ id: 4, group_id: 1, points: 1, amount: '1.00', total: 1 }))
    expect(subscription.current.data).toEqual(await handler())
    await mutate(() => db.table(scores).insert({ id: 5, group_id: 2, points: 1, amount: '1.00', total: 6 }))
    expect(subscription.current.data).toEqual(await handler())
    expect(errors).toEqual([])
  })
  it('keeps a relation average equal to a fresh query when fractional values sum to a whole number', async () => {
    const { db, name, schema, scores } = await openScores(driver)
    await db.table(scores).where('id', '>', 0).delete()
    const groupsName = `${name}_groups`
    await schema.createTable(groupsName, (table) => {
      table.id()
    })
    onTestFinished(() => schema.dropTable(groupsName))
    const groups = defineGeneratedTable(groupsName, { id: column.id() })
    const Score = defineModel(scores)
    const Group = defineModel(groups, { relations: { scores: hasMany(() => Score, 'group_id') } })
    await db.table(groups).insert({ id: 1 })
    await db.table(scores).insert([
      { id: 1, group_id: 1, points: 1, amount: '1.00', ratio: 1 },
      { id: 2, group_id: 1, points: 1, amount: '1.00', ratio: 0.1 },
      { id: 3, group_id: 1, points: 1, amount: '1.00', ratio: 0.2 },
      { id: 4, group_id: 1, points: 1, amount: '1.00', ratio: -0.3 },
    ])
    const handler = async () => (await Group.query().withAvg('scores', 'ratio').orderBy('id').get()).toJSON()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(scores).where('id', 1).delete() }))

    expect(subscription.current.data).toEqual(await handler())
  })
  it('reads refreshed grouped average states once for equivalent subscriptions', async () => {
    const statements: string[] = []
    const { db, scores } = await openScores(driver, { wrapAdapter: adapter => new Proxy(adapter, {
      get(target, key) {
        const value = Reflect.get(target, key, target)
        if (key === 'query') {
          return (sql: string, ...rest: unknown[]) => {
            statements.push(sql)
            return Reflect.apply(value, target, [sql, ...rest])
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) })
    await db.table(scores).where('id', '>', 0).update({ total: 3 })
    const subscriptions = await Promise.all([1, 2, 3].map(() => subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler: () => db.table(scores).select('group_id').addSelectAvg('average', 'total').groupBy('group_id').orderBy('group_id').get() }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )))
    statements.length = 0

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(scores).where('id', 1).update({ total: null }) }))

    const fresh = await db.table(scores).select('group_id').addSelectAvg('average', 'total').groupBy('group_id').orderBy('group_id').get()
    expect(subscriptions.map(subscription => subscription.current.data)).toEqual([fresh, fresh, fresh])
    expect(statements.filter(sql => sql.includes('__holo_grouped_average_sum'))).toHaveLength(driver === 'postgres' ? 1 : 0)
  })
  it.runIf(driver === 'sqlite')('keeps a grouped average over an integer column holding fractional values equal to a fresh query', async () => {
    const { db, scores } = await openScores(driver)
    await db.table(scores).where('id', '>', 0).delete()
    await db.table(scores).insert([
      { id: 1, group_id: 1, points: 1, amount: '1.00' },
      { id: 2, group_id: 1, points: 0.1, amount: '1.00' },
      { id: 3, group_id: 1, points: 0.2, amount: '1.00' },
      { id: 4, group_id: 1, points: -0.3, amount: '1.00' },
    ])
    const handler = () => db.table(scores).select('group_id').addSelectAvg('average', 'points').groupBy('group_id').orderBy('group_id').get()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(scores).where('id', 1).delete() }))

    expect(subscription.current.data).toEqual(await handler())
  })
  it('keeps a plain average equal to a fresh query when a mutation pushes a partial sum in query order past the safe integer range', async () => {
    const { db, scores } = await openScores(driver)
    await db.table(scores).where('id', '>', 0).delete()
    await db.table(scores).insert([
      { id: 1, group_id: 1, points: 1, amount: '1.00', total: Number.MAX_SAFE_INTEGER },
      { id: 3, group_id: 1, points: 1, amount: '1.00', total: -Number.MAX_SAFE_INTEGER },
    ])
    const handler = () => db.table(scores).orderBy('id').avg('total')
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(scores).insert({ id: 2, group_id: 1, points: 1, amount: '1.00', total: 2 }) }))

    expect(subscription.current.data).toBe(await handler())
  })
  it('keeps a plain fractional average equal to a fresh query when an update reorders its rows', async () => {
    const { db, scores } = await openScores(driver)
    await db.table(scores).where('id', '>', 0).delete()
    await db.table(scores).insert([
      { id: 1, group_id: 1, points: 1, amount: '1.00', ratio: 0.1 },
      { id: 2, group_id: 1, points: 2, amount: '1.00', ratio: 0.2 },
      { id: 3, group_id: 1, points: 3, amount: '1.00', ratio: 0.3 },
    ])
    const handler = () => db.table(scores).orderBy('points').avg('ratio')
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(scores).where('id', 1).update({ points: 4 }) }))

    expect(subscription.current.data).toBe(await handler())
  })
  it('reruns a plain fractional average without an order when one of its rows changes', async () => {
    const { db, scores } = await openScores(driver)
    await db.table(scores).where('id', '>', 0).delete()
    await db.table(scores).insert([
      { id: 1, group_id: 1, points: 1, amount: '1.00', ratio: 0.3 },
      { id: 2, group_id: 1, points: 2, amount: '1.00', ratio: 0.2 },
      { id: 3, group_id: 1, points: 3, amount: '1.00', ratio: 0.1 },
    ])
    let runs = 0
    const handler = () => {
      runs += 1
      return db.table(scores).avg('ratio')
    }
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(scores).where('id', 1).update({ points: 4 }) }))

    expect(runs).toBe(2)
    expect(subscription.current.data).toBe(await db.table(scores).avg('ratio'))
  })
  it('reruns a grouped fractional average when one of its groups changes', async () => {
    const { db, scores } = await openScores(driver)
    await db.table(scores).where('id', '>', 0).update({ ratio: 0.5 })
    let runs = 0
    const handler = () => {
      runs += 1
      return db.table(scores).select('group_id').addSelectAvg('average', 'ratio').groupBy('group_id').orderBy('group_id', 'desc').get()
    }
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(scores).insert({ id: 6, group_id: 1, points: 1, amount: '1.00', ratio: 0.1 }) }))

    expect(runs).toBe(2)
    expect(subscription.current.data).toEqual(await db.table(scores).select('group_id').addSelectAvg('average', 'ratio').groupBy('group_id').orderBy('group_id', 'desc').get())
  })
  it('keeps relation aggregates of a parent with a null key equal to a fresh query', async () => {
    const { db, name, schema, scores } = await openScores(driver)
    const groupsName = `${name}_groups`
    await schema.createTable(groupsName, (table) => {
      table.id()
      table.integer('code').nullable()
    })
    onTestFinished(() => schema.dropTable(groupsName))
    const groups = defineGeneratedTable(groupsName, { id: column.id(), code: column.integer().nullable() })
    const Score = defineModel(scores)
    const Group = defineModel(groups, { relations: { scores: hasMany(() => Score, 'group_id', 'code') } })
    await db.table(groups).insert([{ id: 1, code: 1 }, { id: 2, code: null }])
    await db.table(scores).insert({ id: 6, group_id: null, points: 4, amount: '1.00' })
    const handler = async () => (await Group.query().withCount('scores').withAvg('scores', 'points').orderBy('id').get()).toJSON()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })
    const mutate = (mutation: () => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: mutation }))

    await mutate(() => db.table(scores).insert({ id: 7, group_id: null, points: 8, amount: '1.00' }))
    expect(subscription.current.data).toEqual(await handler())
    await mutate(() => db.table(scores).where('id', 1).update({ group_id: null }))
    expect(subscription.current.data).toEqual(await handler())
    await mutate(() => db.table(scores).whereNull('group_id').update({ points: 2 }))
    expect(subscription.current.data).toEqual(await handler())
    await mutate(() => db.table(scores).whereNull('group_id').delete())
    expect(subscription.current.data).toEqual(await handler())
  })
  it('keeps a grouped integer average by a bigint group equal to a fresh query after a backfill refreshes its states', async () => {
    const { db, scores } = await openScores(driver)
    await db.table(scores).where('id', '>', 0).delete()
    await db.table(scores).insert([
      { id: 1, group_id: 2, points: 1, amount: '1.00', total: 5 },
      { id: 2, group_id: 4, points: 1, amount: '1.00', total: 5 },
    ])
    const handler = () => db.table(scores).select('total').addSelectAvg('average', 'group_id').groupBy('total').orderBy('total').get()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })
    const mutate = (mutation: () => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: mutation }))

    await mutate(() => db.table(scores).insert({ id: 3, group_id: null, points: 1, amount: '1.00', total: 5 }))
    expect(subscription.current.data).toEqual(await handler())
    await mutate(() => db.table(scores).insert({ id: 4, group_id: 6, points: 1, amount: '1.00', total: 5 }))
    expect(subscription.current.data).toEqual(await handler())
  })
  it('keeps scalar and paginated subscriptions over the null group equal to a fresh query', async () => {
    const { db, scores } = await openScores(driver)
    await db.table(scores).insert({ id: 6, group_id: null, points: 2, amount: '2.00' })
    const queries = [
      () => db.table(scores).whereNull('group_id').sum('points'),
      () => db.table(scores).whereNull('group_id').count(),
      () => db.table(scores).where('group_id', 1).sum('points'),
      () => db.table(scores).where('group_id', 2).sum('points'),
      () => db.table(scores).whereNull('group_id').orderBy('id').paginate(1, 1),
      () => db.table(scores).where('group_id', 1).orderBy('id').paginate(1, 1),
      () => db.table(scores).where('group_id', 2).orderBy('id').paginate(1, 1),
    ]
    const subscriptions = await Promise.all(queries.map(handler => subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })))
    const mutate = (mutation: () => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: mutation }))
    const totals = (values: readonly unknown[]) => values.map(value => typeof value === 'object' && value !== null && 'meta' in value ? value.meta : value)
    const expectCurrent = async () => {
      expect(totals(subscriptions.map(subscription => subscription.current.data))).toEqual(totals(await Promise.all(queries.map(handler => handler()))))
    }

    await mutate(() => db.table(scores).insert({ id: 7, group_id: null, points: 5, amount: '5.00' }))
    await expectCurrent()
    await mutate(() => db.table(scores).where('id', 1).update({ group_id: null }))
    await expectCurrent()
    await mutate(() => db.table(scores).whereNull('group_id').update({ points: 9 }))
    await expectCurrent()
    await mutate(() => db.table(scores).where('group_id', 2).update({ group_id: null }))
    await expectCurrent()
    await mutate(() => db.table(scores).whereNull('group_id').delete())
    await expectCurrent()
  })
})
