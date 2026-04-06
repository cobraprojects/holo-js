import { describe, expect, it } from 'vitest'
import {
  addColumnOperation,
  alterColumnOperation,
  CapabilityError,
  MySQLSchemaCompiler,
  PostgresSchemaCompiler,
  SchemaError,
  SQLiteSchemaCompiler,
  column,
  createForeignKeyOperation,
  createIndexOperation,
  createDatabase,
  createSchemaRegistry,
  createSchemaService,
  createTableOperation,
  dropColumnOperation,
  dropForeignKeyOperation,
  dropIndexOperation,
  dropTableOperation,
  renameIndexOperation,
  renameColumnOperation,
  renameTableOperation,
  type Dialect,
  type DriverAdapter,
  type DriverExecutionResult,
  type DriverQueryResult } from '../src'
import { defineTable } from './support/internal'

function parseIdentifierTail(identifierPath: string): string {
  return identifierPath
    .split('.')
    .at(-1)!
    .replaceAll('"', '')
    .replaceAll('`', '')
}

function parseColumnDefinition(sql: string): {
  name: string
  type: string
  notNull: boolean
  defaultValue: string | null
  primaryKey: boolean
} {
  const quote = sql[0]
  if (!quote || (quote !== '"' && quote !== '`')) {
    throw new Error(`Unable to parse column definition: ${sql}`)
  }

  const nameEnd = sql.indexOf(quote, 1)
  if (nameEnd <= 0) {
    throw new Error(`Unable to parse column definition: ${sql}`)
  }

  const remainder = sql.slice(nameEnd + 1).trimStart()
  if (remainder.length === 0) {
    throw new Error(`Unable to parse column definition: ${sql}`)
  }

  const columnName = sql.slice(1, nameEnd)
  const constraintBoundary = remainder.match(
    /\s(?=NOT NULL|DEFAULT |PRIMARY KEY|UNIQUE(?:\s|$)|REFERENCES )/i,
  )
  const boundaryIndex = constraintBoundary?.index ?? -1
  const typeSegment = boundaryIndex >= 0
    ? remainder.slice(0, boundaryIndex).trim()
    : remainder.trim()
  const constraintSegment = boundaryIndex >= 0
    ? remainder.slice(boundaryIndex + 1)
    : ''
  const defaultMatch = constraintSegment.match(/DEFAULT (.+?)(?: REFERENCES| ON DELETE| ON UPDATE|$)/i)

  return {
    name: columnName,
    type: typeSegment.trim(),
    notNull: constraintSegment.includes('NOT NULL'),
    defaultValue: defaultMatch?.[1]?.trim() ?? null,
    primaryKey: constraintSegment.includes('PRIMARY KEY') }
}

function toSqliteColumnRow(column: ReturnType<typeof parseColumnDefinition>) {
  return {
    name: column.name,
    type: column.type,
    notnull: column.notNull ? 1 : 0,
    dflt_value: column.defaultValue,
    pk: column.primaryKey ? 1 : 0 }
}

function toPostgresColumnRow(column: ReturnType<typeof parseColumnDefinition>) {
  return {
    name: column.name,
    type: column.type.toLowerCase(),
    is_nullable: column.notNull ? 'NO' as const : 'YES' as const,
    default_value: column.defaultValue,
    primary_key: column.primaryKey }
}

function toMySqlColumnRow(column: ReturnType<typeof parseColumnDefinition>) {
  return {
    name: column.name,
    type: column.type.toLowerCase().split('(')[0] ?? column.type.toLowerCase(),
    is_nullable: column.notNull ? 'NO' as const : 'YES' as const,
    default_value: column.defaultValue,
    column_key: column.primaryKey ? 'PRI' : '' }
}

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

class SchemaAdapter implements DriverAdapter {
  connected = false
  readonly executed: string[] = []
  readonly queried: string[] = []
  readonly introspected: string[] = []
  readonly queryCalls: Array<{ sql: string, bindings: readonly unknown[] }> = []
  readonly introspectionCalls: Array<{ sql: string, bindings: readonly unknown[] }> = []

  constructor(
    private readonly state: QueryState,
    private readonly options: {
      dedicatedIntrospection?: boolean
    } = {},
  ) {}

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
    this.queried.push(sql)
    this.queryCalls.push({ sql, bindings })
    return this.resolveQuery<TRow>(sql, bindings)
  }

  async introspect<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverQueryResult<TRow>> {
    if (!this.options.dedicatedIntrospection) {
      return this.query<TRow>(sql, bindings)
    }

    this.introspected.push(sql)
    this.introspectionCalls.push({ sql, bindings })
    return this.resolveQuery<TRow>(sql, bindings)
  }

  private resolveQuery<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverQueryResult<TRow>> {
    if (sql.includes('sqlite_master')) {
      return Promise.resolve({
        rows: this.state.tables.map(name => ({ name })) as unknown as TRow[],
        rowCount: this.state.tables.length })
    }

    if (sql === 'SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = \'public\' ORDER BY tablename') {
      const rows = this.state.postgresTables ?? []
      return Promise.resolve({ rows: rows as unknown as TRow[], rowCount: rows.length })
    }

    if (sql === 'SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = $1 ORDER BY tablename') {
      const rows = this.state.postgresTables ?? []
      return Promise.resolve({ rows: rows as unknown as TRow[], rowCount: rows.length })
    }

    if (sql === 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name') {
      const rows = this.state.mysqlTables ?? []
      return Promise.resolve({ rows: rows as unknown as TRow[], rowCount: rows.length })
    }

    if (sql === 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name') {
      const rows = this.state.mysqlTables ?? []
      return Promise.resolve({ rows: rows as unknown as TRow[], rowCount: rows.length })
    }

    const tableInfo = sql.match(/^PRAGMA table_info\("([^"]+)"\)$/)
    if (tableInfo) {
      const rows = this.state.columns[tableInfo[1]!] ?? []
      return Promise.resolve({ rows: rows as unknown as TRow[], rowCount: rows.length })
    }

    const indexList = sql.match(/^PRAGMA index_list\("([^"]+)"\)$/)
    if (indexList) {
      const rows = this.state.indexes[indexList[1]!] ?? []
      return Promise.resolve({ rows: rows as unknown as TRow[], rowCount: rows.length })
    }

    const indexInfo = sql.match(/^PRAGMA index_info\("([^"]+)"\)$/)
    if (indexInfo) {
      const rows = this.state.indexColumns[indexInfo[1]!] ?? []
      return Promise.resolve({ rows: rows as unknown as TRow[], rowCount: rows.length })
    }

    const foreignKeyList = sql.match(/^PRAGMA foreign_key_list\("([^"]+)"\)$/)
    if (foreignKeyList) {
      const rows = this.state.foreignKeys[foreignKeyList[1]!] ?? []
      return Promise.resolve({ rows: rows as unknown as TRow[], rowCount: rows.length })
    }

    if (sql === 'SELECT c.column_name AS name, c.data_type AS type, c.is_nullable AS is_nullable, c.column_default AS default_value, EXISTS (SELECT 1 FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.table_schema = \'public\' AND tc.table_name = c.table_name AND tc.constraint_type = \'PRIMARY KEY\' AND kcu.column_name = c.column_name) AS primary_key FROM information_schema.columns c WHERE c.table_schema = \'public\' AND c.table_name = $1 ORDER BY c.ordinal_position') {
      const rows = this.state.postgresColumns?.[String(bindings[0] ?? '')] ?? []
      return Promise.resolve({ rows: rows as unknown as TRow[], rowCount: rows.length })
    }

    if (sql === 'SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = \'public\' AND tablename = $1 ORDER BY indexname') {
      const rows = this.state.postgresIndexes?.[String(bindings[0] ?? '')] ?? []
      return Promise.resolve({ rows: rows as unknown as TRow[], rowCount: rows.length })
    }

    if (sql === 'SELECT ccu.table_name AS table_name, kcu.column_name AS from_column, ccu.column_name AS to_column, rc.update_rule AS on_update, rc.delete_rule AS on_delete FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema WHERE tc.constraint_type = \'FOREIGN KEY\' AND tc.table_schema = \'public\' AND tc.table_name = $1 ORDER BY kcu.ordinal_position') {
      const rows = this.state.postgresForeignKeys?.[String(bindings[0] ?? '')] ?? []
      return Promise.resolve({ rows: rows as unknown as TRow[], rowCount: rows.length })
    }

    if (sql === 'SELECT column_name AS name, data_type AS type, is_nullable AS is_nullable, column_default AS default_value, column_key AS column_key FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position') {
      const rows = this.state.mysqlColumns?.[String(bindings[0] ?? '')] ?? []
      return Promise.resolve({ rows: rows as unknown as TRow[], rowCount: rows.length })
    }

    if (sql === 'SELECT column_name AS name, data_type AS type, is_nullable AS is_nullable, column_default AS default_value, column_key AS column_key FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position') {
      const rows = this.state.mysqlColumns?.[String(bindings[1] ?? '')] ?? []
      return Promise.resolve({ rows: rows as unknown as TRow[], rowCount: rows.length })
    }

    if (sql === 'SELECT index_name AS name, non_unique AS non_unique, column_name AS column_name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? ORDER BY index_name, seq_in_index') {
      const rows = this.state.mysqlIndexes?.[String(bindings[0] ?? '')] ?? []
      return Promise.resolve({ rows: rows as unknown as TRow[], rowCount: rows.length })
    }

    if (sql === 'SELECT index_name AS name, non_unique AS non_unique, column_name AS column_name FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? ORDER BY index_name, seq_in_index') {
      const rows = this.state.mysqlIndexes?.[String(bindings[1] ?? '')] ?? []
      return Promise.resolve({ rows: rows as unknown as TRow[], rowCount: rows.length })
    }

    if (sql === 'SELECT referenced_table_name AS table_name, column_name AS from_column, referenced_column_name AS to_column, update_rule AS on_update, delete_rule AS on_delete FROM information_schema.key_column_usage kcu JOIN information_schema.referential_constraints rc ON rc.constraint_name = kcu.constraint_name AND rc.constraint_schema = kcu.table_schema WHERE kcu.table_schema = DATABASE() AND kcu.table_name = ? AND kcu.referenced_table_name IS NOT NULL ORDER BY kcu.ordinal_position') {
      const rows = this.state.mysqlForeignKeys?.[String(bindings[0] ?? '')] ?? []
      return Promise.resolve({ rows: rows as unknown as TRow[], rowCount: rows.length })
    }

    if (sql === 'SELECT referenced_table_name AS table_name, column_name AS from_column, referenced_column_name AS to_column, update_rule AS on_update, delete_rule AS on_delete FROM information_schema.key_column_usage kcu JOIN information_schema.referential_constraints rc ON rc.constraint_name = kcu.constraint_name AND rc.constraint_schema = kcu.table_schema WHERE kcu.table_schema = ? AND kcu.table_name = ? AND kcu.referenced_table_name IS NOT NULL ORDER BY kcu.ordinal_position') {
      const rows = this.state.mysqlForeignKeys?.[String(bindings[1] ?? '')] ?? []
      return Promise.resolve({ rows: rows as unknown as TRow[], rowCount: rows.length })
    }

    return Promise.resolve({ rows: [] as unknown as TRow[], rowCount: 0 })
  }

  async execute(sql: string): Promise<DriverExecutionResult> {
    this.executed.push(sql)

    const createTable = sql.match(/^CREATE TABLE IF NOT EXISTS (?:"([^"]+)"|`([^`]+)`)/)
    if (createTable) {
      const tableName = createTable[1] ?? createTable[2]
      if (tableName && !this.state.tables.includes(tableName)) {
        this.state.tables.push(tableName)
      }
    }

    const dropTable = sql.match(/^DROP TABLE IF EXISTS (?:"([^"]+)"|`([^`]+)`)/)
    if (dropTable) {
      const tableName = dropTable[1] ?? dropTable[2]
      this.state.tables = this.state.tables.filter(name => name !== tableName)
    }

    const renameTable = sql.match(/^(?:ALTER TABLE (?:"([^"]+)"|`([^`]+)`) RENAME TO (?:"([^"]+)"|`([^`]+)`)|RENAME TABLE (?:"([^"]+)"|`([^`]+)`) TO (?:"([^"]+)"|`([^`]+)`))$/)
    if (renameTable) {
      const fromTableName = renameTable[1] ?? renameTable[2] ?? renameTable[5] ?? renameTable[6]
      const toTableName = renameTable[3] ?? renameTable[4] ?? renameTable[7] ?? renameTable[8]
      if (fromTableName && toTableName) {
        this.state.tables = this.state.tables.map(name => name === fromTableName ? toTableName : name)
      }
    }

    const createIndex = sql.match(/^CREATE (UNIQUE )?INDEX IF NOT EXISTS (?:"([^"]+)"|`([^`]+)`) ON (?:"([^"]+)"|`([^`]+)`|\w+\.\w+) \((.+)\)$/)
    if (createIndex) {
      const [, uniqueFlag, quotedIndexName, mysqlIndexName, quotedTableName, mysqlTableName, rawColumns] = createIndex
      const indexName = quotedIndexName ?? mysqlIndexName ?? ''
      const tableName = quotedTableName ?? mysqlTableName ?? ''
      const columns = (rawColumns ?? '')
        .split(', ')
        .map(column => column.replaceAll('"', '').replaceAll('`', ''))

      const tableIndexes = this.state.indexes[tableName] ?? (this.state.indexes[tableName] = [])
      if (!tableIndexes.some(index => index.name === indexName)) {
        tableIndexes.push({
          name: indexName,
          unique: uniqueFlag ? 1 : 0 })
      }
      this.state.indexColumns[indexName] = columns.map(name => ({ name }))
    }

    const dropIndex = sql.match(/^DROP INDEX IF EXISTS (?:"([^"]+)"|`([^`]+)`)/)
    if (dropIndex) {
      const indexName = dropIndex[1] ?? dropIndex[2] ?? ''
      for (const indexes of Object.values(this.state.indexes)) {
        const position = indexes.findIndex(index => index.name === indexName)
        if (position >= 0) {
          indexes.splice(position, 1)
        }
      }
      delete this.state.indexColumns[indexName]
    }

    const renameIndex = sql.match(/^(?:ALTER INDEX (?:"([^"]+)"|`([^`]+)`) RENAME TO (?:"([^"]+)"|`([^`]+)`)|ALTER TABLE (?:"([^"]+)"|`([^`]+)`) RENAME INDEX (?:"([^"]+)"|`([^`]+)`) TO (?:"([^"]+)"|`([^`]+)`))$/)
    if (renameIndex) {
      const fromIndexName = renameIndex[1] ?? renameIndex[2] ?? renameIndex[7] ?? renameIndex[8] ?? ''
      const toIndexName = renameIndex[3] ?? renameIndex[4] ?? renameIndex[9] ?? renameIndex[10] ?? ''
      for (const indexes of Object.values(this.state.indexes)) {
        const index = indexes.find(entry => entry.name === fromIndexName)
        if (index) {
          index.name = toIndexName
        }
      }
      const columns = this.state.indexColumns[fromIndexName]
      if (columns) {
        this.state.indexColumns[toIndexName] = columns
        delete this.state.indexColumns[fromIndexName]
      }
      if (this.state.postgresIndexes) {
        for (const indexes of Object.values(this.state.postgresIndexes)) {
          for (const index of indexes) {
            if (index.name === fromIndexName) {
              index.name = toIndexName
              index.definition = index.definition.replace(fromIndexName, toIndexName)
            }
          }
        }
      }
      if (this.state.mysqlIndexes) {
        for (const indexes of Object.values(this.state.mysqlIndexes)) {
          for (const index of indexes) {
            if (index.name === fromIndexName) {
              index.name = toIndexName
            }
          }
        }
      }
    }

    const addColumn = sql.match(/^ALTER TABLE (.+) ADD COLUMN (.+)$/)
    if (addColumn) {
      const tableName = parseIdentifierTail(addColumn[1] ?? '')
      const column = parseColumnDefinition(addColumn[2] ?? '')
      const sqliteColumns = this.state.columns[tableName] ?? (this.state.columns[tableName] = [])
      sqliteColumns.push(toSqliteColumnRow(column))

      if (this.state.postgresColumns) {
        const postgresColumns = this.state.postgresColumns[tableName] ?? (this.state.postgresColumns[tableName] = [])
        postgresColumns.push(toPostgresColumnRow(column))
      }

      if (this.state.mysqlColumns) {
        const mysqlColumns = this.state.mysqlColumns[tableName] ?? (this.state.mysqlColumns[tableName] = [])
        mysqlColumns.push(toMySqlColumnRow(column))
      }
    }

    const dropColumn = sql.match(/^ALTER TABLE (.+) DROP COLUMN (?:"([^"]+)"|`([^`]+)`)$/)
    if (dropColumn) {
      const tableName = parseIdentifierTail(dropColumn[1] ?? '')
      const columnName = dropColumn[2] ?? dropColumn[3] ?? ''
      this.state.columns[tableName] = (this.state.columns[tableName] ?? []).filter(column => column.name !== columnName)

      if (this.state.postgresColumns) {
        this.state.postgresColumns[tableName] = (this.state.postgresColumns[tableName] ?? []).filter(column => column.name !== columnName)
      }

      if (this.state.mysqlColumns) {
        this.state.mysqlColumns[tableName] = (this.state.mysqlColumns[tableName] ?? []).filter(column => column.name !== columnName)
      }
    }

    const renameColumn = sql.match(/^ALTER TABLE (.+) RENAME COLUMN (?:"([^"]+)"|`([^`]+)`) TO (?:"([^"]+)"|`([^`]+)`)$/)
    if (renameColumn) {
      const tableName = parseIdentifierTail(renameColumn[1] ?? '')
      const fromColumnName = renameColumn[2] ?? renameColumn[3] ?? ''
      const toColumnName = renameColumn[4] ?? renameColumn[5] ?? ''

      for (const column of this.state.columns[tableName] ?? []) {
        if (column.name === fromColumnName) {
          column.name = toColumnName
        }
      }

      for (const column of this.state.postgresColumns?.[tableName] ?? []) {
        if (column.name === fromColumnName) {
          column.name = toColumnName
        }
      }

      for (const column of this.state.mysqlColumns?.[tableName] ?? []) {
        if (column.name === fromColumnName) {
          column.name = toColumnName
        }
      }
    }

    return { affectedRows: 1 }
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
    capabilities: {
      ...createSqliteDialect().capabilities,
      ddlAlterSupport: true,
      schemaQualifiedIdentifiers: true },
    createPlaceholder(index: number) {
      return `$${index}`
    } }
}

function createMySqlDialect(): Dialect {
  return {
    ...createSqliteDialect(),
    name: 'mysql',
    capabilities: {
      ...createSqliteDialect().capabilities,
      lockForUpdate: true,
      sharedLock: true,
      jsonContains: true,
      jsonLength: true,
      schemaQualifiedIdentifiers: true,
      nativeUpsert: true,
      ddlAlterSupport: true },
    quoteIdentifier(identifier: string) {
      return `\`${identifier}\``
    },
    createPlaceholder() {
      return '?'
    } }
}

describe('sqlite schema compiler', () => {
  it('compiles logical schema definitions into SQLite DDL and index statements', () => {
    const createdAt = new Date('2025-01-02T03:04:05.000Z')
    const compiler = new SQLiteSchemaCompiler(identifier => `"${identifier}"`)
    const users = defineTable('users', {
      id: column.id(),
      active: column.boolean().default(false),
      rating: column.integer().default(3),
      notes: column.text().nullable().default(null),
      created_at: column.timestamp().defaultNow(),
      publishedOn: column.date().default(createdAt),
      nickname: column.string().default('O\'Reilly'),
      settings: column.json<{ enabled: boolean }>().default({ enabled: true }),
      teamId: column.foreignId().constrained('teams').cascadeOnDelete().restrictOnUpdate(),
      account_uuid: column.foreignUuid().constrained('accounts', 'uuid'),
      session_ulid: column.foreignUlid().constrained('sessions'),
      actor_snowflake: column.foreignSnowflake().constrained('actors', 'snowflake_id') }, {
      indexes: [{ columns: ['nickname'], unique: true }] })

    const statements = compiler.compile(createTableOperation(users))
    expect(statements).toHaveLength(2)
    expect(statements[0]!.sql).toContain('CREATE TABLE IF NOT EXISTS "users"')
    expect(statements[0]!.sql).toContain('"id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL')
    expect(statements[0]!.sql).toContain('"active" INTEGER NOT NULL DEFAULT 0')
    expect(statements[0]!.sql).toContain('"rating" INTEGER NOT NULL DEFAULT 3')
    expect(statements[0]!.sql).toContain('"notes" TEXT DEFAULT NULL')
    expect(statements[0]!.sql).toContain('"created_at" TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP')
    expect(statements[0]!.sql).toContain(`"publishedOn" TEXT NOT NULL DEFAULT '${createdAt.toISOString()}'`)
    expect(statements[0]!.sql).toContain(`"nickname" TEXT NOT NULL DEFAULT 'O''Reilly'`)
    expect(statements[0]!.sql).toContain(`"settings" TEXT NOT NULL DEFAULT '{"enabled":true}'`)
    expect(statements[0]!.sql).toContain('REFERENCES "teams" ("id") ON DELETE CASCADE ON UPDATE RESTRICT')
    expect(statements[0]!.sql).toContain('"account_uuid" TEXT NOT NULL REFERENCES "accounts" ("uuid")')
    expect(statements[0]!.sql).toContain('"session_ulid" TEXT NOT NULL REFERENCES "sessions" ("id")')
    expect(statements[0]!.sql).toContain('"actor_snowflake" TEXT NOT NULL REFERENCES "actors" ("snowflake_id")')
    expect(statements[1]!.sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "users_nickname_unique"')

    expect(compiler.compile(dropTableOperation('users'))).toEqual([{
      sql: 'DROP TABLE IF EXISTS "users"',
      source: 'schema:dropTable:users' }])
  })

  it('covers custom index names, non-unique indexes, and true boolean defaults', () => {
    const compiler = new SQLiteSchemaCompiler(identifier => `"${identifier}"`)
    const flags = defineTable('flags', {
      enabled: column.boolean().default(true),
      code: column.string() }, {
      indexes: [{ name: 'flags_code_idx', columns: ['code'], unique: false }] })

    const statements = compiler.compile(createTableOperation(flags))
    expect(statements[0]!.sql).toContain('"enabled" INTEGER NOT NULL DEFAULT 1')
    expect(statements[1]!.sql).toBe(
      'CREATE INDEX IF NOT EXISTS "flags_code_idx" ON "flags" ("code")',
    )
  })

  it('does not append AUTOINCREMENT for non-generated SQLite primary keys', () => {
    const compiler = new SQLiteSchemaCompiler(identifier => `"${identifier}"`)
    const docs = defineTable('docs', {
      slug: column.string().primaryKey(),
      title: column.string() })

    const [statement] = compiler.compile(createTableOperation(docs))

    expect(statement!.sql).toContain('"slug" TEXT PRIMARY KEY NOT NULL')
    expect(statement!.sql).not.toContain('AUTOINCREMENT')
  })

  it('derives non-unique index names when one is not provided', () => {
    const compiler = new SQLiteSchemaCompiler(identifier => `"${identifier}"`)
    const posts = defineTable('posts', {
      title: column.string() }, {
      indexes: [{ columns: ['title'], unique: false }] })

    const statements = compiler.compile(createTableOperation(posts))
    expect(statements[1]!.sql).toBe(
      'CREATE INDEX IF NOT EXISTS "posts_title_index" ON "posts" ("title")',
    )
  })

  it('covers remaining SQLite type lowering branches and fails closed for invalid schema definitions', () => {
    const compiler = new SQLiteSchemaCompiler(identifier => `"${identifier}"`)
    const assets = defineTable('assets', {
      price: column.decimal(),
      ratio: column.real(),
      payload: column.blob() })
    const vectors = defineTable('vectors', {
      embedding: column.vector({ dimensions: 3 }) })
    const unknownKind = defineTable('unknown_kind', {
      weird: {
        kind: 'made_up_kind',
        name: 'weird',
        nullable: false,
        hasDefault: false,
        generated: false,
        primaryKey: false,
        unique: false } as never })

    expect(compiler.compile(createTableOperation(assets))[0]!.sql).toContain(
      '"price" NUMERIC NOT NULL, "ratio" REAL NOT NULL, "payload" BLOB NOT NULL',
    )
    expect(() => compiler.compile(createTableOperation(vectors))).toThrow(SchemaError)
    expect(() => defineTable('broken_fk', {
      teamId: column.foreignId().references('id') })).toThrow(SchemaError)
    expect(() => compiler.compile(createTableOperation(unknownKind))).toThrow(SchemaError)
  })
})

describe('multi-dialect schema compilers', () => {
  it('lowers logical schema types to Postgres syntax', () => {
    const compiler = new PostgresSchemaCompiler(identifier => `"${identifier}"`)
    const embeddings = defineTable('embeddings', {
      id: column.id(),
      active: column.boolean().default(true),
      disabled: column.boolean().default(false),
      score: column.integer().default(3),
      count: column.bigInteger(),
      title: column.string().default('O\'Reilly'),
      body: column.text().nullable().default(null),
      payload: column.json<{ enabled: boolean }>().default({ enabled: true }),
      uuid: column.uuid(),
      ulid: column.ulid(),
      snowflake: column.snowflake(),
      account_uuid: column.foreignUuid().constrained('accounts', 'uuid'),
      session_ulid: column.foreignUlid().constrained('sessions'),
      actor_snowflake: column.foreignSnowflake().constrained('actors', 'snowflake_id'),
      startsOn: column.date().default(new Date('2025-01-02T03:04:05.000Z')),
      publishedAt: column.datetime(),
      createdAt: column.timestamp().defaultNow(),
      role: column.enum(['admin', 'member'] as const),
      ratio: column.real(),
      amount: column.decimal(),
      blob: column.blob(),
      embedding: column.vector({ dimensions: 3 }) })
    const brokenVector = defineTable('broken_vectors', {
      embedding: {
        kind: 'vector',
        name: 'embedding',
        nullable: false,
        hasDefault: false,
        generated: false,
        primaryKey: false,
        unique: false,
        vectorDimensions: 0 } as never })
    const manualId = defineTable('manual_id', {
      id: {
        kind: 'id',
        name: 'id',
        nullable: false,
        hasDefault: false,
        generated: false,
        primaryKey: true,
        unique: false,
        idStrategy: 'uuid' } as never })
    const unknownKind = defineTable('unknown_postgres_kind', {
      weird: {
        kind: 'made_up_kind',
        name: 'weird',
        nullable: false,
        hasDefault: false,
        generated: false,
        primaryKey: false,
        unique: false } as never })

    const statements = compiler.compile(createTableOperation(embeddings))
    expect(statements[0]!.sql).toContain('"id" BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY NOT NULL')
    expect(statements[0]!.sql).toContain('"active" BOOLEAN NOT NULL DEFAULT TRUE')
    expect(statements[0]!.sql).toContain('"disabled" BOOLEAN NOT NULL DEFAULT FALSE')
    expect(statements[0]!.sql).toContain('"score" INTEGER NOT NULL DEFAULT 3')
    expect(statements[0]!.sql).toContain(`"title" VARCHAR(255) NOT NULL DEFAULT 'O''Reilly'`)
    expect(statements[0]!.sql).toContain('"body" TEXT DEFAULT NULL')
    expect(statements[0]!.sql).toContain(`"payload" JSONB NOT NULL DEFAULT '{"enabled":true}'`)
    expect(statements[0]!.sql).toContain('"uuid" UUID NOT NULL')
    expect(statements[0]!.sql).toContain('"ulid" VARCHAR(26) NOT NULL')
    expect(statements[0]!.sql).toContain('"snowflake" VARCHAR(32) NOT NULL')
    expect(statements[0]!.sql).toContain('"account_uuid" UUID NOT NULL REFERENCES "accounts" ("uuid")')
    expect(statements[0]!.sql).toContain('"session_ulid" VARCHAR(26) NOT NULL REFERENCES "sessions" ("id")')
    expect(statements[0]!.sql).toContain('"actor_snowflake" VARCHAR(32) NOT NULL REFERENCES "actors" ("snowflake_id")')
    expect(statements[0]!.sql).toContain(`"startsOn" DATE NOT NULL DEFAULT '2025-01-02T03:04:05.000Z'`)
    expect(statements[0]!.sql).toContain('"publishedAt" TIMESTAMP NOT NULL')
    expect(statements[0]!.sql).toContain('"createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP')
    expect(statements[0]!.sql).toContain('"role" TEXT NOT NULL')
    expect(statements[0]!.sql).toContain('"ratio" DOUBLE PRECISION NOT NULL')
    expect(statements[0]!.sql).toContain('"amount" NUMERIC NOT NULL')
    expect(statements[0]!.sql).toContain('"blob" BYTEA NOT NULL')
    expect(statements[0]!.sql).toContain('"embedding" VECTOR(3) NOT NULL')
    expect(compiler.compile(createTableOperation(manualId))[0]!.sql).toContain('"id" BIGINT PRIMARY KEY NOT NULL')
    expect(() => compiler.compile(createTableOperation(brokenVector))).toThrow(SchemaError)
    expect(() => defineTable('broken_fk', {
      teamId: column.foreignId().references('id') })).toThrow(SchemaError)
    expect(() => compiler.compile(createTableOperation(unknownKind))).toThrow(SchemaError)
  })

  it('quotes schema-qualified Postgres table and foreign-key identifiers structurally', () => {
    const compiler = new PostgresSchemaCompiler(identifier => `"${identifier}"`)
    const auditLogs = defineTable('public.audit_logs', {
      id: column.id(),
      userId: column.foreignId().constrained('auth.users') })

    const statements = compiler.compile(createTableOperation(auditLogs))
    expect(statements[0]!.sql).toContain('CREATE TABLE IF NOT EXISTS "public"."audit_logs"')
    expect(statements[0]!.sql).toContain('REFERENCES "auth"."users" ("id")')
    expect(compiler.compile(dropTableOperation('public.audit_logs'))).toEqual([{
      sql: 'DROP TABLE IF EXISTS "public"."audit_logs"',
      source: 'schema:dropTable:public.audit_logs' }])
  })

  it('quotes database-qualified MySQL table and foreign-key identifiers structurally', () => {
    const compiler = new MySQLSchemaCompiler(identifier => `\`${identifier}\``)
    const auditLogs = defineTable('analytics.audit_logs', {
      id: column.id(),
      userId: column.foreignId().constrained('core.users') })

    const statements = compiler.compile(createTableOperation(auditLogs))
    expect(statements[0]!.sql).toContain('CREATE TABLE IF NOT EXISTS `analytics`.`audit_logs`')
    expect(statements[0]!.sql).toContain('REFERENCES `core`.`users` (`id`)')
    expect(compiler.compile(dropTableOperation('analytics.audit_logs'))).toEqual([{
      sql: 'DROP TABLE IF EXISTS `analytics`.`audit_logs`',
      source: 'schema:dropTable:analytics.audit_logs' }])
  })

  it('lowers logical schema types to MySQL syntax and fails closed for unsupported vectors', () => {
    const compiler = new MySQLSchemaCompiler(identifier => `\`${identifier}\``)
    const users = defineTable('users', {
      id: column.id(),
      active: column.boolean().default(false),
      enabled: column.boolean().default(true),
      score: column.integer().default(3),
      count: column.bigInteger(),
      title: column.string().default('O\'Reilly'),
      body: column.text().nullable().default(null),
      role: column.enum(['admin', 'member'] as const).default('member'),
      uuid: column.uuid(),
      ulid: column.ulid(),
      snowflake: column.snowflake(),
      account_uuid: column.foreignUuid().constrained('accounts', 'uuid'),
      session_ulid: column.foreignUlid().constrained('sessions'),
      actor_snowflake: column.foreignSnowflake().constrained('actors', 'snowflake_id'),
      startsOn: column.date().default(new Date('2025-01-02T03:04:05.000Z')),
      publishedAt: column.datetime(),
      createdAt: column.timestamp().defaultNow(),
      payload: column.json<{ enabled: boolean }>().default({ enabled: true }),
      ratio: column.real(),
      amount: column.decimal(),
      blob: column.blob() })
    const vectors = defineTable('vectors', {
      embedding: column.vector({ dimensions: 3 }) })
    const manualId = defineTable('manual_id', {
      id: {
        kind: 'id',
        name: 'id',
        nullable: false,
        hasDefault: false,
        generated: false,
        primaryKey: true,
        unique: false,
        idStrategy: 'uuid' } as never })
    const brokenEnum = defineTable('broken_enum', {
      role: {
        kind: 'enum',
        name: 'role',
        nullable: false,
        hasDefault: false,
        generated: false,
        primaryKey: false,
        unique: false,
        enumValues: [] } as never })
    const unknownKind = defineTable('unknown_mysql_kind', {
      weird: {
        kind: 'made_up_kind',
        name: 'weird',
        nullable: false,
        hasDefault: false,
        generated: false,
        primaryKey: false,
        unique: false } as never })

    const statements = compiler.compile(createTableOperation(users))
    expect(statements[0]!.sql).toContain('`id` BIGINT AUTO_INCREMENT PRIMARY KEY NOT NULL')
    expect(statements[0]!.sql).toContain('`active` TINYINT(1) NOT NULL DEFAULT 0')
    expect(statements[0]!.sql).toContain('`enabled` TINYINT(1) NOT NULL DEFAULT 1')
    expect(statements[0]!.sql).toContain('`score` INT NOT NULL DEFAULT 3')
    expect(statements[0]!.sql).toContain('`count` BIGINT NOT NULL')
    expect(statements[0]!.sql).toContain('`title` VARCHAR(255) NOT NULL DEFAULT \'O\'\'Reilly\'')
    expect(statements[0]!.sql).toContain('`body` TEXT DEFAULT NULL')
    expect(statements[0]!.sql).toContain('`role` ENUM(\'admin\', \'member\') NOT NULL DEFAULT \'member\'')
    expect(statements[0]!.sql).toContain('`uuid` CHAR(36) NOT NULL')
    expect(statements[0]!.sql).toContain('`ulid` CHAR(26) NOT NULL')
    expect(statements[0]!.sql).toContain('`snowflake` VARCHAR(32) NOT NULL')
    expect(statements[0]!.sql).toContain('`account_uuid` CHAR(36) NOT NULL REFERENCES `accounts` (`uuid`)')
    expect(statements[0]!.sql).toContain('`session_ulid` CHAR(26) NOT NULL REFERENCES `sessions` (`id`)')
    expect(statements[0]!.sql).toContain('`actor_snowflake` VARCHAR(32) NOT NULL REFERENCES `actors` (`snowflake_id`)')
    expect(statements[0]!.sql).toContain('`startsOn` DATE NOT NULL DEFAULT \'2025-01-02T03:04:05.000Z\'')
    expect(statements[0]!.sql).toContain('`publishedAt` DATETIME NOT NULL')
    expect(statements[0]!.sql).toContain('`createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP')
    expect(statements[0]!.sql).toContain('`payload` JSON NOT NULL DEFAULT \'{"enabled":true}\'')
    expect(statements[0]!.sql).toContain('`ratio` DOUBLE NOT NULL')
    expect(statements[0]!.sql).toContain('`amount` DECIMAL(10, 2) NOT NULL')
    expect(statements[0]!.sql).toContain('`blob` BLOB NOT NULL')
    expect(compiler.compile(createTableOperation(manualId))[0]!.sql).toContain('`id` BIGINT PRIMARY KEY NOT NULL')
    expect(() => compiler.compile(createTableOperation(vectors))).toThrow(SchemaError)
    expect(() => defineTable('broken_fk', {
      teamId: column.foreignId().references('id') })).toThrow(SchemaError)
    expect(() => compiler.compile(createTableOperation(brokenEnum))).toThrow(SchemaError)
    expect(() => compiler.compile(createTableOperation(unknownKind))).toThrow(SchemaError)
  })

  it('fails closed for invalid default literals across SQLite, Postgres, and MySQL', () => {
    const invalidDefaults = defineTable('invalid_defaults', {
      nanScore: column.real().default(Number.NaN),
      bufferPayload: column.blob().nullable().default(new Uint8Array([1, 2, 3])) })

    const sqliteCompiler = new SQLiteSchemaCompiler(identifier => `"${identifier}"`)
    const postgresCompiler = new PostgresSchemaCompiler(identifier => `"${identifier}"`)
    const mysqlCompiler = new MySQLSchemaCompiler(identifier => `\`${identifier}\``)

    expect(() => sqliteCompiler.compile(createTableOperation(invalidDefaults))).toThrow(
      'Column "nanScore" has a default value that cannot be compiled safely for SQLite.',
    )
    expect(() => postgresCompiler.compile(createTableOperation(invalidDefaults))).toThrow(
      'Column "nanScore" has a default value that cannot be compiled safely for Postgres.',
    )
    expect(() => mysqlCompiler.compile(createTableOperation(invalidDefaults))).toThrow(
      'Column "nanScore" has a default value that cannot be compiled safely for MySQL.',
    )

    const invalidBlobDefault = defineTable('invalid_blob_defaults', {
      payload: column.blob().default(new Uint8Array([1, 2, 3])) })

    expect(() => sqliteCompiler.compile(createTableOperation(invalidBlobDefault))).toThrow(
      'Column "payload" has a default value that cannot be compiled safely for SQLite.',
    )
    expect(() => postgresCompiler.compile(createTableOperation(invalidBlobDefault))).toThrow(
      'Column "payload" has a default value that cannot be compiled safely for Postgres.',
    )
    expect(() => mysqlCompiler.compile(createTableOperation(invalidBlobDefault))).toThrow(
      'Column "payload" has a default value that cannot be compiled safely for MySQL.',
    )
  })

  it('covers shared schema-compiler helper branches directly', () => {
    const compiler = new SQLiteSchemaCompiler(identifier => `"${identifier}"`)
    const helpers = compiler as unknown as {
      compileIdentifierPath(identifier: string): string
      isSupportedDefaultValue(value: unknown): boolean
      compileCreateTable(table: unknown): Array<{ sql: string, source: string }>
    }

    const indexed = defineTable('analytics.users', {
      id: column.id(),
      email: column.string() }, {
      indexes: [{ columns: ['email'], unique: true }] })

    class CustomDefault {
      constructor(readonly value: number) {}
    }

    expect(helpers.compileIdentifierPath('users')).toBe('"users"')
    expect(helpers.compileIdentifierPath('analytics.users')).toBe('"analytics"."users"')
    expect(helpers.compileCreateTable(indexed)).toHaveLength(2)
    expect(helpers.isSupportedDefaultValue({ nested: [1, 'a', null, true] })).toBe(true)
    expect(helpers.isSupportedDefaultValue(undefined)).toBe(false)
    expect(helpers.isSupportedDefaultValue(new CustomDefault(1))).toBe(false)
  })

  it('compiles explicit create-index and drop-index operations across dialects', () => {
    const sqliteCompiler = new SQLiteSchemaCompiler(identifier => `"${identifier}"`)
    const postgresCompiler = new PostgresSchemaCompiler(identifier => `"${identifier}"`)
    const mysqlCompiler = new MySQLSchemaCompiler(identifier => `\`${identifier}\``)

    expect(sqliteCompiler.compile(createIndexOperation('users', {
      columns: ['email'],
      unique: true }))).toEqual([{
      sql: 'CREATE UNIQUE INDEX IF NOT EXISTS "users_email_unique" ON "users" ("email")',
      source: 'schema:createIndex:users:users_email_unique' }])

    expect(postgresCompiler.compile(createIndexOperation('public.users', {
      name: 'users_name_index',
      columns: ['name'],
      unique: false }))).toEqual([{
      sql: 'CREATE INDEX IF NOT EXISTS "users_name_index" ON "public"."users" ("name")',
      source: 'schema:createIndex:public.users:users_name_index' }])

    expect(mysqlCompiler.compile(createIndexOperation('analytics.users', {
      name: 'users_email_unique',
      columns: ['email'],
      unique: true }))).toEqual([{
      sql: 'CREATE UNIQUE INDEX `users_email_unique` ON `analytics`.`users` (`email`)',
      source: 'schema:createIndex:analytics.users:users_email_unique' }])

    expect(mysqlCompiler.compile(createIndexOperation('analytics.users', {
      columns: ['email'],
      unique: false }))).toEqual([{
      sql: 'CREATE INDEX `analytics_users_email_index` ON `analytics`.`users` (`email`)',
      source: 'schema:createIndex:analytics.users:analytics_users_email_index' }])

    expect(mysqlCompiler.compile(dropIndexOperation('analytics.users', 'users_email_unique'))).toEqual([{
      sql: 'DROP INDEX `users_email_unique` ON `analytics`.`users`',
      source: 'schema:dropIndex:analytics.users:users_email_unique' }])
  })

  it('compiles explicit rename-table operations across dialects', () => {
    const sqliteCompiler = new SQLiteSchemaCompiler(identifier => `"${identifier}"`)
    const postgresCompiler = new PostgresSchemaCompiler(identifier => `"${identifier}"`)
    const mysqlCompiler = new MySQLSchemaCompiler(identifier => `\`${identifier}\``)

    expect(sqliteCompiler.compile(renameTableOperation('users', 'archived_users'))).toEqual([{
      sql: 'ALTER TABLE "users" RENAME TO "archived_users"',
      source: 'schema:renameTable:users:archived_users' }])
    expect(postgresCompiler.compile(renameTableOperation('public.users', 'public.archived_users'))).toEqual([{
      sql: 'ALTER TABLE "public"."users" RENAME TO "public"."archived_users"',
      source: 'schema:renameTable:public.users:public.archived_users' }])
    expect(mysqlCompiler.compile(renameTableOperation('users', 'archived_users'))).toEqual([{
      sql: 'RENAME TABLE `users` TO `archived_users`',
      source: 'schema:renameTable:users:archived_users' }])
  })

  it('compiles explicit rename-index operations across supported dialects', () => {
    const postgresCompiler = new PostgresSchemaCompiler(identifier => `"${identifier}"`)
    const mysqlCompiler = new MySQLSchemaCompiler(identifier => `\`${identifier}\``)

    expect(postgresCompiler.compile(renameIndexOperation('users', 'users_email_index', 'users_email_lookup'))).toEqual([{
      sql: 'ALTER INDEX "users_email_index" RENAME TO "users_email_lookup"',
      source: 'schema:renameIndex:users:users_email_index:users_email_lookup' }])
    expect(mysqlCompiler.compile(renameIndexOperation('users', 'users_email_index', 'users_email_lookup'))).toEqual([{
      sql: 'ALTER TABLE `users` RENAME INDEX `users_email_index` TO `users_email_lookup`',
      source: 'schema:renameIndex:users:users_email_index:users_email_lookup' }])
  })

  it('compiles explicit add-column and drop-column operations across supported dialects', () => {
    const postgresCompiler = new PostgresSchemaCompiler(identifier => `"${identifier}"`)
    const mysqlCompiler = new MySQLSchemaCompiler(identifier => `\`${identifier}\``)

    expect(postgresCompiler.compile(addColumnOperation('public.users', column.string().nullable().toDefinition({
      name: 'nickname' })))).toEqual([{
      sql: 'ALTER TABLE "public"."users" ADD COLUMN "nickname" VARCHAR(255)',
      source: 'schema:addColumn:public.users:nickname' }])

    expect(mysqlCompiler.compile(dropColumnOperation('users', 'nickname'))).toEqual([{
      sql: 'ALTER TABLE `users` DROP COLUMN `nickname`',
      source: 'schema:dropColumn:users:nickname' }])

    expect(postgresCompiler.compile(renameColumnOperation('users', 'nickname', 'display_name'))).toEqual([{
      sql: 'ALTER TABLE "users" RENAME COLUMN "nickname" TO "display_name"',
      source: 'schema:renameColumn:users:nickname:display_name' }])

    expect(postgresCompiler.compile(alterColumnOperation('users', column.string().nullable().default('draft').toDefinition({
      name: 'nickname' })))).toEqual([
      {
        sql: 'ALTER TABLE "users" ALTER COLUMN "nickname" TYPE VARCHAR(255)',
        source: 'schema:alterColumn:users:nickname:type' },
      {
        sql: 'ALTER TABLE "users" ALTER COLUMN "nickname" DROP NOT NULL',
        source: 'schema:alterColumn:users:nickname:nullability' },
      {
        sql: 'ALTER TABLE "users" ALTER COLUMN "nickname" SET DEFAULT \'draft\'',
        source: 'schema:alterColumn:users:nickname:default' },
    ])

    expect(mysqlCompiler.compile(alterColumnOperation('users', column.boolean().default(true).toDefinition({
      name: 'isActive' })))).toEqual([{
      sql: 'ALTER TABLE `users` MODIFY COLUMN `isActive` TINYINT(1) NOT NULL DEFAULT 1',
      source: 'schema:alterColumn:users:isActive' }])

    expect(postgresCompiler.compile(alterColumnOperation('users', column.timestamp().defaultNow().toDefinition({
      name: 'publishedAt' })))).toEqual([
      {
        sql: 'ALTER TABLE "users" ALTER COLUMN "publishedAt" TYPE TIMESTAMP',
        source: 'schema:alterColumn:users:publishedAt:type' },
      {
        sql: 'ALTER TABLE "users" ALTER COLUMN "publishedAt" SET NOT NULL',
        source: 'schema:alterColumn:users:publishedAt:nullability' },
      {
        sql: 'ALTER TABLE "users" ALTER COLUMN "publishedAt" SET DEFAULT CURRENT_TIMESTAMP',
        source: 'schema:alterColumn:users:publishedAt:default' },
    ])

    expect(postgresCompiler.compile(alterColumnOperation('users', column.string().toDefinition({
      name: 'nickname' })))).toEqual([
      {
        sql: 'ALTER TABLE "users" ALTER COLUMN "nickname" TYPE VARCHAR(255)',
        source: 'schema:alterColumn:users:nickname:type' },
      {
        sql: 'ALTER TABLE "users" ALTER COLUMN "nickname" SET NOT NULL',
        source: 'schema:alterColumn:users:nickname:nullability' },
      {
        sql: 'ALTER TABLE "users" ALTER COLUMN "nickname" DROP DEFAULT',
        source: 'schema:alterColumn:users:nickname:default' },
    ])
  })

  it('compiles explicit add-foreign-key and drop-foreign-key operations across supported dialects', () => {
    const postgresCompiler = new PostgresSchemaCompiler(identifier => `"${identifier}"`)
    const mysqlCompiler = new MySQLSchemaCompiler(identifier => `\`${identifier}\``)

    expect(postgresCompiler.compile(createForeignKeyOperation(
      'public.users',
      'team_id',
      { table: 'public.teams', column: 'id', onDelete: 'cascade', onUpdate: 'restrict' },
    ))).toEqual([{
      sql: 'ALTER TABLE "public"."users" ADD CONSTRAINT "public_users_team_id_foreign" FOREIGN KEY ("team_id") REFERENCES "public"."teams" ("id") ON DELETE CASCADE ON UPDATE RESTRICT',
      source: 'schema:createForeignKey:public.users:public_users_team_id_foreign' }])

    expect(mysqlCompiler.compile(dropForeignKeyOperation('users', 'users_team_id_foreign'))).toEqual([{
      sql: 'ALTER TABLE `users` DROP FOREIGN KEY `users_team_id_foreign`',
      source: 'schema:dropForeignKey:users:users_team_id_foreign' }])

    expect(() => postgresCompiler.compile(createForeignKeyOperation(
      'users',
      'team_id',
      { column: 'id' } as never,
    ))).toThrow(
      'Foreign key column "team_id" must include a referenced table for Postgres compilation.',
    )
  })

  it('rejects malformed identifier paths before schema SQL is compiled', () => {
    const compiler = new SQLiteSchemaCompiler(identifier => `"${identifier}"`)

    expect(() => compiler.compile(dropTableOperation('users;drop'))).toThrow(
      'Table name must be a valid SQL identifier segment.',
    )

    expect(() => compiler.compile(dropTableOperation('public..users'))).toThrow(
      'Table name must not contain empty identifier segments.',
    )
  })
})

describe('schema service', () => {
  it('registers tables created through the builder-based createTable API', async () => {
    const adapter = new SchemaAdapter({
      tables: [],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {} })
    const registry = createSchemaRegistry()
    const db = createDatabase({
      adapter,
      dialect: createSqliteDialect(),
      schemaRegistry: registry })
    const schema = createSchemaService(db)

    await schema.createTable('users', (table) => {
      table.id()
      table.string('email').unique()
    })

    expect(db.getSchemaRegistry().get('users')?.tableName).toBe('users')
  })

  it('creates, drops, and syncs tables through compiled statements and registry state', async () => {
    const adapter = new SchemaAdapter({
      tables: [],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {} })
    const registry = createSchemaRegistry()
    const db = createDatabase({
      adapter,
      dialect: createSqliteDialect(),
      schemaRegistry: registry })
    const schema = createSchemaService(db)
    const users = defineTable('users', {
      id: column.id(),
      email: column.string().unique() })
    const posts = defineTable('posts', {
      id: column.id() })

    expect(schema.register(users)).toBe(users)
    expect(db.getSchemaRegistry()).toBe(registry)

    await schema.createTable('users', (table) => {
      table.id()
      table.string('email').unique()
    })
    expect(await schema.hasTable('users')).toBe(true)
    expect(adapter.executed[0]).toContain('CREATE TABLE IF NOT EXISTS "users"')

    await schema.table('users', (table) => {
      table.index(['email'], 'users_email_index')
    })
    expect(await schema.getIndexes('users')).toEqual([
      { name: 'users_email_index', unique: false, columns: ['email'] },
    ])

    await schema.table('users', (table) => {
      table.dropIndex('users_email_index')
    })
    expect(await schema.getIndexes('users')).toEqual([])

    db.getSchemaRegistry().register(posts)
    await expect(schema.previewSync()).resolves.toEqual({
      mode: 'create_missing_only',
      tablesToCreate: ['posts'],
      existingTables: ['users'],
      destructiveChanges: false })
    await schema.sync()
    expect(await schema.getTables()).toEqual(['posts', 'users'])
    expect(adapter.executed.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS "posts"'))).toBe(true)
    expect(adapter.executed.some(sql => sql.includes('DROP TABLE'))).toBe(false)

    await schema.dropTable('users')
    expect(await schema.hasTable('users')).toBe(false)
    expect(adapter.executed.includes('DROP TABLE IF EXISTS "users"')).toBe(true)

    await schema.createTable('profiles', (table) => {
      table.id()
      table.string('display_name').nullable()
      table.timestamps()
    })
    expect(await schema.hasTable('profiles')).toBe(true)
    expect(adapter.executed.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS "profiles"'))).toBe(true)

    await schema.createTable('users', (table) => {
      table.id()
      table.string('email').unique()
    })
    await schema.dropTable('users')
    expect(await schema.hasTable('users')).toBe(false)
  })

  it('renames tables through compiled schema statements', async () => {
    const registry = createSchemaRegistry()
    const adapter = new SchemaAdapter({
      tables: ['users'],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {} })
    const db = createDatabase({
      adapter,
      dialect: createSqliteDialect(),
      schemaRegistry: registry })
    const schema = createSchemaService(db)
    const users = defineTable('users', {
      id: column.id(),
      email: column.string() })
    registry.register(users)

    await schema.renameTable('users', 'archived_users')

    expect(await schema.hasTable('archived_users')).toBe(true)
    expect(await schema.hasTable('users')).toBe(false)
    expect(registry.get('users')).toBeUndefined()
    expect(registry.get('archived_users')?.tableName).toBe('archived_users')
    expect(registry.get('archived_users')?.columns).toEqual(users.columns)
    expect(registry.get('archived_users')?.indexes).toEqual(users.indexes)
    expect(adapter.executed).toContain('ALTER TABLE "users" RENAME TO "archived_users"')
  })

  it('allows table renames even when the schema registry does not have the source table loaded', async () => {
    const adapter = new SchemaAdapter({
      tables: ['users'],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {},
    })
    const registry = createSchemaRegistry()
    const schema = createSchemaService(createDatabase({
      adapter,
      dialect: createSqliteDialect(),
      schemaRegistry: registry,
    }))

    await schema.renameTable('users', 'archived_users')

    expect(registry.get('users')).toBeUndefined()
    expect(registry.get('archived_users')).toBeUndefined()
    expect(adapter.executed).toContain('ALTER TABLE "users" RENAME TO "archived_users"')
  })

  it('resolves explicit and generated index names when mutating registry-backed tables', () => {
    const schema = createSchemaService(createDatabase({
      adapter: new SchemaAdapter({ tables: [], columns: {}, indexes: {}, indexColumns: {}, foreignKeys: {} }),
      dialect: createPostgresDialect(),
      schemaRegistry: createSchemaRegistry(),
    }))

    const resolveIndexName = Reflect.get(schema as object, 'resolveIndexName') as (
      tableName: string,
      index: { columns: readonly string[], unique: boolean, name?: string },
    ) => string

    expect(resolveIndexName('users', { columns: ['email'], unique: true, name: 'users_email_unique' })).toBe('users_email_unique')
    expect(resolveIndexName('users', { columns: ['email'], unique: true })).toBe('users_email_unique')
    expect(resolveIndexName('users', { columns: ['display_name'], unique: false })).toBe('users_display_name_index')
  })

  it('renames indexes where the active dialect supports it and fails closed otherwise', async () => {
    const postgresAdapter = new SchemaAdapter({
      tables: ['users'],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {},
      postgresIndexes: {
        users: [{ name: 'users_email_index', definition: 'CREATE INDEX users_email_index ON public.users USING btree (email)' }] } })
    const postgresSchema = createSchemaService(createDatabase({
      adapter: postgresAdapter,
      dialect: createPostgresDialect(),
      schemaRegistry: createSchemaRegistry() }))
    const users = defineTable('users', {
      id: column.id(),
      email: column.string() })

    await postgresSchema.table('users', (table) => {
      table.renameIndex('users_email_index', 'users_email_lookup')
    })
    expect(await postgresSchema.getIndexes('users')).toEqual([
      { name: 'users_email_lookup', unique: false, columns: ['email'] },
    ])

    const sqliteSchema = createSchemaService(createDatabase({
      adapter: new SchemaAdapter({ tables: ['users'], columns: {}, indexes: {}, indexColumns: {}, foreignKeys: {} }),
      dialect: createSqliteDialect(),
      schemaRegistry: createSchemaRegistry() }))

    await expect(sqliteSchema.table('users', (table) => {
      table.renameIndex('users_email_index', 'users_email_lookup')
    })).rejects.toThrow(
      'SchemaService does not support renaming indexes for dialect "sqlite".',
    )
  })

  it('adds and drops columns where the active dialect supports alter-table operations and fails closed otherwise', async () => {
    const postgresSchema = createSchemaService(createDatabase({
      adapter: new SchemaAdapter({
        tables: ['users'],
        columns: {},
        indexes: {},
        indexColumns: {},
        foreignKeys: {},
        postgresColumns: {
          users: [{ name: 'id', type: 'bigint', is_nullable: 'NO', default_value: null, primary_key: true }] } }),
      dialect: createPostgresDialect(),
      schemaRegistry: createSchemaRegistry() }))
    const mysqlSchema = createSchemaService(createDatabase({
      adapter: new SchemaAdapter({
        tables: ['users'],
        columns: {},
        indexes: {},
        indexColumns: {},
        foreignKeys: {},
        mysqlColumns: {
          users: [{ name: 'id', type: 'bigint', is_nullable: 'NO', default_value: null, column_key: 'PRI' }] } }),
      dialect: createMySqlDialect(),
      schemaRegistry: createSchemaRegistry() }))
    const sqliteSchema = createSchemaService(createDatabase({
      adapter: new SchemaAdapter({ tables: ['users'], columns: {}, indexes: {}, indexColumns: {}, foreignKeys: {} }),
      dialect: createSqliteDialect(),
      schemaRegistry: createSchemaRegistry() }))
    await postgresSchema.table('users', (table) => {
      table.string('nickname').nullable()
    })
    expect(await postgresSchema.getColumns('users')).toMatchObject([
      { name: 'id', logicalType: 'bigInteger' },
      { name: 'nickname', type: 'varchar(255)', logicalType: 'string', notNull: false, defaultValue: null, primaryKey: false },
    ])
    await postgresSchema.table('users', (table) => {
      table.dropColumn('nickname')
    })
    expect(await postgresSchema.getColumns('users')).toEqual([
      { name: 'id', type: 'bigint', logicalType: 'bigInteger', notNull: true, defaultValue: null, primaryKey: true },
    ])

    await mysqlSchema.table('users', (table) => {
      table.boolean('isActive').default(true)
    })
    expect(await mysqlSchema.getColumns('users')).toMatchObject([
      { name: 'id', logicalType: 'bigInteger' },
      { name: 'isActive', type: 'tinyint', logicalType: 'boolean', notNull: true, defaultValue: '1', primaryKey: false },
    ])
    await mysqlSchema.table('users', (table) => {
      table.dropColumn('isActive')
    })
    expect(await mysqlSchema.getColumns('users')).toEqual([
      { name: 'id', type: 'bigint', logicalType: 'bigInteger', notNull: true, defaultValue: null, primaryKey: true },
    ])

    await expect(sqliteSchema.table('users', (table) => {
      table.string('nickname')
    })).rejects.toThrow(
      'SchemaService does not support adding columns for dialect "sqlite".',
    )
    await expect(sqliteSchema.table('users', (table) => {
      table.dropColumn('nickname')
    })).rejects.toThrow(
      'SchemaService does not support dropping columns for dialect "sqlite".',
    )
    await expect(sqliteSchema.table('users', (table) => {
      table.renameColumn('nickname', 'display_name')
    })).rejects.toThrow(
      'SchemaService does not support renaming columns for dialect "sqlite".',
    )
  })

  it('renames columns where the active dialect supports alter-table operations', async () => {
    const postgresSchema = createSchemaService(createDatabase({
      adapter: new SchemaAdapter({
        tables: ['users'],
        columns: {},
        indexes: {},
        indexColumns: {},
        foreignKeys: {},
        postgresColumns: {
          users: [
            { name: 'id', type: 'bigint', is_nullable: 'NO', default_value: null, primary_key: true },
            { name: 'nickname', type: 'varchar(255)', is_nullable: 'YES', default_value: null, primary_key: false },
          ] } }),
      dialect: createPostgresDialect(),
      schemaRegistry: createSchemaRegistry() }))
    const mysqlSchema = createSchemaService(createDatabase({
      adapter: new SchemaAdapter({
        tables: ['users'],
        columns: {},
        indexes: {},
        indexColumns: {},
        foreignKeys: {},
        mysqlColumns: {
          users: [
            { name: 'id', type: 'bigint', is_nullable: 'NO', default_value: null, column_key: 'PRI' },
            { name: 'nickname', type: 'varchar', is_nullable: 'YES', default_value: null, column_key: '' },
          ] } }),
      dialect: createMySqlDialect(),
      schemaRegistry: createSchemaRegistry() }))

    await postgresSchema.table('users', (table) => {
      table.renameColumn('nickname', 'display_name')
    })
    expect(await postgresSchema.getColumns('users')).toMatchObject([
      { name: 'id', logicalType: 'bigInteger' },
      { name: 'display_name', logicalType: 'string' },
    ])

    await mysqlSchema.table('users', (table) => {
      table.renameColumn('nickname', 'display_name')
    })
    expect(await mysqlSchema.getColumns('users')).toMatchObject([
      { name: 'id', logicalType: 'bigInteger' },
      { name: 'display_name', logicalType: 'string' },
    ])
  })

  it('alters columns where the active dialect supports alter-table operations and fails closed for unsupported or unsafe alterations', async () => {
    const postgresAdapter = new SchemaAdapter({ tables: ['users'], columns: {}, indexes: {}, indexColumns: {}, foreignKeys: {} })
    const mysqlAdapter = new SchemaAdapter({ tables: ['users'], columns: {}, indexes: {}, indexColumns: {}, foreignKeys: {} })
    const postgresSchema = createSchemaService(createDatabase({
      adapter: postgresAdapter,
      dialect: createPostgresDialect(),
      schemaRegistry: createSchemaRegistry() }))
    const mysqlSchema = createSchemaService(createDatabase({
      adapter: mysqlAdapter,
      dialect: createMySqlDialect(),
      schemaRegistry: createSchemaRegistry() }))
    const sqliteSchema = createSchemaService(createDatabase({
      adapter: new SchemaAdapter({ tables: ['users'], columns: {}, indexes: {}, indexColumns: {}, foreignKeys: {} }),
      dialect: createSqliteDialect(),
      schemaRegistry: createSchemaRegistry() }))

    await postgresSchema.table('users', (table) => {
      table.string('nickname').nullable().default('draft').change()
    })
    expect(postgresAdapter.executed).toEqual([
      'ALTER TABLE "users" ALTER COLUMN "nickname" TYPE VARCHAR(255)',
      'ALTER TABLE "users" ALTER COLUMN "nickname" DROP NOT NULL',
      'ALTER TABLE "users" ALTER COLUMN "nickname" SET DEFAULT \'draft\'',
    ])

    await mysqlSchema.table('users', (table) => {
      table.boolean('isActive').default(true).change()
    })
    expect(mysqlAdapter.executed).toEqual([
      'ALTER TABLE `users` MODIFY COLUMN `isActive` TINYINT(1) NOT NULL DEFAULT 1',
    ])

    await expect(sqliteSchema.table('users', (table) => {
      table.string('nickname').change()
    })).rejects.toThrow(
      'SchemaService does not support altering columns for dialect "sqlite".',
    )

    await expect(postgresSchema.table('users', (table) => {
      table.id('id').change()
    })).rejects.toThrow(
      'Column "id" cannot be altered through alterColumn(); use dedicated schema operations for keys, indexes, and foreign keys.',
    )
  })

  it('supports table mutation callbacks for add, change, and drop flows', async () => {
    const postgresAdapter = new SchemaAdapter({ tables: ['users'], columns: {}, indexes: {}, indexColumns: {}, foreignKeys: {} })
    const postgresSchema = createSchemaService(createDatabase({
      adapter: postgresAdapter,
      dialect: createPostgresDialect(),
      schemaRegistry: createSchemaRegistry() }))

    await postgresSchema.table('users', async (table) => {
      table.string('nickname').nullable()
      table.string('display_name').nullable().default('guest').change()
      table.dropColumn('legacy_name')

      expect(postgresAdapter.executed).toEqual([])
    })

    expect(postgresAdapter.executed).toEqual([
      'ALTER TABLE "users" ADD COLUMN "nickname" VARCHAR(255)',
      'ALTER TABLE "users" ALTER COLUMN "display_name" TYPE VARCHAR(255)',
      'ALTER TABLE "users" ALTER COLUMN "display_name" DROP NOT NULL',
      'ALTER TABLE "users" ALTER COLUMN "display_name" SET DEFAULT \'guest\'',
      'ALTER TABLE "users" DROP COLUMN "legacy_name"',
    ])
  })

  it('preserves dependent mutation order inside table callbacks', async () => {
    const postgresAdapter = new SchemaAdapter({ tables: ['users'], columns: {}, indexes: {}, indexColumns: {}, foreignKeys: {} })
    const postgresSchema = createSchemaService(createDatabase({
      adapter: postgresAdapter,
      dialect: createPostgresDialect(),
      schemaRegistry: createSchemaRegistry() }))

    await postgresSchema.table('users', (table) => {
      table.renameColumn('nickname', 'display_name')
      table.string('display_name').nullable().change()
    })

    expect(postgresAdapter.executed).toEqual([
      'ALTER TABLE "users" RENAME COLUMN "nickname" TO "display_name"',
      'ALTER TABLE "users" ALTER COLUMN "display_name" TYPE VARCHAR(255)',
      'ALTER TABLE "users" ALTER COLUMN "display_name" DROP NOT NULL',
      'ALTER TABLE "users" ALTER COLUMN "display_name" DROP DEFAULT',
    ])
  })

  it('adds and drops foreign keys where the active dialect supports alter-table operations and fails closed otherwise', async () => {
    const postgresAdapter = new SchemaAdapter({
      tables: ['users'],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {} })
    const mysqlAdapter = new SchemaAdapter({
      tables: ['users'],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {} })
    const postgresSchema = createSchemaService(createDatabase({
      adapter: postgresAdapter,
      dialect: createPostgresDialect(),
      schemaRegistry: createSchemaRegistry() }))
    const mysqlSchema = createSchemaService(createDatabase({
      adapter: mysqlAdapter,
      dialect: createMySqlDialect(),
      schemaRegistry: createSchemaRegistry() }))
    const sqliteSchema = createSchemaService(createDatabase({
      adapter: new SchemaAdapter({ tables: ['users'], columns: {}, indexes: {}, indexColumns: {}, foreignKeys: {} }),
      dialect: createSqliteDialect(),
      schemaRegistry: createSchemaRegistry() }))
    await postgresSchema.table('users', (table) => {
      table.foreign('teamId')
        .references('id')
        .on('teams')
        .cascadeOnDelete()
        .restrictOnUpdate()
      table.dropForeign('users_teamId_foreign')
    })
    expect(postgresAdapter.executed).toContain(
      'ALTER TABLE "users" ADD CONSTRAINT "users_teamId_foreign" FOREIGN KEY ("teamId") REFERENCES "teams" ("id") ON DELETE CASCADE ON UPDATE RESTRICT',
    )
    expect(postgresAdapter.executed).toContain(
      'ALTER TABLE "users" DROP CONSTRAINT "users_teamId_foreign"',
    )

    await mysqlSchema.table('users', (table) => {
      table.foreign('team_id', 'users_team_id_foreign')
        .references('id')
        .on('teams')
      table.dropForeign('users_team_id_foreign')
    })
    expect(mysqlAdapter.executed).toContain(
      'ALTER TABLE `users` ADD CONSTRAINT `users_team_id_foreign` FOREIGN KEY (`team_id`) REFERENCES `teams` (`id`)',
    )
    expect(mysqlAdapter.executed).toContain(
      'ALTER TABLE `users` DROP FOREIGN KEY `users_team_id_foreign`',
    )

    await expect(sqliteSchema.table('users', (table) => {
      table.foreign('teamId').references('id').on('teams')
    })).rejects.toThrow(
      'SchemaService does not support adding foreign keys for dialect "sqlite".',
    )
    await expect(sqliteSchema.table('users', (table) => {
      table.dropForeign('users_teamId_foreign')
    })).rejects.toThrow(
      'SchemaService does not support dropping foreign keys for dialect "sqlite".',
    )
  })

  it('keeps the schema registry aligned when foreign keys are added or dropped through table mutations', async () => {
    const registry = createSchemaRegistry()
    registry.register(defineTable('users', {
      id: column.id(),
      team_id: column.integer(),
      account_id: column.integer(),
    }))

    const adapter = new SchemaAdapter({
      tables: ['users'],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {},
    })
    const schema = createSchemaService(createDatabase({
      adapter,
      dialect: createPostgresDialect(),
      schemaRegistry: registry,
    }))

    await schema.table('users', (table) => {
      table.foreign('team_id').references('id').on('teams').cascadeOnDelete()
    })

    expect(registry.get('users')?.columns.team_id?.references).toEqual({
      table: 'teams',
      column: 'id',
      onDelete: 'cascade',
      onUpdate: undefined,
    })

    await schema.table('users', (table) => {
      table.foreign('account_id').references('uuid').on('accounts')
      table.dropForeign('users_account_id_foreign')
    })

    expect(registry.get('users')?.columns.account_id?.references).toBeUndefined()
    expect(registry.get('users')?.columns.team_id?.references).toEqual({
      table: 'teams',
      column: 'id',
      onDelete: 'cascade',
      onUpdate: undefined,
    })
  })

  it('removes registry foreign keys when dropping an explicitly named constraint', async () => {
    const registry = createSchemaRegistry()
    registry.register(defineTable('users', {
      id: column.id(),
      account_id: column.integer(),
    }))

    const adapter = new SchemaAdapter({
      tables: ['users'],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {},
    })
    const schema = createSchemaService(createDatabase({
      adapter,
      dialect: createPostgresDialect(),
      schemaRegistry: registry,
    }))

    await schema.table('users', (table) => {
      table.foreign('account_id', 'users_account_fk').references('uuid').on('accounts')
      table.dropForeign('users_account_fk')
    })

    expect(registry.get('users')?.columns.account_id?.references).toBeUndefined()
  })

  it('leaves the schema registry unchanged when adding a foreign key for a column the registry does not know about', async () => {
    const registry = createSchemaRegistry()
    registry.register(defineTable('users', {
      id: column.id(),
    }))

    const adapter = new SchemaAdapter({
      tables: ['users'],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {},
    })
    const schema = createSchemaService(createDatabase({
      adapter,
      dialect: createPostgresDialect(),
      schemaRegistry: registry,
    }))

    await schema.table('users', (table) => {
      table.foreign('team_id').references('id').on('teams')
    })

    expect(registry.get('users')).toEqual(defineTable('users', {
      id: column.id(),
    }))
    expect(adapter.executed).toContain(
      'ALTER TABLE "users" ADD CONSTRAINT "users_team_id_foreign" FOREIGN KEY ("team_id") REFERENCES "teams" ("id")',
    )
  })

  it('preserves existing index names when columns are renamed in the registry', async () => {
    const registry = createSchemaRegistry()
    registry.register(defineTable('users', {
      id: column.id(),
      nickname: column.string(),
      email: column.string(),
    }, {
      indexes: [
        { columns: ['nickname'], unique: false },
        { columns: ['email'], unique: true, name: 'users_email_unique' },
      ],
    }))

    const adapter = new SchemaAdapter({
      tables: ['users'],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {},
    })
    const schema = createSchemaService(createDatabase({
      adapter,
      dialect: createPostgresDialect(),
      schemaRegistry: registry,
    }))

    await schema.table('users', (table) => {
      table.renameColumn('nickname', 'display_name')
      table.renameIndex('users_email_unique', 'users_email_address_unique')
      table.dropIndex('users_nickname_index')
    })

    const updated = registry.get('users')
    expect(updated?.columns).toHaveProperty('display_name')
    expect(updated?.columns).not.toHaveProperty('nickname')
    expect(updated?.indexes).toEqual([
      { columns: ['email'], unique: true, name: 'users_email_address_unique' },
    ])
    expect(adapter.executed).toEqual([
      'ALTER TABLE "users" RENAME COLUMN "nickname" TO "display_name"',
      'ALTER INDEX "users_email_unique" RENAME TO "users_email_address_unique"',
      'DROP INDEX IF EXISTS "users_nickname_index"',
    ])
  })

  it('leaves unrelated unnamed indexes unnamed when columns are renamed in the registry', async () => {
    const registry = createSchemaRegistry()
    registry.register(defineTable('users', {
      id: column.id(),
      nickname: column.string(),
      age: column.integer(),
    }, {
      indexes: [
        { columns: ['age'], unique: false },
      ],
    }))

    const adapter = new SchemaAdapter({
      tables: ['users'],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {},
    })
    const schema = createSchemaService(createDatabase({
      adapter,
      dialect: createPostgresDialect(),
      schemaRegistry: registry,
    }))

    await schema.table('users', (table) => {
      table.renameColumn('nickname', 'display_name')
    })

    const updated = registry.get('users')
    expect(updated?.columns).toHaveProperty('display_name')
    expect(updated?.columns).not.toHaveProperty('nickname')
    expect(updated?.indexes).toEqual([
      { columns: ['age'], unique: false },
    ])
    expect(adapter.executed).toEqual([
      'ALTER TABLE "users" RENAME COLUMN "nickname" TO "display_name"',
    ])
  })

  it('preserves existing foreign-key constraint names when columns are renamed in the registry', async () => {
    const registry = createSchemaRegistry()
    registry.register(defineTable('users', {
      id: column.id(),
      team_id: column.integer().constrained('teams'),
    }))

    const adapter = new SchemaAdapter({
      tables: ['users'],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {},
    })
    const schema = createSchemaService(createDatabase({
      adapter,
      dialect: createPostgresDialect(),
      schemaRegistry: registry,
    }))

    await schema.table('users', (table) => {
      table.renameColumn('team_id', 'group_id')
      table.dropForeign('users_team_id_foreign')
    })

    const updated = registry.get('users')
    expect(updated?.columns).toHaveProperty('group_id')
    expect(updated?.columns).not.toHaveProperty('team_id')
    expect(updated?.columns.group_id?.references).toBeUndefined()
    expect(adapter.executed).toEqual([
      'ALTER TABLE "users" RENAME COLUMN "team_id" TO "group_id"',
      'ALTER TABLE "users" DROP CONSTRAINT "users_team_id_foreign"',
    ])
  })

  it('preserves existing foreign keys when alter-column mutations only change scalar attributes', async () => {
    const registry = createSchemaRegistry()
    registry.register(defineTable('users', {
      id: column.id(),
      team_id: column.integer().constrained('teams').nullable(),
    }))

    const adapter = new SchemaAdapter({
      tables: ['users'],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {},
    })
    const schema = createSchemaService(createDatabase({
      adapter,
      dialect: createPostgresDialect(),
      schemaRegistry: registry,
    }))

    await schema.table('users', (table) => {
      table.integer('team_id').default(1).change()
    })

    expect(registry.get('users')?.columns.team_id?.references).toEqual({
      table: 'teams',
      column: 'id',
      constraintName: undefined,
      onDelete: undefined,
      onUpdate: undefined,
    })
    expect(adapter.executed).toEqual([
      'ALTER TABLE "users" ALTER COLUMN "team_id" TYPE INTEGER',
      'ALTER TABLE "users" ALTER COLUMN "team_id" SET NOT NULL',
      'ALTER TABLE "users" ALTER COLUMN "team_id" SET DEFAULT 1',
    ])
  })

  it('preserves existing primary keys when alter-column mutations only change scalar attributes', async () => {
    const registry = createSchemaRegistry()
    registry.register(defineTable('api_keys', {
      key: column.string().primaryKey(),
    }))

    const adapter = new SchemaAdapter({
      tables: ['api_keys'],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {},
    })
    const schema = createSchemaService(createDatabase({
      adapter,
      dialect: createPostgresDialect(),
      schemaRegistry: registry,
    }))

    await schema.table('api_keys', (table) => {
      table.string('key').default('demo').change()
    })

    expect(registry.get('api_keys')?.columns.key?.primaryKey).toBe(true)
    expect(adapter.executed).toEqual([
      'ALTER TABLE "api_keys" ALTER COLUMN "key" TYPE VARCHAR(255)',
      'ALTER TABLE "api_keys" ALTER COLUMN "key" SET NOT NULL',
      'ALTER TABLE "api_keys" ALTER COLUMN "key" SET DEFAULT \'demo\'',
    ])
  })

  it('adds altered columns to the registry when the registry did not know about them yet', async () => {
    const registry = createSchemaRegistry()
    registry.register(defineTable('users', {
      id: column.id(),
    }))

    const adapter = new SchemaAdapter({
      tables: ['users'],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {},
    })
    const schema = createSchemaService(createDatabase({
      adapter,
      dialect: createPostgresDialect(),
      schemaRegistry: registry,
    }))

    await schema.table('users', (table) => {
      table.integer('team_id').default(1).change()
    })

    expect(registry.get('users')?.columns).toHaveProperty('team_id')
    expect(registry.get('users')?.columns.team_id).toMatchObject({
      kind: 'integer',
      defaultValue: 1,
    })
    expect(adapter.executed).toEqual([
      'ALTER TABLE "users" ALTER COLUMN "team_id" TYPE INTEGER',
      'ALTER TABLE "users" ALTER COLUMN "team_id" SET NOT NULL',
      'ALTER TABLE "users" ALTER COLUMN "team_id" SET DEFAULT 1',
    ])
  })

  it('keeps the schema registry aligned when columns are added or dropped through table mutations', async () => {
    const registry = createSchemaRegistry()
    registry.register(defineTable('users', {
      id: column.id(),
      nickname: column.string(),
    }, {
      indexes: [{ columns: ['nickname'], unique: false }],
    }))

    const adapter = new SchemaAdapter({
      tables: ['users'],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {},
    })
    const schema = createSchemaService(createDatabase({
      adapter,
      dialect: createPostgresDialect(),
      schemaRegistry: registry,
    }))

    await schema.table('users', (table) => {
      table.string('email')
      table.dropColumn('nickname')
    })

    const updated = registry.get('users')
    expect(updated?.columns).toHaveProperty('email')
    expect(updated?.columns).not.toHaveProperty('nickname')
    expect(updated?.indexes).toEqual([])
    expect(adapter.executed).toEqual([
      'ALTER TABLE "users" ADD COLUMN "email" VARCHAR(255) NOT NULL',
      'ALTER TABLE "users" DROP COLUMN "nickname"',
    ])
  })

  it('fails fast on incomplete foreign-key mutation chains', async () => {
    const adapter = new SchemaAdapter({
      tables: ['users'],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {} })
    const schema = createSchemaService(createDatabase({
      adapter,
      dialect: createPostgresDialect(),
      schemaRegistry: createSchemaRegistry() }))

    await expect(schema.table('users', (table) => {
      table.foreign('team_id').references('id')
    })).rejects.toThrow('Foreign key table must not be empty.')

    await expect(schema.table('users', (table) => {
      table.foreign('team_id').on('teams')
    })).rejects.toThrow('Foreign key column must be a valid SQL identifier segment.')

    await expect(schema.table('users', (table) => {
      table.foreignId('team_id').references('id')
    })).rejects.toThrow('Foreign key table must not be empty.')

    await expect(schema.table('users', (table) => {
      table.foreignId('team_id').cascadeOnDelete()
    })).rejects.toThrow('Foreign key table must not be empty.')
  })

  it('fails fast on incomplete foreign-key create-table chains', async () => {
    const adapter = new SchemaAdapter({
      tables: [],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {} })
    const schema = createSchemaService(createDatabase({
      adapter,
      dialect: createPostgresDialect(),
      schemaRegistry: createSchemaRegistry() }))

    await expect(schema.createTable('users', (table) => {
      table.bigInteger('team_id')
      table.foreign('team_id').references('id')
    })).rejects.toThrow('Column "team_id" defines a foreign key column "id" but no foreign key table.')

    await expect(schema.createTable('users', (table) => {
      table.foreignId('team_id').references('id')
    })).rejects.toThrow('Column "team_id" defines a foreign key column "id" but no foreign key table.')

    await expect(schema.createTable('users', (table) => {
      table.foreignId('team_id').cascadeOnDelete()
    })).rejects.toThrow('Column "team_id" defines a foreign key column "id" but no foreign key table.')
  })

  it('enables, disables, and scopes foreign key constraints per dialect', async () => {
    const sqliteAdapter = new SchemaAdapter({ tables: [], columns: {}, indexes: {}, indexColumns: {}, foreignKeys: {} })
    const postgresAdapter = new SchemaAdapter({ tables: [], columns: {}, indexes: {}, indexColumns: {}, foreignKeys: {} })
    const mysqlAdapter = new SchemaAdapter({ tables: [], columns: {}, indexes: {}, indexColumns: {}, foreignKeys: {} })

    const sqliteSchema = createSchemaService(createDatabase({ adapter: sqliteAdapter, dialect: createSqliteDialect() }))
    const postgresSchema = createSchemaService(createDatabase({ adapter: postgresAdapter, dialect: createPostgresDialect() }))
    const mysqlSchema = createSchemaService(createDatabase({ adapter: mysqlAdapter, dialect: createMySqlDialect() }))

    await sqliteSchema.disableForeignKeyConstraints()
    await sqliteSchema.enableForeignKeyConstraints()
    await sqliteSchema.withoutForeignKeyConstraints(async () => {
      sqliteAdapter.executed.push('inside scoped foreign-key toggle')
    })

    await postgresSchema.disableForeignKeyConstraints()
    await postgresSchema.enableForeignKeyConstraints()

    await mysqlSchema.disableForeignKeyConstraints()
    await mysqlSchema.enableForeignKeyConstraints()

    expect(sqliteAdapter.executed).toEqual([
      'PRAGMA foreign_keys = OFF',
      'PRAGMA foreign_keys = ON',
      'PRAGMA foreign_keys = OFF',
      'inside scoped foreign-key toggle',
      'PRAGMA foreign_keys = ON',
    ])
    expect(postgresAdapter.executed).toEqual([
      'SET session_replication_role = \'replica\'',
      'SET session_replication_role = \'origin\'',
    ])
    expect(mysqlAdapter.executed).toEqual([
      'SET FOREIGN_KEY_CHECKS = 0',
      'SET FOREIGN_KEY_CHECKS = 1',
    ])
  })

  it('re-enables foreign key constraints after scoped callbacks throw and fails closed for unsupported dialects', async () => {
    const sqliteAdapter = new SchemaAdapter({ tables: [], columns: {}, indexes: {}, indexColumns: {}, foreignKeys: {} })
    const sqliteSchema = createSchemaService(createDatabase({ adapter: sqliteAdapter, dialect: createSqliteDialect() }))

    await expect(sqliteSchema.withoutForeignKeyConstraints(async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')

    expect(sqliteAdapter.executed).toEqual([
      'PRAGMA foreign_keys = OFF',
      'PRAGMA foreign_keys = ON',
    ])

    const unsupportedSchema = createSchemaService(createDatabase({
      adapter: new SchemaAdapter({ tables: [], columns: {}, indexes: {}, indexColumns: {}, foreignKeys: {} }),
      dialect: {
        ...createSqliteDialect(),
        name: 'oracle' } }))

    await expect(unsupportedSchema.disableForeignKeyConstraints()).rejects.toThrow(
      'SchemaService does not support foreign key constraint toggles for dialect "oracle".',
    )
  })

  it('introspects tables, columns, indexes, and foreign keys for sqlite', async () => {
    const adapter = new SchemaAdapter({
      tables: ['users'],
      columns: {
        users: [
          { name: 'id', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 1 },
          { name: 'email', type: 'TEXT', notnull: 1, dflt_value: '\'x\'', pk: 0 },
        ] },
      indexes: {
        users: [{ name: 'users_email_unique', unique: 1 }] },
      indexColumns: {
        users_email_unique: [{ name: 'email' }] },
      foreignKeys: {
        users: [{ table: 'teams', from: 'team_id', to: 'id', on_update: 'CASCADE', on_delete: 'SET NULL' }] } })
    const db = createDatabase({
      adapter,
      dialect: createSqliteDialect() })
    const schema = createSchemaService(db)

    expect(await schema.getTables()).toEqual(['users'])
    expect(await schema.getColumns('users')).toEqual([
      { name: 'id', type: 'INTEGER', logicalType: 'integer', notNull: true, defaultValue: null, primaryKey: true },
      { name: 'email', type: 'TEXT', logicalType: 'text', notNull: true, defaultValue: '\'x\'', primaryKey: false },
    ])
    expect(await schema.getIndexes('users')).toEqual([
      { name: 'users_email_unique', unique: true, columns: ['email'] },
    ])
    expect(await schema.getForeignKeys('users')).toEqual([
      { table: 'teams', from: 'team_id', to: 'id', onUpdate: 'CASCADE', onDelete: 'SET NULL' },
    ])
  })

  it('uses dedicated introspection hooks when the adapter provides them and falls back to query otherwise', async () => {
    const dedicatedAdapter = new SchemaAdapter({
      tables: ['users'],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {} }, {
      dedicatedIntrospection: true })
    const dedicatedSchema = createSchemaService(createDatabase({
      adapter: dedicatedAdapter,
      dialect: createSqliteDialect() }))

    expect(await dedicatedSchema.getTables()).toEqual(['users'])
    expect(dedicatedAdapter.introspected).toEqual([
      'SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name',
    ])
    expect(dedicatedAdapter.queried).toEqual([])

    const fallbackAdapter = new SchemaAdapter({
      tables: ['users'],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {} })
    const fallbackSchema = createSchemaService(createDatabase({
      adapter: fallbackAdapter,
      dialect: createSqliteDialect() }))

    expect(await fallbackSchema.getTables()).toEqual(['users'])
    expect(fallbackAdapter.introspected).toEqual([])
    expect(fallbackAdapter.queried).toEqual([
      'SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name',
    ])
  })

  it('uses the configured schema name for MySQL introspection when provided', async () => {
    const adapter = new SchemaAdapter({
      tables: [],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {},
      mysqlTables: [{ name: 'users' }],
      mysqlColumns: {
        users: [
          { name: 'id', type: 'bigint', is_nullable: 'NO', default_value: null, column_key: 'PRI' },
        ] },
      mysqlIndexes: {
        users: [
          { name: 'users_email_unique', non_unique: 0, column_name: 'email' },
        ] },
      mysqlForeignKeys: {
        users: [
          { table_name: 'teams', from_column: 'team_id', to_column: 'id', on_update: 'CASCADE', on_delete: 'SET NULL' },
        ] } })
    const schema = createSchemaService(createDatabase({
      adapter,
      dialect: createMySqlDialect(),
      schemaName: 'analytics' }))

    expect(await schema.getTables()).toEqual(['users'])
    expect(await schema.getColumns('users')).toEqual([
      { name: 'id', type: 'bigint', logicalType: 'bigInteger', notNull: true, defaultValue: null, primaryKey: true },
    ])
    expect(await schema.getIndexes('users')).toEqual([
      { name: 'users_email_unique', unique: true, columns: ['email'] },
    ])
    expect(await schema.getForeignKeys('users')).toEqual([
      { table: 'teams', from: 'team_id', to: 'id', onUpdate: 'CASCADE', onDelete: 'SET NULL' },
    ])
    expect(adapter.queryCalls).toContainEqual({
      sql: 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name',
      bindings: ['analytics'] })
    expect(adapter.queryCalls).toContainEqual({
      sql: 'SELECT column_name AS name, data_type AS type, is_nullable AS is_nullable, column_default AS default_value, column_key AS column_key FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position',
      bindings: ['analytics', 'users'] })
    expect(adapter.queryCalls).toContainEqual({
      sql: 'SELECT index_name AS name, non_unique AS non_unique, column_name AS column_name FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? ORDER BY index_name, seq_in_index',
      bindings: ['analytics', 'users'] })
    expect(adapter.queryCalls).toContainEqual({
      sql: 'SELECT referenced_table_name AS table_name, column_name AS from_column, referenced_column_name AS to_column, update_rule AS on_update, delete_rule AS on_delete FROM information_schema.key_column_usage kcu JOIN information_schema.referential_constraints rc ON rc.constraint_name = kcu.constraint_name AND rc.constraint_schema = kcu.table_schema WHERE kcu.table_schema = ? AND kcu.table_name = ? AND kcu.referenced_table_name IS NOT NULL ORDER BY kcu.ordinal_position',
      bindings: ['analytics', 'users'] })
  })

  it('rejects malformed runtime table identifiers for schema-service operations', async () => {
    const adapter = new SchemaAdapter({
      tables: ['users'],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {} })
    const db = createDatabase({
      adapter,
      dialect: createSqliteDialect(),
      schemaRegistry: createSchemaRegistry() })
    const schema = createSchemaService(db)
    const postgresSchema = createSchemaService(createDatabase({
      adapter: new SchemaAdapter({ tables: ['users'], columns: {}, indexes: {}, indexColumns: {}, foreignKeys: {}, postgresColumns: { users: [] } }),
      dialect: createPostgresDialect(),
      schemaRegistry: createSchemaRegistry() }))

    await expect(schema.hasTable('users;drop')).rejects.toThrow(
      'Table name must be a valid SQL identifier segment.',
    )
    await expect(schema.getColumns('public..users')).rejects.toThrow(
      'Table name must not contain empty identifier segments.',
    )
    await expect(schema.getIndexes('users bad')).rejects.toThrow(
      'Table name must be a valid SQL identifier segment.',
    )
    await expect(schema.getForeignKeys('users-bad')).rejects.toThrow(
      'Table name must be a valid SQL identifier segment.',
    )
    await expect(schema.dropTable('users;drop')).rejects.toThrow(
      'Table name must be a valid SQL identifier segment.',
    )
    await expect(schema.renameTable('users', 'users bad')).rejects.toThrow(
      'Table name must be a valid SQL identifier segment.',
    )
    await expect(schema.table('users bad', (table) => {
      table.index(['email'])
    })).rejects.toThrow(
      'Table name must be a valid SQL identifier segment.',
    )
    await expect(schema.table('users', (table) => {
      table.dropIndex('users bad')
    })).rejects.toThrow('Index name must be a valid SQL identifier segment.')
    await expect(schema.table('users', (table) => {
      table.renameIndex('users_email_index', 'users bad')
    })).rejects.toThrow(
      'SchemaService does not support renaming indexes for dialect "sqlite".',
    )
    await expect(postgresSchema.table('users', (table) => {
      table.string('display name')
    })).rejects.toThrow(
      'Column name must be a valid SQL identifier segment.',
    )
    await expect(schema.table('users', (table) => {
      table.dropColumn('display name')
    })).rejects.toThrow(
      'SchemaService does not support dropping columns for dialect "sqlite".',
    )
    await expect(postgresSchema.table('users', (table) => {
      table.renameColumn('display-name', 'display_name')
    })).rejects.toThrow(
      'Column name must be a valid SQL identifier segment.',
    )
    await expect(postgresSchema.table('users', (table) => {
      table.string('display name').change()
    })).rejects.toThrow(
      'Column name must be a valid SQL identifier segment.',
    )
    await expect(postgresSchema.table('users', (table) => {
      table.foreign('team-id').references('id').on('teams')
    })).rejects.toThrow(
      'Foreign key column must be a valid SQL identifier segment.',
    )
    await expect(postgresSchema.table('users', (table) => {
      table.dropForeign('users team foreign')
    })).rejects.toThrow(
      'Foreign key name must be a valid SQL identifier segment.',
    )
  })

  it('introspects tables, columns, indexes, and foreign keys for Postgres and MySQL', async () => {
    const postgresDb = createDatabase({
      adapter: new SchemaAdapter({
        tables: [],
        columns: {},
        indexes: {},
        indexColumns: {},
        foreignKeys: {},
        postgresTables: [{ name: 'users' }],
        postgresColumns: {
          users: [
            { name: 'id', type: 'bigint', is_nullable: 'NO', default_value: null, primary_key: true },
            { name: 'email', type: 'character varying', is_nullable: 'YES', default_value: '\'x\'', primary_key: false },
          ] },
        postgresIndexes: {
          users: [
            { name: 'users_email_unique', definition: 'CREATE UNIQUE INDEX users_email_unique ON public.users USING btree (email)' },
            { name: 'users_skipped', definition: 'malformed definition' },
          ] },
        postgresForeignKeys: {
          users: [
            { table_name: 'teams', from_column: 'team_id', to_column: 'id', on_update: 'CASCADE', on_delete: 'SET NULL' },
          ] } }),
      dialect: createPostgresDialect() })
    const mysqlDb = createDatabase({
      adapter: new SchemaAdapter({
        tables: [],
        columns: {},
        indexes: {},
        indexColumns: {},
        foreignKeys: {},
        mysqlTables: [{ name: 'users' }],
        mysqlColumns: {
          users: [
            { name: 'id', type: 'bigint', is_nullable: 'NO', default_value: null, column_key: 'PRI' },
            { name: 'email', type: 'varchar', is_nullable: 'YES', default_value: '\'x\'', column_key: '' },
          ] },
        mysqlIndexes: {
          users: [
            { name: 'users_email_unique', non_unique: 0, column_name: 'email' },
            { name: 'users_name_idx', non_unique: 1, column_name: 'first_name' },
            { name: 'users_name_idx', non_unique: 1, column_name: 'last_name' },
          ] },
        mysqlForeignKeys: {
          users: [
            { table_name: 'teams', from_column: 'team_id', to_column: 'id', on_update: 'CASCADE', on_delete: 'SET NULL' },
          ] } }),
      dialect: createMySqlDialect() })

    const postgresSchema = createSchemaService(postgresDb)
    const mysqlSchema = createSchemaService(mysqlDb)

    expect(await postgresSchema.getTables()).toEqual(['users'])
    expect(await postgresSchema.getColumns('users')).toEqual([
      { name: 'id', type: 'bigint', logicalType: 'bigInteger', notNull: true, defaultValue: null, primaryKey: true },
      { name: 'email', type: 'character varying', logicalType: 'string', notNull: false, defaultValue: '\'x\'', primaryKey: false },
    ])
    expect(await postgresSchema.getIndexes('users')).toEqual([
      { name: 'users_email_unique', unique: true, columns: ['email'] },
    ])
    expect(await postgresSchema.getForeignKeys('users')).toEqual([
      { table: 'teams', from: 'team_id', to: 'id', onUpdate: 'CASCADE', onDelete: 'SET NULL' },
    ])

    expect(await mysqlSchema.getTables()).toEqual(['users'])
    expect(await mysqlSchema.getColumns('users')).toEqual([
      { name: 'id', type: 'bigint', logicalType: 'bigInteger', notNull: true, defaultValue: null, primaryKey: true },
      { name: 'email', type: 'varchar', logicalType: 'string', notNull: false, defaultValue: '\'x\'', primaryKey: false },
    ])
    expect(await mysqlSchema.getIndexes('users')).toEqual([
      { name: 'users_email_unique', unique: true, columns: ['email'] },
      { name: 'users_name_idx', unique: false, columns: ['first_name', 'last_name'] },
    ])
    expect(await mysqlSchema.getForeignKeys('users')).toEqual([
      { table: 'teams', from: 'team_id', to: 'id', onUpdate: 'CASCADE', onDelete: 'SET NULL' },
    ])

    await expect(postgresSchema.createTable('users', (table) => {
      table.id()
      table.boolean('active').default(true)
    })).resolves.toBeUndefined()
    await expect(mysqlSchema.createTable('users', (table) => {
      table.id()
      table.boolean('active').default(true)
    })).resolves.toBeUndefined()
    await expect(mysqlSchema.dropTable('users')).resolves.toBeUndefined()
  })

  it('uses the configured schema name when introspecting Postgres tables', async () => {
    const adapter = new SchemaAdapter({
      tables: [],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {},
      postgresTables: [{ name: 'users' }],
    })
    const schema = createSchemaService(createDatabase({
      adapter,
      dialect: createPostgresDialect(),
      schemaName: 'tenant_app',
    }))

    expect(await schema.getTables()).toEqual(['users'])
    expect(adapter.queryCalls).toContainEqual({
      sql: 'SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = $1 ORDER BY tablename',
      bindings: ['tenant_app'],
    })
  })

  it('maps physical introspection types back to logical Holo column families where that mapping is safe', async () => {
    const sqliteSchema = createSchemaService(createDatabase({
      adapter: new SchemaAdapter({
        tables: ['users'],
        columns: {
          users: [
            { name: 'active', type: 'INTEGER', notnull: 1, dflt_value: '1', pk: 0 },
            { name: 'payload', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
            { name: 'scheduled_at', type: 'TIME', notnull: 0, dflt_value: null, pk: 0 },
            { name: 'legacy_counter', type: 'UNSIGNED BIG INT', notnull: 1, dflt_value: null, pk: 0 },
          ] },
        indexes: {},
        indexColumns: {},
        foreignKeys: {} }),
      dialect: createSqliteDialect() }))
    const postgresSchema = createSchemaService(createDatabase({
      adapter: new SchemaAdapter({
        tables: [],
        columns: {},
        indexes: {},
        indexColumns: {},
        foreignKeys: {},
        postgresTables: [{ name: 'users' }],
        postgresColumns: {
          users: [
            { name: 'settings', type: 'jsonb', is_nullable: 'NO', default_value: null, primary_key: false },
            { name: 'public_id', type: 'uuid', is_nullable: 'NO', default_value: null, primary_key: false },
            { name: 'embedding', type: 'vector(1536)', is_nullable: 'NO', default_value: null, primary_key: false },
            { name: 'legacy_unknown', type: '   ', is_nullable: 'YES', default_value: null, primary_key: false },
          ] } }),
      dialect: createPostgresDialect() }))
    const mysqlSchema = createSchemaService(createDatabase({
      adapter: new SchemaAdapter({
        tables: [],
        columns: {},
        indexes: {},
        indexColumns: {},
        foreignKeys: {},
        mysqlTables: [{ name: 'users' }],
        mysqlColumns: {
          users: [
            { name: 'active', type: 'tinyint', is_nullable: 'NO', default_value: '1', column_key: '' },
            { name: 'settings', type: 'json', is_nullable: 'YES', default_value: null, column_key: '' },
            { name: 'status', type: 'enum(\'draft\',\'published\')', is_nullable: 'NO', default_value: '\'draft\'', column_key: '' },
          ] } }),
      dialect: createMySqlDialect() }))

    expect(await sqliteSchema.getColumns('users')).toEqual([
      { name: 'active', type: 'INTEGER', logicalType: 'integer', notNull: true, defaultValue: '1', primaryKey: false },
      { name: 'payload', type: 'TEXT', logicalType: 'text', notNull: false, defaultValue: null, primaryKey: false },
      { name: 'scheduled_at', type: 'TIME', logicalType: 'string', notNull: false, defaultValue: null, primaryKey: false },
      { name: 'legacy_counter', type: 'UNSIGNED BIG INT', logicalType: 'integer', notNull: true, defaultValue: null, primaryKey: false },
    ])
    expect(await postgresSchema.getColumns('users')).toEqual([
      { name: 'settings', type: 'jsonb', logicalType: 'json', notNull: true, defaultValue: null, primaryKey: false },
      { name: 'public_id', type: 'uuid', logicalType: 'uuid', notNull: true, defaultValue: null, primaryKey: false },
      { name: 'embedding', type: 'vector(1536)', logicalType: 'vector', notNull: true, defaultValue: null, primaryKey: false },
      { name: 'legacy_unknown', type: '   ', logicalType: null, notNull: false, defaultValue: null, primaryKey: false },
    ])
    expect(await mysqlSchema.getColumns('users')).toEqual([
      { name: 'active', type: 'tinyint', logicalType: 'boolean', notNull: true, defaultValue: '1', primaryKey: false },
      { name: 'settings', type: 'json', logicalType: 'json', notNull: false, defaultValue: null, primaryKey: false },
      { name: 'status', type: 'enum(\'draft\',\'published\')', logicalType: 'enum', notNull: true, defaultValue: '\'draft\'', primaryKey: false },
    ])
  })

  it('fails closed for completely unsupported schema dialects', async () => {
    const db = createDatabase({
      adapter: new SchemaAdapter({
        tables: [],
        columns: {},
        indexes: {},
        indexColumns: {},
        foreignKeys: {} }),
      dialect: {
        ...createSqliteDialect(),
        name: 'oracle' } })
    const schema = createSchemaService(db)

    await expect(schema.createTable('users', (table) => {
      table.id()
    })).rejects.toThrow('SchemaService does not support dialect "oracle".')
    await expect(schema.getTables()).rejects.toThrow('SchemaService does not support introspection for dialect "oracle".')
    await expect(schema.getColumns('users')).rejects.toThrow('SchemaService does not support introspection for dialect "oracle".')
    await expect(schema.getIndexes('users')).rejects.toThrow('SchemaService does not support introspection for dialect "oracle".')
    await expect(schema.getForeignKeys('users')).rejects.toThrow('SchemaService does not support introspection for dialect "oracle".')
  })

  it('requires a table-definition callback when creating tables through the public schema API', async () => {
    const schema = createSchemaService(createDatabase({
      adapter: new SchemaAdapter({ tables: [], columns: {}, indexes: {}, indexColumns: {}, foreignKeys: {} }),
      dialect: createSqliteDialect() }))

    const createTableWithoutCallback = schema.createTable.bind(schema) as unknown as (tableName: string) => Promise<void>
    await expect(createTableWithoutCallback('users')).rejects.toThrow(
      'SchemaService.createTable(name, callback) requires a table-definition callback.',
    )
  })

  it('supports multiple contexts reusing the same table definitions without schema leakage', async () => {
    const users = defineTable('users', {
      id: column.id(),
      email: column.string().unique(),
      active: column.boolean().default(true) })

    const firstAdapter = new SchemaAdapter({
      tables: [],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {} })
    const secondAdapter = new SchemaAdapter({
      tables: [],
      columns: {},
      indexes: {},
      indexColumns: {},
      foreignKeys: {} })

    const firstDb = createDatabase({
      connectionName: 'first',
      adapter: firstAdapter,
      dialect: createSqliteDialect() })
    const secondDb = createDatabase({
      connectionName: 'second',
      adapter: secondAdapter,
      dialect: createSqliteDialect() })

    firstDb.getSchemaRegistry().register(users)
    secondDb.getSchemaRegistry().register(users)

    const firstSchema = createSchemaService(firstDb)
    const secondSchema = createSchemaService(secondDb)

    await firstSchema.sync()

    expect(await firstSchema.hasTable('users')).toBe(true)
    expect(await secondSchema.hasTable('users')).toBe(false)
    expect(firstDb.getSchemaRegistry().get('users')).toBe(users)
    expect(secondDb.getSchemaRegistry().get('users')).toBe(users)
    expect(firstDb.getSchemaRegistry()).not.toBe(secondDb.getSchemaRegistry())

    await secondSchema.createTable('users', (table) => {
      table.id()
      table.string('email').unique()
      table.boolean('active').default(true)
    })

    expect(firstAdapter.executed.filter(sql => sql.startsWith('CREATE TABLE'))).toHaveLength(1)
    expect(secondAdapter.executed.filter(sql => sql.startsWith('CREATE TABLE'))).toHaveLength(1)
  })
})
