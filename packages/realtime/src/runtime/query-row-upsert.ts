import {
  appendRowLazily,
} from './query-row-array'
import {
  appendOrderedPatchRowLazily,
  patchCanChangeOrder,
  relocateOrderedPatchRowLazily,
  replaceOrderedPatchRowByIndexLazily,
} from './query-row-ordered-patching'
import {
  mergePatchRow,
  replaceRowByIndexLazily,
} from './query-row-patch-context'
import {
  readQueryRowIdentityIndex,
  rowIdentity,
} from './query-row-identity'
import {
  mergeProjectedPatchRowWithContext,
  projectRowWithContext,
  readProjectedRowIdentity,
} from './query-row-projection'
import {
  MISSING_PROJECTED_IDENTITY,
  type DatabaseQueryObservation,
  type ProjectedLazyRowsMutationResult,
  type RowPatchContext,
  type RowsOrderState,
} from './query-state'

export function upsertPatchRowLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  nextRows: Readonly<Record<string, unknown>>[] | undefined,
  row: Readonly<Record<string, unknown>>,
  keys?: readonly string[],
  query?: DatabaseQueryObservation,
): Readonly<Record<string, unknown>>[] | undefined {
  const targetRows = nextRows ?? rows
  const identity = rowIdentity(row)
  if (typeof identity !== 'undefined') {
    if (!nextRows && query) {
      const indexedRows = upsertPatchRowFromQueryRowsLazily(rows, query, row, identity, keys)
      if (indexedRows) {
        return indexedRows
      }
    }

    for (let index = 0; index < targetRows.length; index += 1) {
      const current = targetRows[index]
      if (!current || rowIdentity(current) !== identity) {
        continue
      }

      const nextRow = mergePatchRow(current, row, keys)
      if (nextRow === current) {
        return nextRows
      }

      if (nextRows) {
        nextRows[index] = nextRow
        return nextRows
      }

      return replaceRowByIndexLazily(targetRows, index, nextRow)
    }
  }

  if (nextRows) {
    nextRows.push(row)
    return nextRows
  }

  return appendRowLazily(targetRows, row)
}

export function upsertOrderedPatchRowLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  nextRows: Readonly<Record<string, unknown>>[] | undefined,
  query: DatabaseQueryObservation,
  context: RowPatchContext,
  row: Readonly<Record<string, unknown>>,
  orderColumns: readonly string[],
  orderMultipliers: readonly number[],
  orderState: RowsOrderState,
): Readonly<Record<string, unknown>>[] | undefined {
  const targetRows = nextRows ?? rows
  const identity = rowIdentity(row)
  if (typeof identity !== 'undefined') {
    if (!nextRows) {
      const indexedRows = upsertOrderedPatchRowFromQueryRowsLazily(
        rows,
        query,
        context,
        row,
        identity,
        orderColumns,
        orderMultipliers,
        orderState,
      )
      if (indexedRows) {
        return indexedRows
      }
    }

    for (let index = 0; index < targetRows.length; index += 1) {
      const current = targetRows[index]
      if (!current || rowIdentity(current) !== identity) {
        continue
      }

      if (patchCanChangeOrder(current, row, context)) {
        orderState.preserved = false
      }

      const nextRow = mergePatchRow(current, row)
      if (nextRow === current) {
        return nextRows
      }

      if (nextRows) {
        nextRows[index] = nextRow
        return nextRows
      }

      return replaceRowByIndexLazily(targetRows, index, nextRow)
    }
  }

  return appendOrderedPatchRowLazily(targetRows, row, query, orderColumns, orderMultipliers, orderState)
}

export function upsertProjectedPatchRowLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  nextRows: Readonly<Record<string, unknown>>[] | undefined,
  query: DatabaseQueryObservation,
  context: RowPatchContext,
  row: Readonly<Record<string, unknown>>,
  identityCache: WeakMap<Readonly<Record<string, unknown>>, unknown>,
  orderColumns: readonly string[],
  orderMultipliers: readonly number[],
  orderState: RowsOrderState,
): ProjectedLazyRowsMutationResult {
  const targetRows = nextRows ?? rows
  const identity = readProjectedRowIdentity(row, context, identityCache)
  if (identity === MISSING_PROJECTED_IDENTITY) {
    return MISSING_PROJECTED_IDENTITY
  }

  if (typeof identity !== 'undefined') {
    if (!nextRows) {
      const indexedRows = upsertProjectedPatchRowFromQueryRowsLazily(
        rows,
        query,
        context,
        row,
        identity,
        orderColumns,
        orderMultipliers,
        orderState,
      )
      if (indexedRows === MISSING_PROJECTED_IDENTITY) {
        return MISSING_PROJECTED_IDENTITY
      }

      if (indexedRows) {
        return indexedRows
      }
    }

    for (let index = 0; index < targetRows.length; index += 1) {
      const current = targetRows[index]
      if (!current) {
        continue
      }

      const currentIdentity = readProjectedRowIdentity(current, context, identityCache)
      if (currentIdentity === MISSING_PROJECTED_IDENTITY) {
        return MISSING_PROJECTED_IDENTITY
      }

      if (currentIdentity !== identity) {
        continue
      }

      if (patchCanChangeOrder(current, row, context)) {
        orderState.preserved = false
      }

      const nextRow = mergeProjectedPatchRowWithContext(current, context, row)
      if (!nextRow) {
        return MISSING_PROJECTED_IDENTITY
      }

      if (nextRow === current) {
        return nextRows
      }

      if (nextRows) {
        nextRows[index] = nextRow
        return nextRows
      }

      return replaceRowByIndexLazily(targetRows, index, nextRow)
    }
  }

  const projected = projectRowWithContext(context, row)
  if (!projected) {
    return MISSING_PROJECTED_IDENTITY
  }

  return appendOrderedPatchRowLazily(targetRows, projected, query, orderColumns, orderMultipliers, orderState)
}

function upsertPatchRowFromQueryRowsLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  row: Readonly<Record<string, unknown>>,
  identity: unknown,
  keys?: readonly string[],
): Readonly<Record<string, unknown>>[] | undefined {
  const rowIdentityIndex = readQueryRowIdentityIndex(query, rows)
  if (!rowIdentityIndex) {
    return undefined
  }

  const rowIndex = rowIdentityIndex.get(identity)
  if (typeof rowIndex === 'undefined') {
    return appendRowLazily(rows, row)
  }

  const current = rows[rowIndex]
  if (typeof current === 'undefined') {
    return undefined
  }

  const nextRow = mergePatchRow(current, row, keys)
  return nextRow === current ? undefined : replaceRowByIndexLazily(rows, rowIndex, nextRow)
}

function upsertOrderedPatchRowFromQueryRowsLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  context: RowPatchContext,
  row: Readonly<Record<string, unknown>>,
  identity: unknown,
  orderColumns: readonly string[],
  orderMultipliers: readonly number[],
  orderState: RowsOrderState,
): Readonly<Record<string, unknown>>[] | undefined {
  const rowIdentityIndex = readQueryRowIdentityIndex(query, rows)
  if (!rowIdentityIndex) {
    return undefined
  }

  const rowIndex = rowIdentityIndex.get(identity)
  return typeof rowIndex === 'undefined'
    ? appendOrderedPatchRowLazily(rows, row, query, orderColumns, orderMultipliers, orderState)
    : replaceOrderedPatchRowByIndexLazily(
      rows,
      rowIndex,
      row,
      context,
      orderColumns,
      orderMultipliers,
      orderState,
    )
}

function upsertProjectedPatchRowFromQueryRowsLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  context: RowPatchContext,
  row: Readonly<Record<string, unknown>>,
  identity: unknown,
  orderColumns: readonly string[],
  orderMultipliers: readonly number[],
  orderState: RowsOrderState,
): ProjectedLazyRowsMutationResult {
  const rowIdentityIndex = readQueryRowIdentityIndex(query, rows)
  if (!rowIdentityIndex) {
    return undefined
  }

  const rowIndex = rowIdentityIndex.get(identity)
  if (typeof rowIndex === 'undefined') {
    const projected = projectRowWithContext(context, row)
    return projected
      ? appendOrderedPatchRowLazily(rows, projected, query, orderColumns, orderMultipliers, orderState)
      : MISSING_PROJECTED_IDENTITY
  }

  const current = rows[rowIndex]
  if (typeof current === 'undefined') {
    return undefined
  }

  const nextRow = mergeProjectedPatchRowWithContext(current, context, row)
  if (!nextRow) {
    return MISSING_PROJECTED_IDENTITY
  }

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
