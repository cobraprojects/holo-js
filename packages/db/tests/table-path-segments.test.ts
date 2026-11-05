import { afterEach, describe, expect, it } from 'vitest'
import { DB, SchemaError, SecurityError, column, configureDB, createConnectionManager, createDatabase, createDialect, createSchemaService, defineGeneratedTable, resetDB, type DriverAdapter } from '../src'

const unreachable = async (): Promise<never> => {
  throw new Error('The statement reached the database.')
}

function openUnreachableDatabase(driver: 'sqlite' | 'postgres' | 'mysql') {
  const adapter: DriverAdapter = {
    initialize: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    query: unreachable,
    execute: unreachable,
    beginTransaction: unreachable,
    commit: unreachable,
    rollback: unreachable,
  }
  const db = createDatabase({ connectionName: 'default', adapter, dialect: createDialect(driver) })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
  return { db, schema: createSchemaService(db) }
}

describe.each(['sqlite', 'postgres', 'mysql'] as const)('table paths with more than two segments on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('rejects them in queries before they reach the database', async () => {
    openUnreachableDatabase(driver)
    const error = new SecurityError('Table "a.b.c" must be a table name or a schema-qualified table name.')

    await expect(DB.table('a.b.c').get()).rejects.toThrow(error)
    await expect(DB.table('a.b.c').insert({ id: 1 })).rejects.toThrow(error)
    await expect(DB.table('a.b.c').where('id', 1).update({ id: 2 })).rejects.toThrow(error)
    await expect(DB.table('a.b.c').where('id', 1).delete()).rejects.toThrow(error)
    await expect(DB.table('a.b.c').truncate()).rejects.toThrow(error)
    await expect(DB.table('a.b.c as t').get()).rejects.toThrow(error)
    await expect(DB.table('users').join('a.b.c', 'a.b.c.id', '=', 'users.id').get())
      .rejects.toThrow(new SecurityError('Join table "a.b.c" must be a table name or a schema-qualified table name.'))
    await expect(DB.table('users').select('a.b.c.*').get())
      .rejects.toThrow(new SecurityError('Column reference "a.b.c.*" must select every column of a table name or a schema-qualified table name.'))
  })

  it('keeps accepting schema-qualified column references', async () => {
    openUnreachableDatabase(driver)

    await expect(DB.table('app.users').select('app.users.id').where('app.users.id', 1).get()).rejects.toThrow('The statement reached the database.')
  })

  it('rejects them in schema operations and table definitions', async () => {
    const { schema } = openUnreachableDatabase(driver)
    const error = new SchemaError('Table name "a.b.c" must be a table name or a schema-qualified table name.')

    await expect(schema.createTable('a.b.c', (table) => {
      table.id()
    })).rejects.toThrow(error)
    await expect(schema.table('a.b.c', (table) => {
      table.string('name')
    })).rejects.toThrow(error)
    await expect(schema.dropTable('a.b.c')).rejects.toThrow(error)
    await expect(schema.renameTable('users', 'a.b.c')).rejects.toThrow(error)
    await expect(schema.createTable('users', (table) => {
      table.id()
      table.foreignId('team_id').constrained('a.b.c')
    })).rejects.toThrow(new SchemaError('Foreign key table "a.b.c" must be a table name or a schema-qualified table name.'))
    expect(() => defineGeneratedTable('a.b.c', { id: column.id() })).toThrow(error)
  })
})
