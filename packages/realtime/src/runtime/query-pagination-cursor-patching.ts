import type {
  DatabaseMutationEvent,
} from './dependencies'
import {
  matchesPatchedPredicate,
  matchesPredicates,
  readMutationValueKeys,
  valueKeysChangeColumns,
} from './predicate-matching'
import {
  readQueryOrderColumns,
  readQueryPredicateColumns,
} from './query-metadata'
import {
  UNCHANGED_QUERY_RESULT,
  UNPATCHED_RESULT,
} from './query-patch-results'
import {
  hydrateBelongsToMutationRows,
} from './query-belongs-to-hydration'
import {
  hydrateRelatedMutationRows,
} from './query-related-hydration'
import type {
  DatabaseQueryCursorPaginationObservation,
  DatabaseQueryObservation,
  PatchQueryResult,
} from './query-state'
import type { BackfillCache } from './state'
import {
  sortRowsForQuery,
} from './query-row-ordering'
import {
  rowIdentity,
} from './query-row-identity'

type PatchedPreviousRowsMutation = DatabaseMutationEvent & {
  readonly previousRows: readonly Readonly<Record<string, unknown>>[]
  readonly values: Readonly<Record<string, unknown>>
}

export async function tryPatchCursorPaginationNextCursor(
  query: DatabaseQueryObservation,
  pagination: DatabaseQueryCursorPaginationObservation,
  value: unknown,
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache,
): Promise<PatchQueryResult> {
  let rowCount = pagination.rowCount
  let rows = pagination.rows
  let changed = false
  for (const mutation of mutations) {
    const belongsToHydratedMutation = await hydrateBelongsToMutationRows(
      mutation,
      query.belongsToHydrations,
      backfills,
    )
    const hydratedMutation = belongsToHydratedMutation
      ? await hydrateRelatedMutationRows(
          belongsToHydratedMutation,
          query.relatedHydrations,
          backfills,
        )
      : undefined
    if (!hydratedMutation) {
      return UNPATCHED_RESULT
    }

    if (cursorMutationKeepsWindowStable(query, hydratedMutation)) {
      continue
    }

    if (hydratedMutation.kind === 'insert') {
      const insertResult = applyCursorInsertMutation(query, hydratedMutation, rows, rowCount)
      if (!insertResult) {
        return UNPATCHED_RESULT
      }

      rows = insertResult.rows
      rowCount = insertResult.rowCount
      changed = changed || insertResult.changed
      continue
    }

    if (hydratedMutation.kind === 'delete') {
      const deleteResult = applyCursorDeleteMutation(query, hydratedMutation, rows, rowCount)
      if (!deleteResult) {
        return UNPATCHED_RESULT
      }

      rows = deleteResult.rows
      rowCount = deleteResult.rowCount
      changed = changed || deleteResult.changed
      continue
    }

    if ((hydratedMutation.kind === 'update' || hydratedMutation.kind === 'upsert') && hasPatchedPreviousRowsMutation(hydratedMutation)) {
      const updateResult = applyCursorPatchedPreviousRowsMutation(query, hydratedMutation, rows, rowCount)
      if (!updateResult) {
        return UNPATCHED_RESULT
      }

      rows = updateResult.rows
      rowCount = updateResult.rowCount
      changed = changed || updateResult.changed
      continue
    }

    return UNPATCHED_RESULT
  }

  if (!changed) {
    return UNCHANGED_QUERY_RESULT
  }

  const sortedRows = sortRowsForQuery(rows, query)
  if (!sortedRows) {
    return UNPATCHED_RESULT
  }

  if (sortedRows.length < Math.min(rowCount, pagination.perPage)) {
    return UNPATCHED_RESULT
  }

  const retainedRows = retainCursorRows(sortedRows, pagination.perPage)
  const visibleRows = readCursorVisibleRows(retainedRows, pagination.perPage)
  const nextCursor = createCursorNextCursor(query, visibleRows, pagination.perPage, rowCount)
  const nextQuery = Object.freeze({
    ...query,
    pagination: Object.freeze({
      ...pagination,
      hasMorePages: nextCursor !== null,
      nextCursor,
      rows: retainedRows,
      rowCount,
    }),
  })

  return value === nextCursor
    ? Object.freeze({
        nextQuery,
        patched: true,
        unchanged: true,
      })
    : Object.freeze({
        nextQuery,
        patched: true,
        query,
        value: nextCursor,
      })
}

type CursorPaginationMutationResult = {
  readonly changed: boolean
  readonly rows: readonly Readonly<Record<string, unknown>>[]
  readonly rowCount: number
}

function applyCursorInsertMutation(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  rows: readonly Readonly<Record<string, unknown>>[],
  rowCount: number,
): CursorPaginationMutationResult | undefined {
  if (!mutation.rows) {
    return undefined
  }

  let nextRows = rows
  let nextRowCount = rowCount
  let changed = false
  for (const row of mutation.rows) {
    const matches = matchesPredicates(row, query.predicates)
    if (typeof matches === 'undefined') {
      return undefined
    }

    if (!matches) {
      continue
    }

    nextRowCount += 1
    nextRows = Object.freeze([...nextRows, row])
    changed = true
  }

  return {
    changed,
    rows: nextRows,
    rowCount: nextRowCount,
  }
}

function applyCursorDeleteMutation(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  rows: readonly Readonly<Record<string, unknown>>[],
  rowCount: number,
): CursorPaginationMutationResult | undefined {
  if (!mutation.rows) {
    return undefined
  }

  let nextRows = rows
  let nextRowCount = rowCount
  let changed = false
  for (const row of mutation.rows) {
    const matches = matchesPredicates(row, query.predicates)
    if (typeof matches === 'undefined') {
      return undefined
    }

    if (!matches) {
      continue
    }

    const identity = rowIdentity(row)
    if (typeof identity === 'undefined') {
      return undefined
    }

    nextRowCount -= 1
    if (nextRowCount < 0) {
      return undefined
    }

    const remainingRows = removeCursorRowByIdentity(nextRows, identity)
    if (remainingRows) {
      nextRows = remainingRows
    }
    changed = true
  }

  return {
    changed,
    rows: nextRows,
    rowCount: nextRowCount,
  }
}

function hasPatchedPreviousRowsMutation(
  mutation: DatabaseMutationEvent,
): mutation is PatchedPreviousRowsMutation {
  return Boolean(mutation.previousRows && mutation.values)
}

function applyCursorPatchedPreviousRowsMutation(
  query: DatabaseQueryObservation,
  mutation: PatchedPreviousRowsMutation,
  rows: readonly Readonly<Record<string, unknown>>[],
  rowCount: number,
): CursorPaginationMutationResult | undefined {
  let nextRows = rows
  let nextRowCount = rowCount
  let changed = false
  const orderChanged = valueKeysChangeColumns(readMutationValueKeys(mutation), readQueryOrderColumns(query))
  for (const row of mutation.previousRows) {
    const previousMatches = matchesPredicates(row, query.predicates)
    const nextMatches = matchesPatchedPredicates(row, mutation.values, query.predicates)
    if (typeof previousMatches === 'undefined' || typeof nextMatches === 'undefined') {
      return undefined
    }

    if (!previousMatches && !nextMatches) {
      continue
    }

    const identity = rowIdentity(row)
    if (typeof identity === 'undefined') {
      return undefined
    }

    if (previousMatches && !nextMatches) {
      nextRowCount -= 1
      if (nextRowCount < 0) {
        return undefined
      }

      const remainingRows = removeCursorRowByIdentity(nextRows, identity)
      if (remainingRows) {
        nextRows = remainingRows
      }
      changed = true
      continue
    }

    const nextRow = Object.freeze({
      ...row,
      ...mutation.values,
    })
    const rowIndex = nextRows.findIndex(candidate => rowIdentity(candidate) === identity)
    if (!previousMatches && nextMatches) {
      if (rowIndex >= 0) {
        return undefined
      }

      nextRowCount += 1
      nextRows = Object.freeze([...nextRows, nextRow])
      changed = true
      continue
    }

    if (rowIndex < 0) {
      if (orderChanged) {
        return undefined
      }

      continue
    }

    nextRows = Object.freeze([
      ...nextRows.slice(0, rowIndex),
      nextRow,
      ...nextRows.slice(rowIndex + 1),
    ])
    changed = true
  }

  return {
    changed,
    rows: nextRows,
    rowCount: nextRowCount,
  }
}

function matchesPatchedPredicates(
  row: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, unknown>>,
  predicates: DatabaseQueryObservation['predicates'],
): boolean | undefined {
  for (const predicate of predicates) {
    const matches = matchesPatchedPredicate(row, values, predicate)
    if (typeof matches === 'undefined') {
      return undefined
    }

    if (!matches) {
      return false
    }
  }

  return true
}

function removeCursorRowByIdentity(
  rows: readonly Readonly<Record<string, unknown>>[],
  identity: unknown,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  const index = rows.findIndex(row => rowIdentity(row) === identity)
  if (index < 0) {
    return undefined
  }

  return Object.freeze([
    ...rows.slice(0, index),
    ...rows.slice(index + 1),
  ])
}

function retainCursorRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  perPage: number,
): readonly Readonly<Record<string, unknown>>[] {
  const retainedLength = perPage + 1
  return rows.length <= retainedLength
    ? rows
    : Object.freeze(rows.slice(0, retainedLength))
}

function readCursorVisibleRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  perPage: number,
): readonly Readonly<Record<string, unknown>>[] {
  return rows.length <= perPage
    ? rows
    : Object.freeze(rows.slice(0, perPage))
}

function cursorMutationKeepsWindowStable(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
): boolean {
  if (mutation.kind !== 'update' || !mutation.values) {
    return false
  }

  const queryColumns = [
    ...readQueryOrderColumns(query),
    ...readQueryPredicateColumns(query),
  ]

  return !valueKeysChangeColumns(readMutationValueKeys(mutation), queryColumns)
}

function createCursorNextCursor(
  query: DatabaseQueryObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  perPage: number,
  rowCount: number,
): string | null {
  if (rowCount <= perPage) {
    return null
  }

  const lastRow = rows.at(-1)
  if (!lastRow) {
    return null
  }

  return encodeCursorValues(query.orderBy.map(order => lastRow[order.column]))
}

function encodeCursorValues(values: readonly unknown[]): string {
  return Buffer.from(JSON.stringify({ values }), 'utf8').toString('base64url')
}
