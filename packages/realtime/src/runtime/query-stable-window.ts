import type {
  DatabaseMutationEvent,
} from './dependencies'
import {
  hasRecordKey,
  valueKeysChangeColumns,
} from './predicate-matching'
import {
  readQueryOrderColumns,
  readQueryPredicateColumns,
} from './query-metadata'
import {
  rowIdentity,
} from './query-row-identity'
import type {
  DatabaseQueryObservation,
  MutationPatchMetadata,
} from './query-state'

export function canPatchStableWindowMutationWithoutBackfill(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  metadata: MutationPatchMetadata,
): boolean {
  const stableColumns = readStableWindowColumns(query)
  if (mutation.kind === 'upsert') {
    return mutationRowsPreserveColumns(mutation, stableColumns)
  }

  return mutation.kind === 'update'
    && metadata.hasValues
    && !valueKeysChangeColumns(metadata.valueKeys, stableColumns)
}

function readStableWindowColumns(query: DatabaseQueryObservation): readonly string[] {
  const orderColumns = readQueryOrderColumns(query)
  const predicateColumns = readQueryPredicateColumns(query)
  if (orderColumns.length === 0) {
    return predicateColumns
  }

  if (predicateColumns.length === 0) {
    return orderColumns
  }

  return Object.freeze([...new Set([...orderColumns, ...predicateColumns])])
}

function mutationRowsPreserveColumns(
  mutation: DatabaseMutationEvent,
  columns: readonly string[],
): boolean {
  if (columns.length === 0) {
    return true
  }

  if (!mutation.rows || !mutation.previousRows || mutation.rows.length !== mutation.previousRows.length) {
    return false
  }

  const previousRows = new Map<unknown, Readonly<Record<string, unknown>>>()
  for (const row of mutation.previousRows) {
    const identity = rowIdentity(row)
    if (typeof identity === 'undefined' || previousRows.has(identity)) {
      return false
    }

    previousRows.set(identity, row)
  }

  for (const row of mutation.rows) {
    const identity = rowIdentity(row)
    const previous = typeof identity === 'undefined' ? undefined : previousRows.get(identity)
    if (!previous || !rowPreservesColumns(row, previous, columns)) {
      return false
    }
  }

  return true
}

function rowPreservesColumns(
  row: Readonly<Record<string, unknown>>,
  previous: Readonly<Record<string, unknown>>,
  columns: readonly string[],
): boolean {
  for (const column of columns) {
    if (!hasRecordKey(row, column) || !hasRecordKey(previous, column) || row[column] !== previous[column]) {
      return false
    }
  }

  return true
}
