import type { DatabaseMutationEvent } from './dependencies'
import {
  hasRecordKey,
  matchesPredicates,
  readMutationValueKeys,
  valueKeysChangeColumns,
} from './predicate-matching'
import type {
  DatabaseQueryAggregateObservation,
  DatabaseQueryObservation,
} from './query-state'

export type AggregateBackfillEntry = {
  readonly queries: readonly DatabaseQueryObservation[]
}

export function canPatchAggregateQuery(query: DatabaseQueryObservation): boolean {
  return query.patchable && typeof query.limit === 'undefined'
}

export function formatCountAggregateValue(count: number, aggregate: DatabaseQueryAggregateObservation): number | boolean {
  if (aggregate.output === 'boolean') {
    return count > 0
  }

  if (aggregate.output === 'inverseBoolean') {
    return count === 0
  }

  return count
}

export function createCountAggregateObservation(
  aggregate: DatabaseQueryAggregateObservation,
  count: number,
): DatabaseQueryAggregateObservation {
  return Object.freeze({
    count: aggregate.output ? count : undefined,
    kind: 'count',
    output: aggregate.output,
  })
}

export function aggregateMutationCannotChangeValue(
  query: DatabaseQueryObservation,
  aggregate: DatabaseQueryAggregateObservation,
  mutation: DatabaseMutationEvent,
): boolean {
  if (mutation.kind !== 'update' || !mutation.values) {
    return false
  }

  const valueKeys = readMutationValueKeys(mutation)
  const aggregateColumn = aggregate.kind === 'count' ? undefined : aggregate.column
  if (aggregate.kind !== 'count' && !aggregateColumn) {
    return false
  }

  if (aggregateColumn && valueKeysChangeColumns(valueKeys, [aggregateColumn])) {
    return false
  }

  for (const predicate of query.predicates) {
    if (valueKeysChangeColumns(valueKeys, [predicate.column])) {
      return false
    }
  }

  return true
}

function readAggregateContribution(
  query: DatabaseQueryObservation,
  aggregate: DatabaseQueryAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
): number | undefined {
  let contribution = 0
  for (const row of rows) {
    const matches = matchesPredicates(row, query.predicates)
    if (typeof matches === 'undefined') {
      return undefined
    }

    if (!matches) {
      continue
    }

    if (aggregate.kind === 'count') {
      contribution += 1
      continue
    }

    if (!aggregate.column || !hasRecordKey(row, aggregate.column)) {
      return undefined
    }

    const value = row[aggregate.column]
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return undefined
    }

    contribution += value
  }

  return contribution
}

export function readAggregateMutationDelta(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
): number | undefined {
  const aggregate = query.aggregate
  if (!aggregate) {
    return undefined
  }

  if (mutation.kind === 'insert') {
    return mutation.rows
      ? readAggregateContribution(query, aggregate, mutation.rows)
      : undefined
  }

  if (mutation.kind === 'delete') {
    const contribution = mutation.rows
      ? readAggregateContribution(query, aggregate, mutation.rows)
      : undefined
    return typeof contribution === 'undefined' ? undefined : -contribution
  }

  if (mutation.kind === 'upsert') {
    if (!mutation.rows || !mutation.previousRows) {
      return undefined
    }

    const previousContribution = readAggregateContribution(query, aggregate, mutation.previousRows)
    const nextContribution = readAggregateContribution(query, aggregate, mutation.rows)
    return typeof previousContribution === 'undefined' || typeof nextContribution === 'undefined'
      ? undefined
      : nextContribution - previousContribution
  }

  if (mutation.kind !== 'update') {
    return undefined
  }

  if (aggregateMutationCannotChangeValue(query, aggregate, mutation)) {
    return 0
  }

  if (!mutation.rows || !mutation.previousRows || mutation.rows.length !== mutation.previousRows.length) {
    return undefined
  }

  const previousContribution = readAggregateContribution(query, aggregate, mutation.previousRows)
  const nextContribution = readAggregateContribution(query, aggregate, mutation.rows)
  return typeof previousContribution === 'undefined' || typeof nextContribution === 'undefined'
    ? undefined
    : nextContribution - previousContribution
}
