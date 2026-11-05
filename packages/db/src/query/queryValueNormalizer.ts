import { SecurityError, SerializationError } from '../core/errors'
import { NumericAdjustment } from './NumericAdjustment'
import { booleanStorageValue, normalizeDialectWriteValue } from '../schema/normalization'
import { formatSQLiteDateTime } from '../sqliteDateTime'
import type { AnyColumnDefinition, TableDefinition } from '../schema/types'
import type { SchemaDialectName } from '../schema/typeMapping'
import type { QueryJsonUpdateOperation } from './ast'

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

function normalizeQueryColumnWriteValue(
  table: TableDefinition | undefined,
  driver: string,
  columnName: string,
  value: unknown,
): unknown {
  const normalized = normalizeQueryWriteValue(table, driver, columnName, value)
  if (driver === 'sqlite' && (Array.isArray(normalized) || isPlainObject(normalized))) {
    const kind = Array.isArray(normalized) ? 'an array' : 'an object'
    throw new SerializationError(`Cannot write ${kind} to column "${columnName}" on SQLite. Add a 'json' cast for it or JSON.stringify the value.`)
  }
  return normalized
}

function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
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

export function normalizeQueryWriteRecord(
  table: TableDefinition | undefined,
  driver: string,
  values: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, normalizeQueryColumnWriteValue(table, driver, key, value)]),
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
      normalized[key] = normalizeQueryColumnWriteValue(table, driver, key, value)
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
