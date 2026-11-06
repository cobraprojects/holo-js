import { CompilerError, ConfigurationError, SecurityError, TransactionError } from '../core/errors'
import { NumericAdjustment } from './NumericAdjustment'
import { redactBindings } from '../security/policy'
import { getApplicationTimezone } from '../applicationTimezone'
import { formatCalendarDate, startOfDayInTimezone } from '../applicationTime'
import { createTrustedRawPredicate } from './trustedRawPredicate'
import { isGenuineDatabaseContext } from '../core/genuineContexts'
import { getRootDatabaseContext } from '../core/contextOwnership'
import {
  getDatabaseQueryCacheBridge,
  hasActiveDatabaseDependencyCollector,
  hasDatabaseDependencyInvalidationListeners,
  hasDatabaseDependencyInvalidationPublisher,
  invalidateQueryCacheDependencies,
  runQueryCacheOperation,
  createDatabaseMutationEvent,
  resolveInsertIdKey,
  createTableCacheDependency,
  createTableRowWildcardCacheDependency,
  createDatabaseQueryFallbackObservation,
  createDatabaseQueryObservation,
  disableDatabaseQueryObservationPatching,
  inferAutomaticInsertCacheInvalidationPlan,
  inferAutomaticQueryCacheInvalidationPlan,
  inferDatabaseQueryObservationDependencies,
  normalizeQueryCacheConfig,
  queryCacheInternals,
  rebindDatabaseQueryObservationAggregate,
  rebindDatabaseQueryObservationCursorPagination,
  rebindDatabaseQueryObservationPagination,
  rebindDatabaseQueryObservationResult,
  rebindDatabaseQueryObservationScalar,
  rebindDatabaseQueryObservationScalarList,
  recordDatabaseQueryDependencies,
  recordDatabaseQueryObservation,
  recordDatabaseQueryContext,
  resolveQueryCacheDependencies,
  writesTextLiterals,
  type QueryTextMatching,
  resolveQueryCacheKey,
  type DatabaseQueryGroupedAggregateStateObservation,
  type DatabaseQueryGroupedAggregateValueCountObservation,
  type DatabaseQueryGroupedAverageStateObservation,
  type DatabaseQueryGroupedAggregateObservation,
  type DatabaseQueryObservation,
  type NormalizedQueryCacheConfig,
  type QueryCacheConfig,
  type QueryCacheFlexibleTtlInput,
  type QueryCacheTtlInput,
} from '../cache'
import { queryBatches, visitRows } from './traversal'
import { hasUnstoredBoolean, holdsUnreadableInteger, readConvertedResultColumns, readInsertedKey, readIntegerColumns, resolveConvertedResultColumns, tableForQualifier, withResolvedDefinitions } from './resultColumns'
import {
  createCursorPaginator,
  createPaginator,
  createSimplePaginator,
} from './paginator'
import {
  assertPositiveInteger,
  decodeValueCursor,
  encodeValueCursor,
  normalizePaginationParameterName,
} from './pagination'
import { cursorPredicate } from './cursorPredicate'
import {
  createDeleteQueryPlan,
  createInsertUsingQueryPlan,
  createTruncateQueryPlan,
  createInsertQueryPlan,
  createSelectQueryPlan,
  createTableSource,
  createUpdateQueryPlan,
  parseTableReference,
  appendSelections,
  appendAggregateSelection,
  appendRawSelection,
  appendSubquerySelection,
  withGroupBy,
  withHaving,
  withJoin,
  withSource,
  withSubquerySelection,
  createUpsertQueryPlan,
  withDistinct,
  withLimit,
  withLockMode,
  withOffset,
  withOrderBy,
  withPredicate,
  withUnion,
  replaceOrderBy,
  withSelections,
  withAggregateSelection,
  withRawSelection,
  withoutPredicates,
} from './ast'
import { createAggregateValueCounts } from './aggregateValueCounts'
import type { SQLQueryCompiler } from './SQLQueryCompiler'
import type { CursorPaginatedResult, CursorPaginationOptions, PaginatedResult, PaginationOptions, SimplePaginatedResult } from './types'
import type { AnyColumnDefinition, InferSelect, TableDefinition } from '../schema/types'
import { assertSinglePrimaryKey, listTablePrimaryKeyColumns, resolveTablePrimaryKey, resolveTablePrimaryKeyColumns } from '../schema/tablePrimaryKey'
import { getConnectionGeneratedTableDefinition } from '../schema/generated'
import { knownJoinedColumns, projectModelRowPlan, qualifiesTable, resolveSourceColumnName, selectionOutputName, selectsJoinedColumn, tableWildcard } from './modelRowProjection'
import { splitTablePath } from '../schema/identifiers'
import { storesJson } from '../schema/normalization'
import { isMySQLConnection, isPostgresConnection, isSQLiteConnection, textMatchesAnyNumber } from '../schema/connectionDialect'
import { UNKNOWN_TEXT_COLUMNS, resolveCaseInsensitiveColumns, type CaseInsensitiveColumns } from '../schema/caseInsensitiveColumns'
import type { SchemaDialectName } from '../schema/typeMapping'
import type { CompiledStatement, DriverExecutionResult, DriverQueryResult, UnsafeStatement } from '../core/types'
import type { DatabaseContext } from '../core/DatabaseContext'
import type {
  QueryAggregateSelection,
  QueryDirection,
  QueryJsonUpdateOperation,
  QueryJoinClause,
  QueryBetweenColumnsPredicate,
  QueryColumnPredicate,
  QueryKeyCast,
  QueryKeyCasts,
  QueryDatePart,
  QueryOperator,
  QueryPredicateNode,
  QueryPredicate,
  QueryColumnSelection,
  QuerySelection,
  SelectQueryPlan,
} from './ast'
import {
  normalizeDateColumnPredicateValue,
  normalizeDatePartPredicateValue,
  normalizeQueryPredicateValue,
  normalizeQueryUpdateValues,
  normalizeQueryWriteRecord,
  normalizeQueryWriteValue,
} from './queryValueNormalizer'
import { createQueryCompiler } from './queryCompilerFactory'
import { resolvePlanGeneratedTableIdentities, resolvePlanTableIdentities, resolveTableIdentity } from './tableIdentity'
import { assertQueryTablePath, validateQueryPlan } from './validator'

import type { AvailableTableColumns, ColumnSelection, NullableColumns, QualifiedTableColumns, SelectedColumns } from './selectionTypes'

type SelectRow<TTableOrName extends string | TableDefinition>
  = TTableOrName extends TableDefinition ? InferSelect<TTableOrName> : Record<string, unknown>

type TableReference = string | TableDefinition
type BuilderCallback<TBuilder> = (query: TBuilder) => unknown
type ValueBuilderCallback<TBuilder, TValue> = (query: TBuilder, value: TValue) => unknown
type CapturedMutationRows = {
  readonly previousRows?: readonly Readonly<Record<string, unknown>>[]
  readonly rows?: readonly Readonly<Record<string, unknown>>[]
}
type MutationExecutionResult = DriverExecutionResult & {
  readonly rows?: CapturedMutationRows
}
type DatabaseQueryObservationFactory = (
  plan: SelectQueryPlan,
  connectionName: string,
  dependencies: readonly string[],
  result?: unknown,
  groupedAverageStates?: readonly DatabaseQueryGroupedAverageStateObservation[],
  groupedAggregateStates?: readonly DatabaseQueryGroupedAggregateStateObservation[],
) => DatabaseQueryObservation | undefined
type DatabaseQueryGroupedAggregateValueCountGroupObservation = {
  readonly groupValue: unknown
  readonly valueCounts: DatabaseQueryGroupedAggregateValueCountObservation[]
}

type SelectedColumnNames<TRow extends Record<string, unknown>> = Extract<keyof TRow, string>
type DeclaredColumnName<
  TTableOrName extends TableReference,
  TColumns extends Record<string, unknown> = AvailableTableColumns<TTableOrName>,
> = keyof TColumns & string
type ColumnReference<TTableOrName extends TableReference>
  = TTableOrName extends TableDefinition ? DeclaredColumnName<TTableOrName> | `${string}.${string}` : string
type JsonColumnPath<
  TTableOrName extends TableReference,
  TColumns extends Record<string, unknown> = AvailableTableColumns<TTableOrName>,
> = DeclaredColumnName<TTableOrName, TColumns> | `${DeclaredColumnName<TTableOrName, TColumns>}->${string}`

type AggregateSelectionResult<TAlias extends string, TValue> = Record<TAlias, TValue>

export const hasQueryCache = Symbol('hasQueryCache')
export const resolveAggregateSource = Symbol('resolveAggregateSource')
export const projectModelRows = Symbol('projectModelRows')
type KeyedInsert = (
  query: TableQueryBuilder<TableReference, Record<string, unknown>, Record<string, unknown>>,
  values: Readonly<Record<string, unknown>>,
  keyColumn: string,
) => Promise<number | string | undefined>

let keyedInsert: KeyedInsert
type AnyTableQuery = TableQueryBuilder<TableReference, Record<string, unknown>, Record<string, unknown>>
let keyColumnComparison: (query: AnyTableQuery, column: string, compareTo: string, casts: QueryKeyCasts) => AnyTableQuery
let keyColumnSelection: (query: AnyTableQuery, column: string, cast: QueryKeyCast | undefined) => AnyTableQuery
let keyColumnJoin: (query: AnyTableQuery, table: TableReference, leftColumn: string, rightColumn: string, casts: QueryKeyCasts) => AnyTableQuery

export function whereKeyColumn<TQuery extends TableQueryBuilder<TableReference, Record<string, unknown>, Record<string, unknown>>>(query: TQuery, column: string, compareTo: string, casts: QueryKeyCasts): TQuery {
  return keyColumnComparison(query as unknown as AnyTableQuery, column, compareTo, casts) as unknown as TQuery
}

export function selectKeyColumn<TQuery extends TableQueryBuilder<TableReference, Record<string, unknown>, Record<string, unknown>>>(query: TQuery, column: string, cast: QueryKeyCast | undefined): TQuery {
  return keyColumnSelection(query as unknown as AnyTableQuery, column, cast) as unknown as TQuery
}

export function joinOnKeyColumns<TQuery extends TableQueryBuilder<TableReference, Record<string, unknown>, Record<string, unknown>>>(query: TQuery, table: TableReference, leftColumn: string, rightColumn: string, casts: QueryKeyCasts): TQuery {
  return keyColumnJoin(query as unknown as AnyTableQuery, table, leftColumn, rightColumn, casts) as unknown as TQuery
}


export function insertGetIdByKey(
  query: TableQueryBuilder<TableReference, Record<string, unknown>, Record<string, unknown>>,
  values: Readonly<Record<string, unknown>>,
  keyColumn: string,
): Promise<number | string | undefined> {
  return keyedInsert(query, values, keyColumn)
}

const trustedRawWhereAppenders = new WeakMap<object, (sql: string, bindings: readonly unknown[]) => unknown>()
const internalPlanHandoff: unique symbol = Symbol('internalPlanHandoff')

const aggregateValueKey = 'holo_aggregate_value'

function mayOutputName(branch: SelectQueryPlan, selection: QuerySelection, name: string, connectionName: string): boolean {
  if (selection.kind === 'raw') return true
  if (selection.kind !== 'column' || (!selection.column.endsWith('.*') && selection.column !== '*')) return selectionOutputName(selection) === name
  if (selection.column === '*') return true
  const qualifier = selection.column.slice(0, -2)
  if (qualifiesTable(qualifier, branch.source.tableName, branch.source.alias)) return !branch.source.table || Object.hasOwn(branch.source.table.columns, name)
  const join = branch.joins.find(candidate => qualifiesTable(qualifier, candidate.table, candidate.alias))
  const columns = join ? knownJoinedColumns(join, connectionName) : undefined
  return columns ? columns.includes(name) : true
}

function unionBranchColumn(branch: SelectQueryPlan, column: string, connectionName: string): string {
  const index = branch.selections.findIndex(selection => selection.kind === 'column' && selection.alias === column)
  const aliased = branch.selections[index]
  if (aliased?.kind === 'column') {
    if (branch.selections.slice(index + 1).some(selection => mayOutputName(branch, selection, column, connectionName))) {
      throw new CompilerError(`Cannot cursor paginate a union by "${column}": more than one of its selected columns may be named "${column}". Select it under a name no other column has.`)
    }
    return aliased.column
  }
  if (branch.joins.length === 0 || column.includes('.') || !branch.source.table || !Object.hasOwn(branch.source.table.columns, column)) return column
  return `${branch.source.alias ?? branch.source.tableName}.${column}`
}

function copyTopLevelPredicates(predicates: readonly QueryPredicateNode[]): readonly QueryPredicateNode[] {
  return Object.freeze(predicates.map(predicate => Object.freeze({ ...predicate }) as QueryPredicateNode))
}

function resolveJoinTarget(table: TableReference): Pick<QueryJoinClause, 'table' | 'alias' | 'definition'> {
  if (typeof table !== 'string') {
    return { table: table.tableName, definition: table }
  }

  const { tableName, alias } = parseTableReference(table)
  return alias === undefined ? { table: tableName } : { table: tableName, alias }
}

const GROUPED_AVERAGE_COUNT_KEY = '__holo_grouped_average_count'
const GROUPED_AVERAGE_ROW_COUNT_KEY = '__holo_grouped_average_row_count'
const GROUPED_AVERAGE_SUM_KEY = '__holo_grouped_average_sum'
const rowsReadFromUnstoredBooleans = new WeakSet<readonly Record<string, unknown>[]>()

const GROUPED_AVERAGE_GROUP_KEY = '__holo_grouped_average_group'
const GROUPED_AGGREGATE_VALUE_KEY = '__holo_grouped_aggregate_state_value'
const GROUPED_AGGREGATE_ROW_COUNT_KEY = '__holo_grouped_aggregate_state_row_count'
const GROUPED_AGGREGATE_GROUP_KEY = '__holo_grouped_aggregate_state_group'
const GROUPED_AGGREGATE_VALUE_COUNT_VALUE_KEY = '__holo_grouped_aggregate_state_count_value'
const GROUPED_AGGREGATE_VALUE_COUNT_KEY = '__holo_grouped_aggregate_state_value_count'

function normalizeAtomicQueryCacheTtl(ttl: QueryCacheTtlInput): QueryCacheFlexibleTtlInput {
  if (ttl instanceof Date) {
    const expiresAt = ttl.getTime()
    if (Number.isNaN(expiresAt)) {
      throw new ConfigurationError('[@holo-js/db] Query cache Date TTL must be valid.')
    }

    const seconds = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000))
    return [seconds, seconds]
  }

  return [ttl, ttl]
}

export class TableQueryBuilder<
  TTableOrName extends TableReference = string,
  TSelectedRow extends Record<string, unknown> = SelectRow<TTableOrName>,
  TAvailableColumns extends Record<string, unknown> = AvailableTableColumns<TTableOrName>,
> {
  private readonly ownSource: ReturnType<typeof createTableSource>
  private boundSource?: ReturnType<typeof createTableSource>
  private readonly plan: SelectQueryPlan

  constructor(
    table: TTableOrName,
    private readonly connection: DatabaseContext,
    plan?: SelectQueryPlan,
    private readonly queryCacheConfig?: NormalizedQueryCacheConfig,
    handoff?: symbol,
  ) {
    const source = plan?.source ?? createTableSource(table)
    this.ownSource = source
    const ownPlan = plan && handoff !== internalPlanHandoff
      ? { ...plan, predicates: copyTopLevelPredicates(plan.predicates) }
      : plan
    this.plan = ownPlan ? withSource(ownPlan, source) : createSelectQueryPlan(source)
    trustedRawWhereAppenders.set(this, (sql, bindings) => this.clone(withPredicate(this.plan, createTrustedRawPredicate({
      kind: 'raw',
      boolean: 'and',
      sql,
      bindings: Object.freeze([...bindings]),
    }))))
  }

  private get source(): ReturnType<typeof createTableSource> {
    if (this.boundSource) return this.boundSource
    if (this.ownSource.table) return this.ownSource
    const table = getConnectionGeneratedTableDefinition(this.ownSource.tableName, this.connection.getConnectionName())
    const source = { ...this.ownSource, table }
    if (table) this.boundSource = source
    return source
  }

  private async bindGeneratedTable(): Promise<void> {
    await resolvePlanGeneratedTableIdentities(this.connection, this.plan)
  }

  private async prepareMutation(): Promise<void> {
    await this.bindGeneratedTable()
    if (getDatabaseQueryCacheBridge() || hasDatabaseDependencyInvalidationListeners() || hasDatabaseDependencyInvalidationPublisher()) {
      await resolveTableIdentity(this.connection, this.ownSource.tableName)
    }
  }

  getTableName(): string {
    return this.source.tableName
  }

  getConnectionName(): string {
    return this.connection.getConnectionName()
  }

  getConnection(): DatabaseContext {
    return this.connection
  }

  getPlan(): SelectQueryPlan {
    return this.plan
  }

  withPredicates(predicates: readonly QueryPredicateNode[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone({ ...this.plan, predicates: copyTopLevelPredicates(predicates) })
  }

  from(table: string): TableQueryBuilder<string, TSelectedRow> {
    const source = createTableSource(table)
    return new TableQueryBuilder(
      table,
      this.connection,
      withSource(this.plan, this.sourceHasRowKey(source.tableName) ? Object.freeze({ ...source, primaryKey: this.source.primaryKey }) : source),
      this.queryCacheConfig,
      internalPlanHandoff,
    )
  }

  select<const TColumns extends readonly ColumnSelection<TAvailableColumns>[]>(
    ...columns: TColumns
  ): TableQueryBuilder<TTableOrName, TColumns extends readonly [] ? TSelectedRow : SelectedColumns<TAvailableColumns, TColumns>, TAvailableColumns> {
    return this.clone(withSelections(this.plan, columns))
  }

  addSelect<const TColumns extends readonly ColumnSelection<TAvailableColumns>[]>(
    ...columns: TColumns
  ): TableQueryBuilder<TTableOrName, Omit<TSelectedRow, keyof SelectedColumns<TAvailableColumns, TColumns>> & SelectedColumns<TAvailableColumns, TColumns>, TAvailableColumns> {
    return this.clone(appendSelections(this.plan, columns))
  }

  selectCount<TAlias extends string = 'count'>(
    alias?: TAlias,
    column: DeclaredColumnName<TTableOrName, TAvailableColumns> | '*' = '*',
  ): TableQueryBuilder<TTableOrName, AggregateSelectionResult<TAlias, number>, TAvailableColumns> {
    return this.clone(
      withAggregateSelection(this.plan, this.createAggregateSelection('count', alias ?? 'count' as TAlias, column)),
    )
  }

  addSelectCount<TAlias extends string = 'count'>(
    alias?: TAlias,
    column: DeclaredColumnName<TTableOrName, TAvailableColumns> | '*' = '*',
  ): TableQueryBuilder<TTableOrName, TSelectedRow & AggregateSelectionResult<TAlias, number>, TAvailableColumns> {
    return this.clone(
      appendAggregateSelection(this.plan, this.createAggregateSelection('count', alias ?? 'count' as TAlias, column)),
    )
  }

  selectSum<TAlias extends string>(
    alias: TAlias,
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
  ): TableQueryBuilder<TTableOrName, AggregateSelectionResult<TAlias, number | null>, TAvailableColumns> {
    return this.clone(
      withAggregateSelection(this.plan, this.createAggregateSelection('sum', alias, column)),
    )
  }

  addSelectSum<TAlias extends string>(
    alias: TAlias,
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow & AggregateSelectionResult<TAlias, number | null>, TAvailableColumns> {
    return this.clone(
      appendAggregateSelection(this.plan, this.createAggregateSelection('sum', alias, column)),
    )
  }

  selectAvg<TAlias extends string>(
    alias: TAlias,
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
  ): TableQueryBuilder<TTableOrName, AggregateSelectionResult<TAlias, number | null>, TAvailableColumns> {
    return this.clone(
      withAggregateSelection(this.plan, this.createAggregateSelection('avg', alias, column)),
    )
  }

  addSelectAvg<TAlias extends string>(
    alias: TAlias,
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow & AggregateSelectionResult<TAlias, number | null>, TAvailableColumns> {
    return this.clone(
      appendAggregateSelection(this.plan, this.createAggregateSelection('avg', alias, column)),
    )
  }

  selectMin<TAlias extends string>(
    alias: TAlias,
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
  ): TableQueryBuilder<TTableOrName, AggregateSelectionResult<TAlias, number | null>, TAvailableColumns> {
    return this.clone(
      withAggregateSelection(this.plan, this.createAggregateSelection('min', alias, column)),
    )
  }

  addSelectMin<TAlias extends string>(
    alias: TAlias,
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow & AggregateSelectionResult<TAlias, number | null>, TAvailableColumns> {
    return this.clone(
      appendAggregateSelection(this.plan, this.createAggregateSelection('min', alias, column)),
    )
  }

  selectMax<TAlias extends string>(
    alias: TAlias,
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
  ): TableQueryBuilder<TTableOrName, AggregateSelectionResult<TAlias, number | null>, TAvailableColumns> {
    return this.clone(
      withAggregateSelection(this.plan, this.createAggregateSelection('max', alias, column)),
    )
  }

  addSelectMax<TAlias extends string>(
    alias: TAlias,
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow & AggregateSelectionResult<TAlias, number | null>, TAvailableColumns> {
    return this.clone(
      appendAggregateSelection(this.plan, this.createAggregateSelection('max', alias, column)),
    )
  }

  unsafeSelect(
    sql: string,
    bindings: readonly unknown[],
  ): TableQueryBuilder<TTableOrName, Record<string, unknown>, TAvailableColumns> {
    return this.clone(withRawSelection(this.plan, {
      kind: 'raw',
      sql,
      bindings: Object.freeze([...bindings]),
    }))
  }

  addUnsafeSelect(
    sql: string,
    bindings: readonly unknown[],
  ): TableQueryBuilder<TTableOrName, Record<string, unknown>, TAvailableColumns> {
    return this.clone(appendRawSelection(this.plan, {
      kind: 'raw',
      sql,
      bindings: Object.freeze([...bindings]),
    }))
  }

  selectSub(
    query: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
    alias: string,
  ): TableQueryBuilder<TTableOrName, Record<string, unknown>, TAvailableColumns> {
    return this.clone(withSubquerySelection(this.plan, query.getPlan(), alias))
  }

  addSelectSub(
    query: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
    alias: string,
  ): TableQueryBuilder<TTableOrName, Record<string, unknown>, TAvailableColumns> {
    return this.clone(appendSubquerySelection(this.plan, query.getPlan(), alias))
  }

  distinct(): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withDistinct(this.plan))
  }

  where(
    callback: BuilderCallback<TableQueryBuilder<TTableOrName, SelectRow<TTableOrName>, TAvailableColumns>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>
  where(
    column: JsonColumnPath<TTableOrName, TAvailableColumns>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>
  where(
    columnOrCallback: string | BuilderCallback<TableQueryBuilder<TTableOrName, SelectRow<TTableOrName>, TAvailableColumns>>,
    operator?: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    if (typeof columnOrCallback === 'function') {
      return this.whereGroupWithBoolean('and', columnOrCallback)
    }

    const column = columnOrCallback
    return this.whereWithBoolean('and', column, operator, value)
  }

  orWhere(
    callback: BuilderCallback<TableQueryBuilder<TTableOrName, SelectRow<TTableOrName>, TAvailableColumns>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>
  orWhere(
    column: JsonColumnPath<TTableOrName, TAvailableColumns>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>
  orWhere(
    columnOrCallback: string | BuilderCallback<TableQueryBuilder<TTableOrName, SelectRow<TTableOrName>, TAvailableColumns>>,
    operator?: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    if (typeof columnOrCallback === 'function') {
      return this.whereGroupWithBoolean('or', columnOrCallback)
    }

    const column = columnOrCallback
    return this.whereWithBoolean('or', column, operator, value)
  }

  private whereGroupWithBoolean(
    boolean: 'and' | 'or',
    callback: BuilderCallback<TableQueryBuilder<TTableOrName, SelectRow<TTableOrName>, TAvailableColumns>>,
    negated = false,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    const table = (this.source.table ?? this.source.tableName) as TTableOrName
    const nestedPlan = { ...createSelectQueryPlan(this.source), joins: this.plan.joins }
    const nestedBuilder = new TableQueryBuilder<TTableOrName, SelectRow<TTableOrName>, TAvailableColumns>(table, this.connection, nestedPlan, undefined, internalPlanHandoff)
    const callbackResult = callback(nestedBuilder)
    const result = callbackResult instanceof TableQueryBuilder ? callbackResult : nestedBuilder
    const predicates = result.getPlan().predicates as readonly QueryPredicateNode[]

    if (predicates.length === 0) {
      return this
    }

    return this.clone(withPredicate(this.plan, {
      kind: 'group',
      boolean,
      negated,
      predicates,
    }))
  }

  whereNot(
    callback: BuilderCallback<TableQueryBuilder<TTableOrName, SelectRow<TTableOrName>, TAvailableColumns>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereGroupWithBoolean('and', callback, true)
  }

  orWhereNot(
    callback: BuilderCallback<TableQueryBuilder<TTableOrName, SelectRow<TTableOrName>, TAvailableColumns>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereGroupWithBoolean('or', callback, true)
  }

  whereExists(
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereExistsWithBoolean('and', subquery, false)
  }

  orWhereExists(
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereExistsWithBoolean('or', subquery, false)
  }

  whereNotExists(
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereExistsWithBoolean('and', subquery, true)
  }

  orWhereNotExists(
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereExistsWithBoolean('or', subquery, true)
  }

  whereSub(
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
    operator: QueryOperator,
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereSubWithBoolean('and', column, operator, subquery)
  }

  orWhereSub(
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
    operator: QueryOperator,
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereSubWithBoolean('or', column, operator, subquery)
  }

  whereInSub(
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereSubWithBoolean('and', column, 'in', subquery)
  }

  whereNotInSub(
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereSubWithBoolean('and', column, 'not in', subquery)
  }

  private whereWithBoolean(
    boolean: 'and' | 'or',
    column: string,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    if (column.includes('->')) {
      return this.whereJsonValueWithBoolean(boolean, column as JsonColumnPath<TTableOrName, TAvailableColumns>, operator, value)
    }

    const normalized = this.normalizeOperatorValue(operator, value)
    if (normalized.value === null && (normalized.operator === '=' || normalized.operator === '!=')) {
      return this.clone(withPredicate(this.plan, {
        kind: 'null',
        boolean,
        column,
        negated: normalized.operator === '!=',
      }))
    }

    return this.clone(withPredicate(this.plan, {
      kind: 'comparison',
      boolean,
      column,
      operator: normalized.operator as QueryOperator,
      ...this.normalizeComparisonValue(column, normalized.value, normalized.operator),
    }))
  }

  private whereExistsWithBoolean(
    boolean: 'and' | 'or',
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
    negated: boolean,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withPredicate(this.plan, {
      kind: 'exists',
      boolean,
      negated,
      subquery: subquery.getPlan(),
    }))
  }

  private whereSubWithBoolean(
    boolean: 'and' | 'or',
    column: string,
    operator: QueryOperator,
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withPredicate(this.plan, {
      kind: 'subquery',
      boolean,
      column,
      operator: operator as Exclude<QueryOperator, 'between' | 'not between'>,
      subquery: subquery.getPlan(),
    }))
  }

  private whereDatePart(
    boolean: 'and' | 'or',
    part: QueryDatePart,
    column: string,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    const normalized = this.normalizeOperatorValue(operator, value)
    const partValue = normalizeDatePartPredicateValue(part, normalized.value)

    return this.clone(withPredicate(this.plan, {
      kind: 'date',
      boolean,
      column,
      part,
      operator: normalized.operator as Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
      value: partValue ?? this.normalizePredicateValueForColumn(column, normalized.value, normalized.operator),
    }))
  }

  private isScalarJsonValue(value: unknown): boolean {
    return value === null
      || typeof value === 'string'
      || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
  }

  private createAggregateSelection(
    aggregate: QueryAggregateSelection['aggregate'],
    alias: string,
    column: string | '*',
  ): QueryAggregateSelection {
    return Object.freeze({
      kind: 'aggregate',
      aggregate,
      column,
      alias,
    })
  }

  private getColumnDefinition(column: string): AnyColumnDefinition | undefined {
    return this.source.table?.columns[column]
  }

  private isDateColumn(column: string): boolean {
    return (this.getSourceColumnDefinition(column) ?? this.getJoinedColumnDefinition(column))?.kind === 'date'
  }

  private getJoinedColumnDefinition(column: string): AnyColumnDefinition | undefined {
    const separator = column.lastIndexOf('.')
    if (separator === -1) return undefined

    const qualifier = column.slice(0, separator)
    const join = this.plan.joins.find(({ alias, table, definition }) => definition && (alias === undefined
      ? table === qualifier || (table !== undefined && splitTablePath(table).table === qualifier)
      : alias === qualifier))
    return join?.definition?.columns[column.slice(separator + 1)]
  }

  private getSourceColumnDefinition(column: string): AnyColumnDefinition | undefined {
    const columnName = this.resolveSourceColumnName(column)
    return typeof columnName === 'undefined' ? undefined : this.getColumnDefinition(columnName)
  }

  private resolveSourceColumnName(column: string): string | undefined {
    return resolveSourceColumnName(this.source, column)
  }

  private assertJsonRootColumn(column: string, methodName: string): void {
    const columnDefinition = this.getSourceColumnDefinition(column)
    if (columnDefinition && !storesJson(this.connection.getDriver() as SchemaDialectName, columnDefinition)) {
      throw new SecurityError(`${methodName}() requires "${column}" to be a JSON column.`)
    }
  }

  private parseJsonPath(
    input: string,
    allowRoot: boolean,
    methodName: string,
  ): { column: string, path: readonly string[] } {
    const normalized = input.trim()
    if (!normalized) {
      throw new SecurityError(`${methodName}() requires a non-empty JSON column path.`)
    }

    if (/->>|#>>?|@>/.test(normalized)) {
      throw new SecurityError(`Use portable JSON path syntax like "settings->profile->region" instead of database-specific JSON operators in "${input}".`)
    }

    if (!normalized.includes('->')) {
      this.assertJsonRootColumn(normalized, methodName)
      return {
        column: normalized,
        path: Object.freeze([]),
      }
    }

    const rawSegments = normalized.split('->').map(segment => segment.trim())
    if (rawSegments.length < 2 || rawSegments.some(segment => segment.length === 0)) {
      throw new SecurityError(`${methodName}() received a malformed JSON path "${input}".`)
    }

    const [column, ...path] = rawSegments
    this.assertJsonRootColumn(column!, methodName)

    return {
      column: column!,
      path: Object.freeze(path),
    }
  }

  private whereJsonValueWithBoolean(
    boolean: 'and' | 'or',
    columnPath: JsonColumnPath<TTableOrName, TAvailableColumns>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    const { column, path } = this.parseJsonPath(columnPath, true, 'whereJson')
    const normalizedOperator = typeof value === 'undefined' ? '=' : operator as QueryOperator
    const normalizedValue = typeof value === 'undefined' ? operator : value

    if (!this.isScalarJsonValue(normalizedValue)) {
      throw new SecurityError(`whereJson() only supports scalar JSON comparisons on "${columnPath}"; use whereJsonContains() for arrays or objects.`)
    }

    if (normalizedValue === null && normalizedOperator !== '=' && normalizedOperator !== '!=') {
      throw new SecurityError('whereJson() only supports "=" or "!=" when comparing JSON values to null.')
    }

    return this.clone(withPredicate(this.plan, {
      kind: 'json',
      boolean,
      column,
      path,
      jsonMode: 'value',
      operator: normalizedOperator as Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
      value: normalizedValue,
    }))
  }

  private whereJsonContainsWithBoolean(
    boolean: 'and' | 'or',
    columnPath: string,
    value: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    const { column, path } = this.parseJsonPath(columnPath, true, 'whereJsonContains')

    return this.clone(withPredicate(this.plan, {
      kind: 'json',
      boolean,
      column,
      path,
      jsonMode: 'contains',
      value,
    }))
  }

  private whereJsonLengthWithBoolean(
    boolean: 'and' | 'or',
    columnPath: string,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    const { column, path } = this.parseJsonPath(columnPath, true, 'whereJsonLength')
    const normalizedOperator = typeof value === 'undefined' ? '=' : operator as QueryOperator
    const normalizedValue = typeof value === 'undefined' ? operator : value

    return this.clone(withPredicate(this.plan, {
      kind: 'json',
      boolean,
      column,
      path,
      jsonMode: 'length',
      operator: normalizedOperator as Exclude<QueryOperator, 'in' | 'not in'>,
      value: normalizedValue,
    }))
  }

  whereNull(column: DeclaredColumnName<TTableOrName, TAvailableColumns>): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereNullWithBoolean('and', column)
  }

  orWhereNull(column: DeclaredColumnName<TTableOrName, TAvailableColumns>): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereNullWithBoolean('or', column)
  }

  private whereNullWithBoolean(
    boolean: 'and' | 'or',
    column: string,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withPredicate(this.plan, {
      kind: 'null',
      boolean,
      column,
      negated: false,
    }))
  }

  whereNotNull(column: DeclaredColumnName<TTableOrName, TAvailableColumns>): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereNotNullWithBoolean('and', column)
  }

  orWhereNotNull(column: DeclaredColumnName<TTableOrName, TAvailableColumns>): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereNotNullWithBoolean('or', column)
  }

  private whereNotNullWithBoolean(
    boolean: 'and' | 'or',
    column: string,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withPredicate(this.plan, {
      kind: 'null',
      boolean,
      column,
      negated: true,
    }))
  }

  whereColumn(column: ColumnReference<TTableOrName>, compareTo: ColumnReference<TTableOrName>): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>
  whereColumn(
    column: ColumnReference<TTableOrName>,
    operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
    compareTo: ColumnReference<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>
  whereColumn(column: string, operatorOrCompareTo: string, compareTo?: string): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereColumnWithBoolean('and', column, operatorOrCompareTo, compareTo)
  }

  orWhereColumn(column: ColumnReference<TTableOrName>, compareTo: ColumnReference<TTableOrName>): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>
  orWhereColumn(
    column: ColumnReference<TTableOrName>,
    operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
    compareTo: ColumnReference<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>
  orWhereColumn(column: string, operatorOrCompareTo: string, compareTo?: string): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereColumnWithBoolean('or', column, operatorOrCompareTo, compareTo)
  }

  private whereColumnWithBoolean(
    boolean: 'and' | 'or',
    column: string,
    operatorOrCompareTo: string,
    compareTo?: string,
    casts?: QueryKeyCasts,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    const comparedColumn = compareTo ?? operatorOrCompareTo
    const dateOperands = { column: this.isDateColumn(column), compareTo: this.isDateColumn(comparedColumn) }
    return this.clone(withPredicate(this.plan, {
      kind: 'column',
      boolean,
      column,
      operator: (typeof compareTo === 'undefined' ? '=' : operatorOrCompareTo) as QueryColumnPredicate['operator'],
      compareTo: comparedColumn,
      ...(dateOperands.column || dateOperands.compareTo ? { dateOperands } : {}),
      ...(casts?.left || casts?.right ? { keyCasts: casts } : {}),
    }))
  }

  whereIn(column: DeclaredColumnName<TTableOrName, TAvailableColumns>, values: readonly unknown[] | TableQueryBuilder<TableDefinition, Record<string, unknown>>): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereInWithBoolean('and', column, values, 'in')
  }

  orWhereIn(column: DeclaredColumnName<TTableOrName, TAvailableColumns>, values: readonly unknown[] | TableQueryBuilder<TableDefinition, Record<string, unknown>>): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereInWithBoolean('or', column, values, 'in')
  }

  whereNotIn(column: DeclaredColumnName<TTableOrName, TAvailableColumns>, values: readonly unknown[] | TableQueryBuilder<TableDefinition, Record<string, unknown>>): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereInWithBoolean('and', column, values, 'not in')
  }

  orWhereNotIn(column: DeclaredColumnName<TTableOrName, TAvailableColumns>, values: readonly unknown[] | TableQueryBuilder<TableDefinition, Record<string, unknown>>): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereInWithBoolean('or', column, values, 'not in')
  }

  whereBetween(column: DeclaredColumnName<TTableOrName, TAvailableColumns>, range: readonly [unknown, unknown]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereBetweenWithBoolean('and', column, range, 'between')
  }

  orWhereBetween(column: DeclaredColumnName<TTableOrName, TAvailableColumns>, range: readonly [unknown, unknown]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereBetweenWithBoolean('or', column, range, 'between')
  }

  whereNotBetween(column: DeclaredColumnName<TTableOrName, TAvailableColumns>, range: readonly [unknown, unknown]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereBetweenWithBoolean('and', column, range, 'not between')
  }

  orWhereNotBetween(column: DeclaredColumnName<TTableOrName, TAvailableColumns>, range: readonly [unknown, unknown]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereBetweenWithBoolean('or', column, range, 'not between')
  }

  private whereInWithBoolean(
    boolean: 'and' | 'or',
    column: string,
    values: readonly unknown[] | TableQueryBuilder<TableDefinition, Record<string, unknown>>,
    operator: 'in' | 'not in',
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    if (values instanceof TableQueryBuilder) {
      return this.whereSubWithBoolean(boolean, column, operator, values)
    }

    return this.clone(withPredicate(this.plan, {
      kind: 'comparison',
      boolean,
      column,
      operator,
      ...this.normalizeComparisonValue(column, values, operator),
    }))
  }

  private whereBetweenWithBoolean(
    boolean: 'and' | 'or',
    column: string,
    range: readonly [unknown, unknown],
    operator: 'between' | 'not between',
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withPredicate(this.plan, {
      kind: 'comparison',
      boolean,
      column,
      operator,
      ...this.normalizeComparisonValue(column, range, operator),
    }))
  }

  whereBetweenColumns(column: DeclaredColumnName<TTableOrName, TAvailableColumns>, columns: readonly [DeclaredColumnName<TTableOrName, TAvailableColumns>, DeclaredColumnName<TTableOrName, TAvailableColumns>]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereBetweenColumnsWithBoolean('and', { column }, columns, false)
  }

  orWhereBetweenColumns(column: DeclaredColumnName<TTableOrName, TAvailableColumns>, columns: readonly [DeclaredColumnName<TTableOrName, TAvailableColumns>, DeclaredColumnName<TTableOrName, TAvailableColumns>]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereBetweenColumnsWithBoolean('or', { column }, columns, false)
  }

  whereNotBetweenColumns(column: DeclaredColumnName<TTableOrName, TAvailableColumns>, columns: readonly [DeclaredColumnName<TTableOrName, TAvailableColumns>, DeclaredColumnName<TTableOrName, TAvailableColumns>]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereBetweenColumnsWithBoolean('and', { column }, columns, true)
  }

  orWhereNotBetweenColumns(column: DeclaredColumnName<TTableOrName, TAvailableColumns>, columns: readonly [DeclaredColumnName<TTableOrName, TAvailableColumns>, DeclaredColumnName<TTableOrName, TAvailableColumns>]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereBetweenColumnsWithBoolean('or', { column }, columns, true)
  }

  whereValueBetween(value: unknown, columns: readonly [DeclaredColumnName<TTableOrName, TAvailableColumns>, DeclaredColumnName<TTableOrName, TAvailableColumns>]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereBetweenColumnsWithBoolean('and', { value }, columns, false)
  }

  orWhereValueBetween(value: unknown, columns: readonly [DeclaredColumnName<TTableOrName, TAvailableColumns>, DeclaredColumnName<TTableOrName, TAvailableColumns>]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereBetweenColumnsWithBoolean('or', { value }, columns, false)
  }

  whereValueNotBetween(value: unknown, columns: readonly [DeclaredColumnName<TTableOrName, TAvailableColumns>, DeclaredColumnName<TTableOrName, TAvailableColumns>]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereBetweenColumnsWithBoolean('and', { value }, columns, true)
  }

  orWhereValueNotBetween(value: unknown, columns: readonly [DeclaredColumnName<TTableOrName, TAvailableColumns>, DeclaredColumnName<TTableOrName, TAvailableColumns>]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereBetweenColumnsWithBoolean('or', { value }, columns, true)
  }

  private whereBetweenColumnsWithBoolean(
    boolean: 'and' | 'or',
    subject: QueryBetweenColumnsPredicate['subject'],
    bounds: readonly [string, string],
    negated: boolean,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withPredicate(this.plan, {
      kind: 'between-columns',
      boolean,
      subject: 'value' in subject
        ? { value: this.normalizePredicateValueForColumn(bounds[0], subject.value) }
        : subject,
      bounds,
      negated,
    }))
  }

  whereLike(
    column: JsonColumnPath<TTableOrName, TAvailableColumns>,
    value: string,
    caseSensitive = false,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereLikeWithBoolean('and', column, value, caseSensitive, false)
  }

  orWhereLike(
    column: JsonColumnPath<TTableOrName, TAvailableColumns>,
    value: string,
    caseSensitive = false,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereLikeWithBoolean('or', column, value, caseSensitive, false)
  }

  whereNotLike(
    column: JsonColumnPath<TTableOrName, TAvailableColumns>,
    value: string,
    caseSensitive = false,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereLikeWithBoolean('and', column, value, caseSensitive, true)
  }

  orWhereNotLike(
    column: JsonColumnPath<TTableOrName, TAvailableColumns>,
    value: string,
    caseSensitive = false,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereLikeWithBoolean('or', column, value, caseSensitive, true)
  }

  private whereLikeWithBoolean(
    boolean: 'and' | 'or',
    column: string,
    value: string,
    caseSensitive: boolean,
    negated: boolean,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    const target = column.includes('->')
      ? this.parseJsonPath(column, false, 'whereLike')
      : { column, path: [] }
    return this.clone(withPredicate(this.plan, {
      kind: 'like',
      boolean,
      column: target.column,
      path: target.path,
      value,
      caseSensitive,
      negated,
    }))
  }

  whereAny(
    columns: readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[],
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereMultiColumns('and', 'any', columns, operator, value)
  }

  orWhereAny(
    columns: readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[],
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereMultiColumns('or', 'any', columns, operator, value)
  }

  whereAll(
    columns: readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[],
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereMultiColumns('and', 'all', columns, operator, value)
  }

  orWhereAll(
    columns: readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[],
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereMultiColumns('or', 'all', columns, operator, value)
  }

  whereNone(
    columns: readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[],
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereMultiColumns('and', 'none', columns, operator, value)
  }

  orWhereNone(
    columns: readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[],
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereMultiColumns('or', 'none', columns, operator, value)
  }

  whereDate(
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereDatePart('and', 'date', column, operator, value)
  }

  orWhereDate(
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereDatePart('or', 'date', column, operator, value)
  }

  whereMonth(
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereDatePart('and', 'month', column, operator, value)
  }

  orWhereMonth(
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereDatePart('or', 'month', column, operator, value)
  }

  whereDay(
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereDatePart('and', 'day', column, operator, value)
  }

  orWhereDay(
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereDatePart('or', 'day', column, operator, value)
  }

  whereYear(
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereDatePart('and', 'year', column, operator, value)
  }

  orWhereYear(
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereDatePart('or', 'year', column, operator, value)
  }

  whereTime(
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereDatePart('and', 'time', column, operator, value)
  }

  orWhereTime(
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereDatePart('or', 'time', column, operator, value)
  }

  wherePast(columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereRelativeToNow('and', columns, '<')
  }

  orWherePast(columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereRelativeToNow('or', columns, '<')
  }

  whereNowOrPast(columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereRelativeToNow('and', columns, '<=')
  }

  orWhereNowOrPast(columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereRelativeToNow('or', columns, '<=')
  }

  whereFuture(columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereRelativeToNow('and', columns, '>')
  }

  orWhereFuture(columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereRelativeToNow('or', columns, '>')
  }

  whereNowOrFuture(columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereRelativeToNow('and', columns, '>=')
  }

  orWhereNowOrFuture(columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereRelativeToNow('or', columns, '>=')
  }

  whereToday(columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereRelativeToToday('and', columns, '=')
  }

  orWhereToday(columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereRelativeToToday('or', columns, '=')
  }

  whereBeforeToday(columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereRelativeToToday('and', columns, '<')
  }

  orWhereBeforeToday(columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereRelativeToToday('or', columns, '<')
  }

  whereTodayOrBefore(columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereRelativeToToday('and', columns, '<=')
  }

  orWhereTodayOrBefore(columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereRelativeToToday('or', columns, '<=')
  }

  whereAfterToday(columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereRelativeToToday('and', columns, '>')
  }

  orWhereAfterToday(columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereRelativeToToday('or', columns, '>')
  }

  whereTodayOrAfter(columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereRelativeToToday('and', columns, '>=')
  }

  orWhereTodayOrAfter(columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereRelativeToToday('or', columns, '>=')
  }

  private whereRelativeToNow(
    boolean: 'and' | 'or',
    columns: string | readonly string[],
    operator: '<' | '<=' | '>' | '>=',
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    const now = new Date()
    const today = formatCalendarDate(now, getApplicationTimezone())
    return (typeof columns === 'string' ? [columns] : columns)
      .reduce<TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>>((query, column) => query.isDateColumn(column)
        ? query.whereDatePart(boolean, 'date', column, operator, today)
        : query.whereDatePart(boolean, 'instant', column, operator, now), this)
  }

  private whereRelativeToToday(
    boolean: 'and' | 'or',
    columns: string | readonly string[],
    operator: '=' | '<' | '<=' | '>' | '>=',
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    const now = new Date()
    const timeZone = getApplicationTimezone()
    const today = formatCalendarDate(now, timeZone)
    const startOfToday = startOfDayInTimezone(now, timeZone)
    const startOfTomorrow = startOfDayInTimezone(now, timeZone, 1)
    return (typeof columns === 'string' ? [columns] : columns)
      .reduce<TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>>((query, column) => {
        if (query.isDateColumn(column)) {
          return query.whereDatePart(boolean, 'date', column, operator, today)
        }

        switch (operator) {
          case '=':
            return query.whereGroupWithBoolean(boolean, group => group
              .whereDatePart('and', 'instant', column, '>=', startOfToday)
              .whereDatePart('and', 'instant', column, '<', startOfTomorrow))
          case '<':
            return query.whereDatePart(boolean, 'instant', column, '<', startOfToday)
          case '<=':
            return query.whereDatePart(boolean, 'instant', column, '<', startOfTomorrow)
          case '>':
            return query.whereDatePart(boolean, 'instant', column, '>=', startOfTomorrow)
          case '>=':
            return query.whereDatePart(boolean, 'instant', column, '>=', startOfToday)
        }
      }, this)
  }

  whereJson(
    columnPath: JsonColumnPath<TTableOrName, TAvailableColumns>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereJsonValueWithBoolean('and', columnPath, operator, value)
  }

  orWhereJson(
    columnPath: JsonColumnPath<TTableOrName, TAvailableColumns>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereJsonValueWithBoolean('or', columnPath, operator, value)
  }

  whereJsonContains(
    columnPath: JsonColumnPath<TTableOrName, TAvailableColumns>,
    value: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereJsonContainsWithBoolean('and', columnPath, value)
  }

  orWhereJsonContains(
    columnPath: JsonColumnPath<TTableOrName, TAvailableColumns>,
    value: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereJsonContainsWithBoolean('or', columnPath, value)
  }

  whereJsonDoesntContain(columnPath: JsonColumnPath<TTableOrName, TAvailableColumns>, value: unknown): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereGroupWithBoolean('and', query => query.whereJsonContainsWithBoolean('and', columnPath, value), true)
  }

  orWhereJsonDoesntContain(columnPath: JsonColumnPath<TTableOrName, TAvailableColumns>, value: unknown): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereGroupWithBoolean('or', query => query.whereJsonContainsWithBoolean('and', columnPath, value), true)
  }

  whereJsonContainsKey(columnPath: JsonColumnPath<TTableOrName, TAvailableColumns>): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereJsonContainsKeyWithBoolean('and', columnPath)
  }

  orWhereJsonContainsKey(columnPath: JsonColumnPath<TTableOrName, TAvailableColumns>): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereJsonContainsKeyWithBoolean('or', columnPath)
  }

  whereJsonDoesntContainKey(columnPath: JsonColumnPath<TTableOrName, TAvailableColumns>): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereGroupWithBoolean('and', query => query.whereJsonContainsKeyWithBoolean('and', columnPath), true)
  }

  orWhereJsonDoesntContainKey(columnPath: JsonColumnPath<TTableOrName, TAvailableColumns>): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereGroupWithBoolean('or', query => query.whereJsonContainsKeyWithBoolean('and', columnPath), true)
  }

  private whereJsonContainsKeyWithBoolean(
    boolean: 'and' | 'or',
    columnPath: string,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    const { column, path } = this.parseJsonPath(columnPath, false, 'whereJsonContainsKey')

    return this.clone(withPredicate(this.plan, {
      kind: 'json',
      boolean,
      column,
      path,
      jsonMode: 'key',
      value: undefined,
    }))
  }

  whereJsonLength(
    columnPath: JsonColumnPath<TTableOrName, TAvailableColumns>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereJsonLengthWithBoolean('and', columnPath, operator, value)
  }

  groupBy(...columns: readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withGroupBy(this.plan, columns))
  }

  join<const TJoinedTable extends TableDefinition>(
    table: TJoinedTable,
    leftColumn: keyof (TAvailableColumns & QualifiedTableColumns<NoInfer<TJoinedTable>>) & string,
    operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
    rightColumn: keyof (TAvailableColumns & QualifiedTableColumns<NoInfer<TJoinedTable>>) & string,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns & QualifiedTableColumns<TJoinedTable>>
  join(
    table: string,
    leftColumn: ColumnReference<TTableOrName>,
    operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
    rightColumn: ColumnReference<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns & Record<string, unknown>>
  join(
    table: TableReference,
    leftColumn: string,
    operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
    rightColumn: string,
  ): TableQueryBuilder<TTableOrName, Record<string, unknown>, Record<string, unknown>> {
    return this.clone(withJoin(this.plan, {
      type: 'inner',
      ...resolveJoinTarget(table),
      leftColumn,
      operator,
      rightColumn,
    }))
  }

  leftJoin<const TJoinedTable extends TableDefinition>(
    table: TJoinedTable,
    leftColumn: keyof (TAvailableColumns & QualifiedTableColumns<NoInfer<TJoinedTable>>) & string,
    operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
    rightColumn: keyof (TAvailableColumns & QualifiedTableColumns<NoInfer<TJoinedTable>>) & string,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns & NullableColumns<QualifiedTableColumns<TJoinedTable>>>
  leftJoin(
    table: string,
    leftColumn: ColumnReference<TTableOrName>,
    operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
    rightColumn: ColumnReference<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns & Record<string, unknown>>
  leftJoin(
    table: TableReference,
    leftColumn: string,
    operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
    rightColumn: string,
  ): TableQueryBuilder<TTableOrName, Record<string, unknown>, Record<string, unknown>> {
    return this.clone(withJoin(this.plan, {
      type: 'left',
      ...resolveJoinTarget(table),
      leftColumn,
      operator,
      rightColumn,
    }))
  }

  rightJoin<const TJoinedTable extends TableDefinition>(
    table: TJoinedTable,
    leftColumn: keyof (TAvailableColumns & QualifiedTableColumns<NoInfer<TJoinedTable>>) & string,
    operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
    rightColumn: keyof (TAvailableColumns & QualifiedTableColumns<NoInfer<TJoinedTable>>) & string,
  ): TableQueryBuilder<TTableOrName, NullableColumns<TSelectedRow>, NullableColumns<TAvailableColumns> & QualifiedTableColumns<TJoinedTable>>
  rightJoin(
    table: string,
    leftColumn: ColumnReference<TTableOrName>,
    operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
    rightColumn: ColumnReference<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns & Record<string, unknown>>
  rightJoin(
    table: TableReference,
    leftColumn: string,
    operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
    rightColumn: string,
  ): TableQueryBuilder<TTableOrName, Record<string, unknown>, Record<string, unknown>> {
    return this.clone(withJoin(this.plan, {
      type: 'right',
      ...resolveJoinTarget(table),
      leftColumn,
      operator,
      rightColumn,
    }))
  }

  joinSub(
    query: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
    alias: string,
    leftColumn: ColumnReference<TTableOrName>,
    operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
    rightColumn: ColumnReference<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns & Record<string, unknown>> {
    return this.clone(withJoin(this.plan, {
      type: 'inner',
      subquery: query.getPlan(),
      alias,
      leftColumn,
      operator,
      rightColumn,
    }))
  }

  leftJoinSub(
    query: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
    alias: string,
    leftColumn: ColumnReference<TTableOrName>,
    operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
    rightColumn: ColumnReference<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns & Record<string, unknown>> {
    return this.clone(withJoin(this.plan, {
      type: 'left',
      subquery: query.getPlan(),
      alias,
      leftColumn,
      operator,
      rightColumn,
    }))
  }

  rightJoinSub(
    query: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
    alias: string,
    leftColumn: ColumnReference<TTableOrName>,
    operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
    rightColumn: ColumnReference<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns & Record<string, unknown>> {
    return this.clone(withJoin(this.plan, {
      type: 'right',
      subquery: query.getPlan(),
      alias,
      leftColumn,
      operator,
      rightColumn,
    }))
  }

  joinLateral(
    query: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
    alias: string,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns & Record<string, unknown>> {
    return this.clone(withJoin(this.plan, {
      type: 'inner',
      subquery: query.getPlan(),
      alias,
      lateral: true,
    }))
  }

  leftJoinLateral(
    query: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
    alias: string,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns & Record<string, unknown>> {
    return this.clone(withJoin(this.plan, {
      type: 'left',
      subquery: query.getPlan(),
      alias,
      lateral: true,
    }))
  }

  crossJoin<const TJoinedTable extends TableDefinition>(
    table: TJoinedTable,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns & QualifiedTableColumns<TJoinedTable>>
  crossJoin(table: string): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns & Record<string, unknown>>
  crossJoin(table: TableReference): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns & Record<string, unknown>> {
    return this.clone(withJoin(this.plan, {
      type: 'cross',
      ...resolveJoinTarget(table),
    }))
  }

  union(
    query: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withUnion(this.plan, {
      all: false,
      query: query.getPlan(),
    }))
  }

  unionAll(
    query: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withUnion(this.plan, {
      all: true,
      query: query.getPlan(),
    }))
  }

  having(
    expression: string,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    const normalizedOperator = typeof value === 'undefined' ? '=' : operator as QueryOperator
    const normalizedValue = typeof value === 'undefined' ? operator : value
    return this.clone(withHaving(this.plan, {
      kind: 'comparison',
      boolean: 'and',
      expression,
      operator: normalizedOperator as Exclude<QueryOperator, 'in' | 'not in'>,
      value: normalizedValue,
    }))
  }

  orHaving(
    expression: string,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    const normalizedOperator = typeof value === 'undefined' ? '=' : operator as QueryOperator
    const normalizedValue = typeof value === 'undefined' ? operator : value
    return this.clone(withHaving(this.plan, {
      kind: 'comparison',
      boolean: 'or',
      expression,
      operator: normalizedOperator as Exclude<QueryOperator, 'in' | 'not in'>,
      value: normalizedValue,
    }))
  }

  havingBetween(expression: string, range: readonly [unknown, unknown]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withHaving(this.plan, {
      kind: 'comparison',
      boolean: 'and',
      expression,
      operator: 'between',
      value: range,
    }))
  }

  orHavingBetween(expression: string, range: readonly [unknown, unknown]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withHaving(this.plan, {
      kind: 'comparison',
      boolean: 'or',
      expression,
      operator: 'between',
      value: range,
    }))
  }

  havingNotBetween(expression: string, range: readonly [unknown, unknown]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withHaving(this.plan, {
      kind: 'comparison',
      boolean: 'and',
      expression,
      operator: 'not between',
      value: range,
    }))
  }

  orHavingNotBetween(expression: string, range: readonly [unknown, unknown]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withHaving(this.plan, {
      kind: 'comparison',
      boolean: 'or',
      expression,
      operator: 'not between',
      value: range,
    }))
  }

  havingNull(expressions: string | readonly string[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return (typeof expressions === 'string' ? [expressions] : expressions)
      .reduce<TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>>((query, expression) => query.clone(withHaving(query.plan, {
        kind: 'null',
        boolean: 'and',
        expression,
        negated: false,
      })), this)
  }

  orHavingNull(expressions: string | readonly string[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return (typeof expressions === 'string' ? [expressions] : expressions)
      .reduce<TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>>((query, expression) => query.clone(withHaving(query.plan, {
        kind: 'null',
        boolean: 'or',
        expression,
        negated: false,
      })), this)
  }

  havingNotNull(expressions: string | readonly string[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return (typeof expressions === 'string' ? [expressions] : expressions)
      .reduce<TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>>((query, expression) => query.clone(withHaving(query.plan, {
        kind: 'null',
        boolean: 'and',
        expression,
        negated: true,
      })), this)
  }

  orHavingNotNull(expressions: string | readonly string[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return (typeof expressions === 'string' ? [expressions] : expressions)
      .reduce<TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>>((query, expression) => query.clone(withHaving(query.plan, {
        kind: 'null',
        boolean: 'or',
        expression,
        negated: true,
      })), this)
  }

  orWhereJsonLength(
    columnPath: string,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereJsonLengthWithBoolean('or', columnPath, operator, value)
  }

  unsafeWhere(
    sql: string,
    bindings: readonly unknown[],
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withPredicate(this.plan, {
      kind: 'raw',
      boolean: 'and',
      sql,
      bindings: Object.freeze([...bindings]),
    }))
  }

  orUnsafeWhere(
    sql: string,
    bindings: readonly unknown[],
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withPredicate(this.plan, {
      kind: 'raw',
      boolean: 'or',
      sql,
      bindings: Object.freeze([...bindings]),
    }))
  }

  whereFullText(
    columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[],
    value: string,
    options: { mode?: 'natural' | 'boolean' } = {},
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereFullTextWithBoolean('and', columns, value, options)
  }

  orWhereFullText(
    columns: DeclaredColumnName<TTableOrName, TAvailableColumns> | readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[],
    value: string,
    options: { mode?: 'natural' | 'boolean' } = {},
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereFullTextWithBoolean('or', columns, value, options)
  }

  whereVectorSimilarTo(
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
    vector: readonly number[],
    minSimilarity = 0,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereVectorSimilarToWithBoolean('and', column, vector, minSimilarity)
  }

  orWhereVectorSimilarTo(
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
    vector: readonly number[],
    minSimilarity = 0,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.whereVectorSimilarToWithBoolean('or', column, vector, minSimilarity)
  }

  when<TValue>(
    value: TValue,
    callback: ValueBuilderCallback<TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>, TValue>,
    defaultCallback?: ValueBuilderCallback<TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>, TValue>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    if (value) {
      const result = callback(this, value)
      return result instanceof TableQueryBuilder ? result : this
    }

    const result = defaultCallback?.(this, value)
    return result instanceof TableQueryBuilder ? result : this
  }

  unless<TValue>(
    value: TValue,
    callback: ValueBuilderCallback<TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>, TValue>,
    defaultCallback?: ValueBuilderCallback<TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>, TValue>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    if (!value) {
      const result = callback(this, value)
      return result instanceof TableQueryBuilder ? result : this
    }

    const result = defaultCallback?.(this, value)
    return result instanceof TableQueryBuilder ? result : this
  }

  withoutWhereNull(column: DeclaredColumnName<TTableOrName, TAvailableColumns>): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withoutPredicates(this.plan, predicate => (
      predicate.kind === 'null' && predicate.column === column && predicate.negated === false
    )))
  }

  withoutWhereNotNull(column: DeclaredColumnName<TTableOrName, TAvailableColumns>): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withoutPredicates(this.plan, predicate => (
      predicate.kind === 'null' && predicate.column === column && predicate.negated === true
    )))
  }

  orderByDesc(column: DeclaredColumnName<TTableOrName, TAvailableColumns>): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.orderBy(column, 'desc')
  }

  orderBy(
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
    direction: QueryDirection = 'asc',
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withOrderBy(this.plan, {
      kind: 'column',
      column,
      direction,
    }))
  }

  unsafeOrderBy(
    sql: string,
    bindings: readonly unknown[],
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withOrderBy(this.plan, {
      kind: 'raw',
      sql,
      bindings: Object.freeze([...bindings]),
    }))
  }

  inRandomOrder(): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(replaceOrderBy(this.plan, [Object.freeze({
      kind: 'random' as const,
    })]))
  }

  latest(column: DeclaredColumnName<TTableOrName, TAvailableColumns> = 'created_at' as DeclaredColumnName<TTableOrName, TAvailableColumns>): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.orderBy(column, 'desc')
  }

  oldest(column: DeclaredColumnName<TTableOrName, TAvailableColumns> = 'created_at' as DeclaredColumnName<TTableOrName, TAvailableColumns>): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.orderBy(column, 'asc')
  }

  reorder(
    column?: DeclaredColumnName<TTableOrName, TAvailableColumns>,
    direction: QueryDirection = 'asc',
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    const reordered = replaceOrderBy(this.plan, [])
    if (!column) {
      return this.clone(reordered)
    }

    return this.clone(withOrderBy(reordered, {
      kind: 'column',
      column,
      direction,
    }))
  }

  orderByVectorSimilarity(
    column: DeclaredColumnName<TTableOrName, TAvailableColumns>,
    vector: readonly number[],
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withOrderBy(this.plan, {
      kind: 'vector',
      column,
      vector: Object.freeze([...vector]),
    }))
  }

  lock(mode: 'update' | 'share'): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withLockMode(this.plan, mode))
  }

  lockForUpdate(): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.lock('update')
  }

  sharedLock(): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.lock('share')
  }

  limit(value?: number): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withLimit(this.plan, value))
  }

  offset(value?: number): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.clone(withOffset(this.plan, value))
  }

  skip(value: number): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.offset(value)
  }

  take(value: number): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this.limit(value)
  }

  forPage(page: number, perPage = 15): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    assertPositiveInteger(page, 'Page', message => new SecurityError(message))
    assertPositiveInteger(perPage, 'Per-page value', message => new SecurityError(message))

    return this.limit(perPage).offset((page - 1) * perPage)
  }

  toSQL() {
    return this.getCompiler().compile(this.plan)
  }

  toRawSql(): string {
    const statement = this.toSQL()
    return this.getCompiler().substituteBindings(statement.sql, statement.bindings ?? [])
  }

  debug() {
    const statement = this.toSQL()
    const bindings = redactBindings(statement.bindings ?? [], this.connection.getSecurityPolicy())
    const schedulingMode = this.connection.getSchedulingModeHint()
    return {
      ...statement,
      bindings,
      connectionName: this.connection.getConnectionName(),
      scope: this.connection.getScope().kind,
      schedulingMode,
      metadata: statement.metadata
        ? {
            ...statement.metadata,
            debug: {
              ...statement.metadata.debug,
              connectionName: this.connection.getConnectionName(),
              scope: this.connection.getScope().kind,
              schedulingMode,
            },
          }
        : undefined,
    }
  }

  dump(): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    console.log(this.debug())
    return this
  }

  [hasQueryCache](): boolean {
    return this.queryCacheConfig !== undefined
  }

  [resolveAggregateSource](column: string, modelRow = false): {
    readonly key: string
    readonly joined: boolean
    readonly selections: readonly string[]
    readonly cache?: NormalizedQueryCacheConfig
  } {
    const root = column.split('->', 1)[0]!
    const qualifier = root.slice(0, root.lastIndexOf('.'))
    const join = typeof this.resolveSourceColumnName(root) === 'undefined'
      ? this.plan.joins.find(join => qualifiesTable(qualifier, join.table, join.alias))
      : undefined
    if (this.plan.joins.length > 0 && this.plan.unions.length > 0) {
      throw new CompilerError(`Cannot aggregate column "${column}" on a joined query with a union.`)
    }
    const key = join ? column.slice(qualifier.length + 1) : Object.keys(this.resolveSourceColumnKeys([[column, column]], 'aggregate'))[0]!
    const source = join ? join.alias ?? join.table! : this.source.alias ?? this.source.tableName
    const wildcard = (table: string) => tableWildcard(table, this.connection.getDriver())
    const implicitSelections = this.plan.selections.length > 0
      ? []
      : [this.source.alias ?? this.source.tableName, ...this.plan.joins.map(join => join.alias ?? join.table!)].map(wildcard)
    const selections = !modelRow || join
      ? [...implicitSelections, `${source}.${key} as ${aggregateValueKey}`]
      : implicitSelections.length > 0
        ? [...implicitSelections, wildcard(source)]
        : this.modelAggregateSelections(column, source, key, wildcard(source))
    return { key, joined: !!join, selections, cache: this.plan.joins.length > 0 ? this.projectAggregate(selections).queryCacheConfig : undefined }
  }

  [projectModelRows](): { readonly query: TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> } {
    const connectionName = this.connection.getConnectionName()
    const plan = projectModelRowPlan(this.plan, this.connection.getDriver(), join => knownJoinedColumns(join, connectionName))
    return { query: plan === this.plan ? this : this.clone(plan) }
  }

  cache(
    config: QueryCacheTtlInput | QueryCacheConfig,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return new TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>(
      (this.source.table ?? this.source.tableName) as TTableOrName,
      this.connection,
      this.plan,
      normalizeQueryCacheConfig(config),
      internalPlanHandoff,
    )
  }

  async get<TRow extends Record<string, unknown> = TSelectedRow>(): Promise<TRow[]> {
    return this.getCompiledRows<TRow>(this.toSQL())
  }

  private async getCompiledRows<TRow extends Record<string, unknown>>(
    statement: CompiledStatement,
    collectObservation = true,
    scopeCacheKey = false,
    convertColumns = true,
  ): Promise<TRow[]> {
    await this.bindGeneratedTable()
    const cacheConfig = this.queryCacheConfig
    const activeDependencyCollector = hasActiveDatabaseDependencyCollector()
    if (activeDependencyCollector || (cacheConfig && !this.plan.lockMode)) {
      await resolvePlanTableIdentities(this.connection, this.plan)
      for (const dependency of cacheConfig?.invalidate ?? []) {
        if (!dependency.startsWith('db:')) await resolveTableIdentity(this.connection, dependency)
      }
    }
    const dependencies = this.plan.lockMode
      || (!cacheConfig && !activeDependencyCollector)
      ? undefined
      : resolveQueryCacheDependencies(
          this.plan,
          this.connection.getConnectionName(),
          cacheConfig?.invalidate,
          cacheConfig?.invalidate?.length ? false : await this.resolveQueryTextMatching(),
    )
    const observationDependencies = activeDependencyCollector && !this.plan.lockMode
      ? dependencies ?? inferDatabaseQueryObservationDependencies(this.plan, this.connection.getConnectionName())
      : dependencies
    const createObservation: DatabaseQueryObservationFactory = dependencies
      ? createDatabaseQueryObservation
      : createDatabaseQueryFallbackObservation
    recordDatabaseQueryDependencies(observationDependencies)
    const expired = cacheConfig?.ttl instanceof Date && cacheConfig.ttl.getTime() <= Date.now()
    if (!cacheConfig || this.plan.lockMode || expired) {
      const rows = this.convertRows(convertColumns, await this.queryRows<TRow>(statement))
      await this.recordCollectedQueryObservation(
        activeDependencyCollector && collectObservation,
        observationDependencies,
        createObservation,
        rows,
      )
      return rows
    }

    const bridge = getDatabaseQueryCacheBridge()
    if (!bridge) {
      throw new ConfigurationError('[@holo-js/db] Query caching requires @holo-js/cache to be installed and configured.')
    }

    const cacheKey = scopeCacheKey && cacheConfig.key
      ? `${cacheConfig.key}:${resolveQueryCacheKey(statement, this.connection.getConnectionName(), { ...cacheConfig, key: undefined })}`
      : resolveQueryCacheKey(statement, this.connection.getConnectionName(), cacheConfig)

    const flexible = cacheConfig.flexible
    if (flexible) {
      const rows = this.convertRows(convertColumns, await runQueryCacheOperation(runSource => bridge.flexible(
        cacheKey,
        flexible,
        () => runSource(() => this.queryRows<TRow>(statement)),
        {
          driver: cacheConfig.driver,
          dependencies,
        },
      )))
      await this.recordCollectedQueryObservation(
        activeDependencyCollector && collectObservation,
        observationDependencies,
        createObservation,
        rows,
      )
      return rows
    }

    if (typeof cacheConfig.ttl === 'undefined') {
      throw new ConfigurationError('[@holo-js/db] Query cache config requires "ttl" or "flexible".')
    }

    const ttl = normalizeAtomicQueryCacheTtl(cacheConfig.ttl)
    const rows = this.convertRows(convertColumns, await runQueryCacheOperation(runSource => bridge.flexible(
      cacheKey,
      ttl,
      () => runSource(() => this.queryRows<TRow>(statement)),
      {
        driver: cacheConfig.driver,
        dependencies,
      },
    )))
    await this.recordCollectedQueryObservation(
      activeDependencyCollector && collectObservation,
      observationDependencies,
      createObservation,
      rows,
    )
    return rows
  }

  private convertRows<TRow extends Record<string, unknown>>(convertColumns: boolean, rows: TRow[]): TRow[] {
    if (!convertColumns) return rows
    const plan = this.plan.source.table ? withResolvedDefinitions(this.plan, this.connection.getConnectionName()) : this.plan
    const convertedColumns = resolveConvertedResultColumns(this.connection.getDriver() as SchemaDialectName, plan)
    if (convertedColumns.size === 0) return rows
    const converted = rows.map(row => readConvertedResultColumns(row, convertedColumns) as TRow)
    if (hasUnstoredBoolean(rows, convertedColumns)) rowsReadFromUnstoredBooleans.add(converted)
    return converted
  }

  private async queryRows<TRow extends Record<string, unknown>>(statement: CompiledStatement): Promise<TRow[]> {
    const { rows } = await this.connection.queryCompiled<TRow>(statement)
    const aggregates = this.plan.selections.filter(selection => selection.kind === 'aggregate')
    if (aggregates.length === 0) return rows
    return rows.map(row => {
      const values: Record<string, unknown> = { ...row }
      for (const selection of aggregates) {
        const value = row[selection.alias]
        if (value == null) continue
        const number = this.normalizeNumericResult(value)
        if (typeof number === 'undefined' || (Number.isInteger(number) && !Number.isSafeInteger(number))) {
          throw new CompilerError(`Query aggregate "${selection.aggregate}" returned an invalid numeric value for "${selection.alias}".`)
        }
        values[selection.alias] = number
      }
      return values as TRow
    })
  }

  private observesSQLiteDecimalColumn(): boolean {
    if (this.connection.getDriver() !== 'sqlite') return false
    const tables = new Map<string, TableDefinition | undefined>([[this.plan.source.alias ?? this.plan.source.tableName, this.source.table]])
    for (const join of this.plan.joins) {
      if (join.table) tables.set(join.alias ?? join.table, join.definition ?? getConnectionGeneratedTableDefinition(join.table, this.connection.getConnectionName()))
    }
    const readsDecimal = (column: string): boolean => {
      const separator = column.lastIndexOf('.')
      const table = separator < 0 || this.resolveSourceColumnName(column) !== undefined ? this.source.table : tableForQualifier(tables, column.slice(0, separator))
      const name = column.slice(separator + 1)
      const columns = Object.entries(table?.columns ?? {})
      return name === '*' ? columns.some(([, definition]) => definition.kind === 'decimal') : columns.some(([key, definition]) => key === name && definition.kind === 'decimal')
    }
    return (this.plan.selections.length === 0 && [...tables.keys()].some(table => readsDecimal(`${table}.*`)))
      || this.plan.selections.some(selection => selection.kind === 'column' && readsDecimal(selection.column))
      || this.plan.groupBy.some(readsDecimal)
      || this.plan.orderBy.some(order => order.kind === 'column' && readsDecimal(order.column))
  }

  private async recordCollectedQueryObservation<TRow extends Record<string, unknown>>(
    activeDependencyCollector: boolean,
    observationDependencies: readonly string[] | undefined,
    createObservation: DatabaseQueryObservationFactory,
    rows: readonly TRow[],
  ): Promise<void> {
    if (activeDependencyCollector) recordDatabaseQueryContext(this.connection)
    if (!activeDependencyCollector || !observationDependencies) {
      return
    }

    const observation = createObservation(
      this.plan,
      this.connection.getConnectionName(),
      observationDependencies,
      rows,
    )
    if (observation?.patchable && (rowsReadFromUnstoredBooleans.has(rows) || this.observesSQLiteDecimalColumn())) {
      recordDatabaseQueryObservation(Object.freeze({ ...observation, patchable: false }))
      return
    }

    const groupedAggregate = observation?.groupedAggregate
    if (
      !observation?.patchable
      || !groupedAggregate
    ) {
      recordDatabaseQueryObservation(observation)
      return
    }

    const averageStates = groupedAggregate.kind === 'avg' && groupedAggregate.aggregateColumn && this.connection.getDriver() !== 'mysql'
      ? await this.readGroupedAverageStates(groupedAggregate)
      : undefined
    const aggregateStates = (
      groupedAggregate.kind === 'count'
      || groupedAggregate.kind === 'sum'
      || groupedAggregate.kind === 'min'
      || groupedAggregate.kind === 'max'
    )
      && groupedAggregate.having
      ? await this.readGroupedAggregateStates(groupedAggregate)
      : undefined

    recordDatabaseQueryObservation(averageStates || aggregateStates
      ? createObservation(
          this.plan,
          this.connection.getConnectionName(),
          observationDependencies,
          rows,
          averageStates,
          aggregateStates,
        )
      : observation)
  }

  private async queryMetadataRows(plan: SelectQueryPlan, groupKey: string): Promise<readonly Record<string, unknown>[]> {
    const { rows } = await this.connection.queryCompiled<Record<string, unknown>>(this.getCompiler().compile(plan))
    const read = resolveConvertedResultColumns(this.connection.getDriver() as SchemaDialectName, plan).get(groupKey)
    return read ? rows.map(row => Object.hasOwn(row, groupKey) ? { ...row, [groupKey]: read(row[groupKey]) } : row) : rows
  }

  private async readGroupedAverageStates(
    groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  ): Promise<readonly DatabaseQueryGroupedAverageStateObservation[] | undefined> {
    const aggregateColumn = groupedAggregate.aggregateColumn!

    const selections: QuerySelection[] = [
      Object.freeze({
        alias: GROUPED_AVERAGE_GROUP_KEY,
        column: groupedAggregate.groupColumn,
        kind: 'column' as const,
      }),
      this.createAggregateSelection('count', GROUPED_AVERAGE_COUNT_KEY, aggregateColumn),
      this.createAggregateSelection('count', GROUPED_AVERAGE_ROW_COUNT_KEY, '*'),
      this.createAggregateSelection('sum', GROUPED_AVERAGE_SUM_KEY, aggregateColumn),
    ]
    const metadataPlan = Object.freeze({
      ...this.plan,
      having: Object.freeze([]),
      selections: Object.freeze(selections),
    }) satisfies SelectQueryPlan
    const result = await this.queryMetadataRows(metadataPlan, GROUPED_AVERAGE_GROUP_KEY)
    const states: DatabaseQueryGroupedAverageStateObservation[] = []
    for (const row of result) {
      const count = this.normalizeNumericResult(row[GROUPED_AVERAGE_COUNT_KEY])
      const rowCount = this.normalizeNumericResult(row[GROUPED_AVERAGE_ROW_COUNT_KEY])
      const sum = this.normalizeNumericResult(row[GROUPED_AVERAGE_SUM_KEY] ?? 0)
      if (
        typeof count === 'undefined'
        || typeof rowCount === 'undefined'
        || typeof sum === 'undefined'
        || count < 0
        || rowCount < 0
      ) {
        return undefined
      }

      states.push(Object.freeze({
        count,
        groupValue: row[GROUPED_AVERAGE_GROUP_KEY],
        rowCount,
        sum,
      }))
    }

    return Object.freeze(states)
  }

  private async readGroupedAggregateStates(
    groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  ): Promise<readonly DatabaseQueryGroupedAggregateStateObservation[] | undefined> {
    const aggregateSelection = this.createGroupedAggregateStateValueSelection(groupedAggregate)

    const valueCounts = await this.readGroupedAggregateValueCounts(groupedAggregate)
    const selections: QuerySelection[] = [
      Object.freeze({
        alias: GROUPED_AGGREGATE_GROUP_KEY,
        column: groupedAggregate.groupColumn,
        kind: 'column' as const,
      }),
      aggregateSelection,
      this.createAggregateSelection('count', GROUPED_AGGREGATE_ROW_COUNT_KEY, '*'),
    ]
    const metadataPlan = Object.freeze({
      ...this.plan,
      having: Object.freeze([]),
      selections: Object.freeze(selections),
    }) satisfies SelectQueryPlan
    const result = await this.queryMetadataRows(metadataPlan, GROUPED_AGGREGATE_GROUP_KEY)
    const states: DatabaseQueryGroupedAggregateStateObservation[] = []
    for (const row of result) {
      const aggregateValue = this.normalizeGroupedAggregateStateValue(
        groupedAggregate,
        row[GROUPED_AGGREGATE_VALUE_KEY],
      )
      const rowCount = this.normalizeNumericResult(row[GROUPED_AGGREGATE_ROW_COUNT_KEY])
      if (
        typeof aggregateValue === 'undefined'
        || typeof rowCount === 'undefined'
        || rowCount < 0
      ) {
        return undefined
      }

      states.push(Object.freeze({
        aggregateValue,
        groupValue: row[GROUPED_AGGREGATE_GROUP_KEY],
        rowCount,
        ...(valueCounts ? { valueCounts: this.readGroupedAggregateValueCountsForGroup(valueCounts, row[GROUPED_AGGREGATE_GROUP_KEY]) } : {}),
      }))
    }

    return Object.freeze(states)
  }

  private async readGroupedAggregateValueCounts(
    groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  ): Promise<readonly DatabaseQueryGroupedAggregateValueCountGroupObservation[] | undefined> {
    if (
      groupedAggregate.kind !== 'min'
      && groupedAggregate.kind !== 'max'
    ) {
      return undefined
    }

    const aggregateColumn = groupedAggregate.aggregateColumn!

    const metadataPlan = Object.freeze({
      ...this.plan,
      groupBy: Object.freeze([groupedAggregate.groupColumn, aggregateColumn]),
      having: Object.freeze([]),
      selections: Object.freeze([
        Object.freeze({
          alias: GROUPED_AGGREGATE_GROUP_KEY,
          column: groupedAggregate.groupColumn,
          kind: 'column' as const,
        }),
        Object.freeze({
          alias: GROUPED_AGGREGATE_VALUE_COUNT_VALUE_KEY,
          column: aggregateColumn,
          kind: 'column' as const,
        }),
        this.createAggregateSelection('count', GROUPED_AGGREGATE_VALUE_COUNT_KEY, '*'),
      ]),
    }) satisfies SelectQueryPlan
    const result = await this.queryMetadataRows(metadataPlan, GROUPED_AGGREGATE_GROUP_KEY)
    const groups: DatabaseQueryGroupedAggregateValueCountGroupObservation[] = []
    for (const row of result) {
      const groupValue = row[GROUPED_AGGREGATE_GROUP_KEY]
      const value = this.normalizeGroupedAggregateStateValue(
        groupedAggregate,
        row[GROUPED_AGGREGATE_VALUE_COUNT_VALUE_KEY],
      )
      const count = this.normalizeNumericResult(row[GROUPED_AGGREGATE_VALUE_COUNT_KEY])
      if (
        typeof value === 'undefined'
        || typeof count === 'undefined'
        || count <= 0
      ) {
        return undefined
      }

      this.pushGroupedAggregateValueCount(groups, groupValue, Object.freeze({ count, value }))
    }

    return Object.freeze(groups.map(group => Object.freeze({
      groupValue: group.groupValue,
      valueCounts: [...group.valueCounts].sort((left, right) => left.value - right.value),
    })))
  }

  private pushGroupedAggregateValueCount(
    groups: DatabaseQueryGroupedAggregateValueCountGroupObservation[],
    groupValue: unknown,
    valueCount: DatabaseQueryGroupedAggregateValueCountObservation,
  ): void {
    const group = groups.find(candidate => Object.is(candidate.groupValue, groupValue))
    if (group) {
      group.valueCounts.push(valueCount)
      return
    }

    groups.push({
      groupValue,
      valueCounts: [valueCount],
    })
  }

  private readGroupedAggregateValueCountsForGroup(
    groups: readonly DatabaseQueryGroupedAggregateValueCountGroupObservation[],
    groupValue: unknown,
  ): readonly DatabaseQueryGroupedAggregateValueCountObservation[] {
    return groups.find(group => Object.is(group.groupValue, groupValue))?.valueCounts ?? Object.freeze([])
  }

  private createGroupedAggregateStateValueSelection(
    groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  ): QuerySelection {
    if (groupedAggregate.kind === 'count') {
      return this.createAggregateSelection('count', GROUPED_AGGREGATE_VALUE_KEY, '*')
    }

    return this.createAggregateSelection(
      groupedAggregate.kind,
      GROUPED_AGGREGATE_VALUE_KEY,
      groupedAggregate.aggregateColumn!,
    )
  }

  private normalizeGroupedAggregateStateValue(
    groupedAggregate: DatabaseQueryGroupedAggregateObservation,
    value: unknown,
  ): number | undefined {
    if (
      (groupedAggregate.kind === 'min' || groupedAggregate.kind === 'max')
      && value === null
    ) {
      return undefined
    }

    return this.normalizeNumericResult(value)
  }

  private normalizeNumericResult(value: unknown): number | undefined {
    if (value === null) {
      return 0
    }

    if (typeof value === 'boolean') {
      return Number(value)
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : undefined
    }

    if (typeof value === 'bigint') {
      const numericValue = Number(value)
      return Number.isSafeInteger(numericValue) ? numericValue : undefined
    }

    if (typeof value === 'string' && value.trim()) {
      const numericValue = Number(value)
      return Number.isFinite(numericValue) ? numericValue : undefined
    }

    return undefined
  }

  async first<TRow extends Record<string, unknown> = TSelectedRow>(): Promise<TRow | undefined> {
    const rows = await this.limit(1).get<TRow>()
    const row = rows[0]
    rebindDatabaseQueryObservationResult(rows, row)
    return row
  }

  async sole<TRow extends Record<string, unknown> = TSelectedRow>(): Promise<TRow> {
    const rows = await this.limit(2).get<TRow>()
    if (rows.length !== 1) {
      throw new CompilerError(`Query expected exactly one row but found ${rows.length}.`)
    }

    const row = rows[0]!
    rebindDatabaseQueryObservationResult(rows, row)
    return row
  }

  async paginate<TRow extends Record<string, unknown> = TSelectedRow>(
    perPage = 15,
    page = 1,
    options: PaginationOptions = {},
  ): Promise<PaginatedResult<TRow>> {
    assertPositiveInteger(perPage, 'Per-page value', message => new SecurityError(message))
    assertPositiveInteger(page, 'Page', message => new SecurityError(message))
    const pageName = normalizePaginationParameterName(options.pageName, 'page', message => new SecurityError(message))

    const offset = (page - 1) * perPage
    const counts = await this.getCompiledRows<{ __holo_count: number | string }>(this.getCompiler().compilePaginationCount(this.plan), false, true, false)
    const total = Number(counts[0]?.__holo_count)
    if (!Number.isSafeInteger(total) || total < 0) throw new CompilerError('Pagination count must be a non-negative safe integer.')
    const pageQuery = this.limit(perPage).offset(offset === 0 ? undefined : offset)
    const data = await pageQuery.getCompiledRows<TRow>(pageQuery.toSQL(), true, true)
    const from = data.length === 0 ? null : offset + 1
    const to = data.length === 0 ? null : offset + data.length
    const result = createPaginator(data, {
      total,
      perPage,
      pageName,
      currentPage: page,
      lastPage: Math.max(1, Math.ceil(total / perPage)),
      from,
      to,
      hasMorePages: offset + data.length < total,
    })
    rebindDatabaseQueryObservationPagination(data, result.data, result.meta, Object.freeze({
      currentPage: page,
      kind: 'standard',
      pageName,
      perPage,
      total,
    }), offset)

    return result
  }

  async simplePaginate<TRow extends Record<string, unknown> = TSelectedRow>(
    perPage = 15,
    page = 1,
    options: PaginationOptions = {},
  ): Promise<SimplePaginatedResult<TRow>> {
    assertPositiveInteger(perPage, 'Per-page value', message => new SecurityError(message))
    assertPositiveInteger(page, 'Page', message => new SecurityError(message))
    const pageName = normalizePaginationParameterName(options.pageName, 'page', message => new SecurityError(message))

    const offset = (page - 1) * perPage
    const pageQuery = this.limit(perPage + 1).offset(offset === 0 ? undefined : offset)
    const pageRows = await pageQuery.getCompiledRows<TRow>(pageQuery.toSQL(), true, true)
    const hasMorePages = pageRows.length > perPage
    const data = hasMorePages ? pageRows.slice(0, perPage) : pageRows
    const from = data.length === 0 ? null : offset + 1
    const to = data.length === 0 ? null : offset + data.length
    const result = createSimplePaginator(data, {
      perPage,
      pageName,
      currentPage: page,
      from,
      to,
      hasMorePages,
    })
    rebindDatabaseQueryObservationPagination(pageRows, result.data, result.meta, Object.freeze({
      currentPage: page,
      hasMorePages,
      kind: 'simple',
      pageName,
      perPage,
      rowCount: null,
    }), offset)

    return result
  }

  async cursorPaginate<TRow extends Record<string, unknown> = TSelectedRow>(
    perPage = 15,
    cursor: string | null = null,
    options: CursorPaginationOptions = {},
  ): Promise<CursorPaginatedResult<TRow>> {
    assertPositiveInteger(perPage, 'Per-page value', message => new SecurityError(message))
    const cursorName = normalizePaginationParameterName(options.cursorName, 'cursor', message => new SecurityError(message))
    const decodedCursor = decodeValueCursor(cursor, message => new SecurityError(message))
    const orderedQuery = this.prepareCursorPaginationQuery()
    const cursorOrders = orderedQuery.resolveCursorOrders()
    if (decodedCursor && decodedCursor.values.length !== cursorOrders.length) throw new SecurityError('Cursor does not match the query ordering.')
    const previous = decodedCursor?.previous === true
    const connectionName = this.connection.getConnectionName()
    const unionColumns = (branch: SelectQueryPlan): readonly string[] => cursorOrders.map(order => unionBranchColumn(branch, order.column, connectionName))
    const assertUnionColumns = (branch: SelectQueryPlan): void => {
      unionColumns(branch)
      for (const union of branch.unions) assertUnionColumns(union.query)
    }
    if (orderedQuery.plan.unions.length > 0) assertUnionColumns(orderedQuery.plan)
    let plan = withOffset(withLimit(orderedQuery.plan, perPage + 1), undefined)
    if (decodedCursor) {
      const normalizedCursor = { ...decodedCursor, values: decodedCursor.values.map((value, index) => this.normalizePredicateValueForColumn(cursorOrders[index]!.column, value)) }
      const nullsLow = !this.connection.getDialect().name.includes('postgres')
      const filter = (branch: SelectQueryPlan, columns: readonly string[]): SelectQueryPlan => {
        const grouped = branch.predicates.some(predicate => predicate.boolean === 'or')
          ? withPredicate(withoutPredicates(branch, () => true), { kind: 'group', predicates: branch.predicates })
          : branch
        return withPredicate(grouped, cursorPredicate(normalizedCursor, cursorOrders.map((order, index) => ({ ...order, column: columns[index]! })), nullsLow))
      }
      const filterUnion = (branch: SelectQueryPlan): SelectQueryPlan => Object.freeze({
        ...filter(branch, unionColumns(branch)),
        unions: Object.freeze(branch.unions.map(union => Object.freeze({ ...union, query: filterUnion(union.query) }))),
      })
      plan = plan.unions.length === 0 ? filter(plan, cursorOrders.map(order => order.column)) : filterUnion(plan)
    }
    if (previous) plan = replaceOrderBy(plan, cursorOrders.map(order => ({ kind: 'column', column: order.column, direction: order.direction === 'asc' ? 'desc' : 'asc' })))
    const pageQuery = orderedQuery.clone(plan)
    const rows = await pageQuery.getCompiledRows<TRow>(pageQuery.toSQL(), true, true)
    const pageRows = rows
    const hasMorePages = pageRows.length > perPage
    const data = pageRows.slice(0, perPage)
    if (previous) data.reverse()
    if (cursor !== null) disableDatabaseQueryObservationPatching(rows)
    const firstRow = data.at(0)
    const lastRow = data.at(-1)
    const result = createCursorPaginator(data, {
      perPage,
      cursorName,
      nextCursor: (previous ? cursor !== null : hasMorePages) && lastRow
        ? encodeValueCursor(cursorOrders.map(order => orderedQuery.readCursorColumnValue(lastRow, order.column)))
        : null,
      prevCursor: (previous ? hasMorePages : cursor !== null) && firstRow
        ? encodeValueCursor(cursorOrders.map(order => orderedQuery.readCursorColumnValue(firstRow, order.column)), true)
        : null,
    })
    if (cursor === null) {
      rebindDatabaseQueryObservationCursorPagination(rows, result.data, {
        cursorName: result.cursorName,
        nextCursor: result.nextCursor,
        perPage: result.perPage,
        prevCursor: result.prevCursor,
      }, Object.freeze({
        cursorName: result.cursorName,
        hasMorePages,
        kind: 'cursor',
        nextCursor: result.nextCursor,
        perPage: result.perPage,
        prevCursor: result.prevCursor,
        rows: pageRows,
        rowCount: rows.length,
        rowCountKnown: !hasMorePages,
      }))
    } else {
      rebindDatabaseQueryObservationResult(rows, data)
    }

    return result
  }

  async chunk<TRow extends Record<string, unknown> = TSelectedRow>(
    size: number,
    callback: (rows: readonly TRow[], page: number) => unknown | Promise<unknown>,
  ): Promise<void> {
    assertPositiveInteger(size, 'Chunk size', message => new SecurityError(message))

    let page = 1
    for await (const rows of queryBatches(this, size, {}, (rows: readonly TRow[]) => rows)) {
      if (await callback(rows, page) === false) return
      page += 1
    }
  }

  async chunkById<TRow extends Record<string, unknown> = TSelectedRow>(
    size: number,
    callback: (rows: readonly TRow[], page: number) => unknown | Promise<unknown>,
    column = 'id',
  ): Promise<void> {
    assertPositiveInteger(size, 'Chunk size', message => new SecurityError(message))

    let page = 1
    for await (const rows of queryBatches(this, size, { column, direction: 'asc' }, (rows: readonly TRow[]) => rows)) {
      if (await callback(rows, page) === false) return
      page += 1
    }
  }

  async chunkByIdDesc<TRow extends Record<string, unknown> = TSelectedRow>(
    size: number,
    callback: (rows: readonly TRow[], page: number) => unknown | Promise<unknown>,
    column = 'id',
  ): Promise<void> {
    assertPositiveInteger(size, 'Chunk size', message => new SecurityError(message))

    let page = 1
    for await (const rows of queryBatches(this, size, { column, direction: 'desc' }, (rows: readonly TRow[]) => rows)) {
      if (await callback(rows, page) === false) return
      page += 1
    }
  }

  async each<TRow extends Record<string, unknown> = TSelectedRow>(
    callback: (row: TRow, index: number) => unknown | Promise<unknown>,
    count = 1000,
  ): Promise<void> {
    await this.chunk<TRow>(count, rows => visitRows(rows, callback))
  }

  async eachById<TRow extends Record<string, unknown> = TSelectedRow>(
    callback: (row: TRow, index: number) => unknown | Promise<unknown>,
    count = 1000,
    column = 'id',
  ): Promise<void> {
    await this.chunkById<TRow>(count, rows => visitRows(rows, callback), column)
  }

  async* lazy<TRow extends Record<string, unknown> = TSelectedRow>(
    size = 1000,
  ): AsyncGenerator<TRow, void, unknown> {
    assertPositiveInteger(size, 'Chunk size', message => new SecurityError(message))

    for await (const rows of queryBatches(this, size, {}, (rows: readonly TRow[]) => rows)) {
      yield* rows
    }
  }

  async* lazyById<TRow extends Record<string, unknown> = TSelectedRow>(
    size = 1000,
    column = 'id',
  ): AsyncGenerator<TRow, void, unknown> {
    yield* this.lazyByColumn<TRow>(size, column, 'asc')
  }

  async* lazyByIdDesc<TRow extends Record<string, unknown> = TSelectedRow>(
    size = 1000,
    column = 'id',
  ): AsyncGenerator<TRow, void, unknown> {
    yield* this.lazyByColumn<TRow>(size, column, 'desc')
  }

  private async* lazyByColumn<TRow extends Record<string, unknown>>(
    size: number,
    column: string,
    direction: QueryDirection,
  ): AsyncGenerator<TRow, void, unknown> {
    assertPositiveInteger(size, 'Chunk size', message => new SecurityError(message))

    for await (const rows of queryBatches(this, size, { column, direction }, (rows: readonly TRow[]) => rows)) {
      yield* rows
    }
  }

  async* cursor<TRow extends Record<string, unknown> = TSelectedRow>(): AsyncGenerator<TRow, void, unknown> {
    yield* this.lazy<TRow>()
  }

  async count(): Promise<number> {
    const rows = await this.getCompiledRows<{ __holo_count: number | string }>(this.getCompiler().compileCount(this.plan), true, true, false)
    const result = Number(rows[0]?.__holo_count)
    if (!Number.isSafeInteger(result) || result < 0) throw new CompilerError('Query count must be a non-negative safe integer.')
    if (hasActiveDatabaseDependencyCollector()) {
      rebindDatabaseQueryObservationAggregate(rows, result, Object.freeze({ kind: 'count' }))
    }
    return result
  }

  async exists(): Promise<boolean> {
    if (!hasActiveDatabaseDependencyCollector()) {
      const rows = await this.getCompiledRows<{ __holo_exists: boolean | number }>(this.getCompiler().compileExists(this.plan), false, true, false)
      return rows[0]?.__holo_exists === true || rows[0]?.__holo_exists === 1
    }
    const count = await this.count()
    const result = count > 0
    if (hasActiveDatabaseDependencyCollector()) {
      rebindDatabaseQueryObservationAggregate(count, result, Object.freeze({
        count,
        kind: 'count',
        output: 'boolean',
      }))
    }
    return result
  }

  async doesntExist(): Promise<boolean> {
    if (!hasActiveDatabaseDependencyCollector()) return !await this.exists()
    const count = await this.count()
    const result = count === 0
    if (hasActiveDatabaseDependencyCollector()) {
      rebindDatabaseQueryObservationAggregate(count, result, Object.freeze({
        count,
        kind: 'count',
        output: 'inverseBoolean',
      }))
    }
    return result
  }

  async existsOr<TResult>(callback: () => TResult | Promise<TResult>): Promise<true | TResult> {
    return await this.exists() ? true : callback()
  }

  async doesntExistOr<TResult>(callback: () => TResult | Promise<TResult>): Promise<true | TResult> {
    return await this.doesntExist() ? true : callback()
  }

  async implode<TKey extends SelectedColumnNames<TSelectedRow>>(column: TKey, glue = ''): Promise<string> {
    return (await this.pluck(column)).join(glue)
  }

  async pluck<TKey extends SelectedColumnNames<TSelectedRow>>(
    column: TKey,
  ): Promise<Array<TSelectedRow[TKey]>> {
    const rows = await this.scalarQuery(column).get<Record<string, unknown>>()
    const key = column.slice(column.lastIndexOf('.') + 1)
    const result = rows.map(row => row[key] as TSelectedRow[TKey])
    rebindDatabaseQueryObservationScalarList(rows, result, key)
    return result
  }

  async value<TKey extends SelectedColumnNames<TSelectedRow>>(
    column: TKey,
  ): Promise<TSelectedRow[TKey] | undefined> {
    const row = await this.scalarQuery(column).first<Record<string, unknown>>()
    const key = column.slice(column.lastIndexOf('.') + 1)
    const result = row?.[key] as TSelectedRow[TKey] | undefined
    rebindDatabaseQueryObservationScalar(row, result, key)
    return result
  }

  async valueOrFail<TKey extends SelectedColumnNames<TSelectedRow>>(
    column: TKey,
  ): Promise<TSelectedRow[TKey]> {
    const row = await this.scalarQuery(column).first<Record<string, unknown>>()
    const key = column.slice(column.lastIndexOf('.') + 1)
    if (!row || typeof row[key] === 'undefined') {
      throw new CompilerError(`Query returned no value for column "${column}".`)
    }

    const result = row[key] as TSelectedRow[TKey]
    rebindDatabaseQueryObservationScalar(row, result, key)
    return result
  }

  async soleValue<TKey extends SelectedColumnNames<TSelectedRow>>(
    column: TKey,
  ): Promise<TSelectedRow[TKey]> {
    const row = await this.scalarQuery(column).sole<Record<string, unknown>>()
    const key = column.slice(column.lastIndexOf('.') + 1)
    if (typeof row[key] === 'undefined') {
      throw new CompilerError(`Query returned no value for column "${column}".`)
    }

    const result = row[key] as TSelectedRow[TKey]
    rebindDatabaseQueryObservationScalar(row, result, key)
    return result
  }

  private scalarQuery(column: string): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    if (this.plan.selections.length > 0
      || (hasActiveDatabaseDependencyCollector() && !this.plan.distinct && this.plan.joins.length === 0 && !column.includes('.'))) {
      return this
    }
    return this.clone(withSelections(this.plan, [column]))
  }

  async sum(column: string): Promise<number> {
    return this.aggregateNumeric(column, 'sum')
  }

  average(column: string): Promise<number | null> {
    return this.avg(column)
  }

  async avg(requestedColumn: string): Promise<number | null> {
    const { query, key, column } = this.resolveAggregateColumn(requestedColumn)
    const rows = await query.get<Record<string, unknown>>()
    if (rows.length === 0) {
      if (hasActiveDatabaseDependencyCollector()) {
        rebindDatabaseQueryObservationAggregate(rows, null, Object.freeze({ column, count: 0, kind: 'avg', sum: 0 }))
      }
      return null
    }

    const values = this.extractNumericValues(rows, key, 'avg', requestedColumn)
    const sum = values.reduce((total, value) => total + value, 0)
    const result = values.length > 0 ? sum / values.length : null
    if (hasActiveDatabaseDependencyCollector()) {
      rebindDatabaseQueryObservationAggregate(rows, result, Object.freeze({ column, count: values.length, kind: 'avg', sum }))
    }
    return result
  }

  async min(requestedColumn: string): Promise<number | null> {
    const { query, key, column } = this.resolveAggregateColumn(requestedColumn)
    const rows = await query.get<Record<string, unknown>>()
    if (rows.length === 0) {
      if (hasActiveDatabaseDependencyCollector()) {
        rebindDatabaseQueryObservationAggregate(rows, null, Object.freeze({ column, kind: 'min' }))
      }
      return null
    }

    const values = this.extractNumericValues(rows, key, 'min', requestedColumn)
    const result = values.length > 0 ? Math.min(...values) : null
    if (hasActiveDatabaseDependencyCollector()) {
      rebindDatabaseQueryObservationAggregate(rows, result, Object.freeze({
        column,
        currentValueCount: values.filter(value => value === result).length,
        kind: 'min',
        valueCounts: createAggregateValueCounts(values),
      }))
    }
    return result
  }

  async max(requestedColumn: string): Promise<number | null> {
    const { query, key, column } = this.resolveAggregateColumn(requestedColumn)
    const rows = await query.get<Record<string, unknown>>()
    if (rows.length === 0) {
      if (hasActiveDatabaseDependencyCollector()) {
        rebindDatabaseQueryObservationAggregate(rows, null, Object.freeze({ column, kind: 'max' }))
      }
      return null
    }

    const values = this.extractNumericValues(rows, key, 'max', requestedColumn)
    const result = values.length > 0 ? Math.max(...values) : null
    if (hasActiveDatabaseDependencyCollector()) {
      rebindDatabaseQueryObservationAggregate(rows, result, Object.freeze({
        column,
        currentValueCount: values.filter(value => value === result).length,
        kind: 'max',
        valueCounts: createAggregateValueCounts(values),
      }))
    }
    return result
  }

  async find<TRow extends Record<string, unknown> = TSelectedRow>(
    value: unknown,
    column = 'id',
  ): Promise<TRow | undefined> {
    return this.where(column as never, value).limit(1).first<TRow>()
  }

  async insert(
    values: Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[],
  ): Promise<DriverExecutionResult> {
    return this.executeInsert(values)
  }

  private async executeInsert(
    values: Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[],
    generatedKeyColumn?: string,
  ): Promise<DriverExecutionResult> {
    await this.prepareMutation()
    const rows = Array.isArray(values)
      ? values.map(value => this.normalizeWriteRecord(value))
      : [this.normalizeWriteRecord(values as Readonly<Record<string, unknown>>)]
    const canReadRows = await this.canReadInsertedRows()
    const captureReturningRows = canReadRows && this.connection.getCapabilities().returning
    const useReturningRows = captureReturningRows || (this.connection.getCapabilities().returning && generatedKeyColumn !== undefined)
    const result: MutationExecutionResult = useReturningRows
      ? await this.queryReturningMutationRows(
          createInsertQueryPlan(this.source, rows, {
            returning: captureReturningRows,
            returningColumn: captureReturningRows ? undefined : generatedKeyColumn,
          }),
          generatedKeyColumn ?? this.resolveSinglePrimaryKeyColumn(),
        )
      : await this.connection.executeCompiled(this.getCompiler().compile(
          createInsertQueryPlan(this.source, rows),
        ))
    await this.invalidateInsertQueries('insert', captureReturningRows ? result.rows?.rows ?? rows : rows, result.lastInsertId, {
      canReadRows,
      rowsAreWritten: !captureReturningRows,
    })
    return {
      affectedRows: result.affectedRows,
      lastInsertId: result.lastInsertId,
    }
  }

  async insertOrIgnore(
    values: Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[],
  ): Promise<DriverExecutionResult> {
    await this.prepareMutation()
    const rows = Array.isArray(values)
      ? values.map(value => this.normalizeWriteRecord(value))
      : [this.normalizeWriteRecord(values as Readonly<Record<string, unknown>>)]
    const canReadRows = await this.canReadInsertedRows()
    const captureReturningRows = canReadRows && this.connection.getCapabilities().returning
    const result: MutationExecutionResult = captureReturningRows
      ? await this.queryReturningMutationRows(
          createInsertQueryPlan(this.source, rows, { ignoreConflicts: true, returning: true }),
          this.resolveSinglePrimaryKeyColumn(),
        )
      : await this.connection.executeCompiled(this.getCompiler().compile(
          createInsertQueryPlan(this.source, rows, { ignoreConflicts: true }),
        ))
    const insertResult = {
      affectedRows: result.affectedRows,
      lastInsertId: result.lastInsertId,
    }
    if (result.affectedRows === 0) {
      return insertResult
    }

    await this.invalidateInsertQueries('insert', result.rows?.rows ?? rows, result.lastInsertId, {
      canReadRows,
      rowsAreWritten: !captureReturningRows,
    })
    return insertResult
  }

  static {
    keyedInsert = (query, values, keyColumn) => query.insertGetKey(values, keyColumn)
    keyColumnComparison = (query, column, compareTo, casts) => query.whereColumnWithBoolean('and', column, '=', compareTo, casts)
    keyColumnSelection = (query, column, cast) => query.clone({ ...query.plan, selections: Object.freeze([Object.freeze({ kind: 'column' as const, column, ...(cast ? { keyCast: cast } : {}) })]) })
    keyColumnJoin = (query, table, leftColumn, rightColumn, casts) => query.clone(withJoin(query.plan, {
      type: 'inner',
      ...resolveJoinTarget(table),
      leftColumn,
      operator: '=',
      rightColumn,
      ...(casts.left || casts.right ? { keyCasts: casts } : {}),
    }))
  }

  async insertGetId(values: Readonly<Record<string, unknown>>): Promise<number | string | undefined> {
    assertSinglePrimaryKey(this.source.table)
    return this.insertGetKey(values, this.resolvePrimaryKeyColumn())
  }

  private async insertGetKey(values: Readonly<Record<string, unknown>>, keyColumn: string): Promise<number | string | undefined> {
    const result = await this.executeInsert(values, keyColumn)
    return readInsertedKey(this.plan.source.table, keyColumn, result.lastInsertId)
  }

  async upsert(
    values: Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[],
    uniqueBy: readonly string[],
    requestedUpdateColumns: readonly string[] = [],
  ): Promise<DriverExecutionResult> {
    await this.prepareMutation()
    const updateColumns = Object.keys(this.resolveSourceColumnKeys(requestedUpdateColumns.map(column => [column, column] as const), 'upsert'))
    const rows = Array.isArray(values)
      ? values.map(value => this.normalizeWriteRecord(value))
      : [this.normalizeWriteRecord(values as Readonly<Record<string, unknown>>)]
    const hasInvalidationListeners = hasDatabaseDependencyInvalidationListeners()
    const previousRows = hasInvalidationListeners
      ? await this.captureUpsertPreviousRows(rows, uniqueBy)
      : undefined
    const useReturningRows = this.shouldUseReturningMutationRows(hasInvalidationListeners)
    const result: MutationExecutionResult = useReturningRows
      ? await this.queryReturningMutationRows(
          createUpsertQueryPlan(this.source, rows, uniqueBy, updateColumns, { returning: true }),
          this.resolveSinglePrimaryKeyColumn(),
        )
      : await this.connection.executeCompiled(this.getCompiler().compile(
          createUpsertQueryPlan(this.source, rows, uniqueBy, updateColumns),
        ))
    const upsertResult = {
      affectedRows: result.affectedRows,
      lastInsertId: result.lastInsertId,
    }
    if (useReturningRows && result.affectedRows === 0) {
      return upsertResult
    }

    await this.invalidateInsertQueries('upsert', result.rows?.rows ?? rows, result.lastInsertId, {
      canReadRows: hasInvalidationListeners,
      conflictColumns: result.rows ? undefined : isMySQLConnection(this.connection) ? 'any' : uniqueBy,
      previousRows,
      rowsAreWritten: !useReturningRows,
      updatedColumns: updateColumns,
    })
    return upsertResult
  }

  async increment(
    column: string,
    amount = 1,
    extraValues: Readonly<Record<string, unknown>> = {},
  ): Promise<DriverExecutionResult> {
    return this.adjustNumericColumns({ [column]: amount }, extraValues)
  }

  async decrement(
    column: string,
    amount = 1,
    extraValues: Readonly<Record<string, unknown>> = {},
  ): Promise<DriverExecutionResult> {
    return this.adjustNumericColumns({ [column]: -amount }, extraValues)
  }

  async incrementEach(
    columns: Readonly<Record<string, number>>,
    extraValues: Readonly<Record<string, unknown>> = {},
  ): Promise<DriverExecutionResult> {
    return this.adjustNumericColumns(columns, extraValues)
  }

  async decrementEach(
    columns: Readonly<Record<string, number>>,
    extraValues: Readonly<Record<string, unknown>> = {},
  ): Promise<DriverExecutionResult> {
    return this.adjustNumericColumns(
      Object.fromEntries(Object.entries(columns).map(([column, amount]) => [column, -amount])),
      extraValues,
    )
  }

  async updateOrInsert(
    attributes: Readonly<Record<string, unknown>>,
    values: Readonly<Record<string, unknown>> | ((exists: boolean) => Readonly<Record<string, unknown>>) = {},
  ): Promise<boolean> {
    const matching = Object.entries(attributes)
      .reduce<TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>>((query, [column, value]) => query.where(column as never, value), this)
    const exists = await matching.exists()
    const resolvedValues = typeof values === 'function' ? values(exists) : values
    if (!exists) {
      await this.insert({ ...attributes, ...resolvedValues })
      return true
    }

    if (Object.keys(resolvedValues).length === 0) {
      return true
    }

    return (await matching.update(resolvedValues)).affectedRows !== 0
  }

  async insertUsing(
    columns: readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[],
    query: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): Promise<DriverExecutionResult> {
    return this.executeInsertUsing(columns, query, false)
  }

  async insertOrIgnoreUsing(
    columns: readonly DeclaredColumnName<TTableOrName, TAvailableColumns>[],
    query: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): Promise<DriverExecutionResult> {
    return this.executeInsertUsing(columns, query, true)
  }

  private async executeInsertUsing(
    columns: readonly string[],
    query: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
    ignoreConflicts: boolean,
  ): Promise<DriverExecutionResult> {
    if (getRootDatabaseContext(query.getConnection()) !== getRootDatabaseContext(this.connection)) {
      throw new SecurityError(`insertUsing() needs a source query on the same database connection as "${this.connection.getConnectionName()}".`)
    }

    await this.prepareMutation()
    const result = await this.connection.executeCompiled(this.getCompiler().compile(
      createInsertUsingQueryPlan(this.source, columns, query.getPlan(), { ignoreConflicts }),
    ))
    await this.invalidateTableQueries('insert')
    return {
      affectedRows: result.affectedRows,
      lastInsertId: result.lastInsertId,
    }
  }

  async truncate(): Promise<void> {
    if (this.getCompiler().truncateCommitsOpenTransaction() && this.connection.isInTransaction()) {
      throw new TransactionError(`truncate() cannot run inside a transaction on "${this.connection.getDriver()}" because the database commits the transaction; use delete() instead.`)
    }

    const plan = createTruncateQueryPlan(this.source)
    validateQueryPlan(plan)
    await this.prepareMutation()
    const tableName = await this.resolveTruncateTarget()
    await this.assertNotReferencedByOtherTables(tableName)
    await this.connection.executeCompiled(this.getCompiler().compileResolvedTruncate(plan, tableName))
    await this.resetSequence(tableName)
    await this.invalidateTableQueries('delete')
  }

  async update(values: Readonly<Record<string, unknown>>): Promise<DriverExecutionResult> {
    assertQueryTablePath(this.source.tableName)
    await this.prepareMutation()
    const normalizedValues = this.normalizeUpdateValues(values)
    const hasInvalidationListeners = hasDatabaseDependencyInvalidationListeners()
    const useReturningRows = this.shouldUseReturningMutationRows(hasInvalidationListeners)
    const needsPreviousRows = hasInvalidationListeners && (!useReturningRows || queryCacheInternals.requiresMutationPreviousRows(
      this.connection.getConnectionName(),
      this.source.tableName,
      Object.keys(normalizedValues),
    ))
    if (needsPreviousRows && this.connection.getScope().kind === 'root') {
      return this.connection.writeTransaction(transaction => new TableQueryBuilder(
        this.source.table ?? this.source.tableName,
        transaction,
        this.plan,
        this.queryCacheConfig,
        internalPlanHandoff,
      ).update(values))
    }
    const mutationRows = needsPreviousRows
      ? await this.captureUpdatedMutationRows(normalizedValues)
      : undefined
    const result: MutationExecutionResult = useReturningRows
      ? await this.queryReturningMutationRows(
          createUpdateQueryPlan(this.source, this.plan.predicates, normalizedValues, { returning: true }),
        )
      : await this.connection.executeCompiled(this.getCompiler().compile(
        createUpdateQueryPlan(this.source, this.plan.predicates, normalizedValues),
      ))
    const capturedRows = result.rows ? { ...result.rows, previousRows: mutationRows?.previousRows } : mutationRows
    if (result.affectedRows !== 0) {
      const rows = await this.readUpdatedDecimalRows(normalizedValues, capturedRows?.rows, useReturningRows)
      await this.invalidateMutationQueries(
        rows ? this.withReadDecimalValues(normalizedValues, rows) : normalizedValues,
        rows ? { ...capturedRows, rows } : capturedRows,
        rows === null,
      )
    }
    return {
      affectedRows: result.affectedRows,
      lastInsertId: result.lastInsertId,
    }
  }

  async updateJson(
    columnPath: string,
    value: unknown,
  ): Promise<DriverExecutionResult> {
    return this.update({ [columnPath]: value })
  }

  async delete(): Promise<DriverExecutionResult> {
    await this.prepareMutation()
    const hasInvalidationListeners = hasDatabaseDependencyInvalidationListeners()
    const useReturningRows = this.shouldUseReturningMutationRows(hasInvalidationListeners)
    const mutationRows = hasInvalidationListeners && !useReturningRows
      ? await this.captureDeletedMutationRows()
      : undefined
    const result: MutationExecutionResult = useReturningRows
      ? await this.queryReturningMutationRows(
          createDeleteQueryPlan(this.source, this.plan.predicates, { returning: true }),
        )
      : await this.connection.executeCompiled(this.getCompiler().compile(
          createDeleteQueryPlan(this.source, this.plan.predicates),
        ))
    const capturedRows = result.rows ?? mutationRows
    if (result.affectedRows !== 0) {
      await this.invalidateMutationQueries({}, capturedRows)
    }
    return {
      affectedRows: result.affectedRows,
      lastInsertId: result.lastInsertId,
    }
  }

  async unsafeQuery<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: Omit<UnsafeStatement, 'source'>,
  ): Promise<DriverQueryResult<TRow>> {
    return this.connection.unsafeQuery<TRow>({
      ...statement,
      unsafe: true,
      source: `table:${this.source.tableName}`,
    })
  }

  async unsafeExecute(statement: Omit<UnsafeStatement, 'source'>): Promise<DriverExecutionResult> {
    return this.connection.unsafeExecute({
      ...statement,
      unsafe: true,
      source: `table:${this.source.tableName}`,
    })
  }

  private clone<
    TRow extends Record<string, unknown> = TSelectedRow,
    TNextColumns extends Record<string, unknown> = TAvailableColumns,
  >(
    plan: SelectQueryPlan,
  ): TableQueryBuilder<TTableOrName, TRow, TNextColumns> {
    const table = (this.source.table ?? this.source.tableName) as TTableOrName
    return new TableQueryBuilder<TTableOrName, TRow, TNextColumns>(table, this.connection, plan, this.queryCacheConfig, internalPlanHandoff)
  }


  private async captureUpdatedMutationRows(
    values: Readonly<Record<string, unknown>>,
  ): Promise<CapturedMutationRows | undefined> {
    const plan = Object.freeze({
      ...createSelectQueryPlan(this.source),
      predicates: this.plan.predicates,
      lockMode: this.connection.getCapabilities().lockForUpdate && this.connection.getScope().kind !== 'root' ? 'update' : undefined,
    }) satisfies SelectQueryPlan
    const result = await this.connection.queryCompiled(this.getCompiler().compile(plan))
    if (result.rows.length === 0) {
      return undefined
    }

    const previousRows = Object.freeze(result.rows.map(row => Object.freeze({ ...row })))
    const rows = Object.freeze(previousRows.map(row => Object.freeze(
      this.applyCapturedUpdateValues(row, values),
    )))

    return Object.freeze({
      previousRows,
      rows,
    })
  }

  private async captureDeletedMutationRows(): Promise<CapturedMutationRows | undefined> {
    const plan = Object.freeze({
      ...createSelectQueryPlan(this.source),
      predicates: this.plan.predicates,
    }) satisfies SelectQueryPlan
    const result = await this.connection.queryCompiled(this.getCompiler().compile(plan))
    if (result.rows.length === 0) {
      return undefined
    }

    return Object.freeze({
      rows: Object.freeze(result.rows.map(row => Object.freeze({ ...row }))),
    })
  }

  private applyCapturedUpdateValues(
    row: Readonly<Record<string, unknown>>,
    values: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>> {
    const nextRow: Record<string, unknown> = { ...row }
    for (const [column, value] of Object.entries(values)) {
      nextRow[column] = this.applyCapturedUpdateValue(row[column], value)
    }

    return nextRow
  }

  private applyCapturedUpdateValue(
    currentValue: unknown,
    value: unknown,
  ): unknown {
    if (value instanceof NumericAdjustment && typeof currentValue === 'number') {
      return currentValue + value.amount
    }

    if (!Array.isArray(value) || !value.every(item => this.isCapturedJsonUpdateOperation(item))) {
      return value
    }

    let nextValue = currentValue
    for (const operation of value) {
      nextValue = this.applyCapturedJsonUpdateOperation(nextValue, operation)
    }

    return nextValue
  }

  private applyCapturedJsonUpdateOperation(
    currentValue: unknown,
    operation: QueryJsonUpdateOperation,
  ): unknown {
    return this.applyCapturedJsonPathValue(currentValue, operation.path, operation.value)
  }

  private isCapturedJsonUpdateOperation(value: unknown): value is QueryJsonUpdateOperation {
    return typeof value === 'object'
      && value !== null
      && !Array.isArray(value)
      && (value as { readonly kind?: unknown }).kind === 'json-set'
      && Array.isArray((value as { readonly path?: unknown }).path)
  }

  private applyCapturedJsonPathValue(
    currentValue: unknown,
    path: readonly string[],
    value: unknown,
  ): unknown {
    const segment = path[0]
    if (typeof segment === 'undefined') {
      return value
    }

    const currentRecord = this.isJsonRecord(currentValue) ? currentValue : {}
    const childValue = this.applyCapturedJsonPathValue(currentRecord[segment], path.slice(1), value)
    return Object.freeze({
      ...currentRecord,
      [segment]: childValue,
    })
  }

  private isJsonRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  private async captureUpsertPreviousRows(
    rows: readonly Readonly<Record<string, unknown>>[],
    uniqueBy: readonly string[],
  ): Promise<readonly Readonly<Record<string, unknown>>[] | undefined> {
    const firstUniqueColumn = uniqueBy[0]!

    const firstColumnValues = Object.freeze([...new Set(rows.map(row => row[firstUniqueColumn]))])
    const query = new TableQueryBuilder<string, Record<string, unknown>>(this.source.tableName, this.connection)
      .whereIn(firstUniqueColumn, firstColumnValues)
    const result = await this.connection.queryCompiled(this.getCompiler().compile(query.getPlan()))
    const previousRows: Readonly<Record<string, unknown>>[] = []
    const usedResultIndexes = new Set<number>()
    for (const row of rows) {
      const resultIndex = result.rows.findIndex((candidate, index) => {
        return !usedResultIndexes.has(index) && this.rowsMatchUniqueBy(candidate, row, uniqueBy)
      })
      if (resultIndex < 0) {
        continue
      }

      const previousRow = result.rows[resultIndex]!
      usedResultIndexes.add(resultIndex)
      previousRows.push(Object.freeze({ ...previousRow }))
    }

    const hasUnpairedPossibleMatch = result.rows.some((candidate, index) => !usedResultIndexes.has(index)
      && rows.some(row => uniqueBy.every(column => !valuesDiffer(candidate[column], row[column]))))
    return hasUnpairedPossibleMatch ? undefined : Object.freeze(previousRows)
  }

  private rowsMatchUniqueBy(
    left: Readonly<Record<string, unknown>>,
    right: Readonly<Record<string, unknown>>,
    uniqueBy: readonly string[],
  ): boolean {
    return uniqueBy.every(column => left[column] === right[column])
  }

  private holdsUnreadableInteger(rows: readonly Readonly<Record<string, unknown>>[]): boolean {
    const table = this.resolveSourceTable()
    return rows.some(row => holdsUnreadableInteger(table, row))
  }

  private resolveSourceTable(): TableDefinition | undefined {
    return this.source.table ?? getConnectionGeneratedTableDefinition(this.source.tableName, this.connection.getConnectionName())
  }

  private writesDecimalColumn(columns: readonly string[]): boolean {
    const columnDefinitions = this.resolveSourceTable()?.columns ?? {}
    return columns.some((column) => {
      const name = column.split('->')[0]!
      return Object.hasOwn(columnDefinitions, name) && columnDefinitions[name]!.kind === 'decimal'
    })
  }

  private async readUpdatedDecimalRows(
    values: Readonly<Record<string, unknown>>,
    rows: readonly Readonly<Record<string, unknown>>[] | undefined,
    rowsWereReturned: boolean,
  ): Promise<readonly Readonly<Record<string, unknown>>[] | null | undefined> {
    if (!rows || !this.writesDecimalColumn(Object.keys(values))) return undefined
    if (rowsWereReturned) return rows
    return await this.readWrittenRows(rows) ?? null
  }

  private withoutDecimalColumns(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    return Object.freeze(Object.fromEntries(Object.entries(row).filter(([column]) => !this.writesDecimalColumn([column]))))
  }

  private async readWrittenRows(
    rows: readonly Readonly<Record<string, unknown>>[],
  ): Promise<readonly Readonly<Record<string, unknown>>[] | undefined> {
    const keys = this.resolveRowKeyColumns()
    if (keys.length === 0 || rows.some(row => keys.some(key => row[key] == null))) return undefined
    const query = keys.reduce(
      (current, key) => current.whereIn(key, [...new Set(rows.map(row => row[key]))]),
      new TableQueryBuilder<string, Record<string, unknown>>(this.source.tableName, this.connection),
    )
    const result = await this.connection.queryCompiled(this.getCompiler().compile(query.getPlan())).catch(() => undefined)
    if (!result) return undefined
    const keyOf = (row: Readonly<Record<string, unknown>>) => {
      const readRow = readIntegerColumns(this.resolveSourceTable(), row)
      return JSON.stringify(keys.map(key => readRow[key] instanceof Uint8Array ? `bytes:${Buffer.from(readRow[key]).toString('hex')}` : `text:${String(readRow[key])}`))
    }
    const rowsByKey = new Map(result.rows.map(row => [keyOf(row), row]))
    const readRows = rows.map(row => rowsByKey.get(keyOf(row)))
    return readRows.every(row => row !== undefined) ? Object.freeze(readRows.map(row => Object.freeze({ ...row }))) : undefined
  }

  private withReadDecimalValues(
    values: Readonly<Record<string, unknown>>,
    rows: readonly Readonly<Record<string, unknown>>[],
  ): Readonly<Record<string, unknown>> {
    const read = Object.keys(values).filter(column => this.writesDecimalColumn([column])
      && rows.length > 0
      && Object.hasOwn(rows[0]!, column)
      && rows.every(row => row[column] === rows[0]![column]))
    return read.length === 0 ? values : { ...values, ...Object.fromEntries(read.map(column => [column, rows[0]![column]])) }
  }

  private shouldUseReturningMutationRows(hasInvalidationListeners: boolean): boolean {
    return hasInvalidationListeners && this.connection.getCapabilities().returning
  }

  private async canReadInsertedRows(): Promise<boolean> {
    if (!hasDatabaseDependencyInvalidationListeners()) return false
    assertQueryTablePath(this.source.tableName)
    await this.connection.initialize()
    const statement = this.connection.getAdapter().getMutationReturningPermissionQuery?.(this.source.tableName)
    if (!statement) return true
    const result = await this.connection.queryCompiled<{ allowed: boolean }>(statement)
    return result.rows[0]?.allowed === true
  }

  private async queryReturningMutationRows(
    plan:
      | ReturnType<typeof createInsertQueryPlan>
      | ReturnType<typeof createUpsertQueryPlan>
      | ReturnType<typeof createUpdateQueryPlan>
      | ReturnType<typeof createDeleteQueryPlan>,
    lastInsertIdColumn?: string,
  ): Promise<MutationExecutionResult> {
    const result = await this.connection.queryCompiled(this.getCompiler().compile(plan))
    const rows = this.freezeMutationRows(result.rows)
    return {
      affectedRows: result.rowCount,
      lastInsertId: lastInsertIdColumn === undefined ? undefined : this.readReturnedLastInsertId(rows, lastInsertIdColumn),
      rows: rows.length === 0
        ? undefined
        : Object.freeze({
            rows,
          }),
    }
  }

  private freezeMutationRows(
    rows: readonly Readonly<Record<string, unknown>>[],
  ): readonly Readonly<Record<string, unknown>>[] {
    return Object.freeze(rows.map(row => Object.freeze({ ...row })))
  }

  private sourceHasRowKey(tableName: string): boolean {
    const primaryKey = this.source.primaryKey
    if (primaryKey === undefined) {
      return false
    }

    if (tableName === this.source.tableName) {
      return true
    }

    const table = getConnectionGeneratedTableDefinition(tableName, this.connection.getConnectionName())
    return Object.values(table?.columns ?? {}).some(column => column.name === primaryKey)
  }

  private resolveRowKeyColumns(): readonly string[] {
    return this.source.primaryKey === undefined ? resolveTablePrimaryKeyColumns(this.source.table) : [this.source.primaryKey]
  }

  private resolveSinglePrimaryKeyColumn(): string | undefined {
    const [primaryKey, ...otherPrimaryKeys] = resolveTablePrimaryKeyColumns(this.source.table)
    return otherPrimaryKeys.length === 0 ? primaryKey : undefined
  }

  private readReturnedLastInsertId(
    rows: readonly Readonly<Record<string, unknown>>[],
    column: string,
  ): number | string | undefined {
    const value = rows.length === 1 ? rows[0]?.[column] : undefined
    return typeof value === 'number' || typeof value === 'string'
      ? value
      : undefined
  }

  private async resolveTruncateTarget(): Promise<string> {
    const lookup = this.getCompiler().compileTableSchemaLookup(this.source.tableName)
    if (!lookup) return this.source.tableName

    const { rows } = await this.connection.queryCompiled<{ schema: string }>(lookup)
    const schema = rows[0]?.schema
    return schema ? `${schema}.${this.source.tableName}` : this.source.tableName
  }

  private async resetSequence(tableName: string): Promise<void> {
    const sequence = this.getCompiler().compileSequenceReset(tableName)
    if (!sequence) return

    const { rows } = await this.connection.queryCompiled(sequence.probe)
    if (rows.length > 0) {
      await this.connection.executeCompiled(sequence.reset)
    }
  }

  private async assertNotReferencedByOtherTables(tableName: string): Promise<void> {
    const statement = this.getCompiler().compileReferencingTables(tableName)
    if (!statement) return

    const { rows } = await this.connection.queryCompiled<{ name: string }>(statement)
    if (rows.length > 0) {
      throw new CompilerError(`Cannot truncate "${this.source.tableName}" because ${rows.map(row => `"${row.name}"`).join(', ')} reference it with foreign keys.`)
    }
  }

  private async invalidateTableQueries(kind: 'insert' | 'delete'): Promise<void> {
    const hasInvalidationListeners = hasDatabaseDependencyInvalidationListeners()
    if (!getDatabaseQueryCacheBridge() && !hasInvalidationListeners && !hasDatabaseDependencyInvalidationPublisher()) {
      return
    }

    const connectionName = this.connection.getConnectionName()
    await invalidateQueryCacheDependencies(
      this.connection,
      [
        createTableCacheDependency(connectionName, this.source.tableName),
        createTableRowWildcardCacheDependency(connectionName, this.source.tableName),
      ],
      hasInvalidationListeners ? [createDatabaseMutationEvent(kind, connectionName, this.source)] : [],
    )
  }

  private async invalidateInsertQueries(
    kind: 'insert' | 'upsert',
    rows: readonly Readonly<Record<string, unknown>>[],
    lastInsertId?: number | string,
    options: {
      readonly canReadRows?: boolean
      readonly conflictColumns?: readonly string[] | 'any'
      readonly previousRows?: readonly Readonly<Record<string, unknown>>[]
      readonly rowsAreWritten?: boolean
      readonly updatedColumns?: readonly string[]
    } = {},
  ): Promise<void> {
    const hasInvalidationListeners = hasDatabaseDependencyInvalidationListeners()
    if (!getDatabaseQueryCacheBridge() && !hasInvalidationListeners && !hasDatabaseDependencyInvalidationPublisher()) {
      return
    }

    const primaryKey = resolveInsertIdKey(this.source, this.connection.getConnectionName())
    const keyedRows = rows.length === 1
      && typeof lastInsertId !== 'undefined'
      && typeof primaryKey !== 'undefined'
      && !Object.prototype.hasOwnProperty.call(rows[0], primaryKey)
      ? Object.freeze([Object.freeze({
          ...rows[0],
          [primaryKey]: lastInsertId,
        })])
      : rows
    const hasWrittenDecimals = hasInvalidationListeners
      && options.rowsAreWritten === true
      && this.writesDecimalColumn(rows.flatMap(row => Object.keys(row)))
    const databaseRows = !hasWrittenDecimals
      ? keyedRows
      : options.canReadRows ? await this.readWrittenRows(keyedRows) : undefined
    const dependencyRows = databaseRows ?? keyedRows.map(row => this.withoutDecimalColumns(row))
    const mutations = !hasInvalidationListeners
      ? []
      : this.holdsUnreadableInteger([...databaseRows ?? [], ...options.previousRows ?? []])
        ? [createDatabaseMutationEvent(kind, this.connection.getConnectionName(), this.source)]
        : [createDatabaseMutationEvent(kind, this.connection.getConnectionName(), this.source, [], undefined, databaseRows, options.previousRows)]
    const invalidation = inferAutomaticInsertCacheInvalidationPlan(
      this.connection.getConnectionName(),
      this.source,
      dependencyRows,
      lastInsertId,
      hasInvalidationListeners,
      await this.resolveCaseInsensitiveColumns(rows),
      options.conflictColumns,
      options.updatedColumns,
    )

    await invalidateQueryCacheDependencies(
      this.connection,
      invalidation.dependencies,
      mutations,
      invalidation,
    )
  }

  private async resolveCaseInsensitiveColumns(
    records: readonly Readonly<Record<string, unknown>>[],
    predicates: readonly QueryPredicateNode[] = [],
  ): Promise<CaseInsensitiveColumns> {
    if (isMySQLConnection(this.connection)) {
      const columns = await resolveCaseInsensitiveColumns(this.connection, this.source.tableName)
      return typeof columns === 'object' && 'findTextColumn' in columns ? columns : UNKNOWN_TEXT_COLUMNS
    }

    if (!isPostgresConnection(this.connection) && !isSQLiteConnection(this.connection)) {
      return 'all'
    }

    return writesTextLiterals(predicates, records)
      ? await resolveCaseInsensitiveColumns(this.connection, this.source.tableName)
      : new Set<string>()
  }

  private async resolveQueryTextMatching(): Promise<QueryTextMatching> {
    if (!isMySQLConnection(this.connection)) {
      return textMatchesAnyNumber(this.connection)
    }

    const columns = await resolveCaseInsensitiveColumns(this.connection, this.source.tableName)
    return typeof columns === 'object' && 'findTextColumn' in columns ? columns : UNKNOWN_TEXT_COLUMNS
  }

  private async invalidateMutationQueries(
    values: Readonly<Record<string, unknown>> = {},
    capturedRows?: CapturedMutationRows,
    hasUnreadDecimals = false,
  ): Promise<void> {
    const hasInvalidationListeners = hasDatabaseDependencyInvalidationListeners()
    if (!getDatabaseQueryCacheBridge() && !hasInvalidationListeners && !hasDatabaseDependencyInvalidationPublisher()) {
      return
    }

    const hasValues = Object.keys(values).length > 0
    const invalidation = inferAutomaticQueryCacheInvalidationPlan(
      this.plan,
      this.connection.getConnectionName(),
      hasUnreadDecimals ? this.withoutDecimalColumns(values) : values,
      hasInvalidationListeners,
      await this.resolveCaseInsensitiveColumns([values], this.plan.predicates),
    )
    const numericColumns = hasInvalidationListeners
      ? Object.keys(values).filter(column => values[column] instanceof NumericAdjustment)
      : []
    const holdsUnreadableInteger = this.holdsUnreadableInteger([values, ...capturedRows?.rows ?? [], ...capturedRows?.previousRows ?? []])
    const mutations = !hasInvalidationListeners ? [] : holdsUnreadableInteger || hasUnreadDecimals
      ? [createDatabaseMutationEvent(hasValues ? 'update' : 'delete', this.connection.getConnectionName(), this.source, this.plan.predicates)]
      : numericColumns.length > 0 && capturedRows?.rows
      ? this.createNumericUpdateMutationEvents(values, numericColumns, capturedRows.rows, capturedRows.previousRows ?? [])
      : [createDatabaseMutationEvent(
          hasValues ? 'update' : 'delete',
          this.connection.getConnectionName(),
          this.source,
          this.plan.predicates,
          hasValues ? values : undefined,
          capturedRows?.rows,
          capturedRows?.previousRows,
        )]
    await invalidateQueryCacheDependencies(
      this.connection,
      invalidation.dependencies,
      mutations,
      invalidation,
    )
  }

  private createNumericUpdateMutationEvents(
    values: Readonly<Record<string, unknown>>,
    numericColumns: readonly string[],
    rows: readonly Readonly<Record<string, unknown>>[],
    previousRows: readonly Readonly<Record<string, unknown>>[],
  ): ReturnType<typeof createDatabaseMutationEvent>[] {
    const primaryKeys = this.resolveRowKeyColumns()
    const keyOf = (keyValues: readonly unknown[]): unknown => keyValues.length === 1
      ? keyValues[0]
      : JSON.stringify(keyValues, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value)
    const updatedKeyValues = (row: Readonly<Record<string, unknown>>) => primaryKeys.map(key => typeof values[key] === 'undefined'
      ? row[key]
      : this.applyCapturedUpdateValue(row[key], values[key]))
    const previousRowsByKey = new Map(previousRows.map(row => [keyOf(updatedKeyValues(row)), row]))

    return rows.map((row) => {
      const previousRow = previousRowsByKey.get(keyOf(primaryKeys.map(key => row[key])))
      return createDatabaseMutationEvent(
        'update',
        this.connection.getConnectionName(),
        this.source,
        primaryKeys.map(key => ({ kind: 'comparison' as const, column: key, operator: '=', value: previousRow?.[key] ?? row[key] })),
        Object.freeze({ ...values, ...Object.fromEntries(numericColumns.map(column => [column, row[column]])) }),
        [row],
        previousRow ? [previousRow] : undefined,
      )
    })
  }

  private getCompiler(): SQLQueryCompiler {
    return createQueryCompiler(this.connection)
  }

  private resolvePrimaryKeyColumn(): string {
    return resolveTablePrimaryKey(this.source.table)
  }

  private normalizeOperatorValue(
    operator: QueryOperator | unknown,
    value: unknown,
  ): { operator: QueryOperator | unknown, value: unknown } {
    if (typeof value === 'undefined') {
      return { operator: '=', value: operator }
    }

    return { operator, value }
  }

  private async adjustNumericColumns(
    requestedAmounts: Readonly<Record<string, number>>,
    extraValues: Readonly<Record<string, unknown>>,
  ): Promise<DriverExecutionResult> {
    await this.prepareMutation()
    const amounts = this.resolveSourceColumnKeys(requestedAmounts, 'increment/decrement')
    const columns = Object.keys(amounts)
    const uncachedSelection = new TableQueryBuilder<TTableOrName, Record<string, unknown>>(
      (this.source.table ?? this.source.tableName) as TTableOrName,
      this.connection,
      withSelections(this.plan, [...this.resolveRowKeyColumns(), ...columns] as never[]),
      undefined,
      internalPlanHandoff,
    )
    const rows = await uncachedSelection.get() as Record<string, unknown>[]
    for (const row of rows) {
      for (const column of columns) {
        const currentValue = row[column]
        if (currentValue == null || typeof this.normalizeNumericResult(currentValue) === 'undefined') {
          throw new CompilerError(`Cannot increment/decrement non-numeric column "${column}".`)
        }
      }
    }
    if (rows.length === 0) return { affectedRows: 0, lastInsertId: undefined }

    const adjustments = Object.fromEntries(Object.entries(amounts).map(([column, amount]) => [column, new NumericAdjustment(amount)]))
    const values = { ...this.resolveSourceColumnKeys(extraValues, 'update'), ...adjustments }
    if (typeof this.plan.limit === 'undefined' && typeof this.plan.offset === 'undefined') {
      return this.update(values)
    }

    const primaryKey = this.source.primaryKey ?? this.resolvePrimaryKeyColumn()
    const plan = this.plan.predicates.length === 0
      ? this.plan
      : withPredicate(withoutPredicates(this.plan, () => true), { kind: 'group', predicates: this.plan.predicates })
    return this.clone(plan).whereIn(primaryKey as never, rows.map(row => row[primaryKey])).update(values)
  }

  private resolveSourceColumnKeys<TValue>(
    values: Readonly<Record<string, TValue>> | readonly (readonly [string, TValue])[],
    operation: 'update' | 'upsert' | 'increment/decrement' | 'aggregate',
  ): Readonly<Record<string, TValue>> {
    const resolved: Record<string, TValue> = {}
    for (const [column, value] of Array.isArray(values) ? values : Object.entries(values)) {
      const pathStart = column.indexOf('->')
      const root = pathStart === -1 ? column : column.slice(0, pathStart)
      const rootName = this.resolveSourceColumnName(root)
      if (typeof rootName === 'undefined') {
        throw new CompilerError(`Cannot ${operation} column "${column}" outside table "${this.source.tableName}".`)
      }
      const columnName = rootName + column.slice(root.length)
      if (Object.hasOwn(resolved, columnName)) {
        throw new CompilerError(`Cannot ${operation} column "${columnName}" more than once.`)
      }
      resolved[columnName] = value
    }

    return resolved
  }

  private whereMultiColumns(
    groupBoolean: 'and' | 'or',
    mode: 'any' | 'all' | 'none',
    columns: readonly string[],
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    if (columns.length === 0) {
      throw new SecurityError(`where${mode.charAt(0).toUpperCase()}${mode.slice(1)}() requires at least one column.`)
    }

    const boolean = mode === 'all' ? 'and' : 'or'
    const callback = (query: TableQueryBuilder<TTableOrName, SelectRow<TTableOrName>, TAvailableColumns>) => {
      let next = query.where(columns[0]! as never, operator, value)
      for (const column of columns.slice(1)) {
        next = boolean === 'and'
          ? next.where(column as never, operator, value)
          : next.orWhere(column as never, operator, value)
      }
      return next
    }

    return this.whereGroupWithBoolean(groupBoolean, callback, mode === 'none')
  }

  private whereFullTextWithBoolean(
    boolean: 'and' | 'or',
    columns: string | readonly string[],
    value: string,
    options: { mode?: 'natural' | 'boolean' } = {},
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    const normalizedColumns = Array.isArray(columns) ? [...columns] : [columns]
    if (normalizedColumns.length === 0) {
      throw new SecurityError('whereFullText() requires at least one column.')
    }

    return this.clone(withPredicate(this.plan, {
      kind: 'fulltext',
      boolean,
      columns: Object.freeze(normalizedColumns),
      mode: options.mode ?? 'natural',
      value,
    }))
  }

  private whereVectorSimilarToWithBoolean(
    boolean: 'and' | 'or',
    column: string,
    vector: readonly number[],
    minSimilarity: number,
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    return this
      .clone(withPredicate(this.plan, {
        kind: 'vector',
        boolean,
        column,
        vector: Object.freeze([...vector]),
        minSimilarity,
      }))
      .orderByVectorSimilarity(column as never, vector)
  }

  private prepareCursorPaginationQuery(): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    if (this.plan.orderBy.some(orderBy => orderBy.kind === 'random')) {
      throw new SecurityError('Cursor pagination cannot use random ordering.')
    }

    const primaryKeys = this.source.table ? listTablePrimaryKeyColumns(this.source.table) : []
    if (this.plan.orderBy.length === 0 && primaryKeys.length === 0) {
      throw new SecurityError('Cursor pagination requires an explicit stable orderBy clause.')
    }

    return this.withPrimaryKeyTieBreakers(primaryKeys)
  }

  private withPrimaryKeyTieBreakers(primaryKeys: readonly string[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    const tableName = this.source.alias ?? this.source.tableName
    const plan = primaryKeys.reduce((current, primaryKey) => {
      const qualifiedKey = `${tableName}.${primaryKey}`
      return current.orderBy.some(order => order.kind === 'column' && (order.column === primaryKey || order.column === qualifiedKey))
        ? current
        : withOrderBy(current, { kind: 'column', column: current.joins.length === 0 || current.unions.length > 0 ? primaryKey : qualifiedKey, direction: 'asc' })
    }, this.plan)
    return plan === this.plan ? this : this.clone(plan)
  }

  private resolveCursorOrders(): readonly { readonly column: string, readonly direction: 'asc' | 'desc' }[] {
    return this.plan.orderBy.map((orderBy) => {
      if (orderBy.kind !== 'column') {
        throw new SecurityError('Cursor pagination requires column orderBy clauses.')
      }

      return {
        column: orderBy.column,
        direction: orderBy.direction,
      }
    })
  }

  private readCursorColumnValue(row: Record<string, unknown>, column: string): unknown {
    const sourceColumn = this.resolveSourceColumnName(column)
    const selections = this.plan.selections
    const ownColumns = Object.keys(this.source.table?.columns ?? {})
    const connectionName = this.connection.getConnectionName()
    const outputsName = (selection: QuerySelection, name: string, unknownOverwrites: boolean): boolean => {
      if (selection.kind === 'raw') return unknownOverwrites
      if (selection.kind !== 'column' || (!selection.column.endsWith('.*') && selection.column !== '*')) return selectionOutputName(selection) === name
      if (this.resolveSourceColumnName(selection.column) === '*') return name === sourceColumn || ownColumns.includes(name)
      const qualifier = selection.column.slice(0, -2)
      const join = this.plan.joins.find(candidate => qualifiesTable(qualifier, candidate.table, candidate.alias))
      const columns = join ? knownJoinedColumns(join, connectionName) : undefined
      return columns ? columns.includes(name) : unknownOverwrites
    }
    const survives = (index: number, name: string, unknownOverwrites = false) => !selections.slice(index + 1).some(selection => outputsName(selection, name, unknownOverwrites))
    const selectsColumn = (selection: QuerySelection): selection is QueryColumnSelection => selection.kind === 'column'
      && (selection.column === column || (typeof sourceColumn !== 'undefined' && this.resolveSourceColumnName(selection.column) === sourceColumn))
    const ownOutput = typeof sourceColumn === 'undefined'
      ? -1
      : selections.findIndex((selection, index) => selection.kind === 'column' && !selection.alias
        && [sourceColumn, '*'].includes(this.resolveSourceColumnName(selection.column) ?? '') && survives(index, sourceColumn, true))
    if (typeof sourceColumn !== 'undefined' && ownOutput !== -1 && sourceColumn in row) return row[sourceColumn]
    const aliased = selections.find((selection, index) => selectsColumn(selection) && typeof selection.alias === 'string' && survives(index, selection.alias))
    if (aliased?.kind === 'column' && aliased.alias) return row[aliased.alias]
    if (column in row) {
      return row[column]
    }
    if (typeof sourceColumn === 'undefined' && !selectsJoinedColumn(this.plan, column)) return undefined

    return row[column.split('.').at(-1)!]
  }

  private async aggregateNumeric(requestedColumn: string, kind: 'sum'): Promise<number> {
    const { query, key, column } = this.resolveAggregateColumn(requestedColumn)
    const rows = await query.get<Record<string, unknown>>()
    const result = rows.length === 0
      ? 0
      : this.extractNumericValues(rows, key, kind, requestedColumn).reduce((sum, value) => sum + value, 0)
    if (hasActiveDatabaseDependencyCollector()) {
      rebindDatabaseQueryObservationAggregate(rows, result, Object.freeze({ column, kind }))
    }
    return result
  }

  private projectAggregate(selections: readonly string[]): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    const projected = this.clone(appendSelections(this.plan, selections))
    const cacheConfig = this.queryCacheConfig
    if (!cacheConfig?.key) return projected

    const key = `${cacheConfig.key}:${resolveQueryCacheKey(projected.toSQL(), this.connection.getConnectionName(), { ...cacheConfig, key: undefined })}`
    return new TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>(
      (this.source.table ?? this.source.tableName) as TTableOrName,
      this.connection,
      projected.getPlan(),
      { ...cacheConfig, key },
      internalPlanHandoff,
    )
  }

  private modelAggregateSelections(column: string, source: string, key: string, sourceWildcard: string): readonly string[] {
    const orderedNames = new Set(this.plan.orderBy.flatMap(order => order.kind === 'column' && !order.column.includes('.') ? [order.column] : []))
    const keyOutput = [...this.plan.selections].reverse().find(selection => [key, '*'].includes(selectionOutputName(selection) ?? ''))
    const keyIsSelectedSourceColumn = keyOutput?.kind === 'column' && [key, '*'].includes(this.resolveSourceColumnName(keyOutput.column) ?? '')
    if (orderedNames.has(key) && keyOutput && !keyIsSelectedSourceColumn) {
      throw new CompilerError(`Cannot aggregate column "${column}" while ordering by "${key}", which names another selected column. Qualify the order by column.`)
    }

    const definitionColumns = Object.keys(this.source.table?.columns ?? {})
    const sourceColumns: readonly { readonly name: string, readonly alias?: string }[] = !this.plan.distinct && this.plan.groupBy.length === 0
      ? [{ name: '*' }]
      : this.selectedSourceColumns()
    const columns = orderedNames.size === 0
      ? sourceColumns
      : sourceColumns
          .flatMap((entry): readonly { readonly name: string, readonly alias?: string }[] => entry.name === '*' && definitionColumns.length > 0 ? definitionColumns.map(name => ({ name })) : [entry])
          .filter(entry => !orderedNames.has(entry.alias ?? entry.name))
    const selections = columns.map(({ name, alias }) => name === '*' ? sourceWildcard : `${source}.${name}${alias ? ` as ${alias}` : ''}`)
    return orderedNames.has(key) && keyIsSelectedSourceColumn ? selections : [...selections, `${source}.${key}`]
  }

  private selectedSourceColumns(): readonly { readonly name: string, readonly alias?: string }[] {
    return this.plan.selections.flatMap((selection) => {
      if (selection.kind !== 'column' || !selection.column.includes('.')) return []
      const name = this.resolveSourceColumnName(selection.column)
      return typeof name === 'undefined' ? [] : [{ name, alias: selection.alias }]
    })
  }

  private resolveAggregateColumn(column: string): {
    readonly query: TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>
    readonly key: string
    readonly column: string
  } {
    if (!column.split('->', 1)[0]!.includes('.')) return { query: this, key: column, column }

    const { key, joined, selections } = this[resolveAggregateSource](column)
    if (this.plan.joins.length === 0) return { query: this, key, column: key }

    return {
      query: this.projectAggregate(selections),
      key: aggregateValueKey,
      column: joined ? column : key,
    }
  }

  private extractNumericValues(
    rows: readonly Record<string, unknown>[],
    key: string,
    kind: 'sum' | 'avg' | 'min' | 'max',
    column: string,
  ): number[] {
    return rows.flatMap((row) => {
      const value = row[key]
      if (value === null) return []
      const numericValue = this.normalizeNumericResult(value)
      if (numericValue === undefined) {
        throw new CompilerError(`Query aggregate "${kind}" requires numeric values for column "${column}".`)
      }

      return [numericValue]
    })
  }

  private normalizeUpdateValues(
    values: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown | readonly QueryJsonUpdateOperation[]>> {
    return normalizeQueryUpdateValues(
      this.source.table,
      this.connection.getDriver(),
      this.resolveSourceColumnKeys(values, 'update'),
      value => this.parseJsonPath(value, false, 'update'),
    )
  }

  private normalizeWriteRecord(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
    return normalizeQueryWriteRecord(this.source.table, this.connection.getDriver(), values)
  }

  private normalizeWriteValueForColumn(columnName: string, value: unknown): unknown {
    return normalizeQueryWriteValue(this.source.table, this.connection.getDriver(), columnName, value)
  }

  private normalizeComparisonValue(columnName: string, value: unknown, operator: unknown): Pick<QueryPredicate, 'value' | 'valueType'> {
    if (this.isDateColumn(columnName)) {
      const normalized = normalizeDateColumnPredicateValue(this.source.table, this.connection.getDriver(), columnName, value, operator)
      return normalized.comparesCalendarDates ? { value: normalized.value, valueType: 'date' } : { value: normalized.value }
    }

    return {
      value: this.normalizePredicateValueForColumn(columnName, value, operator),
      ...(this.source.table?.columns[columnName]?.kind === 'json' ? { valueType: 'json' as const } : {}),
    }
  }

  private normalizePredicateValueForColumn(columnName: string, value: unknown, operator: unknown = '='): unknown {
    return normalizeQueryPredicateValue(this.source.table, this.connection.getDriver(), columnName, value, operator)
  }
}

export function whereColumnNotExpiredByDatabaseClock<
  TTableOrName extends TableReference,
  TSelectedRow extends Record<string, unknown>,
  TAvailableColumns extends Record<string, unknown>,
>(
  query: TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>,
  column: string,
): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
  const appendTrusted = trustedRawWhereAppenders.get(query)
  if (!appendTrusted) {
    throw new SecurityError('whereColumnNotExpiredByDatabaseClock() needs a query builder that Holo created.')
  }
  const append = (sql: string, bindings: readonly unknown[]) => appendTrusted(sql, bindings) as TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns>

  if (!/^[A-Za-z_]\w*$/.test(column)) {
    throw new SecurityError(`Database-clock predicates need a plain column name, received "${column}".`)
  }

  const connection = query.getConnection()
  if (!isGenuineDatabaseContext(connection)) {
    throw new SecurityError('whereColumnNotExpiredByDatabaseClock() needs a connection that Holo created.')
  }

  const dialectName = connection.getDialect().name
  const quoted = dialectName === 'mysql' ? `\`${column}\`` : `"${column}"`
  if (dialectName === 'sqlite') {
    return append(`strftime('%Y-%m-%d %H:%M:%f', ${quoted}) > strftime('%Y-%m-%d %H:%M:%f', 'now')`, [])
  }

  if (dialectName === 'postgres') {
    return append(`${quoted} > (clock_timestamp() AT TIME ZONE ?)`, [getApplicationTimezone()])
  }

  return append(`${quoted} > CURRENT_TIMESTAMP(3)`, [])
}

function valuesDiffer(left: unknown, right: unknown): boolean {
  return left !== right
    && typeof left === typeof right
    && (typeof left === 'number' || typeof left === 'bigint' || typeof left === 'boolean')
}
