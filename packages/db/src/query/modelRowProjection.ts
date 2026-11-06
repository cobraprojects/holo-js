import { CompilerError } from '../core/errors'
import { getConnectionGeneratedTableDefinition } from '../schema/generated'
import type { QueryColumnSelection, QueryJoinClause, QuerySelection, QuerySource, SelectQueryPlan } from './ast'
import type { TableDefinition } from '../schema/types'

type JoinedColumns = (join: QueryJoinClause) => readonly string[] | undefined

type SelectionRole = 'own' | 'joined' | 'other'

function knownSubqueryColumns(subquery: SelectQueryPlan, connectionName: string): readonly string[] | undefined {
  if (subquery.selections.length === 0) {
    const tables = [
      knownTableColumns(subquery.source.table?.tableName ?? subquery.source.tableName, subquery.source.table, connectionName),
      ...subquery.joins.map(join => knownJoinedColumns(join, connectionName)),
    ]
    return tables.every((columns): columns is readonly string[] => typeof columns !== 'undefined') ? tables.flat() : undefined
  }
  const outputs = subquery.selections.map(selection => selectionOutputName(selection))
  return outputs.every((output): output is string => typeof output === 'string' && output !== '*') ? outputs : undefined
}

function knownTableColumns(tableName: string | undefined, definition: TableDefinition | undefined, connectionName: string): readonly string[] | undefined {
  const table = definition ?? (tableName ? getConnectionGeneratedTableDefinition(tableName, connectionName) : undefined)
  return table ? Object.keys(table.columns) : undefined
}

export function knownJoinedColumns(join: QueryJoinClause, connectionName: string): readonly string[] | undefined {
  return join.subquery ? knownSubqueryColumns(join.subquery, connectionName) : knownTableColumns(join.table, join.definition, connectionName)
}

export function qualifiesTable(qualifier: string, tableName: string | undefined, alias: string | undefined): boolean {
  return qualifier === alias || (typeof tableName === 'string' && (qualifier === tableName || qualifier === tableName.slice(tableName.lastIndexOf('.') + 1)))
}

export function resolveSourceColumnName(source: Pick<QuerySource, 'tableName' | 'alias'>, column: string): string | undefined {
  const separator = column.lastIndexOf('.')
  if (separator === -1) return column

  return qualifiesTable(column.slice(0, separator), source.tableName, source.alias) ? column.slice(separator + 1) : undefined
}

function columnOutputName(selection: QueryColumnSelection): string {
  return selection.alias ?? selection.column.slice(selection.column.lastIndexOf('.') + 1)
}

export function selectionOutputName(selection: QuerySelection): string | undefined {
  if (selection.kind === 'column') return columnOutputName(selection)
  return 'alias' in selection ? selection.alias : undefined
}

export function tableWildcard(table: string, driver: string): string {
  return `${driver === 'sqlite' ? table.slice(table.lastIndexOf('.') + 1) : table}.*`
}

function joinName(join: QueryJoinClause): string | undefined {
  return join.alias ?? join.table
}

function selectedAliases(plan: SelectQueryPlan): ReadonlySet<string> {
  return new Set(plan.selections.flatMap(selection => 'alias' in selection && selection.alias ? [selection.alias] : []))
}

function wildcardColumns(branch: SelectQueryPlan, wildcard: string, joinedColumns: JoinedColumns): readonly string[] | undefined {
  const qualifier = wildcard.slice(0, -2)
  const join = branch.joins.find(candidate => qualifiesTable(qualifier, candidate.table, candidate.alias))
  return join ? joinedColumns(join) : undefined
}

function selectionRole(source: QuerySource, selection: QuerySelection): SelectionRole {
  if (selection.kind !== 'column') return 'other'
  return typeof resolveSourceColumnName(source, selection.column) === 'undefined' ? 'joined' : 'own'
}

function wildcardSelection(table: string, driver: string): QueryColumnSelection {
  return Object.freeze({ kind: 'column' as const, column: tableWildcard(table, driver) })
}

function expandSelections(branch: SelectQueryPlan, driver: string): readonly QuerySelection[] {
  const own = wildcardSelection(branch.source.alias ?? branch.source.tableName, driver)
  const joined = branch.joins.flatMap(join => joinName(join) ?? []).map(table => wildcardSelection(table, driver))
  if (branch.selections.length === 0) return [...joined, own]
  return branch.selections.flatMap(selection => selection.kind === 'column' && selection.column === '*' ? [...joined, own] : [selection])
}

function assertBranchSelections(branch: SelectQueryPlan, model: QuerySource, modelColumns: readonly string[], joinedColumns: JoinedColumns): void {
  const ownOutputs = new Set(branch.selections.flatMap(selection => selection.kind === 'column' && selectionRole(branch.source, selection) === 'own' ? [columnOutputName(selection)] : []))
  const replaces = (name: string) => modelColumns.includes(name) && !ownOutputs.has('*') && !ownOutputs.has(name)
  const collisionError = (selected: string, name: string) => new CompilerError(`Cannot select "${selected}" on a joined "${model.tableName}" model query: "${name}" is a "${model.tableName}" column. Qualify or alias it to a non-model name.`)

  for (const selection of branch.selections) {
    if (selection.kind !== 'column' || selectionRole(branch.source, selection) === 'own') continue
    if (selection.column.endsWith('.*')) {
      if (ownOutputs.has('*')) continue
      const columns = wildcardColumns(branch, selection.column, joinedColumns)
      if (!columns) {
        throw new CompilerError(`Cannot select "${selection.column}" on a joined "${model.tableName}" model query: its columns may replace "${model.tableName}" columns the query doesn't select. Select "${model.alias ?? model.tableName}.*" too, or select the joined columns by name.`)
      }
      const replaced = columns.find(replaces)
      if (replaced) throw collisionError(selection.column, replaced)
      continue
    }
    const name = columnOutputName(selection)
    if (selection.alias && modelColumns.includes(name)) throw collisionError(`${selection.column} as ${selection.alias}`, name)
    if (replaces(name)) throw collisionError(selection.column, name)
  }
}

function shadowsModelColumn(branch: SelectQueryPlan, selection: QuerySelection, modelColumns: readonly string[], joinedColumns: JoinedColumns): boolean {
  if (selection.kind !== 'column' || selectionRole(branch.source, selection) !== 'joined') return false
  if (!selection.column.endsWith('.*')) return !selection.alias && modelColumns.includes(columnOutputName(selection))
  const columns = wildcardColumns(branch, selection.column, joinedColumns)
  return !columns || columns.some(column => modelColumns.includes(column))
}

function shadowedModelColumns(branch: SelectQueryPlan, selection: QueryColumnSelection, modelColumns: readonly string[], joinedColumns: JoinedColumns): readonly string[] | undefined {
  if (!selection.column.endsWith('.*')) return [columnOutputName(selection)]
  return wildcardColumns(branch, selection.column, joinedColumns)?.filter(column => modelColumns.includes(column))
}

function protectModelColumns(branch: SelectQueryPlan, selections: readonly QuerySelection[], modelColumns: readonly string[], joinedColumns: JoinedColumns, driver: string): readonly QuerySelection[] {
  const isModelOutput = (selection: QuerySelection): selection is QueryColumnSelection =>
    selection.kind === 'column' && selectionRole(branch.source, selection) === 'own' && ['*', ...modelColumns].includes(columnOutputName(selection))
  const firstOwn = selections.findIndex(isModelOutput)
  if (firstOwn === -1) return Object.freeze([...selections])

  const ownTable = tableWildcard(branch.source.alias ?? branch.source.tableName, driver).slice(0, -2)
  const reselect = (name: string, before: number): readonly QuerySelection[] => {
    const effective = selections.slice(0, before).reverse().find(selection => selection.kind !== 'column'
      ? selectionOutputName(selection) === name
      : selectionRole(branch.source, selection) === 'own' && [name, '*'].includes(columnOutputName(selection)))
    if (!effective) return []
    if (effective.kind === 'column' && columnOutputName(effective) === '*') return [Object.freeze({ kind: 'column' as const, column: `${ownTable}.${name}` })]
    return [effective]
  }
  const moved = selections.filter((selection, index) => index > firstOwn && selection.kind === 'column' && shadowsModelColumn(branch, selection, modelColumns, joinedColumns)
    && typeof shadowedModelColumns(branch, selection, modelColumns, joinedColumns) === 'undefined')
  const kept = selections.flatMap((selection, index) => {
    if (moved.includes(selection)) return []
    if (index <= firstOwn || selection.kind !== 'column' || !shadowsModelColumn(branch, selection, modelColumns, joinedColumns)) return [selection]
    return [selection, ...(shadowedModelColumns(branch, selection, modelColumns, joinedColumns) ?? []).flatMap(name => reselect(name, index))]
  })
  return Object.freeze([...kept.slice(0, firstOwn), ...moved, ...kept.slice(firstOwn)])
}

function ordersByModelColumn(plan: SelectQueryPlan, modelColumns: readonly string[], aliases: ReadonlySet<string>) {
  return (order: SelectQueryPlan['orderBy'][number]): order is Extract<SelectQueryPlan['orderBy'][number], { kind: 'column' }> =>
    order.kind === 'column' && modelColumns.includes(order.column) && !aliases.has(order.column)
}

function qualifyModelOrders(plan: SelectQueryPlan, modelColumns: readonly string[], driver: string): SelectQueryPlan['orderBy'] {
  const isModelOrder = ordersByModelColumn(plan, modelColumns, selectedAliases(plan))
  const own = tableWildcard(plan.source.alias ?? plan.source.tableName, driver).slice(0, -2)
  return Object.freeze(plan.orderBy.map(order => isModelOrder(order) ? Object.freeze({ ...order, column: `${own}.${order.column}` }) : order))
}

function unionBranches(plan: SelectQueryPlan): readonly SelectQueryPlan[] {
  return [plan, ...plan.unions.flatMap(union => unionBranches(union.query))]
}

function orderedModelColumns(plan: SelectQueryPlan, modelColumns: readonly string[]): readonly string[] {
  return plan.orderBy.filter(ordersByModelColumn(plan, modelColumns, selectedAliases(plan))).map(order => order.column)
}

function sharesOrderedName(branch: SelectQueryPlan, selection: QuerySelection, ordered: readonly string[], joinedColumns: JoinedColumns): boolean {
  if (selection.kind !== 'column' || selectionRole(branch.source, selection) !== 'joined') return false
  if (!selection.column.endsWith('.*')) return !selection.alias && ordered.includes(columnOutputName(selection))
  const columns = wildcardColumns(branch, selection.column, joinedColumns)
  return !columns || columns.some(column => ordered.includes(column))
}

function projectUnionBranch(branch: SelectQueryPlan, driver: string, modelColumns: readonly string[], joinedColumns: JoinedColumns, shouldLeadWithModelColumns: boolean): SelectQueryPlan {
  const selections = protectModelColumns(branch, expandSelections(branch, driver), modelColumns, joinedColumns, driver)
  const leading = shouldLeadWithModelColumns ? selections.filter(selection => selectionRole(branch.source, selection) === 'own') : []
  return Object.freeze({
    ...branch,
    selections: Object.freeze([...leading, ...selections]),
    unions: Object.freeze(branch.unions.map(union => Object.freeze({ ...union, query: projectUnionBranch(union.query, driver, modelColumns, joinedColumns, shouldLeadWithModelColumns) }))),
  })
}

export function projectModelRowPlan(plan: SelectQueryPlan, driver: string, joinedColumns: JoinedColumns): SelectQueryPlan {
  const branches = unionBranches(plan)
  if (branches.every(branch => branch.joins.length === 0)) return plan

  const modelColumns = Object.keys(plan.source.table?.columns ?? {})
  for (const branch of branches) assertBranchSelections(branch, plan.source, modelColumns, joinedColumns)

  if (plan.unions.length === 0) {
    return Object.freeze({ ...plan, orderBy: qualifyModelOrders(plan, modelColumns, driver), selections: protectModelColumns(plan, expandSelections(plan, driver), modelColumns, joinedColumns, driver) })
  }

  const roles = branches.map(branch => protectModelColumns(branch, expandSelections(branch, driver), modelColumns, joinedColumns, driver).map(selection => selectionRole(branch.source, selection)).join())
  if (roles.some(role => role !== roles[0])) {
    throw new CompilerError(`Cannot combine a joined "${plan.source.tableName}" model query with a union whose selections don't line up with its own. Select the same tables' columns in the same order in each query.`)
  }
  const ordered = branches.flatMap(branch => orderedModelColumns(branch, modelColumns))
  const shouldLeadWithModelColumns = driver === 'sqlite' && ordered.length > 0 && branches.some(branch => expandSelections(branch, driver).some(selection => sharesOrderedName(branch, selection, ordered, joinedColumns)))
  return projectUnionBranch(plan, driver, modelColumns, joinedColumns, shouldLeadWithModelColumns)
}
