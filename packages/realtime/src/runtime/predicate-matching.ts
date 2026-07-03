export type DatabaseQueryPredicateObservation = {
  readonly column: string
  readonly operator: string
  readonly value: unknown
}

export type PredicateMatchContext = {
  readonly exactId: unknown | typeof NO_EXACT_ID_PREDICATE
  readonly firstPredicate?: DatabaseQueryPredicateObservation
  readonly predicateCount: number
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
}

export type PredicateMutation = {
  readonly exactId?: unknown | typeof NO_EXACT_ID_PREDICATE
  readonly firstPredicate?: DatabaseQueryPredicateObservation
  readonly predicateCount?: number
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
  readonly values?: Readonly<Record<string, unknown>>
  readonly valueKeys?: readonly string[]
}

export type PredicateQuery = {
  readonly exactId?: unknown | typeof NO_EXACT_ID_PREDICATE
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
}

export const NO_EXACT_ID_PREDICATE = Symbol('no exact id predicate')
export const EMPTY_MUTATION_VALUE_KEYS: readonly string[] = Object.freeze([])

export function hasRecordKey(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

export function rowValuesChanged(
  row: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  for (const key of keys) {
    if (!hasRecordKey(row, key) || row[key] !== values[key]) {
      return true
    }
  }

  return false
}

export function compareValues(left: unknown, right: unknown): number | undefined {
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1
  }

  if (typeof left === 'string' && typeof right === 'string') {
    const comparison = left.localeCompare(right)
    return comparison === 0 ? 0 : comparison < 0 ? -1 : 1
  }

  if (left instanceof Date && right instanceof Date) {
    const leftTime = left.getTime()
    const rightTime = right.getTime()
    return leftTime === rightTime ? 0 : leftTime < rightTime ? -1 : 1
  }

  if (left === right) {
    return 0
  }

  return undefined
}

function includesValue(values: readonly unknown[], value: unknown): boolean {
  return values.some(candidate => candidate === value)
}

export function matchesPredicateValue(
  value: unknown,
  predicate: DatabaseQueryPredicateObservation,
): boolean | undefined {
  switch (predicate.operator) {
    case '=':
      return value === predicate.value
    case '!=':
      return value !== predicate.value
    case '>':
    case '>=':
    case '<':
    case '<=': {
      const comparison = compareValues(value, predicate.value)
      if (typeof comparison === 'undefined') {
        return undefined
      }

      if (predicate.operator === '>') {
        return comparison > 0
      }
      if (predicate.operator === '>=') {
        return comparison >= 0
      }
      if (predicate.operator === '<') {
        return comparison < 0
      }
      return comparison <= 0
    }
    case 'in':
      return Array.isArray(predicate.value) ? includesValue(predicate.value, value) : undefined
    case 'not in':
      return Array.isArray(predicate.value) ? !includesValue(predicate.value, value) : undefined
    case 'between': {
      if (!Array.isArray(predicate.value) || predicate.value.length !== 2) {
        return undefined
      }

      const lowerComparison = compareValues(value, predicate.value[0])
      const upperComparison = compareValues(value, predicate.value[1])
      return typeof lowerComparison === 'undefined' || typeof upperComparison === 'undefined'
        ? undefined
        : lowerComparison >= 0 && upperComparison <= 0
    }
    case 'not between': {
      if (!Array.isArray(predicate.value) || predicate.value.length !== 2) {
        return undefined
      }

      const lowerComparison = compareValues(value, predicate.value[0])
      const upperComparison = compareValues(value, predicate.value[1])
      return typeof lowerComparison === 'undefined' || typeof upperComparison === 'undefined'
        ? undefined
        : lowerComparison < 0 || upperComparison > 0
    }
    default:
      return undefined
  }
}

export function matchesPredicate(
  row: Readonly<Record<string, unknown>>,
  predicate: DatabaseQueryPredicateObservation,
): boolean | undefined {
  if (!hasRecordKey(row, predicate.column)) {
    return undefined
  }

  const value = row[predicate.column]
  return matchesPredicateValue(value, predicate)
}

export function matchesPatchedPredicate(
  row: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, unknown>>,
  predicate: DatabaseQueryPredicateObservation,
): boolean | undefined {
  let value: unknown
  if (hasRecordKey(values, predicate.column)) {
    value = values[predicate.column]
  } else if (hasRecordKey(row, predicate.column)) {
    value = row[predicate.column]
  } else {
    return undefined
  }

  return matchesPredicateValue(value, predicate)
}

export function matchesPredicates(
  row: Readonly<Record<string, unknown>>,
  predicates: readonly DatabaseQueryPredicateObservation[],
): boolean | undefined {
  const firstPredicate = predicates[0]
  if (!firstPredicate) {
    return true
  }

  if (predicates.length === 1) {
    if (!hasRecordKey(row, firstPredicate.column)) {
      return undefined
    }

    const value = row[firstPredicate.column]
    if (firstPredicate.operator === '=') {
      return value === firstPredicate.value
    }

    if (firstPredicate.operator === '!=') {
      return value !== firstPredicate.value
    }

    return matchesPredicate(row, firstPredicate)
  }

  for (const predicate of predicates) {
    const matches = matchesPredicate(row, predicate)
    if (typeof matches === 'undefined') {
      return undefined
    }

    if (!matches) {
      return false
    }
  }

  return true
}

export function createPredicateMatchContext(
  predicates: readonly DatabaseQueryPredicateObservation[],
  exactId: unknown | typeof NO_EXACT_ID_PREDICATE,
): PredicateMatchContext {
  return {
    exactId,
    firstPredicate: predicates[0],
    predicateCount: predicates.length,
    predicates,
  }
}

export function createMutationPredicateMatchContext(
  mutation: PredicateMutation,
  exactId: unknown | typeof NO_EXACT_ID_PREDICATE,
): PredicateMatchContext {
  return {
    exactId,
    firstPredicate: readMutationFirstPredicate(mutation),
    predicateCount: readMutationPredicateCount(mutation),
    predicates: mutation.predicates,
  }
}

function readExactIdPredicateValue(
  predicates: readonly DatabaseQueryPredicateObservation[],
): unknown | typeof NO_EXACT_ID_PREDICATE {
  let exactId: unknown | typeof NO_EXACT_ID_PREDICATE = NO_EXACT_ID_PREDICATE
  for (const predicate of predicates) {
    if (predicate.column !== 'id' || predicate.operator !== '=') {
      continue
    }

    if (exactId !== NO_EXACT_ID_PREDICATE && exactId !== predicate.value) {
      return NO_EXACT_ID_PREDICATE
    }

    exactId = predicate.value
  }

  return exactId
}

export function readQueryExactIdPredicateValue(query: PredicateQuery): unknown | typeof NO_EXACT_ID_PREDICATE {
  return Object.prototype.hasOwnProperty.call(query, 'exactId') ? query.exactId : readExactIdPredicateValue(query.predicates)
}

export function readMutationExactIdPredicateValue(mutation: PredicateMutation): unknown | typeof NO_EXACT_ID_PREDICATE {
  return Object.prototype.hasOwnProperty.call(mutation, 'exactId')
    ? mutation.exactId
    : readExactIdPredicateValue(mutation.predicates)
}

export function readMutationValueKeys(mutation: PredicateMutation): readonly string[] {
  if (mutation.valueKeys) {
    return mutation.valueKeys
  }

  return mutation.values ? Object.freeze(Object.keys(mutation.values)) : EMPTY_MUTATION_VALUE_KEYS
}

export function mutationChangesColumns(mutation: PredicateMutation, columns: readonly string[]): boolean {
  if (!mutation.values) {
    return false
  }

  return valueKeysChangeColumns(readMutationValueKeys(mutation), columns)
}

export function valueKeysChangeColumns(valueKeys: readonly string[], columns: readonly string[]): boolean {
  const firstColumn = columns[0]
  const firstValueKey = valueKeys[0]
  if (typeof firstColumn === 'undefined' || typeof firstValueKey === 'undefined') {
    return false
  }

  if (columns.length === 1) {
    for (const valueKey of valueKeys) {
      if (firstColumn === valueKey) {
        return true
      }
    }

    return false
  }

  if (valueKeys.length === 1) {
    for (const column of columns) {
      if (column === firstValueKey) {
        return true
      }
    }

    return false
  }

  for (const column of columns) {
    for (const valueKey of valueKeys) {
      if (column === valueKey) {
        return true
      }
    }
  }

  return false
}

export function readMutationPredicateCount(mutation: PredicateMutation): number {
  return typeof mutation.predicateCount === 'number' ? mutation.predicateCount : mutation.predicates.length
}

export function readMutationFirstPredicate(mutation: PredicateMutation): DatabaseQueryPredicateObservation | undefined {
  return mutation.firstPredicate ?? mutation.predicates[0]
}
