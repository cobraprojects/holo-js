import { SchemaError } from '../core/errors'
import type { AnyColumnDefinition, TableDefinition } from './types'

function listDeclaredPrimaryKeyColumns(columns: Readonly<Record<string, AnyColumnDefinition>>): string[] {
  return Object.values(columns).filter(column => column.primaryKey).map(column => column.name)
}

export function listTablePrimaryKeyColumns(table: TableDefinition): readonly string[] {
  return table.primaryKeyColumns ?? listDeclaredPrimaryKeyColumns(table.columns)
}

export function resolvePrimaryKeyColumnOrder(
  tableName: string,
  columns: Readonly<Record<string, AnyColumnDefinition>>,
  keyColumns: readonly string[],
): readonly string[] | undefined {
  const declared = listDeclaredPrimaryKeyColumns(columns)
  if (keyColumns.length !== declared.length || keyColumns.some(column => !declared.includes(column))) {
    throw new SchemaError(`Primary key columns (${keyColumns.join(', ')}) of table "${tableName}" must be exactly its primary-key columns (${declared.join(', ')}).`)
  }
  return keyColumns.every((column, position) => column === declared[position]) ? undefined : Object.freeze([...keyColumns])
}

export function resolveTablePrimaryKeyColumns(table: TableDefinition | undefined): readonly string[] {
  return table ? listTablePrimaryKeyColumns(table) : ['id']
}

export function assertSinglePrimaryKey(table: TableDefinition | undefined): void {
  assertSingleColumnKey(table, resolveTablePrimaryKeyColumns(table))
}

export function resolveTablePrimaryKey(table: TableDefinition | undefined): string {
  const primaryKeys = resolveTablePrimaryKeyColumns(table)
  assertSingleColumnKey(table, primaryKeys)
  return primaryKeys[0]
}

function assertSingleColumnKey(
  table: TableDefinition | undefined,
  primaryKeys: readonly string[],
): asserts primaryKeys is readonly [string] {
  if (primaryKeys.length === 0) {
    throw new SchemaError(`Table "${table?.tableName}" has no primary key; this operation needs a single primary-key column.`)
  }

  if (primaryKeys.length > 1) {
    throw new SchemaError(
      `Table "${table?.tableName}" has a composite primary key (${primaryKeys.join(', ')}); this operation needs a single primary-key column.`,
    )
  }
}
