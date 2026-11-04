import { SchemaError } from '../core/errors'
import { SQLSchemaCompiler } from './SQLSchemaCompiler'
import { compileColumnDefaultLiteral } from './defaultLiterals'
import { resolveGeneratedCheckName } from './generatedNames'
import { resolveDialectColumnType } from './typeMapping'
import type { DDLStatement } from './ddl'
import type { AnyColumnDefinition, ColumnDefinition } from './types'

export class PostgresSchemaCompiler extends SQLSchemaCompiler {
  protected override getDialectLabel(): string {
    return 'Postgres'
  }

  protected override compileColumnType(column: ColumnDefinition): string {
    return resolveDialectColumnType('postgres', column)
  }

  protected override compileDefaultValue(value: unknown, column: AnyColumnDefinition): string {
    return compileColumnDefaultLiteral('postgres', value, column.kind)
  }

  compileDropCheck(tableName: string, checkName: string): DDLStatement {
    return {
      sql: `ALTER TABLE ${this.compileIdentifierPath(tableName)} DROP CONSTRAINT ${this.quoteIdentifier(checkName)}`,
      source: `schema:dropCheck:${tableName}:${checkName}`,
    }
  }

  compileRenameCheck(tableName: string, fromCheckName: string, toCheckName: string): DDLStatement {
    return {
      sql: `ALTER TABLE ${this.compileIdentifierPath(tableName)} RENAME CONSTRAINT ${this.quoteIdentifier(fromCheckName)} TO ${this.quoteIdentifier(toCheckName)}`,
      source: `schema:renameCheck:${tableName}:${fromCheckName}:${toCheckName}`,
    }
  }

  protected override compilesNotNull(column: AnyColumnDefinition): boolean {
    return !column.nullable
  }

  override compileAlterColumn(
    tableName: string,
    column: ColumnDefinition,
  ): Array<{ sql: string, source: string }> {
    this.assertSupportedAlterColumnDefinition(column)
    if (column.computed) {
      throw new SchemaError(`PostgreSQL cannot change the expression of generated column "${column.name}". Drop and add the column instead.`)
    }
    const tableIdentifier = this.compileIdentifierPath(tableName)
    const columnIdentifier = this.quoteIdentifier(column.name)
    const statements: Array<{ sql: string, source: string }> = []
    if (column.kind === 'enum') {
      statements.push({
        sql: `ALTER TABLE ${tableIdentifier} DROP CONSTRAINT IF EXISTS ${this.quoteIdentifier(resolveGeneratedCheckName(tableName, column.name))}`,
        source: `schema:alterColumn:${tableName}:${column.name}:dropCheck`,
      })
    }

    statements.push({
      sql: `ALTER TABLE ${tableIdentifier} ALTER COLUMN ${columnIdentifier} TYPE ${this.compileColumnType(column)}`,
      source: `schema:alterColumn:${tableName}:${column.name}:type`,
    })

    statements.push({
      sql: `ALTER TABLE ${tableIdentifier} ALTER COLUMN ${columnIdentifier} ${column.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`,
      source: `schema:alterColumn:${tableName}:${column.name}:nullability`,
    })

    if (column.defaultKind === 'value') {
      this.assertSupportedDefaultValue(column.defaultValue, column)
      statements.push({
        sql: `ALTER TABLE ${tableIdentifier} ALTER COLUMN ${columnIdentifier} SET DEFAULT ${this.compileDefaultValue(column.defaultValue, column)}`,
        source: `schema:alterColumn:${tableName}:${column.name}:default`,
      })
    } else if (column.defaultKind === 'now') {
      statements.push({
        sql: `ALTER TABLE ${tableIdentifier} ALTER COLUMN ${columnIdentifier} SET DEFAULT ${this.compileCurrentTimestamp()}`,
        source: `schema:alterColumn:${tableName}:${column.name}:default`,
      })
    } else if (column.defaultKind === 'expression') {
      statements.push({
        sql: `ALTER TABLE ${tableIdentifier} ALTER COLUMN ${columnIdentifier} SET DEFAULT ${this.compileDefaultExpression(column)}`,
        source: `schema:alterColumn:${tableName}:${column.name}:default`,
      })
    } else {
      statements.push({
        sql: `ALTER TABLE ${tableIdentifier} ALTER COLUMN ${columnIdentifier} DROP DEFAULT`,
        source: `schema:alterColumn:${tableName}:${column.name}:default`,
      })
    }

    const enumCheck = this.compileEnumCheckConstraint(tableName, column)
    if (enumCheck) {
      statements.push({
        sql: `ALTER TABLE ${tableIdentifier} ADD ${enumCheck}`,
        source: `schema:alterColumn:${tableName}:${column.name}:check`,
      })
    }

    return statements
  }
}
