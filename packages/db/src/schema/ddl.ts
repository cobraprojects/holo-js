import type { AnyColumnDefinition, ForeignKeyReference, TableDefinition } from './types'

export interface CreateTableOperation {
  readonly kind: 'createTable'
  readonly table: TableDefinition
}

export interface DropTableOperation {
  readonly kind: 'dropTable'
  readonly tableName: string
}

export interface RenameTableOperation {
  readonly kind: 'renameTable'
  readonly fromTableName: string
  readonly toTableName: string
}

export interface CreateIndexOperation {
  readonly kind: 'createIndex'
  readonly tableName: string
  readonly index: {
    readonly name?: string
    readonly columns: readonly string[]
    readonly unique: boolean
  }
}

export interface DropIndexOperation {
  readonly kind: 'dropIndex'
  readonly tableName: string
  readonly indexName: string
}

export interface RenameIndexOperation {
  readonly kind: 'renameIndex'
  readonly tableName: string
  readonly fromIndexName: string
  readonly toIndexName: string
}

export interface AddColumnOperation {
  readonly kind: 'addColumn'
  readonly tableName: string
  readonly column: AnyColumnDefinition
}

export interface DropColumnOperation {
  readonly kind: 'dropColumn'
  readonly tableName: string
  readonly columnName: string
}

export interface RenameColumnOperation {
  readonly kind: 'renameColumn'
  readonly tableName: string
  readonly fromColumnName: string
  readonly toColumnName: string
}

export interface AlterColumnOperation {
  readonly kind: 'alterColumn'
  readonly tableName: string
  readonly column: AnyColumnDefinition
}

export interface CreateForeignKeyOperation {
  readonly kind: 'createForeignKey'
  readonly tableName: string
  readonly columnName: string
  readonly reference: ForeignKeyReference
  readonly constraintName?: string
}

export interface DropForeignKeyOperation {
  readonly kind: 'dropForeignKey'
  readonly tableName: string
  readonly constraintName: string
}

export type DDLOperation = CreateTableOperation | DropTableOperation | RenameTableOperation | CreateIndexOperation | DropIndexOperation | RenameIndexOperation | AddColumnOperation | DropColumnOperation | RenameColumnOperation | AlterColumnOperation | CreateForeignKeyOperation | DropForeignKeyOperation

export interface DDLStatement {
  readonly sql: string
  readonly bindings?: readonly unknown[]
  readonly source: string
}

export function createTableOperation(table: TableDefinition): CreateTableOperation {
  return {
    kind: 'createTable',
    table,
  }
}

export function dropTableOperation(tableName: string): DropTableOperation {
  return {
    kind: 'dropTable',
    tableName,
  }
}

export function renameTableOperation(
  fromTableName: string,
  toTableName: string,
): RenameTableOperation {
  return {
    kind: 'renameTable',
    fromTableName,
    toTableName,
  }
}

export function createIndexOperation(
  tableName: string,
  index: CreateIndexOperation['index'],
): CreateIndexOperation {
  return {
    kind: 'createIndex',
    tableName,
    index,
  }
}

export function dropIndexOperation(
  tableName: string,
  indexName: string,
): DropIndexOperation {
  return {
    kind: 'dropIndex',
    tableName,
    indexName,
  }
}

export function renameIndexOperation(
  tableName: string,
  fromIndexName: string,
  toIndexName: string,
): RenameIndexOperation {
  return {
    kind: 'renameIndex',
    tableName,
    fromIndexName,
    toIndexName,
  }
}

export function addColumnOperation(
  tableName: string,
  column: AnyColumnDefinition,
): AddColumnOperation {
  return {
    kind: 'addColumn',
    tableName,
    column,
  }
}

export function dropColumnOperation(
  tableName: string,
  columnName: string,
): DropColumnOperation {
  return {
    kind: 'dropColumn',
    tableName,
    columnName,
  }
}

export function renameColumnOperation(
  tableName: string,
  fromColumnName: string,
  toColumnName: string,
): RenameColumnOperation {
  return {
    kind: 'renameColumn',
    tableName,
    fromColumnName,
    toColumnName,
  }
}

export function alterColumnOperation(
  tableName: string,
  column: AnyColumnDefinition,
): AlterColumnOperation {
  return {
    kind: 'alterColumn',
    tableName,
    column,
  }
}

export function createForeignKeyOperation(
  tableName: string,
  columnName: string,
  reference: ForeignKeyReference,
  constraintName?: string,
): CreateForeignKeyOperation {
  return {
    kind: 'createForeignKey',
    tableName,
    columnName,
    reference,
    constraintName,
  }
}

export function dropForeignKeyOperation(
  tableName: string,
  constraintName: string,
): DropForeignKeyOperation {
  return {
    kind: 'dropForeignKey',
    tableName,
    constraintName,
  }
}
