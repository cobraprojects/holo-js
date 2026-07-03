import type {
  AggregateSqlBackfillResult,
  AggregateSqlColumnBackfillResult,
} from './query-state'

function normalizeSqlAggregateNumber(value: unknown): number | null | undefined {
  if (value === null) {
    return null
  }

  if (typeof value === 'number') {
    return Number.isNaN(value) ? undefined : value
  }

  if (typeof value === 'string' && value.trim()) {
    const numericValue = Number(value)
    return Number.isNaN(numericValue) ? undefined : numericValue
  }

  return undefined
}

export function normalizeSqlAggregateCount(value: unknown): number | undefined {
  const numericValue = normalizeSqlAggregateNumber(value)
  return typeof numericValue === 'number' && Number.isInteger(numericValue) && numericValue >= 0 ? numericValue : undefined
}

function readAggregateSqlColumnBackfillRow(
  row: Readonly<Record<string, unknown>>,
  index: number,
): AggregateSqlColumnBackfillResult | undefined {
  const sum = normalizeSqlAggregateNumber(row[`__holo_sum_${index}`])
  const avg = normalizeSqlAggregateNumber(row[`__holo_avg_${index}`])
  const min = normalizeSqlAggregateNumber(row[`__holo_min_${index}`])
  const max = normalizeSqlAggregateNumber(row[`__holo_max_${index}`])
  if (
    typeof sum === 'undefined'
    || typeof avg === 'undefined'
    || typeof min === 'undefined'
    || typeof max === 'undefined'
  ) {
    return undefined
  }

  return Object.freeze({
    avg,
    max,
    min,
    sum: sum ?? 0,
  })
}

export function readAggregateSqlBackfillRow(
  row: Readonly<Record<string, unknown>>,
  columns: readonly string[],
): AggregateSqlBackfillResult | undefined {
  const count = normalizeSqlAggregateCount(row.__holo_count)
  if (typeof count === 'undefined') {
    return undefined
  }

  const aggregateColumns = new Map<string, AggregateSqlColumnBackfillResult>()
  for (let index = 0; index < columns.length; index += 1) {
    const result = readAggregateSqlColumnBackfillRow(row, index)
    if (!result) {
      return undefined
    }

    aggregateColumns.set(columns[index]!, result)
  }

  return Object.freeze({
    columns: aggregateColumns,
    count,
  })
}
