import type {
  DatabaseMutationEvent,
} from './dependencies'
import {
  NO_EXACT_ID_PREDICATE,
  hasRecordKey,
  matchesPatchedPredicate,
  matchesPredicateValue,
  matchesPredicates,
  readMutationValueKeys,
  readMutationExactIdPredicateValue,
  readQueryExactIdPredicateValue,
  valueKeysChangeColumns,
} from './predicate-matching'
import {
  isOffsetOrderedLimitedWindow,
  readQueryOrderColumns,
  readQueryPredicateColumns,
} from './query-metadata'
import {
  UNCHANGED_QUERY_RESULT,
  UNPATCHED_RESULT,
} from './query-patch-results'
import {
  exactIdsDiffer,
  matchesExactRowIdentity,
  mutationRowsContainExactId,
  rowsContainExactId,
} from './query-row-matching'
import type {
  DatabaseQueryObservation,
  PatchQueryResult,
  QueryRowPatchContext,
  RowMutationApplier,
  RowsQueryPatchTarget,
} from './query-state'
import type { BackfillCache } from './state'
import { isRecordArray } from './value'

type ScalarMutationValueResult =
  | {
    readonly patched: false
    readonly unchanged?: true
  }
  | {
    readonly patched: true
    readonly value: unknown
  }

type PatchScalarListRows = (
  query: DatabaseQueryObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache,
  queryContext: QueryRowPatchContext,
  applyMutation: RowMutationApplier,
  rowPatchMode: RowsQueryPatchTarget['rowPatchMode'],
) => Promise<PatchQueryResult>

export function tryPatchQueryScalar(
  query: DatabaseQueryObservation,
  value: unknown,
  mutations: readonly DatabaseMutationEvent[],
): PatchQueryResult {
  const column = query.scalarColumn
  if (!column) {
    return UNPATCHED_RESULT
  }

  const exactQueryId = readQueryExactIdPredicateValue(query)
  if (exactQueryId === NO_EXACT_ID_PREDICATE) {
    return UNPATCHED_RESULT
  }

  let nextValue = value
  let changed = false
  for (const mutation of mutations) {
    const result = readScalarMutationValue(query, mutation, exactQueryId, column)
    if (!result.patched) {
      if (result.unchanged) {
        continue
      }

      return UNPATCHED_RESULT
    }

    if (result.value !== nextValue) {
      nextValue = result.value
      changed = true
    }
  }

  return changed
    ? Object.freeze({
        patched: true,
        query,
        value: nextValue,
      })
    : UNCHANGED_QUERY_RESULT
}

function readScalarMutationValue(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  exactQueryId: unknown,
  column: string,
): ScalarMutationValueResult {
  if (exactIdsDiffer(exactQueryId, readMutationExactIdPredicateValue(mutation))) {
    return { patched: false, unchanged: true }
  }

  if (scalarMutationCannotChangeValue(query, mutation, column)) {
    return { patched: false, unchanged: true }
  }

  if (mutation.kind === 'delete') {
    const deletedRowsContainId = mutationRowsContainExactId(mutation.rows, exactQueryId)
    if (typeof deletedRowsContainId === 'undefined') {
      return UNPATCHED_RESULT
    }

    return deletedRowsContainId
      ? { patched: true, value: undefined }
      : { patched: false, unchanged: true }
  }

  const rowResult = readScalarMutationRowValue(query, mutation.rows, exactQueryId, column, mutation.values)
  if (rowResult.patched) {
    return rowResult
  }

  if (!rowResult.unchanged) {
    return rowResult
  }

  const values = mutation.values
  if (mutation.kind === 'update' && values && hasRecordKey(values, column)) {
    const matchesQuery = scalarMutationValuesMatchQuery(query, mutation, values)
    if (typeof matchesQuery === 'undefined') {
      return UNPATCHED_RESULT
    }

    if (!matchesQuery) {
      return {
        patched: true,
        value: undefined,
      }
    }

    return {
      patched: true,
      value: values[column],
    }
  }

  if (mutation.kind === 'update' && values) {
    const predicateOnlyResult = readScalarPredicateOnlyMutationValue(query, mutation, exactQueryId, values)
    if (predicateOnlyResult) {
      return predicateOnlyResult
    }
  }

  const previousRowsContainId = rowsContainExactId(mutation.previousRows ?? [], exactQueryId)
  if (previousRowsContainId === true && mutation.kind === 'update') {
    return UNPATCHED_RESULT
  }

  return { patched: false, unchanged: true }
}

function scalarMutationValuesMatchQuery(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  values: Readonly<Record<string, unknown>>,
): boolean | undefined {
  const valueKeys = readMutationValueKeys(mutation)
  for (const predicate of query.predicates) {
    if (hasRecordKey(values, predicate.column)) {
      const matches = matchesPredicateValue(values[predicate.column], predicate)
      if (typeof matches === 'undefined') {
        return undefined
      }

      if (!matches) {
        return false
      }

      continue
    }

    if (valueKeys.includes(predicate.column)) {
      return undefined
    }
  }

  return true
}

function readScalarPredicateOnlyMutationValue(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  exactQueryId: unknown,
  values: Readonly<Record<string, unknown>>,
): ScalarMutationValueResult | undefined {
  const matchesQuery = scalarMutationValuesMatchQuery(query, mutation, values)
  if (typeof matchesQuery === 'undefined') {
    return UNPATCHED_RESULT
  }

  const mutationExactId = readMutationExactIdPredicateValue(mutation)
  if (mutationExactId === NO_EXACT_ID_PREDICATE) {
    if (!mutation.previousRows || mutation.previousRows.length === 0) {
      return matchesQuery ? undefined : UNPATCHED_RESULT
    }

    const previousRowsContainId = rowsContainExactId(mutation.previousRows, exactQueryId)
    if (typeof previousRowsContainId === 'undefined') {
      return UNPATCHED_RESULT
    }

    if (!previousRowsContainId) {
      return { patched: false, unchanged: true }
    }
  }

  return matchesQuery
    ? { patched: false, unchanged: true }
    : {
        patched: true,
        value: undefined,
      }
}

function scalarMutationCannotChangeValue(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  column: string,
): boolean {
  if (mutation.kind !== 'update' || !mutation.values) {
    return false
  }

  const valueKeys = readMutationValueKeys(mutation)
  const relevantColumns = [
    column,
    ...readQueryPredicateColumns(query),
  ]
  return !valueKeysChangeColumns(valueKeys, relevantColumns)
}

function readScalarMutationRowValue(
  query: DatabaseQueryObservation,
  rows: readonly Readonly<Record<string, unknown>>[] | undefined,
  exactQueryId: unknown,
  column: string,
  values: Readonly<Record<string, unknown>> | undefined,
): ScalarMutationValueResult {
  if (!rows || rows.length === 0) {
    return { patched: false, unchanged: true }
  }

  for (const row of rows) {
    const matchesIdentity = matchesExactRowIdentity(row, exactQueryId)
    if (typeof matchesIdentity === 'undefined') {
      return UNPATCHED_RESULT
    }

    if (!matchesIdentity) {
      continue
    }

    const matchesQuery = values
      ? matchesPredicatesWithValues(row, values, query.predicates)
      : matchesPredicates(row, query.predicates)
    if (typeof matchesQuery === 'undefined') {
      return UNPATCHED_RESULT
    }

    if (!matchesQuery) {
      return {
        patched: true,
        value: undefined,
      }
    }

    if (values && hasRecordKey(values, column)) {
      return {
        patched: true,
        value: values[column],
      }
    }

    if (!hasRecordKey(row, column)) {
      return UNPATCHED_RESULT
    }

    return {
      patched: true,
      value: row[column],
    }
  }

  return { patched: false, unchanged: true }
}

function matchesPredicatesWithValues(
  row: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, unknown>>,
  predicates: readonly DatabaseQueryObservation['predicates'][number][],
): boolean | undefined {
  const firstPredicate = predicates[0]
  if (!firstPredicate) {
    return true
  }

  if (predicates.length === 1) {
    return matchesPatchedPredicate(row, values, firstPredicate)
  }

  for (const predicate of predicates) {
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

function projectScalarListRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  column: string,
): readonly unknown[] | undefined {
  const values: unknown[] = []
  for (const row of rows) {
    if (!hasRecordKey(row, column)) {
      return undefined
    }

    values.push(row[column])
  }

  return Object.freeze(values)
}

function scalarListValuesEqual(
  left: readonly unknown[],
  right: readonly unknown[],
): boolean {
  if (left.length !== right.length) {
    return false
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false
    }
  }

  return true
}

function createScalarListQueryObservation(
  query: DatabaseQueryObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
): DatabaseQueryObservation {
  return Object.freeze({
    ...query,
    scalarListRows: rows,
  })
}

export async function tryPatchQueryScalarList(
  query: DatabaseQueryObservation,
  value: readonly unknown[],
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache,
  queryContext: QueryRowPatchContext,
  applyMutation: RowMutationApplier,
  patchRows: PatchScalarListRows,
): Promise<PatchQueryResult> {
  const column = query.scalarListColumn
  const rows = query.scalarListRows
  if (!column || !rows) {
    return UNPATCHED_RESULT
  }

  const relevantMutations = mutations.filter(mutation => !scalarListMutationCannotChangeValue(query, mutation, column))
  if (relevantMutations.length === 0) {
    return UNCHANGED_QUERY_RESULT
  }

  const result = await patchRows(
    query,
    rows,
    relevantMutations,
    backfills,
    queryContext,
    applyMutation,
    isOffsetOrderedLimitedWindow(query) ? 'offset-window' : 'rows',
  )
  if (!result.patched || 'unchanged' in result) {
    return result
  }

  if (!isRecordArray(result.value)) {
    return UNPATCHED_RESULT
  }

  const nextValue = projectScalarListRows(result.value, column)
  if (!nextValue) {
    return UNPATCHED_RESULT
  }

  const nextQuery = createScalarListQueryObservation(query, result.value)
  return scalarListValuesEqual(value, nextValue)
    ? Object.freeze({
        nextQuery,
        patched: true,
        unchanged: true,
      })
    : Object.freeze({
        nextQuery,
        patched: true,
        query,
        value: nextValue,
      })
}

function scalarListMutationCannotChangeValue(
  query: DatabaseQueryObservation,
  mutation: DatabaseMutationEvent,
  column: string,
): boolean {
  if (mutation.kind !== 'update' || !mutation.values) {
    return false
  }

  const valueKeys = readMutationValueKeys(mutation)
  const relevantColumns = [
    column,
    ...readQueryPredicateColumns(query),
    ...readQueryOrderColumns(query),
  ]
  return !valueKeysChangeColumns(valueKeys, relevantColumns)
}
