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
import { stableStringify } from './stable-stringify'
import {
  EMPTY_AGGREGATE_COLUMNS,
  EMPTY_AGGREGATE_COLUMNS_BY_SCOPE,
  type AggregateExtremeBackfillKinds,
  type BackfillCache,
  type DatabaseQueryObservation,
} from './query-state'
import type {
  AggregateBackfillEntry,
} from './query-aggregate-common'

type AggregateGroupPredicate = {
  readonly column: string
  readonly value: unknown
}

type GroupedAggregateQueries = {
  readonly queries: readonly DatabaseQueryObservation[]
  readonly values: readonly unknown[]
}

export function createAggregateColumnsByScope(
  entries: readonly AggregateBackfillEntry[],
): Map<string, readonly string[]> {
  const columns = new Map<string, string[]>()
  for (const entry of entries) {
    for (const query of entry.queries) {
      if (!query.aggregate?.column) {
        continue
      }

      const scopeKey = createAggregateScopeKey(query)
      const scopeColumns = columns.get(scopeKey)
      if (scopeColumns) {
        if (!scopeColumns.includes(query.aggregate.column)) {
          scopeColumns.push(query.aggregate.column)
        }
        continue
      }

      columns.set(scopeKey, [query.aggregate.column])
    }
  }

  if (columns.size === 0) {
    return EMPTY_AGGREGATE_COLUMNS_BY_SCOPE
  }

  const columnsByScope = new Map<string, readonly string[]>()
  for (const [scope, scopeColumns] of columns) {
    columnsByScope.set(scope, Object.freeze([...scopeColumns]))
  }

  return columnsByScope
}

export function createAggregateExtremeKindsByScope(
  entries: readonly AggregateBackfillEntry[],
): Map<string, ReadonlyMap<string, AggregateExtremeBackfillKinds>> {
  const kinds = new Map<string, Map<string, AggregateExtremeBackfillKinds>>()
  for (const entry of entries) {
    for (const query of entry.queries) {
      addAggregateExtremeKind(kinds, query)
    }
  }

  const kindsByScope = new Map<string, ReadonlyMap<string, AggregateExtremeBackfillKinds>>()
  for (const [scope, scopeKinds] of kinds) {
    kindsByScope.set(scope, new Map(scopeKinds))
  }

  return kindsByScope
}

export function createGroupedAggregateBackfillKey(
  query: DatabaseQueryObservation,
  groupColumn: string,
  values: readonly unknown[],
  columns: readonly string[],
): string {
  return '{"columns":'
    + stableStringify(columns)
    + ',"connectionName":'
    + stableStringify(query.connectionName)
    + ',"groupColumn":'
    + stableStringify(groupColumn)
    + ',"tableName":'
    + stableStringify(query.tableName)
    + ',"values":'
    + stableStringify(values)
    + '}'
}

export function addGroupedAggregateValue(values: unknown[], value: unknown): void {
  if (!values.some(candidate => Object.is(candidate, value))) {
    values.push(value)
  }
}

export function collectGroupedAggregateQueries(
  query: DatabaseQueryObservation,
  backfills: BackfillCache<AggregateBackfillEntry>,
): GroupedAggregateQueries {
  const queries: DatabaseQueryObservation[] = []
  const values: unknown[] = []
  for (const entry of backfills.entries) {
    for (const candidate of entry.queries) {
      const candidateGroupPredicate = readAggregateGroupPredicate(candidate)
      if (
        backfills.exactPredicates
        && isQueryObservationContradictedByExactPredicates(candidate, backfills.exactPredicates) === true
      ) {
        continue
      }

      if (
        candidate.aggregate
        && candidateGroupPredicate
        && aggregateQueriesShareGroupScope(query, candidate)
        && (candidate === query || queryHasAggregateBackfillMutation(candidate, candidateGroupPredicate, backfills))
      ) {
        queries.push(candidate)
        addGroupedAggregateValue(values, candidateGroupPredicate.value)
      }
    }
  }

  return Object.freeze({
    queries: Object.freeze(queries),
    values: Object.freeze(values),
  })
}

export function collectGroupedAggregateColumns(
  queries: readonly DatabaseQueryObservation[],
  columns: readonly string[],
): readonly string[] {
  const groupedColumns = [...columns]
  for (const query of queries) {
    const column = query.aggregate?.column
    if (column) {
      addGroupedAggregateColumn(groupedColumns, column)
    }
  }

  return Object.freeze(groupedColumns)
}

export function readAggregateGroupPredicate(query: DatabaseQueryObservation): AggregateGroupPredicate | undefined {
  const predicate = query.predicates[0]
  return query.predicates.length === 1 && predicate?.operator === '='
    ? { column: predicate.column, value: predicate.value }
    : undefined
}

export function getAggregateBackfillColumns(
  query: DatabaseQueryObservation,
  backfills: BackfillCache<AggregateBackfillEntry>,
): readonly string[] {
  backfills.aggregateColumnsByScope ??= createAggregateColumnsByScope(backfills.entries)
  const scopeColumns = backfills.aggregateColumnsByScope.get(createAggregateScopeKey(query)) ?? EMPTY_AGGREGATE_COLUMNS
  if (!query.aggregate?.column || scopeColumns.includes(query.aggregate.column)) {
    return scopeColumns
  }

  return Object.freeze([...scopeColumns, query.aggregate.column])
}

export function getAggregateExtremeKinds(
  query: DatabaseQueryObservation,
  backfills: BackfillCache<AggregateBackfillEntry>,
): ReadonlyMap<string, AggregateExtremeBackfillKinds> {
  backfills.aggregateExtremeKindsByScope ??= createAggregateExtremeKindsByScope(backfills.entries)
  const scopeKinds = new Map(backfills.aggregateExtremeKindsByScope.get(createAggregateScopeKey(query)))
  const aggregate = query.aggregate
  if (!aggregate?.column || (aggregate.kind !== 'min' && aggregate.kind !== 'max')) {
    return scopeKinds
  }

  const columnKinds = scopeKinds.get(aggregate.column) ?? { max: false, min: false }
  scopeKinds.set(aggregate.column, Object.freeze({
    ...columnKinds,
    [aggregate.kind]: true,
  }))
  return scopeKinds
}

function addAggregateExtremeKind(
  kinds: Map<string, Map<string, AggregateExtremeBackfillKinds>>,
  query: DatabaseQueryObservation,
): void {
  const aggregate = query.aggregate
  if (!aggregate?.column || (aggregate.kind !== 'min' && aggregate.kind !== 'max')) {
    return
  }

  const scopeKey = createAggregateScopeKey(query)
  const scopeKinds = kinds.get(scopeKey) ?? new Map<string, AggregateExtremeBackfillKinds>()
  kinds.set(scopeKey, scopeKinds)

  const columnKinds = scopeKinds.get(aggregate.column) ?? { max: false, min: false }
  scopeKinds.set(aggregate.column, Object.freeze({
    ...columnKinds,
    [aggregate.kind]: true,
  }))
}

function aggregateQueriesShareGroupScope(left: DatabaseQueryObservation, right: DatabaseQueryObservation): boolean {
  const leftPredicate = readAggregateGroupPredicate(left)
  const rightPredicate = readAggregateGroupPredicate(right)
  return Boolean(
    leftPredicate
    && rightPredicate
    && left.connectionName === right.connectionName
    && left.tableName === right.tableName
    && leftPredicate.column === rightPredicate.column,
  )
}

function addGroupedAggregateColumn(columns: string[], column: string): void {
  if (!columns.includes(column)) {
    columns.push(column)
  }
}

function aggregateMutationRequiresBackfill(mutation: DatabaseMutationEvent): boolean {
  if (mutation.kind === 'insert' || mutation.kind === 'delete') {
    return !mutation.rows
  }

  return !mutation.rows || !mutation.previousRows
}

function mutationMatchesAggregateGroupPredicate(
  mutation: DatabaseMutationEvent,
  query: DatabaseQueryObservation,
  groupPredicate: AggregateGroupPredicate,
  backfills: BackfillCache<AggregateBackfillEntry>,
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

function queryHasAggregateBackfillMutation(
  query: DatabaseQueryObservation,
  groupPredicate: AggregateGroupPredicate,
  backfills: BackfillCache<AggregateBackfillEntry>,
): boolean {
  const mutations = backfills.mutations.get(createMutationIndexKey(query.connectionName, query.tableName)) ?? EMPTY_DATABASE_MUTATIONS
  return mutations.some(mutation => aggregateMutationRequiresBackfill(mutation)
    && mutationMatchesAggregateGroupPredicate(mutation, query, groupPredicate, backfills))
}
