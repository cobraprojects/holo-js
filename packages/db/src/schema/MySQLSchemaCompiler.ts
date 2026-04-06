import { SQLSchemaCompiler } from './SQLSchemaCompiler'
import { compileDialectDefaultLiteral } from './defaultLiterals'
import { resolveDialectColumnType } from './typeMapping'
import type { ColumnDefinition, TableIndexDefinition } from './types'

export class MySQLSchemaCompiler extends SQLSchemaCompiler {
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
