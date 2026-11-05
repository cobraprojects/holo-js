import { readIntegerColumnValue, readSQLiteDecimal, readsAsInteger, readsAsSQLiteDecimal } from '../schema/normalization'
import type { SchemaDialectName } from '../schema/typeMapping'
import type { AnyColumnDefinition, TableDefinition } from '../schema/types'
import type { QueryColumnSelection, SelectQueryPlan } from './ast'

const INTEGER_TEXT = /^-?\d+$/

type ColumnReader = (value: unknown) => unknown

type SelectedColumn = readonly [key: string, reader: ColumnReader | undefined]

function readsIntegerText(value: unknown): value is bigint | string {
  return typeof value === 'bigint' || (typeof value === 'string' && INTEGER_TEXT.test(value))
}

function columnReader(dialect: SchemaDialectName, column: AnyColumnDefinition | undefined): ColumnReader | undefined {
  if (column && readsAsInteger(column)) return value => readsIntegerText(value) ? readIntegerColumnValue(column, value) : value
  return column && readsAsSQLiteDecimal(dialect, column) ? readSQLiteDecimal : undefined
}

function columnsOf(dialect: SchemaDialectName, table: TableDefinition | undefined): SelectedColumn[] {
  return Object.entries(table?.columns ?? {}).map(([name, column]) => [name, columnReader(dialect, column)])
}

function queryTables(plan: SelectQueryPlan): Map<string, TableDefinition | undefined> {
  const tables = new Map([[plan.source.alias ?? plan.source.tableName, plan.source.table]])
  for (const join of plan.joins) {
    if (join.table) tables.set(join.alias ?? join.table, join.definition)
  }
  return tables
}

function selectedColumns(
  dialect: SchemaDialectName,
  selection: QueryColumnSelection,
  tables: ReadonlyMap<string, TableDefinition | undefined>,
  unqualifiedTable: TableDefinition | undefined,
): SelectedColumn[] {
  const separator = selection.column.lastIndexOf('.')
  const table = separator < 0 ? unqualifiedTable : tables.get(selection.column.slice(0, separator))
  const name = selection.column.slice(separator + 1)
  if (name === '*') return columnsOf(dialect, table)
  const column = table && Object.hasOwn(table.columns, name) ? table.columns[name] : undefined
  return [[selection.alias ?? name, columnReader(dialect, column)]]
}

export type ConvertedResultColumns = ReadonlyMap<string, ColumnReader>

export function resolveConvertedResultColumns(dialect: SchemaDialectName, plan: SelectQueryPlan): ConvertedResultColumns {
  const unqualifiedTable = plan.joins.length === 0 ? plan.source.table : undefined
  const tables = queryTables(plan)
  const selected: readonly SelectedColumn[] = plan.selections.length === 0
    ? columnsOf(dialect, unqualifiedTable)
    : plan.selections.flatMap((selection): SelectedColumn[] => selection.kind === 'column'
      ? selectedColumns(dialect, selection, tables, unqualifiedTable)
      : 'alias' in selection ? [[selection.alias, undefined]] : [])
  const columns = new Map<string, ColumnReader>()
  for (const [key, reader] of selected) {
    if (reader) columns.set(key, reader)
    else columns.delete(key)
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
