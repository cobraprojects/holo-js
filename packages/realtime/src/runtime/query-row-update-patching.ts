import type {
  DatabaseMutationEvent,
} from './dependencies'
import {
  NO_EXACT_ID_PREDICATE,
  hasRecordKey,
  matchesPredicateValue,
  mutationChangesColumns,
  rowValuesChanged,
} from './predicate-matching'
import {
  hasQueryOrderBy,
  readQueryPredicateColumns,
  readQueryRowWindowMode,
} from './query-metadata'
import {
  UNCHANGED_ROWS_RESULT,
  UNPATCHED_RESULT,
} from './query-patch-results'
import {
  createScannedRowsState,
  flushScannedRows,
  readScannedRows,
  removeRowByIndexLazily,
  skipScannedRow,
} from './query-row-array'
import {
  appendOrderedPatchRowLazily,
  isFullOrderedLimitedWindow,
  relocateOrderedPatchRowLazily,
  replaceOrderedPatchRowByIndexLazily,
} from './query-row-ordered-patching'
import {
  canBackfillShrinkingRows,
  canPatchShrinkingRows,
  matchesPatchedPredicateContext,
  matchesPredicateContext,
  mergePatchRow,
  replaceRowByIndexLazily,
} from './query-row-patch-context'
import {
  readQueryRowIdentityIndex,
  rowIdentity,
} from './query-row-identity'
import {
  exactIdsDiffer,
} from './query-row-matching'
import {
  readMutationRowsContainExactQueryId,
} from './query-row-patch-helpers'
import {
  applySortedRowsWindow,
  compareRowsByOrderMetadata,
  readOrderedRows,
  sortRowsForQuery,
} from './query-row-ordering'
import {
  upsertOrderedPatchRowLazily,
} from './query-row-upsert'
import type {
  DatabaseQueryObservation,
  PatchRowsResult,
  RowPatchContext,
  RowsOrderState,
  ScannedRowsState,
  UpdateRowPatchContext,
} from './query-state'

type PreviousRowsUpdateMutation = DatabaseMutationEvent & {
  readonly previousRows: readonly Readonly<Record<string, unknown>>[]
}

export function applyUpdateMutationToRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  context: UpdateRowPatchContext,
): PatchRowsResult {
  if (!mutation.values) {
    return UNPATCHED_RESULT
  }

  if ((!mutation.rows || mutation.rows.length === 0) && hasPreviousRowsUpdateMutation(mutation)) {
    return tryApplyPreviousRowsUpdateMutationToRows(
      rows,
      query,
      mutation,
      context,
      mutation.values,
    )
  }

  const changedPredicateMatches = changedQueryPredicateMatches(query, mutation, mutation.values)
  if (typeof changedPredicateMatches === 'undefined') {
    return UNPATCHED_RESULT
  }

  if (changedPredicateMatches) {
    if (!mutation.rows || mutation.rows.length === 0) {
      const exactExistingResult = tryApplyExistingExactUpdateMutationToRows(rows, query, context, mutation.values)
      if (exactExistingResult) {
        return exactExistingResult
      }
    }

    return applyUpdatedMutationRowsToQuery(rows, query, mutation, context, mutation.values)
  }

  if (exactIdsDiffer(context.exactQueryId, context.exactMutationId)) {
    return UNCHANGED_ROWS_RESULT
  }

  const exactUpdateResult = tryApplyExactUpdateMutationToRows(rows, query, mutation, context, mutation.values)
  if (exactUpdateResult) {
    return exactUpdateResult
  }

  let updatedRows: ScannedRowsState | undefined
  let orderPreserved = true
  let scannedRows = 0
  for (const row of rows) {
    const matchesMutation = matchesPredicateContext(row, context.mutationPredicates)
    if (typeof matchesMutation === 'undefined') {
      return UNPATCHED_RESULT
    }

    if (!matchesMutation) {
      if (updatedRows) {
        orderPreserved = appendOrderedScannedUpdateRow(updatedRows, rows, scannedRows, row, context, orderPreserved)
      }
      scannedRows += 1
      continue
    }

    if (!rowValuesChanged(row, mutation.values, context.valueKeys)) {
      if (updatedRows) {
        orderPreserved = appendOrderedScannedUpdateRow(updatedRows, rows, scannedRows, row, context, orderPreserved)
      }
      scannedRows += 1
      continue
    }

    if (!updatedRows) {
      updatedRows = createScannedRowsState()
    }

    const matchesQuery = matchesPatchedPredicateContext(row, mutation.values, context.queryPredicates)
    if (typeof matchesQuery === 'undefined') {
      return UNPATCHED_RESULT
    }

    if (matchesQuery) {
      orderPreserved = appendOrderedScannedUpdateRow(
        updatedRows,
        rows,
        scannedRows,
        mergePatchRow(row, mutation.values, context.valueKeys),
        context,
        orderPreserved,
      )
    } else {
      skipScannedRow(updatedRows, rows, scannedRows)
    }

    scannedRows += 1
  }

  if (!updatedRows) {
    if (context.queryOrderChanged && isFullOrderedLimitedWindow(rows, query)) {
      return applyUpdatedMutationRowsToQuery(rows, query, mutation, context, mutation.values)
    }

    return UNCHANGED_ROWS_RESULT
  }

  return createUpdatedRowsPatchResult(rows, query, readScannedRows(updatedRows, rows), context, orderPreserved)
}

function changedQueryPredicateMatches(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  values: Readonly<Record<string, unknown>>,
): boolean | undefined {
  if (!mutationChangesColumns(mutation, readQueryPredicateColumns(query))) {
    return false
  }

  for (const predicate of query.predicates) {
    if (!hasRecordKey(values, predicate.column)) {
      continue
    }

    const value = values[predicate.column]
    const matches = matchesPredicateValue(value, predicate)
    if (typeof matches === 'undefined') {
      return undefined
    }

    if (!matches) {
      return false
    }
  }

  return true
}

function hasPreviousRowsUpdateMutation(
  mutation: DatabaseMutationEvent,
): mutation is PreviousRowsUpdateMutation {
  return Boolean(mutation.previousRows)
}

function tryApplyPreviousRowsUpdateMutationToRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  mutation: PreviousRowsUpdateMutation,
  context: UpdateRowPatchContext,
  values: Readonly<Record<string, unknown>>,
): PatchRowsResult {
  const rowIdentityIndex = readQueryRowIdentityIndex(query, rows)
  if (!rowIdentityIndex) {
    return UNPATCHED_RESULT
  }

  let nextRows: Readonly<Record<string, unknown>>[] | undefined
  const orderState: RowsOrderState = { preserved: true }
  for (const previousRow of mutation.previousRows) {
    if (!previousRow) {
      return UNPATCHED_RESULT
    }

    const identity = rowIdentity(previousRow)
    if (typeof identity === 'undefined') {
      return UNPATCHED_RESULT
    }

    const previousMatches = matchesPredicateContext(previousRow, context.queryPredicates)
    const nextMatches = matchesPatchedPredicateContext(previousRow, values, context.queryPredicates)
    if (typeof previousMatches === 'undefined' || typeof nextMatches === 'undefined') {
      return UNPATCHED_RESULT
    }

    if (!previousMatches && !nextMatches) {
      continue
    }

    const targetRows = nextRows ?? rows
    const rowIndex = findPreviousRowsUpdateIndex(targetRows, rowIdentityIndex, identity, Boolean(nextRows))
    if (previousMatches && !nextMatches) {
      if (typeof rowIndex === 'undefined') {
        continue
      }

      nextRows = removeRowByIndexLazily(targetRows, rowIndex)
      continue
    }

    if (!previousMatches && nextMatches) {
      if (typeof rowIndex !== 'undefined' || !canPatchPreviousRowsEnteringUpdate(query)) {
        return UNPATCHED_RESULT
      }

      const nextRow = mergePatchRow(previousRow, values, context.valueKeys)
      const upsertedRows = upsertOrderedPatchRowLazily(
        rows,
        nextRows,
        query,
        context,
        nextRow,
        context.orderColumns,
        context.orderMultipliers,
        orderState,
      )
      if (upsertedRows) {
        nextRows = upsertedRows
      }
      continue
    }

    if (typeof rowIndex === 'undefined') {
      if (context.queryOrderChanged && isFullOrderedLimitedWindow(rows, query)) {
        return UNPATCHED_RESULT
      }

      continue
    }

    const currentRow = targetRows[rowIndex]
    if (!currentRow || !rowValuesChanged(currentRow, values, context.valueKeys)) {
      continue
    }

    const nextRow = mergePatchRow(currentRow, values, context.valueKeys)
    if (context.queryOrderChanged) {
      const relocatedRows = relocateOrderedPatchRowLazily(
        targetRows,
        rowIndex,
        nextRow,
        context.orderColumns,
        context.orderMultipliers,
      )
      if (!relocatedRows) {
        return UNPATCHED_RESULT
      }

      nextRows = relocatedRows
      continue
    }

    nextRows = replaceRowByIndexLazily(targetRows, rowIndex, nextRow)
  }

  if (!nextRows) {
    return UNCHANGED_ROWS_RESULT
  }

  return createUpdatedRowsPatchResult(rows, query, nextRows, context, orderState.preserved)
}

function findPreviousRowsUpdateIndex(
  rows: readonly Readonly<Record<string, unknown>>[],
  rowIdentityIndex: ReadonlyMap<unknown, number>,
  identity: unknown,
  scanRows: boolean,
): number | undefined {
  if (!scanRows) {
    return rowIdentityIndex.get(identity)
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row && rowIdentity(row) === identity) {
      return index
    }
  }

  return undefined
}

function canPatchPreviousRowsEnteringUpdate(query: DatabaseQueryObservation): boolean {
  return hasQueryOrderBy(query) || readQueryRowWindowMode(query) === 'single'
}

function applyUpdatedMutationRowsToQuery(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  context: RowPatchContext,
  values: Readonly<Record<string, unknown>>,
): PatchRowsResult {
  if (!mutation.rows || mutation.rows.length === 0) {
    return UNPATCHED_RESULT
  }

  let nextRows: Readonly<Record<string, unknown>>[] | undefined
  const orderState: RowsOrderState = { preserved: true }
  if (readMutationRowsContainExactQueryId(context, mutation) === false) {
    return UNCHANGED_ROWS_RESULT
  }

  const exactUpdateResult = tryApplyExactUpdatedMutationRowsToQuery(rows, query, mutation, context, values)
  if (exactUpdateResult) {
    return exactUpdateResult
  }

  for (const row of mutation.rows) {
    if (!row) {
      return UNPATCHED_RESULT
    }

    const matchesQuery = matchesPredicateContext(row, context.queryPredicates)
    if (typeof matchesQuery === 'undefined') {
      return UNPATCHED_RESULT
    }

    if (matchesQuery) {
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
    }
  }

  if (!nextRows) {
    return UNCHANGED_ROWS_RESULT
  }

  const sortedRows = readOrderedRows(nextRows, context, orderState)
  if (!sortedRows) {
    return UNPATCHED_RESULT
  }

  const windowedRows = applySortedRowsWindow(sortedRows, query)
  return windowedRows
    ? { patched: true, rows: windowedRows }
    : UNPATCHED_RESULT
}

function tryApplyExactUpdatedMutationRowsToQuery(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  context: RowPatchContext,
  values: Readonly<Record<string, unknown>>,
): PatchRowsResult | undefined {
  if (context.exactMutationId === NO_EXACT_ID_PREDICATE || mutation.rows?.length !== 1) {
    return undefined
  }

  const row = mutation.rows[0]
  if (typeof row === 'undefined') {
    return undefined
  }

  const identity = rowIdentity(row)
  if (typeof identity === 'undefined' || identity !== context.exactMutationId) {
    return undefined
  }

  const rowIdentityIndex = readQueryRowIdentityIndex(query, rows)
  if (!rowIdentityIndex) {
    return undefined
  }

  const matchesQuery = matchesPredicateContext(row, context.queryPredicates)
  if (typeof matchesQuery === 'undefined') {
    return UNPATCHED_RESULT
  }

  if (!matchesQuery) {
    return UNCHANGED_ROWS_RESULT
  }

  const orderState: RowsOrderState = { preserved: true }
  const rowIndex = rowIdentityIndex.get(identity)
  if (typeof rowIndex === 'undefined') {
    const nextRows = appendOrderedPatchRowLazily(rows, row, query, context.orderColumns, context.orderMultipliers, orderState)
    if (!nextRows) {
      return UNCHANGED_ROWS_RESULT
    }

    const sortedRows = readOrderedRows(nextRows, context, orderState)
    if (!sortedRows) {
      return UNPATCHED_RESULT
    }

    const windowedRows = applySortedRowsWindow(sortedRows, query)
    return windowedRows
      ? { patched: true, rows: windowedRows }
      : UNPATCHED_RESULT
  }

  const currentRow = rows[rowIndex]
  if (!currentRow) {
    return undefined
  }

  const nextRow = createExactUpdatedMutationRow(currentRow, row, values, context)
  const nextRows = replaceOrderedPatchRowByIndexLazily(
    rows,
    rowIndex,
    nextRow,
    context,
    context.orderColumns,
    context.orderMultipliers,
    orderState,
  )

  if (!nextRows) {
    return UNCHANGED_ROWS_RESULT
  }

  const sortedRows = readOrderedRows(nextRows, context, orderState)
  if (!sortedRows) {
    return UNPATCHED_RESULT
  }

  const windowedRows = applySortedRowsWindow(sortedRows, query)
  return windowedRows
    ? { patched: true, rows: windowedRows }
    : UNPATCHED_RESULT
}

function createExactUpdatedMutationRow(
  currentRow: Readonly<Record<string, unknown>>,
  row: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, unknown>>,
  context: RowPatchContext,
): Readonly<Record<string, unknown>> {
  return mergePatchRow(
    mergePatchRow(currentRow, row, Object.keys(row)),
    values,
    context.valueKeys,
  )
}

function appendOrderedScannedUpdateRow(
  state: ScannedRowsState,
  rows: readonly Readonly<Record<string, unknown>>[],
  rowIndex: number,
  row: Readonly<Record<string, unknown>>,
  context: UpdateRowPatchContext,
  orderPreserved: boolean,
): boolean {
  flushScannedRows(state, rows, rowIndex)
  const previous = state.rows[state.rows.length - 1]
  state.rows.push(row)
  state.copiedUntil = rowIndex + 1
  if (!orderPreserved || !context.queryOrderChanged || typeof previous === 'undefined') {
    return orderPreserved
  }

  const comparison = compareRowsByOrderMetadata(previous, row, context.orderColumns, context.orderMultipliers)
  return typeof comparison === 'number' && comparison <= 0
}

function tryApplyExactUpdateMutationToRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  context: UpdateRowPatchContext,
  values: Readonly<Record<string, unknown>>,
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
    return context.queryOrderChanged && isFullOrderedLimitedWindow(rows, query)
      ? applyUpdatedMutationRowsToQuery(rows, query, mutation, context, values)
      : UNCHANGED_ROWS_RESULT
  }

  const row = rows[rowIndex]
  if (typeof row === 'undefined') {
    return undefined
  }

  if (!rowValuesChanged(row, values, context.valueKeys)) {
    return context.queryOrderChanged && isFullOrderedLimitedWindow(rows, query)
      ? applyUpdatedMutationRowsToQuery(rows, query, mutation, context, values)
      : UNCHANGED_ROWS_RESULT
  }

  const matchesQuery = matchesPatchedPredicateContext(row, values, context.queryPredicates)
  if (typeof matchesQuery === 'undefined') {
    return UNPATCHED_RESULT
  }

  if (matchesQuery) {
    const nextRow = mergePatchRow(row, values, context.valueKeys)
    if (context.queryOrderChanged) {
      const relocatedRows = relocateOrderedPatchRowLazily(
        rows,
        rowIndex,
        nextRow,
        context.orderColumns,
        context.orderMultipliers,
      )
      if (relocatedRows) {
        return createUpdatedRowsPatchResult(rows, query, relocatedRows, context, true)
      }
    }

    return createUpdatedRowsPatchResult(rows, query, replaceRowByIndexLazily(rows, rowIndex, nextRow), context)
  }

  return createUpdatedRowsPatchResult(rows, query, removeRowByIndexLazily(rows, rowIndex), context, true)
}

function tryApplyExistingExactUpdateMutationToRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  context: UpdateRowPatchContext,
  values: Readonly<Record<string, unknown>>,
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
    return undefined
  }

  const row = rows[rowIndex]
  if (typeof row === 'undefined') {
    return UNPATCHED_RESULT
  }

  if (!rowValuesChanged(row, values, context.valueKeys)) {
    return UNCHANGED_ROWS_RESULT
  }

  const matchesQuery = matchesPatchedPredicateContext(row, values, context.queryPredicates)
  if (typeof matchesQuery === 'undefined') {
    return UNPATCHED_RESULT
  }

  if (!matchesQuery) {
    return createUpdatedRowsPatchResult(rows, query, removeRowByIndexLazily(rows, rowIndex), context, true)
  }

  const nextRow = mergePatchRow(row, values, context.valueKeys)
  if (context.queryOrderChanged) {
    const relocatedRows = relocateOrderedPatchRowLazily(
      rows,
      rowIndex,
      nextRow,
      context.orderColumns,
      context.orderMultipliers,
    )
    if (relocatedRows) {
      return createUpdatedRowsPatchResult(rows, query, relocatedRows, context, true)
    }

    return UNPATCHED_RESULT
  }

  return createUpdatedRowsPatchResult(rows, query, replaceRowByIndexLazily(rows, rowIndex, nextRow), context)
}

function createUpdatedRowsPatchResult(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  updatedRows: Readonly<Record<string, unknown>>[],
  context: UpdateRowPatchContext,
  orderPreserved = false,
): PatchRowsResult {
  if (updatedRows.length === rows.length && (!context.queryOrderChanged || orderPreserved)) {
    return { patched: true, rows: Object.freeze(updatedRows) }
  }

  if (!context.queryOrderChanged || orderPreserved) {
    const orderedRows = Object.freeze(updatedRows)
    if (updatedRows.length < rows.length && !canPatchShrinkingRows(rows, query)) {
      return canBackfillShrinkingRows(rows, orderedRows, query)
        ? { patched: true, backfill: true, rows: orderedRows }
        : UNPATCHED_RESULT
    }

    const windowedRows = applySortedRowsWindow(orderedRows, query)
    return windowedRows
      ? { patched: true, rows: windowedRows }
      : UNPATCHED_RESULT
  }

  const sortedRows = sortRowsForQuery(updatedRows, query)
  if (!sortedRows) {
    return UNPATCHED_RESULT
  }

  if (updatedRows.length < rows.length && !canPatchShrinkingRows(rows, query)) {
    return canBackfillShrinkingRows(rows, sortedRows, query)
      ? { patched: true, backfill: true, rows: sortedRows }
      : UNPATCHED_RESULT
  }

  const windowedRows = applySortedRowsWindow(sortedRows, query)
  return windowedRows
    ? { patched: true, rows: windowedRows }
    : UNPATCHED_RESULT
}
