import { getExecutionDatabase } from './execution-context'
import { DB, queryCacheInternals, type DatabaseContext, type TableDefinition } from '@holo-js/db'
import type { BackfillRows, DatabaseQueryObservation, RealtimeRowReader, DatabaseQuerySelectionObservation } from './query-state'
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
  readRow?: RealtimeRowReader,
): Readonly<Record<string, unknown>>[] {
  if (rows.some(row => queryCacheInternals.hasUnstoredFetchedBoolean(table, row, selections)
    || queryCacheInternals.hasUnreadableFetchedInteger(table, row, selections))) {
    throw new UnreadableBackfillError()
  }
  const read = rows.map(row => queryCacheInternals.readFetchedRow(table, row, selections))
  return readRow ? read.map(row => readWithReader(readRow, row)) : read
}

function readWithReader(readRow: RealtimeRowReader, row: Readonly<Record<string, unknown>>, written = false): Readonly<Record<string, unknown>> {
  try {
    return readRow(row, written)
  } catch {
    throw new UnreadableBackfillError()
  }
}

export function convertBackfilledRows(
  rows: BackfillRows | undefined,
  readRow: RealtimeRowReader | undefined,
): BackfillRows | undefined {
  return rows && readRow ? Object.freeze(rows.map(row => readWithReader(readRow, row))) : rows
}

export class UnreadableBackfillError extends Error {
  constructor() {
    super('A backfilled column holds a value the query cannot read.')
    this.name = 'UnreadableBackfillError'
  }
}

const scopeIds = new WeakMap<object, number>()
let nextScopeId = 0

function scopeId(scope: object): number {
  let id = scopeIds.get(scope)
  if (id === undefined) {
    nextScopeId += 1
    id = nextScopeId
    scopeIds.set(scope, id)
  }
  return id
}

export function readerCacheKey(readRow: RealtimeRowReader | undefined, scope: object): string {
  return readRow ? `:reader:${scopeId(readRow)}:${scopeId(scope)}` : ''
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

const CONFLICTING_READERS = Symbol('conflictingReaders')

type ObservedReader = RealtimeRowReader | typeof CONFLICTING_READERS

function observedReaders(query: DatabaseQueryObservation): ReadonlyMap<string, ObservedReader> {
  const readers = new Map<string, ObservedReader | undefined>()
  const add = (connectionName: string, tableName: string, readRow: RealtimeRowReader | undefined) => {
    const key = connectionTableKey(connectionName, tableName)
    if (!readers.has(key)) readers.set(key, readRow)
    else if (readers.get(key) !== readRow) readers.set(key, CONFLICTING_READERS)
  }
  add(query.connectionName, query.tableName, query.readRow)
  if (query.relation) add(query.relation.relatedConnectionName, query.relation.relatedTableName, query.relation.relatedReadRow)
  for (const hydration of query.belongsToHydrations ?? []) add(hydration.relatedConnectionName, hydration.relatedTableName, hydration.readRow)
  for (const hydration of query.relatedHydrations ?? []) add(hydration.relatedConnectionName, hydration.relatedTableName, hydration.readRow)
  return new Map([...readers].filter((entry): entry is [string, ObservedReader] => entry[1] !== undefined))
}

function readRows(
  table: TableDefinition | undefined,
  readRow: RealtimeRowReader | undefined,
  rows: readonly Readonly<Record<string, unknown>>[] | undefined,
  values: Readonly<Record<string, unknown>> | undefined,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (!rows) return rows
  const read = rows.map(row => readMergedRow(table, readRow, row, values))
  return read.every((row, index) => row === rows[index]) ? rows : Object.freeze(read)
}

export function readMergedRow(
  table: TableDefinition | undefined,
  readRow: RealtimeRowReader | undefined,
  row: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  const writtenKeys = readRow && values ? Object.keys(row).filter(key => Object.hasOwn(values, key) && Object.is(row[key], values[key])) : []
  if (writtenKeys.length === 0) return readObservedRow(table, readRow, row)
  const written = Object.fromEntries(writtenKeys.map(key => [key, row[key]]))
  const stored = Object.fromEntries(Object.entries(row).filter(([key]) => !writtenKeys.includes(key)))
  return Object.freeze({ ...readObservedRow(table, readRow, stored), ...readObservedRow(table, readRow, written, true) })
}

function readObservedRow(
  table: TableDefinition | undefined,
  readRow: RealtimeRowReader | undefined,
  row: Readonly<Record<string, unknown>>,
  written = false,
): Readonly<Record<string, unknown>> {
  const read = table ? queryCacheInternals.readMutationRow(table, row) : row
  return readRow ? readWithReader(readRow, read, written) : read
}

function readMutation(table: TableDefinition | undefined, readRow: RealtimeRowReader | undefined, mutation: DatabaseMutationEvent): DatabaseMutationEvent {
  const rows = readRows(table, readRow, mutation.rows, mutation.values)
  const previousRows = readRows(table, readRow, mutation.previousRows, undefined)
  const values = mutation.values ? readObservedRow(table, readRow, mutation.values, true) : mutation.values
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
  const readers = observedReaders(query)
  if (tables.size === 0 && readers.size === 0) return mutations
  if (mutations.some(mutation => hasUnreadMutationValue(tables.get(connectionTableKey(mutation.connectionName, mutation.tableName)), mutation))) return undefined
  if (mutations.some(mutation => readers.get(connectionTableKey(mutation.connectionName, mutation.tableName)) === CONFLICTING_READERS)) return undefined
  let changed = false
  const read = mutations.map((mutation) => {
    const key = connectionTableKey(mutation.connectionName, mutation.tableName)
    const table = tables.get(key)
    const reader = readers.get(key)
    const readRow = reader === CONFLICTING_READERS ? undefined : reader
    const next = table || readRow ? readMutation(table, readRow, mutation) : mutation
    if (next !== mutation) {
      changed = true
      const exactPredicates = backfills.mutationExactPredicates?.get(mutation)
      if (exactPredicates) backfills.mutationExactPredicates?.set(next, exactPredicates)
    }
    return next
  })
  return changed ? Object.freeze(read) : mutations
}
