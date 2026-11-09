import { randomUUID } from 'node:crypto'
import { column, configureDB, createConnectionManager, defineGeneratedTable, defineModel } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

type AggregateCase = readonly [kind: 'timestamp' | 'bigint', unreadable: string, readable: string, grouped: boolean, untyped: boolean, rejects?: boolean]

describe.each(integrationDrivers(['sqlite', 'postgres'] as const))('model aggregate unreadable values on %s', (driver) => {
  const cases: readonly AggregateCase[] = driver === 'sqlite' ? [
    ['bigint', '1.5', '1', false, false],
    ['timestamp', '2026-02-01 00:00:00', '2026-01-01 00:00:00', false, false, false],
  ] : [
    ['timestamp', '280000-01-01 00:00:00', '2026-01-01 00:00:00', false, false],
    ['bigint', '9007199254740993', '7', false, false],
    ['timestamp', '280000-01-01 00:00:00', '2026-01-01 00:00:00', true, false],
    ['bigint', '9007199254740993', '7', true, false],
    ['timestamp', '280000-01-01 00:00:00', '2026-01-01 00:00:00', false, true],
    ['timestamp', '2026-02-01 00:00:00', '2026-01-01 00:00:00', false, false, false],
    ['timestamp', '2026-02-01 00:00:00', '2026-01-01 00:00:00', true, false, false],
  ]
  it.each(cases)('matches fresh reads for %s value %s (safe: %s, grouped: %s, untyped: %s)', async (kind, unreadable, readable, grouped, untyped, rejects = true) => {
    const { db, schema } = await openDatabase(driver, { connectionName: 'unreadable' })
    if (untyped) {
      const { db: primary } = await openDatabase('sqlite', { connectionName: 'primary' })
      configureDB(createConnectionManager({ defaultConnection: 'primary', connections: { primary, unreadable: db } }))
    }
    onTestFinished(() => resetRealtimeRuntime())
    const name = `holo_unreadable_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const createTable = (tableName: string) => schema.createTable(tableName, (table) => {
      table.integer('id').primaryKey()
      table.integer('score')
      table.integer('group_id')
      if (kind === 'timestamp') table.timestamp('stored')
      else table.bigInteger('stored')
    })
    const staging = `${name}_staging`
    await createTable(name)
    await createTable(staging)
    onTestFinished(async () => {
      await schema.dropTable(staging)
      await schema.dropTable(name)
    })
    await db.table(staging).insert([
      { id: 3, score: 5, group_id: 1, stored: unreadable },
      { id: 4, score: 5, group_id: 2, stored: unreadable },
    ])
    const table = defineGeneratedTable(name, {
      id: column.integer().primaryKey(),
      score: column.integer(),
      group_id: column.integer(),
      stored: kind === 'timestamp' ? column.timestamp() : column.bigInteger(),
    })
    const options = { timestamps: false, connectionName: db.getConnectionName() }
    const Model = untyped ? defineModel(name, options) : defineModel(table, options)
    await db.table(name).insert([
      { id: 1, score: 3, group_id: 1, stored: readable },
      { id: 2, score: 3, group_id: 2, stored: driver === 'sqlite' && kind === 'bigint' ? '9' : readable },
    ])
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const groups = grouped ? [1, 2] : [undefined]
    const handlers = groups.flatMap(group => (['sum', 'avg', 'min', 'max'] as const).map(aggregate => () => {
      const query = db.model(Model).query()
      return (group === undefined ? query : query.where('group_id', group))[aggregate]('score')
    }))
    const projectedHandler = () => db.model(Model).query().select('score').sum('score')
    const projectedErrors: unknown[] = []
    const projected = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: projectedHandler }), {}, {
      onData: () => {},
      onError: error => { projectedErrors.push(error) },
    })
    const results = await Promise.all(handlers.map(async (handler) => {
      const errors: unknown[] = []
      let runs = 0
      const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: () => {
        runs += 1
        return handler()
      } }), {}, {
        onData: () => {},
        onError: error => { errors.push(error) },
      })
      return { subscription, errors, runs: () => runs }
    }))

    expect(results.map(result => result.subscription.current.data)).toEqual(grouped ? [3, 3, 3, 3, 3, 3, 3, 3] : [6, 3, 3, 3])

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(name).insertUsing(
      ['id', 'score', 'group_id', 'stored'],
      db.table(staging).select('id', 'score', 'group_id', 'stored'),
    ) }))

    for (const [index, handler] of handlers.entries()) {
      const result = results[index]!
      if (rejects) {
        const fresh = await handler().then(() => undefined, (error: unknown) => error)
        expect(fresh).toBeInstanceOf(Error)
        expect.soft(result.errors.at(-1)).toEqual(fresh)
      } else {
        expect(result.errors).toEqual([])
        expect(result.subscription.current.data).toEqual(await handler())
      }
    }

    expect(projectedErrors).toEqual([])
    expect(projected.current.data).toBe(16)

    if (rejects) {
      await db.executeCompiled({ sql: `DELETE FROM "${name}" WHERE "id" > 2`, source: 'schema' })
    } else {
      await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(name).where('id', '>', 2).delete() }))
    }
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(name).where('id', 1).update({ score: 4 }) }))
    for (const [index, handler] of handlers.entries()) {
      expect(results[index]!.subscription.current.data).toEqual(await handler())
    }
  })
})
