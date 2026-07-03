import { TableQueryBuilder, type DatabaseContext } from '@holo-js/db'
import { getBackfillDatabaseConnection } from './query-backfill'
import {
  createAggregateBackfillKey,
  createAggregateSqlBackfillKey,
} from './query-metadata'
import {
  UNCHANGED_QUERY_RESULT,
  UNPATCHED_RESULT,
} from './query-patch-results'
import {
  EMPTY_AGGREGATE_COLUMNS,
  type AggregateBackfillResult,
  type AggregateExtremeBackfillKinds,
  type AggregateSqlBackfillResult,
  type AggregateSqlColumnBackfillResult,
  type BackfillCache,
  type DatabaseQueryAggregateObservation,
  type DatabaseQueryAggregateValueCountObservation,
  type DatabaseQueryObservation,
  type PatchQueryResult,
} from './query-state'
import {
  addGroupedAggregateValue,
  collectGroupedAggregateColumns,
  collectGroupedAggregateQueries,
  createGroupedAggregateBackfillKey,
  getAggregateBackfillColumns,
  getAggregateExtremeKinds,
  readAggregateGroupPredicate,
} from './query-aggregate-backfill-groups'
import {
  type AggregateBackfillEntry,
  createCountAggregateObservation,
  formatCountAggregateValue,
} from './query-aggregate-common'
import {
  normalizeSqlAggregateCount,
  readAggregateSqlBackfillRow,
} from './query-aggregate-sql-results'

const AGGREGATE_VALUE_COUNT_ALIAS = '__holo_value_count'
const EMPTY_AGGREGATE_VALUE_COUNTS = Object.freeze([])

type AggregateExtremeValueWindow = {
  readonly currentValueCount: number
  readonly valueCounts: readonly DatabaseQueryAggregateValueCountObservation[]
}

function createAggregateBackfillBuilder(query: DatabaseQueryObservation): TableQueryBuilder<string, Record<string, unknown>> | undefined {
  const connection = getBackfillDatabaseConnection(query.connectionName)
  if (!connection) {
    return undefined
  }

  let builder = new TableQueryBuilder<string, Record<string, unknown>>(query.tableName, connection)
  for (const predicate of query.predicates) {
    builder = builder.where(predicate.column, predicate.operator, predicate.value)
  }

  return builder
}

async function fetchAggregateSqlBackfill(
  query: DatabaseQueryObservation,
  columns: readonly string[],
  extremeKinds: ReadonlyMap<string, AggregateExtremeBackfillKinds>,
): Promise<AggregateSqlBackfillResult | undefined> {
  const builder = createAggregateBackfillBuilder(query)
  if (!builder) {
    return undefined
  }

  let aggregateBuilder = builder.selectCount('__holo_count')
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index]!
    aggregateBuilder = aggregateBuilder
      .addSelectSum(`__holo_sum_${index}`, column)
      .addSelectAvg(`__holo_avg_${index}`, column)
      .addSelectMin(`__holo_min_${index}`, column)
      .addSelectMax(`__holo_max_${index}`, column)
  }

  const rows = await aggregateBuilder
    .get<Record<string, unknown>>()
  const row = rows[0]
  const result = row ? readAggregateSqlBackfillRow(row, columns) : undefined
  return result ? await attachAggregateSqlExtremeValueCounts(builder, result, extremeKinds) : undefined
}

async function fetchGroupedAggregateSqlBackfill(
  query: DatabaseQueryObservation,
  groupColumn: string,
  values: readonly unknown[],
  columns: readonly string[],
  extremeKinds: ReadonlyMap<string, AggregateExtremeBackfillKinds>,
): Promise<ReadonlyMap<unknown, AggregateSqlBackfillResult> | undefined> {
  const connection = getBackfillDatabaseConnection(query.connectionName)
  if (!connection || values.length === 0) {
    return undefined
  }

  let aggregateBuilder = new TableQueryBuilder<string, Record<string, unknown>>(query.tableName, connection)
    .where(groupColumn, 'in', values)
    .select(groupColumn)
    .addSelectCount('__holo_count')
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index]!
    aggregateBuilder = aggregateBuilder
      .addSelectSum(`__holo_sum_${index}`, column)
      .addSelectAvg(`__holo_avg_${index}`, column)
      .addSelectMin(`__holo_min_${index}`, column)
      .addSelectMax(`__holo_max_${index}`, column)
  }

  const rows = await aggregateBuilder
    .groupBy(groupColumn)
    .get<Record<string, unknown>>()
  const results = new Map<unknown, AggregateSqlBackfillResult>()
  for (const row of rows) {
    const value = row[groupColumn]
    const result = readAggregateSqlBackfillRow(row, columns)
    if (!result) {
      return undefined
    }

    results.set(value, result)
  }

  return await attachGroupedAggregateSqlExtremeValueCounts(query, connection, groupColumn, values, results, extremeKinds)
}

async function readAggregateSqlExtremeValueCount(
  builder: TableQueryBuilder<string, Record<string, unknown>>,
  column: string,
  value: number | null,
): Promise<number> {
  if (typeof value !== 'number') {
    return 0
  }

  return await builder.where(column, value).count()
}

function createAggregateValueCounts(
  values: readonly DatabaseQueryAggregateValueCountObservation[],
): readonly DatabaseQueryAggregateValueCountObservation[] {
  return Object.freeze([...values]
    .sort((left, right) => left.value - right.value)
    .map(valueCount => Object.freeze(valueCount)))
}

function mergeAggregateValueCounts(
  values: readonly DatabaseQueryAggregateValueCountObservation[],
  nextValues: readonly DatabaseQueryAggregateValueCountObservation[] | undefined,
): readonly DatabaseQueryAggregateValueCountObservation[] {
  if (!nextValues) {
    return values
  }

  const counts = new Map<number, number>()
  for (const valueCount of [...values, ...nextValues]) {
    counts.set(valueCount.value, Math.max(counts.get(valueCount.value) ?? 0, valueCount.count))
  }

  return createAggregateValueCounts([...counts.entries()].map(([value, count]) => ({ count, value })))
}

async function readAggregateSqlExtremeValueWindow(
  builder: TableQueryBuilder<string, Record<string, unknown>>,
  column: string,
  kind: 'max' | 'min',
  value: number | null,
): Promise<AggregateExtremeValueWindow | undefined> {
  if (typeof value !== 'number') {
    return undefined
  }

  const rows = await builder
    .where(column, kind === 'min' ? '>=' : '<=', value)
    .select(column)
    .addSelectCount(AGGREGATE_VALUE_COUNT_ALIAS)
    .groupBy(column)
    .orderBy(column, kind === 'min' ? 'asc' : 'desc')
    .limit(2)
    .get<Record<string, unknown>>()
  const valueCounts: DatabaseQueryAggregateValueCountObservation[] = []
  for (const row of rows) {
    const rowValue = row[column]
    const count = normalizeSqlAggregateCount(row[AGGREGATE_VALUE_COUNT_ALIAS])
    if (typeof rowValue !== 'number' || Number.isNaN(rowValue) || typeof count === 'undefined') {
      return undefined
    }

    valueCounts.push({ count, value: rowValue })
  }

  const currentValueCount = valueCounts.find(valueCount => valueCount.value === value)?.count
  return typeof currentValueCount === 'number'
    ? Object.freeze({
        currentValueCount,
        valueCounts: createAggregateValueCounts(valueCounts),
      })
    : undefined
}

async function attachAggregateSqlExtremeValueCounts(
  builder: TableQueryBuilder<string, Record<string, unknown>>,
  result: AggregateSqlBackfillResult,
  extremeKinds: ReadonlyMap<string, AggregateExtremeBackfillKinds>,
): Promise<AggregateSqlBackfillResult | undefined> {
  if (extremeKinds.size === 0) {
    return result
  }

  const columns = new Map<string, AggregateSqlColumnBackfillResult>()
  for (const [column, columnResult] of result.columns) {
    const kinds = extremeKinds.get(column)
    if (!kinds) {
      columns.set(column, columnResult)
      continue
    }

    const minValueWindow = kinds.min
      ? await readAggregateSqlExtremeValueWindow(builder, column, 'min', columnResult.min)
      : undefined
    const minValueCount = kinds.min
      ? minValueWindow?.currentValueCount
        ?? await readAggregateSqlExtremeValueCount(builder, column, columnResult.min)
      : undefined
    const minValueCounts = minValueWindow?.valueCounts
    const maxValueWindow = kinds.max
      ? columnResult.max === columnResult.min && kinds.min
        ? minValueWindow
        : await readAggregateSqlExtremeValueWindow(builder, column, 'max', columnResult.max)
      : undefined
    const maxValueCount = kinds.max
      ? columnResult.max === columnResult.min && typeof minValueCount === 'number'
        ? minValueCount
        : maxValueWindow?.currentValueCount
          ?? await readAggregateSqlExtremeValueCount(builder, column, columnResult.max)
      : undefined
    const maxValueCounts = maxValueWindow?.valueCounts
    const valueCounts = mergeAggregateValueCounts(minValueCounts ?? EMPTY_AGGREGATE_VALUE_COUNTS, maxValueCounts)
    columns.set(column, Object.freeze({
      ...columnResult,
      ...(typeof maxValueCount === 'number' ? { maxValueCount } : {}),
      ...(typeof minValueCount === 'number' ? { minValueCount } : {}),
      ...(valueCounts.length > 0 ? { valueCounts } : {}),
    }))
  }

  return Object.freeze({
    columns,
    count: result.count,
  })
}

async function attachGroupedAggregateSqlExtremeValueCounts(
  query: DatabaseQueryObservation,
  connection: DatabaseContext,
  groupColumn: string,
  values: readonly unknown[],
  results: ReadonlyMap<unknown, AggregateSqlBackfillResult>,
  extremeKinds: ReadonlyMap<string, AggregateExtremeBackfillKinds>,
): Promise<ReadonlyMap<unknown, AggregateSqlBackfillResult> | undefined> {
  if (extremeKinds.size === 0 || results.size === 0) {
    return results
  }

  const nextResults = new Map<unknown, {
    readonly columns: Map<string, AggregateSqlColumnBackfillResult>
    readonly count: number
  }>()
  for (const [value, result] of results) {
    nextResults.set(value, Object.freeze({
      columns: new Map(result.columns),
      count: result.count,
    }))
  }

  for (const [column, kinds] of extremeKinds) {
    const extremeValues: unknown[] = []
    const columnResults = new Map<unknown, {
      readonly columnResult: AggregateSqlColumnBackfillResult
      readonly result: {
        readonly columns: Map<string, AggregateSqlColumnBackfillResult>
        readonly count: number
      }
    }>()
    for (const [groupValue, result] of nextResults) {
      const columnResult = result.columns.get(column)
      if (!columnResult) {
        continue
      }

      columnResults.set(groupValue, Object.freeze({ columnResult, result }))
      if (kinds.min && typeof columnResult.min === 'number') {
        addGroupedAggregateValue(extremeValues, columnResult.min)
      }
      if (kinds.max && typeof columnResult.max === 'number') {
        addGroupedAggregateValue(extremeValues, columnResult.max)
      }
    }

    if (extremeValues.length === 0) {
      continue
    }

    const rows = await new TableQueryBuilder<string, Record<string, unknown>>(query.tableName, connection)
      .where(groupColumn, 'in', values)
      .where(column, 'in', extremeValues)
      .select(groupColumn)
      .addSelect(column)
      .addSelectCount('__holo_count')
      .groupBy(groupColumn, column)
      .get<Record<string, unknown>>()
    const counts = new Map<unknown, Map<unknown, number>>()
    for (const row of rows) {
      const groupValue = row[groupColumn]
      const columnValue = row[column]
      const count = normalizeSqlAggregateCount(row.__holo_count)
      if (typeof count === 'undefined') {
        return undefined
      }

      const groupCounts = counts.get(groupValue) ?? new Map<unknown, number>()
      groupCounts.set(columnValue, count)
      counts.set(groupValue, groupCounts)
    }

    for (const [groupValue, { columnResult, result }] of columnResults) {
      const minValueCount = kinds.min
        ? typeof columnResult.min === 'number'
          ? counts.get(groupValue)?.get(columnResult.min)
          : 0
        : undefined
      const maxValueCount = kinds.max
        ? typeof columnResult.max === 'number'
          ? counts.get(groupValue)?.get(columnResult.max)
          : 0
        : undefined
      if (
        (kinds.min && typeof minValueCount === 'undefined')
        || (kinds.max && typeof maxValueCount === 'undefined')
      ) {
        return undefined
      }

      result.columns.set(column, Object.freeze({
        ...columnResult,
        ...(typeof maxValueCount === 'number' ? { maxValueCount } : {}),
        ...(typeof minValueCount === 'number' ? { minValueCount } : {}),
      }))
    }
  }

  return new Map([...nextResults].map(([value, result]) => [
    value,
    Object.freeze({
      columns: result.columns,
      count: result.count,
    }),
  ]))
}

async function getGroupedAggregateSqlBackfill(
  query: DatabaseQueryObservation,
  columns: readonly string[],
  backfills: BackfillCache<AggregateBackfillEntry>,
): Promise<AggregateSqlBackfillResult | undefined> {
  const groupPredicate = readAggregateGroupPredicate(query)
  const groupedCache = backfills.aggregateGroupedSql
  if (!groupPredicate || !groupedCache) {
    return undefined
  }

  const { queries, values } = collectGroupedAggregateQueries(query, backfills)
  if (values.length < 2) {
    return undefined
  }

  const groupedColumns = collectGroupedAggregateColumns(queries, columns)
  const backfillKey = createGroupedAggregateBackfillKey(query, groupPredicate.column, values, groupedColumns)
  const extremeKinds = getAggregateExtremeKinds(query, backfills)
  const pendingBackfill = groupedCache.get(backfillKey)
    ?? fetchGroupedAggregateSqlBackfill(query, groupPredicate.column, values, groupedColumns, extremeKinds)
  groupedCache.set(backfillKey, pendingBackfill)
  const results = await pendingBackfill
  return results?.get(groupPredicate.value)
}

async function getAggregateSqlBackfill(
  query: DatabaseQueryObservation,
  columns: readonly string[],
  backfills: BackfillCache<AggregateBackfillEntry>,
): Promise<AggregateSqlBackfillResult | undefined> {
  const backfillKey = createAggregateSqlBackfillKey(query, columns)
  const extremeKinds = getAggregateExtremeKinds(query, backfills)
  const pendingBackfill = backfills.aggregateSql.get(backfillKey) ?? fetchAggregateSqlBackfill(query, columns, extremeKinds)
  backfills.aggregateSql.set(backfillKey, pendingBackfill)
  return await pendingBackfill
}

function createAggregateBackfillResult(
  aggregate: DatabaseQueryAggregateObservation,
  result: AggregateSqlBackfillResult,
): AggregateBackfillResult | undefined {
  if (aggregate.kind === 'count') {
    return Object.freeze({
      nextAggregate: createCountAggregateObservation(aggregate, result.count),
      value: formatCountAggregateValue(result.count, aggregate),
    })
  }

  const column = aggregate.column
  if (!column) {
    return undefined
  }

  const columnResult = result.columns.get(column)
  if (!columnResult) {
    return undefined
  }

  if (aggregate.kind === 'sum') {
    return Object.freeze({
      nextAggregate: Object.freeze({ column, kind: 'sum' }),
      value: columnResult.sum,
    })
  }

  if (aggregate.kind === 'avg') {
    return Object.freeze({
      nextAggregate: Object.freeze({
        column,
        count: result.count,
        kind: 'avg',
        sum: columnResult.sum,
      }),
      value: columnResult.avg,
    })
  }

  if (aggregate.kind === 'min') {
    return Object.freeze({
      nextAggregate: Object.freeze({
        column,
        ...(typeof columnResult.minValueCount === 'number'
          ? { currentValueCount: columnResult.minValueCount }
          : {}),
        ...(columnResult.valueCounts ? {
          valueCounts: columnResult.valueCounts,
          valueCountsComplete: false,
        } : {}),
        kind: 'min',
      }),
      value: columnResult.min,
    })
  }

  if (aggregate.kind === 'max') {
    return Object.freeze({
      nextAggregate: Object.freeze({
        column,
        ...(typeof columnResult.maxValueCount === 'number'
          ? { currentValueCount: columnResult.maxValueCount }
          : {}),
        ...(columnResult.valueCounts ? {
          valueCounts: columnResult.valueCounts,
          valueCountsComplete: false,
        } : {}),
        kind: 'max',
      }),
      value: columnResult.max,
    })
  }

  return undefined
}

async function fetchAggregateBackfillResult(
  query: DatabaseQueryObservation,
  aggregate: DatabaseQueryAggregateObservation,
  backfills: BackfillCache<AggregateBackfillEntry>,
): Promise<AggregateBackfillResult | undefined> {
  const columns = getAggregateBackfillColumns(query, backfills)
  if (columns.length > 0) {
    const result = await getGroupedAggregateSqlBackfill(query, columns, backfills)
      ?? await getAggregateSqlBackfill(query, columns, backfills)
    return result ? createAggregateBackfillResult(aggregate, result) : undefined
  }

  if (aggregate.kind === 'count') {
    const result = await getGroupedAggregateSqlBackfill(query, EMPTY_AGGREGATE_COLUMNS, backfills)
    if (result) {
      return createAggregateBackfillResult(aggregate, result)
    }
  }

  const builder = createAggregateBackfillBuilder(query)
  return builder && aggregate.kind === 'count'
    ? backfillCountAggregate(builder, aggregate)
    : undefined
}

async function backfillCountAggregate(
  builder: TableQueryBuilder<string, Record<string, unknown>>,
  aggregate: DatabaseQueryAggregateObservation,
): Promise<AggregateBackfillResult> {
  const count = await builder.count()
  return Object.freeze({
    nextAggregate: createCountAggregateObservation(aggregate, count),
    value: formatCountAggregateValue(count, aggregate),
  })
}

export async function backfillAggregate(
  query: DatabaseQueryObservation,
  backfills: BackfillCache<AggregateBackfillEntry>,
  currentValue?: unknown,
): Promise<PatchQueryResult> {
  const aggregate = query.aggregate
  if (!aggregate) {
    return UNPATCHED_RESULT
  }

  const backfillKey = createAggregateBackfillKey(query)
  const pendingBackfill = backfills.aggregates.get(backfillKey) ?? fetchAggregateBackfillResult(query, aggregate, backfills)
  backfills.aggregates.set(backfillKey, pendingBackfill)

  const result = await pendingBackfill
  if (result && Object.is(result.value, currentValue)) {
    return result.nextAggregate
      ? Object.freeze({
          nextQuery: Object.freeze({
            ...query,
            aggregate: result.nextAggregate,
          }),
          patched: true,
          unchanged: true,
        })
      : UNCHANGED_QUERY_RESULT
  }

  return typeof result === 'undefined'
    ? UNPATCHED_RESULT
    : Object.freeze({
        nextQuery: result.nextAggregate
          ? Object.freeze({
              ...query,
              aggregate: result.nextAggregate,
            })
          : undefined,
        patched: true,
        query,
        value: result.value,
      })
}
