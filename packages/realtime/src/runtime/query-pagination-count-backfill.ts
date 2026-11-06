import { TableQueryBuilder } from '@holo-js/db'
import {
  createMutationIndexKey,
  EMPTY_DATABASE_MUTATIONS,
  type DatabaseMutationEvent,
} from './dependencies'
import {
  isQueryObservationContradictedByExactPredicates,
  readExactPredicateValues,
} from './predicate-dependency-matching'
import {
  createAggregateScopeKey,
} from './query-metadata'
import {
  getBackfillDatabaseConnection,
} from './query-backfill'
import type {
  DatabaseQueryObservation,
} from './query-state'
import type { BackfillCache } from './state'
import { stableStringify } from './stable-stringify'

type PaginationCountGroupPredicate = {
  readonly column: string
  readonly value: unknown
}

export async function getPaginationCountBackfill(
  query: DatabaseQueryObservation,
  backfills: BackfillCache,
): Promise<number | undefined> {
  const groupedCount = await getGroupedPaginationCountBackfill(query, backfills)
  if (typeof groupedCount === 'number') {
    return groupedCount
  }

  const key = createPaginationCountBackfillKey(query)
  const pendingBackfill = backfills.paginationCounts.get(key) ?? fetchPaginationCountBackfill(query)
  backfills.paginationCounts.set(key, pendingBackfill)
  return await pendingBackfill
}

async function getGroupedPaginationCountBackfill(
  query: DatabaseQueryObservation,
  backfills: BackfillCache,
): Promise<number | undefined> {
  const groupPredicate = readPaginationCountGroupPredicate(query)
  const groupedCache = backfills.paginationGroupedCounts
  if (!groupPredicate || !groupedCache) {
    return undefined
  }

  const groupedQueries = collectGroupedPaginationCountQueries(query, backfills)
  if (groupedQueries.length < 2) {
    return undefined
  }

  const values = collectGroupedPaginationCountValues(groupedQueries)
  if (values.length < 2) {
    return undefined
  }

  const key = createGroupedPaginationCountBackfillKey(query, groupPredicate.column, values)
  const pendingBackfill = groupedCache.get(key) ?? fetchGroupedPaginationCountBackfill(query, groupPredicate.column, values)
  groupedCache.set(key, pendingBackfill)
  const counts = await pendingBackfill
  return counts?.get(groupPredicate.value)
}

function createPaginationCountBackfillKey(query: DatabaseQueryObservation): string {
  return '{"paginationCount":'
    + createAggregateScopeKey(query)
    + '}'
}

function createGroupedPaginationCountBackfillKey(
  query: DatabaseQueryObservation,
  groupColumn: string,
  values: readonly unknown[],
): string {
  return '{"groupColumn":'
    + stableStringify(groupColumn)
    + ',"paginationCount":'
    + stableStringify({
      connectionName: query.connectionName,
      tableName: query.tableName,
      values,
    })
    + '}'
}

function readPaginationCountGroupPredicate(query: DatabaseQueryObservation): PaginationCountGroupPredicate | undefined {
  const predicate = query.predicates[0]
  return query.predicates.length === 1 && predicate?.operator === '='
    ? { column: predicate.column, value: predicate.value }
    : undefined
}

function readSharedPaginationCountGroupPredicate(
  left: DatabaseQueryObservation,
  right: DatabaseQueryObservation,
): PaginationCountGroupPredicate | undefined {
  const leftPredicate = readPaginationCountGroupPredicate(left)
  const rightPredicate = readPaginationCountGroupPredicate(right)
  return leftPredicate
    && rightPredicate
    && left.connectionName === right.connectionName
    && left.tableName === right.tableName
    && leftPredicate.column === rightPredicate.column
    ? rightPredicate
    : undefined
}

function paginationMutationRequiresCountBackfill(mutation: DatabaseMutationEvent): boolean {
  return !mutation.rows || (mutation.kind === 'update' || mutation.kind === 'upsert') && !mutation.previousRows
}

function mutationMatchesPaginationCountGroupPredicate(
  mutation: DatabaseMutationEvent,
  query: DatabaseQueryObservation,
  groupPredicate: PaginationCountGroupPredicate,
  backfills: BackfillCache,
): boolean {
  const exactPredicates = backfills.mutationExactPredicates?.get(mutation)
  if (!exactPredicates) {
    return false
  }

  const values = readExactPredicateValues(
    exactPredicates,
    query.connectionName,
    query.tableName,
    groupPredicate.column,
  )
  return values?.some(value => Object.is(value, groupPredicate.value)) === true
}

function queryHasPaginationCountBackfillMutation(
  query: DatabaseQueryObservation,
  groupPredicate: PaginationCountGroupPredicate,
  backfills: BackfillCache,
): boolean {
  const mutations = backfills.mutations.get(createMutationIndexKey(query.connectionName, query.tableName)) ?? EMPTY_DATABASE_MUTATIONS
  return mutations.some(mutation => paginationMutationRequiresCountBackfill(mutation)
    && mutationMatchesPaginationCountGroupPredicate(mutation, query, groupPredicate, backfills))
}

function collectGroupedPaginationCountQueries(
  query: DatabaseQueryObservation,
  backfills: BackfillCache,
): readonly DatabaseQueryObservation[] {
  const queries: DatabaseQueryObservation[] = []
  for (const entry of backfills.entries) {
    for (const candidate of entry.queries) {
      if (!candidate.pagination || candidate.pagination.kind === 'cursor') {
        continue
      }

      if (
        backfills.exactPredicates
        && isQueryObservationContradictedByExactPredicates(candidate, backfills.exactPredicates) === true
      ) {
        continue
      }

      const groupPredicate = readSharedPaginationCountGroupPredicate(query, candidate)
      if (groupPredicate && (candidate === query || queryHasPaginationCountBackfillMutation(candidate, groupPredicate, backfills))) {
        queries.push(candidate)
      }
    }
  }

  return Object.freeze(queries)
}

function collectGroupedPaginationCountValues(
  queries: readonly DatabaseQueryObservation[],
): readonly unknown[] {
  const values: unknown[] = []
  for (const query of queries) {
    const predicate = readPaginationCountGroupPredicate(query)
    if (!predicate || values.some(value => Object.is(value, predicate.value))) {
      continue
    }

    values.push(predicate.value)
  }

  return Object.freeze(values)
}

async function fetchPaginationCountBackfill(query: DatabaseQueryObservation): Promise<number | undefined> {
  const connection = getBackfillDatabaseConnection(query.connectionName)
  if (!connection) {
    return undefined
  }

  let builder = new TableQueryBuilder<string, Record<string, unknown>>(query.tableName, connection)
  for (const predicate of query.predicates) {
    builder = builder.where(predicate.column, predicate.operator, predicate.value)
  }

  const rows = await builder
    .selectCount('__holo_count')
    .get<Record<string, unknown>>()
  const count = rows[0]?.__holo_count
  return normalizePaginationCount(count)
}

async function fetchGroupedPaginationCountBackfill(
  query: DatabaseQueryObservation,
  groupColumn: string,
  values: readonly unknown[],
): Promise<ReadonlyMap<unknown, number> | undefined> {
  const connection = getBackfillDatabaseConnection(query.connectionName)
  if (!connection) {
    return undefined
  }

  const rows = await new TableQueryBuilder<string, Record<string, unknown>>(query.tableName, connection)
    .where(groupColumn, 'in', values)
    .select(groupColumn)
    .addSelectCount('__holo_count')
    .groupBy(groupColumn)
    .get<Record<string, unknown>>()
  const counts = new Map<unknown, number>()
  for (const value of values) {
    counts.set(value, 0)
  }

  for (const row of rows) {
    const value = row[groupColumn]
    const count = normalizePaginationCount(row.__holo_count)
    if (typeof count === 'undefined') {
      return undefined
    }

    counts.set(value, count)
  }

  return counts
}

function normalizePaginationCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return value
  }

  if (typeof value === 'string' && value.trim()) {
    const numericValue = Number(value)
    return Number.isInteger(numericValue) && numericValue >= 0 ? numericValue : undefined
  }

  return undefined
}
