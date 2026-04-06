import { describe, expect, it } from 'vitest'
import {
  CapabilityError,
  SchemaError,
  column,
  createDatabase,
  createSchemaDiff,
  createSchemaService,
  type Dialect,
  type DriverAdapter,
  type DriverExecutionResult,
  type DriverQueryResult } from '../src'
import { defineTable } from './support/internal'

type QueryState = {
  tables: string[]
  columns: Record<string, Array<{
    name: string
    type: string
    notnull: number
    dflt_value: string | null
    pk: number
  }>>
  indexes: Record<string, Array<{ name: string, unique: number }>>
  indexColumns: Record<string, Array<{ name: string }>>
  foreignKeys: Record<string, Array<{
    table: string
    from: string
    to: string
    on_update: string
    on_delete: string
  }>>
  postgresTables?: Array<{ name: string }>
  postgresColumns?: Record<string, Array<{
    name: string
    type: string
    is_nullable: 'YES' | 'NO'
    default_value: string | null
    primary_key: boolean
  }>>
  postgresIndexes?: Record<string, Array<{
    name: string
    definition: string
  }>>
  postgresForeignKeys?: Record<string, Array<{
    table_name: string
    from_column: string
    to_column: string
    on_update: string
    on_delete: string
  }>>
  mysqlTables?: Array<{ name: string }>
  mysqlColumns?: Record<string, Array<{
    name: string
    type: string
    is_nullable: 'YES' | 'NO'
    default_value: string | null
    column_key: string
  }>>
  mysqlIndexes?: Record<string, Array<{
    name: string
    non_unique: number
    column_name: string
  }>>
  mysqlForeignKeys?: Record<string, Array<{
    table_name: string
    from_column: string
    to_column: string
    on_update: string
    on_delete: string
  }>>
}

class DiffAdapter implements DriverAdapter {
  connected = false

  constructor(private readonly state: QueryState) {}

  async initialize(): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverQueryResult<TRow>> {
    if (sql.includes('sqlite_master')) {
      return {
        rows: this.state.tables.map(name => ({ name })) as unknown as TRow[],
        rowCount: this.state.tables.length }
    }

    if (sql === 'SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = \'public\' ORDER BY tablename') {
      const rows = this.state.postgresTables ?? []
      return { rows: rows as unknown as TRow[], rowCount: rows.length }
    }

    if (sql === 'SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = $1 ORDER BY tablename') {
      const rows = this.state.postgresTables ?? []
      return { rows: rows as unknown as TRow[], rowCount: rows.length }
    }

    if (sql === 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name') {
      const rows = this.state.mysqlTables ?? []
      return { rows: rows as unknown as TRow[], rowCount: rows.length }
    }

    const tableInfo = sql.match(/^PRAGMA table_info\("([^"]+)"\)$/)
    if (tableInfo) {
      const rows = this.state.columns[tableInfo[1]!] ?? []
      return { rows: rows as unknown as TRow[], rowCount: rows.length }
    }

    const indexList = sql.match(/^PRAGMA index_list\("([^"]+)"\)$/)
    if (indexList) {
      const rows = this.state.indexes[indexList[1]!] ?? []
      return { rows: rows as unknown as TRow[], rowCount: rows.length }
    }

    const indexInfo = sql.match(/^PRAGMA index_info\("([^"]+)"\)$/)
    if (indexInfo) {
      const rows = this.state.indexColumns[indexInfo[1]!] ?? []
      return { rows: rows as unknown as TRow[], rowCount: rows.length }
    }

    const foreignKeyList = sql.match(/^PRAGMA foreign_key_list\("([^"]+)"\)$/)
    if (foreignKeyList) {
      const rows = this.state.foreignKeys[foreignKeyList[1]!] ?? []
      return { rows: rows as unknown as TRow[], rowCount: rows.length }
    }

    if (sql === 'SELECT c.column_name AS name, c.data_type AS type, c.is_nullable AS is_nullable, c.column_default AS default_value, EXISTS (SELECT 1 FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.table_schema = \'public\' AND tc.table_name = c.table_name AND tc.constraint_type = \'PRIMARY KEY\' AND kcu.column_name = c.column_name) AS primary_key FROM information_schema.columns c WHERE c.table_schema = \'public\' AND c.table_name = $1 ORDER BY c.ordinal_position') {
      const rows = this.state.postgresColumns?.[String(bindings[0] ?? '')] ?? []
      return { rows: rows as unknown as TRow[], rowCount: rows.length }
    }

    if (sql === 'SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = \'public\' AND tablename = $1 ORDER BY indexname') {
      const rows = this.state.postgresIndexes?.[String(bindings[0] ?? '')] ?? []
      return { rows: rows as unknown as TRow[], rowCount: rows.length }
    }

    if (sql === 'SELECT ccu.table_name AS table_name, kcu.column_name AS from_column, ccu.column_name AS to_column, rc.update_rule AS on_update, rc.delete_rule AS on_delete FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema WHERE tc.constraint_type = \'FOREIGN KEY\' AND tc.table_schema = \'public\' AND tc.table_name = $1 ORDER BY kcu.ordinal_position') {
      const rows = this.state.postgresForeignKeys?.[String(bindings[0] ?? '')] ?? []
      return { rows: rows as unknown as TRow[], rowCount: rows.length }
    }

    if (sql === 'SELECT column_name AS name, data_type AS type, is_nullable AS is_nullable, column_default AS default_value, column_key AS column_key FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position') {
      const rows = this.state.mysqlColumns?.[String(bindings[0] ?? '')] ?? []
      return { rows: rows as unknown as TRow[], rowCount: rows.length }
    }

    if (sql === 'SELECT index_name AS name, non_unique AS non_unique, column_name AS column_name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? ORDER BY index_name, seq_in_index') {
      const rows = this.state.mysqlIndexes?.[String(bindings[0] ?? '')] ?? []
      return { rows: rows as unknown as TRow[], rowCount: rows.length }
    }

    if (sql === 'SELECT referenced_table_name AS table_name, column_name AS from_column, referenced_column_name AS to_column, update_rule AS on_update, delete_rule AS on_delete FROM information_schema.key_column_usage kcu JOIN information_schema.referential_constraints rc ON rc.constraint_name = kcu.constraint_name AND rc.constraint_schema = kcu.table_schema WHERE kcu.table_schema = DATABASE() AND kcu.table_name = ? AND kcu.referenced_table_name IS NOT NULL ORDER BY kcu.ordinal_position') {
      const rows = this.state.mysqlForeignKeys?.[String(bindings[0] ?? '')] ?? []
      return { rows: rows as unknown as TRow[], rowCount: rows.length }
    }

    return { rows: [] as unknown as TRow[], rowCount: 0 }
  }

  async execute(): Promise<DriverExecutionResult> {
    return { affectedRows: 0 }
  }

  async beginTransaction(): Promise<void> {}
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
}

function createSqliteDialect(): Dialect {
  return {
    name: 'sqlite',
    capabilities: {
      returning: false,
      savepoints: false,
      concurrentQueries: false,
      workerThreadExecution: false,
      lockForUpdate: false,
      sharedLock: false,
      jsonValueQuery: true,
      jsonContains: false,
      jsonLength: false,
      schemaQualifiedIdentifiers: false,
      nativeUpsert: false,
      ddlAlterSupport: false,
      introspection: true },
    quoteIdentifier(identifier: string) {
      return `"${identifier}"`
    },
    createPlaceholder(index: number) {
      return `?${index}`
    } }
}

function createPostgresDialect(): Dialect {
  return {
    ...createSqliteDialect(),
    name: 'postgres',
    createPlaceholder(index: number) {
      return `$${index}`
    } }
}

function createMySqlDialect(): Dialect {
  return {
    ...createSqliteDialect(),
    name: 'mysql',
    quoteIdentifier(identifier: string) {
      return `\`${identifier}\``
    },
    createPlaceholder() {
      return '?'
    } }
}

describe('schema diff', () => {
  it('reports a clean diff when the live sqlite schema matches the logical schema', async () => {
    const users = defineTable('users', {
      id: column.id(),
      email: column.string().unique(),
      team_id: column.foreignId().constrained('teams').cascadeOnDelete().restrictOnUpdate() }, {
      indexes: [{ columns: ['email'], unique: true }] })

    const db = createDatabase({
      adapter: new DiffAdapter({
        tables: ['users'],
        columns: {
          users: [
            { name: 'id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
            { name: 'email', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
            { name: 'team_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
          ] },
        indexes: {
          users: [{ name: 'users_email_unique', unique: 1 }] },
        indexColumns: {
          users_email_unique: [{ name: 'email' }] },
        foreignKeys: {
          users: [{ table: 'teams', from: 'team_id', to: 'id', on_update: 'RESTRICT', on_delete: 'CASCADE' }] } }),
      dialect: createSqliteDialect() })

    const diff = await createSchemaDiff(createSchemaService(db), [users])
    expect(diff).toEqual({
      missingTables: [],
      extraTables: [],
      tables: [{
        table: 'users',
        missingColumns: [],
        extraColumns: [],
        mismatchedColumns: [],
        missingIndexes: [],
        extraIndexes: [],
        mismatchedIndexes: [],
        missingForeignKeys: [],
        extraForeignKeys: [],
        mismatchedForeignKeys: [],
        hasChanges: false }],
      hasChanges: false })
  })

  it('reports missing, extra, and mismatched sqlite schema details', async () => {
    const users = defineTable('users', {
      id: column.id(),
      email: column.string().unique(),
      active: column.boolean(),
      team_id: column.foreignId().constrained('teams').cascadeOnDelete().restrictOnUpdate() }, {
      indexes: [{ columns: ['email'], unique: true }] })
    const posts = defineTable('posts', {
      id: column.id() })

    const db = createDatabase({
      adapter: new DiffAdapter({
        tables: ['users', 'legacy'],
        columns: {
          users: [
            { name: 'id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
            { name: 'email', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
            { name: 'legacy_flag', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
          ] },
        indexes: {
          users: [{ name: 'legacy_email_idx', unique: 0 }] },
        indexColumns: {
          legacy_email_idx: [{ name: 'email' }] },
        foreignKeys: {
          users: [{ table: 'teams', from: 'team_id', to: 'id', on_update: 'NO ACTION', on_delete: 'SET NULL' }] } }),
      dialect: createSqliteDialect() })

    const diff = await createSchemaDiff(createSchemaService(db), [users, posts])
    expect(diff.missingTables).toEqual(['posts'])
    expect(diff.extraTables).toEqual(['legacy'])
    expect(diff.hasChanges).toBe(true)
    expect(diff.tables).toEqual([{
      table: 'users',
      missingColumns: ['active', 'team_id'],
      extraColumns: ['legacy_flag'],
      mismatchedColumns: [{
        column: 'email',
        expected: { type: 'TEXT', notNull: true, primaryKey: false },
        actual: { type: 'INTEGER', notNull: false, primaryKey: false } }],
      missingIndexes: ['users_email_unique'],
      extraIndexes: ['legacy_email_idx'],
      mismatchedIndexes: [],
      missingForeignKeys: [],
      extraForeignKeys: [],
      mismatchedForeignKeys: [{
        foreignKey: 'team_id->teams.id',
        expected: {
          table: 'teams',
          from: 'team_id',
          to: 'id',
          onUpdate: 'RESTRICT',
          onDelete: 'CASCADE' },
        actual: {
          table: 'teams',
          from: 'team_id',
          to: 'id',
          onUpdate: 'NO ACTION',
          onDelete: 'SET NULL' } }],
      hasChanges: true }])
  })

  it('reports a clean diff when Postgres and MySQL schemas match the logical schema', async () => {
    const users = defineTable('users', {
      id: column.id(),
      email: column.string().unique(),
      external_uuid: column.uuid(),
      public_ulid: column.ulid(),
      snowflake_id: column.snowflake(),
      active: column.boolean(),
      bio: column.text(),
      settings: column.json<{ enabled: boolean }>(),
      birthday: column.date(),
      published_at: column.datetime(),
      created_at: column.timestamp(),
      role: column.enum(['admin', 'member'] as const),
      ratio: column.real(),
      amount: column.decimal(),
      payload: column.blob(),
      login_count: column.integer(),
      team_id: column.foreignId().constrained('teams').cascadeOnDelete().restrictOnUpdate() }, {
      indexes: [{ columns: ['email'], unique: true }] })

    const postgresDb = createDatabase({
      adapter: new DiffAdapter({
        tables: [],
        columns: {},
        indexes: {},
        indexColumns: {},
        foreignKeys: {},
        postgresTables: [{ name: 'users' }],
        postgresColumns: {
          users: [
            { name: 'id', type: 'bigint', is_nullable: 'NO', default_value: null, primary_key: true },
            { name: 'email', type: 'character varying', is_nullable: 'NO', default_value: null, primary_key: false },
            { name: 'external_uuid', type: 'uuid', is_nullable: 'NO', default_value: null, primary_key: false },
            { name: 'public_ulid', type: 'character varying', is_nullable: 'NO', default_value: null, primary_key: false },
            { name: 'snowflake_id', type: 'character varying', is_nullable: 'NO', default_value: null, primary_key: false },
            { name: 'active', type: 'boolean', is_nullable: 'NO', default_value: null, primary_key: false },
            { name: 'bio', type: 'text', is_nullable: 'NO', default_value: null, primary_key: false },
            { name: 'settings', type: 'jsonb', is_nullable: 'NO', default_value: null, primary_key: false },
            { name: 'birthday', type: 'date', is_nullable: 'NO', default_value: null, primary_key: false },
            { name: 'published_at', type: 'timestamp', is_nullable: 'NO', default_value: null, primary_key: false },
            { name: 'created_at', type: 'timestamp', is_nullable: 'NO', default_value: null, primary_key: false },
            { name: 'role', type: 'text', is_nullable: 'NO', default_value: null, primary_key: false },
            { name: 'ratio', type: 'double precision', is_nullable: 'NO', default_value: null, primary_key: false },
            { name: 'amount', type: 'numeric', is_nullable: 'NO', default_value: null, primary_key: false },
            { name: 'payload', type: 'bytea', is_nullable: 'NO', default_value: null, primary_key: false },
            { name: 'login_count', type: 'integer', is_nullable: 'NO', default_value: null, primary_key: false },
            { name: 'team_id', type: 'bigint', is_nullable: 'NO', default_value: null, primary_key: false },
          ] },
        postgresIndexes: {
          users: [
            { name: 'users_email_unique', definition: 'CREATE UNIQUE INDEX users_email_unique ON public.users USING btree (email)' },
          ] },
        postgresForeignKeys: {
          users: [
            { table_name: 'teams', from_column: 'team_id', to_column: 'id', on_update: 'RESTRICT', on_delete: 'CASCADE' },
          ] } }),
      dialect: createPostgresDialect() })

    const mysqlDb = createDatabase({
      adapter: new DiffAdapter({
        tables: [],
        columns: {},
        indexes: {},
        indexColumns: {},
        foreignKeys: {},
        mysqlTables: [{ name: 'users' }],
        mysqlColumns: {
          users: [
            { name: 'id', type: 'bigint', is_nullable: 'NO', default_value: null, column_key: 'PRI' },
            { name: 'email', type: 'varchar', is_nullable: 'NO', default_value: null, column_key: '' },
            { name: 'external_uuid', type: 'char', is_nullable: 'NO', default_value: null, column_key: '' },
            { name: 'public_ulid', type: 'char', is_nullable: 'NO', default_value: null, column_key: '' },
            { name: 'snowflake_id', type: 'varchar', is_nullable: 'NO', default_value: null, column_key: '' },
            { name: 'active', type: 'tinyint', is_nullable: 'NO', default_value: null, column_key: '' },
            { name: 'bio', type: 'text', is_nullable: 'NO', default_value: null, column_key: '' },
            { name: 'settings', type: 'json', is_nullable: 'NO', default_value: null, column_key: '' },
            { name: 'birthday', type: 'date', is_nullable: 'NO', default_value: null, column_key: '' },
            { name: 'published_at', type: 'datetime', is_nullable: 'NO', default_value: null, column_key: '' },
            { name: 'created_at', type: 'timestamp', is_nullable: 'NO', default_value: null, column_key: '' },
            { name: 'role', type: 'enum', is_nullable: 'NO', default_value: null, column_key: '' },
            { name: 'ratio', type: 'double', is_nullable: 'NO', default_value: null, column_key: '' },
            { name: 'amount', type: 'decimal', is_nullable: 'NO', default_value: null, column_key: '' },
            { name: 'payload', type: 'blob', is_nullable: 'NO', default_value: null, column_key: '' },
            { name: 'login_count', type: 'int', is_nullable: 'NO', default_value: null, column_key: '' },
            { name: 'team_id', type: 'bigint', is_nullable: 'NO', default_value: null, column_key: '' },
          ] },
        mysqlIndexes: {
          users: [
            { name: 'users_email_unique', non_unique: 0, column_name: 'email' },
          ] },
        mysqlForeignKeys: {
          users: [
            { table_name: 'teams', from_column: 'team_id', to_column: 'id', on_update: 'RESTRICT', on_delete: 'CASCADE' },
          ] } }),
      dialect: createMySqlDialect() })

    await expect(createSchemaDiff(createSchemaService(postgresDb), [users])).resolves.toMatchObject({
      hasChanges: false,
      tables: [expect.objectContaining({ table: 'users', hasChanges: false })] })
    await expect(createSchemaDiff(createSchemaService(mysqlDb), [users])).resolves.toMatchObject({
      hasChanges: false,
      tables: [expect.objectContaining({ table: 'users', hasChanges: false })] })

    const vectors = defineTable('vectors', {
      id: column.id(),
      embedding: column.vector({ dimensions: 3 }) })

    const postgresVectorDb = createDatabase({
      adapter: new DiffAdapter({
        tables: [],
        columns: {},
        indexes: {},
        indexColumns: {},
        foreignKeys: {},
        postgresTables: [{ name: 'vectors' }],
        postgresColumns: {
          vectors: [
            { name: 'id', type: 'bigint', is_nullable: 'NO', default_value: null, primary_key: true },
            { name: 'embedding', type: 'vector(3)', is_nullable: 'NO', default_value: null, primary_key: false },
          ] },
        postgresIndexes: {},
        postgresForeignKeys: {} }),
      dialect: createPostgresDialect() })

    await expect(createSchemaDiff(createSchemaService(postgresVectorDb), [vectors])).resolves.toMatchObject({
      hasChanges: false,
      tables: [expect.objectContaining({ table: 'vectors', hasChanges: false })] })
  })

  it('fails closed for unsupported logical types and unsupported schema diffing dialects', async () => {
    const vectors = defineTable('vectors', {
      embedding: column.vector({ dimensions: 3 }) })
    const weirdMysql = defineTable('weird_mysql', {
      odd: {
        kind: 'made_up_kind',
        name: 'odd',
        nullable: false,
        hasDefault: false,
        generated: false,
        primaryKey: false,
        unique: false } as never })
    const weirdPostgres = defineTable('weird_postgres', {
      odd: {
        kind: 'made_up_kind',
        name: 'odd',
        nullable: false,
        hasDefault: false,
        generated: false,
        primaryKey: false,
        unique: false } as never })

    const sqliteDb = createDatabase({
      adapter: new DiffAdapter({
        tables: ['vectors', 'broken_fk'],
        columns: {
          vectors: [{ name: 'embedding', type: 'BLOB', notnull: 1, dflt_value: null, pk: 0 }],
          broken_fk: [] },
        indexes: {},
        indexColumns: {},
        foreignKeys: {} }),
      dialect: createSqliteDialect() })

    await expect(createSchemaDiff(createSchemaService(sqliteDb), [vectors])).rejects.toThrow(SchemaError)
    expect(() => defineTable('broken_fk', {
      team_id: column.foreignId().references('id') })).toThrow(SchemaError)

    const mysqlDb = createDatabase({
      adapter: new DiffAdapter({
        tables: [],
        columns: {
          vectors: [{ name: 'embedding', type: 'BLOB', notnull: 1, dflt_value: null, pk: 0 }] },
        indexes: {},
        indexColumns: {},
        foreignKeys: {},
        mysqlTables: [{ name: 'vectors' }],
        mysqlColumns: {
          vectors: [{ name: 'embedding', type: 'blob', is_nullable: 'NO', default_value: null, column_key: '' }] },
        mysqlIndexes: {},
        mysqlForeignKeys: {} }),
      dialect: createMySqlDialect() })

    await expect(createSchemaDiff(createSchemaService(mysqlDb), [vectors])).rejects.toThrow(SchemaError)

    const postgresDb = createDatabase({
      adapter: new DiffAdapter({
        tables: [],
        columns: {},
        indexes: {},
        indexColumns: {},
        foreignKeys: {},
        postgresTables: [{ name: 'weird_postgres' }],
        postgresColumns: {
          weird_postgres: [{ name: 'odd', type: 'text', is_nullable: 'NO', default_value: null, primary_key: false }] } }),
      dialect: createPostgresDialect() })

    await expect(createSchemaDiff(createSchemaService(postgresDb), [weirdPostgres])).rejects.toThrow(SchemaError)

    const weirdMysqlDb = createDatabase({
      adapter: new DiffAdapter({
        tables: [],
        columns: {},
        indexes: {},
        indexColumns: {},
        foreignKeys: {},
        mysqlTables: [{ name: 'weird_mysql' }],
        mysqlColumns: {
          weird_mysql: [{ name: 'odd', type: 'text', is_nullable: 'NO', default_value: null, column_key: '' }] },
        mysqlIndexes: {},
        mysqlForeignKeys: {} }),
      dialect: createMySqlDialect() })

    await expect(createSchemaDiff(createSchemaService(weirdMysqlDb), [weirdMysql])).rejects.toThrow(SchemaError)

    const oracleDb = createDatabase({
      adapter: new DiffAdapter({
        tables: [],
        columns: {},
        indexes: {},
        indexColumns: {},
        foreignKeys: {} }),
      dialect: {
        ...createPostgresDialect(),
        name: 'oracle' } })

    await expect(createSchemaDiff(createSchemaService(oracleDb), [])).rejects.toThrow(CapabilityError)
  })

  it('covers index mismatches, extra foreign keys, and remaining sqlite type-lowering branches', async () => {
    const metrics = defineTable('metrics', {
      price: column.decimal(),
      ratio: column.real(),
      payload: column.blob() }, {
      indexes: [{ name: 'metrics_price_idx', columns: ['price'], unique: true }] })
    const weird = defineTable('weird', {
      odd: {
        kind: 'made_up_kind',
        name: 'odd',
        nullable: false,
        hasDefault: false,
        generated: false,
        primaryKey: false,
        unique: false } as never })

    const sqliteDb = createDatabase({
      adapter: new DiffAdapter({
        tables: ['metrics', 'weird'],
        columns: {
          metrics: [
            { name: 'price', type: 'NUMERIC', notnull: 1, dflt_value: null, pk: 0 },
            { name: 'ratio', type: 'REAL', notnull: 1, dflt_value: null, pk: 0 },
            { name: 'payload', type: 'BLOB', notnull: 1, dflt_value: null, pk: 0 },
          ],
          weird: [
            { name: 'odd', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
          ] },
        indexes: {
          metrics: [{ name: 'metrics_price_idx', unique: 0 }] },
        indexColumns: {
          metrics_price_idx: [{ name: 'ratio' }] },
        foreignKeys: {
          metrics: [{ table: 'teams', from: 'team_id', to: 'id', on_update: 'NO ACTION', on_delete: 'NO ACTION' }] } }),
      dialect: createSqliteDialect() })

    const diff = await createSchemaDiff(createSchemaService(sqliteDb), [metrics])
    expect(diff.tables[0]!.mismatchedIndexes).toEqual([{
      index: 'metrics_price_idx',
      expected: { unique: true, columns: ['price'] },
      actual: { unique: false, columns: ['ratio'] } }])
    expect(diff.tables[0]!.extraForeignKeys).toEqual(['team_id->teams.id'])

    await expect(createSchemaDiff(createSchemaService(sqliteDb), [weird])).rejects.toThrow(SchemaError)
  })

  it('covers default foreign-key actions and unnamed non-unique index naming', async () => {
    const audits = defineTable('audits', {
      id: column.id(),
      team_id: column.foreignId().constrained('teams'),
      code: column.string() }, {
      indexes: [{ columns: ['code'], unique: false }] })

    const db = createDatabase({
      adapter: new DiffAdapter({
        tables: ['audits'],
        columns: {
          audits: [
            { name: 'id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
            { name: 'team_id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
            { name: 'code', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
          ] },
        indexes: {
          audits: [{ name: 'audits_code_index', unique: 0 }] },
        indexColumns: {
          audits_code_index: [{ name: 'code' }] },
        foreignKeys: {
          audits: [{ table: 'teams', from: 'team_id', to: 'id', on_update: 'NO ACTION', on_delete: 'NO ACTION' }] } }),
      dialect: createSqliteDialect() })

    const diff = await createSchemaDiff(createSchemaService(db), [audits])
    expect(diff.hasChanges).toBe(false)
    expect(diff.tables[0]!.missingIndexes).toEqual([])
    expect(diff.tables[0]!.mismatchedForeignKeys).toEqual([])
  })
})
