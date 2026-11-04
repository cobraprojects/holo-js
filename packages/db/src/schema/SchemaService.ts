import { closePinnedConnection, currentPinnedConnection, pinnedRestoreOptions, runPinnedConnection } from '../concurrency/pinnedConnection'
import { reportError } from '@holo-js/kernel/error-reporting'
import { CapabilityError, SchemaError } from '../core/errors'
import { addColumnOperation, alterColumnOperation, createForeignKeyOperation, createIndexOperation, createPrimaryKeyOperation, dropColumnOperation, dropForeignKeyOperation, dropIndexOperation, dropPrimaryKeyOperation, dropTableOperation, dropUniqueOperation, renameColumnOperation, renameIndexOperation, renameTableOperation } from './ddl'
import { resolveCoveringForeignKey, resolveCoveringIndex } from './coveringKeys'
import { assertUniqueResolvedIndexNames, assertValidIndexName, resolveGeneratedIndexName } from './generatedNames'
import { assertValidIdentifierPath, assertValidIdentifierSegment } from './identifiers'
import { PostgresEnumChecks } from './PostgresEnumChecks'
import { PostgresVirtualColumns } from './PostgresVirtualColumns'
import { isMySQLConnection, isPostgresConnection, isSQLiteConnection } from './connectionDialect'
import { createSchemaCompiler } from './schemaCompilerFactory'
import { executeStatements, runAtomically } from './ddlExecution'
import { SQLiteSchemaOperations } from './SQLiteSchemaOperations'
import { TableDefinitionBuilder } from './TableDefinitionBuilder'
import { TableMutationBuilder } from './TableMutationBuilder'
import { createSchemaReader, readTableStructure } from './introspection'
import { inferColumnKind } from './introspection/definitions'
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

export class SchemaService {
  private pinnedRestorePending = false
  private readonly sqlite: SQLiteSchemaOperations
  private readonly postgresEnumChecks: PostgresEnumChecks
  private readonly postgresVirtualColumns: PostgresVirtualColumns

  constructor(private readonly connection: DatabaseContext) {
    this.sqlite = new SQLiteSchemaOperations(connection, callback => this.withoutForeignKeyConstraints(callback))
    this.postgresEnumChecks = new PostgresEnumChecks(connection)
    this.postgresVirtualColumns = new PostgresVirtualColumns(connection)
  }

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
    const statements = this.createCompiler().compile(renameTableOperation(fromTableName, toTableName))
    await (this.isPostgres()
      ? this.postgresEnumChecks.renameTable(fromTableName, toTableName, statements)
      : this.execute(statements))
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
    this.assertCompilableColumnChanges(tableName, operations)
    await this.assertSupportedColumns(operations.flatMap(operation => operation.kind === 'addColumn' || operation.kind === 'alterColumn'
      ? [this.resolveColumnDefinition(operation.columnName, operation.column)]
      : []))

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
    return createSchemaReader(this.connection).listTables()
  }

  async getColumns(tableName: string): Promise<IntrospectedColumn[]> {
    const structure = await this.readTableStructure(tableName)
    return structure?.columns.map(column => ({
      name: column.name,
      type: column.dataType,
      logicalType: inferColumnKind(structure.dialect, column.fullType),
      notNull: column.notNull,
      defaultValue: column.defaultExpression,
      primaryKey: column.primaryKey,
    })) ?? []
  }

  async getIndexes(tableName: string): Promise<IntrospectedIndex[]> {
    const structure = await this.readTableStructure(tableName)
    return structure?.indexes.map(index => ({
      name: index.name,
      unique: index.unique,
      columns: [...index.columns],
    })) ?? []
  }

  async getForeignKeys(tableName: string): Promise<IntrospectedForeignKey[]> {
    const structure = await this.readTableStructure(tableName)
    return structure?.foreignKeys.map(foreignKey => ({
      table: foreignKey.table,
      from: foreignKey.from,
      to: foreignKey.to,
      onUpdate: foreignKey.onUpdate,
      onDelete: foreignKey.onDelete,
    })) ?? []
  }

  private readTableStructure(tableName: string): Promise<DatabaseTableStructure | undefined> {
    return readTableStructure(this.connection, tableName)
  }

  private createCompiler(): SQLSchemaCompiler {
    return createSchemaCompiler(this.connection)
  }

  private execute(statements: readonly DDLStatement[]): Promise<void> {
    return executeStatements(this.connection, statements)
  }

  private isSqlite(): boolean {
    return isSQLiteConnection(this.connection)
  }

  private isPostgres(): boolean {
    return isPostgresConnection(this.connection)
  }

  private isMySQL(): boolean {
    return isMySQLConnection(this.connection)
  }

  private assertAlterCapability(action: string): void {
    this.assertColumnCapability(this.connection.getCapabilities().ddlAlterSupport, action)
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

  private resolveColumnDefinition(columnName: string, column: AnyColumnBuilder): AnyColumnDefinition {
    return column.toDefinition({ name: columnName })
  }

  private assertCompilableColumnChanges(
    tableName: string,
    operations: ReturnType<TableMutationBuilder['getOperations']>,
  ): void {
    if (this.isSqlite()) return
    const compiler = this.createCompiler()
    for (const operation of operations) {
      if (operation.kind === 'alterColumn') {
        compiler.compile(alterColumnOperation(tableName, this.resolveColumnDefinition(operation.columnName, operation.column)))
      }
    }
  }

  private async assertSupportedColumns(columns: readonly AnyColumnDefinition[]): Promise<void> {
    if (this.isPostgres()) await this.postgresVirtualColumns.assertSupported(columns)
  }

  private async createDefinedTable(table: TableDefinition): Promise<void> {
    await this.assertSupportedColumns(Object.values(table.columns))
    const compiler = this.createCompiler()
    const indexes = compiler.resolveCreateTableIndexes(table)
    const tableStatement = compiler.compileTableCreation(table)
    if (indexes.length === 0) {
      await this.execute([tableStatement])
      return
    }

    await runAtomically(this.connection, async (connection) => {
      await executeStatements(connection, [tableStatement])
      const missingIndexes = await resolveMissingIndexes(connection, table.tableName, indexes)
      await executeStatements(connection, missingIndexes.map(index => compiler.compileCreateIndex(table.tableName, index)))
    })
  }

  private async executeAtomically(statements: readonly DDLStatement[]): Promise<void> {
    if (statements.length < 2) {
      await this.execute(statements)
      return
    }

    await runAtomically(this.connection, connection => executeStatements(connection, statements))
  }

  private async resolveCoveringIndexName(tableName: string, columns: readonly string[], unique: boolean): Promise<string> {
    return resolveCoveringIndex(tableName, await this.readTableStructure(tableName), columns, unique).name
  }

  private async resolveUniqueBacking(tableName: string, indexName: string): Promise<UniqueBacking> {
    const index = (await this.readTableStructure(tableName))?.indexes.find(candidate => candidate.name === indexName)
    return index?.constraint && !index.primary ? 'constraint' : 'index'
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
          if ('indexName' in operation) {
            assertValidIndexName(operation.indexName)
          }
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
      case 'alterColumn':
        await this.alterColumn(tableName, this.resolveColumnDefinition(operation.columnName, operation.column))
        return
      case 'dropColumn':
        this.assertColumnCapability(this.connection.getCapabilities().ddlDropColumnSupport, 'dropping columns')
        await this.execute(this.createCompiler().compile(dropColumnOperation(tableName, operation.columnName)))
        return
      case 'renameColumn': {
        this.assertColumnCapability(this.connection.getCapabilities().ddlRenameColumnSupport, 'renaming columns')
        const statements = this.createCompiler().compile(renameColumnOperation(tableName, operation.fromColumnName, operation.toColumnName))
        await (this.isPostgres()
          ? this.postgresEnumChecks.renameColumn(tableName, operation.fromColumnName, operation.toColumnName, statements)
          : this.execute(statements))
        return
      }
      case 'createIndex':
        await this.execute(this.createCompiler().compile(createIndexOperation(tableName, operation.index)))
        return
      case 'dropIndex': {
        const indexName = 'indexName' in operation ? operation.indexName : await this.resolveCoveringIndexName(tableName, operation.columns, false)
        await this.execute(this.createCompiler().compile(dropIndexOperation(tableName, indexName)))
        return
      }
      case 'dropUnique': {
        const indexName = 'indexName' in operation ? operation.indexName : await this.resolveCoveringIndexName(tableName, operation.columns, true)
        if (this.isSqlite() && await this.sqlite.dropInlineUnique(tableName, indexName)) {
          return
        }
        await this.execute(this.createCompiler().compile(
          dropUniqueOperation(tableName, indexName, await this.resolveUniqueBacking(tableName, indexName)),
        ))
        return
      }
      case 'renameIndex':
        await (this.isSqlite()
          ? this.sqlite.renameIndex(tableName, operation.fromIndexName, operation.toIndexName)
          : this.execute(this.createCompiler().compile(renameIndexOperation(tableName, operation.fromIndexName, operation.toIndexName))))
        return
      case 'createForeignKey':
        assertValidIdentifierSegment(operation.columnName, 'Foreign key column')
        assertValidIdentifierPath(operation.reference.table, 'Foreign key table')
        assertValidIdentifierSegment(operation.reference.column, 'Foreign key column')
        if (this.isSqlite()) {
          await this.sqlite.addForeignKey(tableName, operation.columnName, operation.reference, operation.constraintName)
          return
        }
        this.assertAlterCapability('adding foreign keys')
        await this.execute(this.createCompiler().compile(
          createForeignKeyOperation(tableName, operation.columnName, operation.reference, operation.constraintName),
        ))
        return
      case 'dropForeignKey': {
        const foreignKey = 'constraintName' in operation
          ? { name: operation.constraintName, columns: [] }
          : resolveCoveringForeignKey(tableName, await this.readTableStructure(tableName), operation.columns)
        if (this.isSqlite()) {
          await this.sqlite.dropForeignKey(tableName, foreignKey)
          return
        }
        if (foreignKey.name === undefined) {
          throw new SchemaError(`Table "${tableName}" has an unnamed foreign key on columns "${foreignKey.columns.join('", "')}".`)
        }
        this.assertAlterCapability('dropping foreign keys')
        await this.execute(this.createCompiler().compile(
          dropForeignKeyOperation(tableName, foreignKey.name),
        ))
        return
      }
      case 'createPrimaryKey':
        await (this.isSqlite()
          ? this.sqlite.createPrimaryKey(tableName, operation.columns, operation.constraintName)
          : this.execute(this.createCompiler().compile(createPrimaryKeyOperation(tableName, operation.columns, operation.constraintName))))
        return
      case 'dropPrimaryKey':
        await this.dropPrimaryKey(tableName, operation.constraintName)
    }
  }

  private async alterColumn(tableName: string, definition: AnyColumnDefinition): Promise<void> {
    if (this.isSqlite()) {
      await this.sqlite.changeColumn(tableName, definition)
      return
    }

    this.assertAlterCapability('altering columns')
    const statements = this.createCompiler().compile(alterColumnOperation(tableName, definition))
    await (this.isPostgres()
      ? this.postgresEnumChecks.alterColumn(tableName, definition.name, statements)
      : this.execute(statements))
  }

  private async dropPrimaryKey(tableName: string, constraintName?: string): Promise<void> {
    const structure = await this.readTableStructure(tableName)
    if (!structure?.columns.some(column => column.primaryKey)) {
      throw new SchemaError(`Table "${tableName}" has no primary key to drop.`)
    }

    if (this.isSqlite()) {
      await this.sqlite.dropPrimaryKey(tableName)
      return
    }

    const actualName = structure.indexes.find(index => index.primary)?.name ?? 'PRIMARY'
    if (this.isPostgres() && constraintName !== undefined && constraintName !== actualName) {
      throw new SchemaError(`Table "${tableName}" has primary key "${actualName}", not "${constraintName}".`)
    }

    await this.execute(this.createCompiler().compile(dropPrimaryKeyOperation(tableName, actualName)))
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
}

async function resolveMissingIndexes(
  connection: DatabaseContext,
  tableName: string,
  declaredIndexes: readonly TableIndexDefinition[],
): Promise<TableIndexDefinition[]> {
  const existingIndexes = (await readTableStructure(connection, tableName))?.indexes ?? []
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

export function createSchemaService(connection: DatabaseContext): SchemaService {
  return new SchemaService(connection)
}
