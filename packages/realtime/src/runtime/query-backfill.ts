import { getExecutionDatabase } from './execution-context'
import { DB, queryCacheInternals, type DatabaseContext, type TableDefinition } from '@holo-js/db'
import type { DatabaseQueryObservation, DatabaseQuerySelectionObservation } from './query-state'
import type { DatabaseMutationEvent } from './dependencies'
import type { BackfillCache } from './state'
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

function observedTables(query: DatabaseQueryObservation): ReadonlyMap<string, TableDefinition> {
  const tables = new Map<string, TableDefinition>()
  const add = (tableName: string, table: TableDefinition | undefined) => {
    if (table) tables.set(tableName, table)
  }
  add(query.tableName, query.table)
  if (query.relation) add(query.relation.relatedTableName, query.relation.relatedTable)
  for (const hydration of query.belongsToHydrations ?? []) add(hydration.relatedTableName, hydration.relatedTable)
  for (const hydration of query.relatedHydrations ?? []) add(hydration.relatedTableName, hydration.relatedTable)
  return tables
}

function readRows(
  table: TableDefinition,
  rows: readonly Readonly<Record<string, unknown>>[] | undefined,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (!rows) return rows
  const read = readBackfilledRows(table, rows)
  return read.every((row, index) => row === rows[index]) ? rows : Object.freeze(read)
}

function readMutation(table: TableDefinition, mutation: DatabaseMutationEvent): DatabaseMutationEvent {
  const rows = readRows(table, mutation.rows)
  const previousRows = readRows(table, mutation.previousRows)
  const values = mutation.values ? queryCacheInternals.readObservedRow(table, mutation.values) : mutation.values
  if (rows === mutation.rows && previousRows === mutation.previousRows && values === mutation.values) return mutation
  return Object.freeze({ ...mutation, rows, previousRows, values })
}

export function readMutationsForQuery(
  query: DatabaseQueryObservation,
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache,
): readonly DatabaseMutationEvent[] {
  const tables = observedTables(query)
  if (tables.size === 0) return mutations
  let changed = false
  const read = mutations.map((mutation) => {
    const table = tables.get(mutation.tableName)
    const next = table ? readMutation(table, mutation) : mutation
    if (next !== mutation) {
      changed = true
      const exactPredicates = backfills.mutationExactPredicates?.get(mutation)
      if (exactPredicates) backfills.mutationExactPredicates!.set(next, exactPredicates)
    }
    return next
  })
  return changed ? Object.freeze(read) : mutations
}
