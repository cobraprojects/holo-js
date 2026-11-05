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

function orderModelColumnsLast(branch: SelectQueryPlan, selections: readonly QuerySelection[]): readonly QuerySelection[] {
  const columns = selections.filter(selection => selection.kind === 'column')
  const queue = [
    ...columns.filter(selection => selectionRole(branch.source, selection) === 'joined'),
    ...columns.filter(selection => selectionRole(branch.source, selection) === 'own'),
  ]
  return Object.freeze(selections.map(selection => selection.kind === 'column' ? queue.shift() ?? selection : selection))
}

function qualifyModelOrders(plan: SelectQueryPlan, modelColumns: readonly string[], driver: string): SelectQueryPlan['orderBy'] {
  const aliases = new Set(plan.selections.flatMap(selection => 'alias' in selection && selection.alias ? [selection.alias] : []))
  const own = tableWildcard(plan.source.alias ?? plan.source.tableName, driver).slice(0, -2)
  return Object.freeze(plan.orderBy.map(order => order.kind === 'column' && modelColumns.includes(order.column) && !aliases.has(order.column)
    ? Object.freeze({ ...order, column: `${own}.${order.column}` })
    : order))
}

export function projectModelRowPlan(plan: SelectQueryPlan, driver: string, joinedColumns: JoinedColumns): SelectQueryPlan {
  const branches = [plan, ...plan.unions.map(union => union.query)]
  if (branches.every(branch => branch.joins.length === 0)) return plan

  const modelColumns = Object.keys(plan.source.table?.columns ?? {})
  for (const branch of branches) assertBranchSelections(branch, plan.source, modelColumns, joinedColumns)

  const expanded = branches.map(branch => expandSelections(branch, driver))
  if (plan.unions.length === 0) {
    return Object.freeze({ ...plan, orderBy: qualifyModelOrders(plan, modelColumns, driver), selections: orderModelColumnsLast(plan, expanded[0] ?? []) })
  }

  const roles = branches.map((branch, index) => (expanded[index] ?? []).map(selection => selectionRole(branch.source, selection)).join())
  if (roles.some(role => role !== roles[0])) {
    throw new CompilerError(`Cannot combine a joined "${plan.source.tableName}" model query with a union whose selections don't line up with its own. Select the same tables' columns in the same order in each query.`)
  }
  const project = (branch: SelectQueryPlan, index: number) => Object.freeze({ ...branch, selections: orderModelColumnsLast(branch, expanded[index] ?? []) })
  return Object.freeze({
    ...project(plan, 0),
    unions: Object.freeze(plan.unions.map((union, index) => Object.freeze({ ...union, query: project(union.query, index + 1) }))),
  })
}
