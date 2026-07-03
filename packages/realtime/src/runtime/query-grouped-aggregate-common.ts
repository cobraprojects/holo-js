import {
  compareValues,
  hasRecordKey,
  matchesPredicates,
} from './predicate-matching'
import type {
  DatabaseQueryGroupedAggregateObservation,
  DatabaseQueryObservation,
} from './query-state'

export type GroupedAggregateGroupValueRead =
  | {
    readonly matched: false
  }
  | {
    readonly matched: true
    readonly value: unknown
  }
  | {
    readonly matched: 'unknown'
  }

export function readMatchingGroupedAggregateValue(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  row: Readonly<Record<string, unknown>>,
): GroupedAggregateGroupValueRead {
  const matches = matchesPredicates(row, query.predicates)
  if (typeof matches === 'undefined' || (matches && !hasRecordKey(row, groupedAggregate.groupColumn))) {
    return Object.freeze({ matched: 'unknown' })
  }

  return matches
    ? Object.freeze({ matched: true, value: row[groupedAggregate.groupColumn] })
    : Object.freeze({ matched: false })
}

export function readGroupedAggregateNumericContribution(
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  row: Readonly<Record<string, unknown>>,
): number | undefined {
  const column = groupedAggregate.aggregateColumn
  if (!column || !hasRecordKey(row, column)) {
    return undefined
  }

  const value = row[column]
  return typeof value === 'number' && !Number.isNaN(value) ? value : undefined
}

export function readGroupedAggregateCurrentValue(
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  groupValue: unknown,
): unknown {
  const row = rows.find(candidate => Object.is(candidate[groupedAggregate.groupResultKey], groupValue))
  return row?.[groupedAggregate.aggregateResultKey]
}

export function groupedExtremeValueReplaces(
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  currentValue: number,
  nextValue: number,
): boolean {
  return groupedAggregate.kind === 'min'
    ? nextValue < currentValue
    : nextValue > currentValue
}

export function matchesGroupedCountHaving(
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  count: number,
): boolean {
  const having = groupedAggregate.having
  if (!having) {
    return true
  }

  switch (having.operator) {
    case '<':
      return count < having.value
    case '<=':
      return count <= having.value
    case '=':
      return count === having.value
    case '>':
      return count > having.value
    case '>=':
      return count >= having.value
  }
}

export function sortGroupedAggregateRows(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (query.orderBy.length === 0) {
    return rows
  }

  if (
    query.orderBy.length !== 1
    || query.orderBy[0]?.column !== groupedAggregate.groupColumn
  ) {
    return undefined
  }

  const multiplier = query.orderBy[0].direction === 'desc' ? -1 : 1
  const sortedRows = [...rows]
  let comparable = true
  sortedRows.sort((left, right) => {
    const comparison = compareValues(left[groupedAggregate.groupResultKey], right[groupedAggregate.groupResultKey])
    if (typeof comparison !== 'number') {
      comparable = false
      return 0
    }

    return comparison * multiplier
  })

  if (!comparable) {
    return undefined
  }

  return sortedRows.every((row, index) => row === rows[index])
    ? rows
    : sortedRows
}
