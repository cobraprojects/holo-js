import { SchemaError } from '../core/errors'
import { assertValidTablePath, assertValidIdentifierSegment, quoteTablePath, splitTablePath } from './identifiers'
import { listTablePrimaryKeyColumns } from './tablePrimaryKey'
import { assertSupportedColumnDefaultValue } from './defaultLiterals'
import { assertUniqueResolvedIndexNames, assertValidIndexName, resolveGeneratedCheckName, resolveGeneratedForeignKeyName, resolveGeneratedIndexName, resolveGeneratedUniqueIndexName } from './generatedNames'
import type { AnyColumnDefinition, ForeignKeyReference, TableDefinition, TableIndexDefinition } from './types'
import type { DDLOperation, DDLStatement, UniqueBacking } from './ddl'

type IdentifierQuoter = (identifier: string) => string

const REFERENTIAL_ACTIONS = new Set(['cascade', 'restrict', 'set null', 'no action'])

function compileReferentialAction(clause: 'DELETE' | 'UPDATE', action: string): string {
  const normalized = action.toLowerCase()
  if (!REFERENTIAL_ACTIONS.has(normalized)) {
    throw new SchemaError(`Foreign key ON ${clause} action "${action}" is not supported.`)
  }

  return `ON ${clause} ${normalized.toUpperCase()}`
}

export abstract class SQLSchemaCompiler {
  constructor(protected readonly quoteIdentifier: IdentifierQuoter) {}

  compile(operation: DDLOperation): DDLStatement[] {
    if (operation.kind === 'createTable') {
      return this.compileCreateTable(operation.table)
    }

    if (operation.kind === 'addColumn') {
      return [
        this.compileAddColumn(operation.tableName, operation.column),
        ...this.compileAddedColumnIndexes(operation.tableName, operation.column),
      ]
    }

    if (operation.kind === 'dropColumn') {
      return [this.compileDropColumn(operation.tableName, operation.columnName)]
    }

    if (operation.kind === 'renameColumn') {
      return [this.compileRenameColumn(operation.tableName, operation.fromColumnName, operation.toColumnName)]
    }

    if (operation.kind === 'alterColumn') {
      return this.compileAlterColumn(operation.tableName, operation.column)
    }

    if (operation.kind === 'createForeignKey') {
      return [this.compileCreateForeignKey(
        operation.tableName,
        operation.columnName,
        operation.reference,
        operation.constraintName,
      )]
    }

    if (operation.kind === 'dropForeignKey') {
      return [this.compileDropForeignKey(operation.tableName, operation.constraintName)]
    }

    if (operation.kind === 'createPrimaryKey') {
      return [this.compileCreatePrimaryKey(operation.tableName, operation.columns, operation.constraintName)]
    }

    if (operation.kind === 'dropPrimaryKey') {
      return [this.compileDropPrimaryKey(operation.tableName, operation.constraintName)]
    }

    if (operation.kind === 'createIndex') {
      return [this.compileCreateIndex(operation.tableName, operation.index)]
    }

    if (operation.kind === 'dropIndex') {
      return [this.compileDropIndex(operation.tableName, operation.indexName)]
    }

    if (operation.kind === 'dropUnique') {
      return [this.compileDropUnique(operation.tableName, operation.indexName, operation.backedBy)]
    }

    if (operation.kind === 'renameTable') {
      return [this.compileRenameTable(operation.fromTableName, operation.toTableName)]
    }

    if (operation.kind === 'renameIndex') {
      return [this.compileRenameIndex(operation.tableName, operation.fromIndexName, operation.toIndexName)]
    }

    assertValidTablePath(operation.tableName, 'Table name')
    return [{
      sql: `DROP TABLE IF EXISTS ${this.compileIdentifierPath(operation.tableName)}`,
      source: `schema:dropTable:${operation.tableName}`,
    }]
  }

  compileCreateTable(table: TableDefinition): DDLStatement[] {
    return [
      this.compileTableCreation(table),
      ...this.resolveCreateTableIndexes(table).map(index => this.compileCreateIndex(table.tableName, index)),
    ]
  }

  compileTableCreation(table: TableDefinition): DDLStatement {
    assertValidTablePath(table.tableName, 'Table name')
    const { table: definedTable, primaryKeyConstraint } = this.resolveTablePrimaryKeyConstraint(table)
    const columnSql = [
      ...this.compileTableDefinitions(definedTable),
      ...(primaryKeyConstraint ? [primaryKeyConstraint] : []),
      ...this.compileUniqueConstraints(table.tableName, this.resolveColumnUniqueIndexes(table.tableName, Object.values(definedTable.columns))),
    ]
    return {
      sql: `CREATE TABLE IF NOT EXISTS ${this.compileIdentifierPath(table.tableName)} (${columnSql.join(', ')})`,
      source: `schema:createTable:${table.tableName}`,
    }
  }

  resolveCreateTableIndexes(table: TableDefinition): TableIndexDefinition[] {
    const definedColumns = Object.values(this.resolveTablePrimaryKeyConstraint(table).table.columns)
    const columnUniqueIndexes = this.resolveColumnUniqueIndexes(table.tableName, definedColumns)
    const declaredIndexes = table.indexes.filter(index => !columnUniqueIndexes.some(columnUnique => this.isSameIndex(table.tableName, columnUnique, index)))
    assertUniqueResolvedIndexNames(table.tableName, [...declaredIndexes, ...columnUniqueIndexes])
    return [...declaredIndexes, ...this.resolveStandaloneUniqueIndexes(columnUniqueIndexes)]
      .map(index => ({ ...index, name: this.resolveIndexName(table.tableName, index) }))
  }

  private resolveTablePrimaryKeyConstraint(table: TableDefinition): { table: TableDefinition, primaryKeyConstraint?: string } {
    const primaryKeyColumns = listTablePrimaryKeyColumns(table)
    const [onlyPrimaryKeyColumn, ...otherPrimaryKeyColumns] = primaryKeyColumns.flatMap(name => table.columns[name] ?? [])
    if (onlyPrimaryKeyColumn && otherPrimaryKeyColumns.length === 0 && this.keepsPrimaryKeyInline(onlyPrimaryKeyColumn)) {
      return { table }
    }
    if (primaryKeyColumns.length < 2 && !table.primaryKeyName) {
      return { table }
    }

    const columns = Object.fromEntries(Object.entries(table.columns).map(([name, column]) => [name, { ...column, primaryKey: false }]))
    return {
      table: { ...table, columns },
      primaryKeyConstraint: this.compilePrimaryKeyConstraint(primaryKeyColumns, table.primaryKeyName),
    }
  }

  compilePrimaryKeyConstraint(columns: readonly string[], name?: string): string {
    const quotedColumns = columns.map((column) => {
      assertValidIdentifierSegment(column, 'Primary key column')
      return this.quoteIdentifier(column)
    }).join(', ')
    const constraint = name ? `${this.compileNamedConstraint(name, 'Primary key name')} ` : ''
    return `${constraint}PRIMARY KEY (${quotedColumns})`
  }

  resolveColumnUniqueIndexes(tableName: string, columns: readonly AnyColumnDefinition[]): TableIndexDefinition[] {
    return columns
      .filter(column => column.unique && !column.primaryKey)
      .map(column => ({ columns: [column.name], unique: true, name: resolveGeneratedUniqueIndexName(tableName, [column.name]) }))
  }

  private isSameIndex(tableName: string, left: TableIndexDefinition, right: TableIndexDefinition): boolean {
    return left.unique === right.unique
      && left.columns.join('|') === right.columns.join('|')
      && this.resolveIndexName(tableName, left) === this.resolveIndexName(tableName, right)
  }

  protected compileUniqueConstraints(tableName: string, indexes: readonly TableIndexDefinition[]): string[] {
    return indexes.map(index => `CONSTRAINT ${this.quoteIdentifier(this.resolveIndexName(tableName, index))} UNIQUE (${index.columns.map(column => this.quoteIdentifier(column)).join(', ')})`)
  }

  protected resolveStandaloneUniqueIndexes(_indexes: readonly TableIndexDefinition[]): TableIndexDefinition[] {
    return []
  }

  compileAddedColumnIndexes(tableName: string, column: AnyColumnDefinition): DDLStatement[] {
    return this.resolveStandaloneUniqueIndexes(this.resolveColumnUniqueIndexes(tableName, [column]))
      .map(index => this.compileCreateIndex(tableName, index))
  }

  compileAddColumn(tableName: string, column: AnyColumnDefinition): DDLStatement {
    assertValidTablePath(tableName, 'Table name')
    const uniqueConstraints = this.compileUniqueConstraints(tableName, this.resolveColumnUniqueIndexes(tableName, [column]))
      .map(constraint => `, ADD ${constraint}`)
      .join('')
    return {
      sql: `ALTER TABLE ${this.compileIdentifierPath(tableName)} ADD COLUMN ${this.compileColumn(tableName, column)}${uniqueConstraints}`,
      source: `schema:addColumn:${tableName}:${column.name}`,
    }
  }

  compileDropColumn(tableName: string, columnName: string): DDLStatement {
    assertValidTablePath(tableName, 'Table name')
    assertValidIdentifierSegment(columnName, 'Column name')
    return {
      sql: `ALTER TABLE ${this.compileIdentifierPath(tableName)} DROP COLUMN ${this.quoteIdentifier(columnName)}`,
      source: `schema:dropColumn:${tableName}:${columnName}`,
    }
  }

  compileRenameColumn(tableName: string, fromColumnName: string, toColumnName: string): DDLStatement {
    assertValidTablePath(tableName, 'Table name')
    assertValidIdentifierSegment(fromColumnName, 'Column name')
    assertValidIdentifierSegment(toColumnName, 'Column name')
    return {
      sql: `ALTER TABLE ${this.compileIdentifierPath(tableName)} RENAME COLUMN ${this.quoteIdentifier(fromColumnName)} TO ${this.quoteIdentifier(toColumnName)}`,
      source: `schema:renameColumn:${tableName}:${fromColumnName}:${toColumnName}`,
    }
  }

  compileAlterColumn(tableName: string, column: AnyColumnDefinition): DDLStatement[] {
    assertValidTablePath(tableName, 'Table name')
    this.assertSupportedAlterColumnDefinition(column)
    return [{
      sql: `ALTER TABLE ${this.compileIdentifierPath(tableName)} MODIFY COLUMN ${this.compileColumn(tableName, column)}`,
      source: `schema:alterColumn:${tableName}:${column.name}`,
    }]
  }

  compileCreateForeignKey(
    tableName: string,
    columnName: string,
    reference: ForeignKeyReference,
    constraintName?: string,
  ): DDLStatement {
    assertValidTablePath(tableName, 'Table name')
    const resolvedConstraintName = this.resolveForeignKeyName(tableName, columnName, constraintName)
    return {
      sql: `ALTER TABLE ${this.compileIdentifierPath(tableName)} ADD ${this.compileForeignKeyConstraint(tableName, columnName, reference, resolvedConstraintName)}`,
      source: `schema:createForeignKey:${tableName}:${resolvedConstraintName}`,
    }
  }

  protected compileForeignKeyConstraint(
    tableName: string,
    columnName: string,
    reference: ForeignKeyReference,
    constraintName: string,
  ): string {
    assertValidIdentifierSegment(columnName, 'Column name')
    return `${this.compileNamedConstraint(constraintName)} FOREIGN KEY (${this.quoteIdentifier(columnName)}) ${this.compileReferencesClause(tableName, columnName, reference)}`
  }

  private compileColumnForeignKeyConstraint(tableName: string, column: AnyColumnDefinition): string | undefined {
    if (!column.references) {
      return undefined
    }

    const constraintName = this.resolveForeignKeyName(tableName, column.name, column.references.constraintName)
    return `${this.compileNamedConstraint(constraintName)} ${this.compileReferencesClause(tableName, column.name, column.references)}`
  }

  protected compileReferencedTable(_tableName: string, _columnName: string, referencedTable: string): string {
    return this.compileIdentifierPath(referencedTable)
  }

  private compileNamedConstraint(constraintName: string, label = 'Foreign key name'): string {
    assertValidIdentifierSegment(constraintName, label)
    return `CONSTRAINT ${this.quoteIdentifier(constraintName)}`
  }

  private compileReferencesClause(tableName: string, columnName: string, reference: ForeignKeyReference): string {
    assertValidIdentifierSegment(reference.column, 'Referenced column name')
    if (!reference.table) {
      throw new SchemaError(
        `Foreign key column "${columnName}" must include a referenced table for ${this.getDialectLabel()} compilation.`,
      )
    }

    const parts = [
      `REFERENCES ${this.compileReferencedTable(tableName, columnName, reference.table)} (${this.quoteIdentifier(reference.column)})`,
    ]

    if (reference.onDelete) {
      parts.push(compileReferentialAction('DELETE', reference.onDelete))
    }

    if (reference.onUpdate) {
      parts.push(compileReferentialAction('UPDATE', reference.onUpdate))
    }

    return parts.join(' ')
  }

  compileDropForeignKey(tableName: string, constraintName: string): DDLStatement {
    assertValidTablePath(tableName, 'Table name')
    assertValidIdentifierSegment(constraintName, 'Foreign key name')
    return {
      sql: `ALTER TABLE ${this.compileIdentifierPath(tableName)} DROP CONSTRAINT ${this.quoteIdentifier(constraintName)}`,
      source: `schema:dropForeignKey:${tableName}:${constraintName}`,
    }
  }

  compileCreatePrimaryKey(tableName: string, columns: readonly string[], constraintName?: string): DDLStatement {
    assertValidTablePath(tableName, 'Table name')
    return {
      sql: `ALTER TABLE ${this.compileIdentifierPath(tableName)} ADD ${this.compilePrimaryKeyConstraint(columns, constraintName)}`,
      source: `schema:createPrimaryKey:${tableName}`,
    }
  }

  compileDropPrimaryKey(tableName: string, constraintName: string): DDLStatement {
    assertValidTablePath(tableName, 'Table name')
    assertValidIdentifierSegment(constraintName, 'Primary key name')
    return {
      sql: `ALTER TABLE ${this.compileIdentifierPath(tableName)} DROP CONSTRAINT ${this.quoteIdentifier(constraintName)}`,
      source: `schema:dropPrimaryKey:${tableName}:${constraintName}`,
    }
  }

  compileCreateIndex(tableName: string, index: TableIndexDefinition): DDLStatement {
    assertValidTablePath(tableName, 'Table name')
    const indexName = this.resolveIndexName(tableName, index)
    const quotedColumns = index.columns.map((column) => {
      assertValidIdentifierSegment(column, 'Index column')
      return this.quoteIdentifier(column)
    }).join(', ')

    return {
      sql: `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${this.compileIndexNameOnTable(tableName, indexName)} (${quotedColumns})`,
      source: `schema:createIndex:${tableName}:${indexName}`,
    }
  }

  protected compileIndexNameOnTable(tableName: string, indexName: string): string {
    return `${this.quoteIdentifier(indexName)} ON ${this.compileIdentifierPath(tableName)}`
  }

  compileDropIndex(tableName: string, indexName: string): DDLStatement {
    assertValidTablePath(tableName, 'Table name')
    assertValidIndexName(indexName)

    return {
      sql: `DROP INDEX ${this.compileTableSchemaIndexPath(tableName, indexName)}`,
      source: `schema:dropIndex:${tableName}:${indexName}`,
    }
  }

  compileDropUnique(tableName: string, indexName: string, backedBy: UniqueBacking): DDLStatement {
    assertValidTablePath(tableName, 'Table name')
    assertValidIndexName(indexName)
    const sql = backedBy === 'constraint'
      ? `ALTER TABLE ${this.compileIdentifierPath(tableName)} DROP CONSTRAINT ${this.quoteIdentifier(indexName)}`
      : `DROP INDEX ${this.compileTableSchemaIndexPath(tableName, indexName)}`

    return {
      sql,
      source: `schema:dropUnique:${tableName}:${indexName}`,
    }
  }

  compileRenameTable(fromTableName: string, toTableName: string): DDLStatement {
    assertValidTablePath(fromTableName, 'Table name')
    assertValidTablePath(toTableName, 'Table name')

    return {
      sql: `ALTER TABLE ${this.compileIdentifierPath(fromTableName)} RENAME TO ${this.compileIdentifierPath(toTableName)}`,
      source: `schema:renameTable:${fromTableName}:${toTableName}`,
    }
  }

  compileRenameIndex(tableName: string, fromIndexName: string, toIndexName: string): DDLStatement {
    assertValidTablePath(tableName, 'Table name')
    assertValidIndexName(fromIndexName)
    assertValidIndexName(toIndexName)

    return {
      sql: `ALTER INDEX ${this.compileTableSchemaIndexPath(tableName, fromIndexName)} RENAME TO ${this.quoteIdentifier(toIndexName)}`,
      source: `schema:renameIndex:${tableName}:${fromIndexName}:${toIndexName}`,
    }
  }

  protected compileTableSchemaIndexPath(tableName: string, indexName: string): string {
    const { schema } = splitTablePath(tableName)
    return this.compileIdentifierPath(schema === undefined ? indexName : `${schema}.${indexName}`)
  }

  protected compileTableDefinitions(table: TableDefinition): string[] {
    return Object.values(table.columns).map(column => this.compileColumn(table.tableName, column, table.primaryKeyName))
  }

  protected keepsPrimaryKeyInline(_column: AnyColumnDefinition): boolean {
    return false
  }

  protected compileColumn(tableName: string, column: AnyColumnDefinition, primaryKeyName?: string): string {
    const definition = this.compileColumnDefinition(tableName, column, primaryKeyName)
    const enumCheck = this.compileEnumCheckConstraint(tableName, column)
    return enumCheck ? `${definition} ${enumCheck}` : definition
  }

  protected compileColumnDefinition(tableName: string, column: AnyColumnDefinition, primaryKeyName?: string): string {
    assertValidIdentifierSegment(column.name, 'Column name')
    const parts = [
      this.quoteIdentifier(column.name),
      this.compileColumnType(column),
      ...(column.computed ? [`GENERATED ALWAYS AS (${column.computed.expression}) ${column.computed.stored ? 'STORED' : 'VIRTUAL'}`] : []),
    ]

    if (column.primaryKey) {
      if (primaryKeyName) parts.push(this.compileNamedConstraint(primaryKeyName, 'Primary key name'))
      parts.push('PRIMARY KEY')
      this.appendPrimaryKeyExtras(parts, column)
    }

    if (this.compilesNotNull(column)) {
      parts.push('NOT NULL')
    }

    if (column.defaultKind === 'value') {
      this.assertSupportedDefaultValue(column.defaultValue, column)
      parts.push(`DEFAULT ${this.compileDefaultValue(column.defaultValue, column)}`)
    } else if (column.defaultKind === 'now') {
      parts.push(`DEFAULT ${this.compileCurrentTimestamp()}`)
    } else if (column.defaultKind === 'expression') {
      parts.push(`DEFAULT ${this.compileDefaultExpression(column)}`)
    }

    const foreignKeyConstraint = this.compileColumnForeignKeyConstraint(tableName, column)
    if (foreignKeyConstraint) {
      parts.push(foreignKeyConstraint)
    }

    return parts.join(' ')
  }

  protected compilesNotNull(column: AnyColumnDefinition): boolean {
    return !column.nullable && (!column.computed || column.explicitNotNull === true)
  }

  protected compileEnumCheckConstraint(tableName: string, column: AnyColumnDefinition): string | undefined {
    if (column.kind !== 'enum') {
      return undefined
    }

    if (!column.enumValues || column.enumValues.length === 0) {
      throw new SchemaError(`Enum column "${column.name}" requires at least one allowed value.`)
    }

    const allowedValues = column.enumValues
      .map(value => this.compileDefaultValue(value, column))
      .join(', ')
    const constraintName = this.quoteIdentifier(resolveGeneratedCheckName(tableName, column.name))
    return `CONSTRAINT ${constraintName} CHECK (${this.quoteIdentifier(column.name)} IN (${allowedValues}))`
  }

  protected appendPrimaryKeyExtras(_parts: string[], _column: AnyColumnDefinition): void {}

  protected compileDefaultExpression(column: AnyColumnDefinition): string {
    if (typeof column.defaultValue !== 'string' || column.defaultValue.trim() === '') {
      throw new SchemaError(`Column "${column.name}" has an expression default without SQL text.`)
    }

    return column.defaultValue
  }

  protected compileCurrentTimestamp(): string {
    return 'CURRENT_TIMESTAMP'
  }

  protected compileIdentifierPath(identifier: string): string {
    assertValidTablePath(identifier, 'Identifier path')
    return quoteTablePath({ quoteIdentifier: identifier => this.quoteIdentifier(identifier) }, identifier)
  }

  protected assertSupportedDefaultValue(value: unknown, column: AnyColumnDefinition): void {
    assertSupportedColumnDefaultValue(column.name, column.kind, value, this.getDialectLabel())
  }

  protected resolveIndexName(tableName: string, index: TableIndexDefinition): string {
    return resolveGeneratedIndexName(tableName, index)
  }

  protected resolveForeignKeyName(tableName: string, columnName: string, constraintName?: string): string {
    return resolveGeneratedForeignKeyName(tableName, columnName, constraintName)
  }

  protected assertSupportedAlterColumnDefinition(column: AnyColumnDefinition): void {
    if (column.primaryKey || column.unique || column.references || column.kind === 'id') {
      throw new SchemaError(
        `Column "${column.name}" cannot be altered through alterColumn(); use dedicated schema operations for keys, indexes, and foreign keys.`,
      )
    }
  }

  abstract getDialectLabel(): string
  protected abstract compileColumnType(column: AnyColumnDefinition): string
  protected abstract compileDefaultValue(value: unknown, column: AnyColumnDefinition): string
}
