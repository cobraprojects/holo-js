import {
  compareValues,
  hasRecordKey,
} from './predicate-matching'
import {
  readQueryOrderColumns,
  readQueryOrderMultipliers,
  readQueryRowWindowMode,
} from './query-metadata'
import type {
  DatabaseQueryObservation,
  RowOrderingAnalysis,
  RowPatchContext,
  RowsOrderState,
} from './query-state'

export function sortRowsForQuery(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  return sortRowsByOrderMetadata(rows, readQueryOrderColumns(query), readQueryOrderMultipliers(query))
}

export function sortRowsByOrderMetadata(
  rows: readonly Readonly<Record<string, unknown>>[],
  orderColumns: readonly string[],
  orderMultipliers: readonly number[],
): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (orderColumns.length === 0) {
    return Object.isFrozen(rows) ? rows : Object.freeze(rows)
  }
  const firstOrderColumn = orderColumns[0]

  if (rows.length === 0) {
    return Object.isFrozen(rows) ? rows : Object.freeze(rows)
  }

  if (rows.length === 1) {
    const row = rows[0]
    if (!row || !firstOrderColumn) {
      return undefined
    }

    if (orderColumns.length === 1) {
      return hasRecordKey(row, firstOrderColumn)
        ? Object.isFrozen(rows) ? rows : Object.freeze(rows)
        : undefined
    }

    for (let orderIndex = 0; orderIndex < orderColumns.length; orderIndex += 1) {
      const column = orderColumns[orderIndex]
      if (!column || !hasRecordKey(row, column)) {
        return undefined
      }
    }

    return Object.isFrozen(rows) ? rows : Object.freeze(rows)
  }
  const ordering = orderColumns.length === 1 && firstOrderColumn
    ? analyzeRowsForSingleColumnOrdering(rows, firstOrderColumn, orderMultipliers[0] ?? 1)
    : analyzeRowsForQueryOrdering(rows, orderColumns, orderMultipliers)
  if (ordering === 'invalid') {
    return undefined
  }

  if (ordering === 'sorted') {
    return Object.isFrozen(rows) ? rows : Object.freeze(rows)
  }

  const nextRows = [...rows]
  if (orderColumns.length === 1 && firstOrderColumn) {
    const multiplier = orderMultipliers[0] ?? 1
    nextRows.sort((left, right) => compareSingleColumnRowsForQuery(left, right, firstOrderColumn, multiplier))
  } else {
    nextRows.sort((left, right) => compareRowsForQuery(left, right, orderColumns, orderMultipliers))
  }

  return Object.freeze(nextRows)
}

function analyzeRowsForSingleColumnOrdering(
  rows: readonly Readonly<Record<string, unknown>>[],
  column: string,
  multiplier: number,
): RowOrderingAnalysis {
  const firstRow = rows[0]
  if (!firstRow || !hasRecordKey(firstRow, column)) {
    return 'invalid'
  }

  let sorted = true
  let previous = firstRow
  for (let index = 1; index < rows.length; index += 1) {
    const current = rows[index]
    if (!current || !hasRecordKey(current, column)) {
      return 'invalid'
    }

    const comparison = compareValues(previous[column], current[column])
    if (typeof comparison === 'undefined') {
      return 'invalid'
    }

    if (comparison * multiplier > 0) {
      sorted = false
    }

    previous = current
  }

  return sorted ? 'sorted' : 'unsorted'
}

function analyzeRowsForQueryOrdering(
  rows: readonly Readonly<Record<string, unknown>>[],
  orderColumns: readonly string[],
  orderMultipliers: readonly number[],
): RowOrderingAnalysis {
  const firstRow = rows[0]
  if (!firstRow) {
    return 'invalid'
  }

  for (const column of orderColumns) {
    if (!hasRecordKey(firstRow, column)) {
      return 'invalid'
    }
  }

  let sorted = true
  let previous = firstRow
  for (let index = 1; index < rows.length; index += 1) {
    const current = rows[index]
    if (!current) {
      return 'invalid'
    }

    let pairComparison = 0
    for (let orderIndex = 0; orderIndex < orderColumns.length; orderIndex += 1) {
      const column = orderColumns[orderIndex]
      if (!column || !hasRecordKey(current, column)) {
        return 'invalid'
      }

      const comparison = compareValues(previous[column], current[column])
      if (typeof comparison === 'undefined') {
        return 'invalid'
      }

      if (pairComparison === 0 && comparison !== 0) {
        pairComparison = comparison * (orderMultipliers[orderIndex] ?? 1)
      }
    }

    if (pairComparison > 0) {
      sorted = false
    }

    previous = current
  }

  return sorted ? 'sorted' : 'unsorted'
}

function compareSingleColumnRowsForQuery(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  column: string,
  multiplier: number,
): number {
  const comparison = compareValues(left[column], right[column])
  return comparison! * multiplier
}

function compareRowsForQuery(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  orderColumns: readonly string[],
  orderMultipliers: readonly number[],
): number {
  for (const [orderIndex, column] of orderColumns.entries()) {
    const comparison = compareValues(left[column], right[column])
    if (typeof comparison === 'undefined' || comparison === 0) {
      continue
    }

    return comparison * (orderMultipliers[orderIndex] ?? 1)
  }

  return 0
}

function applySingleRowWindow(
  rows: readonly Readonly<Record<string, unknown>>[],
): readonly Readonly<Record<string, unknown>>[] {
  if (rows.length <= 1) {
    return Object.isFrozen(rows) ? rows : Object.freeze(rows)
  }

  return Object.freeze(rows.slice(0, 1))
}

export function applySortedRowsWindow(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  const windowMode = readQueryRowWindowMode(query)
  if (windowMode === 'single') {
    return applySingleRowWindow(rows)
  }

  if (windowMode === 'limited') {
    const limit = query.limit
    if (typeof limit !== 'number') {
      return undefined
    }

    return rows.length <= limit
      ? Object.isFrozen(rows) ? rows : Object.freeze(rows)
      : Object.freeze(rows.slice(0, limit))
  }

  return windowMode === 'unwindowed' ? rows : undefined
}

export function readOrderedRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  context: RowPatchContext,
  orderState: RowsOrderState,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  return orderState.preserved
    ? Object.isFrozen(rows) ? rows : Object.freeze(rows)
    : sortRowsByOrderMetadata(rows, context.orderColumns, context.orderMultipliers)
}

export function rowHasOrderColumns(
  row: Readonly<Record<string, unknown>>,
  orderColumns: readonly string[],
): boolean {
  for (const column of orderColumns) {
    if (!hasRecordKey(row, column)) {
      return false
    }
  }

  return true
}

export function compareRowsByOrderMetadata(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  orderColumns: readonly string[],
  orderMultipliers: readonly number[],
): number | undefined {
  for (let orderIndex = 0; orderIndex < orderColumns.length; orderIndex += 1) {
    const column = orderColumns[orderIndex]
    if (!column || !hasRecordKey(left, column) || !hasRecordKey(right, column)) {
      return undefined
    }

    const comparison = compareValues(left[column], right[column])
    if (typeof comparison === 'undefined') {
      return undefined
    }

    if (comparison !== 0) {
      return comparison * (orderMultipliers[orderIndex] ?? 1)
    }
  }

  return 0
}
