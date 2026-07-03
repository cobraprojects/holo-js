import {
  rowsContainExactId,
} from './query-row-matching'
import {
  findUniqueRowIndexByIdentityValue,
  readQueryRowIdentityIndex,
} from './query-row-identity'
import {
  type DUPLICATE_ROW_IDENTITY,
  EMPTY_RECORD_ROWS,
  type DatabaseQueryObservation,
  type RowPatchContext,
} from './query-state'
import type {
  DatabaseMutationEvent,
} from './dependencies'

export function readMutationRowsContainExactQueryId(
  context: RowPatchContext,
  mutation: DatabaseMutationEvent,
): boolean | undefined {
  if (context.rowsContainExactQueryIdCached) {
    return context.rowsContainExactQueryId
  }

  context.rowsContainExactQueryIdCached = true
  context.rowsContainExactQueryId = rowsContainExactId(mutation.rows ?? EMPTY_RECORD_ROWS, context.exactQueryId)
  return context.rowsContainExactQueryId
}

export function readPreviousMutationRowsContainExactQueryId(
  context: RowPatchContext,
  mutation: DatabaseMutationEvent,
): boolean | undefined {
  if (context.previousRowsContainExactQueryIdCached) {
    return context.previousRowsContainExactQueryId
  }

  context.previousRowsContainExactQueryIdCached = true
  context.previousRowsContainExactQueryId = rowsContainExactId(
    mutation.previousRows ?? EMPTY_RECORD_ROWS,
    context.exactQueryId,
  )
  return context.previousRowsContainExactQueryId
}

export function findRowIndexByIdentity(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  identity: unknown,
): number | undefined | typeof DUPLICATE_ROW_IDENTITY {
  const rowIdentityIndex = readQueryRowIdentityIndex(query, rows)
  return rowIdentityIndex ? rowIdentityIndex.get(identity) : findUniqueRowIndexByIdentityValue(rows, identity)
}
