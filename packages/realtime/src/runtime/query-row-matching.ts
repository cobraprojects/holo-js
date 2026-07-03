import {
  NO_EXACT_ID_PREDICATE,
  hasRecordKey,
} from './predicate-matching'
import { rowIdentity } from './query-row-identity'
import {
  EMPTY_RECORD_ROWS,
} from './query-state'

export function matchesExactRowIdentity(
  row: Readonly<Record<string, unknown>>,
  identity: unknown,
): boolean | undefined {
  return hasRecordKey(row, 'id') ? rowIdentity(row) === identity : undefined
}

export function matchesPatchedExactRowIdentity(
  row: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, unknown>>,
  identity: unknown,
): boolean | undefined {
  if (hasRecordKey(values, 'id')) {
    return values.id === identity
  }

  return matchesExactRowIdentity(row, identity)
}

export function exactIdsDiffer(
  left: unknown | typeof NO_EXACT_ID_PREDICATE,
  right: unknown | typeof NO_EXACT_ID_PREDICATE,
): boolean {
  return left !== NO_EXACT_ID_PREDICATE && right !== NO_EXACT_ID_PREDICATE && left !== right
}

export function rowsContainExactId(
  rows: readonly Readonly<Record<string, unknown>>[],
  exactId: unknown | typeof NO_EXACT_ID_PREDICATE,
): boolean | undefined {
  if (exactId === NO_EXACT_ID_PREDICATE) {
    return undefined
  }

  for (const row of rows) {
    const matches = matchesExactRowIdentity(row, exactId)
    if (typeof matches === 'undefined') {
      return undefined
    }

    if (matches) {
      return true
    }
  }

  return false
}

export function mutationRowsContainExactId(
  rows: readonly Readonly<Record<string, unknown>>[] | undefined,
  exactId: unknown | typeof NO_EXACT_ID_PREDICATE,
): boolean | undefined {
  return rowsContainExactId(rows ?? EMPTY_RECORD_ROWS, exactId)
}
