import { TableQueryBuilder, type CompiledStatement, type DatabaseContext } from '@holo-js/db'
import type {
  DatabaseMutationEvent,
  MutationIndex,
} from './dependencies'
import {
  createMutationIndexKey,
} from './dependencies'
import {
  getBackfillDatabaseConnection,
} from './query-backfill'
import type {
  BackfillCache,
  BackfillRows,
  DatabaseQueryRelatedHydrationObservation,
} from './query-state'
import {
  matchesPredicates,
  type DatabaseQueryPredicateObservation,
} from './predicate-matching'
import { stableStringify } from './stable-stringify'

const GROUPED_RELATED_ROW_ID_ALIAS = '__holo_related_group_id'
const GROUPED_RELATED_ROW_NUMBER_ALIAS = '__holo_related_row_number'

export async function hydrateRelatedMutationRows(
  mutation: DatabaseMutationEvent,
  hydrations: readonly DatabaseQueryRelatedHydrationObservation[] | undefined,
  backfills: BackfillCache,
): Promise<DatabaseMutationEvent | undefined> {
  if (!hydrations || hydrations.length === 0 || !mutation.rows || mutation.kind === 'delete') {
    return mutation
  }

  let nextRows: Readonly<Record<string, unknown>>[] | undefined
  for (let index = 0; index < mutation.rows.length; index += 1) {
    const row = mutation.rows[index]
    if (!row) {
      return undefined
    }

    const hydrated = await hydrateRelatedRow(row, hydrations, backfills, mutation)
    if (!hydrated) {
      return undefined
    }

    if (hydrated !== row) {
      nextRows ??= [...mutation.rows.slice(0, index)]
    }

    nextRows?.push(hydrated)
  }

  if (!nextRows) {
    return mutation
  }

  return Object.freeze({
    ...mutation,
    rows: Object.freeze(nextRows),
  })
}

export async function hydrateRelatedRow(
  row: Readonly<Record<string, unknown>>,
  hydrations: readonly DatabaseQueryRelatedHydrationObservation[],
  backfills: BackfillCache,
  sourceMutation?: DatabaseMutationEvent,
): Promise<Readonly<Record<string, unknown>> | undefined> {
  let nextRow = row
  for (const hydration of hydrations) {
    const relatedValue = await readRelatedHydratedValue(
      hydration,
      row[hydration.localKey],
      backfills,
      sourceMutation,
    )
    if (typeof relatedValue === 'undefined') {
      return undefined
    }

    if (nextRow[hydration.relationKey] === relatedValue) {
      continue
    }

    nextRow = Object.freeze({
      ...nextRow,
      [hydration.relationKey]: relatedValue,
    })
  }

  return nextRow
}

async function readRelatedHydratedValue(
  hydration: DatabaseQueryRelatedHydrationObservation,
  localKey: unknown,
  backfills: BackfillCache,
  sourceMutation: DatabaseMutationEvent | undefined,
): Promise<readonly Readonly<Record<string, unknown>>[] | Readonly<Record<string, unknown>> | null | undefined> {
  if (localKey === null || typeof localKey === 'undefined') {
    return hydration.kind === 'hasMany' ? Object.freeze([]) : null
  }

  const relatedRows = await fetchRelatedRows(hydration, localKey, backfills, sourceMutation)
    ?? readRelatedMutationRows(hydration, localKey, backfills.mutations)
  if (!relatedRows) {
    return undefined
  }

  const orderedRows = orderRelatedRows(relatedRows, hydration)
  return hydration.kind === 'hasMany'
    ? orderedRows
    : orderedRows[0] ?? null
}

function readRelatedMutationRows(
  hydration: DatabaseQueryRelatedHydrationObservation,
  localKey: unknown,
  mutations: MutationIndex,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  const relatedMutations = mutations.get(createMutationIndexKey(
    hydration.relatedConnectionName,
    hydration.relatedTableName,
  ))
  if (!relatedMutations) {
    return undefined
  }

  const rows: Readonly<Record<string, unknown>>[] = []
  for (const mutation of relatedMutations) {
    if (mutation.kind === 'delete' || !mutation.rows) {
      continue
    }

    for (const row of mutation.rows) {
      const matches = row[hydration.foreignKey] === localKey && matchesPredicates(row, hydration.predicates) === true
      if (matches) {
        rows.push(row)
      }
    }
  }

  return rows.length > 0 ? Object.freeze(rows) : undefined
}

function orderRelatedRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  hydration: DatabaseQueryRelatedHydrationObservation,
): readonly Readonly<Record<string, unknown>>[] {
  if (hydration.orderBy.length === 0) {
    return rows
  }

  return Object.freeze([...rows].sort((left, right) => compareRelatedRows(left, right, hydration)))
}

function compareRelatedRows(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  hydration: DatabaseQueryRelatedHydrationObservation,
): number {
  for (const order of hydration.orderBy) {
    const result = compareRelatedValues(left[order.column], right[order.column])
    if (result !== 0) {
      return order.direction === 'desc' ? -result : result
    }
  }

  return 0
}

function compareRelatedValues(left: unknown, right: unknown): number {
  if (left === right) {
    return 0
  }

  if (left === null || typeof left === 'undefined') {
    return -1
  }

  if (right === null || typeof right === 'undefined') {
    return 1
  }

  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  })
}

async function fetchRelatedRows(
  hydration: DatabaseQueryRelatedHydrationObservation,
  localKey: unknown,
  backfills: BackfillCache,
  sourceMutation: DatabaseMutationEvent | undefined,
): Promise<readonly Readonly<Record<string, unknown>>[] | undefined> {
  const groupedRows = await fetchGroupedRelatedRows(hydration, localKey, backfills, sourceMutation)
  if (groupedRows) {
    return groupedRows
  }

  const backfillKey = createRelatedHydrationBackfillKey(hydration, localKey)
  const pendingBackfill = backfills.rows.get(backfillKey) ?? fetchRelatedHydrationRows(hydration, localKey)
  backfills.rows.set(backfillKey, pendingBackfill)
  return await pendingBackfill
}

async function fetchGroupedRelatedRows(
  hydration: DatabaseQueryRelatedHydrationObservation,
  localKey: unknown,
  backfills: BackfillCache,
  sourceMutation: DatabaseMutationEvent | undefined,
): Promise<BackfillRows | undefined> {
  if (!sourceMutation || !backfills.rowGroups) {
    return undefined
  }

  const values = collectRelatedLocalKeys(hydration, sourceMutation, backfills.mutations)
  if (values.length < 2) {
    return undefined
  }

  const backfillKey = createGroupedRelatedHydrationBackfillKey(hydration, values)
  const pendingBackfill = backfills.rowGroups.get(backfillKey) ?? fetchGroupedRelatedHydrationRows(hydration, values)
  backfills.rowGroups.set(backfillKey, pendingBackfill)

  const rowsByLocalKey = await pendingBackfill
  return rowsByLocalKey?.get(localKey)
}

function collectRelatedLocalKeys(
  hydration: DatabaseQueryRelatedHydrationObservation,
  sourceMutation: DatabaseMutationEvent,
  mutationIndex: MutationIndex,
): readonly unknown[] {
  const sourceMutations = mutationIndex.get(createMutationIndexKey(sourceMutation.connectionName, sourceMutation.tableName))
  if (!sourceMutations) {
    return Object.freeze([])
  }

  const values: unknown[] = []
  for (const mutation of sourceMutations) {
    if (!mutation.rows || mutation.kind === 'delete') {
      continue
    }

    for (const row of mutation.rows) {
      const localKey = row[hydration.localKey]
      if (
        localKey === null
        || typeof localKey === 'undefined'
        || values.some(value => Object.is(value, localKey))
      ) {
        continue
      }

      values.push(localKey)
    }
  }

  return Object.freeze(values)
}

async function fetchGroupedRelatedHydrationRows(
  hydration: DatabaseQueryRelatedHydrationObservation,
  values: readonly unknown[],
): Promise<ReadonlyMap<unknown, BackfillRows> | undefined> {
  const connection = getBackfillDatabaseConnection(hydration.relatedConnectionName)
  if (!connection) {
    return undefined
  }

  if (!canBackfillRelatedHydrationPredicates(hydration.predicates)) {
    return undefined
  }

  if (hydration.kind === 'hasOne' && hydration.orderBy.length > 0) {
    const topOneRows = await fetchGroupedRelatedTopOneRows(connection, hydration, values)
    if (topOneRows) {
      return topOneRows
    }
  }

  let builder = new TableQueryBuilder<string, Record<string, unknown>>(
    hydration.relatedTableName,
    connection,
  ).where(hydration.foreignKey, 'in', values)
  for (const predicate of hydration.predicates) {
    builder = builder.where(predicate.column, predicate.operator, predicate.value)
  }
  for (const order of hydration.orderBy) {
    builder = builder.orderBy(order.column, order.direction)
  }

  const rows = await builder.get()
  const rowsByLocalKey = new Map<unknown, Readonly<Record<string, unknown>>[]>()
  for (const row of rows) {
    const localKey = row[hydration.foreignKey]
    if (typeof localKey === 'undefined') {
      return undefined
    }

    const group = rowsByLocalKey.get(localKey) ?? []
    group.push(row)
    rowsByLocalKey.set(localKey, group)
  }

  const result = new Map<unknown, BackfillRows>()
  for (const value of values) {
    result.set(value, Object.freeze(rowsByLocalKey.get(value) ?? []))
  }

  return result
}

async function fetchGroupedRelatedTopOneRows(
  connection: DatabaseContext,
  hydration: DatabaseQueryRelatedHydrationObservation,
  values: readonly unknown[],
): Promise<ReadonlyMap<unknown, BackfillRows> | undefined> {
  const statement = compileGroupedRelatedTopOneStatement(connection, hydration, values)
  const rows = await connection.queryCompiled<Record<string, unknown>>(statement)
  return groupRelatedTopOneRows(rows.rows, values)
}

function groupRelatedTopOneRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  values: readonly unknown[],
): ReadonlyMap<unknown, BackfillRows> | undefined {
  const rowsByLocalKey = new Map<unknown, BackfillRows>()
  for (const row of rows) {
    const localKey = row[GROUPED_RELATED_ROW_ID_ALIAS]
    if (typeof localKey === 'undefined') {
      return undefined
    }

    const {
      [GROUPED_RELATED_ROW_ID_ALIAS]: _groupValue,
      [GROUPED_RELATED_ROW_NUMBER_ALIAS]: _rowNumber,
      ...result
    } = row
    rowsByLocalKey.set(localKey, Object.freeze([Object.freeze(result)]))
  }

  const result = new Map<unknown, BackfillRows>()
  for (const value of values) {
    result.set(value, rowsByLocalKey.get(value) ?? Object.freeze([]))
  }

  return result
}

function compileGroupedRelatedTopOneStatement(
  connection: DatabaseContext,
  hydration: DatabaseQueryRelatedHydrationObservation,
  values: readonly unknown[],
): CompiledStatement {
  const dialect = connection.getDialect()
  const bindings: unknown[] = []
  const quote = (identifier: string): string => dialect.quoteIdentifier(identifier)
  const placeholder = (value: unknown): string => {
    bindings.push(value)
    return dialect.createPlaceholder(bindings.length)
  }
  const groupPlaceholders = values.map(placeholder).join(', ')
  const predicateClauses = compileRelatedTopOnePredicateClauses(hydration, quote, placeholder)
  const whereClause = [
    `${quote(hydration.foreignKey)} IN (${groupPlaceholders})`,
    ...predicateClauses,
  ].join(' AND ')
  const orderBy = hydration.orderBy.map(order => `${quote(order.column)} ${order.direction.toUpperCase()}`).join(', ')
  const rowNumber = `ROW_NUMBER() OVER (PARTITION BY ${quote(hydration.foreignKey)} ORDER BY ${orderBy}) AS ${quote(GROUPED_RELATED_ROW_NUMBER_ALIAS)}`
  const upperBoundPlaceholder = placeholder(1)
  const derivedAlias = quote('__holo_grouped_related_rows')
  const rowNumberColumn = quote(GROUPED_RELATED_ROW_NUMBER_ALIAS)
  const sql = `SELECT * FROM (SELECT *, ${quote(hydration.foreignKey)} AS ${quote(GROUPED_RELATED_ROW_ID_ALIAS)}, ${rowNumber} FROM ${quote(hydration.relatedTableName)} WHERE ${whereClause}) AS ${derivedAlias} WHERE ${rowNumberColumn} <= ${upperBoundPlaceholder} ORDER BY ${quote(GROUPED_RELATED_ROW_ID_ALIAS)} ASC, ${rowNumberColumn} ASC`

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
        mode: 'all' as const,
      },
      safety: {
        containsRawSql: false,
        unsafe: false,
      },
      debug: {
        complexity: 4 + hydration.orderBy.length + hydration.predicates.length + values.length,
        hasGrouping: false,
        hasHaving: false,
        hasJoins: false,
        hasUnions: false,
        intent: 'read' as const,
        streaming: 'buffered' as const,
        tableName: hydration.relatedTableName,
        transactionAffinity: 'optional' as const,
      },
    },
    source: `realtime:grouped-related-top-one:${hydration.relatedTableName}`,
    sql,
  }
}

function compileRelatedTopOnePredicateClauses(
  hydration: DatabaseQueryRelatedHydrationObservation,
  quote: (identifier: string) => string,
  placeholder: (value: unknown) => string,
): readonly string[] {
  const clauses: string[] = []
  for (const predicate of hydration.predicates) {
    const column = quote(predicate.column)
    switch (predicate.operator) {
      case '=':
      case '!=':
      case '>':
      case '>=':
      case '<':
      case '<=':
        clauses.push(`${column} ${predicate.operator} ${placeholder(predicate.value)}`)
        break
      case 'like':
        clauses.push(`${column} LIKE ${placeholder(predicate.value)}`)
        break
      case 'in':
      case 'not in': {
        const values = predicate.value as readonly unknown[]
        const operator = predicate.operator === 'in' ? 'IN' : 'NOT IN'
        clauses.push(`${column} ${operator} (${values.map(placeholder).join(', ')})`)
        break
      }
      case 'between':
      case 'not between': {
        const values = predicate.value as readonly [unknown, unknown]
        const operator = predicate.operator === 'between' ? 'BETWEEN' : 'NOT BETWEEN'
        clauses.push(`${column} ${operator} ${placeholder(values[0])} AND ${placeholder(values[1])}`)
        break
      }
    }
  }

  return Object.freeze(clauses)
}

async function fetchRelatedHydrationRows(
  hydration: DatabaseQueryRelatedHydrationObservation,
  localKey: unknown,
): Promise<readonly Readonly<Record<string, unknown>>[] | undefined> {
  const connection = getBackfillDatabaseConnection(hydration.relatedConnectionName)
  if (!connection) {
    return undefined
  }

  if (!canBackfillRelatedHydrationPredicates(hydration.predicates)) {
    return undefined
  }

  let builder = new TableQueryBuilder<string, Record<string, unknown>>(
    hydration.relatedTableName,
    connection,
  ).where(hydration.foreignKey, localKey)
  for (const predicate of hydration.predicates) {
    builder = builder.where(predicate.column, predicate.operator, predicate.value)
  }
  for (const order of hydration.orderBy) {
    builder = builder.orderBy(order.column, order.direction)
  }

  const rows = await builder
    .limit(hydration.kind === 'hasOne' ? 1 : undefined)
    .get()
  return validateRelatedHydrationRows(rows, hydration)
}

function validateRelatedHydrationRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  hydration: DatabaseQueryRelatedHydrationObservation,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  for (const row of rows) {
    if (typeof row[hydration.foreignKey] === 'undefined') {
      return undefined
    }
  }

  return rows
}

function canBackfillRelatedHydrationPredicates(
  predicates: readonly DatabaseQueryPredicateObservation[],
): boolean {
  for (const predicate of predicates) {
    if (!canBackfillRelatedHydrationPredicate(predicate)) {
      return false
    }
  }

  return true
}

function canBackfillRelatedHydrationPredicate(predicate: DatabaseQueryPredicateObservation): boolean {
  switch (predicate.operator) {
    case '=':
    case '!=':
    case '>':
    case '>=':
    case '<':
    case '<=':
    case 'like':
      return true
    case 'in':
    case 'not in':
      return Array.isArray(predicate.value) && predicate.value.length > 0
    case 'between':
    case 'not between':
      return Array.isArray(predicate.value) && predicate.value.length === 2
    default:
      return false
  }
}

function createRelatedHydrationBackfillKey(
  hydration: DatabaseQueryRelatedHydrationObservation,
  localKey: unknown,
): string {
  return `related:${hydration.kind}:${hydration.relatedConnectionName}:${hydration.relatedTableName}:${hydration.foreignKey}:${stableStringify(localKey)}:${stableStringify(hydration.predicates)}:${stableStringify(hydration.orderBy)}`
}

function createGroupedRelatedHydrationBackfillKey(
  hydration: DatabaseQueryRelatedHydrationObservation,
  values: readonly unknown[],
): string {
  return `related-group:${hydration.kind}:${hydration.relatedConnectionName}:${hydration.relatedTableName}:${hydration.foreignKey}:${stableStringify(values)}:${stableStringify(hydration.predicates)}:${stableStringify(hydration.orderBy)}`
}
