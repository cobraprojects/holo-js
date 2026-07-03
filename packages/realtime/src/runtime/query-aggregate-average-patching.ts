import type { DatabaseMutationEvent } from './dependencies'
import { hasRecordKey, matchesPredicates } from './predicate-matching'
import {
  UNCHANGED_QUERY_RESULT,
  UNPATCHED_RESULT,
} from './query-patch-results'
import type {
  AggregateCountState,
  BackfillCache,
  DatabaseQueryAggregateObservation,
  DatabaseQueryObservation,
  PatchQueryResult,
} from './query-state'
import { backfillAggregate } from './query-aggregate-backfill'
import {
  aggregateMutationCannotChangeValue,
  type AggregateBackfillEntry,
} from './query-aggregate-common'

function applyAggregateCountRows(
  query: DatabaseQueryObservation,
  aggregate: DatabaseQueryAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  direction: 1 | -1,
  state: AggregateCountState,
): true | undefined {
  for (const row of rows) {
    const matches = matchesPredicates(row, query.predicates)
    if (typeof matches === 'undefined') {
      return undefined
    }

    if (!matches) {
      continue
    }

    if (!aggregate.column || !hasRecordKey(row, aggregate.column)) {
      return undefined
    }

    const value = row[aggregate.column]
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return undefined
    }

    state.count += direction
    state.sum += direction * value
  }

  return true
}

function applyAggregateMutationCount(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  state: AggregateCountState,
): true | undefined {
  const aggregate = query.aggregate
  if (!aggregate || aggregate.kind !== 'avg') {
    return undefined
  }

  if (mutation.kind === 'insert') {
    return mutation.rows ? applyAggregateCountRows(query, aggregate, mutation.rows, 1, state) : undefined
  }

  if (mutation.kind === 'delete') {
    return mutation.rows ? applyAggregateCountRows(query, aggregate, mutation.rows, -1, state) : undefined
  }

  if (mutation.kind === 'upsert') {
    if (!mutation.rows || !mutation.previousRows) {
      return undefined
    }

    const previousApplied = applyAggregateCountRows(query, aggregate, mutation.previousRows, -1, state)
    return previousApplied
      ? applyAggregateCountRows(query, aggregate, mutation.rows, 1, state)
      : undefined
  }

  if (aggregateMutationCannotChangeValue(query, aggregate, mutation)) {
    return true
  }

  if (!mutation.rows || !mutation.previousRows || mutation.rows.length !== mutation.previousRows.length) {
    return undefined
  }

  const previousApplied = applyAggregateCountRows(query, aggregate, mutation.previousRows, -1, state)
  return previousApplied
    ? applyAggregateCountRows(query, aggregate, mutation.rows, 1, state)
    : undefined
}

function averageRowsCanAffectQuery(
  query: DatabaseQueryObservation,
  aggregate: DatabaseQueryAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[] | undefined,
): boolean | undefined {
  if (!rows) {
    return undefined
  }

  for (const row of rows) {
    const matches = matchesPredicates(row, query.predicates)
    if (typeof matches === 'undefined') {
      return undefined
    }

    if (!matches) {
      continue
    }

    if (!aggregate.column || !hasRecordKey(row, aggregate.column)) {
      return undefined
    }

    const value = row[aggregate.column]
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return undefined
    }

    return true
  }

  return false
}

function averageMutationCanAffectQuery(
  query: DatabaseQueryObservation,
  aggregate: DatabaseQueryAggregateObservation,
  mutation: DatabaseMutationEvent,
): boolean | undefined {
  if (aggregateMutationCannotChangeValue(query, aggregate, mutation)) {
    return false
  }

  if (mutation.kind === 'insert' || mutation.kind === 'delete') {
    return averageRowsCanAffectQuery(query, aggregate, mutation.rows)
  }

  if (mutation.kind === 'upsert') {
    if (!mutation.previousRows) {
      return undefined
    }

    const previousMatches = averageRowsCanAffectQuery(query, aggregate, mutation.previousRows)
    if (previousMatches) {
      return true
    }

    const nextMatches = averageRowsCanAffectQuery(query, aggregate, mutation.rows)
    if (nextMatches) {
      return true
    }

    return typeof previousMatches === 'undefined' || typeof nextMatches === 'undefined'
      ? undefined
      : false
  }

  const previousMatches = averageRowsCanAffectQuery(query, aggregate, mutation.previousRows)
  if (previousMatches) {
    return true
  }

  const nextMatches = averageRowsCanAffectQuery(query, aggregate, mutation.rows)
  if (nextMatches) {
    return true
  }

  return typeof previousMatches === 'undefined' || typeof nextMatches === 'undefined'
    ? undefined
    : false
}

function averageMutationsCanAffectQuery(
  query: DatabaseQueryObservation,
  aggregate: DatabaseQueryAggregateObservation,
  mutations: readonly DatabaseMutationEvent[],
): boolean | undefined {
  for (const mutation of mutations) {
    const canAffect = averageMutationCanAffectQuery(query, aggregate, mutation)
    if (typeof canAffect === 'undefined') {
      return undefined
    }

    if (canAffect) {
      return true
    }
  }

  return false
}

export function tryPatchAverageAggregate(
  query: DatabaseQueryObservation,
  aggregate: DatabaseQueryAggregateObservation,
  value: unknown,
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache<AggregateBackfillEntry>,
): Promise<PatchQueryResult> | PatchQueryResult {
  if (typeof aggregate.count !== 'number' || typeof aggregate.sum !== 'number') {
    const canAffect = averageMutationsCanAffectQuery(query, aggregate, mutations)
    return canAffect === false ? UNCHANGED_QUERY_RESULT : backfillAggregate(query, backfills, value)
  }

  if (value !== null && typeof value !== 'number') {
    return UNPATCHED_RESULT
  }

  const state: AggregateCountState = {
    count: aggregate.count,
    sum: aggregate.sum,
  }
  for (const mutation of mutations) {
    if (!applyAggregateMutationCount(query, mutation, state)) {
      return backfillAggregate(query, backfills, value)
    }

    if (state.count < 0) {
      return UNPATCHED_RESULT
    }
  }

  const nextValue = state.count === 0 ? null : state.sum / state.count
  const nextAggregate = Object.freeze({
    ...aggregate,
    count: state.count,
    sum: state.sum,
  })
  if (nextValue === value) {
    return state.count === aggregate.count && state.sum === aggregate.sum
      ? UNCHANGED_QUERY_RESULT
      : Object.freeze({
          nextQuery: Object.freeze({
            ...query,
            aggregate: nextAggregate,
          }),
          patched: true,
          unchanged: true,
        })
  }

  return Object.freeze({
    nextQuery: Object.freeze({
      ...query,
      aggregate: nextAggregate,
    }),
    patched: true,
    query,
    value: nextValue,
  })
}
