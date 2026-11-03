import { randomUUID } from 'node:crypto'
import { closePinnedConnection, currentPinnedConnection, pinnedRestoreOptions, runPinnedConnection } from '../concurrency/pinnedConnection'
import { reportError } from '@holo-js/kernel/error-reporting'
import { CapabilityError, SchemaError } from '../core/errors'
import { addColumnOperation, alterColumnOperation, createForeignKeyOperation, createIndexOperation, createPrimaryKeyOperation, createTableOperation, dropColumnOperation, dropForeignKeyOperation, dropIndexOperation, dropPrimaryKeyOperation, dropTableOperation, dropUniqueOperation, renameColumnOperation, renameIndexOperation, renameTableOperation } from './ddl'
import { assertUniqueResolvedIndexNames, assertValidIndexName, resolveGeneratedCheckName, resolveGeneratedIndexName } from './generatedNames'
import { assertValidIdentifierPath, assertValidIdentifierSegment } from './identifiers'
import { SQLiteSchemaCompiler } from './SQLiteSchemaCompiler'
import { PostgresSchemaCompiler } from './PostgresSchemaCompiler'
import { MySQLSchemaCompiler } from './MySQLSchemaCompiler'
import { TableDefinitionBuilder } from './TableDefinitionBuilder'
import { TableMutationBuilder } from './TableMutationBuilder'
import { createSchemaReader } from './introspection'
import { inferColumnKind, toTableDefinition } from './introspection/definitions'
import { listSQLiteReferencingTables, readSQLiteCreateTableSql, readSQLiteTableObjects } from './introspection/sqlite'
import { isPrimaryKeyConstraintDefinition, readColumnDefinitionName, readEnumChecks, readInlineColumnConstraints, withoutForeignKeyDefinitions, withoutUniqueDefinitions, splitCreateTableSql, withoutInlinePrimaryKey } from './introspection/sqlDefinitions'
import type { AnyColumnBuilder } from './columns'
import type { SQLSchemaCompiler } from './SQLSchemaCompiler'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { DDLStatement, UniqueBacking } from './ddl'
import type { DatabaseTableStructure } from './introspection'
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

type SQLiteForeignKeysRow = {
  foreign_keys: number
}

type SQLiteTableRewrite = (
  structure: DatabaseTableStructure,
  definitions: readonly string[],
) => Array<string | AnyColumnDefinition>

type CheckConstraintRename = {
  readonly from: string
  readonly to: string
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
    assertValidIdentifierPath(tableName, 'Table name')
    return createSchemaReader(this.connection).readTableStructure(tableName)
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

  private resolveColumnDefinition(columnName: string, column: AnyColumnBuilder): AnyColumnDefinition {
    return column.toDefinition({ name: columnName })
  }

  private async createDefinedTable(table: TableDefinition): Promise<void> {
    await this.executeWithColumnUniques(table.tableName, Object.values(table.columns), this.createCompiler().compile(createTableOperation(table)))
  }

  private async executeWithColumnUniques(
    tableName: string,
    columns: readonly AnyColumnDefinition[],
    statements: DDLStatement[],
  ): Promise<void> {
    const expectedIndexes = this.isSqlite() ? this.createCompiler().resolveColumnUniqueIndexes(tableName, columns) : []
    if (expectedIndexes.length === 0) {
      await this.execute(statements)
      return
    }

    await this.connection.transaction(async (tx) => {
      const service = new SchemaService(tx)
      await service.execute(statements)
      await service.assertUniqueIndexesExist(tableName, expectedIndexes)
    })
  }

  private async assertUniqueIndexesExist(tableName: string, expectedIndexes: readonly TableIndexDefinition[]): Promise<void> {
    const actualIndexes = (await this.readTableStructure(tableName))?.indexes ?? []
    for (const expected of expectedIndexes) {
      const exists = actualIndexes.some(actual => actual.name === expected.name
        && actual.unique
        && actual.columns.join('|') === expected.columns.join('|'))
      if (!exists) {
        throw new SchemaError(
          `Unique index "${expected.name}" for column "${expected.columns.join('", "')}" could not be created on table "${tableName}" because another index already uses that name.`,
        )
      }
    }
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
        await this.executeWithColumnUniques(tableName, [definition], this.createCompiler().compile(addColumnOperation(tableName, definition)))
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
        if (this.isSqlite() && await this.dropSqliteInlineUnique(tableName, operation.indexName, operation.columns)) {
          return
        }
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
        assertValidIdentifierSegment(operation.columnName, 'Foreign key column')
        assertValidIdentifierPath(operation.reference.table, 'Foreign key table')
        assertValidIdentifierSegment(operation.reference.column, 'Foreign key column')
        if (this.isSqlite()) {
          await this.addSqliteForeignKey(tableName, operation.columnName, operation.reference, operation.constraintName)
          return
        }
        this.assertAlterCapability('adding foreign keys')
        await this.execute(this.createCompiler().compile(
          createForeignKeyOperation(tableName, operation.columnName, operation.reference, operation.constraintName),
        ))
        return
      case 'dropForeignKey':
        if (this.isSqlite()) {
          await this.dropSqliteForeignKey(tableName, operation.constraintName, operation.columns)
          return
        }
        this.assertAlterCapability('dropping foreign keys')
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
    const structure = await this.readTableStructure(tableName)
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

    return (await this.readTableStructure(tableName))?.enumChecks ?? []
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
    const existingCheckNames = new Set((await this.readPostgresEnumChecks(tableName)).flatMap(check => check.name ? [check.name] : []))
    const pendingRenames = checkRenames
      .filter(({ from, to }) => from !== to && existingCheckNames.has(from))
      .map(rename => ({ ...rename, temporary: `__holo_check_rename_${randomUUID().replaceAll('-', '')}` }))
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
    const index = (await this.readTableStructure(tableName))?.indexes
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

  private async addSqliteForeignKey(
    tableName: string,
    columnName: string,
    reference: ForeignKeyReference,
    constraintName?: string,
  ): Promise<void> {
    const foreignKey = new SQLiteSchemaCompiler(identifier => this.connection.getDialect().quoteIdentifier(identifier))
      .compileTableForeignKey(tableName, columnName, reference, constraintName)
    await this.rebuildSqliteTable(tableName, (structure, definitions) => {
      if (structure.foreignKeys.some(existing => existing.name === foreignKey.name)) {
        throw new SchemaError(`SQLite cannot add foreign key "${foreignKey.name}" to table "${tableName}" because the table already has a foreign key with that name.`)
      }
      return [...definitions, foreignKey.definition]
    })
  }

  private async dropSqliteForeignKey(tableName: string, constraintName: string, columns?: readonly string[]): Promise<void> {
    const unnamedColumn = columns?.length === 1 ? columns[0] : undefined
    await this.rebuildSqliteTable(tableName, (_structure, definitions) => {
      const kept = withoutForeignKeyDefinitions(definitions, foreignKey => foreignKey.name === undefined
        ? foreignKey.column === unnamedColumn
        : foreignKey.name === constraintName)
      if (!kept) {
        throw new SchemaError(`SQLite cannot drop missing foreign key "${constraintName}" on table "${tableName}".`)
      }
      return kept
    })
  }

  private async dropSqliteInlineUnique(tableName: string, indexName: string, columns?: readonly string[]): Promise<boolean> {
    const indexes = (await this.readTableStructure(tableName))?.indexes ?? []
    const index = indexes.find(candidate => candidate.name === indexName)
    const inlineColumns = index ? (index.name.startsWith('sqlite_autoindex_') ? index.columns : undefined) : columns
    if (!inlineColumns) {
      return false
    }

    await this.rebuildSqliteTable(tableName, (_structure, definitions) => {
      const kept = withoutUniqueDefinitions(definitions, inlineColumns)
      if (!kept) {
        throw new SchemaError(`SQLite cannot drop missing unique "${indexName}" on table "${tableName}".`)
      }
      return kept
    })
    return true
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
    const referencingTables = await listSQLiteReferencingTables(this.connection, tableName)
    if (referencingTables.length > 0) {
      throw new SchemaError(
        `SQLite cannot rebuild table "${tableName}" inside a transaction while foreign-key enforcement is on, because table "${referencingTables.join('", "')}" references it. Run the change outside the transaction or in a migration.`,
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
    const structure = await this.readTableStructure(tableName)
    if (!structure) {
      throw new SchemaError(`SQLite cannot rebuild table "${tableName}" because it does not exist.`)
    }

    const temporaryTableName = `__holo_rebuild_${tableName.replaceAll('.', '_')}`
    if (await this.hasTable(temporaryTableName)) {
      throw new SchemaError(
        `SQLite cannot rebuild table "${tableName}" because temporary table "${temporaryTableName}" already exists.`,
      )
    }

    const currentSql = splitCreateTableSql(await readSQLiteCreateTableSql(this.connection, tableName) ?? '')
    if (!currentSql) {
      throw new SchemaError(`SQLite cannot read the definition of table "${tableName}" to rebuild it.`)
    }

    const schemaObjects = await readSQLiteTableObjects(this.connection, tableName)
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

    for (const object of schemaObjects) {
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
}

export function createSchemaService(connection: DatabaseContext): SchemaService {
  return new SchemaService(connection)
}
