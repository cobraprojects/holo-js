import type { PredicateDependencyIndex } from './dependencies'
import {
  matchesPredicateValue,
  type DatabaseQueryPredicateObservation,
} from './predicate-matching'
import type { DatabaseQueryObservation } from './query-state'

const UNREADABLE_DEPENDENCY_VALUE = Symbol('unreadable dependency value')

function createQueryTableKey(query: DatabaseQueryObservation): string {
  return `db:${query.connectionName}:${query.tableName}`
}

function createTableKey(connectionName: string, tableName: string): string {
  return `db:${connectionName}:${tableName}`
}

function decodeDependencyValue(encodedValue: string): unknown | typeof UNREADABLE_DEPENDENCY_VALUE {
  try {
    return JSON.parse(decodeURIComponent(encodedValue)) as unknown
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

export function readExactPredicateValues(
  exactPredicateDependencies: PredicateDependencyIndex,
  connectionName: string,
  tableName: string,
  column: string,
): readonly unknown[] | undefined {
  const encodedValues = exactPredicateDependencies.get(createTableKey(connectionName, tableName))?.get(column)
  if (!encodedValues) {
    return undefined
  }

  const values: unknown[] = []
  for (const encodedValue of encodedValues) {
    const value = decodeDependencyValue(encodedValue)
    if (value === UNREADABLE_DEPENDENCY_VALUE) {
      return undefined
    }

    values.push(value)
  }

  return Object.freeze(values)
}
