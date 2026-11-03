import { readIntegerColumnValue, readsAsInteger } from '../schema/normalization'
import type { AnyColumnDefinition, TableDefinition } from '../schema/types'
import type { QueryColumnSelection, SelectQueryPlan } from './ast'

const INTEGER_TEXT = /^-?\d+$/

type SelectedColumn = readonly [key: string, integer: AnyColumnDefinition | undefined]

function integerColumn(column: AnyColumnDefinition | undefined): AnyColumnDefinition | undefined {
  return column && readsAsInteger(column) ? column : undefined
}

function columnsOf(table: TableDefinition | undefined): SelectedColumn[] {
  return Object.entries(table?.columns ?? {}).map(([name, column]) => [name, integerColumn(column)])
}

function queryTables(plan: SelectQueryPlan): Map<string, TableDefinition | undefined> {
  const tables = new Map([[plan.source.alias ?? plan.source.tableName, plan.source.table]])
  for (const join of plan.joins) {
    if (join.table) tables.set(join.alias ?? join.table, join.definition)
  }
  return tables
}

function selectedColumns(
  selection: QueryColumnSelection,
  tables: ReadonlyMap<string, TableDefinition | undefined>,
  unqualifiedTable: TableDefinition | undefined,
): SelectedColumn[] {
  const separator = selection.column.lastIndexOf('.')
  const table = separator < 0 ? unqualifiedTable : tables.get(selection.column.slice(0, separator))
  const name = selection.column.slice(separator + 1)
  if (name === '*') return columnsOf(table)
  const column = table && Object.hasOwn(table.columns, name) ? table.columns[name] : undefined
  return [[selection.alias ?? name, integerColumn(column)]]
}

export type IntegerResultColumns = ReadonlyMap<string, AnyColumnDefinition>

export function resolveIntegerResultColumns(plan: SelectQueryPlan): IntegerResultColumns {
  const unqualifiedTable = plan.joins.length === 0 ? plan.source.table : undefined
  const tables = queryTables(plan)
  const selected: readonly SelectedColumn[] = plan.selections.length === 0
    ? columnsOf(unqualifiedTable)
    : plan.selections.flatMap((selection): SelectedColumn[] => selection.kind === 'column'
      ? selectedColumns(selection, tables, unqualifiedTable)
      : 'alias' in selection ? [[selection.alias, undefined]] : [])
  const columns = new Map<string, AnyColumnDefinition>()
  for (const [key, integer] of selected) {
    if (integer) columns.set(key, integer)
    else columns.delete(key)
  }
  return columns
}

function readsIntegerText(value: unknown): value is bigint | string {
  return typeof value === 'bigint' || (typeof value === 'string' && INTEGER_TEXT.test(value))
}

export function readIntegerResultColumns(row: Record<string, unknown>, columns: IntegerResultColumns): Record<string, unknown> {
  const values: Record<string, unknown> = { ...row }
  for (const [key, column] of columns) {
    const value = row[key]
    if (readsIntegerText(value)) values[key] = readIntegerColumnValue(column, value)
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
