import { SQLSchemaCompiler } from './SQLSchemaCompiler'
import { compileDialectDefaultLiteral } from './defaultLiterals'
import { assertValidIdentifierPath } from './identifiers'
import { SchemaError } from '../core/errors'
import { withIndexName, withSchemaQualifiedName } from './introspection/sqlDefinitions'
import { resolveDialectColumnType } from './typeMapping'
import type { DDLStatement } from './ddl'
import type { SQLiteDependentObject, SQLiteTableObject } from './introspection/sqlite'
import type { AnyColumnDefinition, ColumnDefinition, ForeignKeyReference, TableIndexDefinition } from './types'

export class SQLiteSchemaCompiler extends SQLSchemaCompiler {
  protected override getDialectLabel(): string {
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

  protected override compileDefaultValue(value: unknown): string {
    return compileDialectDefaultLiteral('sqlite', value)
  }

  protected override compileUniqueConstraints(): string[] {
    return []
  }

  protected override resolveStandaloneUniqueIndexes(indexes: readonly TableIndexDefinition[]): TableIndexDefinition[] {
    return [...indexes]
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
    return [
      { sql: 'DELETE FROM sqlite_sequence WHERE name = ?', bindings: [temporaryTableName], source },
      { sql: 'UPDATE sqlite_sequence SET name = ? WHERE name = ?', bindings: [temporaryTableName, tableName], source },
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
    const renamedSql = withIndexName(createIndexSql, this.quoteIdentifier(toIndexName))
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
    return { name, definition: this.compileForeignKeyConstraint(columnName, reference, name) }
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

  compileChangedColumn(tableName: string, column: AnyColumnDefinition, preservedConstraints: readonly string[]): string {
    const changedParts = this.compileColumn(tableName, { ...column, primaryKey: false, references: undefined })
    return [changedParts, ...preservedConstraints].join(' ')
  }
}
