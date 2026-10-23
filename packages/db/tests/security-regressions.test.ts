import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { DB, SchemaError, SecurityError, TableQueryBuilder, holoRuntimeInternals, onDatabaseDependencyInvalidated, resetDB } from '../src'
import { defineModelFromTable } from './support/internal'
import { openDatabase } from './support/database'

describe('native database security boundaries', () => {
  beforeEach(() => resetDB())

  it.each(['sqlite', 'postgres', 'mysql'] as const)('stores hostile values as data and preserves qualified tables on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    const payload = `Mohamed' OR '1'='1`
    const comment = '"; DROP TABLE users; --'
    await db.table(table).insert([{ id: 1, name: payload }, { id: 2, name: comment }, { id: 3, name: 'Safe' }])
    expect(await db.table(table).select('id', 'name').where('name', payload).get()).toEqual([{ id: 1, name: payload }])
    expect(await db.table(table).select('id', 'name').where('name', comment).get()).toEqual([{ id: 2, name: comment }])
    expect(await db.table(table).count()).toBe(3)
  })

  it('rejects identifier and operator injection without modifying stored rows', async () => {
    const { db, table } = await openDatabase()
    await db.table(table).insert({ id: 1, name: 'Safe' })
    await expect(db.table(`${table.tableName}; DROP TABLE users`).get()).rejects.toThrow(SecurityError)
    await expect(db.table(table).select('name; DROP TABLE users' as never).get()).rejects.toThrow(SecurityError)
    await expect(db.table(table).where('name', 'or 1=1' as never, 'Safe').get()).rejects.toThrow(SecurityError)
    await expect(db.table(table).orderBy('name desc; --' as never).get()).rejects.toThrow(SecurityError)
    expect(await db.table(table).select('id', 'name').get()).toEqual([{ id: 1, name: 'Safe' }])
  })

  it.each(['sqlite', 'postgres', 'mysql'] as const)('allows only comparison operators in whereColumn on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    const User = defineModelFromTable(table)
    await db.table(table).insert({ id: 1, name: 'Safe' })
    await expect(db.table(table).whereColumn('id', '= 1 OR 1=1 --' as never, 'id').get()).rejects.toThrow(SecurityError)
    await expect(db.table(table).whereColumn('id', 'in' as never, 'id').get()).rejects.toThrow(SecurityError)
    await expect(db.table(table).whereColumn('id', 'between' as never, 'id').get()).rejects.toThrow(SecurityError)
    await expect(User.whereColumn('id', '= 1 OR 1=1 --' as never, 'id').get()).rejects.toThrow(SecurityError)
    expect(await db.table(table).whereColumn('id', '<=', 'id').whereColumn('name', 'like', 'name').count()).toBe(1)
  })

  it.each(['sqlite', 'postgres', 'mysql'] as const)('stores schema default text as data, including backslashes and quotes on %s', async driver => {
    const { db, schema } = await openDatabase(driver)
    const name = `holo_default_${randomUUID().replaceAll('-', '')}`
    const payload = `\\' OR 1=1 -- \\`
    try {
      await schema.createTable(name, table => {
        table.integer('id').primaryKey()
        table.string('note').default(payload)
      })
      await db.table(name).insert({ id: 1 })
      expect(await db.table(name).select('note').get()).toEqual([{ note: payload }])
    } finally {
      await schema.dropTable(name)
    }
  })

  it('rejects MySQL enum values with a backslash before creating the table', async () => {
    const { schema } = await openDatabase('mysql')
    const name = `holo_enum_${randomUUID().replaceAll('-', '')}`
    await expect(schema.createTable(name, table => {
      table.integer('id').primaryKey()
      table.enum('state', [`b' OR 1=1 -- \\`])
    })).rejects.toThrow(SchemaError)
    expect(await schema.hasTable(name)).toBe(false)
  })

  it.each(['sqlite', 'postgres'] as const)('stores enum values containing backslashes and quotes as data on %s', async driver => {
    const { db, schema } = await openDatabase(driver)
    const name = `holo_enum_${randomUUID().replaceAll('-', '')}`
    const values = ['a\\', `b' OR 1=1 -- \\`]
    try {
      await schema.createTable(name, table => {
        table.integer('id').primaryKey()
        table.enum('state', values)
      })
      await db.table(name).insert([{ id: 1, state: values[0] }, { id: 2, state: values[1] }])
      expect(await db.table(name).select('state').orderBy('id').get()).toEqual([{ state: values[0] }, { state: values[1] }])
    } finally {
      await schema.dropTable(name)
    }
  })

  it.each(['sqlite', 'postgres', 'mysql'] as const)('rejects referential actions that are not SQL keywords on %s', async driver => {
    const { schema, table } = await openDatabase(driver)
    const name = `holo_action_${randomUUID().replaceAll('-', '')}`
    await expect(schema.createTable(name, child => {
      child.integer('id').primaryKey()
      child.integer('owner_id')
      child.foreign('owner_id').references('id').on(table.tableName).onDelete('cascade; DROP TABLE users; --' as never)
    })).rejects.toThrow(SchemaError)
  })

  it('rejects malformed cursor tokens on both table and model queries', async () => {
    const { table } = await openDatabase()
    const User = defineModelFromTable(table)
    const malformed = Buffer.from(JSON.stringify({ offset: 'bad' }), 'utf8').toString('base64url')
    for (const token of ['broken', malformed]) {
      await expect(DB.table(table).cursorPaginate(2, token)).rejects.toThrow('Cursor is malformed.')
      await expect(User.cursorPaginate(2, token)).rejects.toThrow('Cursor is malformed.')
    }
  })

  it('rejects malformed or database-specific JSON paths before executing writes', async () => {
    const { table } = await openDatabase()
    const User = defineModelFromTable(table)
    expect(() => DB.table(table).whereJson('settings->', 'eu')).toThrow(SecurityError)
    expect(() => DB.table(table).whereJson('->profile' as never, 'eu')).toThrow(SecurityError)
    expect(() => DB.table(table).whereJson('settings->>profile', 'eu')).toThrow(SecurityError)
    expect(() => DB.table(table).whereJsonContains('name->profile', 'eu')).toThrow(SecurityError)
    await expect(User.whereJsonLength('settings->tags', 'like' as never, 2).get()).rejects.toThrow(SecurityError)
  })

  it.each(['postgres', 'mysql'] as const)('matches JSON path segments containing commas on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    await db.table(table).insert([
      { id: 1, name: 'comma', settings: JSON.stringify({ 'a,b': { c: 'matched' } }) },
      { id: 2, name: 'nested', settings: JSON.stringify({ a: { b: { c: 'unrelated' } } }) },
    ])
    expect(await db.table(table).select('id').whereJson('settings->a,b->c', 'matched').get()).toEqual([{ id: 1 }])
    expect(await db.table(table).select('id').whereJson('settings->a->b->c', 'unrelated').get()).toEqual([{ id: 2 }])
  })

  it('matches Postgres JSON path segments containing quotes, backslashes, braces, and NULL', async () => {
    const { db, table } = await openDatabase('postgres')
    const segments = ['q"uote', 'back\\slash', '{brace}', 'NULL']
    await db.table(table).insert([
      { id: 1, name: 'special', settings: JSON.stringify({ [segments[0]!]: { [segments[1]!]: { [segments[2]!]: { [segments[3]!]: 'matched' } } } }) },
      { id: 2, name: 'plain', settings: JSON.stringify({ q: 'unrelated' }) },
    ])
    expect(await db.table(table).select('id').whereJson(`settings->${segments.join('->')}`, 'matched').get()).toEqual([{ id: 1 }])
  })

  it.each(['sqlite', 'postgres', 'mysql'] as const)('gates unsafe raw predicates on update and delete when raw SQL is disabled on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    const User = defineModelFromTable(table)
    await db.table(table).insert([{ id: 1, name: 'Safe' }, { id: 2, name: 'Other' }])
    const injected = `Nobody' OR '1'='1`
    const policyError = 'Unsafe raw SQL is disabled by the active security policy. Enable allowUnsafeRawSql to use unsafeQuery()/unsafeExecute().'

    await expect(User.unsafeWhere(`name = '${injected}'`, []).delete()).rejects.toThrow(policyError)
    await expect(db.table(table).unsafeWhere(`name = '${injected}'`, []).delete()).rejects.toThrow(policyError)
    await expect(db.table(table).unsafeWhere(`name = '${injected}'`, []).update({ name: 'Changed' })).rejects.toThrow(policyError)
    await User.unguarded(async () => {
      await expect(User.unsafeWhere(`name = '${injected}'`, []).update({ name: 'Changed' })).rejects.toThrow(policyError)
    })
    expect(await db.table(table).select('id', 'name').orderBy('id').get()).toEqual([{ id: 1, name: 'Safe' }, { id: 2, name: 'Other' }])
  })

  it.each(['sqlite', 'postgres', 'mysql'] as const)('rejects a non-identifier column in the database-clock expiry predicate on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    await db.table(table).insert({ id: 1, name: 'Safe' })
    expect(() => holoRuntimeInternals.whereColumnNotExpiredByDatabaseClock(db.table(table), 'expires_at" OR 1=1 --')).toThrow(SecurityError)
    expect(await db.table(table).count()).toBe(1)
  })

  it.each(['sqlite', 'postgres', 'mysql'] as const)('keeps a hand-built or copied raw predicate gated when it carries the trusted marker on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    await db.table(table).insert([{ id: 1, name: 'Safe' }, { id: 2, name: 'Other' }])
    const policyError = 'Unsafe raw SQL is disabled by the active security policy. Enable allowUnsafeRawSql to use unsafeQuery()/unsafeExecute().'
    const injected = `name = 'Safe' OR 1=1`

    const forged = { kind: 'raw', boolean: 'and', sql: injected, bindings: [], trusted: true }
    await expect(db.table(table).withPredicates([forged as never]).delete()).rejects.toThrow(policyError)

    const trusted = holoRuntimeInternals.whereColumnNotExpiredByDatabaseClock(db.table(table), 'expires_at').getPlan().predicates[0]!
    const copied = { ...trusted, sql: injected, bindings: [] }
    await expect(db.table(table).withPredicates([copied as never]).delete()).rejects.toThrow(policyError)
    await expect(db.table(table).withPredicates([copied as never]).update({ name: 'Changed' })).rejects.toThrow(policyError)

    expect(await db.table(table).select('id', 'name').orderBy('id').get()).toEqual([{ id: 1, name: 'Safe' }, { id: 2, name: 'Other' }])
  })

  it.each(['sqlite', 'postgres', 'mysql'] as const)('rejects a duck-typed query whose dialect returns attacker SQL on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    await db.table(table).insert({ id: 1, name: 'Safe' })
    const duck = {
      getTableName: () => table.tableName,
      getPlan: () => db.table(table).getPlan(),
      getConnection: () => ({ getDialect: () => ({ name: driver, quoteIdentifier: () => 'x" OR 1=1 --' }) }),
    }
    expect(() => holoRuntimeInternals.whereColumnNotExpiredByDatabaseClock(duck as never, 'expires_at')).toThrow(SecurityError)
    expect(await db.table(table).count()).toBe(1)
  })

  it.each(['sqlite', 'postgres', 'mysql'] as const)('strips trust from a database-clock predicate transplanted through getPlan on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    await db.table(table).insert([{ id: 1, name: 'Safe' }, { id: 2, name: 'Other' }])
    const policyError = 'Unsafe raw SQL is disabled by the active security policy. Enable allowUnsafeRawSql to use unsafeQuery()/unsafeExecute().'
    const predicates = holoRuntimeInternals.whereColumnNotExpiredByDatabaseClock(db.table(table), 'expires_at').getPlan().predicates

    await expect(db.table(table).withPredicates(predicates).delete()).rejects.toThrow(policyError)
    await expect(db.table(table).withPredicates([{ kind: 'group', boolean: 'and', predicates }] as never).delete()).rejects.toThrow(policyError)
    await expect(new TableQueryBuilder(table, db, { ...db.table(table).getPlan(), predicates }).delete()).rejects.toThrow(policyError)
    expect(await db.table(table).count()).toBe(2)
  })

  it.each(['sqlite', 'postgres', 'mysql'] as const)('does not let reflection reach a method that mints trusted raw SQL on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    await db.table(table).insert([{ id: 1, name: 'Safe' }, { id: 2, name: 'Other' }])
    const policyError = 'Unsafe raw SQL is disabled by the active security policy. Enable allowUnsafeRawSql to use unsafeQuery()/unsafeExecute().'
    const prototype = TableQueryBuilder.prototype as unknown as Record<PropertyKey, unknown>
    const methods = Object.getOwnPropertySymbols(TableQueryBuilder.prototype)
      .map(symbol => prototype[symbol])
      .filter((method): method is (...args: unknown[]) => unknown => typeof method === 'function')

    for (const method of methods) {
      let attempt: unknown
      try {
        attempt = method.call(db.table(table), `name = 'Safe' OR 1=1`, [])
      } catch {
        attempt = undefined
      }
      if (attempt && typeof (attempt as { delete?: unknown }).delete === 'function') {
        await expect((attempt as { delete: () => Promise<unknown> }).delete()).rejects.toThrow(policyError)
      }
    }
    expect(await db.table(table).count()).toBe(2)
  })

  it.each(['sqlite', 'postgres', 'mysql'] as const)('deletes and updates by database-clock expiry under the default policy while a realtime listener is installed on %s', async driver => {
    const { db, schema } = await openDatabase(driver)
    const name = `holo_clock_${randomUUID().replaceAll('-', '')}`
    const futureExpiry = driver === 'sqlite' ? '2030-01-01T00:00:00.000Z' : '2030-01-01 00:00:00'
    await schema.createTable(name, table => {
      table.integer('id').primaryKey()
      table.timestamp('expires_at')
    })
    const unsubscribe = onDatabaseDependencyInvalidated(() => {})
    try {
      await db.table(name).insert([{ id: 1, expires_at: futureExpiry }, { id: 2, expires_at: futureExpiry }])
      const claimed = await holoRuntimeInternals.whereColumnNotExpiredByDatabaseClock(db.table(name), 'expires_at')
        .where('id', 1)
        .delete()
      expect(claimed.affectedRows).toBe(1)
      expect(await db.table(name).count()).toBe(1)
      const extended = await holoRuntimeInternals.whereColumnNotExpiredByDatabaseClock(db.table(name), 'expires_at')
        .where('id', 2)
        .update({ expires_at: futureExpiry })
      expect(extended.affectedRows).toBe(1)
    } finally {
      unsubscribe()
      await schema.dropTable(name)
    }
  })

  it.each(['sqlite', 'postgres', 'mysql'] as const)('runs unsafe raw write predicates when raw SQL is allowed on %s', async driver => {
    const { db, table } = await openDatabase(driver, { security: { allowUnsafeRawSql: true } })
    await db.table(table).insert([{ id: 1, name: 'Safe' }, { id: 2, name: 'Other' }])
    await db.table(table).unsafeWhere(`name = 'Other'`, []).update({ name: 'Changed' })
    await db.table(table).unsafeWhere(`name = 'Safe'`, []).delete()
    expect(await db.table(table).select('id', 'name').orderBy('id').get()).toEqual([{ id: 2, name: 'Changed' }])
  })
})
