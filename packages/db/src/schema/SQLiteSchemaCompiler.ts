import { SQLSchemaCompiler } from './SQLSchemaCompiler'
import { compileDialectDefaultLiteral } from './defaultLiterals'
import { assertValidIdentifierPath } from './identifiers'
import { resolveDialectColumnType } from './typeMapping'
import type { DDLStatement } from './ddl'
import type { ColumnDefinition, TableDefinition } from './types'

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

  compileRebuildTable(table: TableDefinition, temporaryTableName: string): DDLStatement {
    assertValidIdentifierPath(temporaryTableName, 'Table name')
    return {
      sql: `CREATE TABLE ${this.compileIdentifierPath(temporaryTableName)} (${this.compileTableDefinitions(table).join(', ')})`,
      source: `schema:sqliteRebuild:create:${table.tableName}`,
    }
  }
}
