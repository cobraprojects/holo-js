import { TableQueryBuilder, type CompiledStatement, type DatabaseContext } from '@holo-js/db'
import {
  readQueryRowWindowMode,
} from './query-metadata'
import {
  NO_EXACT_ID_PREDICATE,
  readQueryExactIdPredicateValue,
} from './predicate-matching'
import {
  isQueryObservationContradictedByExactPredicates,
} from './predicate-dependency-matching'
import {
  createBackfillSelection,
  getBackfillDatabaseConnection,
} from './query-backfill'
import type {
  BackfillRows,
  DatabaseQueryObservation,
  DatabaseQueryOrderObservation,
  DatabaseQuerySelectionObservation,
} from './query-state'
import type { BackfillCache } from './state'
import { stableStringify } from './stable-stringify'

const GROUPED_ROW_ID_ALIAS = '__holo_group_id'
const GROUPED_ROW_NUMBER_ALIAS = '__holo_row_number'

export async function getGroupedExactRowBackfill(
  query: DatabaseQueryObservation,
  backfills: BackfillCache,
): Promise<BackfillRows | undefined> {
  const rowGroups = backfills.rowGroups
  const exactId = readQueryExactIdPredicateValue(query)
  if (!rowGroups || exactId === NO_EXACT_ID_PREDICATE) {
    return undefined
  }

  const queries = collectGroupedExactRowBackfillQueries(query, backfills)
  if (queries.length < 2) {
    return undefined
  }

  const values = collectGroupedExactRowBackfillValues(queries)
  if (values.length < 2) {
    return undefined
  }

  const key = createGroupedExactRowBackfillKey(query, values)
  const pendingBackfill = rowGroups.get(key) ?? fetchGroupedExactRowBackfill(query, values)
  rowGroups.set(key, pendingBackfill)
  const rowsById = await pendingBackfill
  return rowsById?.get(exactId)
}

export async function getGroupedWindowRowBackfill(
  query: DatabaseQueryObservation,
  backfills: BackfillCache,
  offset: number,
  limit: number,
): Promise<BackfillRows | undefined> {
  const rowGroups = backfills.rowGroups
  const groupPredicate = readGroupedWindowPredicate(query)
  if (!rowGroups || !groupPredicate || query.orderBy.length === 0) {
    return undefined
  }

  const queries = collectGroupedWindowBackfillQueries(query, backfills)
  if (queries.length < 2) {
    return undefined
  }

  const values = collectGroupedWindowValues(queries)
  if (values.length < 2) {
    return undefined
  }

  const key = createGroupedWindowBackfillKey(query, groupPredicate.column, offset, limit, values)
  const pendingBackfill = rowGroups.get(key) ?? fetchGroupedWindowBackfill(query, groupPredicate.column, values, offset, limit)
  rowGroups.set(key, pendingBackfill)
  const rowsByGroup = await pendingBackfill
  return rowsByGroup?.get(groupPredicate.value)
}

function collectGroupedExactRowBackfillQueries(
  query: DatabaseQueryObservation,
  backfills: BackfillCache,
): readonly DatabaseQueryObservation[] {
  const queries: DatabaseQueryObservation[] = []
  for (const entry of backfills.entries) {
    for (const candidate of entry.queries) {
      if (
        backfills.exactPredicates
        && isQueryObservationContradictedByExactPredicates(candidate, backfills.exactPredicates) === true
      ) {
        continue
      }

      if (exactRowBackfillQueriesShareScope(query, candidate)) {
        queries.push(candidate)
      }
    }
  }

  return Object.freeze(queries)
}

function exactRowBackfillQueriesShareScope(
  query: DatabaseQueryObservation,
  candidate: DatabaseQueryObservation,
): boolean {
  return readQueryRowWindowMode(candidate) === 'single'
    && readQueryExactIdPredicateValue(candidate) !== NO_EXACT_ID_PREDICATE
    && query.connectionName === candidate.connectionName
    && query.tableName === candidate.tableName
    && selectionsEqual(query.selections ?? [], candidate.selections ?? [])
}

function selectionsEqual(
  left: readonly DatabaseQuerySelectionObservation[],
  right: readonly DatabaseQuerySelectionObservation[],
): boolean {
  if (left.length !== right.length) {
    return false
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftSelection = left[index]
    const rightSelection = right[index]
    if (
      !leftSelection
      || !rightSelection
      || leftSelection.column !== rightSelection.column
      || leftSelection.resultKey !== rightSelection.resultKey
    ) {
      return false
    }
  }

  return true
}

function collectGroupedExactRowBackfillValues(
  queries: readonly DatabaseQueryObservation[],
): readonly unknown[] {
  const values: unknown[] = []
  for (const query of queries) {
    const exactId = readQueryExactIdPredicateValue(query)
    if (exactId === NO_EXACT_ID_PREDICATE || values.some(value => Object.is(value, exactId))) {
      continue
    }

    values.push(exactId)
  }

  return Object.freeze(values)
}

function createGroupedExactRowBackfillKey(
  query: DatabaseQueryObservation,
  values: readonly unknown[],
): string {
  return '{"connectionName":'
    + stableStringify(query.connectionName)
    + ',"exactRowIds":'
    + stableStringify(values)
    + ',"selections":'
    + stableStringify(query.selections ?? [])
    + ',"tableName":'
    + stableStringify(query.tableName)
    + '}'
}

async function fetchGroupedExactRowBackfill(
  query: DatabaseQueryObservation,
  values: readonly unknown[],
): Promise<ReadonlyMap<unknown, BackfillRows> | undefined> {
  const connection = getBackfillDatabaseConnection(query.connectionName)
  if (!connection) {
    return undefined
  }

  let builder = new TableQueryBuilder<string, Record<string, unknown>>(query.tableName, connection)
  const selections = query.selections ?? []
  const usesHiddenIdentity = selections.length > 0
  if (usesHiddenIdentity) {
    builder = builder.select(...[
      ...selections.map(createBackfillSelection),
      `id as ${GROUPED_ROW_ID_ALIAS}`,
    ])
  }

  const rows = await builder
    .where('id', 'in', values)
    .get()

  const rowsById = new Map<unknown, BackfillRows>()
  for (const row of rows) {
    const id = usesHiddenIdentity ? row[GROUPED_ROW_ID_ALIAS] : row.id
    if (typeof id === 'undefined') {
      return undefined
    }

    rowsById.set(id, Object.freeze([stripGroupedRowIdentity(row, usesHiddenIdentity)]))
  }

  for (const value of values) {
    if (!rowsById.has(value)) {
      rowsById.set(value, Object.freeze([]))
    }
  }

  return rowsById
}

function stripGroupedRowIdentity(
  row: Readonly<Record<string, unknown>>,
  strip: boolean,
): Readonly<Record<string, unknown>> {
  if (!strip) {
    return row
  }

  const { [GROUPED_ROW_ID_ALIAS]: _id, ...result } = row
  return Object.freeze(result)
}

type GroupedWindowPredicate = {
  readonly column: string
  readonly value: unknown
}

function readGroupedWindowPredicate(query: DatabaseQueryObservation): GroupedWindowPredicate | undefined {
  const predicate = query.predicates[0]
  return query.predicates.length === 1 && predicate?.operator === '='
    ? { column: predicate.column, value: predicate.value }
    : undefined
}

function collectGroupedWindowBackfillQueries(
  query: DatabaseQueryObservation,
  backfills: BackfillCache,
): readonly DatabaseQueryObservation[] {
  const queries: DatabaseQueryObservation[] = []
  for (const entry of backfills.entries) {
    for (const candidate of entry.queries) {
      if (
        backfills.exactPredicates
        && isQueryObservationContradictedByExactPredicates(candidate, backfills.exactPredicates) === true
      ) {
        continue
      }

      if (groupedWindowBackfillQueriesShareScope(query, candidate)) {
        queries.push(candidate)
      }
    }
  }

  return Object.freeze(queries)
}

function groupedWindowBackfillQueriesShareScope(
  query: DatabaseQueryObservation,
  candidate: DatabaseQueryObservation,
): boolean {
  const leftPredicate = readGroupedWindowPredicate(query)
  const rightPredicate = readGroupedWindowPredicate(candidate)
  return Boolean(
    leftPredicate
    && rightPredicate
    && query.connectionName === candidate.connectionName
    && query.tableName === candidate.tableName
    && query.limit === candidate.limit
    && (query.offset ?? 0) === (candidate.offset ?? 0)
    && leftPredicate.column === rightPredicate.column
    && selectionsEqual(query.selections ?? [], candidate.selections ?? [])
    && orderByEqual(query.orderBy, candidate.orderBy),
  )
}

function orderByEqual(
  left: readonly DatabaseQueryOrderObservation[],
  right: readonly DatabaseQueryOrderObservation[],
): boolean {
  if (left.length !== right.length) {
    return false
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftOrder = left[index]
    const rightOrder = right[index]
    if (
      !leftOrder
      || !rightOrder
      || leftOrder.column !== rightOrder.column
      || leftOrder.direction !== rightOrder.direction
    ) {
      return false
    }
  }

  return true
}

function collectGroupedWindowValues(
  queries: readonly DatabaseQueryObservation[],
): readonly unknown[] {
  const values: unknown[] = []
  for (const query of queries) {
    const predicate = readGroupedWindowPredicate(query)
    if (!predicate || values.some(value => Object.is(value, predicate.value))) {
      continue
    }

    values.push(predicate.value)
  }

  return Object.freeze(values)
}

function createGroupedWindowBackfillKey(
  query: DatabaseQueryObservation,
  groupColumn: string,
  offset: number,
  limit: number,
  values: readonly unknown[],
): string {
  return '{"connectionName":'
    + stableStringify(query.connectionName)
    + ',"groupedWindowValues":'
    + stableStringify(values)
    + ',"limit":'
    + stableStringify(limit)
    + ',"offset":'
    + stableStringify(offset)
    + ',"orderBy":'
    + stableStringify(query.orderBy)
    + ',"groupColumn":'
    + stableStringify(groupColumn)
    + ',"selections":'
    + stableStringify(query.selections ?? [])
    + ',"tableName":'
    + stableStringify(query.tableName)
    + '}'
}

async function fetchGroupedWindowBackfill(
  query: DatabaseQueryObservation,
  groupColumn: string,
  values: readonly unknown[],
  offset: number,
  limit: number,
): Promise<ReadonlyMap<unknown, BackfillRows> | undefined> {
  const connection = getBackfillDatabaseConnection(query.connectionName)
  if (!connection) {
    return undefined
  }

  const rows = await connection.queryCompiled<Record<string, unknown>>(
    compileGroupedWindowBackfillStatement(connection, query, groupColumn, values, offset, limit),
  )
  return groupWindowRows(rows.rows, values)
}

function groupWindowRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  values: readonly unknown[],
): ReadonlyMap<unknown, BackfillRows> | undefined {
  const rowsByGroup = new Map<unknown, Readonly<Record<string, unknown>>[]>()
  for (const row of rows) {
    const groupValue = row[GROUPED_ROW_ID_ALIAS]
    if (typeof groupValue === 'undefined') {
      return undefined
    }

    const group = rowsByGroup.get(groupValue) ?? []
    const {
      [GROUPED_ROW_ID_ALIAS]: _groupValue,
      [GROUPED_ROW_NUMBER_ALIAS]: _rowNumber,
      ...result
    } = row

    group.push(Object.freeze(result))
    rowsByGroup.set(groupValue, group)
  }

  const result = new Map<unknown, BackfillRows>()
  for (const value of values) {
    result.set(value, Object.freeze(rowsByGroup.get(value) ?? []))
  }

  return result
}

function compileGroupedWindowBackfillStatement(
  connection: DatabaseContext,
  query: DatabaseQueryObservation,
  groupColumn: string,
  values: readonly unknown[],
  offset: number,
  limit: number,
): CompiledStatement {
  const dialect = connection.getDialect()
  const bindings: unknown[] = []
  const quote = (identifier: string): string => dialect.quoteIdentifier(identifier)
  const placeholder = (value: unknown): string => {
    bindings.push(value)
    return dialect.createPlaceholder(bindings.length)
  }
  const innerSelections = createGroupedWindowInnerSelections(query, groupColumn, quote)
  const groupPlaceholders = values.map(placeholder).join(', ')
  const whereClause = `${quote(groupColumn)} IN (${groupPlaceholders})`
  const orderBy = query.orderBy.map(order => `${quote(order.column)} ${order.direction.toUpperCase()}`).join(', ')
  const rowNumber = `ROW_NUMBER() OVER (PARTITION BY ${quote(groupColumn)} ORDER BY ${orderBy}) AS ${quote(GROUPED_ROW_NUMBER_ALIAS)}`
  const windowUpperBound = offset + limit
  const lowerBoundPlaceholder = placeholder(offset)
  const upperBoundPlaceholder = placeholder(windowUpperBound)
  const derivedAlias = quote('__holo_grouped_rows')
  const rowNumberColumn = quote(GROUPED_ROW_NUMBER_ALIAS)
  const sql = `SELECT * FROM (SELECT ${innerSelections}, ${rowNumber} FROM ${quote(query.tableName)} WHERE ${whereClause}) AS ${derivedAlias} WHERE ${rowNumberColumn} > ${lowerBoundPlaceholder} AND ${rowNumberColumn} <= ${upperBoundPlaceholder} ORDER BY ${quote(GROUPED_ROW_ID_ALIAS)} ASC, ${rowNumberColumn} ASC`

  return {
    bindings,
    metadata: {
      kind: 'select' as const,
      resultMode: 'rows' as const,
      selectedShape: {
        aggregates: [],
        columns: [],
        hasRawSelections: false,
        hasSubqueries: true,
        mode: query.selections && query.selections.length > 0 ? 'projection' as const : 'all' as const,
      },
      safety: {
        containsRawSql: false,
        unsafe: false,
      },
      debug: {
        complexity: 3 + query.orderBy.length + values.length,
        hasGrouping: false,
        hasHaving: false,
        hasJoins: false,
        hasUnions: false,
        intent: 'read' as const,
        streaming: 'buffered' as const,
        tableName: query.tableName,
        transactionAffinity: 'optional' as const,
      },
    },
    source: `realtime:grouped-window-backfill:${query.tableName}`,
    sql,
  }
}

function createGroupedWindowInnerSelections(
  query: DatabaseQueryObservation,
  groupColumn: string,
  quote: (identifier: string) => string,
): string {
  const selections = query.selections ?? []
  if (selections.length === 0) {
    return `*, ${quote(groupColumn)} AS ${quote(GROUPED_ROW_ID_ALIAS)}`
  }

  const compiledSelections = selections.map((selection) => {
    return selection.resultKey === selection.column
      ? quote(selection.column)
      : `${quote(selection.column)} AS ${quote(selection.resultKey)}`
  })
  compiledSelections.push(`${quote(groupColumn)} AS ${quote(GROUPED_ROW_ID_ALIAS)}`)

  return compiledSelections.join(', ')
}
