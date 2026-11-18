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

export function assertUnambiguousUnionOutputs(plan: SelectQueryPlan, names: readonly string[], connectionName: string): void {
  const selections: readonly QuerySelection[] = plan.selections.length === 0 ? [{ kind: 'column', column: '*' }] : plan.selections
  const outputs = selections.map(selection => selectionNames(plan, selection, connectionName))
  const hidesNames = outputs.some(output => output === undefined)
  const ambiguous = names.find(name => hidesNames || outputs.flat().filter(output => output === name).length > 1)
  if (ambiguous !== undefined) {
    throw new CompilerError(`Cannot cursor paginate a union by "${ambiguous}": more than one of its selected columns may be named "${ambiguous}". Select it under a name no other column has.`)
  }
}
