import { SQLSchemaCompiler } from './SQLSchemaCompiler'
import { compileColumnDefaultLiteral } from './defaultLiterals'
import { assertValidIdentifierPath, splitTablePath } from './identifiers'
import { SchemaError } from '../core/errors'
import { withIndexName, withSchemaQualifiedName } from './introspection/sqlDefinitions'
import { resolveDialectColumnType } from './typeMapping'
import type { DDLStatement } from './ddl'
import type { SQLiteDependentObject, SQLiteTableObject } from './introspection/sqlite'
import type { AnyColumnDefinition, ColumnDefinition, ForeignKeyReference, TableIndexDefinition } from './types'

export class SQLiteSchemaCompiler extends SQLSchemaCompiler {
  override getDialectLabel(): string {
    return 'SQLite'
  }

  protected override appendPrimaryKeyExtras(parts: string[], column: ColumnDefinition): void {
    if (column.idStrategy === 'autoIncrement') {
      parts.push('AUTOINCREMENT')
    }
  }

  protected override keepsPrimaryKeyInline(column: AnyColumnDefinition): boolean {
    return column.idStrategy === 'autoIncrement'
  }

  protected override compileColumnType(column: ColumnDefinition): string {
    return resolveDialectColumnType('sqlite', column)
  }

  protected override compileDefaultValue(value: unknown, column: AnyColumnDefinition): string {
    return compileColumnDefaultLiteral('sqlite', value, column.kind)
  }

  protected override compileDefaultExpression(column: AnyColumnDefinition): string {
    return `(${super.compileDefaultExpression(column)})`
  }

  protected override compileUniqueConstraints(): string[] {
    return []
  }

  protected override resolveStandaloneUniqueIndexes(indexes: readonly TableIndexDefinition[]): TableIndexDefinition[] {
    return [...indexes]
  }

  protected override compileIndexTarget(tableName: string, indexName: string): string {
    const { schema, table } = splitTablePath(tableName)
    if (schema === undefined) return super.compileIndexTarget(tableName, indexName)
    return `${this.compileIdentifierPath(`${schema}.${indexName}`)} ON ${this.quoteIdentifier(table)}`
  }

  protected override compileReferencedTable(tableName: string, columnName: string, referencedTable: string): string {
    assertValidIdentifierPath(referencedTable, 'Referenced table name')
    const referenced = splitTablePath(referencedTable)
    if (referenced.schema === undefined) return this.quoteIdentifier(referenced.table)
    const owningSchema = splitTablePath(tableName).schema ?? 'main'
    if (referenced.schema.toLowerCase() !== owningSchema.toLowerCase()) {
      throw new SchemaError(`SQLite foreign key "${columnName}" on table "${tableName}" cannot reference table "${referencedTable}" in another database.`)
    }
    return this.quoteIdentifier(referenced.table)
  }

  override compileRenameTable(fromTableName: string, toTableName: string): DDLStatement {
    assertValidIdentifierPath(fromTableName, 'Table name')
    assertValidIdentifierPath(toTableName, 'Table name')
    const from = splitTablePath(fromTableName)
    const to = splitTablePath(toTableName)
    if (to.schema !== undefined && to.schema.toLowerCase() !== (from.schema ?? 'main').toLowerCase()) {
      throw new SchemaError(`SQLite cannot move table "${fromTableName}" to another database as "${toTableName}".`)
    }

    return {
      sql: `ALTER TABLE ${this.compileIdentifierPath(fromTableName)} RENAME TO ${this.quoteIdentifier(to.table)}`,
      source: `schema:renameTable:${fromTableName}:${toTableName}`,
    }
  }

  compileForeignKeyEnforcementQuery(): DDLStatement {
    return { sql: 'PRAGMA foreign_keys', source: 'schema:sqliteRebuild:foreignKeys' }
  }

  compileForeignKeyViolationsQuery(tableName: string): DDLStatement {
    return { sql: 'PRAGMA foreign_key_check', source: `schema:sqliteRebuild:foreignKeyCheck:${tableName}` }
  }

  compileCopyTableRows(tableName: string, temporaryTableName: string, columnNames: readonly string[]): DDLStatement {
    const columns = columnNames.map(columnName => this.quoteIdentifier(columnName)).join(', ')
    return {
      sql: `INSERT INTO ${this.quoteIdentifier(temporaryTableName)} (${columns}) SELECT ${columns} FROM ${this.quoteIdentifier(tableName)}`,
      source: `schema:sqliteRebuild:copy:${tableName}`,
    }
  }

  compileMoveAutoIncrementSequence(tableName: string, temporaryTableName: string): DDLStatement[] {
    const source = `schema:sqliteRebuild:sequence:${tableName}`
    const { schema, table } = splitTablePath(tableName)
    const temporaryTable = splitTablePath(temporaryTableName).table
    const sequenceTable = schema === undefined ? 'sqlite_sequence' : `${this.compileIdentifierPath(schema)}.sqlite_sequence`
    return [
      { sql: `DELETE FROM ${sequenceTable} WHERE name = ?`, bindings: [temporaryTable], source },
      { sql: `UPDATE ${sequenceTable} SET name = ? WHERE name = ?`, bindings: [temporaryTable, table], source },
    ]
  }

  compileDropDependentObjects(objects: readonly SQLiteDependentObject[]): DDLStatement[] {
    return [...objects].reverse().map(object => ({
      sql: `DROP ${object.type === 'view' ? 'VIEW' : 'TRIGGER'} ${this.quoteIdentifier(object.schema)}.${this.quoteIdentifier(object.name)}`,
      source: `schema:sqliteRebuild:detach:${object.type}:${object.name}`,
    }))
  }

  compileRestoreSchemaObjects(objects: readonly (SQLiteTableObject | SQLiteDependentObject)[]): DDLStatement[] {
    return objects.map((object) => {
      const sql = withSchemaQualifiedName(object.sql, this.quoteIdentifier(object.schema))
      if (sql === undefined) {
        throw new SchemaError(`SQLite cannot read the definition of ${object.type} "${object.name}" to restore it.`)
      }
      return { sql, source: `schema:sqliteRebuild:restore:${object.type}:${object.name}` }
    })
  }

  compileRecreateIndex(tableName: string, fromIndexName: string, toIndexName: string, createIndexSql: string): DDLStatement[] | undefined {
    const { schema } = splitTablePath(tableName)
    const renamedSql = withIndexName(createIndexSql, this.compileIdentifierPath(schema === undefined ? toIndexName : `${schema}.${toIndexName}`))
    if (renamedSql === undefined) return undefined
    return [
      this.compileDropIndex(tableName, fromIndexName),
      { sql: renamedSql, source: `schema:renameIndex:${tableName}:${toIndexName}` },
    ]
  }

  compileTableForeignKey(
    tableName: string,
    columnName: string,
    reference: ForeignKeyReference,
    constraintName?: string,
  ): { name: string, definition: string } {
    const name = this.resolveForeignKeyName(tableName, columnName, constraintName)
    return { name, definition: this.compileForeignKeyConstraint(tableName, columnName, reference, name) }
  }

  compileRebuildTable(
    tableName: string,
    temporaryTableName: string,
    definitions: readonly string[],
    options: string,
  ): DDLStatement {
    assertValidIdentifierPath(temporaryTableName, 'Table name')
    const tableOptions = options ? ` ${options}` : ''
    return {
      sql: `CREATE TABLE ${this.compileIdentifierPath(temporaryTableName)} (${definitions.join(', ')})${tableOptions}`,
      source: `schema:sqliteRebuild:create:${tableName}`,
    }
  }

  compileAddedColumn(tableName: string, column: AnyColumnDefinition): string {
    return this.compileColumn(tableName, column)
  }

  compileChangedColumn(tableName: string, column: AnyColumnDefinition, preservedConstraints: readonly string[]): string {
    const changedParts = this.compileColumn(tableName, { ...column, primaryKey: false, references: undefined })
    return [changedParts, ...preservedConstraints].join(' ')
  }
}
