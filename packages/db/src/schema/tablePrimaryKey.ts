import type { TableDefinition } from './types'

export function resolveTablePrimaryKey(table: TableDefinition | undefined): string {
  return Object.values(table?.columns ?? {}).find(column => column.primaryKey)?.name ?? 'id'
}
