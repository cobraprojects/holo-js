import type {
  DatabaseMutationEvent,
} from './dependencies'
import {
  matchesPredicates,
} from './predicate-matching'
import {
  UNCHANGED_QUERY_RESULT,
  UNPATCHED_RESULT,
} from './query-patch-results'
import {
  rowIdentity,
} from './query-row-identity'
import {
  sortRowsForQuery,
} from './query-row-ordering'
import type {
  DatabaseQueryObservation,
  PatchQueryResult,
  RowPatchContext,
} from './query-state'
import type { BackfillCache } from './state'
import { canPatchPartialCursorMutation } from './query-stable-window'
import { backfillCurrentQueryRows } from './query-row-backfill'
import { prepareRowWindowMutation } from './query-row-window-mutation'
import { createMutationRowPatchContext, createQueryRowPatchContext } from './query-row-patch-context'
import { projectRowWithContext } from './query-row-projection'
import { isRecordArray } from './value'

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

  const queryContext = createQueryRowPatchContext(query)
  let patchContext: RowPatchContext | undefined
  let patchedRows = cursorRows
  let patchedRowCount = rowCount
  let changed = false
  for (const mutation of mutations) {
    if (query.cursorRowCountKnown === false && !canPatchPartialCursorMutation(query, mutation)) {
      const refreshedRows = await backfillCurrentQueryRows({ ...query, limit: perPage + 1, rowWindowMode: undefined }, backfills)
      if (!refreshedRows) return UNPATCHED_RESULT
      return Object.freeze({
        nextQuery: Object.freeze({
          ...query,
          cursorRowCount: refreshedRows.length,
          cursorRowCountKnown: refreshedRows.length <= perPage,
          cursorRows: refreshedRows,
        }),
        patched: true,
        query,
        value: refreshedRows.slice(0, perPage),
      })
    }
    const prepared = await prepareRowWindowMutation(query, queryContext, mutation, backfills)
    if (prepared === null) {
      continue
    }

    if (!prepared) {
      return undefined
    }

    patchContext = createMutationRowPatchContext(queryContext, prepared.metadata)
    const result = applyCursorWrapperMutation(query, prepared.mutation, patchedRows, patchedRowCount)
    if (!result) {
      return undefined
    }

    patchedRows = result.rows
    patchedRowCount = result.rowCount
    changed = changed || result.changed
  }

  if (!changed || !patchContext) {
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

  const projectedRows = projectCursorVisibleRows(query, visibleRows, patchContext)
  if (!projectedRows) {
    return undefined
  }

  return Object.freeze({
    nextQuery: Object.freeze({
      ...query,
      cursorRowCount: patchedRowCount,
      cursorRows: retainedRows,
    }),
    patched: true,
    query,
    value: projectedRows,
  })
}

function projectCursorVisibleRows(
  query: DatabaseQueryObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  context: RowPatchContext,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (!context.hasProjectedSelections) {
    return rows
  }

  const previousRows = isRecordArray(query.result) ? query.result : []
  const previousById = new Map(previousRows.map(row => [rowIdentity(row), row]))
  const projectedRows: Readonly<Record<string, unknown>>[] = []
  for (const row of rows) {
    const projected = projectRowWithContext(context, row)
    if (!projected) {
      return undefined
    }

    const identity = rowIdentity(row)
    const previous = typeof identity === 'undefined' ? undefined : previousById.get(identity)
    const resultKeys = Object.keys(projected)
    const unchanged = previous
      && Object.keys(previous).length === resultKeys.length
      && resultKeys.every(key => Object.is(previous[key], projected[key]))
    projectedRows.push(unchanged ? previous : projected)
  }

  return Object.freeze(projectedRows)
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
