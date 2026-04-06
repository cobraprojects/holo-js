import { CapabilityError } from '../core/errors'
import { addColumnOperation, alterColumnOperation, createForeignKeyOperation, createIndexOperation, createTableOperation, dropColumnOperation, dropForeignKeyOperation, dropIndexOperation, dropTableOperation, renameColumnOperation, renameIndexOperation, renameTableOperation } from './ddl'
import { defineTable } from './defineTable'
import { assertValidIdentifierPath, assertValidIdentifierSegment } from './identifiers'
import { SQLiteSchemaCompiler } from './SQLiteSchemaCompiler'
import { PostgresSchemaCompiler } from './PostgresSchemaCompiler'
import { MySQLSchemaCompiler } from './MySQLSchemaCompiler'
import { TableDefinitionBuilder } from './TableDefinitionBuilder'
import { TableMutationBuilder } from './TableMutationBuilder'
import type { AnyColumnBuilder } from './columns'
import type { SQLSchemaCompiler } from './SQLSchemaCompiler'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { AnyColumnDefinition, ForeignKeyReference, LogicalColumnKind, TableDefinition, TableIndexDefinition } from './types'

export interface IntrospectedColumn {
  name: string
  type: string
  logicalType: LogicalColumnKind | null
  notNull: boolean
  defaultValue: string | null
  primaryKey: boolean
}

export interface IntrospectedIndex {
  name: string
  unique: boolean
  columns: string[]
}

export interface IntrospectedForeignKey {
  table: string
  from: string
  to: string
  onUpdate: string
  onDelete: string
}

export interface SchemaSyncPlan {
  readonly mode: 'create_missing_only'
  readonly tablesToCreate: readonly string[]
  readonly existingTables: readonly string[]
  readonly destructiveChanges: false
}

type SQLiteTableRow = {
  name: string
}

type SQLiteColumnRow = {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

type SQLiteIndexRow = {
  name: string
  unique: number
}

type SQLiteIndexInfoRow = {
  name: string
}

type SQLiteForeignKeyRow = {
  table: string
  from: string
  to: string
  on_update: string
  on_delete: string
}

type PostgresColumnRow = {
  name: string
  type: string
  is_nullable: 'YES' | 'NO'
  default_value: string | null
  primary_key: boolean
}

type PostgresIndexRow = {
  name: string
  definition: string
}

type PostgresForeignKeyRow = {
  table_name: string
  from_column: string
  to_column: string
  on_update: string
  on_delete: string
}

type MySQLColumnRow = {
  name: string
  type: string
  is_nullable: 'YES' | 'NO'
  default_value: string | null
  column_key: string
}

type MySQLIndexRow = {
  name: string
  non_unique: number
  column_name: string
}

type MySQLForeignKeyRow = {
  table_name: string
  from_column: string
  to_column: string
  on_update: string
  on_delete: string
}

export class SchemaService {
  constructor(private readonly connection: DatabaseContext) {}

  getDialectName(): string {
    return this.connection.getDialect().name
  }

  register<TTable extends TableDefinition>(table: TTable): TTable {
    return this.connection.getSchemaRegistry().register(table)
  }

  async createTable<TName extends string>(
    tableName: TName,
    callback: (table: TableDefinitionBuilder<TName>) => void | Promise<void>,
  ): Promise<void> {
    const table = await this.buildTableDefinition(tableName, callback)
    await this.createDefinedTable(table)
  }

  async dropTable(tableName: string): Promise<void> {
    assertValidIdentifierPath(tableName, 'Table name')
    await this.execute(this.createCompiler().compile(dropTableOperation(tableName)))
    this.connection.getSchemaRegistry().delete(tableName)
  }

  async renameTable(
    fromTableName: string,
    toTableName: string,
  ): Promise<void> {
    assertValidIdentifierPath(fromTableName, 'Table name')
    assertValidIdentifierPath(toTableName, 'Table name')
    await this.execute(this.createCompiler().compile(renameTableOperation(fromTableName, toTableName)))
    this.renameRegisteredTable(fromTableName, toTableName)
  }

  async table(
    tableName: string,
    callback: (table: TableMutationBuilder) => void | Promise<void>,
  ): Promise<void> {
    assertValidIdentifierPath(tableName, 'Table name')
    const builder = new TableMutationBuilder(tableName)
    await callback(builder)

    for (const operation of builder.getOperations()) {
      await this.executeTableMutation(tableName, operation)
    }
  }

  async enableForeignKeyConstraints(): Promise<void> {
    await this.connection.executeCompiled(this.createForeignKeyConstraintStatement(true))
  }

  async disableForeignKeyConstraints(): Promise<void> {
    await this.connection.executeCompiled(this.createForeignKeyConstraintStatement(false))
  }

  async withoutForeignKeyConstraints<TResult>(
    callback: () => TResult | Promise<TResult>,
  ): Promise<TResult> {
    await this.disableForeignKeyConstraints()
    try {
      return await callback()
    } finally {
      await this.enableForeignKeyConstraints()
    }
  }

  async sync(tables?: readonly TableDefinition[]): Promise<void> {
    const plan = await this.previewSync(tables)
    const tableMap = new Map((tables ?? this.connection.getSchemaRegistry().list()).map(table => [table.tableName, table]))

    for (const tableName of plan.tablesToCreate) {
      const table = tableMap.get(tableName)
      if (table) {
        await this.createDefinedTable(table)
      }
    }
  }

  async previewSync(tables?: readonly TableDefinition[]): Promise<SchemaSyncPlan> {
    const toSync = tables ?? this.connection.getSchemaRegistry().list()
    const existingTables = await this.getTables()
    const existingSet = new Set(existingTables)

    return {
      mode: 'create_missing_only',
      tablesToCreate: toSync
        .map(table => table.tableName)
        .filter(tableName => !existingSet.has(tableName)),
      existingTables,
      destructiveChanges: false,
    }
  }

  async hasTable(name: string): Promise<boolean> {
    assertValidIdentifierPath(name, 'Table name')
    const tables = await this.getTables()
    return tables.includes(name)
  }

  async getTables(): Promise<string[]> {
    if (this.isSqlite()) {
      const result = await this.connection.introspectCompiled<SQLiteTableRow>({
        sql: 'SELECT name FROM sqlite_master WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name',
        source: 'schema:introspect:tables',
      })
      return result.rows.map(row => row.name).sort()
    }

    if (this.isPostgres()) {
      const schemaName = this.connection.getSchemaName() ?? 'public'
      const result = await this.connection.introspectCompiled<SQLiteTableRow>({
        sql: 'SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = $1 ORDER BY tablename',
        bindings: [schemaName],
        source: 'schema:introspect:tables',
      })
      return result.rows.map(row => row.name).sort()
    }

    if (this.isMySQL()) {
      const schemaName = this.connection.getSchemaName()
      const result = await this.connection.introspectCompiled<SQLiteTableRow>({
        sql: schemaName
          ? 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name'
          : 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name',
        bindings: schemaName ? [schemaName] : undefined,
        source: 'schema:introspect:tables',
      })
      return result.rows.map(row => row.name).sort()
    }

    throw this.unsupportedIntrospectionError()
  }

  async getColumns(tableName: string): Promise<IntrospectedColumn[]> {
    assertValidIdentifierPath(tableName, 'Table name')
    if (this.isSqlite()) {
      const result = await this.connection.introspectCompiled<SQLiteColumnRow>({
        sql: `PRAGMA table_info(${this.connection.getDialect().quoteIdentifier(tableName)})`,
        source: `schema:introspect:columns:${tableName}`,
      })
      return result.rows.map(row => ({
        name: row.name,
        type: row.type,
        logicalType: this.inferLogicalColumnType(row.type, 'sqlite'),
        notNull: row.notnull === 1,
        defaultValue: row.dflt_value,
        primaryKey: row.pk === 1,
      }))
    }

    if (this.isPostgres()) {
      const result = await this.connection.introspectCompiled<PostgresColumnRow>({
        sql: 'SELECT c.column_name AS name, c.data_type AS type, c.is_nullable AS is_nullable, c.column_default AS default_value, EXISTS (SELECT 1 FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.table_schema = \'public\' AND tc.table_name = c.table_name AND tc.constraint_type = \'PRIMARY KEY\' AND kcu.column_name = c.column_name) AS primary_key FROM information_schema.columns c WHERE c.table_schema = \'public\' AND c.table_name = $1 ORDER BY c.ordinal_position',
        bindings: [tableName],
        source: `schema:introspect:columns:${tableName}`,
      })
      return result.rows.map(row => ({
        name: row.name,
        type: row.type,
        logicalType: this.inferLogicalColumnType(row.type, 'postgres'),
        notNull: row.is_nullable === 'NO',
        defaultValue: row.default_value,
        primaryKey: row.primary_key,
      }))
    }

    if (this.isMySQL()) {
      const schemaName = this.connection.getSchemaName()
      const result = await this.connection.introspectCompiled<MySQLColumnRow>({
        sql: schemaName
          ? 'SELECT column_name AS name, data_type AS type, is_nullable AS is_nullable, column_default AS default_value, column_key AS column_key FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position'
          : 'SELECT column_name AS name, data_type AS type, is_nullable AS is_nullable, column_default AS default_value, column_key AS column_key FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position',
        bindings: schemaName ? [schemaName, tableName] : [tableName],
        source: `schema:introspect:columns:${tableName}`,
      })
      return result.rows.map(row => ({
        name: row.name,
        type: row.type,
        logicalType: this.inferLogicalColumnType(row.type, 'mysql'),
        notNull: row.is_nullable === 'NO',
        defaultValue: row.default_value,
        primaryKey: row.column_key === 'PRI',
      }))
    }

    throw this.unsupportedIntrospectionError()
  }

  async getIndexes(tableName: string): Promise<IntrospectedIndex[]> {
    assertValidIdentifierPath(tableName, 'Table name')
    if (this.isSqlite()) {
      const indexRows = await this.connection.introspectCompiled<SQLiteIndexRow>({
        sql: `PRAGMA index_list(${this.connection.getDialect().quoteIdentifier(tableName)})`,
        source: `schema:introspect:indexes:${tableName}`,
      })

      const indexes: IntrospectedIndex[] = []
      for (const row of indexRows.rows) {
        const columns = await this.connection.introspectCompiled<SQLiteIndexInfoRow>({
          sql: `PRAGMA index_info(${this.connection.getDialect().quoteIdentifier(row.name)})`,
          source: `schema:introspect:indexColumns:${tableName}:${row.name}`,
        })

        indexes.push({
          name: row.name,
          unique: row.unique === 1,
          columns: columns.rows.map(column => column.name),
        })
      }

      return indexes
    }

    if (this.isPostgres()) {
      const result = await this.connection.introspectCompiled<PostgresIndexRow>({
        sql: 'SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = \'public\' AND tablename = $1 ORDER BY indexname',
        bindings: [tableName],
        source: `schema:introspect:indexes:${tableName}`,
      })

      return result.rows.flatMap((row) => {
        const parsed = this.parsePostgresIndex(row)
        return parsed ? [parsed] : []
      })
    }

    if (this.isMySQL()) {
      const schemaName = this.connection.getSchemaName()
      const result = await this.connection.introspectCompiled<MySQLIndexRow>({
        sql: schemaName
          ? 'SELECT index_name AS name, non_unique AS non_unique, column_name AS column_name FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? ORDER BY index_name, seq_in_index'
          : 'SELECT index_name AS name, non_unique AS non_unique, column_name AS column_name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? ORDER BY index_name, seq_in_index',
        bindings: schemaName ? [schemaName, tableName] : [tableName],
        source: `schema:introspect:indexes:${tableName}`,
      })

      const grouped = new Map<string, IntrospectedIndex>()
      for (const row of result.rows) {
        const existing = grouped.get(row.name)
        if (existing) {
          existing.columns.push(row.column_name)
          continue
        }

        grouped.set(row.name, {
          name: row.name,
          unique: row.non_unique === 0,
          columns: [row.column_name],
        })
      }

      return [...grouped.values()]
    }

    throw this.unsupportedIntrospectionError()
  }

  async getForeignKeys(tableName: string): Promise<IntrospectedForeignKey[]> {
    assertValidIdentifierPath(tableName, 'Table name')
    if (this.isSqlite()) {
      const result = await this.connection.introspectCompiled<SQLiteForeignKeyRow>({
        sql: `PRAGMA foreign_key_list(${this.connection.getDialect().quoteIdentifier(tableName)})`,
        source: `schema:introspect:foreignKeys:${tableName}`,
      })

      return result.rows.map(row => ({
        table: row.table,
        from: row.from,
        to: row.to,
        onUpdate: row.on_update,
        onDelete: row.on_delete,
      }))
    }

    if (this.isPostgres()) {
      const result = await this.connection.introspectCompiled<PostgresForeignKeyRow>({
        sql: 'SELECT ccu.table_name AS table_name, kcu.column_name AS from_column, ccu.column_name AS to_column, rc.update_rule AS on_update, rc.delete_rule AS on_delete FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema WHERE tc.constraint_type = \'FOREIGN KEY\' AND tc.table_schema = \'public\' AND tc.table_name = $1 ORDER BY kcu.ordinal_position',
        bindings: [tableName],
        source: `schema:introspect:foreignKeys:${tableName}`,
      })

      return result.rows.map(row => ({
        table: row.table_name,
        from: row.from_column,
        to: row.to_column,
        onUpdate: row.on_update,
        onDelete: row.on_delete,
      }))
    }

    if (this.isMySQL()) {
      const schemaName = this.connection.getSchemaName()
      const result = await this.connection.introspectCompiled<MySQLForeignKeyRow>({
        sql: schemaName
          ? 'SELECT referenced_table_name AS table_name, column_name AS from_column, referenced_column_name AS to_column, update_rule AS on_update, delete_rule AS on_delete FROM information_schema.key_column_usage kcu JOIN information_schema.referential_constraints rc ON rc.constraint_name = kcu.constraint_name AND rc.constraint_schema = kcu.table_schema WHERE kcu.table_schema = ? AND kcu.table_name = ? AND kcu.referenced_table_name IS NOT NULL ORDER BY kcu.ordinal_position'
          : 'SELECT referenced_table_name AS table_name, column_name AS from_column, referenced_column_name AS to_column, update_rule AS on_update, delete_rule AS on_delete FROM information_schema.key_column_usage kcu JOIN information_schema.referential_constraints rc ON rc.constraint_name = kcu.constraint_name AND rc.constraint_schema = kcu.table_schema WHERE kcu.table_schema = DATABASE() AND kcu.table_name = ? AND kcu.referenced_table_name IS NOT NULL ORDER BY kcu.ordinal_position',
        bindings: schemaName ? [schemaName, tableName] : [tableName],
        source: `schema:introspect:foreignKeys:${tableName}`,
      })

      return result.rows.map(row => ({
        table: row.table_name,
        from: row.from_column,
        to: row.to_column,
        onUpdate: row.on_update,
        onDelete: row.on_delete,
      }))
    }

    throw this.unsupportedIntrospectionError()
  }

  private createCompiler(): SQLSchemaCompiler {
    const quoteIdentifier = (identifier: string) => this.connection.getDialect().quoteIdentifier(identifier)
    const dialectName = this.connection.getDialect().name

    if (dialectName.startsWith('sqlite')) {
      return new SQLiteSchemaCompiler(quoteIdentifier)
    }

    if (dialectName.startsWith('postgres')) {
      return new PostgresSchemaCompiler(quoteIdentifier)
    }

    if (dialectName.startsWith('mysql')) {
      return new MySQLSchemaCompiler(quoteIdentifier)
    }

    throw new CapabilityError(
      `SchemaService does not support dialect "${dialectName}".`,
    )
  }

  private async execute(statements: readonly { sql: string, bindings?: readonly unknown[], source: string }[]): Promise<void> {
    for (const statement of statements) {
      await this.connection.executeCompiled(statement)
    }
  }

  private isSqlite(): boolean {
    return this.connection.getDialect().name.startsWith('sqlite')
  }

  private isPostgres(): boolean {
    return this.connection.getDialect().name.startsWith('postgres')
  }

  private isMySQL(): boolean {
    return this.connection.getDialect().name.startsWith('mysql')
  }

  private parsePostgresIndex(row: PostgresIndexRow): IntrospectedIndex | null {
    const unique = row.definition.includes('CREATE UNIQUE INDEX')
    const columnsMatch = row.definition.match(/\((.+)\)$/)
    if (!columnsMatch) {
      return null
    }

    return {
      name: row.name,
      unique,
      columns: columnsMatch[1]!.split(',').map(column => column.trim().replaceAll('"', '')),
    }
  }

  private unsupportedIntrospectionError(): CapabilityError {
    return new CapabilityError(
      `SchemaService does not support introspection for dialect "${this.connection.getDialect().name}".`,
    )
  }

  private assertAlterCapability(action: string): void {
    if (!this.connection.getCapabilities().ddlAlterSupport) {
      throw new CapabilityError(
        `SchemaService does not support ${action} for dialect "${this.connection.getDialect().name}".`,
      )
    }
  }

  private assertForeignKeyCapability(action: string): void {
    if (this.isSqlite() || !this.connection.getCapabilities().ddlAlterSupport) {
      throw new CapabilityError(
        `SchemaService does not support ${action} for dialect "${this.connection.getDialect().name}".`,
      )
    }
  }

  private resolveColumnDefinition(columnName: string, column: AnyColumnBuilder): AnyColumnDefinition {
    return column.toDefinition({ name: columnName })
  }

  private async createDefinedTable(table: TableDefinition): Promise<void> {
    if (!this.connection.getSchemaRegistry().has(table.tableName)) {
      this.register(table)
    }
    await this.execute(this.createCompiler().compile(createTableOperation(table)))
  }

  private async executeTableMutation(
    tableName: string,
    operation:
      | { kind: 'addColumn', columnName: string, column: AnyColumnBuilder }
      | { kind: 'alterColumn', columnName: string, column: AnyColumnBuilder }
      | { kind: 'dropColumn', columnName: string }
      | { kind: 'renameColumn', fromColumnName: string, toColumnName: string }
      | { kind: 'createIndex', index: TableIndexDefinition }
      | { kind: 'dropIndex', indexName: string }
      | { kind: 'renameIndex', fromIndexName: string, toIndexName: string }
      | { kind: 'createForeignKey', columnName: string, reference: ForeignKeyReference, constraintName?: string }
      | { kind: 'dropForeignKey', constraintName: string },
  ): Promise<void> {
    switch (operation.kind) {
      case 'addColumn': {
        this.assertAlterCapability('adding columns')
        const definition = this.resolveColumnDefinition(operation.columnName, operation.column)
        await this.execute(this.createCompiler().compile(addColumnOperation(tableName, definition)))
        this.updateRegisteredTable(tableName, table => this.withColumn(table, definition))
        return
      }
      case 'alterColumn': {
        this.assertAlterCapability('altering columns')
        const definition = this.resolveColumnDefinition(operation.columnName, operation.column)
        await this.execute(this.createCompiler().compile(alterColumnOperation(tableName, definition)))
        this.updateRegisteredTable(tableName, table => this.withAlteredColumn(table, definition))
        return
      }
      case 'dropColumn':
        this.assertAlterCapability('dropping columns')
        await this.execute(this.createCompiler().compile(dropColumnOperation(tableName, operation.columnName)))
        this.updateRegisteredTable(tableName, table => this.withoutColumn(table, operation.columnName))
        return
      case 'renameColumn':
        this.assertAlterCapability('renaming columns')
        await this.execute(this.createCompiler().compile(
          renameColumnOperation(tableName, operation.fromColumnName, operation.toColumnName),
        ))
        this.updateRegisteredTable(
          tableName,
          table => this.renameRegisteredColumn(table, operation.fromColumnName, operation.toColumnName),
        )
        return
      case 'createIndex':
        await this.execute(this.createCompiler().compile(createIndexOperation(tableName, operation.index)))
        this.updateRegisteredTable(tableName, table => this.withIndex(table, operation.index))
        return
      case 'dropIndex':
        await this.execute(this.createCompiler().compile(dropIndexOperation(tableName, operation.indexName)))
        this.updateRegisteredTable(tableName, table => this.withoutIndex(table, operation.indexName))
        return
      case 'renameIndex':
        if (this.isSqlite()) {
          throw new CapabilityError('SchemaService does not support renaming indexes for dialect "sqlite".')
        }
        await this.execute(this.createCompiler().compile(
          renameIndexOperation(tableName, operation.fromIndexName, operation.toIndexName),
        ))
        this.updateRegisteredTable(
          tableName,
          table => this.renameRegisteredIndex(table, operation.fromIndexName, operation.toIndexName),
        )
        return
      case 'createForeignKey':
        this.assertForeignKeyCapability('adding foreign keys')
        assertValidIdentifierSegment(operation.columnName, 'Foreign key column')
        assertValidIdentifierPath(operation.reference.table, 'Foreign key table')
        assertValidIdentifierSegment(operation.reference.column, 'Foreign key column')
        await this.execute(this.createCompiler().compile(
          createForeignKeyOperation(tableName, operation.columnName, operation.reference, operation.constraintName),
        ))
        this.updateRegisteredTable(
          tableName,
          table => this.withForeignKey(table, operation.columnName, operation.reference, operation.constraintName),
        )
        return
      case 'dropForeignKey':
        this.assertForeignKeyCapability('dropping foreign keys')
        await this.execute(this.createCompiler().compile(
          dropForeignKeyOperation(tableName, operation.constraintName),
        ))
        this.updateRegisteredTable(
          tableName,
          table => this.withoutForeignKey(table, operation.constraintName),
        )
        return
    }
  }

  private async buildTableDefinition<TName extends string>(
    tableName: TName,
    callback?: (table: TableDefinitionBuilder<TName>) => void | Promise<void>,
  ): Promise<TableDefinition> {
    assertValidIdentifierPath(tableName, 'Table name')

    if (!callback) {
      throw new CapabilityError('SchemaService.createTable(name, callback) requires a table-definition callback.')
    }

    const builder = new TableDefinitionBuilder(tableName)
    await callback(builder)
    return builder.build()
  }

  private updateRegisteredTable(
    tableName: string,
    update: (table: TableDefinition) => TableDefinition,
  ): void {
    const registry = this.connection.getSchemaRegistry()
    const existing = registry.get(tableName)
    if (!existing) {
      return
    }

    registry.replace(update(existing))
  }

  private renameRegisteredTable(fromTableName: string, toTableName: string): void {
    const registry = this.connection.getSchemaRegistry()
    const existing = registry.get(fromTableName)
    if (!existing) {
      return
    }

    registry.delete(fromTableName)
    registry.replace(defineTable(toTableName, existing.columns, { indexes: existing.indexes }))
  }

  private withColumn(table: TableDefinition, column: AnyColumnDefinition): TableDefinition {
    return defineTable(table.tableName, {
      ...table.columns,
      [column.name]: column,
    }, { indexes: table.indexes })
  }

  private withAlteredColumn(table: TableDefinition, column: AnyColumnDefinition): TableDefinition {
    const existing = table.columns[column.name]
    if (!existing) {
      return this.withColumn(table, column)
    }

    return defineTable(table.tableName, {
      ...table.columns,
      [column.name]: Object.freeze({
        ...column,
        primaryKey: existing.primaryKey,
        unique: existing.unique,
        references: existing.references,
      }),
    }, { indexes: table.indexes })
  }

  private withoutColumn(table: TableDefinition, columnName: string): TableDefinition {
    const nextColumns = Object.fromEntries(
      Object.entries(table.columns).filter(([name]) => name !== columnName),
    )
    const nextIndexes = table.indexes.filter(index => !index.columns.includes(columnName))
    return defineTable(table.tableName, nextColumns, { indexes: nextIndexes })
  }

  private renameRegisteredColumn(table: TableDefinition, fromColumnName: string, toColumnName: string): TableDefinition {
    const nextColumns = Object.fromEntries(
      Object.entries(table.columns).map(([name, column]) => {
        if (name !== fromColumnName) {
          return [name, column]
        }

        return [toColumnName, Object.freeze({
          ...column,
          name: toColumnName,
          references: column.references
            ? {
                ...column.references,
                constraintName: column.references.constraintName
                  ?? this.resolveForeignKeyName(table.tableName, fromColumnName),
              }
            : undefined,
        })]
      }),
    )
    const nextIndexes = table.indexes.map(index => ({
      ...index,
      name: index.name
        ?? (
          index.columns.includes(fromColumnName)
            ? this.resolveIndexName(table.tableName, index)
            : undefined
        ),
      columns: index.columns.map(columnName => columnName === fromColumnName ? toColumnName : columnName),
    }))
    return defineTable(table.tableName, nextColumns, { indexes: nextIndexes })
  }

  private withIndex(table: TableDefinition, index: TableIndexDefinition): TableDefinition {
    return defineTable(table.tableName, table.columns, {
      indexes: [...table.indexes, index],
    })
  }

  private withoutIndex(table: TableDefinition, indexName: string): TableDefinition {
    const nextIndexes = table.indexes.filter(index => this.resolveIndexName(table.tableName, index) !== indexName)
    return defineTable(table.tableName, table.columns, { indexes: nextIndexes })
  }

  private renameRegisteredIndex(table: TableDefinition, fromIndexName: string, toIndexName: string): TableDefinition {
    const nextIndexes = table.indexes.map(index => (
      this.resolveIndexName(table.tableName, index) === fromIndexName
        ? { ...index, name: toIndexName }
        : index
    ))
    return defineTable(table.tableName, table.columns, { indexes: nextIndexes })
  }

  private withForeignKey(
    table: TableDefinition,
    columnName: string,
    reference: ForeignKeyReference,
    constraintName?: string,
  ): TableDefinition {
    const target = table.columns[columnName]
    if (!target) {
      return table
    }

    return defineTable(table.tableName, {
      ...table.columns,
      [columnName]: Object.freeze({
        ...target,
        references: { ...reference, ...(constraintName ? { constraintName } : {}) },
      }),
    }, { indexes: table.indexes })
  }

  private withoutForeignKey(table: TableDefinition, constraintName: string): TableDefinition {
    const nextColumns = Object.fromEntries(
      Object.entries(table.columns).map(([name, column]) => {
        const generatedConstraintName = this.resolveForeignKeyName(table.tableName, name)
        const registeredConstraintName = column.references?.constraintName ?? generatedConstraintName
        if (!column.references || registeredConstraintName !== constraintName) {
          return [name, column]
        }

        return [name, Object.freeze({
          ...column,
          references: undefined,
        })]
      }),
    )

    return defineTable(table.tableName, nextColumns, { indexes: table.indexes })
  }

  private resolveIndexName(tableName: string, index: TableIndexDefinition): string {
    return index.name ?? `${tableName.replaceAll('.', '_')}_${index.columns.join('_')}_${index.unique ? 'unique' : 'index'}`
  }

  private resolveForeignKeyName(tableName: string, columnName: string): string {
    return `${tableName.replaceAll('.', '_')}_${columnName}_foreign`
  }

  private createForeignKeyConstraintStatement(enable: boolean): { sql: string, source: string } {
    if (this.isSqlite()) {
      return {
        sql: `PRAGMA foreign_keys = ${enable ? 'ON' : 'OFF'}`,
        source: `schema:${enable ? 'enable' : 'disable'}ForeignKeys`,
      }
    }

    if (this.isPostgres()) {
      return {
        sql: `SET session_replication_role = '${enable ? 'origin' : 'replica'}'`,
        source: `schema:${enable ? 'enable' : 'disable'}ForeignKeys`,
      }
    }

    if (this.isMySQL()) {
      return {
        sql: `SET FOREIGN_KEY_CHECKS = ${enable ? '1' : '0'}`,
        source: `schema:${enable ? 'enable' : 'disable'}ForeignKeys`,
      }
    }

    throw new CapabilityError(
      `SchemaService does not support foreign key constraint toggles for dialect "${this.connection.getDialect().name}".`,
    )
  }

  private inferLogicalColumnType(
    physicalType: string,
    dialect: 'sqlite' | 'postgres' | 'mysql',
  ): LogicalColumnKind | null {
    const normalized = physicalType.trim().toLowerCase()
    if (normalized.length === 0) {
      return null
    }

    if (normalized === 'uuid') {
      return 'uuid'
    }

    if (normalized === 'json' || normalized === 'jsonb') {
      return 'json'
    }

    if (normalized.startsWith('vector')) {
      return 'vector'
    }

    if (normalized.startsWith('enum(')) {
      return 'enum'
    }

    if (normalized === 'boolean' || normalized === 'bool') {
      return 'boolean'
    }

    if (normalized === 'date') {
      return 'date'
    }

    if (normalized.startsWith('timestamp')) {
      return 'timestamp'
    }

    if (normalized === 'datetime') {
      return 'datetime'
    }

    if (normalized === 'time') {
      return 'string'
    }

    if (normalized === 'real'
      || normalized === 'double'
      || normalized === 'double precision'
      || normalized === 'float') {
      return 'real'
    }

    if (normalized === 'numeric' || normalized.startsWith('decimal')) {
      return 'decimal'
    }

    if (normalized === 'blob'
      || normalized === 'bytea'
      || normalized === 'binary'
      || normalized === 'varbinary') {
      return 'blob'
    }

    if (normalized === 'text'
      || normalized === 'tinytext'
      || normalized === 'mediumtext'
      || normalized === 'longtext') {
      return 'text'
    }

    if (normalized.startsWith('varchar')
      || normalized.startsWith('character varying')
      || normalized.startsWith('character')
      || normalized === 'char') {
      return 'string'
    }

    if (normalized === 'bigint' || normalized === 'bigserial') {
      return 'bigInteger'
    }

    if (normalized === 'integer'
      || normalized === 'int'
      || normalized === 'smallint'
      || normalized === 'serial') {
      return 'integer'
    }

    if (dialect === 'mysql' && normalized === 'tinyint') {
      return 'boolean'
    }

    if (dialect === 'sqlite' && normalized.includes('int')) {
      return 'integer'
    }

    return null
  }
}

export function createSchemaService(connection: DatabaseContext): SchemaService {
  return new SchemaService(connection)
}
