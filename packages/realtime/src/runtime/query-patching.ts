import type {
  DatabaseMutationEvent,
} from './dependencies'
import {
  tryPatchQueryAggregate,
} from './query-aggregate-patching'
import {
  UNPATCHED_RESULT,
} from './query-patch-results'
import {
  tryPatchGroupedAggregateQuery,
} from './query-grouped-aggregate-patching'
import {
  tryPatchQueryPaginationMeta,
} from './query-pagination-patching'
import {
  tryPatchQueryRelation,
} from './query-relation-patching'

export {
  createPatchedQueryObservation,
  isPatchableQueryPatchTarget,
  readPatchPathKey,
  updateDelayedPatchedQueryPatchTarget,
  updatePatchedQueryPatchTarget,
  updateQueryEntryObservedQueries,
} from './query-patch-targets'
import {
  isRecordPatchTarget,
  isRowsPatchTarget,
  isScalarListPatchTarget,
  isScalarPatchTarget,
} from './query-patch-targets'
import {
  tryPatchQueryRecord,
} from './query-record-patching'
import {
  tryPatchQueryRows,
  tryPatchWrapperDataRows,
} from './query-rows-patching'
import {
  tryPatchQueryScalar,
  tryPatchQueryScalarList,
} from './query-scalar-patching'
import type {
  PatchQueryResult,
  PatchableQueryPatchTarget,
} from './query-state'
import type { BackfillCache } from './state'

export async function tryPatchObservedQuery(
  target: PatchableQueryPatchTarget,
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache,
): Promise<PatchQueryResult> {
  if (mutations.length === 0) {
    return UNPATCHED_RESULT
  }

  const { aggregatePatchMode, currentValue, query } = target

  if (query.relation) {
    return await tryPatchQueryRelation(query, currentValue, mutations, backfills)
  }

  if (aggregatePatchMode) {
    return await tryPatchQueryAggregate(query, currentValue, mutations, backfills, aggregatePatchMode)
  }

  if (isRowsPatchTarget(target) && query.groupedAggregate) {
    return await tryPatchGroupedAggregateQuery(query, target.currentValue, mutations, backfills)
  }

  if (isRowsPatchTarget(target) && target.rowPatchMode === 'offset-window') {
    return await tryPatchQueryRows(
      query,
      target.currentValue,
      mutations,
      backfills,
      target.rowContext,
      target.rowMutationApplier,
      target.rowPatchMode,
    )
  }

  if (isRowsPatchTarget(target) && target.skipsPatching) {
    return await tryPatchWrapperDataRows(
      query,
      target.currentValue,
      mutations,
      backfills,
      target.rowContext,
      target.rowMutationApplier,
    )
  }

  if (isRowsPatchTarget(target)) {
    return await tryPatchQueryRows(
      query,
      target.currentValue,
      mutations,
      backfills,
      target.rowContext,
      target.rowMutationApplier,
      target.rowPatchMode,
    )
  }

  if (target.rowPatchMode === 'pagination') {
    return await tryPatchQueryPaginationMeta(query, currentValue, mutations, backfills)
  }

  if (isRecordPatchTarget(target)) {
    return tryPatchQueryRecord(
      query,
      target.currentValue,
      mutations,
      backfills,
      target.rowContext,
      target.rowMutationApplier,
    )
  }

  if (isScalarPatchTarget(target)) {
    return tryPatchQueryScalar(query, target.currentValue, mutations)
  }

  if (isScalarListPatchTarget(target)) {
    return await tryPatchQueryScalarList(
      query,
      target.currentValue,
      mutations,
      backfills,
      target.rowContext,
      target.rowMutationApplier,
      tryPatchQueryRows,
    )
  }

  return UNPATCHED_RESULT
}
