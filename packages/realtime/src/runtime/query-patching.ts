import {
  createMutationIndexKey,
  type DatabaseMutationEvent,
} from './dependencies'
import {
  hasRecordKey,
  holdsUnsafeIntegerPredicate,
  readPrimaryKey,
} from './predicate-matching'
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
  DatabaseQueryObservation,
  PatchQueryResult,
  PatchableQueryPatchTarget,
} from './query-state'
import type { BackfillCache } from './state'
import { readMutationsForQuery } from './query-backfill'

export async function tryPatchObservedQuery(
  target: PatchableQueryPatchTarget,
  observedMutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache,
): Promise<PatchQueryResult> {
  if (observedMutations.length === 0) {
    return UNPATCHED_RESULT
  }

  const { aggregatePatchMode, currentValue, query } = target
  const mutations = readMutationsForQuery(query, observedMutations, backfills)
  if (!mutations) {
    return UNPATCHED_RESULT
  }

  if (readsConvertedColumnsAsDriverValues(query, mutations) || holdsUnsafeIntegerPredicate(query.predicates)) {
    return UNPATCHED_RESULT
  }

  if (query.relation) {
    return await tryPatchQueryRelation(query, currentValue, mutations, backfills)
  }

  if (aggregatePatchMode) {
    return await tryPatchQueryAggregate(query, currentValue, mutations, backfills, aggregatePatchMode)
  }

  if (isRowsPatchTarget(target) && query.groupedAggregate) {
    return await tryPatchGroupedAggregateQuery(query, target.currentValue, mutations, backfills)
  }

  if (insertsRowsWithUnknownPrimaryKey(query, mutations)) {
    return UNPATCHED_RESULT
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

function hasReadColumn(query: DatabaseQueryObservation, columns: readonly string[]): boolean {
  const selections = query.selections ?? []
  return selections.length === 0
    || selections.some(selection => columns.includes(selection.column))
    || [query.scalarColumn, query.scalarListColumn, query.aggregate?.column, query.groupedAggregate?.groupColumn, query.groupedAggregate?.aggregateColumn]
      .some(column => column !== undefined && columns.includes(column))
}

function readsConvertedColumnsAsDriverValues(
  query: DatabaseQueryObservation,
  mutations: readonly DatabaseMutationEvent[],
): boolean {
  return query.table === undefined && mutations.some(mutation => createMutationIndexKey(mutation.connectionName, mutation.tableName) === createMutationIndexKey(query.connectionName, query.tableName)
    && mutation.convertedColumns !== undefined
    && hasReadColumn(query, mutation.convertedColumns))
}

function insertsRowsWithUnknownPrimaryKey(
  query: DatabaseQueryObservation,
  mutations: readonly DatabaseMutationEvent[],
): boolean {
  const primaryKey = readPrimaryKey(query)
  return mutations.some(mutation => (mutation.kind === 'insert' || mutation.kind === 'upsert')
    && mutation.connectionName === query.connectionName
    && createMutationIndexKey(mutation.connectionName, mutation.tableName) === createMutationIndexKey(query.connectionName, query.tableName)
    && (
      mutation.rows?.some(row => !hasRecordKey(row, primaryKey))
      || upsertChangesPrimaryKey(mutation, primaryKey)
    ))
}

function upsertChangesPrimaryKey(mutation: DatabaseMutationEvent, primaryKey: string): boolean {
  if (mutation.kind !== 'upsert') {
    return false
  }

  if (!mutation.previousRows) {
    return true
  }

  if (mutation.previousRows.length === 0) {
    return false
  }

  const previousKeys = new Set(mutation.previousRows.map(row => row[primaryKey]))
  const keys = new Set((mutation.rows ?? []).map(row => row[primaryKey]))
  return previousKeys.size !== keys.size || [...keys].some(key => !previousKeys.has(key))
}
