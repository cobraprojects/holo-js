import { SQLSchemaCompiler } from './SQLSchemaCompiler'
import { compileDialectDefaultLiteral } from './defaultLiterals'
import { resolveDialectColumnType } from './typeMapping'
import type { ColumnDefinition } from './types'

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
}
