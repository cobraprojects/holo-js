import type { DatabaseMutationEvent } from './dependencies'
import { hasRecordKey, matchesPredicates } from './predicate-matching'
import {
  UNCHANGED_QUERY_RESULT,
  UNPATCHED_RESULT,
} from './query-patch-results'
import type {
  AggregateRowsState,
  BackfillCache,
  DatabaseQueryAggregateObservation,
  DatabaseQueryAggregateValueCountObservation,
  DatabaseQueryObservation,
  PatchQueryResult,
} from './query-state'
import { backfillAggregate } from './query-aggregate-backfill'
import {
  aggregateMutationCannotChangeValue,
  type AggregateBackfillEntry,
} from './query-aggregate-common'

function createAggregateRowsState(): AggregateRowsState {
  return {
    candidate: undefined,
    candidateCount: 0,
    count: 0,
    currentValueCount: 0,
    sum: 0,
    valueCounts: new Map(),
  }
}

function resetAggregateRowsState(state: AggregateRowsState): void {
  state.candidate = undefined
  state.candidateCount = 0
  state.count = 0
  state.currentValueCount = 0
  state.sum = 0
  state.valueCounts.clear()
}

function recordAggregateCandidate(
  aggregate: DatabaseQueryAggregateObservation,
  state: AggregateRowsState,
  value: number,
): void {
  const candidate = state.candidate
  if (typeof candidate !== 'number') {
    state.candidate = value
    state.candidateCount = 1
    return
  }

  const candidateChanged = aggregate.kind === 'min'
    ? value < candidate
    : value > candidate
  if (candidateChanged) {
    state.candidate = value
    state.candidateCount = 1
    return
  }

  if (value === candidate) {
    state.candidateCount += 1
  }
}

function applyAggregateRowsState(
  query: DatabaseQueryObservation,
  aggregate: DatabaseQueryAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  state: AggregateRowsState,
  currentValue: number | null,
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

    recordAggregateCandidate(aggregate, state, value)
    state.count += 1
    state.valueCounts.set(value, (state.valueCounts.get(value) ?? 0) + 1)
    if (value === currentValue) {
      state.currentValueCount += 1
    }

    state.sum += value
  }

  return true
}

function aggregateRowsStateChanged(
  previous: AggregateRowsState,
  next: AggregateRowsState,
): boolean {
  return (
    previous.count !== next.count
    || previous.sum !== next.sum
    || previous.candidate !== next.candidate
    || previous.candidateCount !== next.candidateCount
    || previous.currentValueCount !== next.currentValueCount
    || !aggregateValueCountsEqual(previous.valueCounts, next.valueCounts)
  )
}

function aggregateValueCountsEqual(
  previous: ReadonlyMap<number, number>,
  next: ReadonlyMap<number, number>,
): boolean {
  if (previous.size !== next.size) {
    return false
  }

  for (const [value, count] of previous) {
    if (next.get(value) !== count) {
      return false
    }
  }

  return true
}

function aggregateCandidatePreservesExtreme(
  aggregate: DatabaseQueryAggregateObservation,
  currentValue: number,
  candidate: number,
): boolean {
  return aggregate.kind === 'min'
    ? candidate <= currentValue
    : candidate >= currentValue
}

function mergeAggregateExtremeValue(
  aggregate: DatabaseQueryAggregateObservation,
  currentValue: number | null,
  candidate: number,
): number {
  return typeof currentValue === 'number'
    ? aggregate.kind === 'min' ? Math.min(currentValue, candidate) : Math.max(currentValue, candidate)
    : candidate
}

function candidateBecomesExtreme(
  aggregate: DatabaseQueryAggregateObservation,
  previousValue: number | null,
  nextValue: number,
  candidate: number,
): boolean {
  return candidate === nextValue
    && (typeof previousValue !== 'number' || aggregateCandidatePreservesExtreme(aggregate, previousValue, candidate))
}

function updateCurrentValueCountFromNextCandidate(
  aggregate: DatabaseQueryAggregateObservation,
  previousValue: number | null,
  nextValue: number,
  currentValueCount: number | undefined,
  next: AggregateRowsState,
): number | undefined {
  const candidate = next.candidate!
  if (!candidateBecomesExtreme(aggregate, previousValue, nextValue, candidate)) {
    return currentValueCount
  }

  return nextValue === previousValue && typeof currentValueCount === 'number'
    ? currentValueCount + next.candidateCount
    : next.candidateCount
}

function readAggregateValueCounts(
  valueCounts: readonly DatabaseQueryAggregateValueCountObservation[] | undefined,
): Map<number, number> | undefined {
  if (!valueCounts) {
    return undefined
  }

  const counts = new Map<number, number>()
  for (const valueCount of valueCounts) {
    if (
      typeof valueCount.value !== 'number'
      || Number.isNaN(valueCount.value)
      || typeof valueCount.count !== 'number'
      || !Number.isInteger(valueCount.count)
      || valueCount.count <= 0
    ) {
      return undefined
    }

    counts.set(valueCount.value, (counts.get(valueCount.value) ?? 0) + valueCount.count)
  }

  return counts
}

function createAggregateValueCounts(
  valueCounts: ReadonlyMap<number, number>,
): readonly DatabaseQueryAggregateValueCountObservation[] {
  return Object.freeze([...valueCounts.entries()]
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left - right)
    .map(([value, count]) => Object.freeze({ count, value })))
}

function trimAggregateValueCounts(
  aggregate: DatabaseQueryAggregateObservation,
  valueCounts: ReadonlyMap<number, number>,
): Map<number, number> {
  const counts = [...valueCounts.entries()]
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => aggregate.kind === 'min' ? left - right : right - left)
    .slice(0, 2)

  return new Map(counts)
}

function applyAggregateValueCountDeltas(
  valueCounts: ReadonlyMap<number, number>,
  previous: AggregateRowsState,
  next: AggregateRowsState,
): Map<number, number> {
  const counts = new Map(valueCounts)
  for (const [value, count] of previous.valueCounts) {
    const nextCount = (counts.get(value) ?? 0) - count
    if (nextCount > 0) {
      counts.set(value, nextCount)
    } else {
      counts.delete(value)
    }
  }

  for (const [value, count] of next.valueCounts) {
    counts.set(value, (counts.get(value) ?? 0) + count)
  }

  return counts
}

function readAggregateExtremeValue(
  aggregate: DatabaseQueryAggregateObservation,
  valueCounts: ReadonlyMap<number, number>,
): number | null {
  let extreme: number | undefined
  for (const value of valueCounts.keys()) {
    extreme = typeof extreme === 'number'
      ? aggregate.kind === 'min' ? Math.min(extreme, value) : Math.max(extreme, value)
      : value
  }

  return typeof extreme === 'number' ? extreme : null
}

function readAggregateExtremeValueCount(
  valueCounts: ReadonlyMap<number, number>,
  value: number | null,
): number {
  return typeof value === 'number'
    ? valueCounts.get(value)!
    : 0
}

function aggregateValueCountsCanResolveValue(
  valueCounts: ReadonlyMap<number, number>,
  value: unknown,
  complete: boolean,
  previousValue: unknown,
): boolean {
  return complete
    || (value === null && previousValue === null)
    || (typeof value === 'number' && valueCounts.has(value))
}

function applyAggregateMutationRowsState(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  previous: AggregateRowsState,
  next: AggregateRowsState,
  currentValue: number | null,
): true | undefined {
  const aggregate = query.aggregate
  if (!aggregate || (aggregate.kind !== 'min' && aggregate.kind !== 'max')) {
    return undefined
  }

  if (mutation.kind === 'insert') {
    return mutation.rows ? applyAggregateRowsState(query, aggregate, mutation.rows, next, currentValue) : undefined
  }

  if (mutation.kind === 'delete') {
    return mutation.rows ? applyAggregateRowsState(query, aggregate, mutation.rows, previous, currentValue) : undefined
  }

  if (mutation.kind === 'upsert') {
    if (!mutation.rows || !mutation.previousRows) {
      return undefined
    }

    const previousApplied = applyAggregateRowsState(query, aggregate, mutation.previousRows, previous, currentValue)
    return previousApplied
      ? applyAggregateRowsState(query, aggregate, mutation.rows, next, currentValue)
      : undefined
  }

  if (mutation.kind !== 'update') {
    return undefined
  }

  if (aggregateMutationCannotChangeValue(query, aggregate, mutation)) {
    return true
  }

  if (!mutation.rows || !mutation.previousRows || mutation.rows.length !== mutation.previousRows.length) {
    return undefined
  }

  const previousApplied = applyAggregateRowsState(query, aggregate, mutation.previousRows, previous, currentValue)
  return previousApplied
    ? applyAggregateRowsState(query, aggregate, mutation.rows, next, currentValue)
    : undefined
}

export function tryPatchExtremeAggregate(
  query: DatabaseQueryObservation,
  aggregate: DatabaseQueryAggregateObservation,
  value: unknown,
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache<AggregateBackfillEntry>,
): Promise<PatchQueryResult> | PatchQueryResult {
  if (value !== null && typeof value !== 'number') {
    return UNPATCHED_RESULT
  }

  let nextValue = value
  let currentValueCount = aggregate.currentValueCount
  const initialCurrentValueCount = currentValueCount
  let valueCounts = readAggregateValueCounts(aggregate.valueCounts)
  const valueCountsComplete = aggregate.valueCountsComplete !== false
  if (
    valueCounts
    && !aggregateValueCountsCanResolveValue(valueCounts, value, valueCountsComplete, value)
  ) {
    return backfillAggregate(query, backfills, value)
  }

  const initialValueCounts = valueCounts
  let changed = false
  const previous = createAggregateRowsState()
  const next = createAggregateRowsState()
  for (const mutation of mutations) {
    resetAggregateRowsState(previous)
    resetAggregateRowsState(next)
    const applied = applyAggregateMutationRowsState(query, mutation, previous, next, nextValue)
    if (!applied) {
      return backfillAggregate(query, backfills, value)
    }

    if (!aggregateRowsStateChanged(previous, next)) {
      continue
    }

    changed = true
    if (valueCounts) {
      valueCounts = applyAggregateValueCountDeltas(valueCounts, previous, next)
      if (!valueCountsComplete) {
        valueCounts = trimAggregateValueCounts(aggregate, valueCounts)
      }
      nextValue = readAggregateExtremeValue(aggregate, valueCounts)
      if (!aggregateValueCountsCanResolveValue(valueCounts, nextValue, valueCountsComplete, value)) {
        return backfillAggregate(query, backfills, value)
      }
      currentValueCount = readAggregateExtremeValueCount(valueCounts, nextValue)
      continue
    }

    if (typeof nextValue === 'number' && previous.currentValueCount > 0) {
      if (typeof currentValueCount === 'number') {
        const remainingCurrentValueCount = currentValueCount - previous.currentValueCount + next.currentValueCount
        if (remainingCurrentValueCount > 0) {
          currentValueCount = remainingCurrentValueCount
          continue
        }
      }

      if (typeof next.candidate !== 'number') {
        return backfillAggregate(query, backfills, value)
      }

      if (!aggregateCandidatePreservesExtreme(aggregate, nextValue, next.candidate)) {
        return backfillAggregate(query, backfills, value)
      }

      nextValue = mergeAggregateExtremeValue(aggregate, nextValue, next.candidate)
      currentValueCount = next.candidateCount
      continue
    }

    if (typeof next.candidate !== 'number') {
      continue
    }

    const previousValue = nextValue
    nextValue = mergeAggregateExtremeValue(aggregate, nextValue, next.candidate)
    currentValueCount = updateCurrentValueCountFromNextCandidate(
      aggregate,
      previousValue,
      nextValue,
      currentValueCount,
      next,
    )
  }

  if (!changed) {
    return UNCHANGED_QUERY_RESULT
  }

  if (nextValue === value) {
    if (
      currentValueCount === initialCurrentValueCount
      && valueCounts === initialValueCounts
    ) {
      return UNCHANGED_QUERY_RESULT
    }

    const unchangedAggregate = Object.freeze({
      ...aggregate,
      currentValueCount: currentValueCount as number,
      ...(valueCounts ? { valueCounts: createAggregateValueCounts(valueCounts) } : {}),
      ...(!valueCountsComplete ? { valueCountsComplete } : {}),
    })
    return Object.freeze({
      nextQuery: Object.freeze({
        ...query,
        aggregate: unchangedAggregate,
      }),
      patched: true,
      unchanged: true,
    })
  }

  const patchedAggregate = Object.freeze({
    ...aggregate,
    currentValueCount: currentValueCount as number,
    ...(valueCounts ? { valueCounts: createAggregateValueCounts(valueCounts) } : {}),
    ...(!valueCountsComplete ? { valueCountsComplete } : {}),
  })
  return Object.freeze({
    nextQuery: Object.freeze({
      ...query,
      aggregate: patchedAggregate,
    }),
    patched: true,
    query,
    value: nextValue,
  })
}
