import { getExecutionDatabase } from './execution-context'
import { DB, TableQueryBuilder, type DatabaseContext } from '@holo-js/db'
import type { DatabaseQueryObservation, DatabaseQuerySelectionObservation } from './query-state'
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

export function createBackfillQuery(
  query: Pick<DatabaseQueryObservation, 'table' | 'tableName'>,
  connection: DatabaseContext,
): TableQueryBuilder<string, Record<string, unknown>> {
  return new TableQueryBuilder<string, Record<string, unknown>>((query.table ?? query.tableName) as string, connection)
}
