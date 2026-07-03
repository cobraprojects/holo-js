import type {
  DatabaseMutationEvent,
} from './dependencies'
import {
  UNCHANGED_ROWS_RESULT,
  UNPATCHED_RESULT,
} from './query-patch-results'
import {
  appendScannedRow,
  createScannedRowsState,
  readScannedRows,
  removeRowByIndex,
  skipScannedRow,
} from './query-row-array'
import {
  NO_EXACT_ID_PREDICATE,
} from './predicate-matching'
import {
  readQueryRowIdentityIndex,
} from './query-row-identity'
import {
  exactIdsDiffer,
} from './query-row-matching'
import {
  canBackfillShrinkingRows,
  canPatchShrinkingRows,
  matchesPredicateContext,
} from './query-row-patch-context'
import type {
  DatabaseQueryObservation,
  PatchRowsResult,
  RowPatchContext,
  ScannedRowsState,
} from './query-state'

export function applyDeleteMutationToRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  context: RowPatchContext,
): PatchRowsResult {
  if (exactIdsDiffer(context.exactQueryId, context.exactMutationId)) {
    return UNCHANGED_ROWS_RESULT
  }

  const exactDeleteResult = tryApplyExactDeleteMutationToRows(rows, query, context)
  if (exactDeleteResult) {
    return exactDeleteResult
  }

  let nextRows: ScannedRowsState | undefined
  let scannedRows = 0
  for (const row of rows) {
    const matchesMutation = matchesPredicateContext(row, context.mutationPredicates)
    if (typeof matchesMutation === 'undefined') {
      return UNPATCHED_RESULT
    }

    if (matchesMutation) {
      nextRows ??= createScannedRowsState()
      skipScannedRow(nextRows, rows, scannedRows)
      scannedRows += 1
      continue
    }

    if (nextRows) {
      appendScannedRow(nextRows, rows, scannedRows, row)
    }
    scannedRows += 1
  }

  if (!nextRows) {
    return UNCHANGED_ROWS_RESULT
  }

  return createShrinkingRowsPatchResult(rows, query, Object.freeze(readScannedRows(nextRows, rows)))
}

function tryApplyExactDeleteMutationToRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  context: RowPatchContext,
): PatchRowsResult | undefined {
  if (context.exactMutationId === NO_EXACT_ID_PREDICATE) {
    return undefined
  }

  const rowIdentityIndex = readQueryRowIdentityIndex(query, rows)
  if (!rowIdentityIndex) {
    return undefined
  }

  const rowIndex = rowIdentityIndex.get(context.exactMutationId)
  if (typeof rowIndex === 'undefined') {
    return UNCHANGED_ROWS_RESULT
  }

  return createShrinkingRowsPatchResult(rows, query, removeRowByIndex(rows, rowIndex))
}

function createShrinkingRowsPatchResult(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  patchedRows: readonly Readonly<Record<string, unknown>>[],
): PatchRowsResult {
  if (canPatchShrinkingRows(rows, query)) {
    return { patched: true, rows: patchedRows }
  }

  return canBackfillShrinkingRows(rows, patchedRows, query)
    ? { patched: true, backfill: true, rows: patchedRows }
    : UNPATCHED_RESULT
}
