import {
  readQueryRowIdentityIndex,
  rowIdentity,
} from './query-row-identity'
import type {
  DatabaseQueryObservation,
  LazyRowsMutationResult,
  ScannedRowsState,
} from './query-state'

export function appendRowsRange(
  nextRows: Readonly<Record<string, unknown>>[],
  rows: readonly Readonly<Record<string, unknown>>[],
  start: number,
  end: number,
): void {
  for (let index = start; index < end; index += 1) {
    const row = rows[index]
    if (row) {
      nextRows.push(row)
    }
  }
}

function copyRows(
  rows: readonly Readonly<Record<string, unknown>>[],
): Readonly<Record<string, unknown>>[] {
  const nextRows: Readonly<Record<string, unknown>>[] = []
  appendRowsRange(nextRows, rows, 0, rows.length)
  return nextRows
}

export function appendRowLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>>[] {
  const rowCount = rows.length
  const nextRows = new Array<Readonly<Record<string, unknown>>>(rowCount + 1)
  for (let index = 0; index < rowCount; index += 1) {
    const current = rows[index]
    if (!current) {
      const copiedRows = copyRows(rows)
      copiedRows.push(row)
      return copiedRows
    }

    nextRows[index] = current
  }

  nextRows[rowCount] = row
  return nextRows
}

export function removeRowByIndex(
  rows: readonly Readonly<Record<string, unknown>>[],
  rowIndex: number,
): readonly Readonly<Record<string, unknown>>[] {
  return Object.freeze(removeRowByIndexLazily(rows, rowIndex))
}

export function removeRowByIndexLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  rowIndex: number,
): Readonly<Record<string, unknown>>[] {
  const nextRows: Readonly<Record<string, unknown>>[] = []
  appendRowsRange(nextRows, rows, 0, rowIndex)
  appendRowsRange(nextRows, rows, rowIndex + 1, rows.length)
  return nextRows
}

function removeRowsByIndexes(
  rows: readonly Readonly<Record<string, unknown>>[],
  rowIndexes: readonly number[],
): readonly Readonly<Record<string, unknown>>[] {
  const removedRows = removeRowsByIndexesLazily(rows, rowIndexes)
  if (!removedRows) {
    return rows
  }

  return Object.freeze(removedRows)
}

function removeRowsByIndexesLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  rowIndexes: readonly number[],
): LazyRowsMutationResult {
  const firstRowIndex = rowIndexes[0]
  if (typeof firstRowIndex === 'undefined') {
    return undefined
  }

  const secondRowIndex = rowIndexes[1]
  if (typeof secondRowIndex === 'undefined') {
    return removeRowByIndexLazily(rows, firstRowIndex)
  }

  if (rowIndexes.length === 2) {
    return removeRowsByTwoIndexesLazily(rows, firstRowIndex, secondRowIndex)
  }

  return removeRowsBySortedIndexesLazily(
    rows,
    [...rowIndexes].sort((first, second) => first - second),
  )
}

function removeRowsByTwoIndexesLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  firstRowIndex: number,
  secondRowIndex: number,
): Readonly<Record<string, unknown>>[] {
  if (firstRowIndex === secondRowIndex) {
    return removeRowByIndexLazily(rows, firstRowIndex)
  }

  const lowerRowIndex = firstRowIndex < secondRowIndex ? firstRowIndex : secondRowIndex
  const upperRowIndex = firstRowIndex < secondRowIndex ? secondRowIndex : firstRowIndex
  const nextRows: Readonly<Record<string, unknown>>[] = []
  appendRowsRange(nextRows, rows, 0, lowerRowIndex)
  appendRowsRange(nextRows, rows, lowerRowIndex + 1, upperRowIndex)
  appendRowsRange(nextRows, rows, upperRowIndex + 1, rows.length)
  return nextRows
}

function removeRowsBySortedIndexesLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  sortedRowIndexes: readonly number[],
): Readonly<Record<string, unknown>>[] {
  const firstRowIndex = sortedRowIndexes[0]!
  const nextRows: Readonly<Record<string, unknown>>[] = []
  appendRowsRange(nextRows, rows, 0, firstRowIndex)
  let previousRowIndex = firstRowIndex
  for (let index = 1; index < sortedRowIndexes.length; index += 1) {
    const rowIndex = sortedRowIndexes[index]
    if (typeof rowIndex === 'undefined' || rowIndex === previousRowIndex) {
      continue
    }

    appendRowsRange(nextRows, rows, previousRowIndex + 1, rowIndex)
    previousRowIndex = rowIndex
  }

  appendRowsRange(nextRows, rows, previousRowIndex + 1, rows.length)
  return nextRows
}

function readTwoIdentityRowIndexes(
  rowIdentityIndex: ReadonlyMap<unknown, number>,
  firstIdentity: unknown,
  secondIdentity: unknown,
): readonly number[] {
  const firstRowIndex = rowIdentityIndex.get(firstIdentity)
  const secondRowIndex = rowIdentityIndex.get(secondIdentity)
  if (typeof firstRowIndex === 'undefined') {
    return typeof secondRowIndex === 'undefined' ? [] : [secondRowIndex]
  }

  if (typeof secondRowIndex === 'undefined' || secondRowIndex === firstRowIndex) {
    return [firstRowIndex]
  }

  return [firstRowIndex, secondRowIndex]
}

function readIdentityRowIndexes(
  rowIdentityIndex: ReadonlyMap<unknown, number>,
  removedIdentities: ReadonlySet<unknown>,
): readonly number[] {
  const rowIndexes: number[] = []
  for (const identity of removedIdentities) {
    const rowIndex = rowIdentityIndex.get(identity)
    if (typeof rowIndex !== 'undefined') {
      rowIndexes.push(rowIndex)
    }
  }

  return rowIndexes
}

export function removeRowsByIdentityValues(
  rows: readonly Readonly<Record<string, unknown>>[],
  removedIdentities: ReadonlySet<unknown>,
): readonly Readonly<Record<string, unknown>>[] {
  let nextRows: ScannedRowsState | undefined
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!row) {
      continue
    }

    if (!removedIdentities.has(rowIdentity(row))) {
      if (nextRows) {
        appendScannedRow(nextRows, rows, index, row)
      }
      continue
    }

    nextRows ??= createScannedRowsState()
    skipScannedRow(nextRows, rows, index)
  }

  return nextRows ? Object.freeze(readScannedRows(nextRows, rows)) : rows
}

export function removeRowsByIdentityValuesLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  nextRows: Readonly<Record<string, unknown>>[] | undefined,
  removedIdentities: ReadonlySet<unknown>,
): LazyRowsMutationResult {
  const targetRows = nextRows ?? rows
  if (nextRows) {
    let writeIndex = 0
    for (let readIndex = 0; readIndex < nextRows.length; readIndex += 1) {
      const row = nextRows[readIndex]
      if (!row || removedIdentities.has(rowIdentity(row))) {
        continue
      }

      nextRows[writeIndex] = row
      writeIndex += 1
    }

    nextRows.length = writeIndex
    return nextRows
  }

  let mutableRows: ScannedRowsState | undefined
  for (let index = 0; index < targetRows.length; index += 1) {
    const row = targetRows[index]
    if (!row) {
      continue
    }

    if (removedIdentities.has(rowIdentity(row))) {
      mutableRows ??= createScannedRowsState()
      skipScannedRow(mutableRows, targetRows, index)
      continue
    }

    if (mutableRows) {
      appendScannedRow(mutableRows, targetRows, index, row)
    }
  }

  return mutableRows ? readScannedRows(mutableRows, targetRows) : undefined
}

export function removeRowsByTwoIdentityValues(
  rows: readonly Readonly<Record<string, unknown>>[],
  firstRemovedIdentity: unknown,
  secondRemovedIdentity: unknown,
): readonly Readonly<Record<string, unknown>>[] {
  let nextRows: ScannedRowsState | undefined
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!row) {
      continue
    }

    const identity = rowIdentity(row)
    if (identity !== firstRemovedIdentity && identity !== secondRemovedIdentity) {
      if (nextRows) {
        appendScannedRow(nextRows, rows, index, row)
      }
      continue
    }

    nextRows ??= createScannedRowsState()
    skipScannedRow(nextRows, rows, index)
  }

  return nextRows ? Object.freeze(readScannedRows(nextRows, rows)) : rows
}

export function removeRowsByTwoIdentityValuesLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  nextRows: Readonly<Record<string, unknown>>[] | undefined,
  firstRemovedIdentity: unknown,
  secondRemovedIdentity: unknown,
): LazyRowsMutationResult {
  const targetRows = nextRows ?? rows
  if (nextRows) {
    let writeIndex = 0
    for (let readIndex = 0; readIndex < nextRows.length; readIndex += 1) {
      const row = nextRows[readIndex]
      if (!row) {
        continue
      }

      const identity = rowIdentity(row)
      if (identity === firstRemovedIdentity || identity === secondRemovedIdentity) {
        continue
      }

      nextRows[writeIndex] = row
      writeIndex += 1
    }

    nextRows.length = writeIndex
    return nextRows
  }

  let mutableRows: ScannedRowsState | undefined
  for (let index = 0; index < targetRows.length; index += 1) {
    const row = targetRows[index]
    if (!row) {
      continue
    }

    const identity = rowIdentity(row)
    if (identity === firstRemovedIdentity || identity === secondRemovedIdentity) {
      mutableRows ??= createScannedRowsState()
      skipScannedRow(mutableRows, targetRows, index)
      continue
    }

    if (mutableRows) {
      appendScannedRow(mutableRows, targetRows, index, row)
    }
  }

  return mutableRows ? readScannedRows(mutableRows, targetRows) : undefined
}

export function removeRowsByIdentityValuesFromQueryRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  removedIdentities: ReadonlySet<unknown>,
): readonly Readonly<Record<string, unknown>>[] {
  const rowIdentityIndex = readQueryRowIdentityIndex(query, rows)
  if (!rowIdentityIndex) {
    return removeRowsByIdentityValues(rows, removedIdentities)
  }

  return removeRowsByIndexes(rows, readIdentityRowIndexes(rowIdentityIndex, removedIdentities))
}

export function removeRowsByIdentityValuesFromQueryRowsLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  nextRows: Readonly<Record<string, unknown>>[] | undefined,
  query: DatabaseQueryObservation,
  removedIdentities: ReadonlySet<unknown>,
): LazyRowsMutationResult {
  if (!nextRows) {
    const rowIdentityIndex = readQueryRowIdentityIndex(query, rows)
    if (rowIdentityIndex) {
      const rowIndexes = readIdentityRowIndexes(rowIdentityIndex, removedIdentities)
      return rowIndexes.length === 0 ? undefined : removeRowsByIndexesLazily(rows, rowIndexes)
    }
  }

  return removeRowsByIdentityValuesLazily(rows, nextRows, removedIdentities)
}

export function removeRowsByTwoIdentityValuesFromQueryRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  firstRemovedIdentity: unknown,
  secondRemovedIdentity: unknown,
): readonly Readonly<Record<string, unknown>>[] {
  const rowIdentityIndex = readQueryRowIdentityIndex(query, rows)
  if (!rowIdentityIndex) {
    return removeRowsByTwoIdentityValues(rows, firstRemovedIdentity, secondRemovedIdentity)
  }

  return removeRowsByIndexes(
    rows,
    readTwoIdentityRowIndexes(rowIdentityIndex, firstRemovedIdentity, secondRemovedIdentity),
  )
}

export function removeRowsByTwoIdentityValuesFromQueryRowsLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  nextRows: Readonly<Record<string, unknown>>[] | undefined,
  query: DatabaseQueryObservation,
  firstRemovedIdentity: unknown,
  secondRemovedIdentity: unknown,
): LazyRowsMutationResult {
  if (!nextRows) {
    const rowIdentityIndex = readQueryRowIdentityIndex(query, rows)
    if (rowIdentityIndex) {
      const rowIndexes = readTwoIdentityRowIndexes(rowIdentityIndex, firstRemovedIdentity, secondRemovedIdentity)
      return rowIndexes.length === 0 ? undefined : removeRowsByIndexesLazily(rows, rowIndexes)
    }
  }

  return removeRowsByTwoIdentityValuesLazily(rows, nextRows, firstRemovedIdentity, secondRemovedIdentity)
}

export function removeRowByIdentityValueFromQueryRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  removedIdentity: unknown,
): readonly Readonly<Record<string, unknown>>[] {
  const rowIdentityIndex = readQueryRowIdentityIndex(query, rows)
  if (!rowIdentityIndex) {
    return removeRowByIdentityValue(rows, removedIdentity)
  }

  const rowIndex = rowIdentityIndex.get(removedIdentity)
  return typeof rowIndex === 'undefined' ? rows : removeRowByIndex(rows, rowIndex)
}

export function removeRowByIdentityValueFromQueryRowsLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  nextRows: Readonly<Record<string, unknown>>[] | undefined,
  query: DatabaseQueryObservation,
  removedIdentity: unknown,
): LazyRowsMutationResult {
  if (!nextRows) {
    const rowIdentityIndex = readQueryRowIdentityIndex(query, rows)
    if (rowIdentityIndex) {
      const rowIndex = rowIdentityIndex.get(removedIdentity)
      return typeof rowIndex === 'undefined' ? undefined : removeRowByIndexLazily(rows, rowIndex)
    }
  }

  return removeRowByIdentityValueLazily(rows, nextRows, removedIdentity)
}

function removeRowByIdentityValue(
  rows: readonly Readonly<Record<string, unknown>>[],
  removedIdentity: unknown,
): readonly Readonly<Record<string, unknown>>[] {
  let nextRows: ScannedRowsState | undefined
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!row) {
      continue
    }

    if (rowIdentity(row) !== removedIdentity) {
      if (nextRows) {
        appendScannedRow(nextRows, rows, index, row)
      }
      continue
    }

    nextRows ??= createScannedRowsState()
    skipScannedRow(nextRows, rows, index)
  }

  return nextRows ? Object.freeze(readScannedRows(nextRows, rows)) : rows
}

function removeRowByIdentityValueLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  nextRows: Readonly<Record<string, unknown>>[] | undefined,
  removedIdentity: unknown,
): LazyRowsMutationResult {
  const targetRows = nextRows ?? rows
  if (nextRows) {
    let writeIndex = 0
    for (let readIndex = 0; readIndex < nextRows.length; readIndex += 1) {
      const row = nextRows[readIndex]
      if (!row || rowIdentity(row) === removedIdentity) {
        continue
      }

      nextRows[writeIndex] = row
      writeIndex += 1
    }

    nextRows.length = writeIndex
    return nextRows
  }

  let mutableRows: ScannedRowsState | undefined
  for (let index = 0; index < targetRows.length; index += 1) {
    const row = targetRows[index]
    if (!row) {
      continue
    }

    if (rowIdentity(row) === removedIdentity) {
      mutableRows ??= createScannedRowsState()
      skipScannedRow(mutableRows, targetRows, index)
      continue
    }

    if (mutableRows) {
      appendScannedRow(mutableRows, targetRows, index, row)
    }
  }

  return mutableRows ? readScannedRows(mutableRows, targetRows) : undefined
}

export function createScannedRowsState(): ScannedRowsState {
  return {
    copiedUntil: 0,
    rows: [],
  }
}

export function appendScannedRow(
  state: ScannedRowsState,
  rows: readonly Readonly<Record<string, unknown>>[],
  rowIndex: number,
  row: Readonly<Record<string, unknown>>,
): void {
  flushScannedRows(state, rows, rowIndex)
  state.rows.push(row)
  state.copiedUntil = rowIndex + 1
}

export function skipScannedRow(
  state: ScannedRowsState,
  rows: readonly Readonly<Record<string, unknown>>[],
  rowIndex: number,
): void {
  flushScannedRows(state, rows, rowIndex)
  state.copiedUntil = rowIndex + 1
}

export function flushScannedRows(
  state: ScannedRowsState,
  rows: readonly Readonly<Record<string, unknown>>[],
  end: number,
): void {
  if (state.copiedUntil < end) {
    appendRowsRange(state.rows, rows, state.copiedUntil, end)
    state.copiedUntil = end
  }
}

export function readScannedRows(
  state: ScannedRowsState,
  rows: readonly Readonly<Record<string, unknown>>[],
): Readonly<Record<string, unknown>>[] {
  flushScannedRows(state, rows, rows.length)
  return state.rows
}
