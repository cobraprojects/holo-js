import { randomUUID } from 'node:crypto'
import { belongsToMany, column, createDatabase, createDialect, defineGeneratedTable, defineModel } from '@holo-js/db'
import { createMySQLAdapter } from '../../db-mysql/src'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, mysqlTestConnection, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

function mutate(handler: () => Promise<unknown>) {
  return executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
}

async function openFixture(driver: typeof drivers[number]) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const groupsName = `holo_norm_groups_${suffix}`
  const tagsName = `holo_norm_tags_${suffix}`
  const pivotName = `holo_norm_rates_${suffix}`
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
    table.decimal('rate')
  })
  if (driver === 'postgres') {
    await db.executeCompiled({ sql: `ALTER TABLE "${pivotName}" ALTER COLUMN "rate" TYPE NUMERIC(10, 2)`, source: 'schema' })
  }
  onTestFinished(async () => {
    await schema.dropTable(pivotName)
    await schema.dropTable(tagsName)
    await schema.dropTable(groupsName)
  })
  const groups = defineGeneratedTable(groupsName, { id: column.id(), name: column.string() })
  const tags = defineGeneratedTable(tagsName, { id: column.id(), name: column.string() })
  const rates = defineGeneratedTable(pivotName, { id: column.id(), group_id: column.bigInteger(), tag_id: column.bigInteger(), rate: column.decimal() })
  await db.table(groups).insert([{ id: 1, name: 'first' }, { id: 2, name: 'second' }])
  await db.table(tags).insert([{ id: 1, name: 'sale' }, { id: 2, name: 'new' }])
  await db.table(rates).insert({ id: 1, group_id: 1, tag_id: 1, rate: '12.30' })
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  const Tag = defineModel(tags, { timestamps: false })
  const Rate = defineModel(rates, { timestamps: false, fillable: ['rate'] })
  const Group = defineModel(groups, { timestamps: false, relations: { tags: belongsToMany(() => Tag, rates, 'group_id', 'tag_id').withPivot('id', 'rate').using(() => Rate) } })
  return { db, rates, Group, Rate }
}

describe.each(drivers)('realtime values the database normalizes on %s', (driver) => {
  it('keeps pivot ids and decimal values equal to a fresh query after inserts and updates', async () => {
    const { db, rates, Group, Rate } = await openFixture(driver)
    const queries: Record<string, () => Promise<unknown>> = {
      rows: () => db.table(rates).orderBy('id').get(),
      projected: () => db.table(rates).select('id', 'group_id', 'rate').orderBy('id').get(),
      first: () => db.table(rates).where('id', 1).first(),
      models: () => db.model(Rate).query().orderBy('id').getJson(),
      pivots: () => db.model(Group).query().with('tags').orderBy('id').getJson(),
    }
    const subscriptions = await Promise.all(Object.values(queries).map(handler => subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )))
    const expectFresh = async () => {
      const fresh = await Promise.all(Object.values(queries).map(handler => handler()))
      expect(Object.fromEntries(Object.keys(queries).map((name, index) => [name, subscriptions[index]!.current.data])))
        .toEqual(Object.fromEntries(Object.keys(queries).map((name, index) => [name, fresh[index]])))
    }

    await mutate(() => db.table(rates).insert({ id: '2', group_id: '2', tag_id: '1', rate: '9.5' }))
    await expectFresh()
    await mutate(() => db.table(rates).insert({ id: '3', group_id: '1', tag_id: '2', rate: 7 }))
    await expectFresh()
    await mutate(() => db.table(rates).where('id', 1).update({ rate: '4.5', group_id: '2' }))
    await expectFresh()
    await mutate(() => db.model(Rate).query().where('id', 3).update({ rate: '1.255' }))
    await expectFresh()
    await mutate(() => db.table(rates).upsert([{ id: '3', group_id: '1', tag_id: '2', rate: '2.5' }, { id: '4', group_id: '2', tag_id: '2', rate: '3' }], ['id'], ['rate']))
    await expectFresh()
    await mutate(() => db.table(rates).insertOrIgnore([{ id: '4', group_id: '1', tag_id: '1', rate: '8' }, { id: '5', group_id: '1', tag_id: '1', rate: '6.5' }]))
    await expectFresh()
    await mutate(() => db.table(rates).where('id', 2).increment('rate', 1, { tag_id: '2' }))
    await expectFresh()
    if (driver === 'postgres') {
      await db.executeCompiled({ sql: `SELECT setval(pg_get_serial_sequence('"${rates.tableName}"', 'id'), 10)`, source: 'schema' })
    }
    await mutate(() => db.table(rates).insert([{ group_id: '1', tag_id: '1', rate: '0.5' }, { group_id: '2', tag_id: '2', rate: '1.255' }]))
    await expectFresh()
    expect(JSON.stringify(subscriptions[0]!.current.data)).toContain('"4.50"')
  })

  it('keeps a filtered subscription equal to a fresh query when an update moves a row into it', async () => {
    const { db, rates } = await openFixture(driver)
    await db.table(rates).insert({ id: 2, group_id: 2, tag_id: 2, rate: '5.00' })
    const queries: Record<string, () => Promise<unknown>> = {
      rows: () => db.table(rates).where('group_id', 2).orderBy('id').get(),
      projected: () => db.table(rates).select('id', 'tag_id').where('group_id', 2).orderBy('id').get(),
      first: () => db.table(rates).where('group_id', 2).orderBy('id').first(),
      count: () => db.table(rates).where('group_id', 2).count(),
    }
    let reads = 0
    const subscriptions = await Promise.all(Object.values(queries).map(handler => subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler: () => {
        reads += 1
        return handler()
      } }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )))
    const expectFresh = async () => {
      const fresh = await Promise.all(Object.values(queries).map(handler => handler()))
      expect(subscriptions.map(subscription => subscription.current.data)).toEqual(fresh)
    }

    await mutate(() => db.table(rates).where('id', 1).update({ group_id: 2 }))
    await expectFresh()
    expect(subscriptions[0]!.current.data).toEqual([{ id: 1, group_id: 2, tag_id: 1, rate: '12.30' }, { id: 2, group_id: 2, tag_id: 2, rate: '5.00' }])
    await mutate(() => db.table(rates).where('id', 1).update({ tag_id: 3 }))
    await expectFresh()
    await mutate(() => db.table(rates).where('id', 2).update({ group_id: 1 }))
    await expectFresh()
    expect(subscriptions[0]!.current.data).toEqual([{ id: 1, group_id: 2, tag_id: 3, rate: '12.30' }])
    if (driver !== 'sqlite') expect(reads).toBe(Object.keys(queries).length)
  })

  it('keeps a table keyed by a decimal column equal to a fresh query after updating its key', async () => {
    const { db, schema } = await openDatabase(driver)
    onTestFinished(() => resetRealtimeRuntime())
    const name = `holo_norm_prices_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, (table) => {
      table.decimal('code').primaryKey()
      table.decimal('rate')
    })
    if (driver === 'postgres') {
      await db.executeCompiled({ sql: `ALTER TABLE "${name}" ALTER COLUMN "code" TYPE NUMERIC(10, 2), ALTER COLUMN "rate" TYPE NUMERIC(10, 2)`, source: 'schema' })
    }
    onTestFinished(() => schema.dropTable(name))
    const prices = defineGeneratedTable(name, { code: column.decimal().primaryKey(), rate: column.decimal() })
    await db.table(prices).insert({ code: '1.00', rate: '1.00' })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const handler = () => db.table(prices).orderBy('code').get()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await mutate(() => db.table(prices).where('code', '1.00').update({ code: '2.5', rate: '3.5' }))

    expect(subscription.current.data).toEqual(await handler())
  })

  it.runIf(driver === 'mysql')('reads back rows keyed by distinct binary values that are not valid text', async () => {
    const { db } = await openDatabase(driver)
    onTestFinished(() => resetRealtimeRuntime())
    const name = `holo_norm_codes_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await db.executeCompiled({ sql: `CREATE TABLE \`${name}\` (\`code\` VARBINARY(16) PRIMARY KEY, \`group_id\` BIGINT NOT NULL, \`rate\` DECIMAL(10, 2) NOT NULL)`, source: 'schema' })
    onTestFinished(() => db.executeCompiled({ sql: `DROP TABLE IF EXISTS \`${name}\``, source: 'schema' }).then(() => undefined))
    const codes = defineGeneratedTable(name, { code: column.blob().primaryKey(), group_id: column.bigInteger(), rate: column.decimal() })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const handler = () => db.table(codes).orderBy('group_id').get()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await mutate(() => db.table(codes).insert([
      { code: Uint8Array.from([0xff]), group_id: 1, rate: '1.5' },
      { code: Uint8Array.from([0xfe]), group_id: 2, rate: '2.5' },
    ]))

    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).toContain('"rate":"2.50"')
  })

  it('refreshes subscriptions filtering an integer column by text after writes of either representation', async () => {
    const { db, rates } = await openFixture(driver)
    const queries: Record<string, () => Promise<unknown>> = {
      count: () => db.table(rates).where('group_id', '2').count(),
      rows: () => db.table(rates).whereIn('group_id', ['2']).orderBy('id').get(),
      first: () => db.table(rates).where('id', '2').first(),
    }
    const subscriptions = await Promise.all(Object.values(queries).map(handler => subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )))
    const expectFresh = async () => {
      const fresh = await Promise.all(Object.values(queries).map(handler => handler()))
      expect(subscriptions.map(subscription => subscription.current.data)).toEqual(fresh)
    }

    await mutate(() => db.table(rates).insert({ id: 2, group_id: '2', tag_id: 1, rate: '1.00' }))
    await expectFresh()
    await mutate(() => db.table(rates).insert({ id: 3, group_id: 2, tag_id: 1, rate: '1.00' }))
    await expectFresh()
    await mutate(() => db.table(rates).where('id', '1').update({ group_id: '2' }))
    await expectFresh()
    expect(subscriptions[0]!.current.data).toBe(3)
  })

  it.runIf(driver === 'mysql')('keeps an insert by a user that cannot read the written decimal back and re-runs its subscriptions', async () => {
    const { db, rates } = await openFixture(driver)
    const connection = mysqlTestConnection()
    const user = `holo_ins_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const password = randomUUID()
    await db.executeCompiled({ sql: `CREATE USER '${user}'@'%' IDENTIFIED BY '${password}'`, source: 'schema' })
    onTestFinished(() => db.executeCompiled({ sql: `DROP USER IF EXISTS '${user}'@'%'`, source: 'schema' }).then(() => undefined))
    await db.executeCompiled({ sql: `GRANT INSERT, SELECT (\`group_id\`) ON \`${connection.database}\`.\`${rates.tableName}\` TO '${user}'@'%'`, source: 'schema' })
    const insertOnly = createDatabase({ connectionName: 'default', adapter: createMySQLAdapter({ config: { ...connection, user, password } }), dialect: createDialect('mysql') })
    onTestFinished(() => insertOnly.disconnect())
    configureRealtimeRuntime({ db: () => insertOnly, loadAuthModule: async () => null })
    const handler = () => insertOnly.table(rates).where('group_id', 2).count()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await mutate(() => insertOnly.table(rates).insert({ id: 2, group_id: 2, tag_id: 1, rate: '9.5' }))

    expect(subscription.current.data).toBe(await handler())
    expect(subscription.current.data).toBe(1)
  })

  it('keeps integer columns written in other representations equal to a fresh query', async () => {
    const { db, rates, Group } = await openFixture(driver)
    const queries: Record<string, () => Promise<unknown>> = {
      rows: () => db.table(rates).orderBy('id').get(),
      pivots: () => db.model(Group).query().with('tags').orderBy('id').getJson(),
    }
    const subscriptions = await Promise.all(Object.values(queries).map(handler => subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )))
    const expectFresh = async () => {
      const fresh = await Promise.all(Object.values(queries).map(handler => handler()))
      expect(subscriptions.map(subscription => subscription.current.data)).toEqual(fresh)
    }

    await mutate(() => db.table(rates).insert({ id: '05', group_id: '+2', tag_id: '01', rate: '9.5' }))
    await expectFresh()
    await mutate(() => db.table(rates).where('id', 5).update({ group_id: '+1', rate: '3' }))
    await expectFresh()
    expect(JSON.stringify(subscriptions[0]!.current.data)).toContain('"id":5,"group_id":1,"tag_id":1,"rate":"3.00"')
  })

  it('re-runs subscriptions instead of patching an integer value queries cannot read', async () => {
    const { db, rates } = await openFixture(driver)
    const errors: unknown[] = []
    let snapshots = 0
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: () => db.table(rates).orderBy('id').get() }), {}, {
      onData: () => { snapshots += 1 },
      onError: (error) => { errors.push(error) },
    })

    await mutate(() => db.table(rates).insert({ id: 2, group_id: '9007199254740993', tag_id: 1, rate: '1.00' }))

    await expect(db.table(rates).orderBy('id').get()).rejects.toThrow('cannot be represented as a safe integer')
    expect({ snapshots, errors: errors.length }).toEqual({ snapshots: 1, errors: 1 })
  })

  it.runIf(driver === 'postgres')('re-runs subscriptions after an insert by a role that cannot read the written decimal back', async () => {
    const { db, rates } = await openFixture(driver)
    const role = `holo_insert_only_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await db.executeCompiled({ sql: `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS; GRANT INSERT ON "${rates.tableName}" TO ${role}`, source: 'schema' })
    onTestFinished(() => db.executeCompiled({ sql: `REVOKE ALL ON "${rates.tableName}" FROM ${role}; DROP ROLE IF EXISTS ${role}`, source: 'schema' }).then(() => undefined))
    const handler = () => db.table(rates).orderBy('id').get()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await mutate(() => db.transaction(async (transaction) => {
      await transaction.executeCompiled({ sql: `SET LOCAL ROLE ${role}`, source: 'schema' })
      await transaction.table(rates).insert({ id: 2, group_id: 2, tag_id: 1, rate: '9.5' })
    }))

    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).toContain('"9.50"')
  })
})
