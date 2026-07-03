import type {
  DatabaseMutationEvent,
} from './dependencies'
import {
  hasProjectedSelections,
  hasQueryOrderBy,
  readQueryRowWindowMode,
} from './query-metadata'
import {
  UNCHANGED_ROWS_RESULT,
  UNPATCHED_RESULT,
} from './query-patch-results'
import {
  applyDeleteMutationToRows,
} from './query-row-delete-patching'
import {
  removeRowByIdentityValueFromQueryRowsLazily,
} from './query-row-array'
import {
  canBackfillShrinkingRows,
  canPatchShrinkingRows,
  matchesPredicateContext,
} from './query-row-patch-context'
import {
  rowIdentity,
} from './query-row-identity'
import {
  readMutationRowsContainExactQueryId,
} from './query-row-patch-helpers'
import {
  applyProjectedMutationToRows,
} from './query-row-projected-patching'
import {
  upsertOrderedPatchRowLazily,
} from './query-row-upsert'
import {
  applySortedRowsWindow,
  readOrderedRows,
} from './query-row-ordering'
import {
  applyUpdateMutationToRows,
} from './query-row-update-patching'
import type {
  DatabaseQueryObservation,
  PatchRowsResult,
  RowMutationApplier,
  RowPatchContext,
  RowsOrderState,
} from './query-state'

export {
  canBackfillShrinkingRows,
  canPatchShrinkingRows,
  createMutationRowPatchContext,
  createQueryRowPatchContext,
  matchesPatchedPredicateContext,
  matchesPredicateContext,
  mergePatchRow,
  projectedUpdateCannotAffectQueryResult,
  readMutationPatchMetadata,
  replaceRowByIndexLazily,
} from './query-row-patch-context'

export {
  upsertPatchRowLazily,
} from './query-row-upsert'

function canPatchUnorderedInsert(query: DatabaseQueryObservation): boolean {
  return hasQueryOrderBy(query) || readQueryRowWindowMode(query) === 'single'
}

function applyInsertMutationToRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  context: RowPatchContext,
): PatchRowsResult {
  if (
    !canPatchUnorderedInsert(query)
    && !knownUpdateUpsertCanPatchUnordered(mutation, context)
  ) {
    return UNPATCHED_RESULT
  }

  if (!mutation.rows || mutation.rows.length === 0) {
    return UNPATCHED_RESULT
  }

  let nextRows: Readonly<Record<string, unknown>>[] | undefined
  const orderState: RowsOrderState = { preserved: true }
  if (readMutationRowsContainExactQueryId(context, mutation) === false) {
    return UNCHANGED_ROWS_RESULT
  }

  for (const row of mutation.rows) {
    if (!row) {
      return UNPATCHED_RESULT
    }

    const matches = matchesPredicateContext(row, context.queryPredicates)
    if (typeof matches === 'undefined') {
      return UNPATCHED_RESULT
    }

    if (matches) {
      const upsertedRows = upsertOrderedPatchRowLazily(
        rows,
        nextRows,
        query,
        context,
        row,
        context.orderColumns,
        context.orderMultipliers,
        orderState,
      )
      if (upsertedRows) {
        nextRows = upsertedRows
      }
      continue
    }

    if (mutation.kind === 'upsert') {
      const withoutRow = removeRowByIdentityValueFromQueryRowsLazily(rows, nextRows, query, rowIdentity(row))
      if (withoutRow) {
        nextRows = withoutRow
      }
    }
  }

  if (!nextRows) {
    return UNCHANGED_ROWS_RESULT
  }

  const sortedRows = readOrderedRows(nextRows, context, orderState)
  if (!sortedRows) {
    return UNPATCHED_RESULT
  }

  if (nextRows.length < rows.length && !canPatchShrinkingRows(rows, query)) {
    return canBackfillShrinkingRows(rows, sortedRows, query)
      ? { patched: true, backfill: true, rows: sortedRows }
      : UNPATCHED_RESULT
  }

  const windowedRows = applySortedRowsWindow(sortedRows, query)
  return windowedRows
    ? { patched: true, rows: windowedRows }
    : UNPATCHED_RESULT
}

function applyPlainMutationToRowsWithContext(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  context: RowPatchContext,
): PatchRowsResult {
  if (mutation.kind === 'insert' || mutation.kind === 'upsert') {
    return applyInsertMutationToRows(rows, query, mutation, context)
  }

  if (mutation.kind === 'update') {
    return applyUpdateMutationToRows(rows, query, mutation, context)
  }

  return applyDeleteMutationToRows(rows, query, mutation, context)
}

function knownUpdateUpsertCanPatchUnordered(
  mutation: DatabaseMutationEvent,
  context: RowPatchContext,
): boolean {
  if (mutation.kind !== 'upsert') {
    return false
  }

  const rows = mutation.rows
  const previousRows = mutation.previousRows
  if (!rows || !previousRows || rows.length !== previousRows.length) {
    return false
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const previousRow = previousRows[index]
    if (!row || !previousRow) {
      return false
    }

    const previousMatches = matchesPredicateContext(previousRow, context.queryPredicates)
    const nextMatches = matchesPredicateContext(row, context.queryPredicates)
    if (typeof previousMatches === 'undefined' || typeof nextMatches === 'undefined') {
      return false
    }

    if (!previousMatches && nextMatches) {
      return false
    }
  }

  return true
}

export function selectRowMutationApplier(query: DatabaseQueryObservation): RowMutationApplier {
  return (query.hasProjectedSelections ?? hasProjectedSelections(query))
    ? applyProjectedMutationToRows
    : applyPlainMutationToRowsWithContext
}
