import { getExecutionDatabase } from './execution-context'
import { DB, TableQueryBuilder, queryCacheInternals, type DatabaseContext, type Dialect, type TableDefinition } from '@holo-js/db'
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

export function createRelatedBackfillQuery(
  relation: { readonly relatedTable?: TableDefinition, readonly relatedTableName: string },
  connection: DatabaseContext,
): TableQueryBuilder<string, Record<string, unknown>> {
  return createBackfillQuery({ table: relation.relatedTable, tableName: relation.relatedTableName }, connection)
}

export function createBackfillQuery(
  query: Pick<DatabaseQueryObservation, 'table' | 'tableName'>,
  connection: DatabaseContext,
): TableQueryBuilder<string, Record<string, unknown>> {
  return new TableQueryBuilder<string, Record<string, unknown>>((query.table ?? query.tableName) as string, connection)
}

export function readBackfilledRows(
  connection: DatabaseContext,
  table: TableDefinition | undefined,
  rows: readonly Readonly<Record<string, unknown>>[],
  selections?: readonly DatabaseQuerySelectionObservation[],
): Readonly<Record<string, unknown>>[] {
  return rows.map(row => queryCacheInternals.readFetchedRow(connection, table, row, selections))
}

export function observedTableKey(query: { readonly tableName: string, readonly table?: TableDefinition }): string {
  return query.table ? `typed:${query.tableName}` : query.tableName
}

export function readBackfilledValue(connection: DatabaseContext, table: TableDefinition | undefined, column: string, value: unknown): unknown {
  return queryCacheInternals.readFetchedRow(connection, table, { [column]: value })[column]
}

function connectionTableKey(connectionName: string, tableName: string): string {
  return `${connectionName}\0${tableName}`
}

function observedTables(query: DatabaseQueryObservation): ReadonlyMap<string, TableDefinition> {
  const tables = new Map<string, TableDefinition>()
  const add = (connectionName: string, tableName: string, table: TableDefinition | undefined) => {
    if (table) tables.set(connectionTableKey(connectionName, tableName), table)
  }
  add(query.connectionName, query.tableName, query.table)
  if (query.relation) add(query.relation.relatedConnectionName, query.relation.relatedTableName, query.relation.relatedTable)
  for (const hydration of query.belongsToHydrations ?? []) add(hydration.relatedConnectionName, hydration.relatedTableName, hydration.relatedTable)
  for (const hydration of query.relatedHydrations ?? []) add(hydration.relatedConnectionName, hydration.relatedTableName, hydration.relatedTable)
  return tables
}

function readRows(
  table: TableDefinition,
  rows: readonly Readonly<Record<string, unknown>>[] | undefined,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (!rows) return rows
  const read = rows.map(row => queryCacheInternals.readTypedMutationRow(table, row))
  return read.every((row, index) => row === rows[index]) ? rows : Object.freeze(read)
}

function readMutation(table: TableDefinition, mutation: DatabaseMutationEvent): DatabaseMutationEvent {
  const rows = readRows(table, mutation.rows)
  const previousRows = readRows(table, mutation.previousRows)
  const values = mutation.values ? queryCacheInternals.readTypedMutationRow(table, mutation.values) : mutation.values
  if (rows === mutation.rows && previousRows === mutation.previousRows && values === mutation.values) return mutation
  return Object.freeze({ ...mutation, rows, previousRows, values })
}

function hasUnreadMutationValue(table: TableDefinition | undefined, mutation: DatabaseMutationEvent): boolean {
  return [...mutation.rows ?? [], ...mutation.previousRows ?? [], ...mutation.values ? [mutation.values] : []]
    .some(row => queryCacheInternals.hasUnreadBoolean(table, row) || queryCacheInternals.hasUnreadInteger(table, row))
}

export function readMutationsForQuery(
  query: DatabaseQueryObservation,
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache,
): readonly DatabaseMutationEvent[] | undefined {
  const tables = observedTables(query)
  if (tables.size === 0) return mutations
  if (mutations.some(mutation => hasUnreadMutationValue(tables.get(connectionTableKey(mutation.connectionName, mutation.tableName)), mutation))) return undefined
  let changed = false
  const read = mutations.map((mutation) => {
    const table = tables.get(connectionTableKey(mutation.connectionName, mutation.tableName))
    const next = table ? readMutation(table, mutation) : mutation
    if (next !== mutation) {
      changed = true
      const exactPredicates = backfills.mutationExactPredicates?.get(mutation)
      if (exactPredicates) backfills.mutationExactPredicates?.set(next, exactPredicates)
    }
    return next
  })
  return changed ? Object.freeze(read) : mutations
}

export function quoteTableReference(dialect: Dialect, tableName: string): string {
  return tableName
    .split('.')
    .map(segment => dialect.quoteIdentifier(segment))
    .join('.')
}
