import { CompilerError } from '../core/errors'
import type { QueryOrderBy, QuerySelection, SelectQueryPlan } from './ast'
import { knownJoinedColumns, knownTableColumns, qualifiesTable, selectionOutputName } from './modelRowProjection'

export function unionOutputName(plan: SelectQueryPlan, column: string): string {
  if (plan.selections.some(selection => selectionOutputName(selection) === column)) return column
  const selected = plan.selections.find(selection => selection.kind === 'column' && selection.column === column)
  return (selected && selectionOutputName(selected)) ?? column.slice(column.lastIndexOf('.') + 1)
}

export function unionOutputOrder(plan: SelectQueryPlan, orderBy: QueryOrderBy): QueryOrderBy {
  if (orderBy.kind !== 'column' || orderBy.column.includes('->')) return orderBy
  return { ...orderBy, column: unionOutputName(plan, orderBy.column) }
}

function sourceColumns(plan: SelectQueryPlan, connectionName: string): readonly string[] | undefined {
  return knownTableColumns(plan.source.table?.tableName ?? plan.source.tableName, plan.source.table, connectionName)
}

function selectionNames(plan: SelectQueryPlan, selection: QuerySelection, connectionName: string): readonly (string | undefined)[] | undefined {
  if (selection.kind === 'raw') return undefined
  if (selection.kind !== 'column' || (selection.column !== '*' && !selection.column.endsWith('.*'))) return [selectionOutputName(selection)]
  if (selection.column === '*') {
    const tables = [sourceColumns(plan, connectionName), ...plan.joins.map(join => knownJoinedColumns(join, connectionName))]
    return tables.every((columns): columns is readonly string[] => typeof columns !== 'undefined') ? tables.flat() : undefined
  }
  const qualifier = selection.column.slice(0, -2)
  if (qualifiesTable(qualifier, plan.source.tableName, plan.source.alias)) return sourceColumns(plan, connectionName)
  const join = plan.joins.find(candidate => qualifiesTable(qualifier, candidate.table, candidate.alias))
  return join && knownJoinedColumns(join, connectionName)
}

export function unionOutputColumn(plan: SelectQueryPlan, name: string): string | undefined {
  const selected = plan.selections.find(selection => selectionOutputName(selection) === name)
  if (!selected) return name
  return selected.kind === 'column' ? selected.column : undefined
}

export function assertPageableUnionOutputs(plan: SelectQueryPlan, names: readonly string[], connectionName: string): void {
  const selections: readonly QuerySelection[] = plan.selections.length === 0 ? [{ kind: 'column', column: '*' }] : plan.selections
  const outputs = selections.map(selection => selectionNames(plan, selection, connectionName))
  if (outputs.some(output => output === undefined)) {
    const name = names[0]!
    throw new CompilerError(`Cannot cursor paginate a union by "${name}": more than one of its selected columns may be named "${name}". Select it under a name no other column has.`)
  }
  const known = outputs.flat()
  const duplicate = known.find((output, index) => output !== undefined && known.indexOf(output) !== index)
  if (duplicate !== undefined) {
    throw new CompilerError(`Cannot cursor paginate a union whose first query selects more than one column named "${duplicate}". Select each column under a name no other column has.`)
  }
  const missing = names.find(name => !known.includes(name))
  if (missing !== undefined) {
    throw new CompilerError(`Cannot cursor paginate a union by "${missing}": the first query in the union doesn't select it. Select the order column in each query.`)
  }
}
