import { SQLSchemaCompiler } from './SQLSchemaCompiler'
import { compileDialectDefaultLiteral } from './defaultLiterals'
import { assertValidIdentifierPath } from './identifiers'
import { resolveDialectColumnType } from './typeMapping'
import type { DDLStatement } from './ddl'
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

  compileRecreateIndex(tableName: string, fromIndexName: string, index: TableIndexDefinition): DDLStatement[] {
    return [this.compileDropIndex(tableName, fromIndexName), this.compileCreateIndex(tableName, index)]
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
    definitions: readonly (string | AnyColumnDefinition)[],
    options: string,
  ): DDLStatement {
    assertValidIdentifierPath(temporaryTableName, 'Table name')
    const compiledDefinitions = definitions.map(definition => typeof definition === 'string'
      ? definition
      : this.compileRebuiltColumn(tableName, definition))
    const tableOptions = options ? ` ${options}` : ''
    return {
      sql: `CREATE TABLE ${this.compileIdentifierPath(temporaryTableName)} (${compiledDefinitions.join(', ')})${tableOptions}`,
      source: `schema:sqliteRebuild:create:${tableName}`,
    }
  }

  private compileRebuiltColumn(tableName: string, column: AnyColumnDefinition): string {
    const definition = this.compileColumn(tableName, column)
    return column.unique && !column.primaryKey ? `${definition} UNIQUE` : definition
  }
}
