import type {
  DatabaseMutationEvent,
} from './dependencies'
import {
  UNCHANGED_QUERY_RESULT,
  UNPATCHED_RESULT,
} from './query-patch-results'
import {
  backfillCurrentQueryRows,
  backfillLimitedQueryRows,
  backfillOffsetQueryRows,
} from './query-row-backfill'
import {
  tryPatchCursorWrapperDataRows,
} from './query-cursor-wrapper-patching'
import {
  createMutationRowPatchContext,
} from './query-row-patching'
import {
  canPatchStableWindowMutationWithoutBackfill,
} from './query-stable-window'
import type {
  DatabaseQueryObservation,
  PatchQueryResult,
  QueryRowPatchContext,
  RowMutationApplier,
  RowsQueryPatchTarget,
} from './query-state'
import type { BackfillCache } from './state'
import { prepareRowWindowMutation } from './query-row-window-mutation'

type RowWindowPolicy = 'standard' | 'wrapper' | 'offset'
type PatchedRowWindow = {
  readonly rows: readonly Readonly<Record<string, unknown>>[]
  readonly changed: boolean
  readonly needsBackfill: boolean
}

export async function tryPatchQueryRows(
  query: DatabaseQueryObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache,
  queryContext: QueryRowPatchContext,
  applyMutation: RowMutationApplier,
  rowPatchMode: RowsQueryPatchTarget['rowPatchMode'],
): Promise<PatchQueryResult> {
  if (mutations.length === 0) {
    return UNPATCHED_RESULT
  }

  if (rowPatchMode === 'offset-window') {
    const localPatch = await tryPatchOffsetQueryRows(query, rows, mutations, backfills, queryContext, applyMutation)
    if (localPatch) {
      return localPatch
    }

    const backfilledRows = await backfillOffsetQueryRows(query, backfills)
    return backfilledRows ? createPatchedRowsResult(query, backfilledRows) : UNPATCHED_RESULT
  }

  const patched = await patchRowWindowMutations(query, rows, mutations, backfills, queryContext, applyMutation, 'standard')
  if (!patched) {
    return await tryBackfillCurrentQueryRows(query, backfills)
  }

  if (!patched.changed) {
    return UNCHANGED_QUERY_RESULT
  }

  if (patched.needsBackfill) {
    const backfilledRows = await backfillLimitedQueryRows(query, patched.rows, backfills)
    return backfilledRows
      ? createPatchedRowsResult(query, backfilledRows)
      : await tryBackfillCurrentQueryRows(query, backfills)
  }

  return createPatchedRowsResult(query, patched.rows)
}

export async function tryPatchWrapperDataRows(
  query: DatabaseQueryObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache,
  queryContext: QueryRowPatchContext,
  applyMutation: RowMutationApplier,
): Promise<PatchQueryResult> {
  const cursorPatch = await tryPatchCursorWrapperDataRows(query, mutations, backfills)
  if (cursorPatch) {
    return cursorPatch
  }

  const patched = await patchRowWindowMutations(query, rows, mutations, backfills, queryContext, applyMutation, 'wrapper')
  if (!patched) {
    return await tryBackfillCurrentQueryRows(query, backfills)
  }

  return patched.changed ? createPatchedRowsResult(query, patched.rows) : UNCHANGED_QUERY_RESULT
}

async function tryPatchOffsetQueryRows(
  query: DatabaseQueryObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache,
  queryContext: QueryRowPatchContext,
  applyMutation: RowMutationApplier,
): Promise<PatchQueryResult | undefined> {
  const patched = await patchRowWindowMutations(query, rows, mutations, backfills, queryContext, applyMutation, 'offset')
  if (!patched) {
    return undefined
  }

  return patched.changed ? createPatchedRowsResult(query, patched.rows) : UNCHANGED_QUERY_RESULT
}

async function patchRowWindowMutations(
  query: DatabaseQueryObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache,
  queryContext: QueryRowPatchContext,
  applyMutation: RowMutationApplier,
  policy: RowWindowPolicy,
): Promise<PatchedRowWindow | undefined> {
  let patchedRows = rows
  let changed = false
  let needsBackfill = false
  for (const mutation of mutations) {
    const prepared = await prepareRowWindowMutation(query, queryContext, mutation, backfills)
    if (prepared === null) {
      continue
    }

    if (!prepared || (policy === 'offset' && !canPatchStableWindowMutationWithoutBackfill(query, prepared.mutation, prepared.metadata))) {
      return undefined
    }

    const result = applyMutation(patchedRows, query, prepared.mutation, createMutationRowPatchContext(queryContext, prepared.metadata))
    if (!result.patched) {
      return undefined
    }

    if (!('rows' in result)) {
      continue
    }

    if (policy === 'offset' && result.rows.length !== patchedRows.length) {
      return undefined
    }

    if (policy === 'wrapper' && (result.backfill === true || result.rows.length !== patchedRows.length)) {
      const backfilledRows = await backfillLimitedQueryRows(query, result.rows, backfills)
      if (!backfilledRows) {
        return undefined
      }

      patchedRows = backfilledRows
    } else {
      patchedRows = result.rows
    }

    changed = true
    needsBackfill = needsBackfill || result.backfill === true
  }

  return { rows: patchedRows, changed, needsBackfill }
}

function createPatchedRowsResult(
  query: DatabaseQueryObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
): PatchQueryResult {
  return Object.freeze({ patched: true, query, value: rows })
}

async function tryBackfillCurrentQueryRows(
  query: DatabaseQueryObservation,
  backfills: BackfillCache,
): Promise<PatchQueryResult> {
  const backfilledRows = await backfillCurrentQueryRows(query, backfills)
  return backfilledRows ? createPatchedRowsResult(query, backfilledRows) : UNPATCHED_RESULT
}
