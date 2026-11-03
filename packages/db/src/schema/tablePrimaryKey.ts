import { SchemaError } from '../core/errors'
import type { TableDefinition } from './types'

export function resolveTablePrimaryKeyColumns(table: TableDefinition | undefined): readonly [string, ...string[]] {
  const [first, ...rest] = Object.values(table?.columns ?? {}).filter(column => column.primaryKey).map(column => column.name)
  return first === undefined ? ['id'] : [first, ...rest]
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
  primaryKeys: readonly [string, ...string[]],
): asserts primaryKeys is readonly [string] {
  if (primaryKeys.length > 1) {
    throw new SchemaError(
      `Table "${table?.tableName}" has a composite primary key (${primaryKeys.join(', ')}); this operation needs a single primary-key column.`,
    )
  }
}
