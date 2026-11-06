import { CompilerError } from '../core/errors'
import type { QuerySelection, SelectQueryPlan } from './ast'
import { knownJoinedColumns, knownTableColumns, qualifiesTable, selectionOutputName } from './modelRowProjection'

type UnionOutput = { readonly name?: string, readonly column?: string } | undefined

function qualifiedOutputs(qualifier: string, columns: readonly string[] | undefined): readonly UnionOutput[] {
  return columns ? columns.map(name => ({ name, column: `${qualifier}.${name}` })) : [undefined]
}

function sourceOutputs(branch: SelectQueryPlan, connectionName: string): readonly UnionOutput[] {
  const { source } = branch
  return qualifiedOutputs(source.alias ?? source.tableName, knownTableColumns(source.table?.tableName ?? source.tableName, source.table, connectionName))
}

function joinOutputs(branch: SelectQueryPlan, qualifier: string, connectionName: string): readonly UnionOutput[] {
  const join = branch.joins.find(candidate => qualifiesTable(qualifier, candidate.table, candidate.alias))
  return qualifiedOutputs(qualifier, join ? knownJoinedColumns(join, connectionName) : undefined)
}

function selectionOutputs(branch: SelectQueryPlan, selection: QuerySelection, connectionName: string): readonly UnionOutput[] {
  if (selection.kind === 'raw') return [undefined]
  if (selection.kind !== 'column') return [{ name: selectionOutputName(selection) }]
  if (selection.column === '*') {
    return [...sourceOutputs(branch, connectionName), ...branch.joins.flatMap(join => joinOutputs(branch, join.alias ?? join.table ?? '', connectionName))]
  }
  if (!selection.column.endsWith('.*')) return [{ name: selectionOutputName(selection), column: selection.column }]
  const qualifier = selection.column.slice(0, -2)
  return qualifiesTable(qualifier, branch.source.tableName, branch.source.alias) ? sourceOutputs(branch, connectionName) : joinOutputs(branch, qualifier, connectionName)
}

function branchOutputs(branch: SelectQueryPlan, connectionName: string): readonly UnionOutput[] {
  const selections: readonly QuerySelection[] = branch.selections.length === 0 ? [{ kind: 'column', column: '*' }] : branch.selections
  return selections.flatMap(selection => selectionOutputs(branch, selection, connectionName))
}

function outputPosition(plan: SelectQueryPlan, column: string, connectionName: string): number | undefined {
  const outputs = branchOutputs(plan, connectionName)
  const position = outputs.findIndex(output => output?.name === column || output?.column === column)
  if (position === -1) return undefined
  if (outputs.slice(position + 1).some(output => !output || output.name === column)) {
    throw new CompilerError(`Cannot cursor paginate a union by "${column}": more than one of its selected columns may be named "${column}". Select it under a name no other column has.`)
  }
  return outputs.slice(0, position).includes(undefined) ? undefined : position
}

function namedBranchColumn(branch: SelectQueryPlan, column: string): string {
  const aliased = branch.selections.find(selection => selection.kind === 'column' && selection.alias === column)
  if (aliased?.kind === 'column') return aliased.column
  if (branch.joins.length === 0 || column.includes('.') || !branch.source.table || !Object.hasOwn(branch.source.table.columns, column)) return column
  return `${branch.source.alias ?? branch.source.tableName}.${column}`
}

function positionedBranchColumn(branch: SelectQueryPlan, column: string, position: number, connectionName: string): string {
  const outputs = branchOutputs(branch, connectionName)
  const output = outputs.slice(0, position).includes(undefined) ? undefined : outputs[position]
  if (!output?.column) {
    throw new CompilerError(`Cannot cursor paginate a union by "${column}": a query in the union doesn't select a table column at its position. Select a column at the same position in each query.`)
  }
  return output.column
}

function unionBranches(plan: SelectQueryPlan): readonly SelectQueryPlan[] {
  return [plan, ...plan.unions.flatMap(union => unionBranches(union.query))]
}

export function unionCursorColumns(plan: SelectQueryPlan, columns: readonly string[], connectionName: string): (branch: SelectQueryPlan) => readonly string[] {
  const positions = columns.map(column => outputPosition(plan, column, connectionName))
  const branchColumns = (branch: SelectQueryPlan) => columns.map((column, index) => {
    const position = positions[index]
    return typeof position === 'undefined' ? namedBranchColumn(branch, column) : positionedBranchColumn(branch, column, position, connectionName)
  })
  for (const branch of unionBranches(plan)) branchColumns(branch)
  return branchColumns
}
