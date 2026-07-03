import type {
  DatabaseMutationEvent,
} from './dependencies'
import {
  matchesPredicates,
} from './predicate-matching'
import {
  UNCHANGED_QUERY_RESULT,
} from './query-patch-results'
import {
  hydrateBelongsToMutationRows,
} from './query-belongs-to-hydration'
import {
  hydrateRelatedMutationRows,
} from './query-related-hydration'
import {
  rowIdentity,
} from './query-row-identity'
import {
  sortRowsForQuery,
} from './query-row-ordering'
import type {
  DatabaseQueryObservation,
  PatchQueryResult,
} from './query-state'
import type { BackfillCache } from './state'

type CursorWrapperMutationResult = {
  readonly changed: boolean
  readonly rows: readonly Readonly<Record<string, unknown>>[]
  readonly rowCount: number
}

export async function tryPatchCursorWrapperDataRows(
  query: DatabaseQueryObservation,
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache,
): Promise<PatchQueryResult | undefined> {
  const cursorRows = query.cursorRows
  const rowCount = query.cursorRowCount
  const perPage = query.limit
  if (!cursorRows || typeof rowCount !== 'number' || typeof perPage !== 'number') {
    return undefined
  }

  let patchedRows = cursorRows
  let patchedRowCount = rowCount
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
      return undefined
    }

    const result = applyCursorWrapperMutation(query, hydratedMutation, patchedRows, patchedRowCount)
    if (!result) {
      return undefined
    }

    patchedRows = result.rows
    patchedRowCount = result.rowCount
    changed = changed || result.changed
  }

  if (!changed) {
    return UNCHANGED_QUERY_RESULT
  }

  const sortedRows = sortRowsForQuery(patchedRows, query)
  if (!sortedRows || sortedRows.length < Math.min(patchedRowCount, perPage)) {
    return undefined
  }

  const retainedRows = sortedRows.length <= perPage + 1
    ? sortedRows
    : Object.freeze(sortedRows.slice(0, perPage + 1))
  const visibleRows = retainedRows.length <= perPage
    ? retainedRows
    : Object.freeze(retainedRows.slice(0, perPage))

  return Object.freeze({
    nextQuery: Object.freeze({
      ...query,
      cursorRowCount: patchedRowCount,
      cursorRows: retainedRows,
    }),
    patched: true,
    query,
    value: visibleRows,
  })
}

function applyCursorWrapperMutation(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  rows: readonly Readonly<Record<string, unknown>>[],
  rowCount: number,
): CursorWrapperMutationResult | undefined {
  if (mutation.kind === 'insert') {
    return applyCursorWrapperInsertMutation(query, mutation, rows, rowCount)
  }

  if (mutation.kind === 'delete') {
    return applyCursorWrapperDeleteMutation(query, mutation, rows, rowCount)
  }

  if (mutation.kind === 'update' || mutation.kind === 'upsert') {
    return applyCursorWrapperReturnedRowsMutation(query, mutation, rows, rowCount)
  }

  return undefined
}

function applyCursorWrapperInsertMutation(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  rows: readonly Readonly<Record<string, unknown>>[],
  rowCount: number,
): CursorWrapperMutationResult | undefined {
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

function applyCursorWrapperDeleteMutation(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  rows: readonly Readonly<Record<string, unknown>>[],
  rowCount: number,
): CursorWrapperMutationResult | undefined {
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

    const remainingRows = removeCursorWrapperRowByIdentity(nextRows, identity)
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

function applyCursorWrapperReturnedRowsMutation(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  rows: readonly Readonly<Record<string, unknown>>[],
  rowCount: number,
): CursorWrapperMutationResult | undefined {
  if (!mutation.rows) {
    return undefined
  }

  let nextRows = rows
  let changed = false
  for (const row of mutation.rows) {
    const identity = rowIdentity(row)
    if (typeof identity === 'undefined') {
      return undefined
    }

    const index = nextRows.findIndex(candidate => rowIdentity(candidate) === identity)
    const matches = matchesPredicates(row, query.predicates)
    if (typeof matches === 'undefined') {
      return undefined
    }

    if (index >= 0) {
      if (matches) {
        nextRows = Object.freeze([
          ...nextRows.slice(0, index),
          row,
          ...nextRows.slice(index + 1),
        ])
      } else {
        nextRows = Object.freeze([
          ...nextRows.slice(0, index),
          ...nextRows.slice(index + 1),
        ])
      }
      changed = true
      continue
    }

    if (matches) {
      nextRows = Object.freeze([...nextRows, row])
      changed = true
    }
  }

  return {
    changed,
    rows: nextRows,
    rowCount,
  }
}

function removeCursorWrapperRowByIdentity(
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
