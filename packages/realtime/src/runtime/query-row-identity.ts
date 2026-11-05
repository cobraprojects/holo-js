import {
  DUPLICATE_ROW_IDENTITY,
  ROW_IDENTITY_INDEXES_BY_ROWS,
  type DatabaseQueryObservation,
} from './query-state'
import { readPrimaryKey } from './predicate-matching'
import { isRecordArray } from './value'

export function rowIdentity(row: Readonly<Record<string, unknown>>, primaryKey: string): unknown {
  return row[primaryKey]
}

export function createQueryRowIdentityIndex(
  value: unknown,
  primaryKey: string,
): ReadonlyMap<unknown, number> | undefined {
  return isRecordArray(value) ? readRowsIdentityIndex(value, primaryKey) : undefined
}

export function readQueryRowIdentityIndex(
  query: DatabaseQueryObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
): ReadonlyMap<unknown, number> | undefined {
  const primaryKey = readPrimaryKey(query)
  return query.result === rows
    ? query.rowIdentityIndex ?? readRowsIdentityIndex(rows, primaryKey)
    : readRowsIdentityIndex(rows, primaryKey)
}

export function findUniqueRowIndexByIdentityValue(
  rows: readonly Readonly<Record<string, unknown>>[],
  identity: unknown,
  primaryKey: string,
): number | undefined | typeof DUPLICATE_ROW_IDENTITY {
  let rowIndex: number | undefined
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!row || rowIdentity(row, primaryKey) !== identity) {
      continue
    }

    if (typeof rowIndex !== 'undefined') {
      return DUPLICATE_ROW_IDENTITY
    }

    rowIndex = index
  }

  return rowIndex
}

function readRowsIdentityIndex(
  rows: readonly Readonly<Record<string, unknown>>[],
  primaryKey: string,
): ReadonlyMap<unknown, number> | undefined {
  const cachedIndexes = ROW_IDENTITY_INDEXES_BY_ROWS.get(rows)
  if (cachedIndexes?.has(primaryKey)) {
    return cachedIndexes.get(primaryKey)
  }

  const identityIndex = createDefinedRowIdentityIndex(rows, primaryKey)
  if (cachedIndexes) {
    cachedIndexes.set(primaryKey, identityIndex)
  } else {
    ROW_IDENTITY_INDEXES_BY_ROWS.set(rows, new Map([[primaryKey, identityIndex]]))
  }

  return identityIndex
}

function createDefinedRowIdentityIndex(
  rows: readonly Readonly<Record<string, unknown>>[],
  primaryKey: string,
): ReadonlyMap<unknown, number> | undefined {
  const identities = new Map<unknown, number>()
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!row) {
      continue
    }

    const identity = rowIdentity(row, primaryKey)
    if (typeof identity === 'undefined' || identities.has(identity)) {
      return undefined
    }

    identities.set(identity, index)
  }

  return identities
}
