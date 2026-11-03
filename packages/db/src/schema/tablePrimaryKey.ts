import { SchemaError } from '../core/errors'
import type { TableDefinition } from './types'

export function resolveTablePrimaryKeyColumns(table: TableDefinition | undefined): readonly [string, ...string[]] {
  const [first, ...rest] = Object.values(table?.columns ?? {}).filter(column => column.primaryKey).map(column => column.name)
  return first === undefined ? ['id'] : [first, ...rest]
}

export function assertSinglePrimaryKey(table: TableDefinition | undefined): void {
  const primaryKeys = resolveTablePrimaryKeyColumns(table)
  if (primaryKeys.length > 1) {
    throw new SchemaError(
      `Table "${table?.tableName}" has a composite primary key (${primaryKeys.join(', ')}); this operation needs a single primary-key column.`,
    )
  }
}

export function resolveTablePrimaryKey(table: TableDefinition | undefined): string {
  assertSinglePrimaryKey(table)
  return resolveTablePrimaryKeyColumns(table)[0]
}
