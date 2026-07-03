import { TableQueryBuilder } from '@holo-js/db'
import type { DatabaseMutationEvent } from './dependencies'
import {
  matchesGroupedCountHaving,
  readMatchingGroupedAggregateValue,
  sortGroupedAggregateRows,
} from './query-grouped-aggregate-common'
import { getBackfillDatabaseConnection } from './query-backfill'
import {
  UNCHANGED_QUERY_RESULT,
  UNPATCHED_RESULT,
} from './query-patch-results'
import type {
  BackfillCache,
  DatabaseQueryGroupedAggregateStateObservation,
  DatabaseQueryGroupedAggregateObservation,
  DatabaseQueryObservation,
  GroupedAggregateValueBackfillResult,
  GroupedAggregateValueCountBackfillResult,
  PatchQueryResult,
} from './query-state'
import { stableStringify } from './stable-stringify'

const GROUPED_AGGREGATE_VALUE_KEY = '__holo_grouped_aggregate_value'
const GROUPED_AGGREGATE_ROW_COUNT_KEY = '__holo_grouped_aggregate_row_count'
const GROUPED_AGGREGATE_VALUE_COUNT_KEY = '__holo_grouped_aggregate_value_count'

type GroupedAggregateValueCountGroup = {
  readonly groupValue: unknown
  readonly valueCounts: GroupedAggregateValueCountBackfillResult[]
}

type NumericGroupedAggregateBackfillEntry = {
  readonly groupValue: unknown
  readonly rowCount: number
  readonly value: number
}

export async function backfillGroupedAggregateRows(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  mutations: readonly DatabaseMutationEvent[],
  backfills: BackfillCache,
): Promise<PatchQueryResult> {
  const groupValues = collectAffectedGroupValues(query, groupedAggregate, mutations)
  if (!groupValues || groupValues.length === 0) {
    return groupValues ? UNCHANGED_QUERY_RESULT : UNPATCHED_RESULT
  }

  const backfilledValues = await readGroupedAggregateValues(query, groupedAggregate, groupValues, backfills)
  if (!backfilledValues) {
    return UNPATCHED_RESULT
  }

  const nextRows = mergeBackfilledGroupedAggregateRows(query, groupedAggregate, rows, groupValues, backfilledValues)
  if (!nextRows) {
    return UNPATCHED_RESULT
  }

  const nextQuery = await createBackfilledGroupedAggregateQuery(query, groupedAggregate, groupValues, backfilledValues, backfills)

  return nextRows === rows
    ? nextQuery
        ? Object.freeze({
            nextQuery,
            patched: true,
            unchanged: true,
          })
        : UNCHANGED_QUERY_RESULT
    : Object.freeze({
        ...(nextQuery ? { nextQuery } : {}),
        patched: true,
        query,
        value: nextRows,
      })
}

function collectAffectedGroupValues(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  mutations: readonly DatabaseMutationEvent[],
): readonly unknown[] | undefined {
  const values: unknown[] = []
  for (const mutation of mutations) {
    if (mutation.kind === 'insert') {
      if (!mutation.rows || !appendRowsGroupValues(values, query, groupedAggregate, mutation.rows)) {
        return undefined
      }
      continue
    }

    if (mutation.kind === 'delete') {
      if (!mutation.rows || !appendRowsGroupValues(values, query, groupedAggregate, mutation.rows)) {
        return undefined
      }
      continue
    }

    if (!mutation.rows || !mutation.previousRows || mutation.rows.length !== mutation.previousRows.length) {
      return undefined
    }

    if (
      !appendRowsGroupValues(values, query, groupedAggregate, mutation.previousRows)
      || !appendRowsGroupValues(values, query, groupedAggregate, mutation.rows)
    ) {
      return undefined
    }
  }

  return Object.freeze(values)
}

function appendRowsGroupValues(
  values: unknown[],
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
): boolean {
  for (const row of rows) {
    const groupValue = readMatchingGroupedAggregateValue(query, groupedAggregate, row)
    if (groupValue.matched === 'unknown') {
      return false
    }

    if (groupValue.matched) {
      appendGroupValue(values, groupValue.value)
    }
  }

  return true
}

function appendGroupValue(values: unknown[], value: unknown): void {
  if (!values.some(candidate => Object.is(candidate, value))) {
    values.push(value)
  }
}

async function readGroupedAggregateValues(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  values: readonly unknown[],
  backfills: BackfillCache,
): Promise<ReadonlyMap<unknown, GroupedAggregateValueBackfillResult> | undefined> {
  const cache = backfills.groupedAggregateValues
  const backfillKey = createGroupedAggregateValueBackfillKey(query, groupedAggregate, values)
  if (!cache) {
    return await fetchGroupedAggregateValues(query, groupedAggregate, values)
  }

  const pendingBackfill = cache.get(backfillKey) ?? fetchGroupedAggregateValues(query, groupedAggregate, values)
  cache.set(backfillKey, pendingBackfill)
  return await pendingBackfill
}

function createGroupedAggregateValueBackfillKey(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  values: readonly unknown[],
): string {
  return '{"aggregateColumn":'
    + stableStringify(groupedAggregate.aggregateColumn)
    + ',"connectionName":'
    + stableStringify(query.connectionName)
    + ',"groupColumn":'
    + stableStringify(groupedAggregate.groupColumn)
    + ',"having":'
    + stableStringify(groupedAggregate.having)
    + ',"kind":'
    + stableStringify(groupedAggregate.kind)
    + ',"predicates":'
    + stableStringify(query.predicates)
    + ',"tableName":'
    + stableStringify(query.tableName)
    + ',"values":'
    + stableStringify(values)
    + '}'
}

async function fetchGroupedAggregateValues(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  values: readonly unknown[],
): Promise<ReadonlyMap<unknown, GroupedAggregateValueBackfillResult> | undefined> {
  const column = groupedAggregate.aggregateColumn
  const connection = getBackfillDatabaseConnection(query.connectionName)
  if (!connection || values.length === 0) {
    return undefined
  }

  let builder = new TableQueryBuilder<string, Record<string, unknown>>(query.tableName, connection)
  for (const predicate of query.predicates) {
    builder = builder.where(predicate.column, predicate.operator, predicate.value)
  }

  let aggregateBuilder = builder
    .where(groupedAggregate.groupColumn, 'in', values)
    .select(groupedAggregate.groupColumn)
  if (groupedAggregate.kind === 'count') {
    aggregateBuilder = aggregateBuilder.addSelectCount(GROUPED_AGGREGATE_VALUE_KEY)
  } else if (groupedAggregate.kind === 'avg') {
    if (!column) {
      return undefined
    }
    aggregateBuilder = aggregateBuilder.addSelectAvg(GROUPED_AGGREGATE_VALUE_KEY, column)
  } else if (groupedAggregate.kind === 'sum') {
    if (!column) {
      return undefined
    }
    aggregateBuilder = aggregateBuilder.addSelectSum(GROUPED_AGGREGATE_VALUE_KEY, column)
  } else if (groupedAggregate.kind === 'min') {
    if (!column) {
      return undefined
    }
    aggregateBuilder = aggregateBuilder.addSelectMin(GROUPED_AGGREGATE_VALUE_KEY, column)
  } else {
    if (!column) {
      return undefined
    }
    aggregateBuilder = aggregateBuilder.addSelectMax(GROUPED_AGGREGATE_VALUE_KEY, column)
  }
  const having = groupedAggregate.having
  if (having) {
    aggregateBuilder = aggregateBuilder.having('count(*)', having.operator, having.value)
  }

  const rows = await aggregateBuilder
    .addSelectCount(GROUPED_AGGREGATE_ROW_COUNT_KEY)
    .groupBy(groupedAggregate.groupColumn)
    .get<Record<string, unknown>>()
  const results = new Map<unknown, GroupedAggregateValueBackfillResult>()
  for (const row of rows) {
    const groupValue = row[groupedAggregate.groupColumn]
    const value = normalizeAggregateValue(row[GROUPED_AGGREGATE_VALUE_KEY])
    const rowCount = normalizeAggregateMetadataNumber(row[GROUPED_AGGREGATE_ROW_COUNT_KEY])
    if (typeof value === 'undefined') {
      return undefined
    }

    if (typeof rowCount === 'number' && rowCount < 0) {
      return undefined
    }

    results.set(groupValue, Object.freeze({
      ...(typeof rowCount === 'number' ? { rowCount } : {}),
      value,
    }))
  }

  return results
}

async function createBackfilledGroupedAggregateQuery(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  groupValues: readonly unknown[],
  backfilledValues: ReadonlyMap<unknown, GroupedAggregateValueBackfillResult>,
  backfills: BackfillCache,
): Promise<DatabaseQueryObservation | undefined> {
  if (
    groupedAggregate.kind !== 'min'
    && groupedAggregate.kind !== 'max'
  ) {
    return undefined
  }

  const stateEntries = collectNumericGroupedAggregateBackfillEntries(backfilledValues)
  if (!stateEntries) {
    return undefined
  }

  if (stateEntries.length === 0) {
    return Object.freeze({
      ...query,
      groupedAggregate: Object.freeze({
        ...groupedAggregate,
        aggregateStates: Object.freeze([...(groupedAggregate.aggregateStates ?? [])]
          .filter(state => !groupValues.some(groupValue => Object.is(groupValue, state.groupValue)))),
      }),
    })
  }

  const valueCounts = await readGroupedAggregateValueCounts(query, groupedAggregate, groupValues, backfills)
  if (!valueCounts) {
    return undefined
  }

  const aggregateStates = createBackfilledGroupedAggregateStates(groupedAggregate, groupValues, stateEntries, valueCounts)
  if (!aggregateStates) {
    return undefined
  }

  return Object.freeze({
    ...query,
    groupedAggregate: Object.freeze({
      ...groupedAggregate,
      aggregateStates,
    }),
  })
}

function collectNumericGroupedAggregateBackfillEntries(
  backfilledValues: ReadonlyMap<unknown, GroupedAggregateValueBackfillResult>,
): readonly NumericGroupedAggregateBackfillEntry[] | undefined {
  const entries: NumericGroupedAggregateBackfillEntry[] = []
  for (const [groupValue, backfilledValue] of backfilledValues) {
    if (backfilledValue.value === null || typeof backfilledValue.rowCount !== 'number') {
      return undefined
    }

    entries.push(Object.freeze({
      groupValue,
      rowCount: backfilledValue.rowCount,
      value: backfilledValue.value,
    }))
  }

  return Object.freeze(entries)
}

async function readGroupedAggregateValueCounts(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  values: readonly unknown[],
  backfills: BackfillCache,
): Promise<ReadonlyMap<unknown, readonly GroupedAggregateValueCountBackfillResult[]> | undefined> {
  const cache = backfills.groupedAggregateValueCounts
  const backfillKey = createGroupedAggregateValueCountBackfillKey(query, groupedAggregate, values)
  if (!cache) {
    return await fetchGroupedAggregateValueCounts(query, groupedAggregate, values)
  }

  const pendingBackfill = cache.get(backfillKey) ?? fetchGroupedAggregateValueCounts(query, groupedAggregate, values)
  cache.set(backfillKey, pendingBackfill)
  return await pendingBackfill
}

function createGroupedAggregateValueCountBackfillKey(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  values: readonly unknown[],
): string {
  return '{"aggregateColumnValueCounts":'
    + stableStringify(groupedAggregate.aggregateColumn)
    + ',"connectionName":'
    + stableStringify(query.connectionName)
    + ',"groupColumn":'
    + stableStringify(groupedAggregate.groupColumn)
    + ',"kind":'
    + stableStringify(groupedAggregate.kind)
    + ',"predicates":'
    + stableStringify(query.predicates)
    + ',"tableName":'
    + stableStringify(query.tableName)
    + ',"values":'
    + stableStringify(values)
    + '}'
}

async function fetchGroupedAggregateValueCounts(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  values: readonly unknown[],
): Promise<ReadonlyMap<unknown, readonly GroupedAggregateValueCountBackfillResult[]> | undefined> {
  const column = groupedAggregate.aggregateColumn
  const connection = getBackfillDatabaseConnection(query.connectionName)
  if (!column || !connection || values.length === 0) {
    return undefined
  }

  let builder = new TableQueryBuilder<string, Record<string, unknown>>(query.tableName, connection)
  for (const predicate of query.predicates) {
    builder = builder.where(predicate.column, predicate.operator, predicate.value)
  }

  const rows = await builder
    .where(groupedAggregate.groupColumn, 'in', values)
    .select(groupedAggregate.groupColumn, column)
    .addSelectCount(GROUPED_AGGREGATE_VALUE_COUNT_KEY)
    .groupBy(groupedAggregate.groupColumn)
    .groupBy(column)
    .get<Record<string, unknown>>()

  const groups: GroupedAggregateValueCountGroup[] = []
  for (const row of rows) {
    const value = normalizeExtremeAggregateValue(row[column])
    if (typeof value === 'undefined') {
      continue
    }

    const count = normalizeAggregateMetadataNumber(row[GROUPED_AGGREGATE_VALUE_COUNT_KEY])
    if (typeof count === 'undefined' || count <= 0) {
      return undefined
    }

    pushGroupedAggregateValueCount(groups, row[groupedAggregate.groupColumn], Object.freeze({ count, value }))
  }

  const results = new Map<unknown, readonly GroupedAggregateValueCountBackfillResult[]>()
  for (const group of groups) {
    results.set(group.groupValue, Object.freeze([...group.valueCounts].sort((left, right) => left.value - right.value)))
  }

  return results
}

function normalizeExtremeAggregateValue(value: unknown): number | undefined {
  if (value === null) {
    return undefined
  }

  return normalizeAggregateMetadataNumber(value)
}

function normalizeAggregateMetadataNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }

  if (typeof value === 'bigint') {
    const numericValue = Number(value)
    return Number.isSafeInteger(numericValue) ? numericValue : undefined
  }

  if (typeof value === 'string' && value.trim()) {
    const numericValue = Number(value)
    return Number.isFinite(numericValue) ? numericValue : undefined
  }

  return undefined
}

function pushGroupedAggregateValueCount(
  groups: GroupedAggregateValueCountGroup[],
  groupValue: unknown,
  valueCount: GroupedAggregateValueCountBackfillResult,
): void {
  const group = groups.find(candidate => Object.is(candidate.groupValue, groupValue))
  if (group) {
    group.valueCounts.push(valueCount)
    return
  }

  groups.push({
    groupValue,
    valueCounts: [valueCount],
  })
}

function createBackfilledGroupedAggregateStates(
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  groupValues: readonly unknown[],
  stateEntries: readonly NumericGroupedAggregateBackfillEntry[],
  valueCounts: ReadonlyMap<unknown, readonly GroupedAggregateValueCountBackfillResult[]>,
): readonly DatabaseQueryGroupedAggregateStateObservation[] | undefined {
  const states = [...(groupedAggregate.aggregateStates ?? [])]
    .filter(state => !groupValues.some(groupValue => Object.is(groupValue, state.groupValue)))

  for (const stateEntry of stateEntries) {
    const groupValueCounts = valueCounts.get(stateEntry.groupValue)
    if (!groupValueCounts || groupValueCounts.length === 0) {
      return undefined
    }

    states.push(Object.freeze({
      aggregateValue: stateEntry.value,
      groupValue: stateEntry.groupValue,
      rowCount: stateEntry.rowCount,
      valueCounts: groupValueCounts,
    }))
  }

  return Object.freeze(states)
}

function normalizeAggregateValue(value: unknown): number | null | undefined {
  if (value === null) {
    return null
  }

  const numericValue = normalizeAggregateMetadataNumber(value)
  if (typeof numericValue === 'number') {
    return numericValue
  }

  return undefined
}

function mergeBackfilledGroupedAggregateRows(
  query: DatabaseQueryObservation,
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  groupValues: readonly unknown[],
  backfilledValues: ReadonlyMap<unknown, GroupedAggregateValueBackfillResult>,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  const nextRows: Readonly<Record<string, unknown>>[] = []
  for (const row of rows) {
    const groupValue = row[groupedAggregate.groupResultKey]
    if (!groupValues.some(value => Object.is(value, groupValue))) {
      nextRows.push(row)
      continue
    }

    if (!backfilledValues.has(groupValue)) {
      continue
    }

    const backfilledValue = backfilledValues.get(groupValue)!.value
    if (!shouldKeepBackfilledGroupedAggregateValue(groupedAggregate, backfilledValue)) {
      continue
    }

    nextRows.push(Object.freeze({
      ...row,
      [groupedAggregate.aggregateResultKey]: backfilledValue,
    }))
  }

  for (const [groupValue, backfilledValue] of backfilledValues) {
    if (!shouldKeepBackfilledGroupedAggregateValue(groupedAggregate, backfilledValue.value)) {
      continue
    }

    if (nextRows.some(row => Object.is(row[groupedAggregate.groupResultKey], groupValue))) {
      continue
    }

    nextRows.push(Object.freeze({
      [groupedAggregate.groupResultKey]: groupValue,
      [groupedAggregate.aggregateResultKey]: backfilledValue.value,
    }))
  }

  const sortedRows = sortGroupedAggregateRows(query, groupedAggregate, nextRows)
  if (!sortedRows) {
    return undefined
  }

  return rowsEqual(rows, sortedRows) ? rows : sortedRows
}

function shouldKeepBackfilledGroupedAggregateValue(
  groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  value: number | null,
): boolean {
  return groupedAggregate.kind !== 'count'
    || (value !== null && matchesGroupedCountHaving(groupedAggregate, value))
}

function rowsEqual(
  left: readonly Readonly<Record<string, unknown>>[],
  right: readonly Readonly<Record<string, unknown>>[],
): boolean {
  if (left.length !== right.length) {
    return false
  }

  return left.every((row, index) => {
    const rightRow = right[index]!
    return row === rightRow || recordsEqual(row, rightRow)
  })
}

function recordsEqual(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.is(left[key], right[key]))
}
