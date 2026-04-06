import { SchemaError } from '../core/errors'
import { assertValidIdentifierPath, assertValidIdentifierSegment, sanitizeIdentifierForGeneratedName } from './identifiers'
import type { AnyColumnDefinition, TableDefinition, TableIndexDefinition } from './types'
import type { DDLOperation, DDLStatement } from './ddl'

type IdentifierQuoter = (identifier: string) => string

export abstract class SQLSchemaCompiler {
  constructor(protected readonly quoteIdentifier: IdentifierQuoter) {}

  compile(operation: DDLOperation): DDLStatement[] {
    if (operation.kind === 'createTable') {
      return this.compileCreateTable(operation.table)
    }

    if (operation.kind === 'addColumn') {
      return [this.compileAddColumn(operation.tableName, operation.column)]
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

    if (operation.kind === 'createIndex') {
      return [this.compileCreateIndex(operation.tableName, operation.index)]
    }

    if (operation.kind === 'dropIndex') {
      return [this.compileDropIndex(operation.tableName, operation.indexName)]
    }

    if (operation.kind === 'renameTable') {
      return [this.compileRenameTable(operation.fromTableName, operation.toTableName)]
    }

    if (operation.kind === 'renameIndex') {
      return [this.compileRenameIndex(operation.tableName, operation.fromIndexName, operation.toIndexName)]
    }

    assertValidIdentifierPath(operation.tableName, 'Table name')
    return [{
      sql: `DROP TABLE IF EXISTS ${this.compileIdentifierPath(operation.tableName)}`,
      source: `schema:dropTable:${operation.tableName}`,
    }]
  }

  compileCreateTable(table: TableDefinition): DDLStatement[] {
    assertValidIdentifierPath(table.tableName, 'Table name')
    const columnSql = Object.values(table.columns).map(column => this.compileColumn(column))
    const sql = `CREATE TABLE IF NOT EXISTS ${this.compileIdentifierPath(table.tableName)} (${columnSql.join(', ')})`
    const statements: DDLStatement[] = [{
      sql,
      source: `schema:createTable:${table.tableName}`,
    }]

    for (const index of table.indexes) {
      statements.push(this.compileCreateIndex(table.tableName, index))
    }

    return statements
  }

  compileAddColumn(tableName: string, column: AnyColumnDefinition): DDLStatement {
    assertValidIdentifierPath(tableName, 'Table name')
    return {
      sql: `ALTER TABLE ${this.compileIdentifierPath(tableName)} ADD COLUMN ${this.compileColumn(column)}`,
      source: `schema:addColumn:${tableName}:${column.name}`,
    }
  }

  compileDropColumn(tableName: string, columnName: string): DDLStatement {
    assertValidIdentifierPath(tableName, 'Table name')
    assertValidIdentifierSegment(columnName, 'Column name')
    return {
      sql: `ALTER TABLE ${this.compileIdentifierPath(tableName)} DROP COLUMN ${this.quoteIdentifier(columnName)}`,
      source: `schema:dropColumn:${tableName}:${columnName}`,
    }
  }

  compileRenameColumn(tableName: string, fromColumnName: string, toColumnName: string): DDLStatement {
    assertValidIdentifierPath(tableName, 'Table name')
    assertValidIdentifierSegment(fromColumnName, 'Column name')
    assertValidIdentifierSegment(toColumnName, 'Column name')
    return {
      sql: `ALTER TABLE ${this.compileIdentifierPath(tableName)} RENAME COLUMN ${this.quoteIdentifier(fromColumnName)} TO ${this.quoteIdentifier(toColumnName)}`,
      source: `schema:renameColumn:${tableName}:${fromColumnName}:${toColumnName}`,
    }
  }

  compileAlterColumn(tableName: string, column: AnyColumnDefinition): DDLStatement[] {
    assertValidIdentifierPath(tableName, 'Table name')
    this.assertSupportedAlterColumnDefinition(column)
    return [{
      sql: `ALTER TABLE ${this.compileIdentifierPath(tableName)} MODIFY COLUMN ${this.compileColumn(column)}`,
      source: `schema:alterColumn:${tableName}:${column.name}`,
    }]
  }

  compileCreateForeignKey(
    tableName: string,
    columnName: string,
    reference: NonNullable<AnyColumnDefinition['references']>,
    constraintName?: string,
  ): DDLStatement {
    assertValidIdentifierPath(tableName, 'Table name')
    assertValidIdentifierSegment(columnName, 'Column name')
    if (!reference.table) {
      throw new SchemaError(
        `Foreign key column "${columnName}" must include a referenced table for ${this.getDialectLabel()} compilation.`,
      )
    }

    const resolvedConstraintName = this.resolveForeignKeyName(tableName, columnName, constraintName)
    const parts = [
      `ALTER TABLE ${this.compileIdentifierPath(tableName)}`,
      `ADD CONSTRAINT ${this.quoteIdentifier(resolvedConstraintName)}`,
      `FOREIGN KEY (${this.quoteIdentifier(columnName)})`,
      `REFERENCES ${this.compileIdentifierPath(reference.table)} (${this.quoteIdentifier(reference.column)})`,
    ]

    if (reference.onDelete) {
      parts.push(`ON DELETE ${reference.onDelete.toUpperCase()}`)
    }

    if (reference.onUpdate) {
      parts.push(`ON UPDATE ${reference.onUpdate.toUpperCase()}`)
    }

    return {
      sql: parts.join(' '),
      source: `schema:createForeignKey:${tableName}:${resolvedConstraintName}`,
    }
  }

  compileDropForeignKey(tableName: string, constraintName: string): DDLStatement {
    assertValidIdentifierPath(tableName, 'Table name')
    assertValidIdentifierSegment(constraintName, 'Foreign key name')
    return {
      sql: `ALTER TABLE ${this.compileIdentifierPath(tableName)} DROP CONSTRAINT ${this.quoteIdentifier(constraintName)}`,
      source: `schema:dropForeignKey:${tableName}:${constraintName}`,
    }
  }

  compileCreateIndex(tableName: string, index: TableIndexDefinition): DDLStatement {
    assertValidIdentifierPath(tableName, 'Table name')
    const indexName = this.resolveIndexName(tableName, index)
    const quotedColumns = index.columns.map((column) => {
      assertValidIdentifierSegment(column, 'Index column')
      return this.quoteIdentifier(column)
    }).join(', ')

    return {
      sql: `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${this.quoteIdentifier(indexName)} ON ${this.compileIdentifierPath(tableName)} (${quotedColumns})`,
      source: `schema:createIndex:${tableName}:${indexName}`,
    }
  }

  compileDropIndex(tableName: string, indexName: string): DDLStatement {
    assertValidIdentifierPath(tableName, 'Table name')
    assertValidIdentifierSegment(indexName, 'Index name')

    return {
      sql: `DROP INDEX IF EXISTS ${this.quoteIdentifier(indexName)}`,
      source: `schema:dropIndex:${tableName}:${indexName}`,
    }
  }

  compileRenameTable(fromTableName: string, toTableName: string): DDLStatement {
    assertValidIdentifierPath(fromTableName, 'Table name')
    assertValidIdentifierPath(toTableName, 'Table name')

    return {
      sql: `ALTER TABLE ${this.compileIdentifierPath(fromTableName)} RENAME TO ${this.compileIdentifierPath(toTableName)}`,
      source: `schema:renameTable:${fromTableName}:${toTableName}`,
    }
  }

  compileRenameIndex(tableName: string, fromIndexName: string, toIndexName: string): DDLStatement {
    assertValidIdentifierPath(tableName, 'Table name')
    assertValidIdentifierSegment(fromIndexName, 'Index name')
    assertValidIdentifierSegment(toIndexName, 'Index name')

    return {
      sql: `ALTER INDEX ${this.quoteIdentifier(fromIndexName)} RENAME TO ${this.quoteIdentifier(toIndexName)}`,
      source: `schema:renameIndex:${tableName}:${fromIndexName}:${toIndexName}`,
    }
  }

  protected compileColumn(column: AnyColumnDefinition): string {
    assertValidIdentifierSegment(column.name, 'Column name')
    const parts = [
      this.quoteIdentifier(column.name),
      this.compileColumnType(column),
    ]

    if (column.primaryKey) {
      parts.push('PRIMARY KEY')
      this.appendPrimaryKeyExtras(parts, column)
    }

    if (!column.nullable) {
      parts.push('NOT NULL')
    }

    if (column.unique && !column.primaryKey) {
      parts.push('UNIQUE')
    }

    if (column.defaultKind === 'value') {
      this.assertSupportedDefaultValue(column.defaultValue, column)
      parts.push(`DEFAULT ${this.compileDefaultValue(column.defaultValue)}`)
    } else if (column.defaultKind === 'now') {
      parts.push(`DEFAULT ${this.compileCurrentTimestamp()}`)
    }

    if (column.references) {
      const referenceTable = column.references.table as string
      parts.push(
        `REFERENCES ${this.compileIdentifierPath(referenceTable)} (${this.quoteIdentifier(column.references.column)})`,
      )

      if (column.references.onDelete) {
        parts.push(`ON DELETE ${column.references.onDelete.toUpperCase()}`)
      }

      if (column.references.onUpdate) {
        parts.push(`ON UPDATE ${column.references.onUpdate.toUpperCase()}`)
      }
    }

    return parts.join(' ')
  }

  protected appendPrimaryKeyExtras(_parts: string[], _column: AnyColumnDefinition): void {}

  protected compileCurrentTimestamp(): string {
    return 'CURRENT_TIMESTAMP'
  }

  protected compileIdentifierPath(identifier: string): string {
    assertValidIdentifierPath(identifier, 'Identifier path')
    if (!identifier.includes('.')) {
      return this.quoteIdentifier(identifier)
    }

    return identifier
      .split('.')
      .map(part => this.quoteIdentifier(part))
      .join('.')
  }

  protected assertSupportedDefaultValue(value: unknown, column: AnyColumnDefinition): void {
    if (!this.isSupportedDefaultValue(value)) {
      throw new SchemaError(
        `Column "${column.name}" has a default value that cannot be compiled safely for ${this.getDialectLabel()}.`,
      )
    }
  }

  protected isSupportedDefaultValue(value: unknown): boolean {
    if (value === null) {
      return true
    }

    if (typeof value === 'boolean' || typeof value === 'string') {
      return true
    }

    if (typeof value === 'number') {
      return Number.isFinite(value)
    }

    if (value instanceof Date) {
      return Number.isFinite(value.getTime())
    }

    if (value instanceof Uint8Array) {
      return false
    }

    if (Array.isArray(value)) {
      return value.every(entry => this.isSupportedDefaultValue(entry))
    }

    if (typeof value === 'object') {
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) {
        return false
      }

      return Object.values(value as Record<string, unknown>).every(entry => this.isSupportedDefaultValue(entry))
    }

    return false
  }

  protected resolveIndexName(tableName: string, index: TableIndexDefinition): string {
    const indexName = index.name ?? `${sanitizeIdentifierForGeneratedName(tableName)}_${index.columns.join('_')}_${index.unique ? 'unique' : 'index'}`
    assertValidIdentifierSegment(indexName, 'Index name')
    return indexName
  }

  protected resolveForeignKeyName(tableName: string, columnName: string, constraintName?: string): string {
    const resolvedName = constraintName ?? `${sanitizeIdentifierForGeneratedName(tableName)}_${columnName}_foreign`
    assertValidIdentifierSegment(resolvedName, 'Foreign key name')
    return resolvedName
  }

  protected assertSupportedAlterColumnDefinition(column: AnyColumnDefinition): void {
    if (column.primaryKey || column.unique || column.references || column.kind === 'id') {
      throw new SchemaError(
        `Column "${column.name}" cannot be altered through alterColumn(); use dedicated schema operations for keys, indexes, and foreign keys.`,
      )
    }
  }

  protected abstract getDialectLabel(): string
  protected abstract compileColumnType(column: AnyColumnDefinition): string
  protected abstract compileDefaultValue(value: unknown): string
}
