import {
  appendScannedRow,
  createScannedRowsState,
  readScannedRows,
  removeRowByIdentityValueFromQueryRows,
  removeRowByIdentityValueFromQueryRowsLazily,
  removeRowsByIdentityValuesFromQueryRows,
  removeRowsByIdentityValuesFromQueryRowsLazily,
  removeRowsByTwoIdentityValuesFromQueryRows,
  removeRowsByTwoIdentityValuesFromQueryRowsLazily,
  skipScannedRow,
} from './query-row-array'
import {
  readProjectedRowIdentity,
} from './query-row-projection'
import {
  MISSING_PROJECTED_IDENTITY,
  type DatabaseQueryObservation,
  type ProjectedLazyRowsMutationResult,
  type RowPatchContext,
} from './query-state'

export function removeRowsByProjectedIdentity(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  context: RowPatchContext,
  removedRows: readonly Readonly<Record<string, unknown>>[],
  identityCache?: WeakMap<Readonly<Record<string, unknown>>, unknown>,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (context.usesExactQueryIdAsProjectedIdentity) {
    return removeProjectedRowsByScannedIdentity(rows, removedRows, context, identityCache)
  }

  const firstRemovedRow = removedRows[0]
  if (!firstRemovedRow) {
    return rows
  }

  if (removedRows.length === 1) {
    return removeRowByProjectedIdentity(rows, query, context, firstRemovedRow, identityCache)
  }

  const secondRemovedRow = removedRows[1]
  if (removedRows.length === 2 && secondRemovedRow) {
    const firstIdentity = readProjectedRowIdentity(firstRemovedRow, context, identityCache)
    const secondIdentity = readProjectedRowIdentity(secondRemovedRow, context, identityCache)
    return firstIdentity === MISSING_PROJECTED_IDENTITY || secondIdentity === MISSING_PROJECTED_IDENTITY
      ? undefined
      : removeRowsByTwoIdentityValuesFromQueryRows(rows, query, firstIdentity, secondIdentity)
  }

  const removedIdentities = new Set<unknown>()
  for (const row of removedRows) {
    const identity = readProjectedRowIdentity(row, context, identityCache)
    if (identity === MISSING_PROJECTED_IDENTITY) {
      return undefined
    }

    removedIdentities.add(identity)
  }

  return removeRowsByIdentityValuesFromQueryRows(rows, query, removedIdentities)
}

export function removeRowsByProjectedIdentityLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  nextRows: Readonly<Record<string, unknown>>[] | undefined,
  query: DatabaseQueryObservation,
  context: RowPatchContext,
  removedRows: readonly Readonly<Record<string, unknown>>[],
  identityCache?: WeakMap<Readonly<Record<string, unknown>>, unknown>,
): ProjectedLazyRowsMutationResult {
  if (context.usesExactQueryIdAsProjectedIdentity) {
    return removeProjectedRowsByScannedIdentityLazily(rows, nextRows, removedRows, context, identityCache)
  }

  const firstRemovedRow = removedRows[0]
  if (!firstRemovedRow) {
    return nextRows
  }

  if (removedRows.length === 1) {
    return removeRowByProjectedIdentityLazily(rows, nextRows, query, context, firstRemovedRow, identityCache)
  }

  const secondRemovedRow = removedRows[1]
  if (removedRows.length === 2 && secondRemovedRow) {
    const firstIdentity = readProjectedRowIdentity(firstRemovedRow, context, identityCache)
    const secondIdentity = readProjectedRowIdentity(secondRemovedRow, context, identityCache)
    return firstIdentity === MISSING_PROJECTED_IDENTITY || secondIdentity === MISSING_PROJECTED_IDENTITY
      ? MISSING_PROJECTED_IDENTITY
      : removeRowsByTwoIdentityValuesFromQueryRowsLazily(rows, nextRows, query, firstIdentity, secondIdentity)
  }

  const removedIdentities = new Set<unknown>()
  for (const row of removedRows) {
    const identity = readProjectedRowIdentity(row, context, identityCache)
    if (identity === MISSING_PROJECTED_IDENTITY) {
      return MISSING_PROJECTED_IDENTITY
    }

    removedIdentities.add(identity)
  }

  return removeRowsByIdentityValuesFromQueryRowsLazily(rows, nextRows, query, removedIdentities)
}

export function removeRowByProjectedIdentityLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  nextRows: Readonly<Record<string, unknown>>[] | undefined,
  query: DatabaseQueryObservation,
  context: RowPatchContext,
  removedRow: Readonly<Record<string, unknown>>,
  identityCache?: WeakMap<Readonly<Record<string, unknown>>, unknown>,
): ProjectedLazyRowsMutationResult {
  if (context.usesExactQueryIdAsProjectedIdentity) {
    return removeProjectedRowsByScannedIdentityLazily(rows, nextRows, [removedRow], context, identityCache)
  }

  const removedIdentity = readProjectedRowIdentity(removedRow, context, identityCache)
  return removedIdentity === MISSING_PROJECTED_IDENTITY
    ? MISSING_PROJECTED_IDENTITY
    : removeRowByIdentityValueFromQueryRowsLazily(rows, nextRows, query, removedIdentity)
}

function removeRowByProjectedIdentity(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
  context: RowPatchContext,
  removedRow: Readonly<Record<string, unknown>>,
  identityCache?: WeakMap<Readonly<Record<string, unknown>>, unknown>,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  const removedIdentity = readProjectedRowIdentity(removedRow, context, identityCache)
  return removedIdentity === MISSING_PROJECTED_IDENTITY
    ? undefined
    : removeRowByIdentityValueFromQueryRows(rows, query, removedIdentity)
}

function collectProjectedRemovedIdentities(
  removedRows: readonly Readonly<Record<string, unknown>>[],
  context: RowPatchContext,
  identityCache?: WeakMap<Readonly<Record<string, unknown>>, unknown>,
): ReadonlySet<unknown> | typeof MISSING_PROJECTED_IDENTITY {
  const removedIdentities = new Set<unknown>()
  for (const row of removedRows) {
    const identity = readProjectedRowIdentity(row, context, identityCache)
    if (identity === MISSING_PROJECTED_IDENTITY) {
      return MISSING_PROJECTED_IDENTITY
    }

    removedIdentities.add(identity)
  }

  return removedIdentities
}

function removeProjectedRowsByScannedIdentity(
  rows: readonly Readonly<Record<string, unknown>>[],
  removedRows: readonly Readonly<Record<string, unknown>>[],
  context: RowPatchContext,
  identityCache?: WeakMap<Readonly<Record<string, unknown>>, unknown>,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  const removedIdentities = collectProjectedRemovedIdentities(removedRows, context, identityCache)
  if (removedIdentities === MISSING_PROJECTED_IDENTITY) {
    return undefined
  }

  let nextRows: ReturnType<typeof createScannedRowsState> | undefined
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (!row) {
      continue
    }

    const identity = readProjectedRowIdentity(row, context, identityCache)
    if (identity === MISSING_PROJECTED_IDENTITY) {
      return undefined
    }

    if (!removedIdentities.has(identity)) {
      if (nextRows) {
        appendScannedRow(nextRows, rows, index, row)
      }
      continue
    }

    nextRows ??= createScannedRowsState()
    skipScannedRow(nextRows, rows, index)
  }

  return nextRows ? Object.freeze(readScannedRows(nextRows, rows)) : rows
}

function removeProjectedRowsByScannedIdentityLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  nextRows: Readonly<Record<string, unknown>>[] | undefined,
  removedRows: readonly Readonly<Record<string, unknown>>[],
  context: RowPatchContext,
  identityCache?: WeakMap<Readonly<Record<string, unknown>>, unknown>,
): ProjectedLazyRowsMutationResult {
  const removedIdentities = collectProjectedRemovedIdentities(removedRows, context, identityCache)
  if (removedIdentities === MISSING_PROJECTED_IDENTITY) {
    return MISSING_PROJECTED_IDENTITY
  }

  const targetRows = nextRows ?? rows
  if (nextRows) {
    let writeIndex = 0
    for (let readIndex = 0; readIndex < nextRows.length; readIndex += 1) {
      const row = nextRows[readIndex]
      if (!row) {
        continue
      }

      const identity = readProjectedRowIdentity(row, context, identityCache)
      if (identity === MISSING_PROJECTED_IDENTITY) {
        return MISSING_PROJECTED_IDENTITY
      }

      if (removedIdentities.has(identity)) {
        continue
      }

      nextRows[writeIndex] = row
      writeIndex += 1
    }

    nextRows.length = writeIndex
    return nextRows
  }

  let mutableRows: ReturnType<typeof createScannedRowsState> | undefined
  for (let index = 0; index < targetRows.length; index += 1) {
    const row = targetRows[index]
    if (!row) {
      continue
    }

    const identity = readProjectedRowIdentity(row, context, identityCache)
    if (identity === MISSING_PROJECTED_IDENTITY) {
      return MISSING_PROJECTED_IDENTITY
    }

    if (removedIdentities.has(identity)) {
      mutableRows ??= createScannedRowsState()
      skipScannedRow(mutableRows, targetRows, index)
      continue
    }

    if (mutableRows) {
      appendScannedRow(mutableRows, targetRows, index, row)
    }
  }

  return mutableRows ? readScannedRows(mutableRows, targetRows) : undefined
}
