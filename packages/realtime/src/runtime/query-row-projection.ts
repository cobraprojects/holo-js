import {
  hasRecordKey,
} from './predicate-matching'
import {
  copyRecord,
  mergePatchRow,
} from './query-row-patch-context'
import {
  rowIdentity,
} from './query-row-identity'
import {
  MISSING_PROJECTED_IDENTITY,
  NO_PROJECTED_IDENTITY_COLUMN,
  PROJECTED_IDENTITY_UNDEFINED,
  type RowPatchContext,
} from './query-state'

export function projectRowWithContext(
  context: RowPatchContext,
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  if (!context.hasProjectedSelections) {
    return row
  }

  const projected: Record<string, unknown> = {}
  for (let index = 0; index < context.selectionColumns.length; index += 1) {
    const column = context.selectionColumns[index]
    const resultKey = context.selectionResultKeys[index]
    if (!column || !resultKey || !hasRecordKey(row, column)) {
      return undefined
    }

    projected[resultKey] = row[column]
  }

  return Object.freeze(projected)
}

export function projectedRowIdentity(
  context: RowPatchContext,
  row: Readonly<Record<string, unknown>>,
): unknown | typeof MISSING_PROJECTED_IDENTITY {
  if (!context.hasProjectedSelections) {
    return rowIdentity(row)
  }

  if (context.projectedIdentityColumn === NO_PROJECTED_IDENTITY_COLUMN) {
    return context.usesExactQueryIdAsProjectedIdentity ? context.exactQueryId : undefined
  }

  for (const selectionColumn of context.selectionColumns) {
    if (!hasRecordKey(row, selectionColumn)) {
      return MISSING_PROJECTED_IDENTITY
    }
  }

  return row[context.projectedIdentityColumn]
}

export function readProjectedRowIdentity(
  row: Readonly<Record<string, unknown>>,
  context: RowPatchContext,
  cache: WeakMap<Readonly<Record<string, unknown>>, unknown> | undefined,
): unknown | typeof MISSING_PROJECTED_IDENTITY {
  if (!cache) {
    return projectedRowIdentity(context, row)
  }

  if (cache.has(row)) {
    const identity = cache.get(row)
    return identity === PROJECTED_IDENTITY_UNDEFINED ? undefined : identity
  }

  const identity = projectedRowIdentity(context, row)
  cache.set(row, typeof identity === 'undefined' ? PROJECTED_IDENTITY_UNDEFINED : identity)
  return identity
}

export function readProjectedRowIdentityCache(context: RowPatchContext): WeakMap<Readonly<Record<string, unknown>>, unknown> {
  context.projectedIdentityCache ??= new WeakMap<Readonly<Record<string, unknown>>, unknown>()
  return context.projectedIdentityCache
}

export function mergeProjectedPatchRowWithContext(
  current: Readonly<Record<string, unknown>>,
  context: RowPatchContext,
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  if (!context.hasProjectedSelections) {
    return mergePatchRow(current, row)
  }

  let next: Record<string, unknown> | undefined
  for (let index = 0; index < context.selectionColumns.length; index += 1) {
    const column = context.selectionColumns[index]
    const resultKey = context.selectionResultKeys[index]
    if (!column || !resultKey || !hasRecordKey(row, column)) {
      return undefined
    }

    if (!hasRecordKey(current, resultKey) || current[resultKey] !== row[column]) {
      next ??= copyRecord(current)
      next[resultKey] = row[column]
    }
  }

  return next ? Object.freeze(next) : current
}

export function mergeProjectedMutationValuesWithContext(
  current: Readonly<Record<string, unknown>>,
  context: RowPatchContext,
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  if (!context.hasProjectedSelections) {
    return mergePatchRow(current, values, context.valueKeys)
  }

  let next: Record<string, unknown> | undefined
  for (let index = 0; index < context.selectionColumns.length; index += 1) {
    const column = context.selectionColumns[index]
    const resultKey = context.selectionResultKeys[index]
    if (!column || !resultKey) {
      return undefined
    }

    if (!context.valueKeys.includes(column)) {
      continue
    }

    if (!hasRecordKey(values, column)) {
      return undefined
    }

    if (!hasRecordKey(current, resultKey) || current[resultKey] !== values[column]) {
      next ??= copyRecord(current)
      next[resultKey] = values[column]
    }
  }

  return next ? Object.freeze(next) : current
}

export function mergeProjectedPatchRowAndMutationValuesWithContext(
  current: Readonly<Record<string, unknown>>,
  context: RowPatchContext,
  row: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | undefined {
  if (!context.hasProjectedSelections) {
    return mergePatchRow(mergePatchRow(current, row), values, context.valueKeys)
  }

  let next: Record<string, unknown> | undefined
  for (let index = 0; index < context.selectionColumns.length; index += 1) {
    const column = context.selectionColumns[index]
    const resultKey = context.selectionResultKeys[index]
    if (!column || !resultKey) {
      return undefined
    }

    if (hasRecordKey(row, column)) {
      if (!hasRecordKey(current, resultKey) || current[resultKey] !== row[column]) {
        next ??= copyRecord(current)
        next[resultKey] = row[column]
      }
      continue
    }

    if (context.valueKeys.includes(column)) {
      if (!hasRecordKey(values, column)) {
        return undefined
      }

      if (!hasRecordKey(current, resultKey) || current[resultKey] !== values[column]) {
        next ??= copyRecord(current)
        next[resultKey] = values[column]
      }
      continue
    }

    if (!hasRecordKey(current, resultKey)) {
      return undefined
    }
  }

  return next ? Object.freeze(next) : current
}
