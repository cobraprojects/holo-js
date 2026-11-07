import { getExecutionDatabase } from './execution-context'
import { DB, queryCacheInternals, type DatabaseContext, type TableDefinition, type TableQueryBuilder } from '@holo-js/db'
import type { DatabaseQueryPredicateObservation } from './predicate-matching'
import type { DatabaseQueryObservation, DatabaseQuerySelectionObservation } from './query-state'
import type { DatabaseMutationEvent } from './dependencies'
import type { BackfillCache } from './state'
import { getRuntimeState } from './state'

export function getBackfillDatabaseConnection(connectionName: string): DatabaseContext | undefined {
  const state = getRuntimeState()
  state.backfillConnectionLookups = (state.backfillConnectionLookups ?? 0) + 1
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

export function relatedTablePath(relation: { readonly relatedTableName: string, readonly relatedTable?: TableDefinition }): string {
  return relation.relatedTable?.tableName ?? relation.relatedTableName
}

export function whereObservedPredicates(
  builder: TableQueryBuilder<string, Record<string, unknown>>,
  predicates: readonly DatabaseQueryPredicateObservation[],
): TableQueryBuilder<string, Record<string, unknown>> | undefined {
  if (predicates.some(predicate => predicate.value === null)) {
    return undefined
  }

  return predicates.reduce((current, predicate) => current.where(predicate.column, predicate.operator, predicate.value), builder)
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
  if (rows.some(row => queryCacheInternals.hasUnstoredFetchedBoolean(table, row, selections)
    || queryCacheInternals.hasUnreadableFetchedInteger(table, row, selections))) {
    throw new UnreadableBackfillError()
  }
  return rows.map(row => queryCacheInternals.readFetchedRow(table, row, selections))
}

export class UnreadableBackfillError extends Error {
  constructor() {
    super('A backfilled column holds a value the query cannot read.')
    this.name = 'UnreadableBackfillError'
  }
}

export function observedTableKey(query: { readonly tableName: string, readonly table?: TableDefinition }): string {
  return query.table ? `typed:${query.tableName}` : query.tableName
}

export function readBackfilledValue(table: TableDefinition | undefined, column: string, value: unknown): unknown {
  return queryCacheInternals.readFetchedRow(table, { [column]: value })[column]
}

function connectionTableKey(connectionName: string, tableName: string): string {
  return `${connectionName}\0${queryCacheInternals.canonicalTableName(connectionName, tableName)}`
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
  const read = rows.map(row => queryCacheInternals.readMutationRow(table, row))
  return read.every((row, index) => row === rows[index]) ? rows : Object.freeze(read)
}

function readMutation(table: TableDefinition, mutation: DatabaseMutationEvent): DatabaseMutationEvent {
  const rows = readRows(table, mutation.rows)
  const previousRows = readRows(table, mutation.previousRows)
  const values = mutation.values ? queryCacheInternals.readMutationRow(table, mutation.values) : mutation.values
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
