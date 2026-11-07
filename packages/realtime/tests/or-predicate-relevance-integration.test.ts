import { randomUUID } from 'node:crypto'
import { column, defineGeneratedTable } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

describe.each(drivers)('realtime OR predicate relevance on %s', (driver) => {
  it.each(['first', 'last', 'precedence', 'nested', 'unknown', 'json'] as const)('keeps the snapshot equal to a fresh query when the matching OR branch is %s', async (scenario) => {
    const { db, schema } = await openDatabase(driver)
    onTestFinished(() => resetRealtimeRuntime())
    const name = `holo_or_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, (table) => {
      table.id()
      table.integer('a')
      table.integer('b').nullable()
      table.json('settings')
    })
    onTestFinished(() => schema.dropTable(name))
    const rows = defineGeneratedTable(name, { id: column.id(), a: column.integer(), b: column.integer().nullable(), settings: column.json<{ enabled: boolean }>() })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const queries = {
      first: () => db.table(rows).where('a', 1).orWhere('b', '>', null),
      last: () => db.table(rows).where('b', '>', null).orWhere('a', 1),
      precedence: () => db.table(rows).where('a', 1).orWhere('b', '>', null).where('a', 2),
      nested: () => db.table(rows).where(query => query.where('a', 1).orWhere('b', '>', null)).where('a', 1),
      unknown: () => db.table(rows).whereNull('b').orWhere('a', '>', null),
      json: () => db.table(rows).where('a', 9).orWhere(query => query.where('settings', { enabled: true })),
    }
    const handler = () => queries[scenario]().orderBy('id').get()
    const errors: unknown[] = []
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, {
      onData: () => {},
      onError: (error) => { errors.push(error) },
    })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(rows).insert({ a: 1, b: null, settings: { enabled: true } }) }))

    const fresh = await handler()
    expect(fresh).toHaveLength(1)
    expect({ errors, data: subscription.current.data }).toEqual({ errors: [], data: fresh })
  })
})
