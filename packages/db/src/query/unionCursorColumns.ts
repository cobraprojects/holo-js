import { CompilerError } from '../core/errors'
import type { QuerySelection, SelectQueryPlan } from './ast'
import { knownJoinedColumns, knownTableColumns, qualifiesTable, selectionOutputName } from './modelRowProjection'

type UnionOutput = { readonly names: readonly string[] | undefined, readonly column?: string, readonly positioned: boolean }

function unpositioned(names: readonly string[] | undefined): UnionOutput {
  return { names, positioned: false }
}

function joinColumns(branch: SelectQueryPlan, qualifier: string, connectionName: string): readonly string[] | undefined {
  const join = branch.joins.find(candidate => qualifiesTable(qualifier, candidate.table, candidate.alias))
  return join ? knownJoinedColumns(join, connectionName) : undefined
}

function sourceColumns(branch: SelectQueryPlan, connectionName: string): readonly string[] | undefined {
  const { source } = branch
  return knownTableColumns(source.table?.tableName ?? source.tableName, source.table, connectionName)
}

function selectionOutput(branch: SelectQueryPlan, selection: QuerySelection, connectionName: string): UnionOutput {
  if (selection.kind === 'raw') return unpositioned(undefined)
  const name = selectionOutputName(selection)
  if (selection.kind !== 'column') return { names: typeof name === 'string' ? [name] : undefined, positioned: true }
  if (selection.column === '*') {
    const tables = [sourceColumns(branch, connectionName), ...branch.joins.map(join => joinColumns(branch, join.alias ?? join.table ?? '', connectionName))]
    return unpositioned(tables.every((columns): columns is readonly string[] => typeof columns !== 'undefined') ? tables.flat() : undefined)
  }
  if (!selection.column.endsWith('.*')) return { names: [name!], column: selection.column, positioned: true }
  const qualifier = selection.column.slice(0, -2)
  return unpositioned(qualifiesTable(qualifier, branch.source.tableName, branch.source.alias) ? sourceColumns(branch, connectionName) : joinColumns(branch, qualifier, connectionName))
}

function branchOutputs(branch: SelectQueryPlan, connectionName: string): readonly UnionOutput[] {
  const selections: readonly QuerySelection[] = branch.selections.length === 0 ? [{ kind: 'column', column: '*' }] : branch.selections
  return selections.map(selection => selectionOutput(branch, selection, connectionName))
}

function outputPosition(plan: SelectQueryPlan, column: string, connectionName: string): number | undefined {
  const outputs = branchOutputs(plan, connectionName)
  const named = outputs.findIndex(output => output.names?.includes(column))
  const position = named === -1 ? outputs.findIndex(output => output.column === column) : named
  if (position === -1) return undefined
  if (outputs.slice(position + 1).some(output => !output.names || output.names.includes(column))) {
    throw new CompilerError(`Cannot cursor paginate a union by "${column}": more than one of its selected columns may be named "${column}". Select it under a name no other column has.`)
  }
  return outputs.slice(0, position + 1).every(output => output.positioned) ? position : undefined
}

function namedBranchColumn(branch: SelectQueryPlan, column: string): string {
  const aliased = branch.selections.find(selection => selection.kind === 'column' && selection.alias === column)
  if (aliased?.kind === 'column') return aliased.column
  if (branch.joins.length === 0 || column.includes('.') || !branch.source.table || !Object.hasOwn(branch.source.table.columns, column)) return column
  return `${branch.source.alias ?? branch.source.tableName}.${column}`
}

function positionedBranchColumn(branch: SelectQueryPlan, column: string, position: number, connectionName: string): string {
  const outputs = branchOutputs(branch, connectionName)
  const output = outputs.slice(0, position).every(candidate => candidate.positioned) ? outputs[position] : undefined
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
