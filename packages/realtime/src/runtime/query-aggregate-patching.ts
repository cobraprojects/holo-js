import type { DatabaseMutationEvent } from './dependencies'
import {
  UNCHANGED_QUERY_RESULT,
  UNPATCHED_RESULT,
} from './query-patch-results'
import type {
  AggregatePatchMode,
  BackfillCache,
  DatabaseQueryAggregateObservation,
  DatabaseQueryObservation,
  PatchQueryResult,
} from './query-state'
import { tryPatchAverageAggregate } from './query-aggregate-average-patching'
import { backfillAggregate } from './query-aggregate-backfill'
import {
  type AggregateBackfillEntry,
  canPatchAggregateQuery,
  createCountAggregateObservation,
  formatCountAggregateValue,
  readAggregateMutationDelta,
} from './query-aggregate-common'
import { tryPatchExtremeAggregate } from './query-aggregate-extreme-patching'

export function selectAggregatePatchMode(query: DatabaseQueryObservation): AggregatePatchMode | undefined {
  const aggregate = query.aggregate
  if (!aggregate) {
    return undefined
  }

  if (!canPatchAggregateQuery(query)) {
    return 'unpatchable'
  }

  if (aggregate.kind === 'avg') {
    return 'average'
  }

  if (aggregate.kind === 'min' || aggregate.kind === 'max') {
    return 'extreme'
  }

  return 'simple'
}

export function tryPatchQueryAggregate(
  query: DatabaseQueryObservation,
  value: unknown,
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache<AggregateBackfillEntry>,
  mode: AggregatePatchMode,
): Promise<PatchQueryResult> | PatchQueryResult {
  if (mode === 'unpatchable') {
    return UNPATCHED_RESULT
  }

  const aggregate = query.aggregate
  if (!aggregate) {
    return UNPATCHED_RESULT
  }

  if (mode === 'average') {
    return tryPatchAverageAggregate(query, aggregate, value, mutations, backfills)
  }

  if (mode === 'extreme') {
    return tryPatchExtremeAggregate(query, aggregate, value, mutations, backfills)
  }

  if (aggregate.kind === 'count' && aggregate.output) {
    return tryPatchBooleanCountAggregate(query, aggregate, value, mutations, backfills)
  }

  if (typeof value !== 'number') {
    return UNPATCHED_RESULT
  }

  return tryPatchNumericAggregate(query, value, mutations, backfills)
}

function tryPatchNumericAggregate(
  query: DatabaseQueryObservation,
  value: number,
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache<AggregateBackfillEntry>,
): Promise<PatchQueryResult> | PatchQueryResult {
  let nextValue = value
  for (const mutation of mutations) {
    const delta = readAggregateMutationDelta(query, mutation)
    if (typeof delta === 'undefined') {
      return backfillAggregate(query, backfills, value)
    }

    nextValue += delta
  }

  if (nextValue === value) {
    return UNCHANGED_QUERY_RESULT
  }

  return Object.freeze({
    patched: true,
    query,
    value: nextValue,
  })
}

function tryPatchBooleanCountAggregate(
  query: DatabaseQueryObservation,
  aggregate: DatabaseQueryAggregateObservation,
  value: unknown,
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache<AggregateBackfillEntry>,
): Promise<PatchQueryResult> | PatchQueryResult {
  if (typeof aggregate.count !== 'number' || typeof value !== 'boolean') {
    return backfillAggregate(query, backfills, value)
  }

  let count = aggregate.count
  for (const mutation of mutations) {
    const delta = readAggregateMutationDelta(query, mutation)
    if (typeof delta === 'undefined') {
      return backfillAggregate(query, backfills, value)
    }

    count += delta
    if (count < 0) {
      return UNPATCHED_RESULT
    }
  }

  const nextValue = formatCountAggregateValue(count, aggregate)
  const nextAggregate = createCountAggregateObservation(aggregate, count)
  if (nextValue === value) {
    return count === aggregate.count
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
