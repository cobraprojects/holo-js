import { SecurityError } from '../core/errors'
import { normalizeDialectWriteValue } from '../schema/normalization'
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
  const column = table?.columns[columnName]
  if (!column) return value
  return normalizeDialectWriteValue(driver as SchemaDialectName, column as AnyColumnDefinition, value)
}

export function normalizeQueryPredicateValue(
  table: TableDefinition | undefined,
  driver: string,
  columnName: string,
  value: unknown,
): unknown {
  if (Array.isArray(value)) {
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
