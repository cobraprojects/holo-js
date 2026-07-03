import type {
  DatabaseMutationEvent,
} from './dependencies'
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
import {
  backfillCurrentQueryRows,
} from './query-row-backfill'
import {
  createMutationRowPatchContext,
  projectedUpdateCannotAffectQueryResult,
  readMutationPatchMetadata,
} from './query-row-patching'
import type {
  DatabaseQueryObservation,
  PatchQueryResult,
  QueryRowPatchContext,
  RowMutationApplier,
} from './query-state'
import type { BackfillCache } from './state'

export async function tryPatchQueryRecord(
  query: DatabaseQueryObservation,
  value: Readonly<Record<string, unknown>> | null | undefined,
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache,
  queryContext: QueryRowPatchContext,
  applyMutation: RowMutationApplier,
): Promise<PatchQueryResult> {
  const emptyValue = query.emptyRecordValue === null || value === null ? null : undefined
  const rows = value === null || typeof value === 'undefined' ? Object.freeze([]) : Object.freeze([value])
  if (mutations.length === 0) {
    return UNPATCHED_RESULT
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
      return await tryBackfillCurrentQueryRecord(query, emptyValue, backfills)
    }

    const result = applyMutation(patchedRows, query, hydratedMutation, createMutationRowPatchContext(queryContext, metadata))
    if (!result.patched) {
      return await tryBackfillCurrentQueryRecord(query, emptyValue, backfills)
    }

    if ('rows' in result) {
      if (result.rows.length > 1) {
        return UNPATCHED_RESULT
      }

      changed = true
      patchedRows = result.rows
    }
  }

  if (!changed) {
    return UNCHANGED_QUERY_RESULT
  }

  return Object.freeze({
    patched: true,
    query,
    value: patchedRows[0] ?? emptyValue,
  })
}

async function tryBackfillCurrentQueryRecord(
  query: DatabaseQueryObservation,
  emptyValue: null | undefined,
  backfills: BackfillCache,
): Promise<PatchQueryResult> {
  const rows = await backfillCurrentQueryRows(query, backfills)
  if (!rows || rows.length > 1) {
    return UNPATCHED_RESULT
  }

  return Object.freeze({
    patched: true,
    query,
    value: rows[0] ?? emptyValue,
  })
}
