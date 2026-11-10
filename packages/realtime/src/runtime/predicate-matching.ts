export type DatabaseQueryPredicateObservation = {
  readonly column: string
  readonly operator: string
  readonly value: unknown
}

export const EMPTY_MUTATION_VALUE_KEYS: readonly string[] = Object.freeze([])

function hasRecordKey(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function isNumberLike(value: unknown): boolean {
  return typeof value === 'number' || typeof value === 'bigint'
}

function isUnsafeInteger(value: unknown): boolean {
  return (typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))) && !Number.isSafeInteger(Number(value))
}

function comparesBooleanWithNumber(left: unknown, right: unknown): boolean {
  return (typeof left === 'boolean' && (typeof right === 'boolean' || isNumberLike(right)))
    || (typeof right === 'boolean' && isNumberLike(left))
}

export function holdsUnsafeIntegerPredicate(predicates: readonly DatabaseQueryPredicateObservation[]): boolean {
  return predicates.some(predicate => Array.isArray(predicate.value) ? predicate.value.some(isUnsafeInteger) : isUnsafeInteger(predicate.value))
}

export function compareValues(left: unknown, right: unknown): number | undefined {
  if (comparesBooleanWithNumber(left, right)) {
    return compareValues(Number(left), Number(right))
  }

  if (isNumberLike(left) && isNumberLike(right) && (isUnsafeInteger(left) || isUnsafeInteger(right))) {
    return undefined
  }

  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1
  }

  if (isNumberLike(left) && isNumberLike(right)) {
    if (Number.isNaN(left) || Number.isNaN(right)) return undefined
    const leftNumber = left as number | bigint
    const rightNumber = right as number | bigint
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0
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
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean'
}

function holdsStructuredValue(value: unknown): boolean {
  return typeof value === 'object' && value !== null
}

function equalValues(left: unknown, right: unknown): boolean | undefined {
  if (left === null || right === null) return false
  if (left === right) return true
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime()
  if (holdsStructuredValue(left) || holdsStructuredValue(right)) return undefined
  if (comparesBooleanWithNumber(left, right)) return Number(left) === Number(right)
  if (isNumberLike(left) && isNumberLike(right)) {
    if (Number.isNaN(left) || Number.isNaN(right)) return false
    const comparison = compareValues(left, right)
    return comparison === undefined ? undefined : comparison === 0
  }
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
