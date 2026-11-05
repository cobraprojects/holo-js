import { isRecord, isRecordArray } from './value'

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
  readonly primaryKey?: string
}

export type PredicateMutation = {
  readonly exactId?: unknown | typeof NO_EXACT_ID_PREDICATE
  readonly firstPredicate?: DatabaseQueryPredicateObservation
  readonly predicateCount?: number
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
  readonly primaryKey?: string
  readonly rows?: readonly Readonly<Record<string, unknown>>[]
  readonly values?: Readonly<Record<string, unknown>>
  readonly valueKeys?: readonly string[]
}

export type PredicateQuery = {
  readonly exactId?: unknown | typeof NO_EXACT_ID_PREDICATE
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
  readonly primaryKey?: string
  readonly result?: unknown
  readonly selections?: readonly { readonly column: string, readonly resultKey: string }[]
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

function comparesAsText(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
}

export function equalValues(left: unknown, right: unknown): boolean | undefined {
  if (left === null || right === null) return false
  if (left === right) return true
  const textComparison = (typeof left === 'string' && comparesAsText(right)) || (typeof right === 'string' && comparesAsText(left))
  return textComparison ? undefined : false
}

function includesValue(values: readonly unknown[], value: unknown): boolean | undefined {
  let comparable = true
  for (const candidate of values) {
    const equal = equalValues(candidate, value)
    if (equal) return true
    if (typeof equal === 'undefined') comparable = false
  }
  return comparable ? false : undefined
}

export function matchesPredicateValue(
  value: unknown,
  predicate: DatabaseQueryPredicateObservation,
): boolean | undefined {
  switch (predicate.operator) {
    case '=':
      return equalValues(value, predicate.value)
    case '!=': {
      if (value === null || predicate.value === null) return false
      const equal = equalValues(value, predicate.value)
      return typeof equal === 'undefined' ? undefined : !equal
    }
    case '>':
    case '>=':
    case '<':
    case '<=': {
      if (value === null || predicate.value === null) return false
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
      return Array.isArray(predicate.value) ? value !== null && includesValue(predicate.value, value) : undefined
    case 'not in': {
      if (!Array.isArray(predicate.value)) return undefined
      if (predicate.value.length === 0) return true
      if (value === null || predicate.value.includes(null)) return false
      const included = includesValue(predicate.value, value)
      return typeof included === 'undefined' ? undefined : !included
    }
    case 'between': {
      if (!Array.isArray(predicate.value) || predicate.value.length !== 2) {
        return undefined
      }
      if (value === null) return false

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
      if (value === null) return false

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
    return matchesPredicateValue(value, firstPredicate)
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
  primaryKey: string,
): PredicateMatchContext {
  return {
    exactId,
    firstPredicate: predicates[0],
    predicateCount: predicates.length,
    predicates,
    primaryKey,
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
    primaryKey: readPrimaryKey(mutation),
  }
}

export function readPrimaryKey(source: { readonly primaryKey?: string }): string {
  return source.primaryKey ?? 'id'
}

function readExactIdPredicateValue(
  predicates: readonly DatabaseQueryPredicateObservation[],
  primaryKey: string,
): unknown | typeof NO_EXACT_ID_PREDICATE {
  let exactId: unknown | typeof NO_EXACT_ID_PREDICATE = NO_EXACT_ID_PREDICATE
  for (const predicate of predicates) {
    if (predicate.column !== primaryKey || predicate.operator !== '=') {
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
  if (Object.prototype.hasOwnProperty.call(query, 'exactId')) {
    return query.exactId
  }

  const primaryKey = readPrimaryKey(query)
  const exactId = readExactIdPredicateValue(query.predicates, primaryKey)
  if (typeof exactId !== 'string') {
    return exactId
  }

  if (query.selections?.length && !selectsOnlyKeyColumnAsKey(query.selections, primaryKey)) {
    return NO_EXACT_ID_PREDICATE
  }

  const rows = isRecordArray(query.result) ? query.result : isRecord(query.result) ? [query.result] : []
  return readStoredExactId(rows, primaryKey)
}

function selectsOnlyKeyColumnAsKey(
  selections: readonly { readonly column: string, readonly resultKey: string }[],
  primaryKey: string,
): boolean {
  const keySelections = selections.filter(selection => selection.resultKey === primaryKey)
  return keySelections.length > 0 && keySelections.every(selection => selection.column === primaryKey)
}

function readStoredExactId(
  rows: readonly Readonly<Record<string, unknown>>[],
  primaryKey: string,
): unknown | typeof NO_EXACT_ID_PREDICATE {
  const [row, ...otherRows] = rows
  return row && otherRows.length === 0 && hasRecordKey(row, primaryKey) ? row[primaryKey] : NO_EXACT_ID_PREDICATE
}

export function readMutationExactIdPredicateValue(
  mutation: PredicateMutation,
  primaryKey = readPrimaryKey(mutation),
): unknown | typeof NO_EXACT_ID_PREDICATE {
  if (Object.prototype.hasOwnProperty.call(mutation, 'exactId') && readPrimaryKey(mutation) === primaryKey) {
    return mutation.exactId
  }

  const exactId = readExactIdPredicateValue(mutation.predicates, primaryKey)
  if (typeof exactId !== 'string' || mutation.rows?.length === 0) {
    return exactId
  }

  if (mutation.values && hasRecordKey(mutation.values, primaryKey)) {
    return NO_EXACT_ID_PREDICATE
  }

  return readStoredExactId(mutation.rows ?? [], primaryKey)
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
