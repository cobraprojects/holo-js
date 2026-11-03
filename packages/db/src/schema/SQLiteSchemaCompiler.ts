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

  override compileStandaloneUniqueIndexes(tableName: string, indexes: readonly TableIndexDefinition[]): DDLStatement[] {
    return indexes.map(index => this.compileCreateIndex(tableName, index))
  }

  compileRecreateIndex(tableName: string, fromIndexName: string, index: TableIndexDefinition): DDLStatement[] {
    return [this.compileDropIndex(tableName, fromIndexName), this.compileIndexCreation(tableName, index, '')]
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
