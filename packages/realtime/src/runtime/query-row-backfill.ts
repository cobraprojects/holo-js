import { TableQueryBuilder } from '@holo-js/db'
import {
  createBackfillQueryKey,
  isOffsetOrderedLimitedWindow,
  readQueryRowWindowMode,
} from './query-metadata'
import {
  createBackfillSelection,
  getBackfillDatabaseConnection,
} from './query-backfill'
import {
  applySortedRowsWindow,
  sortRowsForQuery,
} from './query-row-ordering'
import {
  hydrateBelongsToRow,
} from './query-belongs-to-hydration'
import {
  hydrateRelatedRow,
} from './query-related-hydration'
import {
  upsertPatchRowLazily,
} from './query-row-patching'
import type {
  BackfillRows,
  DatabaseQueryObservation,
} from './query-state'
import type { BackfillCache } from './state'
import {
  getGroupedExactRowBackfill,
  getGroupedWindowRowBackfill,
} from './query-row-grouped-backfill'

async function fetchLimitedQueryBackfillRows(
  query: DatabaseQueryObservation,
  offset: number,
  limit: number,
): Promise<BackfillRows | undefined> {
  const connection = getBackfillDatabaseConnection(query.connectionName)
  if (!connection) {
    return undefined
  }

  let builder = new TableQueryBuilder<string, Record<string, unknown>>(query.tableName, connection)
  const selections = query.selections ?? []
  if (selections.length > 0) {
    builder = builder.select(...selections.map(createBackfillSelection))
  }
  for (const predicate of query.predicates) {
    builder = builder.where(predicate.column, predicate.operator, predicate.value)
  }
  for (const order of query.orderBy) {
    builder = builder.orderBy(order.column, order.direction)
  }

  return await builder
    .offset(offset)
    .limit(limit)
    .get()
}

export async function backfillLimitedQueryRows(
  query: DatabaseQueryObservation,
  rows: readonly Readonly<Record<string, unknown>>[],
  backfills: BackfillCache,
): Promise<readonly Readonly<Record<string, unknown>>[] | undefined> {
  const limit = query.limit
  if (readQueryRowWindowMode(query) !== 'limited' || typeof limit !== 'number' || rows.length >= limit) {
    return undefined
  }

  const missingRows = limit - rows.length
  const backfillKey = createBackfillQueryKey(query, rows.length, missingRows)
  const pendingBackfill = backfills.rows.get(backfillKey) ?? fetchLimitedQueryBackfillRows(query, rows.length, missingRows)
  backfills.rows.set(backfillKey, pendingBackfill)

  const backfilledRows = await hydrateBackfilledRows(query, await pendingBackfill, backfills)
  if (!backfilledRows) {
    return undefined
  }

  let nextRows: Readonly<Record<string, unknown>>[] | undefined
  for (const row of backfilledRows) {
    const upsertedRows = upsertPatchRowLazily(rows, nextRows, row, undefined, query)
    if (upsertedRows) {
      nextRows = upsertedRows
    }
  }

  const sortedRows = sortRowsForQuery(nextRows ?? rows, query)
  if (!sortedRows) {
    return undefined
  }

  return applySortedRowsWindow(sortedRows, query)
}

export async function backfillOffsetQueryRows(
  query: DatabaseQueryObservation,
  backfills: BackfillCache,
): Promise<readonly Readonly<Record<string, unknown>>[] | undefined> {
  const { limit, offset } = query
  if (typeof limit !== 'number' || typeof offset !== 'number') {
    return undefined
  }

  const groupedRows = await getGroupedWindowRowBackfill(query, backfills, offset, limit)
  if (groupedRows) {
    return await hydrateBackfilledRows(query, groupedRows, backfills)
  }

  const backfillKey = createBackfillQueryKey(query, offset, limit)
  const pendingBackfill = backfills.rows.get(backfillKey) ?? fetchLimitedQueryBackfillRows(query, offset, limit)
  backfills.rows.set(backfillKey, pendingBackfill)

  return await hydrateBackfilledRows(query, await pendingBackfill, backfills)
}

export async function backfillCurrentQueryRows(
  query: DatabaseQueryObservation,
  backfills: BackfillCache,
): Promise<readonly Readonly<Record<string, unknown>>[] | undefined> {
  const limit = query.limit
  if (typeof limit !== 'number') {
    return undefined
  }

  const mode = readQueryRowWindowMode(query)
  const offset = query.offset ?? 0
  if (mode !== 'single' && mode !== 'limited' && !isOffsetOrderedLimitedWindow(query)) {
    return undefined
  }

  if (mode === 'single') {
    const groupedRows = await getGroupedExactRowBackfill(query, backfills)
    if (groupedRows) {
      return await hydrateBackfilledRows(query, groupedRows, backfills)
    }
  }

  const groupedRows = await getGroupedWindowRowBackfill(query, backfills, offset, limit)
  if (groupedRows) {
    return await hydrateBackfilledRows(query, groupedRows, backfills)
  }

  const backfillKey = createBackfillQueryKey(query, offset, limit)
  const pendingBackfill = backfills.rows.get(backfillKey) ?? fetchLimitedQueryBackfillRows(query, offset, limit)
  backfills.rows.set(backfillKey, pendingBackfill)

  return await hydrateBackfilledRows(query, await pendingBackfill, backfills)
}

async function hydrateBackfilledRows(
  query: DatabaseQueryObservation,
  rows: BackfillRows | undefined,
  backfills: BackfillCache,
): Promise<BackfillRows | undefined> {
  const belongsToHydrations = query.belongsToHydrations
  const relatedHydrations = query.relatedHydrations
  if (
    !rows
    || ((!belongsToHydrations || belongsToHydrations.length === 0)
      && (!relatedHydrations || relatedHydrations.length === 0))
  ) {
    return rows
  }

  const hydratedRows: Readonly<Record<string, unknown>>[] = []
  for (const row of rows) {
    const belongsToHydratedRow = belongsToHydrations && belongsToHydrations.length > 0
      ? await hydrateBelongsToRow(row, belongsToHydrations, backfills)
      : row

    const hydratedRow = relatedHydrations && relatedHydrations.length > 0
      ? await hydrateRelatedRow(belongsToHydratedRow, relatedHydrations, backfills)
      : belongsToHydratedRow
    if (!hydratedRow) {
      return undefined
    }

    hydratedRows.push(hydratedRow)
  }

  return Object.freeze(hydratedRows)
}
