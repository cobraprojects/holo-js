import { parseInteger, readsAsInteger } from '../schema/normalization'
import type { AnyColumnDefinition, TableDefinition } from '../schema/types'
import type { QueryColumnSelection, SelectQueryPlan } from './ast'

const INTEGER_TEXT = /^-?\d+$/

type SelectedColumn = readonly [key: string, integer: boolean]

function integerColumn(column: AnyColumnDefinition | undefined): boolean {
  return column !== undefined && readsAsInteger(column)
}

function columnsOf(table: TableDefinition | undefined): SelectedColumn[] {
  return Object.entries(table?.columns ?? {}).map(([name, column]) => [name, integerColumn(column)])
}

function joinedColumns(plan: SelectQueryPlan): SelectedColumn[] {
  const tables = [plan.source.table, ...plan.joins.map(join => join.definition)]
  if (!tables.every(table => table !== undefined)) return []
  const declared = tables as TableDefinition[]
  const names = new Set(declared.flatMap(table => Object.keys(table.columns)))
  return [...names].map(name => [name, declared.every(table => !Object.hasOwn(table.columns, name) || integerColumn(table.columns[name]))])
}

function queryTables(plan: SelectQueryPlan): Map<string, TableDefinition | undefined> {
  const tables = new Map([[plan.source.alias ?? plan.source.tableName, plan.source.table]])
  for (const join of plan.joins) {
    if (join.table) tables.set(join.alias ?? join.table, join.definition)
  }
  return tables
}

function allColumns(plan: SelectQueryPlan): SelectedColumn[] {
  return plan.joins.length === 0 ? columnsOf(plan.source.table) : joinedColumns(plan)
}

function selectedColumns(
  plan: SelectQueryPlan,
  selection: QueryColumnSelection,
  tables: ReadonlyMap<string, TableDefinition | undefined>,
): SelectedColumn[] {
  const separator = selection.column.lastIndexOf('.')
  const name = selection.column.slice(separator + 1)
  if (separator < 0 && name === '*') return allColumns(plan)
  const table = separator < 0 ? plan.source.table : tables.get(selection.column.slice(0, separator))
  if (name === '*') return columnsOf(table)
  const column = table && Object.hasOwn(table.columns, name) ? table.columns[name] : undefined
  return [[selection.alias ?? name, integerColumn(column)]]
}

export type IntegerResultColumns = ReadonlySet<string>

export function resolveIntegerResultColumns(plan: SelectQueryPlan): IntegerResultColumns {
  const tables = queryTables(plan)
  const selected: readonly SelectedColumn[] = plan.selections.length === 0
    ? allColumns(plan)
    : plan.selections.flatMap((selection): SelectedColumn[] => selection.kind === 'column'
      ? selectedColumns(plan, selection, tables)
      : 'alias' in selection ? [[selection.alias, false]] : [])
  const columns = new Set<string>()
  for (const [key, integer] of selected) {
    if (integer) columns.add(key)
    else columns.delete(key)
  }
  return columns
}

function readsIntegerText(value: unknown): value is bigint | string {
  return typeof value === 'bigint' || (typeof value === 'string' && INTEGER_TEXT.test(value))
}

function holdsInteger(value: unknown): boolean {
  return typeof value === 'number' || readsIntegerText(value)
}

export function readIntegerResultColumns(row: Record<string, unknown>, columns: IntegerResultColumns): Record<string, unknown> {
  const values: Record<string, unknown> = { ...row }
  for (const key of columns) {
    const value = row[key]
    if (holdsInteger(value)) values[key] = parseInteger(value)
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
