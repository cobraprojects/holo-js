import { closePinnedConnection, currentPinnedConnection, pinnedRestoreOptions, runPinnedConnection } from '../concurrency/pinnedConnection'
import { reportError } from '@holo-js/kernel/error-reporting'
import { CapabilityError, SchemaError } from '../core/errors'
import { addColumnOperation, alterColumnOperation, createForeignKeyOperation, createIndexOperation, createPrimaryKeyOperation, dropColumnOperation, dropForeignKeyOperation, dropIndexOperation, dropPrimaryKeyOperation, dropTableOperation, dropUniqueOperation, renameColumnOperation, renameIndexOperation, renameTableOperation } from './ddl'
import { assertUniqueResolvedIndexNames, assertValidIndexName, resolveGeneratedCheckName, resolveGeneratedIndexName } from './generatedNames'
import { assertValidIdentifierPath, assertValidIdentifierSegment } from './identifiers'
import { SQLiteSchemaCompiler } from './SQLiteSchemaCompiler'
import { PostgresSchemaCompiler } from './PostgresSchemaCompiler'
import { MySQLSchemaCompiler } from './MySQLSchemaCompiler'
import { TableDefinitionBuilder } from './TableDefinitionBuilder'
import { TableMutationBuilder } from './TableMutationBuilder'
import { createSchemaReader } from './introspection'
import { toTableDefinition } from './introspection/definitions'
import { isPrimaryKeyConstraintDefinition, readColumnDefinitionName, readEnumChecks, readInlineColumnConstraints, splitCreateTableSql, withoutInlinePrimaryKey } from './introspection/sqlDefinitions'
import type { AnyColumnBuilder } from './columns'
import type { SQLSchemaCompiler } from './SQLSchemaCompiler'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { DDLStatement, UniqueBacking } from './ddl'
import type { DatabaseTableStructure } from './introspection'
import type { AnyColumnDefinition, LogicalColumnKind, TableDefinition, TableIndexDefinition } from './types'

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

type SQLiteTableSqlRow = {
  sql: string
}

type SQLiteForeignKeysRow = {
  foreign_keys: number
}

type SQLiteTableRewrite = (
  structure: DatabaseTableStructure,
  definitions: readonly string[],
) => Array<string | AnyColumnDefinition>

type SQLiteSchemaObjectRow = {
  type: 'index' | 'trigger'
  name: string
  sql: string
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

type PostgresConstraintRow = {
  name: string
  is_check: boolean
}

type CheckConstraintRename = {
  readonly from: string
  readonly to: string
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
  private pinnedRestorePending = false

  constructor(private readonly connection: DatabaseContext) {}

  getDialectName(): string {
    return this.connection.getDialect().name
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
  }

  async renameTable(
    fromTableName: string,
    toTableName: string,
  ): Promise<void> {
    assertValidIdentifierPath(fromTableName, 'Table name')
    assertValidIdentifierPath(toTableName, 'Table name')
    const destinationTableName = this.resolveRenamedTablePath(fromTableName, toTableName)
    const enumColumnNames = (await this.readPostgresEnumChecks(fromTableName)).map(check => check.column)
    await this.executeRename(
      this.createCompiler().compile(renameTableOperation(fromTableName, toTableName)),
      destinationTableName,
      enumColumnNames.map(columnName => ({
        from: resolveGeneratedCheckName(fromTableName, columnName),
        to: resolveGeneratedCheckName(destinationTableName, columnName),
      })),
    )
  }

  async table(
    tableName: string,
    callback: (table: TableMutationBuilder) => void | Promise<void>,
  ): Promise<void> {
    assertValidIdentifierPath(tableName, 'Table name')
    const builder = new TableMutationBuilder(tableName)
    await callback(builder)
    const operations = builder.getOperations()
    this.assertTableMutationIndexNames(tableName, operations)

    for (const operation of operations) {
      await this.executeTableMutation(tableName, operation)
    }
  }

  async enableForeignKeyConstraints(): Promise<void> {
    const options = this.pinnedRestorePending ? pinnedRestoreOptions : undefined
    this.pinnedRestorePending = false
    await this.connection.executeCompiled(this.createForeignKeyConstraintStatement(true), options)
  }

  async disableForeignKeyConstraints(): Promise<void> {
    await this.connection.executeCompiled(this.createForeignKeyConstraintStatement(false))
  }

  async withoutForeignKeyConstraints<TResult>(
    callback: () => TResult | Promise<TResult>,
  ): Promise<TResult> {
    const adapter = this.connection.getAdapter()
    if (currentPinnedConnection(adapter)) {
      return callback()
    }

    return runPinnedConnection(adapter, () => (adapter.runWithTransactionScope
      ? adapter.runWithTransactionScope(() => this.runWithoutForeignKeyConstraints(callback))
      : this.runWithoutForeignKeyConstraints(callback)))
  }

  private async restoreForeignKeyConstraints(): Promise<void> {
    try {
      this.pinnedRestorePending = true
      await this.enableForeignKeyConstraints()
    } catch (error) {
      await this.connection.getAdapter().execute(this.createForeignKeyConstraintStatement(true).sql)
      reportError(error, { capability: 'db', operation: 'schema.restoreForeignKeys' })
    }
  }

  private async runWithoutForeignKeyConstraints<TResult>(
    callback: () => TResult | Promise<TResult>,
  ): Promise<TResult> {
    const pinned = currentPinnedConnection(this.connection.getAdapter())!
    try {
      await this.disableForeignKeyConstraints()
      return await callback()
    } finally {
      await closePinnedConnection(pinned)
      await this.restoreForeignKeyConstraints()
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
          ? 'SELECT kcu.referenced_table_name AS table_name, kcu.column_name AS from_column, kcu.referenced_column_name AS to_column, rc.update_rule AS on_update, rc.delete_rule AS on_delete FROM information_schema.key_column_usage kcu JOIN information_schema.referential_constraints rc ON rc.constraint_name = kcu.constraint_name AND rc.constraint_schema = kcu.table_schema WHERE kcu.table_schema = ? AND kcu.table_name = ? AND kcu.referenced_table_name IS NOT NULL ORDER BY kcu.ordinal_position'
          : 'SELECT kcu.referenced_table_name AS table_name, kcu.column_name AS from_column, kcu.referenced_column_name AS to_column, rc.update_rule AS on_update, rc.delete_rule AS on_delete FROM information_schema.key_column_usage kcu JOIN information_schema.referential_constraints rc ON rc.constraint_name = kcu.constraint_name AND rc.constraint_schema = kcu.table_schema WHERE kcu.table_schema = DATABASE() AND kcu.table_name = ? AND kcu.referenced_table_name IS NOT NULL ORDER BY kcu.ordinal_position',
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

  private assertAddColumnCapability(): void {
    const capabilities = this.connection.getCapabilities()
    this.assertColumnCapability(capabilities.ddlAddColumnSupport ?? capabilities.ddlAlterSupport, 'adding columns')
  }

  private assertColumnCapability(supported: boolean, action: string): void {
    if (!supported) {
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
    const compiler = this.createCompiler()
    const indexes = compiler.resolveCreateTableIndexes(table)
    const tableStatement = compiler.compileTableCreation(table)
    if (indexes.length === 0) {
      await this.execute([tableStatement])
      return
    }

    await this.runAtomically(async (service) => {
      await service.execute([tableStatement])
      const missingIndexes = await service.resolveMissingIndexes(table.tableName, indexes)
      await service.execute(missingIndexes.map(index => compiler.compileCreateIndex(table.tableName, index)))
    })
  }

  private async resolveMissingIndexes(tableName: string, declaredIndexes: readonly TableIndexDefinition[]): Promise<TableIndexDefinition[]> {
    const existingIndexes = (await createSchemaReader(this.connection).readTableStructure(tableName))?.indexes ?? []
    return declaredIndexes.filter((declared) => {
      const existing = existingIndexes.find(index => index.name === declared.name)
      if (!existing) {
        return true
      }

      if (existing.unique !== declared.unique || existing.columns.join('|') !== declared.columns.join('|')) {
        throw new SchemaError(
          `Index "${declared.name}" on table "${tableName}" already exists with columns "${existing.columns.join('", "')}"${existing.unique ? ' (unique)' : ''}, not the declared columns "${declared.columns.join('", "')}"${declared.unique ? ' (unique)' : ''}.`,
        )
      }

      return false
    })
  }

  private async runAtomically(callback: (service: SchemaService) => Promise<void>): Promise<void> {
    if (this.isMySQL()) {
      await callback(this)
      return
    }

    await this.connection.transaction(tx => callback(new SchemaService(tx)))
  }

  private async executeAtomically(statements: readonly DDLStatement[]): Promise<void> {
    if (statements.length < 2) {
      await this.execute(statements)
      return
    }

    await this.runAtomically(service => service.execute(statements))
  }

  private async resolveUniqueBacking(tableName: string, indexName: string): Promise<UniqueBacking> {
    if (!this.isPostgres()) {
      return 'index'
    }

    const quote = (identifier: string) => this.connection.getDialect().quoteIdentifier(identifier)
    const result = await this.connection.introspectCompiled<{ name: string }>({
      sql: 'SELECT conname AS name FROM pg_constraint WHERE conrelid = to_regclass($1) AND conname = $2 AND contype = \'u\'',
      bindings: [tableName.split('.').map(quote).join('.'), indexName],
      source: `schema:introspect:uniqueConstraint:${tableName}:${indexName}`,
    })
    return result.rows.length > 0 ? 'constraint' : 'index'
  }

  private assertTableMutationIndexNames(
    tableName: string,
    operations: ReturnType<TableMutationBuilder['getOperations']>,
  ): void {
    const indexes: TableIndexDefinition[] = []
    for (const operation of operations) {
      switch (operation.kind) {
        case 'createIndex':
          indexes.push(operation.index)
          this.resolveIndexName(tableName, operation.index)
          break
        case 'dropIndex':
        case 'dropUnique':
          assertValidIndexName(operation.indexName)
          break
        case 'renameIndex':
          assertValidIndexName(operation.fromIndexName)
          assertValidIndexName(operation.toIndexName)
          indexes.push({ columns: [], name: operation.toIndexName, unique: false })
          break
      }
    }

    assertUniqueResolvedIndexNames(tableName, indexes)
  }

  private async executeTableMutation(
    tableName: string,
    operation: ReturnType<TableMutationBuilder['getOperations']>[number],
  ): Promise<void> {
    switch (operation.kind) {
      case 'addColumn': {
        this.assertAddColumnCapability()
        const definition = this.resolveColumnDefinition(operation.columnName, operation.column)
        await this.executeAtomically(this.createCompiler().compile(addColumnOperation(tableName, definition)))
        return
      }
      case 'alterColumn': {
        const definition = this.resolveColumnDefinition(operation.columnName, operation.column)
        if (this.isSqlite()) {
          await this.rebuildSqliteTable(tableName, (structure, definitions) => this.rebuildSqliteDefinitions(tableName, structure, definitions, definition))
        } else {
          this.assertAlterCapability('altering columns')
          const statements = this.createCompiler().compile(alterColumnOperation(tableName, definition))
          if (this.isPostgres()) {
            const enumChecks = (await this.readPostgresEnumChecks(tableName)).filter(check => check.column === definition.name)
            await this.connection.transaction(async (tx) => {
              const service = new SchemaService(tx)
              await service.dropPostgresChecks(tableName, enumChecks.flatMap(check => check.name ? [check.name] : []))
              await service.execute(statements)
            })
          } else {
            await this.execute(statements)
          }
        }
        return
      }
      case 'dropColumn':
        this.assertColumnCapability(this.connection.getCapabilities().ddlDropColumnSupport, 'dropping columns')
        await this.execute(this.createCompiler().compile(dropColumnOperation(tableName, operation.columnName)))
        return
      case 'renameColumn':
        this.assertColumnCapability(this.connection.getCapabilities().ddlRenameColumnSupport, 'renaming columns')
        await this.executeRename(
          this.createCompiler().compile(renameColumnOperation(tableName, operation.fromColumnName, operation.toColumnName)),
          tableName,
          (await this.readPostgresEnumChecks(tableName))
            .filter(check => check.column === operation.fromColumnName)
            .map(() => ({
              from: resolveGeneratedCheckName(tableName, operation.fromColumnName),
              to: resolveGeneratedCheckName(tableName, operation.toColumnName),
            })),
        )
        return
      case 'createIndex':
        await this.execute(this.createCompiler().compile(createIndexOperation(tableName, operation.index)))
        return
      case 'dropIndex':
        await this.execute(this.createCompiler().compile(dropIndexOperation(tableName, operation.indexName)))
        return
      case 'dropUnique':
        await this.execute(this.createCompiler().compile(
          dropUniqueOperation(tableName, operation.indexName, await this.resolveUniqueBacking(tableName, operation.indexName)),
        ))
        return
      case 'renameIndex':
        if (this.isSqlite()) {
          await this.renameSqliteIndex(tableName, operation.fromIndexName, operation.toIndexName)
          return
        }
        await this.execute(this.createCompiler().compile(
          renameIndexOperation(tableName, operation.fromIndexName, operation.toIndexName),
        ))
        return
      case 'createForeignKey':
        this.assertForeignKeyCapability('adding foreign keys')
        assertValidIdentifierSegment(operation.columnName, 'Foreign key column')
        assertValidIdentifierPath(operation.reference.table, 'Foreign key table')
        assertValidIdentifierSegment(operation.reference.column, 'Foreign key column')
        await this.execute(this.createCompiler().compile(
          createForeignKeyOperation(tableName, operation.columnName, operation.reference, operation.constraintName),
        ))
        return
      case 'dropForeignKey':
        this.assertForeignKeyCapability('dropping foreign keys')
        await this.execute(this.createCompiler().compile(
          dropForeignKeyOperation(tableName, operation.constraintName),
        ))
        return
      case 'createPrimaryKey':
        await this.createPrimaryKey(tableName, operation.columns, operation.constraintName)
        return
      case 'dropPrimaryKey':
        await this.dropPrimaryKey(tableName, operation.constraintName)
    }
  }

  private async createPrimaryKey(tableName: string, columns: readonly string[], constraintName?: string): Promise<void> {
    const compiler = this.createCompiler()
    if (!this.isSqlite()) {
      await this.execute(compiler.compile(createPrimaryKeyOperation(tableName, columns, constraintName)))
      return
    }

    await this.rebuildSqliteTable(tableName, (structure, definitions) => {
      if (structure.columns.some(column => column.primaryKey)) {
        throw new SchemaError(`Table "${tableName}" already has a primary key. Drop it with dropPrimary() first.`)
      }

      return [...definitions, compiler.compilePrimaryKeyConstraint(columns, constraintName)]
    })
  }

  private async dropPrimaryKey(tableName: string, constraintName?: string): Promise<void> {
    const structure = await createSchemaReader(this.connection).readTableStructure(tableName)
    if (!structure?.columns.some(column => column.primaryKey)) {
      throw new SchemaError(`Table "${tableName}" has no primary key to drop.`)
    }

    if (this.isSqlite()) {
      await this.rebuildSqliteTable(tableName, (_structure, definitions) => definitions
        .filter(definition => !isPrimaryKeyConstraintDefinition(definition))
        .map(definition => readColumnDefinitionName(definition) === undefined ? definition : withoutInlinePrimaryKey(definition)))
      return
    }

    const actualName = structure.indexes.find(index => index.primary)?.name ?? 'PRIMARY'
    if (this.isPostgres() && constraintName !== undefined && constraintName !== actualName) {
      throw new SchemaError(`Table "${tableName}" has primary key "${actualName}", not "${constraintName}".`)
    }

    await this.execute(this.createCompiler().compile(dropPrimaryKeyOperation(tableName, actualName)))
  }

  private async executeRename(
    statements: DDLStatement[],
    tableName: string,
    checkRenames: readonly CheckConstraintRename[],
  ): Promise<void> {
    if (!this.isPostgres() || checkRenames.length === 0) {
      await this.execute(statements)
      return
    }

    await this.connection.transaction(async (tx) => {
      const service = new SchemaService(tx)
      await service.execute(statements)
      await service.renamePostgresEnumChecks(tableName, checkRenames)
    })
  }

  private async readPostgresEnumChecks(tableName: string): Promise<DatabaseTableStructure['enumChecks']> {
    if (!this.isPostgres()) {
      return []
    }

    return (await createSchemaReader(this.connection).readTableStructure(tableName))?.enumChecks ?? []
  }

  private async dropPostgresChecks(tableName: string, checkNames: readonly string[]): Promise<void> {
    const quote = (identifier: string) => this.connection.getDialect().quoteIdentifier(identifier)
    const tableIdentifier = tableName.split('.').map(quote).join('.')
    for (const checkName of checkNames) {
      await this.connection.executeCompiled({
        sql: `ALTER TABLE ${tableIdentifier} DROP CONSTRAINT ${quote(checkName)}`,
        source: `schema:dropCheck:${tableName}:${checkName}`,
      })
    }
  }

  private resolveRenamedTablePath(fromTableName: string, toTableName: string): string {
    const fromSegments = fromTableName.split('.')
    if (this.isMySQL() || toTableName.includes('.') || fromSegments.length === 1) {
      return toTableName
    }

    return [...fromSegments.slice(0, -1), toTableName].join('.')
  }

  private async renamePostgresEnumChecks(
    tableName: string,
    checkRenames: readonly CheckConstraintRename[],
  ): Promise<void> {
    const quote = (identifier: string) => this.connection.getDialect().quoteIdentifier(identifier)
    const tableIdentifier = tableName.split('.').map(quote).join('.')
    const result = await this.connection.introspectCompiled<PostgresConstraintRow>({
      sql: 'SELECT conname AS name, contype = \'c\' AS is_check FROM pg_constraint WHERE conrelid = to_regclass($1)',
      bindings: [tableIdentifier],
      source: `schema:introspect:checks:${tableName}`,
    })
    const existingCheckNames = new Set(result.rows.filter(row => row.is_check).map(row => row.name))
    const reservedNames = new Set([...result.rows.map(row => row.name), ...checkRenames.map(({ to }) => to)])
    const reserveTemporaryName = (): string => {
      let suffix = 0
      while (reservedNames.has(`__holo_check_rename_${suffix}`)) {
        suffix += 1
      }

      const name = `__holo_check_rename_${suffix}`
      reservedNames.add(name)
      return name
    }
    const pendingRenames = checkRenames
      .filter(({ from, to }) => from !== to && existingCheckNames.has(from))
      .map(rename => ({ ...rename, temporary: reserveTemporaryName() }))
    const renameConstraint = (from: string, to: string) => this.connection.executeCompiled({
      sql: `ALTER TABLE ${tableIdentifier} RENAME CONSTRAINT ${quote(from)} TO ${quote(to)}`,
      source: `schema:renameCheck:${tableName}:${from}:${to}`,
    })

    for (const { from, temporary } of pendingRenames) {
      await renameConstraint(from, temporary)
    }

    for (const { to, temporary } of pendingRenames) {
      await renameConstraint(temporary, to)
    }
  }


  private async renameSqliteIndex(tableName: string, fromIndexName: string, toIndexName: string): Promise<void> {
    const index = (await createSchemaReader(this.connection).readTableStructure(tableName))?.indexes
      .find(candidate => candidate.name === fromIndexName)
    if (!index) {
      throw new SchemaError(`SQLite cannot rename missing index "${fromIndexName}" on table "${tableName}".`)
    }
    if (!index.representable) {
      throw new SchemaError(`SQLite cannot rename index "${fromIndexName}" on table "${tableName}" because it is a partial or expression index.`)
    }

    const statements = new SQLiteSchemaCompiler(identifier => this.connection.getDialect().quoteIdentifier(identifier))
      .compileRecreateIndex(tableName, fromIndexName, { name: toIndexName, columns: index.columns, unique: index.unique })
    await this.connection.transaction(async (tx) => {
      await new SchemaService(tx).execute(statements)
    })
  }

  private async rebuildSqliteTable(tableName: string, rewrite: SQLiteTableRewrite): Promise<void> {
    if (!(await this.sqliteForeignKeysEnabled())) {
      await this.connection.transaction(tx => new SchemaService(tx).copySqliteTable(tableName, rewrite))
      return
    }

    if (this.connection.isInTransaction() || currentPinnedConnection(this.connection.getAdapter())) {
      await this.assertSqliteTableUnreferenced(tableName)
      await this.connection.transaction(tx => new SchemaService(tx).copySqliteTable(tableName, rewrite))
      return
    }

    await this.withoutForeignKeyConstraints(() => this.connection.transaction(async (tx) => {
      const service = new SchemaService(tx)
      await service.copySqliteTable(tableName, rewrite)
      await service.assertNoSqliteForeignKeyViolations(tableName)
    }))
  }

  private async sqliteForeignKeysEnabled(): Promise<boolean> {
    const result = await this.connection.introspectCompiled<SQLiteForeignKeysRow>({
      sql: 'PRAGMA foreign_keys',
      source: 'schema:sqliteRebuild:foreignKeys',
    })
    return Number(result.rows[0]?.foreign_keys) === 1
  }

  private async assertSqliteTableUnreferenced(tableName: string): Promise<void> {
    const result = await this.connection.introspectCompiled<SQLiteTableRow>({
      sql: 'SELECT DISTINCT m.name FROM sqlite_master m, pragma_foreign_key_list(m.name) f WHERE m.type = \'table\' AND f."table" = ?',
      bindings: [tableName],
      source: `schema:sqliteRebuild:referencingTables:${tableName}`,
    })
    if (result.rows.length > 0) {
      throw new SchemaError(
        `SQLite cannot rebuild table "${tableName}" inside a transaction while foreign-key enforcement is on, because table "${result.rows.map(row => row.name).join('", "')}" references it. Run the change outside the transaction or in a migration.`,
      )
    }
  }

  private async assertNoSqliteForeignKeyViolations(tableName: string): Promise<void> {
    const result = await this.connection.introspectCompiled({
      sql: 'PRAGMA foreign_key_check',
      source: `schema:sqliteRebuild:foreignKeyCheck:${tableName}`,
    })
    if (result.rows.length > 0) {
      throw new SchemaError(
        `SQLite cannot rebuild table "${tableName}" because it would leave ${result.rows.length} foreign key violation${result.rows.length === 1 ? '' : 's'}.`,
      )
    }
  }

  private async copySqliteTable(tableName: string, rewrite: SQLiteTableRewrite): Promise<void> {
    const structure = await createSchemaReader(this.connection).readTableStructure(tableName)
    if (!structure) {
      throw new SchemaError(`SQLite cannot rebuild table "${tableName}" because it does not exist.`)
    }

    const temporaryTableName = `__holo_rebuild_${tableName.replaceAll('.', '_')}`
    if (await this.hasTable(temporaryTableName)) {
      throw new SchemaError(
        `SQLite cannot rebuild table "${tableName}" because temporary table "${temporaryTableName}" already exists.`,
      )
    }

    const currentTable = await this.connection.introspectCompiled<SQLiteTableSqlRow>({
      sql: 'SELECT sql FROM sqlite_master WHERE type = \'table\' AND name = ?',
      bindings: [tableName],
      source: `schema:sqliteRebuild:table:${tableName}`,
    })
    const currentSql = splitCreateTableSql(currentTable.rows[0]?.sql ?? '')
    if (!currentSql) {
      throw new SchemaError(`SQLite cannot read the definition of table "${tableName}" to rebuild it.`)
    }

    const schemaObjects = await this.connection.introspectCompiled<SQLiteSchemaObjectRow>({
      sql: 'SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? AND type IN (\'index\', \'trigger\') AND sql IS NOT NULL ORDER BY type, name',
      bindings: [tableName],
      source: `schema:sqliteRebuild:objects:${tableName}`,
    })
    const quote = (identifier: string) => this.connection.getDialect().quoteIdentifier(identifier)
    const compiler = new SQLiteSchemaCompiler(quote)
    const definitions = rewrite(structure, currentSql.definitions)
    const columns = structure.columns.filter(existing => !existing.computed).map(existing => quote(existing.name)).join(', ')

    await this.connection.executeCompiled(compiler.compileRebuildTable(tableName, temporaryTableName, definitions, currentSql.options))
    await this.connection.executeCompiled({
      sql: `INSERT INTO ${quote(temporaryTableName)} (${columns}) SELECT ${columns} FROM ${quote(tableName)}`,
      source: `schema:sqliteRebuild:copy:${tableName}`,
    })
    if (definitions.some(definition => typeof definition === 'string'
      ? readInlineColumnConstraints(definition).autoIncrement
      : definition.idStrategy === 'autoIncrement')) {
      await this.connection.executeCompiled({
        sql: 'DELETE FROM sqlite_sequence WHERE name = ?',
        bindings: [temporaryTableName],
        source: `schema:sqliteRebuild:sequence:${tableName}`,
      })
      await this.connection.executeCompiled({
        sql: 'UPDATE sqlite_sequence SET name = ? WHERE name = ?',
        bindings: [temporaryTableName, tableName],
        source: `schema:sqliteRebuild:sequence:${tableName}`,
      })
    }
    await this.execute(compiler.compile(dropTableOperation(tableName)))
    await this.execute(compiler.compile(renameTableOperation(temporaryTableName, tableName)))

    for (const object of schemaObjects.rows) {
      await this.connection.executeCompiled({
        sql: object.sql,
        source: `schema:sqliteRebuild:restore:${object.type}:${object.name}`,
      })
    }
  }

  private rebuildSqliteDefinitions(
    tableName: string,
    structure: DatabaseTableStructure,
    definitions: readonly string[],
    column: AnyColumnDefinition,
  ): Array<string | AnyColumnDefinition> {
    if (!structure.columns.some(existing => existing.name === column.name)) {
      throw new SchemaError(
        `SQLite cannot change missing column "${column.name}" on table "${tableName}". Add the column without change() first.`,
      )
    }

    return definitions.flatMap((definition): Array<string | AnyColumnDefinition> => {
      const columnName = readColumnDefinitionName(definition)
      if (columnName === column.name) {
        return [this.keepSqliteColumnConstraints(structure, definition, column)]
      }

      if (columnName === undefined && readEnumChecks(definition).some(check => check.column === column.name)) {
        return []
      }

      return [definition]
    })
  }

  private keepSqliteColumnConstraints(
    structure: DatabaseTableStructure,
    definition: string,
    column: AnyColumnDefinition,
  ): AnyColumnDefinition {
    const inline = readInlineColumnConstraints(definition)
    const references = inline.references ? toTableDefinition(structure).columns[column.name]?.references : undefined
    return {
      ...column,
      primaryKey: inline.primaryKey,
      unique: inline.unique,
      references,
      ...(inline.autoIncrement ? { idStrategy: 'autoIncrement' as const } : {}),
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

  private resolveIndexName(tableName: string, index: TableIndexDefinition): string {
    return resolveGeneratedIndexName(tableName, index)
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

    if (dialect === 'sqlite' && normalized === 'tinyint(1)') {
      return 'boolean'
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
