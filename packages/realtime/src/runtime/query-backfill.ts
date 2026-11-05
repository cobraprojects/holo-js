import { getExecutionDatabase } from './execution-context'
import { DB, type DatabaseContext, type Dialect } from '@holo-js/db'
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

export function quoteTableReference(dialect: Dialect, tableName: string): string {
  return tableName
    .split('.')
    .map(segment => dialect.quoteIdentifier(segment))
    .join('.')
}
