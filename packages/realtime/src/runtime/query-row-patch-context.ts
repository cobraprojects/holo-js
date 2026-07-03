import type {
  DatabaseMutationEvent,
} from './dependencies'
import {
  NO_EXACT_ID_PREDICATE,
  createMutationPredicateMatchContext,
  createPredicateMatchContext,
  hasRecordKey,
  matchesPatchedPredicate,
  matchesPredicate,
  matchesPredicateValue,
  readMutationExactIdPredicateValue,
  readMutationValueKeys,
  readQueryExactIdPredicateValue,
  valueKeysChangeColumns,
  type PredicateMatchContext,
} from './predicate-matching'
import {
  hasProjectedSelections,
  readQueryOrderColumns,
  readQueryOrderMultipliers,
  readQueryPredicateColumns,
  readQueryProjectedIdentityColumn,
  readQueryRowWindowMode,
  readQuerySelectionColumns,
  readQuerySelectionResultKeys,
} from './query-metadata'
import {
  appendRowLazily,
  appendRowsRange,
} from './query-row-array'
import {
  matchesExactRowIdentity,
  matchesPatchedExactRowIdentity,
} from './query-row-matching'
import type {
  BackfillCache,
  DatabaseQueryObservation,
  MutationPatchMetadata,
  QueryRowPatchContext,
  RowPatchContext,
} from './query-state'
import {
  NO_PROJECTED_IDENTITY_COLUMN,
} from './query-state'

export function matchesPredicateContext(
  row: Readonly<Record<string, unknown>>,
  context: PredicateMatchContext,
): boolean | undefined {
  if (context.exactId !== NO_EXACT_ID_PREDICATE) {
    const matchesExactId = matchesExactRowIdentity(row, context.exactId)
    return matchesExactId ? matchesRemainingPredicateContext(row, context) : matchesExactId
  }

  const firstPredicate = context.firstPredicate
  if (!firstPredicate) {
    return true
  }

  if (context.predicateCount === 1) {
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

    return matchesPredicateValue(value, firstPredicate)
  }

  for (const predicate of context.predicates) {
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

export function matchesPatchedPredicateContext(
  row: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, unknown>>,
  context: PredicateMatchContext,
): boolean | undefined {
  if (context.exactId !== NO_EXACT_ID_PREDICATE) {
    const matchesExactId = matchesPatchedExactRowIdentity(row, values, context.exactId)
    return matchesExactId ? matchesRemainingPatchedPredicateContext(row, values, context) : matchesExactId
  }

  const firstPredicate = context.firstPredicate
  if (!firstPredicate) {
    return true
  }

  if (context.predicateCount === 1) {
    return matchesPatchedPredicate(row, values, firstPredicate)
  }

  for (const predicate of context.predicates) {
    const matches = matchesPatchedPredicate(row, values, predicate)
    if (typeof matches === 'undefined') {
      return undefined
    }

    if (!matches) {
      return false
    }
  }

  return true
}

function matchesRemainingPredicateContext(
  row: Readonly<Record<string, unknown>>,
  context: PredicateMatchContext,
): boolean | undefined {
  for (const predicate of context.predicates) {
    if (isMatchedExactIdPredicate(predicate, context.exactId)) {
      continue
    }

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

function matchesRemainingPatchedPredicateContext(
  row: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, unknown>>,
  context: PredicateMatchContext,
): boolean | undefined {
  for (const predicate of context.predicates) {
    if (isMatchedExactIdPredicate(predicate, context.exactId)) {
      continue
    }

    const matches = matchesPatchedPredicate(row, values, predicate)
    if (typeof matches === 'undefined') {
      return undefined
    }

    if (!matches) {
      return false
    }
  }

  return true
}

function isMatchedExactIdPredicate(
  predicate: Readonly<{
    readonly column: string
    readonly operator: string
    readonly value: unknown
  }>,
  exactId: unknown | typeof NO_EXACT_ID_PREDICATE,
): boolean {
  return exactId !== NO_EXACT_ID_PREDICATE
    && predicate.column === 'id'
    && predicate.operator === '='
    && predicate.value === exactId
}

export function readMutationPatchMetadata(
  mutation: DatabaseMutationEvent,
  backfills: BackfillCache,
): MutationPatchMetadata {
  const cachedMetadata = backfills.mutationMetadata.get(mutation)
  if (cachedMetadata) {
    return cachedMetadata
  }

  const metadata = createMutationPatchMetadata(mutation)
  backfills.mutationMetadata.set(mutation, metadata)
  return metadata
}

function createMutationPatchMetadata(mutation: DatabaseMutationEvent): MutationPatchMetadata {
  const exactMutationId = readMutationExactIdPredicateValue(mutation)
  return Object.freeze({
    exactMutationId,
    hasValues: Boolean(mutation.values),
    mutationPredicates: createMutationPredicateMatchContext(mutation, exactMutationId),
    valueKeys: readMutationValueKeys(mutation),
  })
}

export function canPatchShrinkingRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
): boolean {
  const windowMode = readQueryRowWindowMode(query)
  if (windowMode === 'single' || windowMode === 'unwindowed') {
    return true
  }

  const limit = query.limit
  if (typeof limit !== 'number') {
    return true
  }

  if (query.offset && query.offset > 0) {
    return false
  }

  return rows.length < limit
}

export function canBackfillShrinkingRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  nextRows: readonly Readonly<Record<string, unknown>>[],
  query: DatabaseQueryObservation,
): boolean {
  return readQueryRowWindowMode(query) === 'limited'
    && rows.length === query.limit
    && nextRows.length < rows.length
}

export function createQueryRowPatchContext(query: DatabaseQueryObservation): QueryRowPatchContext {
  const exactQueryId = readQueryExactIdPredicateValue(query)
  const projectedIdentityColumn = readQueryProjectedIdentityColumn(query)
  return {
    exactQueryId,
    hasProjectedSelections: query.hasProjectedSelections ?? hasProjectedSelections(query),
    orderColumns: readQueryOrderColumns(query),
    orderMultipliers: readQueryOrderMultipliers(query),
    projectedIdentityColumn,
    queryPredicates: createPredicateMatchContext(query.predicates, exactQueryId),
    selectionColumns: readQuerySelectionColumns(query),
    selectionResultKeys: readQuerySelectionResultKeys(query),
    usesExactQueryIdAsProjectedIdentity: exactQueryId !== NO_EXACT_ID_PREDICATE
      && projectedIdentityColumn === NO_PROJECTED_IDENTITY_COLUMN
      && readQueryRowWindowMode(query) === 'single',
  }
}

export function createMutationRowPatchContext(
  queryContext: QueryRowPatchContext,
  metadata: MutationPatchMetadata,
): RowPatchContext {
  return {
    exactMutationId: metadata.exactMutationId,
    exactQueryId: queryContext.exactQueryId,
    hasProjectedSelections: queryContext.hasProjectedSelections,
    mutationPredicates: metadata.mutationPredicates,
    orderColumns: queryContext.orderColumns,
    orderMultipliers: queryContext.orderMultipliers,
    projectedIdentityColumn: queryContext.projectedIdentityColumn,
    projectedSelectionChanged: selectionColumnsChangedByMutation(queryContext.selectionColumns, metadata),
    queryOrderChanged: valueKeysChangeColumns(metadata.valueKeys, queryContext.orderColumns),
    queryPredicates: queryContext.queryPredicates,
    selectionColumns: queryContext.selectionColumns,
    selectionResultKeys: queryContext.selectionResultKeys,
    usesExactQueryIdAsProjectedIdentity: queryContext.usesExactQueryIdAsProjectedIdentity,
    valueKeys: metadata.valueKeys,
  }
}

export function projectedUpdateCannotAffectQueryResult(
  query: DatabaseQueryObservation,
  queryContext: QueryRowPatchContext,
  mutation: DatabaseMutationEvent,
  metadata: MutationPatchMetadata,
): boolean {
  if (mutation.kind !== 'update' || !metadata.hasValues || !queryContext.hasProjectedSelections) {
    return false
  }

  if (queryContext.selectionColumns.length === 0) {
    return false
  }

  const predicateColumns = readQueryPredicateColumns(query)
  const visibleColumns = [
    ...queryContext.selectionColumns,
    ...queryContext.orderColumns,
    ...predicateColumns,
  ]
  return !valueKeysChangeColumns(metadata.valueKeys, visibleColumns)
}

function selectionColumnsChangedByMutation(
  selectionColumns: readonly string[],
  metadata: MutationPatchMetadata,
): boolean {
  if (selectionColumns.length === 0 || !metadata.hasValues) {
    return true
  }

  return valueKeysChangeColumns(metadata.valueKeys, selectionColumns)
}

export function mergePatchRow(
  current: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
  keys: readonly string[] = Object.keys(patch),
): Readonly<Record<string, unknown>> {
  let next: Record<string, unknown> | undefined
  for (const key of keys) {
    if (!hasRecordKey(current, key) || current[key] !== patch[key]) {
      next ??= copyRecord(current)
      next[key] = patch[key]
    }
  }

  return next ? Object.freeze(next) : current
}

export function copyRecord(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const copy: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    copy[key] = record[key]
  }

  return copy
}

export function replaceRowByIndexLazily(
  rows: readonly Readonly<Record<string, unknown>>[],
  rowIndex: number,
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>>[] {
  const rowCount = rows.length
  if (rowIndex === rowCount) {
    return appendRowLazily(rows, row)
  }

  if (rowIndex >= 0 && rowIndex < rowCount) {
    const nextRows = new Array<Readonly<Record<string, unknown>>>(rowCount)
    let copiedAllRows = true
    for (let index = 0; index < rowCount; index += 1) {
      if (index === rowIndex) {
        nextRows[index] = row
        continue
      }

      const current = rows[index]
      if (!current) {
        copiedAllRows = false
        break
      }

      nextRows[index] = current
    }

    if (copiedAllRows) {
      return nextRows
    }
  }

  const nextRows: Readonly<Record<string, unknown>>[] = []
  appendRowsRange(nextRows, rows, 0, rowIndex)
  nextRows.push(row)
  appendRowsRange(nextRows, rows, rowIndex + 1, rows.length)
  return nextRows
}
