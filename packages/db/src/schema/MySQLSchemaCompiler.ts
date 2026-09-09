import { SQLSchemaCompiler } from './SQLSchemaCompiler'
import { compileDialectDefaultLiteral } from './defaultLiterals'
import { assertValidIndexName } from './generatedNames'
import { resolveDialectColumnType } from './typeMapping'
import type { AnyColumnDefinition, ColumnDefinition, TableDefinition, TableIndexDefinition } from './types'

export class MySQLSchemaCompiler extends SQLSchemaCompiler {
  protected override compileTableDefinitions(table: TableDefinition): string[] {
    const columns = Object.values(table.columns)
    const definitions = columns.map(column => this.compileColumn({ ...column, references: undefined }))

    for (const column of columns) {
      if (column.references) {
        const constraintName = this.resolveForeignKeyName(table.tableName, column.name, column.references.constraintName)
        definitions.push(this.compileForeignKeyConstraint(column.name, column.references, constraintName))
      }
    }

    return definitions
  }

  override compileAddColumn(tableName: string, column: AnyColumnDefinition): { sql: string, source: string } {
    const statement = super.compileAddColumn(tableName, { ...column, references: undefined })
    if (!column.references) {
      return statement
    }

    const constraintName = this.resolveForeignKeyName(tableName, column.name, column.references.constraintName)
    return {
      ...statement,
      sql: `${statement.sql}, ADD ${this.compileForeignKeyConstraint(column.name, column.references, constraintName)}`,
    }
  }

  protected override getDialectLabel(): string {
    return 'MySQL'
  }

  protected override compileColumnType(column: ColumnDefinition): string {
    return resolveDialectColumnType('mysql', column)
  }

  protected override compileDefaultValue(value: unknown): string {
    return compileDialectDefaultLiteral('mysql', value)
  }

  override compileRenameTable(fromTableName: string, toTableName: string): { sql: string, source: string } {
    return {
      sql: `RENAME TABLE ${this.compileIdentifierPath(fromTableName)} TO ${this.compileIdentifierPath(toTableName)}`,
      source: `schema:renameTable:${fromTableName}:${toTableName}`,
    }
  }

  override compileRenameIndex(tableName: string, fromIndexName: string, toIndexName: string): { sql: string, source: string } {
    assertValidIndexName(fromIndexName)
    assertValidIndexName(toIndexName)
    return {
      sql: `ALTER TABLE ${this.compileIdentifierPath(tableName)} RENAME INDEX ${this.quoteIdentifier(fromIndexName)} TO ${this.quoteIdentifier(toIndexName)}`,
      source: `schema:renameIndex:${tableName}:${fromIndexName}:${toIndexName}`,
    }
  }

  override compileCreateIndex(tableName: string, index: TableIndexDefinition): { sql: string, source: string } {
    const indexName = this.resolveIndexName(tableName, index)
    const quotedColumns = index.columns.map((column) => this.quoteIdentifier(column)).join(', ')

    return {
      sql: `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${this.quoteIdentifier(indexName)} ON ${this.compileIdentifierPath(tableName)} (${quotedColumns})`,
      source: `schema:createIndex:${tableName}:${indexName}`,
    }
  }

  override compileDropIndex(tableName: string, indexName: string): { sql: string, source: string } {
    assertValidIndexName(indexName)
    return {
      sql: `DROP INDEX ${this.quoteIdentifier(indexName)} ON ${this.compileIdentifierPath(tableName)}`,
      source: `schema:dropIndex:${tableName}:${indexName}`,
    }
  }

  override compileDropForeignKey(tableName: string, constraintName: string): { sql: string, source: string } {
    return {
      sql: `ALTER TABLE ${this.compileIdentifierPath(tableName)} DROP FOREIGN KEY ${this.quoteIdentifier(constraintName)}`,
      source: `schema:dropForeignKey:${tableName}:${constraintName}`,
    }
  }
}
