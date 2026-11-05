import { CompilerError } from '../core/errors'
import type { QueryColumnSelection, QueryJoinClause, QuerySelection, QuerySource, SelectQueryPlan } from './ast'

type JoinedColumns = (join: QueryJoinClause) => readonly string[] | undefined

type SelectionRole = 'own' | 'joined' | 'other'

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
  const reject = (selected: string, name: string) => new CompilerError(`Cannot select "${selected}" on a joined "${model.tableName}" model query: "${name}" is a "${model.tableName}" column. Qualify or alias it to a non-model name.`)

  for (const selection of branch.selections) {
    if (selection.kind !== 'column' || selectionRole(branch.source, selection) === 'own') continue
    if (selection.column.endsWith('.*')) {
      if (ownOutputs.has('*')) continue
      const qualifier = selection.column.slice(0, -2)
      const join = branch.joins.find(candidate => qualifiesTable(qualifier, candidate.table, candidate.alias))
      const columns = join ? joinedColumns(join) : undefined
      if (!columns) {
        throw new CompilerError(`Cannot select "${selection.column}" on a joined "${model.tableName}" model query: its columns may replace "${model.tableName}" columns the query doesn't select. Select "${model.alias ?? model.tableName}.*" too, or select the joined columns by name.`)
      }
      const replaced = columns.find(replaces)
      if (replaced) throw reject(selection.column, replaced)
      continue
    }
    const name = columnOutputName(selection)
    if (selection.alias && modelColumns.includes(name)) throw reject(`${selection.column} as ${selection.alias}`, name)
    if (replaces(name)) throw reject(selection.column, name)
  }
}

function shadowsModelColumn(branch: SelectQueryPlan, selection: QuerySelection, modelColumns: readonly string[]): boolean {
  if (selection.kind !== 'column' || selectionRole(branch.source, selection) !== 'joined') return false
  return selection.column.endsWith('.*') || (!selection.alias && modelColumns.includes(columnOutputName(selection)))
}

function alignmentRole(branch: SelectQueryPlan, selection: QuerySelection, modelColumns: readonly string[]): string {
  return shadowsModelColumn(branch, selection, modelColumns) ? 'shadow' : selectionRole(branch.source, selection)
}

function moveShadowingColumnsFirst(branch: SelectQueryPlan, selections: readonly QuerySelection[], modelColumns: readonly string[]): readonly QuerySelection[] {
  const firstOwn = selections.findIndex(selection => selectionRole(branch.source, selection) === 'own')
  if (firstOwn === -1) return Object.freeze([...selections])
  const following = selections.slice(firstOwn)
  const moved = following.filter(selection => shadowsModelColumn(branch, selection, modelColumns))
  return Object.freeze([...selections.slice(0, firstOwn), ...moved, ...following.filter(selection => !moved.includes(selection))])
}

function qualifyModelOrders(plan: SelectQueryPlan, modelColumns: readonly string[], driver: string): SelectQueryPlan['orderBy'] {
  const aliases = new Set(plan.selections.flatMap(selection => 'alias' in selection && selection.alias ? [selection.alias] : []))
  const own = tableWildcard(plan.source.alias ?? plan.source.tableName, driver).slice(0, -2)
  return Object.freeze(plan.orderBy.map(order => order.kind === 'column' && modelColumns.includes(order.column) && !aliases.has(order.column)
    ? Object.freeze({ ...order, column: `${own}.${order.column}` })
    : order))
}

function unionBranches(plan: SelectQueryPlan): readonly SelectQueryPlan[] {
  return [plan, ...plan.unions.flatMap(union => unionBranches(union.query))]
}

function orderedModelColumns(plan: SelectQueryPlan, modelColumns: readonly string[]): readonly string[] {
  const aliases = new Set(plan.selections.flatMap(selection => 'alias' in selection && selection.alias ? [selection.alias] : []))
  return plan.orderBy.flatMap(order => order.kind === 'column' && modelColumns.includes(order.column) && !aliases.has(order.column) ? [order.column] : [])
}

function sharesOrderedName(branch: SelectQueryPlan, selection: QuerySelection, ordered: readonly string[], joinedColumns: JoinedColumns): boolean {
  if (selection.kind !== 'column' || selectionRole(branch.source, selection) !== 'joined') return false
  if (!selection.column.endsWith('.*')) return !selection.alias && ordered.includes(columnOutputName(selection))
  const qualifier = selection.column.slice(0, -2)
  const join = branch.joins.find(candidate => qualifiesTable(qualifier, candidate.table, candidate.alias))
  const columns = join ? joinedColumns(join) : undefined
  return !columns || columns.some(column => ordered.includes(column))
}

function projectUnionBranch(branch: SelectQueryPlan, driver: string, modelColumns: readonly string[], leadingModelColumns: boolean): SelectQueryPlan {
  const selections = moveShadowingColumnsFirst(branch, expandSelections(branch, driver), modelColumns)
  const leading = leadingModelColumns ? selections.filter(selection => selectionRole(branch.source, selection) === 'own') : []
  return Object.freeze({
    ...branch,
    selections: Object.freeze([...leading, ...selections]),
    unions: Object.freeze(branch.unions.map(union => Object.freeze({ ...union, query: projectUnionBranch(union.query, driver, modelColumns, leadingModelColumns) }))),
  })
}

export function projectModelRowPlan(plan: SelectQueryPlan, driver: string, joinedColumns: JoinedColumns): SelectQueryPlan {
  const branches = unionBranches(plan)
  if (branches.every(branch => branch.joins.length === 0)) return plan

  const modelColumns = Object.keys(plan.source.table?.columns ?? {})
  for (const branch of branches) assertBranchSelections(branch, plan.source, modelColumns, joinedColumns)

  if (plan.unions.length === 0) {
    return Object.freeze({ ...plan, orderBy: qualifyModelOrders(plan, modelColumns, driver), selections: moveShadowingColumnsFirst(plan, expandSelections(plan, driver), modelColumns) })
  }

  const roles = branches.map(branch => expandSelections(branch, driver).map(selection => alignmentRole(branch, selection, modelColumns)).join())
  if (roles.some(role => role !== roles[0])) {
    throw new CompilerError(`Cannot combine a joined "${plan.source.tableName}" model query with a union whose selections don't line up with its own. Select the same tables' columns in the same order in each query.`)
  }
  const ordered = branches.flatMap(branch => orderedModelColumns(branch, modelColumns))
  const leadingModelColumns = ordered.length > 0 && branches.some(branch => expandSelections(branch, driver).some(selection => sharesOrderedName(branch, selection, ordered, joinedColumns)))
  return projectUnionBranch(plan, driver, modelColumns, leadingModelColumns)
}
