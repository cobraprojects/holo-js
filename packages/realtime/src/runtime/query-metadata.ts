import { createMutationIndexKey } from './dependencies'
import {
  readQueryExactIdPredicateValue,
  type DatabaseQueryPredicateObservation,
} from './predicate-matching'
import { createQueryRowIdentityIndex } from './query-row-identity'
import {
  EMPTY_ORDER_COLUMNS,
  EMPTY_ORDER_MULTIPLIERS,
  EMPTY_PREDICATE_COLUMNS,
  EMPTY_SELECTION_COLUMNS,
  EMPTY_SELECTION_RESULT_KEYS,
  NO_PROJECTED_IDENTITY_COLUMN,
  type DatabaseQueryObservation,
  type DatabaseQueryOrderObservation,
  type DatabaseQuerySelectionObservation,
  type RowWindowMode,
} from './query-state'
import { stableStringify } from './stable-stringify'

export function readQueryOrderColumns(query: DatabaseQueryObservation): readonly string[] {
  return query.orderColumns ?? createQueryOrderColumns(query.orderBy)
}

export function readQueryOrderMultipliers(query: DatabaseQueryObservation): readonly number[] {
  return query.orderMultipliers ?? createQueryOrderMultipliers(query.orderBy)
}

export function readQueryPredicateColumns(query: DatabaseQueryObservation): readonly string[] {
  return query.predicateColumns ?? createQueryPredicateColumns(query.predicates)
}

export function readQuerySelectionColumns(query: DatabaseQueryObservation): readonly string[] {
  return query.selectionColumns ?? createQuerySelectionColumns(query.selections)
}

export function readQuerySelectionResultKeys(query: DatabaseQueryObservation): readonly string[] {
  return query.selectionResultKeys ?? createQuerySelectionResultKeys(query.selections)
}

export function readQueryProjectedIdentityColumn(
  query: DatabaseQueryObservation,
): string | typeof NO_PROJECTED_IDENTITY_COLUMN {
  return query.projectedIdentityColumn ?? createQueryProjectedIdentityColumn(query.selections)
}

export function hasQueryOrderBy(query: DatabaseQueryObservation): boolean {
  return typeof query.hasOrderBy === 'boolean' ? query.hasOrderBy : query.orderBy.length > 0
}

export function hasProjectedSelections(query: DatabaseQueryObservation): boolean {
  return typeof query.hasProjectedSelections === 'boolean'
    ? query.hasProjectedSelections
    : Boolean(query.selections && query.selections.length > 0)
}

export function isSingleIdQuery(query: DatabaseQueryObservation): boolean {
  if (typeof query.isSingleId === 'boolean') {
    return query.isSingleId
  }

  return query.limit === 1
    && query.predicates.some(predicate => predicate.column === 'id' && predicate.operator === '=')
}

export function isOffsetOrderedLimitedWindow(query: DatabaseQueryObservation): boolean {
  if (typeof query.isOffsetOrderedLimited === 'boolean') {
    return query.isOffsetOrderedLimited
  }

  return typeof query.limit === 'number'
    && typeof query.offset === 'number'
    && query.offset > 0
    && hasQueryOrderBy(query)
}

export function readQueryRowWindowMode(query: DatabaseQueryObservation): RowWindowMode {
  if (query.rowWindowMode) {
    return query.rowWindowMode
  }

  if (isSingleIdQuery(query)) {
    return 'single'
  }

  if (typeof query.limit !== 'number') {
    return query.offset && query.offset > 0 ? 'invalid' : 'unwindowed'
  }

  return hasQueryOrderBy(query) && (!query.offset || query.offset === 0) ? 'limited' : 'invalid'
}

export function createQueryObservationMetadata(
  query: DatabaseQueryObservation,
): Pick<
  DatabaseQueryObservation,
  | 'aggregateBackfillKey'
  | 'aggregateScopeKey'
  | 'exactId'
  | 'hasOrderBy'
  | 'hasProjectedSelections'
  | 'isOffsetOrderedLimited'
  | 'isSingleId'
  | 'mutationIndexKey'
  | 'orderColumns'
  | 'orderMultipliers'
  | 'predicateColumns'
  | 'projectedIdentityColumn'
  | 'rowIdentityIndex'
  | 'rowBackfillKeyPrefix'
  | 'rowWindowMode'
  | 'selectionColumns'
  | 'selectionResultKeys'
> {
  const orderColumns = readQueryOrderColumns(query)
  const hasOrderBy = orderColumns.length > 0
  const rowWindowMode = readQueryRowWindowMode(query)
  const isAggregateQuery = Boolean(query.aggregate)
  return {
    aggregateBackfillKey: isAggregateQuery ? createAggregateBackfillKey(query) : undefined,
    aggregateScopeKey: isAggregateQuery ? createAggregateScopeKey(query) : undefined,
    exactId: readQueryExactIdPredicateValue(query),
    hasOrderBy,
    hasProjectedSelections: hasProjectedSelections(query),
    isOffsetOrderedLimited: isOffsetOrderedLimitedWindow(query),
    isSingleId: isSingleIdQuery(query),
    mutationIndexKey: createMutationIndexKey(query.connectionName, query.tableName),
    orderColumns,
    orderMultipliers: readQueryOrderMultipliers(query),
    predicateColumns: readQueryPredicateColumns(query),
    projectedIdentityColumn: readQueryProjectedIdentityColumn(query),
    rowIdentityIndex: createQueryRowIdentityIndex(query.result),
    rowBackfillKeyPrefix: isAggregateQuery ? undefined : createRowBackfillKeyPrefix(query),
    rowWindowMode,
    selectionColumns: readQuerySelectionColumns(query),
    selectionResultKeys: readQuerySelectionResultKeys(query),
  }
}

export function createBackfillQueryKey(
  query: DatabaseQueryObservation,
  offset: number,
  limit: number,
): string {
  return (query.rowBackfillKeyPrefix ?? createRowBackfillKeyPrefix(query))
    + ',"limit":'
    + stableStringify(limit)
    + ',"offset":'
    + stableStringify(offset)
    + '}'
}

export function createRowBackfillKeyPrefix(query: DatabaseQueryObservation): string {
  return '{"connectionName":'
    + stableStringify(query.connectionName)
    + ',"orderBy":'
    + stableStringify(query.orderBy)
    + ',"predicates":'
    + stableStringify(query.predicates)
    + ',"selections":'
    + stableStringify(query.selections ?? [])
    + ',"tableName":'
    + stableStringify(query.tableName)
}

export function createAggregateBackfillKey(query: DatabaseQueryObservation): string {
  return query.aggregateBackfillKey ?? '{"aggregate":'
    + stableStringify(query.aggregate)
    + ',"connectionName":'
    + stableStringify(query.connectionName)
    + ',"predicates":'
    + stableStringify(query.predicates)
    + ',"tableName":'
    + stableStringify(query.tableName)
    + '}'
}

export function createAggregateScopeKey(query: DatabaseQueryObservation): string {
  return query.aggregateScopeKey ?? '{"connectionName":'
    + stableStringify(query.connectionName)
    + ',"predicates":'
    + stableStringify(query.predicates)
    + ',"tableName":'
    + stableStringify(query.tableName)
    + '}'
}

export function createAggregateSqlBackfillKey(
  query: DatabaseQueryObservation,
  columns: readonly string[],
): string {
  return '{"columns":'
    + stableStringify(columns)
    + ',"scope":'
    + createAggregateScopeKey(query)
    + '}'
}

function createQueryOrderColumns(
  orderBy: readonly DatabaseQueryOrderObservation[],
): readonly string[] {
  if (orderBy.length === 0) {
    return EMPTY_ORDER_COLUMNS
  }

  const columns: string[] = []
  for (const order of orderBy) {
    columns.push(order.column)
  }

  return Object.freeze(columns)
}

function createQueryOrderMultipliers(
  orderBy: readonly DatabaseQueryOrderObservation[],
): readonly number[] {
  if (orderBy.length === 0) {
    return EMPTY_ORDER_MULTIPLIERS
  }

  const multipliers: number[] = []
  for (const order of orderBy) {
    multipliers.push(order.direction === 'asc' ? 1 : -1)
  }

  return Object.freeze(multipliers)
}

function createQueryPredicateColumns(
  predicates: readonly DatabaseQueryPredicateObservation[],
): readonly string[] {
  if (predicates.length === 0) {
    return EMPTY_PREDICATE_COLUMNS
  }

  const columns: string[] = []
  for (const predicate of predicates) {
    columns.push(predicate.column)
  }

  return Object.freeze(columns)
}

function createQuerySelectionColumns(
  selections: readonly DatabaseQuerySelectionObservation[] | undefined,
): readonly string[] {
  if (!selections || selections.length === 0) {
    return EMPTY_SELECTION_COLUMNS
  }

  const columns: string[] = []
  for (const selection of selections) {
    columns.push(selection.column)
  }

  return Object.freeze(columns)
}

function createQuerySelectionResultKeys(
  selections: readonly DatabaseQuerySelectionObservation[] | undefined,
): readonly string[] {
  if (!selections || selections.length === 0) {
    return EMPTY_SELECTION_RESULT_KEYS
  }

  const keys: string[] = []
  for (const selection of selections) {
    keys.push(selection.resultKey)
  }

  return Object.freeze(keys)
}

function createQueryProjectedIdentityColumn(
  selections: readonly DatabaseQuerySelectionObservation[] | undefined,
): string | typeof NO_PROJECTED_IDENTITY_COLUMN {
  if (!selections || selections.length === 0) {
    return 'id'
  }

  for (const selection of selections) {
    if (selection.resultKey === 'id') {
      return selection.column
    }
  }

  return NO_PROJECTED_IDENTITY_COLUMN
}
