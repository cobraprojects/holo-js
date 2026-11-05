import { SecurityError } from '../core/errors'
import { NumericAdjustment } from './NumericAdjustment'
import { booleanStorageValue, normalizeDialectWriteValue } from '../schema/normalization'
import { formatSQLiteDateTime, parseSQLiteDateTime } from '../sqliteDateTime'
import { formatWallClockSeconds } from '../applicationTime'
import { getApplicationTimezone } from '../applicationTimezone'
import type { AnyColumnDefinition, TableDefinition } from '../schema/types'
import type { SchemaDialectName } from '../schema/typeMapping'
import type { QueryDatePart, QueryJsonUpdateOperation } from './ast'

type JsonPathParser = (value: string) => { readonly column: string, readonly path: readonly string[] }

export function normalizeQueryWriteValue(
  table: TableDefinition | undefined,
  driver: string,
  columnName: string,
  value: unknown,
): unknown {
  if (value instanceof NumericAdjustment) return value
  const column = table?.columns[columnName]
  if (!column) return normalizeDefinitionlessValue(driver, value)
  return normalizeDialectWriteValue(driver as SchemaDialectName, column as AnyColumnDefinition, value)
}

function normalizeDefinitionlessValue(driver: string, value: unknown): unknown {
  if (typeof value === 'boolean') return booleanStorageValue(value)
  return driver === 'sqlite' && value instanceof Date ? formatSQLiteDateTime(value) : value
}

export function normalizeQueryPredicateValue(
  table: TableDefinition | undefined,
  driver: string,
  columnName: string,
  value: unknown,
  operator: unknown = '=',
): unknown {
  if (Array.isArray(value) && typeof operator === 'string' && ['in', 'not in', 'between', 'not between'].includes(operator)) {
    return value.map(item => normalizeQueryWriteValue(table, driver, columnName, item))
  }
  return normalizeQueryWriteValue(table, driver, columnName, value)
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function mapPredicateValue(value: unknown, map: (item: unknown) => unknown): unknown {
  return Array.isArray(value) ? value.map(map) : map(value)
}

const WALL_CLOCK_PARTS = /^(\d{4,})-(\d{2})-(\d{2}) (\d{2}:\d{2}:\d{2})$/

function commonEraWallClockParts(instant: Date, timeZone: string): { year: string, month: string, day: string, time: string } | undefined {
  const match = WALL_CLOCK_PARTS.exec(formatWallClockSeconds(instant, timeZone))
  if (!match || Number(match[1]) < 1) return undefined

  const [, year, month, day, time] = match
  return { year: year!, month: month!, day: day!, time: time! }
}

function calendarDateOf(instant: Date, timeZone: string): string | undefined {
  const parts = commonEraWallClockParts(instant, timeZone)
  return parts && `${parts.year}-${parts.month}-${parts.day}`
}

export function normalizeDateColumnPredicateValue(
  table: TableDefinition | undefined,
  driver: string,
  columnName: string,
  value: unknown,
  operator: unknown,
): { readonly value: unknown, readonly comparesCalendarDates: boolean } {
  const timeZone = getApplicationTimezone()
  const instantOf = (item: unknown): Date | undefined => isValidDate(item)
    ? item
    : driver === 'sqlite' && typeof item === 'string' ? parseSQLiteDateTime(item) : undefined
  const isBeforeCommonEra = (item: unknown): boolean => {
    const instant = instantOf(item)
    return instant !== undefined && calendarDateOf(instant, timeZone) === undefined
  }
  const normalized = normalizeQueryPredicateValue(table, driver, columnName, value, operator)
  if ([value, normalized].flat().some(isBeforeCommonEra)) return { value: normalized, comparesCalendarDates: false }

  const calendarDates = mapPredicateValue(value, item => isValidDate(item) ? calendarDateOf(item, timeZone) : item)
  const normalizedCalendarDates = normalizeQueryPredicateValue(table, driver, columnName, calendarDates, operator)
  return {
    value: driver === 'sqlite' ? mapPredicateValue(normalizedCalendarDates, item => {
      const instant = instantOf(item)
      return instant ? calendarDateOf(instant, timeZone) : item
    }) : normalizedCalendarDates,
    comparesCalendarDates: true,
  }
}

export function normalizeDatePartPredicateValue(part: QueryDatePart, value: unknown): unknown {
  if (part === 'instant' || !isValidDate(value)) return undefined
  const parts = commonEraWallClockParts(value, getApplicationTimezone())
  if (!parts) return undefined

  switch (part) {
    case 'date':
      return `${parts.year}-${parts.month}-${parts.day}`
    case 'time':
      return parts.time
    case 'year':
      return Number(parts.year)
    case 'month':
      return Number(parts.month)
    case 'day':
      return Number(parts.day)
  }
}

export function normalizeQueryWriteRecord(
  table: TableDefinition | undefined,
  driver: string,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, normalizeQueryWriteValue(table, driver, key, value)]),
  )
}

export function normalizeQueryUpdateValues(
  table: TableDefinition | undefined,
  driver: string,
  values: Readonly<Record<string, unknown>>,
  parseJsonPath: JsonPathParser,
): Readonly<Record<string, unknown | readonly QueryJsonUpdateOperation[]>> {
  const normalized: Record<string, unknown | QueryJsonUpdateOperation[]> = {}

  for (const [key, value] of Object.entries(values)) {
    if (!key.includes('->')) {
      normalized[key] = normalizeQueryWriteValue(table, driver, key, value)
      continue
    }

    const { column, path } = parseJsonPath(key)
    if (typeof normalized[column] !== 'undefined' && !Array.isArray(normalized[column])) {
      throw new SecurityError(`Cannot mix direct and nested JSON assignments for column "${column}" in one update.`)
    }

    const operations = Array.isArray(normalized[column]) ? normalized[column] : []
    operations.push(Object.freeze({ kind: 'json-set', path, value }))
    normalized[column] = operations
  }

  return Object.freeze(Object.fromEntries(
    Object.entries(normalized).map(([column, value]) => [
      column,
      Array.isArray(value) ? Object.freeze([...value]) : value,
    ]),
  ))
}
