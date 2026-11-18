import { CompilerError } from '../core/errors'
import type { QueryOrderBy, QuerySelection, SelectQueryPlan } from './ast'
import { knownJoinedColumns, knownTableColumns, qualifiesTable, selectionOutputName } from './modelRowProjection'

type UnionOutput = { readonly names: readonly string[] | undefined, readonly column?: string, readonly qualifier?: string, readonly positioned: boolean }

export type UnionCursorColumns = {
  readonly outputNames: readonly string[]
  readonly branchColumns: (branch: SelectQueryPlan) => readonly string[]
}

export function unionOutputName(plan: SelectQueryPlan, column: string): string {
  const selected = plan.selections.find(selection => selection.kind === 'column' && selection.column === column)
  return (selected && selectionOutputName(selected)) ?? column.slice(column.lastIndexOf('.') + 1)
}

export function unionOutputOrder(plan: SelectQueryPlan, orderBy: QueryOrderBy): QueryOrderBy {
  if (orderBy.kind !== 'column' || orderBy.column.includes('->')) return orderBy
  return { ...orderBy, column: unionOutputName(plan, orderBy.column) }
}

function unpositioned(names: readonly string[] | undefined, qualifier?: string): UnionOutput {
  return { names, positioned: false, ...(qualifier === undefined ? {} : { qualifier }) }
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
  return unpositioned(qualifiesTable(qualifier, branch.source.tableName, branch.source.alias) ? sourceColumns(branch, connectionName) : joinColumns(branch, qualifier, connectionName), qualifier)
}

function branchOutputs(branch: SelectQueryPlan, connectionName: string): readonly UnionOutput[] {
  const selections: readonly QuerySelection[] = branch.selections.length === 0 ? [{ kind: 'column', column: '*' }] : branch.selections
  return selections.map(selection => selectionOutput(branch, selection, connectionName))
}

function unknownPosition(column: string): CompilerError {
  return new CompilerError(`Cannot cursor paginate a union by "${column}": its column position cannot be determined. Select the order column explicitly in each query without preceding wildcards.`)
}

function assertKnownPosition(outputs: readonly UnionOutput[], column: string): void {
  if (outputs.some(output => !output.names)) throw unknownPosition(column)
}

function outputPosition(plan: SelectQueryPlan, column: string, name: string, connectionName: string): number | undefined {
  const outputs = branchOutputs(plan, connectionName)
  const named = outputs.findIndex(output => output.names?.includes(name))
  const position = named === -1 ? outputs.findIndex(output => output.column === column) : named
  if (position !== -1 && outputs.slice(position + 1).some(output => !output.names || output.names.includes(name))) {
    throw new CompilerError(`Cannot cursor paginate a union by "${column}": more than one of its selected columns may be named "${name}". Select it under a name no other column has.`)
  }
  assertKnownPosition(outputs, column)
  if (position === -1) return undefined
  return outputs.slice(0, position + 1).every(output => output.positioned) ? position : undefined
}

function qualifiedSourceColumn(branch: SelectQueryPlan, name: string): string {
  return branch.joins.length === 0 ? name : `${branch.source.alias ?? branch.source.tableName}.${name}`
}

function wildcardColumn(branch: SelectQueryPlan, output: UnionOutput, name: string, connectionName: string): string {
  if (output.qualifier !== undefined) return `${output.qualifier}.${name}`
  if (sourceColumns(branch, connectionName)?.includes(name)) return qualifiedSourceColumn(branch, name)
  const join = branch.joins.find(candidate => knownJoinedColumns(candidate, connectionName)?.includes(name))
  return join ? `${join.alias ?? join.table}.${name}` : name
}

function namedBranchColumn(branch: SelectQueryPlan, column: string, name: string, connectionName: string): string {
  const output = branchOutputs(branch, connectionName).find(candidate => candidate.names?.includes(name))
  if (output?.column !== undefined) return output.column
  if (output) return wildcardColumn(branch, output, name, connectionName)
  if (!sourceColumns(branch, connectionName)?.includes(name)) throw unknownPosition(column)
  return qualifiedSourceColumn(branch, name)
}

function positionedBranchColumn(branch: SelectQueryPlan, column: string, name: string, position: number, connectionName: string): string {
  const outputs = branchOutputs(branch, connectionName)
  assertKnownPosition(outputs.slice(0, position + 1), column)
  if (!outputs.slice(0, position + 1).every(output => output.positioned)) return namedBranchColumn(branch, column, name, connectionName)
  const output = outputs[position]
  if (!output?.column) {
    throw new CompilerError(`Cannot cursor paginate a union by "${column}": a query in the union doesn't select a table column at its position. Select a column at the same position in each query.`)
  }
  return output.column
}

function unionBranches(plan: SelectQueryPlan): readonly SelectQueryPlan[] {
  return [plan, ...plan.unions.flatMap(union => unionBranches(union.query))]
}

export function unionCursorColumns(plan: SelectQueryPlan, columns: readonly string[], connectionName: string): UnionCursorColumns {
  const outputNames = columns.map(column => unionOutputName(plan, column))
  const positions = columns.map((column, index) => outputPosition(plan, column, outputNames[index]!, connectionName))
  const branchColumns = (branch: SelectQueryPlan) => columns.map((column, index) => {
    const name = outputNames[index]!
    const position = positions[index]
    if (typeof position !== 'undefined') return positionedBranchColumn(branch, column, name, position, connectionName)
    assertKnownPosition(branchOutputs(branch, connectionName), column)
    return namedBranchColumn(branch, column, name, connectionName)
  })
  for (const branch of unionBranches(plan)) branchColumns(branch)
  return { outputNames, branchColumns }
}
