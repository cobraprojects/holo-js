import { getExecutionDatabase } from './execution-context'
import { DB, TableQueryBuilder, type DatabaseContext, type TableDefinition } from '@holo-js/db'
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

const backfillTableKeys = new WeakMap<TableDefinition, number>()
let nextBackfillTableKey = 1

export function readBackfillTableKey(query: Pick<DatabaseQueryObservation, 'table'>): number {
  if (!query.table) return 0
  const known = backfillTableKeys.get(query.table)
  if (known !== undefined) return known
  const key = nextBackfillTableKey
  nextBackfillTableKey += 1
  backfillTableKeys.set(query.table, key)
  return key
}
