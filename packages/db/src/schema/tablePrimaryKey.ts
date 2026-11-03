import { SchemaError } from '../core/errors'
import type { TableDefinition } from './types'

export function resolveTablePrimaryKeyColumns(table: TableDefinition | undefined): readonly [string, ...string[]] {
  const [first, ...rest] = Object.values(table?.columns ?? {}).filter(column => column.primaryKey).map(column => column.name)
  return first === undefined ? ['id'] : [first, ...rest]
}

export function resolveTablePrimaryKey(table: TableDefinition | undefined): string {
  const [primaryKey, ...otherPrimaryKeys] = resolveTablePrimaryKeyColumns(table)
  if (otherPrimaryKeys.length > 0) {
    throw new SchemaError(
      `Table "${table?.tableName}" has a composite primary key (${[primaryKey, ...otherPrimaryKeys].join(', ')}); this operation needs a single primary-key column.`,
    )
  }

  return primaryKey
}
