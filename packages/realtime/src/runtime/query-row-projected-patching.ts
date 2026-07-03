import type {
  DatabaseMutationEvent,
} from './dependencies'
import {
  NO_EXACT_ID_PREDICATE,
  hasRecordKey,
} from './predicate-matching'
import {
  hasQueryOrderBy,
  readQueryRowWindowMode,
} from './query-metadata'
import {
  removeRowByIndexLazily,
} from './query-row-array'
import {
  exactIdsDiffer,
} from './query-row-matching'
import {
  UNCHANGED_ROWS_RESULT,
  UNPATCHED_RESULT,
} from './query-patch-results'
import {
  applySortedRowsWindow,
  readOrderedRows,
} from './query-row-ordering'
import {
  canBackfillShrinkingRows,
  canPatchShrinkingRows,
  matchesPatchedPredicateContext,
  matchesPredicateContext,
  replaceRowByIndexLazily,
} from './query-row-patch-context'
import {
  readMutationRowsContainExactQueryId,
  readPreviousMutationRowsContainExactQueryId,
} from './query-row-patch-helpers'
import {
  readQueryRowIdentityIndex,
} from './query-row-identity'
import {
  mergeProjectedMutationValuesWithContext,
  mergeProjectedPatchRowAndMutationValuesWithContext,
  readProjectedRowIdentity,
  readProjectedRowIdentityCache,
} from './query-row-projection'
import {
  removeRowByProjectedIdentityLazily,
  removeRowsByProjectedIdentity,
  removeRowsByProjectedIdentityLazily,
} from './query-row-projected-removal'
import {
  upsertProjectedPatchRowLazily,
} from './query-row-upsert'
import {
  EMPTY_RECORD_ROWS,
  DUPLICATE_ROW_IDENTITY,
  MISSING_PROJECTED_IDENTITY,
  NO_PROJECTED_IDENTITY_COLUMN,
  type DatabaseQueryObservation,
  type PatchRowsResult,
  type RowPatchContext,
  type RowsOrderState,
} from './query-state'

type DatabaseMutationEventWithRows = DatabaseMutationEvent & {
  readonly rows: readonly Readonly<Record<string, unknown>>[]
}

type ProjectedPreviousRowsUpdateMutation = DatabaseMutationEvent & {
  readonly previousRows: readonly Readonly<Record<string, unknown>>[]
  readonly values: Readonly<Record<string, unknown>>
}

function hasMutationRows(mutation: DatabaseMutationEvent): mutation is DatabaseMutationEventWithRows {
  return Boolean(mutation.rows && mutation.rows.length > 0)
}

function hasProjectedPreviousRowsUpdateMutation(
  mutation: DatabaseMutationEvent,
): mutation is ProjectedPreviousRowsUpdateMutation {
  return mutation.kind === 'update' && Boolean(mutation.previousRows && mutation.values)
}

function findProjectedRowIndexByIdentity(
  rows: readonly Readonly<Record<string, unknown>>[],
  context: RowPatchContext,
  identity: unknown,
  identityCache: WeakMap<Readonly<Record<string, unknown>>, unknown>,
): number | undefined | typeof DUPLICATE_ROW_IDENTITY | typeof MISSING_PROJECTED_IDENTITY {
  let rowIndex: number | undefined
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!row) {
      continue
    }

    const projectedIdentity = readProjectedRowIdentity(row, context, identityCache)
    if (projectedIdentity === MISSING_PROJECTED_IDENTITY) {
      return MISSING_PROJECTED_IDENTITY
    }

    if (projectedIdentity !== identity) {
      continue
    }

    if (typeof rowIndex !== 'undefined') {
      return DUPLICATE_ROW_IDENTITY
    }

    rowIndex = index
  }

  return rowIndex
}

function tryApplySingleProjectedStableUpdateRow(
  rows: readonly Readonly<Record<string, unknown>>[],
  mutation: DatabaseMutationEvent,
  context: RowPatchContext,
  values: Readonly<Record<string, unknown>>,
): PatchRowsResult | undefined {
  if (mutation.rows?.length !== 1) {
    return undefined
  }

  const row = mutation.rows[0]
  if (!row) {
    return UNCHANGED_ROWS_RESULT
  }

  const identitySourceRow = mutation.previousRows?.[0] ?? row
  const identityCache = readProjectedRowIdentityCache(context)
  const identity = readProjectedMutationRowIdentity(identitySourceRow, context, identityCache)
  if (identity === MISSING_PROJECTED_IDENTITY || typeof identity === 'undefined') {
    return UNPATCHED_RESULT
  }

  const matches = matchesPatchedPredicateContext(row, values, context.queryPredicates)
  if (typeof matches === 'undefined') {
    return UNPATCHED_RESULT
  }

  const rowIndex = findProjectedRowIndexByIdentity(rows, context, identity, identityCache)
  if (rowIndex === MISSING_PROJECTED_IDENTITY) {
    return UNPATCHED_RESULT
  }

  if (rowIndex === DUPLICATE_ROW_IDENTITY) {
    return undefined
  }

  if (typeof rowIndex === 'undefined') {
    return matches ? undefined : UNCHANGED_ROWS_RESULT
  }

  if (!matches) {
    return undefined
  }

  if (!context.projectedSelectionChanged) {
    return UNCHANGED_ROWS_RESULT
  }

  const nextIdentity = readProjectedMutationRowIdentity(row, context, identityCache)
  if (nextIdentity === MISSING_PROJECTED_IDENTITY) {
    return UNPATCHED_RESULT
  }

  if (nextIdentity !== identity) {
    return undefined
  }

  const currentRow = rows[rowIndex]!
  const nextRow = mergeProjectedPatchRowAndMutationValuesWithContext(currentRow, context, row, values)
  if (!nextRow) {
    return UNPATCHED_RESULT
  }

  if (nextRow === currentRow) {
    return UNCHANGED_ROWS_RESULT
  }

  const nextRows = replaceRowByIndexLazily(rows, rowIndex, nextRow)

  return { patched: true, rows: Object.freeze(nextRows) }
}

function readProjectedMutationRowIdentity(
  row: Readonly<Record<string, unknown>>,
  context: RowPatchContext,
  cache: WeakMap<Readonly<Record<string, unknown>>, unknown>,
): unknown | typeof MISSING_PROJECTED_IDENTITY {
  if (!context.hasProjectedSelections) {
    return readProjectedRowIdentity(row, context, cache)
  }

  if (context.projectedIdentityColumn === NO_PROJECTED_IDENTITY_COLUMN) {
    return context.usesExactQueryIdAsProjectedIdentity ? context.exactQueryId : undefined
  }

  return hasRecordKey(row, context.projectedIdentityColumn)
    ? row[context.projectedIdentityColumn]
    : MISSING_PROJECTED_IDENTITY
}

function tryApplyProjectedExactMutationValues(
  rows: readonly Readonly<Record<string, unknown>>[],
  mutation: DatabaseMutationEvent,
  context: RowPatchContext,
): PatchRowsResult | undefined {
  if (mutation.kind !== 'update' || !mutation.values || !context.usesExactQueryIdAsProjectedIdentity) {
    return undefined
  }

  if (context.exactMutationId === NO_EXACT_ID_PREDICATE) {
    return undefined
  }

  if (exactIdsDiffer(context.exactQueryId, context.exactMutationId)) {
    return UNCHANGED_ROWS_RESULT
  }

  if (rows.length === 0) {
    return UNCHANGED_ROWS_RESULT
  }

  if (rows.length !== 1) {
    return undefined
  }

  if (hasRecordKey(mutation.values, 'id') && mutation.values.id !== context.exactQueryId) {
    return { patched: true, rows: EMPTY_RECORD_ROWS }
  }

  if (!context.projectedSelectionChanged) {
    return UNCHANGED_ROWS_RESULT
  }

  const currentRow = rows[0]
  if (!currentRow) {
    return undefined
  }

  const nextRow = mergeProjectedMutationValuesWithContext(currentRow, context, mutation.values)
  if (!nextRow) {
    return UNPATCHED_RESULT
  }

  if (nextRow === currentRow) {
    return UNCHANGED_ROWS_RESULT
  }

  return { patched: true, rows: Object.freeze(replaceRowByIndexLazily(rows, 0, nextRow)) }
}

function tryApplyProjectedPreviousRowsMutationValues(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  mutation: ProjectedPreviousRowsUpdateMutation,
  context: RowPatchContext,
): PatchRowsResult {
  let nextRows: Readonly<Record<string, unknown>>[] | undefined
  const identityCache = readProjectedRowIdentityCache(context)
  const orderState: RowsOrderState = { preserved: true }
  for (const previousRow of mutation.previousRows) {
    if (!previousRow) {
      return UNPATCHED_RESULT
    }

    const previousMatches = matchesPredicateContext(previousRow, context.queryPredicates)
    const nextMatches = matchesPatchedPredicateContext(previousRow, mutation.values, context.queryPredicates)
    if (typeof previousMatches === 'undefined' || typeof nextMatches === 'undefined') {
      return UNPATCHED_RESULT
    }

    if (!previousMatches && !nextMatches) {
      continue
    }

    const targetRows = nextRows ?? rows
    const identity = readProjectedMutationRowIdentity(previousRow, context, identityCache)
    if (identity === MISSING_PROJECTED_IDENTITY || typeof identity === 'undefined') {
      return UNPATCHED_RESULT
    }

    const rowIndex = findProjectedRowIndexByIdentity(targetRows, context, identity, identityCache)
    if (rowIndex === MISSING_PROJECTED_IDENTITY || rowIndex === DUPLICATE_ROW_IDENTITY) {
      return UNPATCHED_RESULT
    }

    if (previousMatches && !nextMatches) {
      if (typeof rowIndex === 'undefined') {
        continue
      }

      nextRows = removeRowByIndexLazily(targetRows, rowIndex)
      continue
    }

    if (!previousMatches && nextMatches) {
      if (typeof rowIndex !== 'undefined' || !canPatchProjectedPreviousRowsEnteringUpdate(query)) {
        return UNPATCHED_RESULT
      }

      const nextFullRow = Object.freeze({
        ...previousRow,
        ...mutation.values,
      })
      const upsertedRows = upsertProjectedPatchRowLazily(
        rows,
        nextRows,
        query,
        context,
        nextFullRow,
        identityCache,
        context.orderColumns,
        context.orderMultipliers,
        orderState,
      )
      if (upsertedRows === MISSING_PROJECTED_IDENTITY) {
        return UNPATCHED_RESULT
      }

      if (upsertedRows) {
        nextRows = upsertedRows
      }
      continue
    }

    if (typeof rowIndex === 'undefined') {
      if (context.queryOrderChanged && isFullProjectedPreviousRowsWindow(rows, query)) {
        return UNPATCHED_RESULT
      }

      continue
    }

    if (!context.projectedSelectionChanged) {
      continue
    }

    const currentRow = targetRows[rowIndex]!
    const nextRow = mergeProjectedMutationValuesWithContext(currentRow, context, mutation.values)
    if (!nextRow) {
      return UNPATCHED_RESULT
    }

    if (nextRow === currentRow) {
      continue
    }

    if (context.queryOrderChanged) {
      return UNPATCHED_RESULT
    }

    nextRows = replaceRowByIndexLazily(targetRows, rowIndex, nextRow)
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

function canPatchProjectedPreviousRowsEnteringUpdate(query: DatabaseQueryObservation): boolean {
  return hasQueryOrderBy(query) || readQueryRowWindowMode(query) === 'single'
}

function isFullProjectedPreviousRowsWindow(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
): boolean {
  return readQueryRowWindowMode(query) === 'limited' && rows.length === query.limit
}

function tryApplyProjectedStableUpdateRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  context: RowPatchContext,
): PatchRowsResult | undefined {
  if (mutation.kind !== 'update' || !mutation.rows || !mutation.values || context.queryOrderChanged) {
    return undefined
  }

  const previousRows = mutation.previousRows
  if (previousRows) {
    if (
      readPreviousMutationRowsContainExactQueryId(context, mutation) === false
      && readMutationRowsContainExactQueryId(context, mutation) === false
    ) {
      return UNCHANGED_ROWS_RESULT
    }
  } else if (
    exactIdsDiffer(context.exactQueryId, context.exactMutationId)
    && readMutationRowsContainExactQueryId(context, mutation) === false
  ) {
    return UNCHANGED_ROWS_RESULT
  }

  const singleRowResult = tryApplySingleProjectedStableUpdateRow(rows, mutation, context, mutation.values)
  if (singleRowResult) {
    return singleRowResult
  }

  const rowIndexes = readQueryRowIdentityIndex(query, rows)
  if (!rowIndexes) {
    return undefined
  }

  let nextRows: Readonly<Record<string, unknown>>[] | undefined
  const identityCache = readProjectedRowIdentityCache(context)
  for (let index = 0; index < mutation.rows.length; index += 1) {
    const row = mutation.rows[index]
    if (!row) {
      continue
    }

    const identitySourceRow = previousRows?.[index] ?? row
    const identity = readProjectedMutationRowIdentity(identitySourceRow, context, identityCache)
    if (identity === MISSING_PROJECTED_IDENTITY || typeof identity === 'undefined') {
      return UNPATCHED_RESULT
    }

    const rowIndex = rowIndexes.get(identity)
    const matches = matchesPatchedPredicateContext(row, mutation.values, context.queryPredicates)
    if (typeof matches === 'undefined') {
      return UNPATCHED_RESULT
    }

    if (typeof rowIndex === 'undefined') {
      if (matches) {
        return undefined
      }

      continue
    }

    if (!matches) {
      return undefined
    }

    if (!context.projectedSelectionChanged) {
      continue
    }

    const nextIdentity = readProjectedMutationRowIdentity(row, context, identityCache)
    if (nextIdentity === MISSING_PROJECTED_IDENTITY) {
      return UNPATCHED_RESULT
    }

    if (nextIdentity !== identity) {
      return undefined
    }

    const currentRows = nextRows ?? rows
    const currentRow = currentRows[rowIndex]
    if (!currentRow) {
      return undefined
    }

    const nextRow = mergeProjectedPatchRowAndMutationValuesWithContext(currentRow, context, row, mutation.values)
    if (!nextRow) {
      return UNPATCHED_RESULT
    }

    if (nextRow === currentRow) {
      continue
    }

    if (!nextRows) {
      nextRows = replaceRowByIndexLazily(rows, rowIndex, nextRow)
      continue
    }

    nextRows[rowIndex] = nextRow
  }

  return nextRows
    ? { patched: true, rows: Object.freeze(nextRows) }
    : UNCHANGED_ROWS_RESULT
}

export function applyProjectedMutationToRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  context: RowPatchContext,
): PatchRowsResult {
  if (!hasMutationRows(mutation)) {
    if (hasProjectedPreviousRowsUpdateMutation(mutation)) {
      return tryApplyProjectedPreviousRowsMutationValues(rows, query, mutation, context)
    }

    return tryApplyProjectedExactMutationValues(rows, mutation, context) ?? UNPATCHED_RESULT
  }

  if (mutation.kind === 'insert' || mutation.kind === 'upsert') {
    let nextRows: Readonly<Record<string, unknown>>[] | undefined
    const identityCache = readProjectedRowIdentityCache(context)
    const orderState: RowsOrderState = { preserved: true }
    if (readMutationRowsContainExactQueryId(context, mutation) === false) {
      return UNCHANGED_ROWS_RESULT
    }

    for (const row of mutation.rows) {
      const matches = matchesPredicateContext(row, context.queryPredicates)
      if (typeof matches === 'undefined') {
        return UNPATCHED_RESULT
      }

      if (!matches) {
        if (mutation.kind === 'upsert') {
          const withoutRow = removeRowByProjectedIdentityLazily(
            rows,
            nextRows,
            query,
            context,
            row,
            identityCache,
          )
          if (withoutRow === MISSING_PROJECTED_IDENTITY) {
            return UNPATCHED_RESULT
          }

          if (withoutRow) {
            nextRows = withoutRow
          }
        }
        continue
      }

      const upsertedRows = upsertProjectedPatchRowLazily(
        rows,
        nextRows,
        query,
        context,
        row,
        identityCache,
        context.orderColumns,
        context.orderMultipliers,
        orderState,
      )
      if (upsertedRows === MISSING_PROJECTED_IDENTITY) {
        return UNPATCHED_RESULT
      }

      if (upsertedRows) {
        nextRows = upsertedRows
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

  if (mutation.kind === 'delete') {
    if (readMutationRowsContainExactQueryId(context, mutation) === false) {
      return UNCHANGED_ROWS_RESULT
    }

    const remainingRows = removeRowsByProjectedIdentity(
      rows,
      query,
      context,
      mutation.rows,
      readProjectedRowIdentityCache(context),
    )
    if (!remainingRows) {
      return UNPATCHED_RESULT
    }

    if (remainingRows.length === rows.length) {
      return UNCHANGED_ROWS_RESULT
    }

    if (remainingRows.length < rows.length && !canPatchShrinkingRows(rows, query)) {
      return canBackfillShrinkingRows(rows, remainingRows, query)
        ? { patched: true, backfill: true, rows: remainingRows }
        : UNPATCHED_RESULT
    }

    return { patched: true, rows: remainingRows }
  }

  if (!mutation.previousRows) {
    return applyProjectedReturnedUpdateRowsToRows(rows, query, mutation, context)
  }

  if (mutation.previousRows.length !== mutation.rows.length) {
    return UNPATCHED_RESULT
  }

  const stableRows = tryApplyProjectedStableUpdateRows(rows, query, mutation, context)
  if (stableRows) {
    return stableRows
  }

  let nextRows: Readonly<Record<string, unknown>>[] | undefined
  const orderState: RowsOrderState = { preserved: true }
  if (
    readPreviousMutationRowsContainExactQueryId(context, mutation) === false
    && readMutationRowsContainExactQueryId(context, mutation) === false
  ) {
    return UNCHANGED_ROWS_RESULT
  }

  const identityCache = readProjectedRowIdentityCache(context)
  const withoutPreviousRows = removeRowsByProjectedIdentityLazily(
    rows,
    nextRows,
    query,
    context,
    mutation.previousRows,
    identityCache,
  )
  if (withoutPreviousRows === MISSING_PROJECTED_IDENTITY) {
    return UNPATCHED_RESULT
  }
  if (withoutPreviousRows) {
    nextRows = withoutPreviousRows
  }

  for (const row of mutation.rows) {
    const matches = matchesPredicateContext(row, context.queryPredicates)
    if (typeof matches === 'undefined') {
      return UNPATCHED_RESULT
    }

    if (!matches) {
      continue
    }

    const upsertedRows = upsertProjectedPatchRowLazily(
      rows,
      nextRows,
      query,
      context,
      row,
      identityCache,
      context.orderColumns,
      context.orderMultipliers,
      orderState,
    )
    if (upsertedRows === MISSING_PROJECTED_IDENTITY) {
      return UNPATCHED_RESULT
    }

    if (upsertedRows) {
      nextRows = upsertedRows
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

function applyProjectedReturnedUpdateRowsToRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEventWithRows,
  context: RowPatchContext,
): PatchRowsResult {
  const stableRows = tryApplyProjectedStableUpdateRows(rows, query, mutation, context)
  if (stableRows) {
    return stableRows
  }

  const identityCache = readProjectedRowIdentityCache(context)
  const nextRowsWithoutReturnedRows = removeRowsByProjectedIdentityLazily(
    rows,
    undefined,
    query,
    context,
    mutation.rows,
    identityCache,
  )
  if (nextRowsWithoutReturnedRows === MISSING_PROJECTED_IDENTITY) {
    return UNPATCHED_RESULT
  }

  let nextRows = nextRowsWithoutReturnedRows
  const orderState: RowsOrderState = { preserved: nextRowsWithoutReturnedRows === rows }
  if (readMutationRowsContainExactQueryId(context, mutation) === false) {
    return UNCHANGED_ROWS_RESULT
  }

  for (const row of mutation.rows) {
    const matches = matchesPredicateContext(row, context.queryPredicates)
    if (typeof matches === 'undefined') {
      return UNPATCHED_RESULT
    }

    if (!matches) {
      continue
    }

    const upsertedRows = upsertProjectedPatchRowLazily(
      rows,
      nextRows,
      query,
      context,
      row,
      identityCache,
      context.orderColumns,
      context.orderMultipliers,
      orderState,
    )
    if (upsertedRows === MISSING_PROJECTED_IDENTITY) {
      return UNPATCHED_RESULT
    }

    if (upsertedRows) {
      nextRows = upsertedRows
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
