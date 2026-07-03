import {
  DUPLICATE_ROW_IDENTITY,
  ROWS_WITHOUT_UNIQUE_IDENTITY_INDEX,
  ROW_IDENTITY_INDEXES_BY_ROWS,
  type DatabaseQueryObservation,
} from './query-state'
import { isRecordArray } from './value'

export function rowIdentity(row: Readonly<Record<string, unknown>>): unknown {
  return row.id
}

export function createQueryRowIdentityIndex(value: unknown): ReadonlyMap<unknown, number> | undefined {
  return isRecordArray(value) ? readRowsIdentityIndex(value) : undefined
}

export function readQueryRowIdentityIndex(
  query: DatabaseQueryObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
): ReadonlyMap<unknown, number> | undefined {
  return query.result === rows
    ? query.rowIdentityIndex ?? readRowsIdentityIndex(rows)
    : readRowsIdentityIndex(rows)
}

export function findUniqueRowIndexByIdentityValue(
  rows: readonly Readonly<Record<string, unknown>>[],
  identity: unknown,
): number | undefined | typeof DUPLICATE_ROW_IDENTITY {
  let rowIndex: number | undefined
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!row || rowIdentity(row) !== identity) {
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
): ReadonlyMap<unknown, number> | undefined {
  const cachedIndex = ROW_IDENTITY_INDEXES_BY_ROWS.get(rows)
  if (cachedIndex) {
    return cachedIndex
  }

  if (ROWS_WITHOUT_UNIQUE_IDENTITY_INDEX.has(rows)) {
    return undefined
  }

  const identityIndex = createDefinedRowIdentityIndex(rows)
  if (!identityIndex) {
    ROWS_WITHOUT_UNIQUE_IDENTITY_INDEX.add(rows)
    return undefined
  }

  ROW_IDENTITY_INDEXES_BY_ROWS.set(rows, identityIndex)
  return identityIndex
}

function createDefinedRowIdentityIndex(
  rows: readonly Readonly<Record<string, unknown>>[],
): ReadonlyMap<unknown, number> | undefined {
  const identities = new Map<unknown, number>()
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!row) {
      continue
    }

    const identity = rowIdentity(row)
    if (typeof identity === 'undefined' || identities.has(identity)) {
      return undefined
    }

    identities.set(identity, index)
  }

  return identities
}
