import { afterEach, describe, expect, it } from 'vitest'
import { MySQLSchemaCompiler } from '../src/schema/MySQLSchemaCompiler'
import { PostgresSchemaCompiler } from '../src/schema/PostgresSchemaCompiler'
import { DB, SchemaError, SecurityError, column, configureDB, createConnectionManager, createDatabase, createDialect, createSchemaService, belongsToMany, defineGeneratedTable, defineModel, onDatabaseDependencyInvalidated, resetDB, type DriverAdapter } from '../src'

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
  const secondary = createDatabase({ connectionName: 'secondary', adapter, dialect: createDialect(driver) })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db, secondary } }))
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
    const wildcardError = new SecurityError('Column reference "a.b.c.*" must select every column of a table name or a schema-qualified table name.')
    await expect(DB.table('users').select('a.b.c.*').get()).rejects.toThrow(wildcardError)
    await expect(DB.table('users').select('a.b.c.*').count()).rejects.toThrow(wildcardError)
    await expect(DB.table('users').select('a.b.c.*').exists()).rejects.toThrow(wildcardError)
    await expect(DB.table('users').select('a.b.c.*').paginate(10, 1)).rejects.toThrow(wildcardError)
    await expect(DB.table('users').select('a.b.c.*').sum('id')).rejects.toThrow(wildcardError)
    await expect(DB.table('users').select('a.b.c.*').max('id')).rejects.toThrow(wildcardError)
    await expect(DB.table('users').select('a.b.c.*').first()).rejects.toThrow(wildcardError)
  })

  it('rejects them before inserts look up RETURNING permissions', async () => {
    const { db } = openUnreachableDatabase(driver)
    const adapter = db.getAdapter() as DriverAdapter & { getMutationReturningPermissionQuery?: (tableName: string) => { sql: string, source: string } }
    adapter.getMutationReturningPermissionQuery = tableName => ({ sql: `SELECT ${tableName}`, source: 'test' })
    const stop = onDatabaseDependencyInvalidated(() => {})
    try {
      const error = new SecurityError('Table "a.b.c" must be a table name or a schema-qualified table name.')
      await expect(DB.table('a.b.c').insert({ id: 1 })).rejects.toThrow(error)
      await expect(DB.table('a.b.c').insertOrIgnore({ id: 1 })).rejects.toThrow(error)
    } finally {
      stop()
    }
  })

  it('rejects them before an untyped model loads its guarded columns', async () => {
    openUnreachableDatabase(driver)
    const Thing = defineModel('a.b.c', { connectionName: 'secondary', guarded: ['id'], timestamps: false })

    await expect(Thing.create({ name: 'x' })).rejects.toThrow(new SecurityError('Table "a.b.c" must be a table name or a schema-qualified table name.'))
  })

  it('rejects them before updates open a transaction to capture previous rows', async () => {
    openUnreachableDatabase(driver)
    const stop = onDatabaseDependencyInvalidated(() => {})
    try {
      const error = new SecurityError('Table "a.b.c" must be a table name or a schema-qualified table name.')
      await expect(DB.table('a.b.c').where('id', 1).update({ name: 'x' })).rejects.toThrow(error)
      await expect(DB.table('a.b.c').where('id', 1).delete()).rejects.toThrow(error)
    } finally {
      stop()
    }
  })

  it('rejects them before model writes open a transaction', async () => {
    openUnreachableDatabase(driver)
    const error = new SecurityError('Table "a.b.c" must be a table name or a schema-qualified table name.')
    const Fillable = defineModel('a.b.c', { connectionName: 'secondary', fillable: ['name'], timestamps: false })
    const Unguarded = defineModel('a.b.c', { connectionName: 'secondary', guarded: [], timestamps: false })

    await expect(Fillable.create({ name: 'x' })).rejects.toThrow(error)
    await expect(Unguarded.create({ name: 'x' })).rejects.toThrow(error)
    await expect(Fillable.createOrFirst({ name: 'x' })).rejects.toThrow(error)
    await expect((await Fillable.hydrate({ id: 1, name: 'x' })).delete()).rejects.toThrow(error)
  })

  it('rejects them before pivot mutations open a transaction', async () => {
    openUnreachableDatabase(driver)
    const error = new SecurityError('Table "a.b.c" must be a table name or a schema-qualified table name.')
    const Role = defineModel('roles', { connectionName: 'secondary', timestamps: false })
    const User = defineModel('users', { connectionName: 'secondary', timestamps: false, relations: { roles: belongsToMany(() => Role, 'a.b.c', 'user_id', 'role_id') } })
    const user = await User.hydrate({ id: 1 })

    await expect(user.attach('roles', [1])).rejects.toThrow(error)
    await expect(user.sync('roles', [1])).rejects.toThrow(error)
    await expect(user.toggle('roles', [1])).rejects.toThrow(error)
    await expect(user.detach('roles', [1])).rejects.toThrow(error)
    await expect(user.updateExistingPivot('roles', 1, { note: 'x' })).rejects.toThrow(error)
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

describe('schema compilers reject table paths with more than two segments', () => {
  const quote = (identifier: string) => `"${identifier}"`

  it('rejects them in referenced tables and in MySQL table overrides', () => {
    const error = new SchemaError('Identifier path "a.b.c" must be a table name or a schema-qualified table name.')

    expect(() => new PostgresSchemaCompiler(quote).compileCreateForeignKey('users', 'team_id', { table: 'a.b.c', column: 'id' })).toThrow(error)
    expect(() => new MySQLSchemaCompiler(quote).compileCreateForeignKey('users', 'team_id', { table: 'a.b.c', column: 'id' })).toThrow(error)
    expect(() => new MySQLSchemaCompiler(quote).compileRenameTable('a.b.c', 'users')).toThrow(error)
    expect(() => new MySQLSchemaCompiler(quote).compileRenameIndex('a.b.c', 'old_idx', 'new_idx')).toThrow(error)
    expect(() => new MySQLSchemaCompiler(quote).compileDropIndex('a.b.c', 'old_idx')).toThrow(error)
    expect(() => new MySQLSchemaCompiler(quote).compileDropForeignKey('a.b.c', 'users_team_id_foreign')).toThrow(error)
    expect(() => new MySQLSchemaCompiler(quote).compileDropPrimaryKey('a.b.c')).toThrow(error)
  })
})
