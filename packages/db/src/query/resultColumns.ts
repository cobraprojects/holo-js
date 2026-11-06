import { coerceBoolean, isStoredBoolean, parseInteger, readSQLiteDecimal, readsAsCoercedBoolean, readsAsInteger, readsAsSQLiteDecimal } from '../schema/normalization'
import { getConnectionGeneratedTableDefinition } from '../schema/generated'
import type { SchemaDialectName } from '../schema/typeMapping'
import type { AnyColumnDefinition, TableDefinition } from '../schema/types'
import type { QueryColumnSelection, SelectQueryPlan } from './ast'

const INTEGER_TEXT = /^-?\d+$/

const UNKNOWN_COLUMNS = '\0*'

type ColumnReader = (value: unknown) => unknown

type SelectedColumn = readonly [key: string, definition: AnyColumnDefinition | undefined]

function readsIntegerText(value: unknown): value is bigint | string {
  return typeof value === 'bigint' || (typeof value === 'string' && INTEGER_TEXT.test(value))
}

function holdsInteger(value: unknown): boolean {
  return typeof value === 'number' || readsIntegerText(value)
}

function readIntegerResult(value: unknown): unknown {
  return holdsInteger(value) ? parseInteger(value) : value
}

function columnReader(dialect: SchemaDialectName, column: AnyColumnDefinition | undefined): ColumnReader | undefined {
  if (!column) return undefined
  if (readsAsInteger(column)) return readIntegerResult
  if (readsAsCoercedBoolean(dialect, column)) return coerceBoolean
  return readsAsSQLiteDecimal(dialect, column) ? readSQLiteDecimal : undefined
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

export function tableForQualifier(tables: ReadonlyMap<string, TableDefinition | undefined>, qualifier: string): TableDefinition | undefined {
  if (tables.has(qualifier)) return tables.get(qualifier)
  const matches = [...tables.entries()].filter(([name]) => name.includes('.') && name.slice(name.lastIndexOf('.') + 1) === qualifier)
  return matches.length === 1 ? matches[0]![1] : undefined
}

function unambiguousColumn(tables: ReadonlyMap<string, TableDefinition | undefined>, name: string): AnyColumnDefinition | undefined {
  const [source] = tables.values()
  if (source && Object.hasOwn(source.columns, name)) return source.columns[name]
  const definitions = [...tables.values()]
  if (definitions.some(table => table === undefined)) return undefined
  const owners = definitions.filter(table => Object.hasOwn(table!.columns, name))
  return owners.length === 1 ? owners[0]!.columns[name] : undefined
}

function projectedColumns(tables: ReadonlyMap<string, TableDefinition | undefined>): SelectedColumn[] {
  return [...tables.values()].flatMap(table => table ? columnsOf(table) : [[UNKNOWN_COLUMNS, undefined] as const])
}

function selectedColumns(selection: QueryColumnSelection, tables: ReadonlyMap<string, TableDefinition | undefined>): SelectedColumn[] {
  const separator = selection.column.lastIndexOf('.')
  const name = selection.column.slice(separator + 1)
  if (separator < 0) {
    return name === '*' ? projectedColumns(tables) : [[selection.alias ?? name, unambiguousColumn(tables, name)]]
  }
  const table = tableForQualifier(tables, selection.column.slice(0, separator))
  if (name === '*') return table ? columnsOf(table) : [[UNKNOWN_COLUMNS, undefined]]
  return [[selection.alias ?? name, table && Object.hasOwn(table.columns, name) ? table.columns[name] : undefined]]
}

function selectedResultColumns(plan: SelectQueryPlan): readonly SelectedColumn[] {
  const tables = queryTables(plan)
  return plan.selections.length === 0
    ? projectedColumns(tables)
    : plan.selections.flatMap((selection): SelectedColumn[] => selection.kind === 'column'
      ? selectedColumns(selection, tables)
      : 'alias' in selection ? [[selection.alias, undefined]] : [[UNKNOWN_COLUMNS, undefined]])
}

function resultColumnDefinitions(plan: SelectQueryPlan): ReadonlyMap<string, AnyColumnDefinition> {
  const selected = selectedResultColumns(plan)
  const definitions = new Map<string, AnyColumnDefinition>()
  for (const [key, definition] of selected) {
    if (key === UNKNOWN_COLUMNS) definitions.clear()
    else if (definition) definitions.set(key, definition)
    else definitions.delete(key)
  }
  return definitions
}

export function withResolvedDefinitions(plan: SelectQueryPlan, connectionName: string): SelectQueryPlan {
  return {
    ...plan,
    joins: plan.joins.map(join => join.table && !join.definition
      ? { ...join, definition: getConnectionGeneratedTableDefinition(join.table, connectionName) }
      : join),
    unions: plan.unions.map(union => ({ ...union, query: withResolvedDefinitions(union.query, connectionName) })),
  }
}

export function resultColumnDefinition(plan: SelectQueryPlan, key: string): AnyColumnDefinition | undefined {
  return resultColumnDefinitions(plan).get(key)
}

export type ConvertedResultColumns = ReadonlyMap<string, ColumnReader>

function hasEveryPosition(columns: readonly SelectedColumn[]): boolean {
  return columns.every(([key]) => key !== UNKNOWN_COLUMNS)
}

function unionBranches(plan: SelectQueryPlan): readonly SelectQueryPlan[] {
  return plan.unions.flatMap(union => [union.query, ...unionBranches(union.query)])
}

function hasWildcardProjection(plan: SelectQueryPlan): boolean {
  return plan.selections.length === 0 || plan.selections.some(selection => selection.kind === 'column' && selection.column.endsWith('*'))
}

function projectionShape(plan: SelectQueryPlan): string {
  return JSON.stringify([
    plan.source.tableName,
    plan.joins.map(join => join.table ?? null),
    plan.selections.map(selection => selection.kind === 'column' ? [selection.column, selection.alias ?? null] : selection.kind),
  ])
}

function hasAlignedWildcards(plan: SelectQueryPlan, branches: readonly SelectQueryPlan[]): boolean {
  const plans = [plan, ...branches]
  if (!plans.some(hasWildcardProjection)) return true
  const shape = projectionShape(plan)
  return branches.every(branch => projectionShape(branch) === shape)
}

function createUnionReaderCheck(
  dialect: SchemaDialectName,
  plan: SelectQueryPlan,
): (key: string, reader: ColumnReader) => boolean {
  if (plan.unions.length === 0) return () => true
  const branchPlans = unionBranches(plan)
  if (!hasAlignedWildcards(plan, branchPlans)) return () => false
  const selected = selectedResultColumns(plan)
  const branches = branchPlans.map(selectedResultColumns)
  if (!hasEveryPosition(selected) || branches.some(branch => branch.length !== selected.length || !hasEveryPosition(branch))) {
    return () => false
  }
  return (key, reader) => {
    const position = selected.map(([selectedKey]) => selectedKey).lastIndexOf(key)
    return branches.every(branch => columnReader(dialect, branch[position]?.[1]) === reader)
  }
}

export function resolveConvertedResultColumns(dialect: SchemaDialectName, plan: SelectQueryPlan): ConvertedResultColumns {
  const columns = new Map<string, ColumnReader>()
  const unionReads = createUnionReaderCheck(dialect, plan)
  for (const [key, definition] of resultColumnDefinitions(plan)) {
    const reader = columnReader(dialect, definition)
    if (reader && unionReads(key, reader)) columns.set(key, reader)
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

export function hasUnstoredBoolean(rows: readonly Record<string, unknown>[], columns: ConvertedResultColumns): boolean {
  const booleanKeys = [...columns].filter(([, read]) => read === coerceBoolean).map(([key]) => key)
  return booleanKeys.length > 0 && rows.some(row => booleanKeys.some((key) => {
    const value = row[key]
    return value != null && typeof value !== 'boolean' && !isStoredBoolean(value)
  }))
}

const CANONICAL_INTEGER_TEXT = /^(?:0|-?[1-9]\d*)$/

function holdsIntegerValue(value: unknown): value is bigint | number | string {
  return typeof value === 'bigint' || typeof value === 'number' || typeof value === 'string'
}

function readsCanonicalInteger(value: unknown): boolean {
  return (typeof value === 'bigint' && Number.isSafeInteger(Number(value)))
    || (typeof value === 'number' && Number.isSafeInteger(value))
    || (typeof value === 'string' && CANONICAL_INTEGER_TEXT.test(value) && Number.isSafeInteger(Number(value)))
}

export function holdsUnreadableInteger(table: TableDefinition | undefined, row: Readonly<Record<string, unknown>>): boolean {
  return columnsOf(table).some(([key, definition]) => readsAsInteger(definition!)
    && Object.hasOwn(row, key)
    && holdsIntegerValue(row[key])
    && !readsCanonicalInteger(row[key]))
}

export function readCanonicalInteger(value: unknown): unknown {
  return readsCanonicalInteger(value) && typeof value !== 'number' ? Number(value) : value
}

export function readIntegerColumns(table: TableDefinition | undefined, row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const columns = columnsOf(table).flatMap(([key, definition]) => readsAsInteger(definition!) && Object.hasOwn(row, key) && readCanonicalInteger(row[key]) !== row[key] ? [key] : [])
  if (columns.length === 0) return row
  return Object.freeze({ ...row, ...Object.fromEntries(columns.map(key => [key, readCanonicalInteger(row[key])])) })
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
