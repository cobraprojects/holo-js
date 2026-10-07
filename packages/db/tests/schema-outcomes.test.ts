import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { column, createDatabase, createDialect, createSchemaService, defineGeneratedTable } from '../src'

describe('schema mutation outcomes', () => {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  const db = createDatabase({ adapter, dialect: createDialect('sqlite') })
  const schema = createSchemaService(db)

  beforeEach(async () => {
    db.getSchemaRegistry().clear()
    await adapter.initialize()
  })

  afterEach(async () => {
    await adapter.disconnect()
  })

  it('does not publish metadata when table creation fails', async () => {
    await expect(schema.createTable('invalid', (table) => {
      table.id()
      table.id('second_id')
    })).rejects.toThrow()
    expect(await schema.hasTable('invalid')).toBe(false)
    expect(db.getSchemaRegistry().has('invalid')).toBe(false)
  })
  it('restores the original SQLite table when a column rebuild fails', async () => {
    await schema.createTable('users', (table) => {
      table.id()
      table.string('name').nullable()
    })
    await db.executeCompiled({ sql: 'INSERT INTO users (name) VALUES (NULL)', source: 'test:seed' })
    const original = db.getSchemaRegistry().get('users')
    await expect(schema.table('users', (table) => {
      table.string('name').change()
    })).rejects.toThrow()
    expect(await schema.getTables()).toEqual(['users'])
    expect(db.getSchemaRegistry().get('users')).toBe(original)
    expect((await schema.getColumns('users')).find(column => column.name === 'name')?.notNull).toBe(false)
    expect((await db.queryCompiled({ sql: 'SELECT name FROM users', source: 'test:read' })).rows).toEqual([{ name: null }])
  })

  it('retains a declared definition when its creation fails', async () => {
    const declared = schema.register(defineGeneratedTable('invalid', { id: column.id(), second_id: column.id() }))
    await expect(schema.sync()).rejects.toThrow()
    expect(await schema.hasTable('invalid')).toBe(false)
    expect(db.getSchemaRegistry().get('invalid')).toBe(declared)
  })

  it('retains successful preceding alterations when a later alteration fails', async () => {
    await schema.createTable('users', table => { table.id() })
    await expect(schema.table('users', (table) => {
      table.string('name').nullable()
      table.string('name').nullable()
    })).rejects.toThrow()
    expect((await schema.getColumns('users')).map(column => column.name)).toEqual(['id', 'name'])
    expect(Object.keys(db.getSchemaRegistry().get('users')!.columns)).toEqual(['id', 'name'])
  })

  it('keeps metadata aligned after successful and refused rename and drop operations', async () => {
    await schema.createTable('users', table => { table.id() })
    await schema.createTable('occupied', table => { table.id() })
    const original = db.getSchemaRegistry().get('users')
    await expect(schema.renameTable('users', 'occupied')).rejects.toThrow()
    expect(db.getSchemaRegistry().get('users')).toBe(original)
    await schema.renameTable('users', 'renamed')
    expect(await schema.hasTable('renamed')).toBe(true)
    expect(db.getSchemaRegistry().has('users')).toBe(false)
    expect(db.getSchemaRegistry().has('renamed')).toBe(true)
    await schema.dropTable('renamed')
    expect(await schema.hasTable('renamed')).toBe(false)
    expect(db.getSchemaRegistry().has('renamed')).toBe(false)
  })

  it('records only indexes whose DDL succeeded during partial table creation', async () => {
    await expect(schema.createTable('users', (table) => {
      table.id()
      table.index(['id'], 'users_id_index')
      table.index(['missing'], 'users_missing_index')
    })).rejects.toThrow()
    expect(await schema.hasTable('users')).toBe(true)
    expect((await schema.getIndexes('users')).map(index => index.name)).toEqual(['users_id_index'])
    expect(db.getSchemaRegistry().get('users')?.indexes.map(index => index.name)).toEqual(['users_id_index'])
  })

})
