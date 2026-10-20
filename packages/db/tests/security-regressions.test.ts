import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { DB, SchemaError, SecurityError, resetDB } from '../src'
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

  it.each(['sqlite', 'postgres', 'mysql'] as const)('stores enum values containing backslashes and quotes as data on %s', async driver => {
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
})
