import { DB, type DatabaseContext } from '@holo-js/db'
import type { DatabaseQuerySelectionObservation } from './query-state'
import { getRuntimeState } from './state'

export function getBackfillDatabaseConnection(connectionName: string): DatabaseContext | undefined {
  const boundConnection = getRuntimeState().bindings?.db?.()
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
