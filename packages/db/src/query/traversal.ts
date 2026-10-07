import { rebindDatabaseQueryObservationResult } from '../cache'
import { resolveTablePrimaryKey } from '../schema/tablePrimaryKey'
import type { TableDefinition } from '../schema/types'
import { compareChunkValuesAscending, compareChunkValuesDescending } from './chunkOrdering'
import type { QueryDirection } from './ast'
import type { TableQueryBuilder } from './TableQueryBuilder'
import type { CursorPaginatedResult } from './types'

type IdTraversal = {
  readonly column: string
  readonly direction: QueryDirection
  readonly primaryKey?: string
}

export async function* queryIdBatches<
  TTable extends string | TableDefinition,
  TSelectedRow extends Record<string, unknown>,
  TAvailableColumns extends Record<string, unknown>,
  TRow extends Record<string, unknown>,
  TValue,
>(
  input: TableQueryBuilder<TTable, TSelectedRow, TAvailableColumns>,
  size: number,
  traversal: IdTraversal,
  transform: (rows: readonly TRow[]) => readonly TValue[] | Promise<readonly TValue[]>,
): AsyncGenerator<readonly TValue[], void, unknown> {
  const plan = input.getPlan()
  const tableName = plan.source.alias ?? plan.source.tableName
  const column = `${tableName}.${traversal.column}`
  const primaryKey = traversal.primaryKey ?? resolveTablePrimaryKey(plan.source.table)
  const cursorColumns = [...new Set([
    column,
    `${tableName}.${primaryKey}`,
    ...(plan.source.table ? [`${tableName}.${resolveTablePrimaryKey(plan.source.table)}`] : []),
  ])]
  const selectedColumn = plan.selections.find(selection =>
    selection.kind === 'column' && (selection.column === traversal.column || selection.column === column),
  )
  const canOrder = (plan.groupBy.length === 0 || plan.groupBy.includes(traversal.column) || plan.groupBy.includes(column))
    && ((!plan.distinct && plan.unions.length === 0) || plan.selections.length === 0 || selectedColumn !== undefined)
  const orderColumn = plan.unions.length > 0 && selectedColumn?.kind === 'column'
    ? selectedColumn.alias ?? traversal.column
    : column
  let query: TableQueryBuilder<TTable, Record<string, unknown>, TAvailableColumns> = input.limit(undefined).offset(undefined)
  if (canOrder) query = query.reorder(orderColumn as keyof TAvailableColumns & string, traversal.direction)
  const bounded = !plan.distinct && plan.joins.length === 0 && plan.groupBy.length === 0 && plan.unions.length === 0
    && !plan.selections.some(selection => selection.kind === 'aggregate' || selection.kind === 'raw')
    && (plan.source.table !== undefined || traversal.primaryKey !== undefined || traversal.column === 'id')
  if (!bounded) {
    const rows = await query.get<TRow>()
    const key = selectedColumn?.kind === 'column' ? selectedColumn.alias ?? traversal.column : traversal.column
    const compare = traversal.direction === 'asc' ? compareChunkValuesAscending : compareChunkValuesDescending
    rows.sort((left, right) => compare(left[key], right[key]))
    const values = await transform(rows)
    for (let index = 0; index < values.length; index += size) yield values.slice(index, index + size)
    return
  }
  for (const cursorColumn of cursorColumns.slice(1)) query = query.orderBy(cursorColumn as keyof TAvailableColumns & string)
  const hiddenColumns: string[] = []
  if (plan.selections.length > 0) {
    const selectedNames = new Set([
      ...Object.keys(plan.source.table?.columns ?? {}),
      ...plan.selections.map(selection => selection.kind === 'column' ? selection.alias ?? selection.column.split('.').at(-1) : 'alias' in selection ? selection.alias : undefined),
    ])
    for (const cursorColumn of cursorColumns) {
      let alias = `__holo_chunk_${hiddenColumns.length}`
      while (selectedNames.has(alias)) alias += '_'
      hiddenColumns.push(alias)
      selectedNames.add(alias)
      query = query.addSelect(`${cursorColumn} as ${alias}` as `${keyof TAvailableColumns & string} as ${string}`)
    }
  }
  let cursor: string | null = null
  do {
    const batch: CursorPaginatedResult<TRow> = await query.cursorPaginate<TRow>(size, cursor)
    if (batch.data.length === 0) return
    const rows = hiddenColumns.length === 0 ? batch.data : batch.data.map(row => {
      const attributes = { ...row }
      for (const hiddenColumn of hiddenColumns) delete attributes[hiddenColumn]
      return attributes
    })
    rebindDatabaseQueryObservationResult(batch.data, rows)
    yield await transform(rows)
    cursor = batch.nextCursor
  } while (cursor !== null)
}
