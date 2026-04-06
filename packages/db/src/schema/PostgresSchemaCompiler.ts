import { SQLSchemaCompiler } from './SQLSchemaCompiler'
import { compileDialectDefaultLiteral } from './defaultLiterals'
import { resolveDialectColumnType } from './typeMapping'
import type { ColumnDefinition } from './types'

export class PostgresSchemaCompiler extends SQLSchemaCompiler {
  protected override getDialectLabel(): string {
    return 'Postgres'
  }

  protected override compileColumnType(column: ColumnDefinition): string {
    return resolveDialectColumnType('postgres', column)
  }

  protected override compileDefaultValue(value: unknown): string {
    return compileDialectDefaultLiteral('postgres', value)
  }

  override compileAlterColumn(tableName: string, column: ColumnDefinition): Array<{ sql: string, source: string }> {
    this.assertSupportedAlterColumnDefinition(column)
    const tableIdentifier = this.compileIdentifierPath(tableName)
    const columnIdentifier = this.quoteIdentifier(column.name)
    const statements: Array<{ sql: string, source: string }> = [{
      sql: `ALTER TABLE ${tableIdentifier} ALTER COLUMN ${columnIdentifier} TYPE ${this.compileColumnType(column)}`,
      source: `schema:alterColumn:${tableName}:${column.name}:type`,
    }]

    statements.push({
      sql: `ALTER TABLE ${tableIdentifier} ALTER COLUMN ${columnIdentifier} ${column.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`,
      source: `schema:alterColumn:${tableName}:${column.name}:nullability`,
    })

    if (column.defaultKind === 'value') {
      this.assertSupportedDefaultValue(column.defaultValue, column)
      statements.push({
        sql: `ALTER TABLE ${tableIdentifier} ALTER COLUMN ${columnIdentifier} SET DEFAULT ${this.compileDefaultValue(column.defaultValue)}`,
        source: `schema:alterColumn:${tableName}:${column.name}:default`,
      })
    } else if (column.defaultKind === 'now') {
      statements.push({
        sql: `ALTER TABLE ${tableIdentifier} ALTER COLUMN ${columnIdentifier} SET DEFAULT ${this.compileCurrentTimestamp()}`,
        source: `schema:alterColumn:${tableName}:${column.name}:default`,
      })
    } else {
      statements.push({
        sql: `ALTER TABLE ${tableIdentifier} ALTER COLUMN ${columnIdentifier} DROP DEFAULT`,
        source: `schema:alterColumn:${tableName}:${column.name}:default`,
      })
    }

    return statements
  }
}
