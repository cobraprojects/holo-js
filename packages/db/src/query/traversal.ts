import { rebindDatabaseQueryObservationResult } from '../cache'
import { resolveTablePrimaryKey } from '../schema/tablePrimaryKey'
import type { TableDefinition } from '../schema/types'
import { compareChunkValuesAscending, compareChunkValuesDescending } from './chunkOrdering'
import type { QueryDirection } from './ast'
import type { TableQueryBuilder } from './TableQueryBuilder'
import type { CursorPaginatedResult } from './types'

type QueryTraversal = {
  readonly column?: string
  readonly direction?: QueryDirection
  readonly primaryKey?: string
  readonly fallbackOrder?: 'database' | 'rows'
}

export async function* queryBatches<
  TTable extends string | TableDefinition,
  TSelectedRow extends Record<string, unknown>,
  TAvailableColumns extends Record<string, unknown>,
  TRow extends Record<string, unknown>,
  TValue,
>(
  input: TableQueryBuilder<TTable, TSelectedRow, TAvailableColumns>,
  size: number,
  traversal: QueryTraversal,
  transform: (rows: readonly TRow[]) => readonly TValue[] | Promise<readonly TValue[]>,
): AsyncGenerator<readonly TValue[], void, unknown> {
  const plan = input.getPlan()
  const tableName = plan.source.alias ?? plan.source.tableName
  const primaryKey = traversal.primaryKey ?? resolveTablePrimaryKey(plan.source.table)
  const idColumn = traversal.column === undefined ? undefined : traversal.column.includes('.') ? traversal.column : `${tableName}.${traversal.column}`
  const selectedColumn = plan.selections.find(selection =>
    selection.kind === 'column' && (selection.column === traversal.column || selection.column === idColumn),
  )
  let query: TableQueryBuilder<TTable, Record<string, unknown>, TAvailableColumns> = input.limit(undefined).offset(undefined)
  if (traversal.column && traversal.fallbackOrder === 'database') {
    const canOrder = (plan.groupBy.length === 0 || plan.groupBy.includes(traversal.column) || plan.groupBy.includes(idColumn!))
      && ((!plan.distinct && plan.unions.length === 0) || plan.selections.length === 0 || selectedColumn !== undefined)
    const orderColumn = plan.unions.length > 0 && selectedColumn?.kind === 'column'
      ? selectedColumn.alias ?? traversal.column
      : idColumn!
    if (canOrder) query = query.reorder(orderColumn as keyof TAvailableColumns & string, traversal.direction)
  }
  const idDefinition = traversal.column ? plan.source.table?.columns[traversal.column.split('.').at(-1)!] : undefined
  const nullableId = idDefinition?.nullable ?? (idColumn !== undefined && idColumn !== `${tableName}.${primaryKey}`)
  const requiresRowNullOrder = traversal.column !== undefined && traversal.fallbackOrder !== 'database'
    && nullableId && query.getConnection().getDialect().name.includes('postgres')
  const hasPrimaryKey = plan.source.table !== undefined
    ? Object.values(plan.source.table.columns).some(column => column.primaryKey)
    : traversal.primaryKey !== undefined
  const bounded = hasPrimaryKey && !requiresRowNullOrder && !plan.distinct && plan.joins.length === 0 && plan.groupBy.length === 0 && plan.unions.length === 0
    && !plan.selections.some(selection => selection.kind === 'aggregate' || selection.kind === 'raw')
    && (traversal.fallbackOrder === 'database' || plan.orderBy.every(order => order.kind === 'column'))
  if (!bounded) {
    const fetchedRows = await query.get<TRow>()
    const sortRows = traversal.column !== undefined && traversal.fallbackOrder !== 'database'
    const rows = sortRows ? [...fetchedRows] : fetchedRows
    if (traversal.column && sortRows) {
      const key = selectedColumn?.kind === 'column' ? selectedColumn.alias ?? selectedColumn.column.split('.').at(-1)! : traversal.column.split('.').at(-1)!
      const compare = traversal.direction === 'desc' ? compareChunkValuesDescending : compareChunkValuesAscending
      rows.sort((left, right) => compare(left[key], right[key]))
      rebindDatabaseQueryObservationResult(fetchedRows, rows)
    }
    const values = await transform(rows)
    for (let index = 0; index < values.length; index += size) yield values.slice(index, index + size)
    return
  }
  const requestedOrders = plan.orderBy.flatMap(order => {
    if (order.kind !== 'column') return []
    const selection = plan.selections.find(selection => selection.kind === 'column' && selection.alias === order.column)
    return [{ column: selection?.kind === 'column' ? selection.column : order.column, direction: order.direction }]
  })
  const orders = idColumn
    ? [
        { column: idColumn, direction: traversal.direction ?? 'asc' },
        ...(traversal.fallbackOrder === 'database' ? [] : requestedOrders.filter(order => order.column !== traversal.column && order.column !== idColumn)),
      ]
    : requestedOrders
  for (const key of [...new Set([primaryKey, ...(plan.source.table ? [resolveTablePrimaryKey(plan.source.table)] : [])])]) {
    if (!orders.some(order => order.column === key || order.column === `${tableName}.${key}`)) {
      orders.push({ column: `${tableName}.${key}`, direction: 'asc' })
    }
  }
  query = query.reorder()
  for (const order of orders) query = query.orderBy(order.column as keyof TAvailableColumns & string, order.direction)
  const cursorColumns = orders.map(order => order.column)
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
