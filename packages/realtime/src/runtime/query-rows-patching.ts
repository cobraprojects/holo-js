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
  hydrateBelongsToMutationRows,
} from './query-belongs-to-hydration'
import {
  hydrateRelatedMutationRows,
} from './query-related-hydration'
import {
  createMutationRowPatchContext,
  projectedUpdateCannotAffectQueryResult,
  readMutationPatchMetadata,
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
    const localPatch = await tryPatchOffsetQueryRows(
      query,
      rows,
      mutations,
      backfills,
      queryContext,
      applyMutation,
    )
    if (localPatch) {
      return localPatch
    }

    const backfilledRows = await backfillOffsetQueryRows(query, backfills)
    return backfilledRows
      ? Object.freeze({
          patched: true,
          query,
          value: backfilledRows,
        })
      : UNPATCHED_RESULT
  }

  let patchedRows = rows
  let changed = false
  let needsBackfill = false
  for (const mutation of mutations) {
    const metadata = readMutationPatchMetadata(mutation, backfills)
    if (projectedUpdateCannotAffectQueryResult(query, queryContext, mutation, metadata)) {
      continue
    }

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
      return await tryBackfillCurrentQueryRows(query, backfills)
    }

    const result = applyMutation(patchedRows, query, hydratedMutation, createMutationRowPatchContext(queryContext, metadata))
    if (!result.patched) {
      return await tryBackfillCurrentQueryRows(query, backfills)
    }

    if ('rows' in result) {
      changed = true
      needsBackfill = needsBackfill || result.backfill === true
      patchedRows = result.rows
    }
  }

  if (!changed) {
    return UNCHANGED_QUERY_RESULT
  }

  if (needsBackfill) {
    const backfilledRows = await backfillLimitedQueryRows(query, patchedRows, backfills)
    if (!backfilledRows) {
      return await tryBackfillCurrentQueryRows(query, backfills)
    }

    patchedRows = backfilledRows
  }

  return Object.freeze({
    patched: true,
    query,
    value: patchedRows,
  })
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

  let patchedRows = rows
  let changed = false
  for (const mutation of mutations) {
    const metadata = readMutationPatchMetadata(mutation, backfills)
    if (projectedUpdateCannotAffectQueryResult(query, queryContext, mutation, metadata)) {
      continue
    }

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
      return await tryBackfillCurrentQueryRows(query, backfills)
    }

    const result = applyMutation(
      patchedRows,
      query,
      hydratedMutation,
      createMutationRowPatchContext(queryContext, metadata),
    )
    if (!result.patched) {
      return await tryBackfillCurrentQueryRows(query, backfills)
    }

    if ('rows' in result) {
      if (result.backfill === true || result.rows.length !== patchedRows.length) {
        const backfilledRows = await backfillLimitedQueryRows(query, result.rows, backfills)
        if (!backfilledRows) {
          return await tryBackfillCurrentQueryRows(query, backfills)
        }

        changed = true
        patchedRows = backfilledRows
        continue
      }

      changed = true
      patchedRows = result.rows
    }
  }

  return changed
    ? Object.freeze({
        patched: true,
        query,
        value: patchedRows,
      })
    : UNCHANGED_QUERY_RESULT
}

async function tryBackfillCurrentQueryRows(
  query: DatabaseQueryObservation,
  backfills: BackfillCache,
): Promise<PatchQueryResult> {
  const backfilledRows = await backfillCurrentQueryRows(query, backfills)
  return backfilledRows
    ? Object.freeze({
        patched: true,
        query,
        value: backfilledRows,
      })
    : UNPATCHED_RESULT
}

async function tryPatchOffsetQueryRows(
  query: DatabaseQueryObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache,
  queryContext: QueryRowPatchContext,
  applyMutation: RowMutationApplier,
): Promise<PatchQueryResult | undefined> {
  let patchedRows = rows
  let changed = false
  for (const mutation of mutations) {
    const metadata = readMutationPatchMetadata(mutation, backfills)
    if (projectedUpdateCannotAffectQueryResult(query, queryContext, mutation, metadata)) {
      continue
    }

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

    if (!canPatchStableWindowMutationWithoutBackfill(query, hydratedMutation, metadata)) {
      return undefined
    }

    const result = applyMutation(
      patchedRows,
      query,
      hydratedMutation,
      createMutationRowPatchContext(queryContext, metadata),
    )
    if (!result.patched) {
      return undefined
    }

    if ('rows' in result) {
      if (result.rows.length !== patchedRows.length) {
        return undefined
      }

      changed = true
      patchedRows = result.rows
    }
  }

  return changed
    ? Object.freeze({
        patched: true,
        query,
        value: patchedRows,
      })
    : UNCHANGED_QUERY_RESULT
}
