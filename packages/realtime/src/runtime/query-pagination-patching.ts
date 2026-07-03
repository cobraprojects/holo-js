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
  readQueryPredicateColumns,
} from './query-metadata'
import {
  UNCHANGED_QUERY_RESULT,
  UNPATCHED_RESULT,
} from './query-patch-results'
import type {
  DatabaseQueryObservation,
  DatabaseQuerySimplePaginationObservation,
  DatabaseQueryStandardPaginationObservation,
  PatchQueryResult,
} from './query-state'
import type { BackfillCache } from './state'
import {
  getPaginationCountBackfill,
} from './query-pagination-count-backfill'
import {
  tryPatchCursorPaginationNextCursor,
} from './query-pagination-cursor-patching'
import { isRecord } from './value'

export async function tryPatchQueryPaginationMeta(
  query: DatabaseQueryObservation,
  value: unknown,
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache,
): Promise<PatchQueryResult> {
  const pagination = query.pagination
  if (!pagination) {
    return UNPATCHED_RESULT
  }

  if (pagination.kind === 'cursor') {
    return await tryPatchCursorPaginationNextCursor(query, pagination, value, mutations, backfills)
  }

  if (!isRecord(value)) {
    return UNPATCHED_RESULT
  }

  let rowCount = pagination.kind === 'standard' ? pagination.total : pagination.rowCount
  let needsCountBackfill = false
  for (const mutation of mutations) {
    const delta = readPaginationMutationTotalDelta(query, mutation)
    if (typeof delta === 'undefined') {
      needsCountBackfill = true
      break
    }

    rowCount += delta
    if (rowCount < 0) {
      return UNPATCHED_RESULT
    }
  }

  const previousRowCount = pagination.kind === 'standard' ? pagination.total : pagination.rowCount
  if (needsCountBackfill) {
    const backfilledCount = await getPaginationCountBackfill(query, backfills)
    if (typeof backfilledCount === 'undefined') {
      return UNPATCHED_RESULT
    }

    rowCount = backfilledCount
  }

  if (rowCount === previousRowCount) {
    return UNCHANGED_QUERY_RESULT
  }

  const nextValue = createPaginationMetaValue(pagination, rowCount)
  const nextQuery = Object.freeze({
    ...query,
    pagination: pagination.kind === 'standard'
      ? Object.freeze({
          ...pagination,
          total: rowCount,
        })
      : Object.freeze({
          ...pagination,
          hasMorePages: readHasMorePages(pagination, rowCount),
          rowCount,
        }),
  })

  return paginationMetaValuesEqual(value, nextValue)
    ? Object.freeze({
        nextQuery,
        patched: true,
        unchanged: true,
      })
    : Object.freeze({
        nextQuery,
        patched: true,
        query,
        value: nextValue,
      })
}

function readPaginationMutationTotalDelta(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
): number | undefined {
  if (mutation.kind === 'insert') {
    return mutation.rows ? countMatchingRows(query, mutation.rows) : undefined
  }

  if (mutation.kind === 'delete') {
    const count = mutation.rows ? countMatchingRows(query, mutation.rows) : undefined
    return typeof count === 'undefined' ? undefined : -count
  }

  if (
    mutation.kind === 'update'
    && !paginationUpdateCanChangeRowCount(query, mutation)
  ) {
    return 0
  }

  if (!mutation.rows || !mutation.previousRows) {
    if (mutation.previousRows && mutation.values) {
      const previousCount = countMatchingRows(query, mutation.previousRows)
      const nextCount = countMatchingPatchedRows(query, mutation.previousRows, mutation.values)
      return typeof previousCount === 'undefined' || typeof nextCount === 'undefined'
        ? undefined
        : nextCount - previousCount
    }

    return undefined
  }

  const previousCount = countMatchingRows(query, mutation.previousRows)
  const nextCount = countMatchingRows(query, mutation.rows)
  return typeof previousCount === 'undefined' || typeof nextCount === 'undefined'
    ? undefined
    : nextCount - previousCount
}

function paginationUpdateCanChangeRowCount(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
): boolean {
  const predicateColumns = readQueryPredicateColumns(query)
  if (predicateColumns.length === 0) {
    return false
  }

  return !mutation.values || valueKeysChangeColumns(readMutationValueKeys(mutation), predicateColumns)
}

function countMatchingRows(
  query: DatabaseQueryObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
): number | undefined {
  let count = 0
  for (const row of rows) {
    const matches = matchesPredicates(row, query.predicates)
    if (typeof matches === 'undefined') {
      return undefined
    }

    if (matches) {
      count += 1
    }
  }

  return count
}

function countMatchingPatchedRows(
  query: DatabaseQueryObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  values: Readonly<Record<string, unknown>>,
): number | undefined {
  let count = 0
  for (const row of rows) {
    const matches = matchesPatchedPredicates(row, values, query.predicates)
    if (typeof matches === 'undefined') {
      return undefined
    }

    if (matches) {
      count += 1
    }
  }

  return count
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

function createPaginationMetaValue(
  pagination: DatabaseQueryStandardPaginationObservation | DatabaseQuerySimplePaginationObservation,
  rowCount: number,
): Readonly<Record<string, unknown>> {
  const offset = (pagination.currentPage - 1) * pagination.perPage
  const from = rowCount === 0 || offset >= rowCount ? null : offset + 1
  const to = from === null ? null : Math.min(offset + pagination.perPage, rowCount)

  if (pagination.kind === 'standard') {
    return Object.freeze({
      total: rowCount,
      perPage: pagination.perPage,
      pageName: pagination.pageName,
      currentPage: pagination.currentPage,
      lastPage: Math.max(1, Math.ceil(rowCount / pagination.perPage)),
      from,
      to,
      hasMorePages: readHasMorePages(pagination, rowCount),
    })
  }

  return Object.freeze({
    perPage: pagination.perPage,
    pageName: pagination.pageName,
    currentPage: pagination.currentPage,
    from,
    to,
    hasMorePages: readHasMorePages(pagination, rowCount),
  })
}

function readHasMorePages(
  pagination: DatabaseQueryStandardPaginationObservation | DatabaseQuerySimplePaginationObservation,
  rowCount: number,
): boolean {
  const offset = (pagination.currentPage - 1) * pagination.perPage
  return offset + pagination.perPage < rowCount
}

function paginationMetaValuesEqual(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  const keys = Object.keys(right)
  for (const key of keys) {
    if (left[key] !== right[key]) {
      return false
    }
  }

  return keys.length === Object.keys(left).length
}
