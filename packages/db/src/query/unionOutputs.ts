import { CompilerError } from '../core/errors'
import type { QueryOrderBy, QuerySelection, SelectQueryPlan } from './ast'
import { knownJoinedColumns, knownTableColumns, qualifiesTable, resolveSourceColumnName, selectionOutputName } from './modelRowProjection'

function sameColumnReference(plan: SelectQueryPlan, left: string, right: string): boolean {
  if (left === right) return true
  const source = resolveSourceColumnName(plan.source, left)
  return source !== undefined && source === resolveSourceColumnName(plan.source, right)
}

function sameOutputName(left: string | undefined, right: string, caseSensitive: boolean): boolean {
  return left !== undefined && (caseSensitive ? left === right : left.toLowerCase() === right.toLowerCase())
}

function selectedOutput(plan: SelectQueryPlan, column: string, caseSensitive: boolean): QuerySelection | undefined {
  return plan.selections.find(selection => sameOutputName(selectionOutputName(selection), column, caseSensitive))
    ?? plan.selections.find(selection => selection.kind === 'column' && sameColumnReference(plan, selection.column, column))
}

export function unionOutputName(plan: SelectQueryPlan, column: string, caseSensitive: boolean): string {
  const selected = selectedOutput(plan, column, caseSensitive)
  return (selected && selectionOutputName(selected)) ?? column.slice(column.lastIndexOf('.') + 1)
}

export function unionOutputOrder(plan: SelectQueryPlan, orderBy: QueryOrderBy, caseSensitive: boolean): QueryOrderBy {
  if (orderBy.kind !== 'column' || orderBy.column.includes('->')) return orderBy
  return { ...orderBy, column: unionOutputName(plan, orderBy.column, caseSensitive) }
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

export function unionOutputValueColumn(plan: SelectQueryPlan, column: string, connectionName: string, caseSensitive: boolean): string | undefined {
  const selected = selectedOutput(plan, column, caseSensitive)
  if (selected?.kind === 'column') return selected.column
  if (selected?.kind === 'aggregate') return selected.aggregate === 'min' || selected.aggregate === 'max' ? selected.column : undefined
  if (selected) return undefined
  return column.includes('.') ? column : wildcardOwnerColumn(plan, column, connectionName) ?? column
}

function wildcardOwnerColumn(plan: SelectQueryPlan, name: string, connectionName: string): string | undefined {
  const selections: readonly QuerySelection[] = plan.selections.length === 0 ? [{ kind: 'column', column: '*' }] : plan.selections
  for (const selection of selections) {
    if (selection.kind !== 'column' || (selection.column !== '*' && !selection.column.endsWith('.*'))) continue
    const qualifier = selection.column === '*' ? undefined : selection.column.slice(0, -2)
    const ownsSource = (qualifier === undefined || qualifiesTable(qualifier, plan.source.tableName, plan.source.alias)) && sourceColumns(plan, connectionName)?.includes(name)
    if (ownsSource) return plan.joins.length === 0 ? name : `${plan.source.alias ?? plan.source.tableName}.${name}`
    const join = plan.joins.find(candidate => (qualifier === undefined || qualifiesTable(qualifier, candidate.table, candidate.alias)) && knownJoinedColumns(candidate, connectionName)?.includes(name))
    if (join) return `${join.alias ?? join.table}.${name}`
  }
  return undefined
}

export function pageableUnionOutputNames(plan: SelectQueryPlan, names: readonly string[], connectionName: string, caseSensitiveNames: boolean): readonly string[] {
  const selections: readonly QuerySelection[] = plan.selections.length === 0 ? [{ kind: 'column', column: '*' }] : plan.selections
  const outputs = selections.map(selection => selectionNames(plan, selection, connectionName))
  if (outputs.some(output => output === undefined)) {
    const name = names[0]!
    throw new CompilerError(`Cannot cursor paginate a union by "${name}": more than one of its selected columns may be named "${name}". Select it under a name no other column has.`)
  }
  const identifier = (name: string) => caseSensitiveNames ? name : name.toLowerCase()
  const known = outputs.flat().flatMap(output => output === undefined ? [] : [output])
  const duplicate = known.find((output, index) => known.findIndex(other => identifier(other) === identifier(output)) !== index)
  if (duplicate !== undefined) {
    throw new CompilerError(`Cannot cursor paginate a union whose first query selects more than one column named "${identifier(duplicate)}". Select each column under a name no other column has.`)
  }
  return names.map((name) => {
    const output = known.find(candidate => identifier(candidate) === identifier(name))
    if (output === undefined) {
      throw new CompilerError(`Cannot cursor paginate a union by "${name}": the first query in the union doesn't select it. Select the order column in each query.`)
    }
    return output
  })
}
