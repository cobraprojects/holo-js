import { readIntegerColumnValue, readSQLiteDecimal, readsAsInteger, readsAsSQLiteDecimal } from '../schema/normalization'
import type { SchemaDialectName } from '../schema/typeMapping'
import type { AnyColumnDefinition, TableDefinition } from '../schema/types'
import type { QueryColumnSelection, SelectQueryPlan } from './ast'

const INTEGER_TEXT = /^-?\d+$/

type ColumnReader = (value: unknown) => unknown

type SelectedColumn = readonly [key: string, definition: AnyColumnDefinition | undefined]

function readsIntegerText(value: unknown): value is bigint | string {
  return typeof value === 'bigint' || (typeof value === 'string' && INTEGER_TEXT.test(value))
}

function columnReader(dialect: SchemaDialectName, column: AnyColumnDefinition | undefined): ColumnReader | undefined {
  if (column && readsAsInteger(column)) return value => readsIntegerText(value) ? readIntegerColumnValue(column, value) : value
  return column && readsAsSQLiteDecimal(dialect, column) ? readSQLiteDecimal : undefined
}

function columnsOf(table: TableDefinition | undefined): SelectedColumn[] {
  return Object.entries(table?.columns ?? {})
}

function queryTables(plan: SelectQueryPlan): Map<string, TableDefinition | undefined> {
  const tables = new Map([[plan.source.alias ?? plan.source.tableName, plan.source.table]])
  for (const [index, join] of plan.joins.entries()) {
    tables.set(join.alias ?? join.table ?? `\0subquery${index}`, join.table ? join.definition : undefined)
  }
  return tables
}

function unambiguousColumn(tables: ReadonlyMap<string, TableDefinition | undefined>, name: string): AnyColumnDefinition | undefined {
  const definitions = [...tables.values()]
  if (definitions.some(table => table === undefined)) return undefined
  const columns = definitions.flatMap(table => Object.hasOwn(table!.columns, name) ? [table!.columns[name]!] : [])
  const [first] = columns
  return first && columns.every(column => column.kind === first.kind && column.idStrategy === first.idStrategy) ? first : undefined
}

function unambiguousColumns(tables: ReadonlyMap<string, TableDefinition | undefined>): SelectedColumn[] {
  const names = new Set([...tables.values()].flatMap(table => Object.keys(table?.columns ?? {})))
  return [...names].map(name => [name, unambiguousColumn(tables, name)])
}

function selectedColumns(selection: QueryColumnSelection, tables: ReadonlyMap<string, TableDefinition | undefined>): SelectedColumn[] {
  const separator = selection.column.lastIndexOf('.')
  const name = selection.column.slice(separator + 1)
  if (separator < 0) {
    return name === '*' ? unambiguousColumns(tables) : [[selection.alias ?? name, unambiguousColumn(tables, name)]]
  }
  const table = tables.get(selection.column.slice(0, separator))
  if (name === '*') return columnsOf(table)
  return [[selection.alias ?? name, table && Object.hasOwn(table.columns, name) ? table.columns[name] : undefined]]
}

function resultColumnDefinitions(plan: SelectQueryPlan): ReadonlyMap<string, AnyColumnDefinition> {
  const tables = queryTables(plan)
  const selected: readonly SelectedColumn[] = plan.selections.length === 0
    ? unambiguousColumns(tables)
    : plan.selections.flatMap((selection): SelectedColumn[] => selection.kind === 'column'
      ? selectedColumns(selection, tables)
      : 'alias' in selection ? [[selection.alias, undefined]] : [])
  const definitions = new Map<string, AnyColumnDefinition>()
  for (const [key, definition] of selected) {
    if (definition) definitions.set(key, definition)
    else definitions.delete(key)
  }
  return definitions
}

export function resultColumnDefinition(plan: SelectQueryPlan, key: string): AnyColumnDefinition | undefined {
  return resultColumnDefinitions(plan).get(key)
}

export type ConvertedResultColumns = ReadonlyMap<string, ColumnReader>

export function resolveConvertedResultColumns(dialect: SchemaDialectName, plan: SelectQueryPlan): ConvertedResultColumns {
  const columns = new Map<string, ColumnReader>()
  for (const [key, definition] of resultColumnDefinitions(plan)) {
    const reader = columnReader(dialect, definition)
    if (reader) columns.set(key, reader)
  }
  return columns
}

export function readConvertedResultColumns(row: Record<string, unknown>, columns: ConvertedResultColumns): Record<string, unknown> {
  const values: Record<string, unknown> = { ...row }
  for (const [key, read] of columns) {
    if (Object.hasOwn(row, key)) values[key] = read(row[key])
  }
  return values
}

export function readInsertedKey(
  table: TableDefinition | undefined,
  column: string,
  value: number | string | undefined,
): number | string | undefined {
  const definition = table && Object.hasOwn(table.columns, column) ? table.columns[column] : undefined
  const readsInteger = table ? definition !== undefined && readsAsInteger(definition) : true
  if (!readsInteger || !readsIntegerText(value)) return value
  const integer = Number(value)
  return Number.isSafeInteger(integer) ? integer : value
}
