import { parseInteger, readsAsInteger } from '../schema/normalization'
import type { TableDefinition } from '../schema/types'
import type { QueryColumnSelection, SelectQueryPlan } from './ast'

const INTEGER_TEXT = /^-?\d+$/

type TableResolver = (tableName: string) => TableDefinition | undefined
type SelectedColumn = readonly [key: string, integer: boolean]

function columnsOf(table: TableDefinition | undefined): SelectedColumn[] {
  return Object.entries(table?.columns ?? {}).map(([name, column]) => [name, readsAsInteger(column)])
}

function queryTables(plan: SelectQueryPlan, resolveTable: TableResolver): Map<string, TableDefinition | undefined> {
  const tables = new Map([[plan.source.alias ?? plan.source.tableName, plan.source.table]])
  for (const join of plan.joins) {
    if (join.table) tables.set(join.alias ?? join.table, join.definition ?? resolveTable(join.table))
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
  return [[selection.alias ?? name, column ? readsAsInteger(column) : false]]
}

export function resolveIntegerResultColumns(plan: SelectQueryPlan, resolveTable: TableResolver): readonly string[] {
  const unqualifiedTable = plan.joins.length === 0 ? plan.source.table : undefined
  if (plan.selections.length === 0) {
    return columnsOf(unqualifiedTable).filter(([, integer]) => integer).map(([key]) => key)
  }

  const tables = queryTables(plan, resolveTable)
  const keys = new Set<string>()
  for (const selection of plan.selections) {
    const selected: readonly SelectedColumn[] = selection.kind === 'column'
      ? selectedColumns(selection, tables, unqualifiedTable)
      : 'alias' in selection ? [[selection.alias, false]] : []
    for (const [key, integer] of selected) {
      if (integer) keys.add(key)
      else keys.delete(key)
    }
  }
  return [...keys]
}

export function readIntegerResultColumns(row: Record<string, unknown>, columns: readonly string[]): Record<string, unknown> {
  const values: Record<string, unknown> = { ...row }
  for (const column of columns) {
    const value = row[column]
    if (typeof value === 'bigint' || (typeof value === 'string' && INTEGER_TEXT.test(value))) values[column] = parseInteger(value)
  }
  return values
}
