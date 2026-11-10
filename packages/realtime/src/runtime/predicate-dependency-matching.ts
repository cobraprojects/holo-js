import { queryCacheInternals } from '@holo-js/db'
import type { DatabaseMutationEvent, PredicateDependencyIndex } from './dependencies'
import {
  matchesPredicate,
  matchesPredicates,
  matchesPredicateValue,
  type DatabaseQueryPredicateObservation,
} from './predicate-matching'
import type { DatabaseQueryObservation } from './query-state'

const UNREADABLE_DEPENDENCY_VALUE = Symbol('unreadable dependency value')

function createQueryTableKey(query: DatabaseQueryObservation): string {
  return createTableKey(query.connectionName, query.tableName)
}

function createTableKey(connectionName: string, tableName: string): string {
  return queryCacheInternals.createTableCacheDependency(connectionName, tableName)
}

function holdsUnsafeInteger(value: unknown): boolean {
  if (value && typeof value === 'object') {
    return Object.values(value).some(holdsUnsafeInteger)
  }

  return typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)
}

function decodeDependencyValue(encodedValue: string): unknown | typeof UNREADABLE_DEPENDENCY_VALUE {
  try {
    const value = JSON.parse(decodeURIComponent(encodedValue)) as unknown
    return holdsUnsafeInteger(value) ? UNREADABLE_DEPENDENCY_VALUE : value
  } catch {
    return UNREADABLE_DEPENDENCY_VALUE
  }
}

function exactPredicateValuesCanMatchQueryPredicate(
  encodedValues: Set<string>,
  predicate: DatabaseQueryPredicateObservation,
): boolean {
  for (const encodedValue of encodedValues) {
    const value = decodeDependencyValue(encodedValue)
    if (value === UNREADABLE_DEPENDENCY_VALUE) {
      return true
    }

    if (matchesPredicateValue(value, predicate) !== false) {
      return true
    }
  }

  return false
}

export function isQueryObservationContradictedByExactPredicates(
  query: DatabaseQueryObservation,
  exactPredicateDependencies: PredicateDependencyIndex,
): boolean | undefined {
  const exactPredicates = exactPredicateDependencies.get(createQueryTableKey(query))
  if (!exactPredicates) {
    return undefined
  }

  if (query.predicates.length === 0) {
    return false
  }

  for (const predicate of query.predicates) {
    const exactValues = exactPredicates.get(predicate.column)
    if (!exactValues) {
      continue
    }

    if (!exactPredicateValuesCanMatchQueryPredicate(exactValues, predicate)) {
      return true
    }
  }

  return false
}

export function isQueryContradictedByMutationRows(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
): boolean {
  if (query.predicates.length === 0 && !query.predicateTree?.length) {
    return false
  }

  switch (mutation.kind) {
    case 'insert':
    case 'delete':
      return rowsCannotMatchQuery(query, mutation.rows)
    case 'update':
    case 'upsert':
      return rowsCannotMatchQuery(query, mutation.previousRows) && rowsCannotMatchQuery(query, mutation.rows)
  }
}

function rowsCannotMatchQuery(
  query: DatabaseQueryObservation,
  rows: readonly Readonly<Record<string, unknown>>[] | undefined,
): boolean {
  if (!rows || rows.length === 0) {
    return false
  }

  return rows.every(row => rowMatchesQuery(query, row) === false)
}

function rowMatchesQuery(
  query: DatabaseQueryObservation,
  row: Readonly<Record<string, unknown>>,
): boolean | undefined {
  return query.predicateTree
    ? matchesPredicateTree(row, query.predicateTree)
    : matchesPredicates(row, query.predicates)
}

function matchesPredicateTree(
  row: Readonly<Record<string, unknown>>,
  predicates: NonNullable<DatabaseQueryObservation['predicateTree']>,
): boolean | undefined {
  let branch: boolean | undefined = true
  let result: boolean | undefined = false
  for (let index = 0; index < predicates.length; index += 1) {
    const predicate = predicates[index]!
    if (index > 0 && predicate.boolean === 'or') {
      if (branch === true) return true
      if (branch === undefined) result = undefined
      branch = true
    }

    const matches = predicate.kind === 'comparison' && !predicate.valueType
      ? matchesPredicate(row, { ...predicate, column: predicate.column.split('.').at(-1)! })
      : predicate.kind === 'group' && !predicate.negated
        ? matchesPredicateTree(row, predicate.predicates)
        : undefined
    if (matches === false) branch = false
    else if (matches === undefined && branch !== false) branch = undefined
  }

  if (branch === true) return true
  return branch === undefined ? undefined : result
}
