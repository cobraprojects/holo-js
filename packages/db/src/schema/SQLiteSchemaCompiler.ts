import { SQLSchemaCompiler } from './SQLSchemaCompiler'
import { compileDialectDefaultLiteral } from './defaultLiterals'
import { assertValidIdentifierPath } from './identifiers'
import { resolveDialectColumnType } from './typeMapping'
import type { DDLStatement } from './ddl'
import type { AnyColumnDefinition, ColumnDefinition, TableIndexDefinition } from './types'

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

  compileRecreateIndex(tableName: string, fromIndexName: string, index: TableIndexDefinition): DDLStatement[] {
    return [this.compileDropIndex(tableName, fromIndexName), this.compileIndexCreation(tableName, index, '')]
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
      : this.compileColumn(tableName, definition))
    const tableOptions = options ? ` ${options}` : ''
    return {
      sql: `CREATE TABLE ${this.compileIdentifierPath(temporaryTableName)} (${compiledDefinitions.join(', ')})${tableOptions}`,
      source: `schema:sqliteRebuild:create:${tableName}`,
    }
  }
}
