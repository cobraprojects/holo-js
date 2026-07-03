import {
  hasRecordKey,
} from './predicate-matching'
import {
  readQueryRowWindowMode,
} from './query-metadata'
import {
  appendRowLazily,
  appendRowsRange,
  removeRowByIndexLazily,
} from './query-row-array'
import {
  mergePatchRow,
  replaceRowByIndexLazily,
} from './query-row-patch-context'
import {
  compareRowsByOrderMetadata,
  rowHasOrderColumns,
} from './query-row-ordering'
import type {
  DatabaseQueryObservation,
  LazyRowsMutationResult,
  RowPatchContext,
  RowsOrderState,
} from './query-state'

export function isFullOrderedLimitedWindow(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
): boolean {
  return readQueryRowWindowMode(query) === 'limited' && rows.length === query.limit
}

export function patchCanChangeOrder(
  current: Readonly<Record<string, unknown>>,
  row: Readonly<Record<string, unknown>>,
  context: RowPatchContext,
): boolean {
  return context.queryOrderChanged && patchChangesOrder(current, context.orderColumns, row)
}

export function appendOrderedPatchRowLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  row: Readonly<Record<string, unknown>>,
  query: DatabaseQueryObservation,
  orderColumns: readonly string[],
  orderMultipliers: readonly number[],
  orderState: RowsOrderState,
): Readonly<Record<string, unknown>>[] | undefined {
  if (isPastFullOrderedWindowTail(rows, row, query, orderColumns, orderMultipliers)) {
    return undefined
  }

  const orderedRows = insertOrderedPatchRowLazily(rows, row, orderColumns, orderMultipliers)
  if (orderedRows) {
    return orderedRows
  }

  orderState.preserved = false
  return appendRowLazily(rows, row)
}

export function relocateOrderedPatchRowLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  rowIndex: number,
  row: Readonly<Record<string, unknown>>,
  orderColumns: readonly string[],
  orderMultipliers: readonly number[],
): Readonly<Record<string, unknown>>[] | undefined {
  if (orderedPatchRowCanStayInPlace(rows, rowIndex, row, orderColumns, orderMultipliers)) {
    return replaceRowByIndexLazily(rows, rowIndex, row)
  }

  const remainingRows = removeRowByIndexLazily(rows, rowIndex)
  return insertOrderedPatchRowLazily(remainingRows, row, orderColumns, orderMultipliers)
}

export function replaceOrderedPatchRowByIndexLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  rowIndex: number,
  row: Readonly<Record<string, unknown>>,
  context: RowPatchContext,
  orderColumns: readonly string[],
  orderMultipliers: readonly number[],
  orderState: RowsOrderState,
): LazyRowsMutationResult {
  const current = rows[rowIndex]
  if (typeof current === 'undefined') {
    return undefined
  }

  const nextRow = mergePatchRow(current, row)
  if (nextRow === current) {
    return undefined
  }

  if (patchCanChangeOrder(current, row, context)) {
    const relocatedRows = relocateOrderedPatchRowLazily(rows, rowIndex, nextRow, orderColumns, orderMultipliers)
    if (relocatedRows) {
      return relocatedRows
    }

    orderState.preserved = false
  }

  return replaceRowByIndexLazily(rows, rowIndex, nextRow)
}

function patchChangesOrder(
  current: Readonly<Record<string, unknown>>,
  orderColumns: readonly string[],
  row: Readonly<Record<string, unknown>>,
): boolean {
  for (const column of orderColumns) {
    if (!hasRecordKey(current, column) || !hasRecordKey(row, column) || current[column] !== row[column]) {
      return true
    }
  }

  return false
}

function isPastFullOrderedWindowTail(
  rows: readonly Readonly<Record<string, unknown>>[],
  row: Readonly<Record<string, unknown>>,
  query: DatabaseQueryObservation,
  orderColumns: readonly string[],
  orderMultipliers: readonly number[],
): boolean {
  if (!isFullOrderedLimitedWindow(rows, query)) {
    return false
  }

  const lastRow = rows[rows.length - 1]
  if (!lastRow) {
    return false
  }

  const comparison = compareRowsByOrderMetadata(row, lastRow, orderColumns, orderMultipliers)
  return typeof comparison === 'number' && comparison >= 0
}

function insertOrderedPatchRowLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  row: Readonly<Record<string, unknown>>,
  orderColumns: readonly string[],
  orderMultipliers: readonly number[],
): Readonly<Record<string, unknown>>[] | undefined {
  if (orderColumns.length === 0) {
    return appendRowLazily(rows, row)
  }

  if (!rowHasOrderColumns(row, orderColumns)) {
    return undefined
  }

  let insertionIndex = rows.length
  let previous: Readonly<Record<string, unknown>> | undefined
  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index]
    if (typeof current === 'undefined') {
      return undefined
    }

    if (previous) {
      const currentOrder = compareRowsByOrderMetadata(previous, current, orderColumns, orderMultipliers)
      if (typeof currentOrder === 'undefined' || currentOrder > 0) {
        return undefined
      }
    }

    const insertedOrder = compareRowsByOrderMetadata(row, current, orderColumns, orderMultipliers)
    if (typeof insertedOrder === 'undefined') {
      return undefined
    }

    if (insertedOrder < 0 && insertionIndex === rows.length) {
      insertionIndex = index
    }

    previous = current
  }

  if (insertionIndex === rows.length) {
    return appendRowLazily(rows, row)
  }

  const nextRows: Readonly<Record<string, unknown>>[] = []
  appendRowsRange(nextRows, rows, 0, insertionIndex)
  nextRows.push(row)
  appendRowsRange(nextRows, rows, insertionIndex, rows.length)
  return nextRows
}

function orderedPatchRowCanStayInPlace(
  rows: readonly Readonly<Record<string, unknown>>[],
  rowIndex: number,
  row: Readonly<Record<string, unknown>>,
  orderColumns: readonly string[],
  orderMultipliers: readonly number[],
): boolean {
  const previousRow = rows[rowIndex - 1]
  if (typeof previousRow === 'undefined') {
    if (rowIndex > 0) {
      return false
    }
  } else {
    const previousOrder = compareRowsByOrderMetadata(previousRow, row, orderColumns, orderMultipliers)
    if (typeof previousOrder === 'undefined' || previousOrder > 0) {
      return false
    }
  }

  const nextRow = rows[rowIndex + 1]
  if (typeof nextRow === 'undefined') {
    if (rowIndex < rows.length - 1) {
      return false
    }
  } else {
    const nextOrder = compareRowsByOrderMetadata(row, nextRow, orderColumns, orderMultipliers)
    if (typeof nextOrder === 'undefined' || nextOrder > 0) {
      return false
    }
  }

  return true
}
