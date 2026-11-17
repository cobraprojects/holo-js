import type { TableDefinition } from './types'

const untypedTables = new WeakSet<TableDefinition>()

export function createUntypedTable<TName extends string>(tableName: TName): TableDefinition<TName> {
  const table: TableDefinition<TName> = Object.freeze({
    kind: 'table',
    tableName,
    columns: Object.freeze({}),
    indexes: Object.freeze([]),
  })
  untypedTables.add(table)
  return table
}

export function typedTableOrName(table: string | TableDefinition): string | TableDefinition {
  return typeof table !== 'string' && untypedTables.has(table) ? table.tableName : table
}
