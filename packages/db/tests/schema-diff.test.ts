import { describe, expect, it, onTestFinished } from 'vitest'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { column, createDatabase, createDialect, createSchemaDiff, createSchemaService, SchemaError } from '../src'
import { defineTable } from './support/internal'
import { createTestTable } from './support/schema'
import { openDatabase } from './support/database'

function openSQLiteSchema() {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  const db = createDatabase({ adapter, dialect: createDialect('sqlite') })
  return { adapter, db, schema: createSchemaService(db) }
}

describe('native schema diff', () => {
  it.each(['sqlite', 'postgres', 'mysql'] as const)('reports matching columns and indexes on %s', async driver => {
    const { schema, table } = await openDatabase(driver)
    const expected = defineTable(table.tableName.split('.').at(-1)!, table.columns)
    const diff = await createSchemaDiff(schema, [expected])
    expect(diff.missingTables).toEqual([])
    expect(diff.tables).toHaveLength(1)
    expect(diff.tables[0]).toMatchObject({
      missingColumns: [], extraColumns: [], mismatchedColumns: [],
      missingIndexes: [], extraIndexes: [], mismatchedIndexes: [],
      missingForeignKeys: [], extraForeignKeys: [], mismatchedForeignKeys: [], hasChanges: false,
    })
  })

  it('compares actual foreign keys, unique indexes, and default reference actions', async () => {
    const { db, schema } = openSQLiteSchema()
    const teams = defineTable('teams', { id: column.id() })
    const users = defineTable('users', {
      id: column.id(), email: column.string().unique(),
      team_id: column.foreignId().constrained('teams').cascadeOnDelete().restrictOnUpdate(),
    }, { indexes: [{ columns: ['email'], unique: true }] })
    const audits = defineTable('audits', {
      id: column.id(), team_id: column.foreignId().constrained('teams'), message: column.string(),
    }, { indexes: [{ columns: ['message'], unique: false }] })
    for (const table of [teams, users, audits]) await createTestTable(db, table)
    const diff = await createSchemaDiff(schema, [teams, users, audits])
    expect(diff.hasChanges).toBe(false)
    expect(diff.extraTables).toEqual([])
    expect(diff.missingTables).toEqual([])
    expect(diff.tables.every(table => !table.hasChanges)).toBe(true)
  })

  it('reports missing and extra tables and mismatched columns and reference actions', async () => {
    const { adapter, schema } = openSQLiteSchema()
    await adapter.execute('CREATE TABLE teams (id INTEGER PRIMARY KEY NOT NULL)')
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY NOT NULL, email INTEGER, legacy_flag TEXT, team_id INTEGER, FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL ON UPDATE NO ACTION)')
    await adapter.execute('CREATE INDEX legacy_email_idx ON users(email)')
    await adapter.execute('CREATE TABLE legacy (id INTEGER PRIMARY KEY NOT NULL)')
    const teams = defineTable('teams', { id: column.id() })
    const users = defineTable('users', {
      id: column.id(), email: column.string().unique(), active: column.boolean(),
      team_id: column.foreignId().constrained('teams').cascadeOnDelete().restrictOnUpdate(),
    }, { indexes: [{ columns: ['email'], unique: true }] })
    const posts = defineTable('posts', { id: column.id() })
    const diff = await createSchemaDiff(schema, [teams, users, posts])
    expect(diff.missingTables).toEqual(['posts'])
    expect(diff.extraTables).toEqual(['legacy'])
    expect(diff.hasChanges).toBe(true)
    const changed = diff.tables.find(table => table.table === 'users')!
    expect(changed.missingColumns).toEqual(['active'])
    expect(changed.extraColumns).toEqual(['legacy_flag'])
    expect(changed.mismatchedColumns).toEqual([
      { column: 'email', expected: { type: 'TEXT', notNull: true, primaryKey: false }, actual: { type: 'INTEGER', notNull: false, primaryKey: false } },
      { column: 'team_id', expected: { type: 'INTEGER', notNull: true, primaryKey: false }, actual: { type: 'INTEGER', notNull: false, primaryKey: false } },
    ])
    expect(changed.missingIndexes).toEqual(['users_email_unique'])
    expect(changed.extraIndexes).toEqual(['legacy_email_idx'])
    expect(changed.mismatchedForeignKeys).toEqual([{
      foreignKey: 'team_id->teams.id',
      expected: { table: 'teams', from: 'team_id', to: 'id', onUpdate: 'RESTRICT', onDelete: 'CASCADE' },
      actual: { table: 'teams', from: 'team_id', to: 'id', onUpdate: 'NO ACTION', onDelete: 'SET NULL' },
    }])
  })

  it('reports index column and uniqueness changes and extra foreign keys', async () => {
    const { adapter, schema } = openSQLiteSchema()
    await adapter.execute('CREATE TABLE teams (id INTEGER PRIMARY KEY NOT NULL)')
    await adapter.execute('CREATE TABLE metrics (price NUMERIC NOT NULL, ratio REAL NOT NULL, payload BLOB NOT NULL, team_id INTEGER, FOREIGN KEY (team_id) REFERENCES teams(id))')
    await adapter.execute('CREATE INDEX metrics_price_idx ON metrics(ratio)')
    const metrics = defineTable('metrics', {
      price: column.decimal(), ratio: column.real(), payload: column.blob(), team_id: column.integer().nullable(),
    }, { indexes: [{ name: 'metrics_price_idx', columns: ['price'], unique: true }] })
    const diff = await createSchemaDiff(schema, [metrics])
    expect(diff.tables[0]!.mismatchedColumns).toEqual([])
    expect(diff.tables[0]!.mismatchedIndexes).toEqual([{
      index: 'metrics_price_idx', expected: { unique: true, columns: ['price'] }, actual: { unique: false, columns: ['ratio'] },
    }])
    expect(diff.tables[0]!.extraForeignKeys).toEqual(['team_id->teams.id'])
  })

  it.each(['sqlite', 'mysql'] as const)('rejects unsupported vector columns on %s', async driver => {
    const { db, table, schema } = await openDatabase(driver)
    await schema.table(table.tableName, table => { table.blob('embedding').nullable() })
    const vectors = defineTable(table.tableName.split('.').at(-1)!, { ...table.columns, embedding: column.vector({ dimensions: 3 }).nullable() })
    await expect(createSchemaDiff(schema, [vectors])).rejects.toThrow(SchemaError)
    expect(await db.table(table).count()).toBe(0)
  })
})
