import { getExecutionDatabase } from './execution-context'
import { DB, queryCacheInternals, type DatabaseContext, type TableDefinition } from '@holo-js/db'
import type { DatabaseQuerySelectionObservation } from './query-state'
import { getRuntimeState } from './state'

export function getBackfillDatabaseConnection(connectionName: string): DatabaseContext | undefined {
  const boundConnection = getExecutionDatabase() ?? getRuntimeState().bindings?.db?.()
  if (boundConnection) {
    return boundConnection.getConnectionName() === connectionName
      ? boundConnection
      : undefined
  }

  try {
    return DB.connection(connectionName)
  } catch {
    return undefined
  }
}

export function createBackfillSelection(selection: DatabaseQuerySelectionObservation): string {
  return selection.resultKey === selection.column
    ? selection.column
    : `${selection.column} as ${selection.resultKey}`
}

export function readBackfilledRows(
  table: TableDefinition | undefined,
  rows: readonly Readonly<Record<string, unknown>>[],
  selections?: readonly DatabaseQuerySelectionObservation[],
): Readonly<Record<string, unknown>>[] {
  return rows.map(row => queryCacheInternals.readObservedRow(table, row, selections))
}

export function observedTableKey(query: { readonly tableName: string, readonly table?: TableDefinition }): string {
  return query.table ? `typed:${query.tableName}` : query.tableName
}

export function readBackfilledValue(table: TableDefinition | undefined, column: string, value: unknown): unknown {
  return queryCacheInternals.readObservedRow(table, { [column]: value })[column]
}
