import { CompilerError, ConfigurationError, SecurityError, TransactionError } from '../core/errors'
import { NumericAdjustment } from './NumericAdjustment'
import { redactBindings } from '../security/policy'
import { getApplicationTimezone } from '../applicationTimezone'
import { formatCalendarDate, startOfDayInTimezone } from '../applicationTime'
import { createTrustedRawPredicate } from './trustedRawPredicate'
import { createDateExtremaSelection, createFractionalCountSelection } from './trustedRawSelection'
import type { QueryRawSelection } from './ast'
import { isGenuineDatabaseContext } from '../core/genuineContexts'
import { getRootDatabaseContext } from '../core/contextOwnership'
import {
  getDatabaseQueryCacheBridge,
  canUseQueryCache,
  needsFullQueryRefresh,
  databaseSchemaDependency,
  hasActiveDatabaseDependencyCollector,
  hasDatabaseDependencyInvalidationListeners,
  hasDatabaseDependencyInvalidationPublisher,
  invalidateQueryCacheDependencies,
  runQueryCacheOperation,
  resolveInsertIdKey,
  createTableCacheDependency,
  createTableRowWildcardCacheDependency,
  recordDatabaseQueryRefreshTables,
  createDatabaseQueryObservation,
  createDatabaseQueryFallbackObservation,
  inferAutomaticInsertCacheInvalidationPlan,
  inferAutomaticQueryCacheInvalidationPlan,
  inferDatabaseQueryObservationDependencies,
  normalizeQueryCacheConfig,
  recordDatabaseQueryDependencies,
  recordDatabaseQueryObservation,
  recordDatabaseQueryContext,
  resolveQueryCacheDependencies,
  writesTextLiterals,
  type QueryTextMatching,
  resolveQueryCacheKey,
  type NormalizedQueryCacheConfig,
  type QueryCacheConfig,
  type QueryCacheFlexibleTtlInput,
  type QueryCacheTtlInput,
} from '../cache'
import { queryBatches, visitRows } from './traversal'
import { readConvertedResultColumns, readInsertedKey, readIntegerColumns, resolveConvertedResultColumns, withResolvedDefinitions } from './resultColumns'
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
  assertUnreservedTableAlias,
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
  hasKeyCasts,
} from './ast'
import type { SQLQueryCompiler } from './SQLQueryCompiler'
import type { CursorPaginatedResult, CursorPaginationOptions, PaginatedResult, PaginationOptions, SimplePaginatedResult } from './types'
import type { AnyColumnDefinition, InferSelect, TableDefinition } from '../schema/types'
import { assertSinglePrimaryKey, listTablePrimaryKeyColumns, resolveTablePrimaryKey, resolveTablePrimaryKeyColumns } from '../schema/tablePrimaryKey'
import { isAwaitingGeneratedTableIdentity, getConnectionGeneratedTableDefinition } from '../schema/generated'
import { unionCursorColumns } from './unionCursorColumns'
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
  QueryDatePredicate,
  QueryNullPredicate,
  QueryColumnPredicate,
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
import { applyTableNameFolding } from '../schema/tableIdentityRegistry'
import { resolvePlanGeneratedTableIdentities, resolvePlanTableIdentities, resolveTableIdentity, resolvedTableNameFolding } from './tableIdentity'
import { currentRootTransaction } from '../core/openTransactions'
import { applyDeferredPredicateNormalizations, copyDeferredPredicateNormalization, deferPredicateNormalization } from './deferredPredicateValues'
import { assertQueryTablePath, validateQueryPlan } from './validator'
import { requalifyAliasedSource } from './requalifyAliasedSource'

import type { AvailableTableColumns, ColumnSelection, NullableColumns, QualifiedTableColumns, SelectedColumns } from './selectionTypes'

type SelectRow<TTableOrName extends string | TableDefinition>
  = TTableOrName extends TableDefinition ? InferSelect<TTableOrName> : Record<string, unknown>

type TableReference = string | TableDefinition
type BuilderCallback<TBuilder> = (query: TBuilder) => unknown
type ValueBuilderCallback<TBuilder, TValue> = (query: TBuilder, value: TValue) => unknown
type MutationExecutionResult = DriverExecutionResult & {
  readonly rows?: readonly Readonly<Record<string, unknown>>[]
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
export const whereResolvedColumn = Symbol('whereResolvedColumn')
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
let keyColumnSelection: (query: AnyTableQuery, column: string, casts: QueryKeyCasts) => AnyTableQuery
let keyColumnJoin: (query: AnyTableQuery, table: TableReference | TableQueryBuilder<TableDefinition, Record<string, unknown>>, leftColumn: string, rightColumn: string, casts: QueryKeyCasts, alias?: string) => AnyTableQuery
let sourceAliasing: (query: AnyTableQuery, alias: string) => AnyTableQuery
let sourceRequalifying: (query: AnyTableQuery, previousAlias?: string) => AnyTableQuery
let connectionNameFolding: (query: AnyTableQuery) => ((name: string) => string) | undefined

export function aliasTableSource<TQuery extends TableQueryBuilder<TableReference, Record<string, unknown>, Record<string, unknown>>>(query: TQuery, alias: string): TQuery {
  if (!/^[A-Z_]\w*$/i.test(alias)) throw new CompilerError(`Table alias "${alias}" must be a plain identifier.`)
  return sourceAliasing(query as unknown as AnyTableQuery, alias) as unknown as TQuery
}

export function requalifyTableSource<TQuery extends TableQueryBuilder<TableReference, Record<string, unknown>, Record<string, unknown>>>(query: TQuery, previousAlias?: string): TQuery {
  return sourceRequalifying(query as unknown as AnyTableQuery, previousAlias) as unknown as TQuery
}

export function whereKeyColumn<TQuery extends TableQueryBuilder<TableReference, Record<string, unknown>, Record<string, unknown>>>(query: TQuery, column: string, compareTo: string, casts: QueryKeyCasts): TQuery {
  return keyColumnComparison(query as unknown as AnyTableQuery, column, compareTo, casts) as unknown as TQuery
}

export function selectKeyColumn<TQuery extends TableQueryBuilder<TableReference, Record<string, unknown>, Record<string, unknown>>>(query: TQuery, column: string, casts: QueryKeyCasts): TQuery {
  return keyColumnSelection(query as unknown as AnyTableQuery, column, casts) as unknown as TQuery
}

export function joinOnKeyColumns<TQuery extends TableQueryBuilder<TableReference, Record<string, unknown>, Record<string, unknown>>>(query: TQuery, table: TableReference | TableQueryBuilder<TableDefinition, Record<string, unknown>>, leftColumn: string, rightColumn: string, casts: QueryKeyCasts, alias?: string): TQuery {
  return keyColumnJoin(query as unknown as AnyTableQuery, table, leftColumn, rightColumn, casts, alias) as unknown as TQuery
}

export function insertGetIdByKey(
  query: TableQueryBuilder<TableReference, Record<string, unknown>, Record<string, unknown>>,
  values: Readonly<Record<string, unknown>>,
  keyColumn: string,
): Promise<number | string | undefined> {
  return keyedInsert(query, values, keyColumn)
}

const trustedRawWhereAppenders = new WeakMap<object, (sql: string, bindings: readonly unknown[]) => unknown>()
const trustedRawSelectionAppenders = new WeakMap<object, (selection: QueryRawSelection) => unknown>()
const internalPlanHandoff: unique symbol = Symbol('internalPlanHandoff')

const aggregateValueKey = 'holo_aggregate_value'

function isSnapshottablePredicateObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || 'toJSON' in value) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true)
}

function isSnapshottablePredicateArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
    && Object.getPrototypeOf(value) === Array.prototype
    && Reflect.ownKeys(value).every(key => key === 'length' || (typeof key === 'string' && /^(?:0|[1-9]\d*)$/.test(key)))
}

function isSnapshottablePredicateDate(value: unknown): value is Date {
  return value instanceof Date && Object.getPrototypeOf(value) === Date.prototype && Reflect.ownKeys(value).length === 0
}

function snapshotPredicateValue(value: unknown): unknown {
  if (isSnapshottablePredicateArray(value)) return Object.freeze(value.map(snapshotPredicateValue))
  if (isSnapshottablePredicateDate(value)) return new Date(value.getTime())
  if (isSnapshottablePredicateObject(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotPredicateValue(item)])))
  return value
}

function copyTopLevelPredicates(predicates: readonly QueryPredicateNode[]): readonly QueryPredicateNode[] {
  return Object.freeze(predicates.map((predicate) => {
    const copied = Object.freeze({ ...predicate }) as QueryPredicateNode
    copyDeferredPredicateNormalization(predicate, copied)
    return copied
  }))
}

function resolveJoinTarget(table: TableReference): Pick<QueryJoinClause, 'table' | 'alias' | 'definition'> {
  if (typeof table !== 'string') {
    return { table: table.tableName, definition: table }
  }

  const { tableName, alias } = parseTableReference(table)
  return alias === undefined ? { table: tableName } : { table: tableName, alias }
}

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
  private plan: SelectQueryPlan

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
    trustedRawSelectionAppenders.set(this, selection => this.clone(appendRawSelection(this.plan, selection)))
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
    this.plan = applyDeferredPredicateNormalizations(this.plan)
  }

  private isAwaitingGeneratedTable(): boolean {
    return !this.source.table && isAwaitingGeneratedTableIdentity(this.ownSource.tableName, this.connection.getConnectionName())
  }

  private retainedPredicateValue<TValue>(value: TValue): TValue {
    return this.isAwaitingGeneratedTable() ? snapshotPredicateValue(value) as TValue : value
  }

  [whereResolvedColumn](resolveColumn: () => string, operator: 'in' | 'not in' | '=' | '!=', value: unknown): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    if (value === null) {
      return this.clone(withPredicate(this.plan, this.withNormalizedValue<QueryNullPredicate>({
        kind: 'null',
        boolean: 'and',
        column: resolveColumn(),
        negated: operator === '!=' || operator === 'not in',
      }, () => ({ column: resolveColumn() }))))
    }
    const snapshot = this.retainedPredicateValue(value)
    return this.clone(withPredicate(this.plan, this.withNormalizedValue<QueryPredicate>({
      kind: 'comparison',
      boolean: 'and',
      column: resolveColumn(),
      operator,
      value: snapshot,
    }, () => {
      const column = resolveColumn()
      return { column, ...this.normalizeComparisonValue(column, snapshot, operator) }
    })))
  }

  private withNormalizedValue<TPredicate extends QueryPredicateNode>(predicate: TPredicate, normalize: () => Partial<TPredicate>): TPredicate {
    if (!this.isAwaitingGeneratedTable()) return { ...predicate, ...normalize() }
    let bound: Partial<TPredicate> | undefined
    return deferPredicateNormalization(predicate, () => {
      if (bound) return bound
      const normalized = normalize()
      if (!this.isAwaitingGeneratedTable()) bound = normalized
      return normalized
    })
  }

  private async prepareMutation(): Promise<void> {
    await this.bindGeneratedTable()
    if (!currentRootTransaction(this.connection)?.schemaChanged && (getDatabaseQueryCacheBridge() || hasDatabaseDependencyInvalidationListeners() || hasDatabaseDependencyInvalidationPublisher())) {
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

    const snapshot = this.retainedPredicateValue(normalized.value)
    return this.clone(withPredicate(this.plan, this.withNormalizedValue<QueryPredicate>({
      kind: 'comparison',
      boolean,
      column,
      operator: normalized.operator as QueryOperator,
      value: snapshot,
    }, () => this.normalizeComparisonValue(column, snapshot, normalized.operator))))
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
    const snapshot = this.retainedPredicateValue(normalized.value)

    const predicate: QueryDatePredicate = {
      kind: 'date',
      boolean,
      column,
      part,
      operator: normalized.operator as Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
      value: partValue ?? snapshot,
    }
    return this.clone(withPredicate(this.plan, partValue === undefined
      ? this.withNormalizedValue(predicate, () => ({ value: this.normalizePredicateValueForColumn(column, snapshot, normalized.operator) }))
      : predicate))
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
      ...(hasKeyCasts(casts) ? { keyCasts: casts } : {}),
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

    const snapshot = this.retainedPredicateValue(values) as readonly unknown[]
    return this.clone(withPredicate(this.plan, this.withNormalizedValue<QueryPredicate>({
      kind: 'comparison',
      boolean,
      column,
      operator,
      value: snapshot,
    }, () => this.normalizeComparisonValue(column, snapshot, operator))))
  }

  private whereBetweenWithBoolean(
    boolean: 'and' | 'or',
    column: string,
    range: readonly [unknown, unknown],
    operator: 'between' | 'not between',
  ): TableQueryBuilder<TTableOrName, TSelectedRow, TAvailableColumns> {
    const snapshot = this.retainedPredicateValue(range) as readonly [unknown, unknown]
    return this.clone(withPredicate(this.plan, this.withNormalizedValue<QueryPredicate>({
      kind: 'comparison',
      boolean,
      column,
      operator,
      value: snapshot,
    }, () => this.normalizeComparisonValue(column, snapshot, operator))))
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
    if (!('value' in subject)) return this.clone(withPredicate(this.plan, { kind: 'between-columns', boolean, subject, bounds, negated }))
    const value = this.retainedPredicateValue(subject.value)
    const predicate: QueryBetweenColumnsPredicate = { kind: 'between-columns', boolean, subject: { value }, bounds, negated }
    return this.clone(withPredicate(this.plan, this.withNormalizedValue(predicate, () => ({ subject: { value: this.normalizePredicateValueForColumn(bounds[0], value) } }))))
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
      alias: assertUnreservedTableAlias(alias),
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
      alias: assertUnreservedTableAlias(alias),
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
      alias: assertUnreservedTableAlias(alias),
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
      alias: assertUnreservedTableAlias(alias),
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
      alias: assertUnreservedTableAlias(alias),
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
    return this.getCompiler().compile(applyDeferredPredicateNormalizations(this.plan))
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
    return this.getCompiledRows<TRow>(() => this.toSQL())
  }

  private async getCompiledRows<TRow extends Record<string, unknown>>(
    compileStatement: () => CompiledStatement,
    collectObservation = true,
    scopeCacheKey = false,
    convertColumns = true,
  ): Promise<TRow[]> {
    await this.bindGeneratedTable()
    const statement = compileStatement()
    const cacheConfig = this.queryCacheConfig
    const activeDependencyCollector = hasActiveDatabaseDependencyCollector()
    if (activeDependencyCollector || (canUseQueryCache(this.connection) && cacheConfig && !this.plan.lockMode)) {
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
          !canUseQueryCache(this.connection) || cacheConfig?.invalidate?.length ? false : await this.resolveQueryTextMatching(),
    )
    const observationDependencies = activeDependencyCollector && !this.plan.lockMode
      ? dependencies ?? inferDatabaseQueryObservationDependencies(this.plan, this.connection.getConnectionName())
      : dependencies
    const createObservation = dependencies ? createDatabaseQueryObservation : createDatabaseQueryFallbackObservation
    recordDatabaseQueryDependencies(observationDependencies)
    const expired = cacheConfig?.ttl instanceof Date && cacheConfig.ttl.getTime() <= Date.now()
    if (!cacheConfig || this.plan.lockMode || expired || !canUseQueryCache(this.connection) || currentRootTransaction(this.connection)?.schemaChanged) {
      const rows = this.convertRows(convertColumns, await this.queryRows<TRow>(statement))
      this.recordCollectedQueryObservation(
        activeDependencyCollector && collectObservation,
        observationDependencies,
        createObservation,
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
          dependencies: [...dependencies ?? [], databaseSchemaDependency],
        },
      )))
      this.recordCollectedQueryObservation(
        activeDependencyCollector && collectObservation,
        observationDependencies,
        createObservation,
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
        dependencies: [...dependencies ?? [], databaseSchemaDependency],
      },
    )))
    this.recordCollectedQueryObservation(
      activeDependencyCollector && collectObservation,
      observationDependencies,
      createObservation,
    )
    return rows
  }

  private convertRows<TRow extends Record<string, unknown>>(convertColumns: boolean, rows: TRow[]): TRow[] {
    if (!convertColumns) return rows
    const plan = withResolvedDefinitions(this.plan, this.connection.getConnectionName())
    const convertedColumns = resolveConvertedResultColumns(this.connection.getDriver() as SchemaDialectName, plan)
    if (convertedColumns.size === 0) return rows
    return rows.map(row => readConvertedResultColumns(row, convertedColumns) as TRow)
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

  private recordCollectedQueryObservation(
    activeDependencyCollector: boolean,
    observationDependencies: readonly string[] | undefined,
    createObservation: typeof createDatabaseQueryObservation,
  ): void {
    if (activeDependencyCollector) recordDatabaseQueryContext(this.connection)
    if (!activeDependencyCollector || !observationDependencies) return
    const observation = createObservation(withResolvedDefinitions(this.plan, this.connection.getConnectionName()), this.connection.getConnectionName(), observationDependencies)
    recordDatabaseQueryObservation(observation)
    if (observation) recordDatabaseQueryRefreshTables(observationDependencies, observation.connectionName, observation.tableName)
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
    return row
  }

  async sole<TRow extends Record<string, unknown> = TSelectedRow>(): Promise<TRow> {
    const rows = await this.limit(2).get<TRow>()
    if (rows.length !== 1) {
      throw new CompilerError(`Query expected exactly one row but found ${rows.length}.`)
    }

    const row = rows[0]!
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
    const counts = await this.getCompiledRows<{ __holo_count: number | string }>(() => this.getCompiler().compilePaginationCount(this.plan), false, true, false)
    const total = Number(counts[0]?.__holo_count)
    if (!Number.isSafeInteger(total) || total < 0) throw new CompilerError('Pagination count must be a non-negative safe integer.')
    const pageQuery = this.limit(perPage).offset(offset === 0 ? undefined : offset)
    const data = await pageQuery.getCompiledRows<TRow>(() => pageQuery.toSQL(), true, true)
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
    const pageRows = await pageQuery.getCompiledRows<TRow>(() => pageQuery.toSQL(), true, true)
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
    await this.bindGeneratedTable()
    const orderedQuery = this.prepareCursorPaginationQuery()
    const cursorOrders = orderedQuery.resolveCursorOrders()
    if (decodedCursor && decodedCursor.values.length !== cursorOrders.length) throw new SecurityError('Cursor does not match the query ordering.')
    const previous = decodedCursor?.previous === true
    const cursorValue = (row: Record<string, unknown>, column: string): unknown =>
      orderedQuery.plan.unions.length > 0 && Object.hasOwn(row, column) ? row[column] : orderedQuery.readCursorColumnValue(row, column)
    const unionColumns = orderedQuery.plan.unions.length === 0
      ? undefined
      : unionCursorColumns(orderedQuery.plan, cursorOrders.map(order => order.column), this.connection.getConnectionName())
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
      const filterUnion = (branch: SelectQueryPlan, branchColumns: (branch: SelectQueryPlan) => readonly string[]): SelectQueryPlan => Object.freeze({
        ...filter(branch, branchColumns(branch)),
        unions: Object.freeze(branch.unions.map(union => Object.freeze({ ...union, query: filterUnion(union.query, branchColumns) }))),
      })
      plan = unionColumns ? filterUnion(plan, unionColumns) : filter(plan, cursorOrders.map(order => order.column))
    }
    if (previous) plan = replaceOrderBy(plan, cursorOrders.map(order => ({ kind: 'column', column: order.column, direction: order.direction === 'asc' ? 'desc' : 'asc' })))
    const pageQuery = orderedQuery.clone(plan)
    const rows = await pageQuery.getCompiledRows<TRow>(() => pageQuery.toSQL(), true, true)
    const pageRows = rows
    const hasMorePages = pageRows.length > perPage
    const data = pageRows.slice(0, perPage)
    if (previous) data.reverse()
    const firstRow = data.at(0)
    const lastRow = data.at(-1)
    const result = createCursorPaginator(data, {
      perPage,
      cursorName,
      nextCursor: (previous ? cursor !== null : hasMorePages) && lastRow
        ? encodeValueCursor(cursorOrders.map(order => cursorValue(lastRow, order.column)))
        : null,
      prevCursor: (previous ? hasMorePages : cursor !== null) && firstRow
        ? encodeValueCursor(cursorOrders.map(order => cursorValue(firstRow, order.column)), true)
        : null,
    })

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
    const rows = await this.getCompiledRows<{ __holo_count: number | string }>(() => this.getCompiler().compileCount(this.plan), true, true, false)
    const result = Number(rows[0]?.__holo_count)
    if (!Number.isSafeInteger(result) || result < 0) throw new CompilerError('Query count must be a non-negative safe integer.')
    return result
  }

  async exists(): Promise<boolean> {
    if (!hasActiveDatabaseDependencyCollector()) {
      const rows = await this.getCompiledRows<{ __holo_exists: boolean | number }>(() => this.getCompiler().compileExists(this.plan), false, true, false)
      return rows[0]?.__holo_exists === true || rows[0]?.__holo_exists === 1
    }
    const count = await this.count()
    const result = count > 0
    return result
  }

  async doesntExist(): Promise<boolean> {
    if (!hasActiveDatabaseDependencyCollector()) return !await this.exists()
    const count = await this.count()
    const result = count === 0
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
    return result
  }

  async value<TKey extends SelectedColumnNames<TSelectedRow>>(
    column: TKey,
  ): Promise<TSelectedRow[TKey] | undefined> {
    const row = await this.scalarQuery(column).first<Record<string, unknown>>()
    const key = column.slice(column.lastIndexOf('.') + 1)
    const result = row?.[key] as TSelectedRow[TKey] | undefined
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
    const { query, key } = this.resolveAggregateColumn(requestedColumn)
    const rows = await query.get<Record<string, unknown>>()
    if (rows.length === 0) {
      return null
    }

    const values = this.extractNumericValues(rows, key, 'avg', requestedColumn)
    const sum = values.reduce((total, value) => total + value, 0)
    const result = values.length > 0 ? sum / values.length : null
    return result
  }

  async min(requestedColumn: string): Promise<number | null> {
    const { query, key } = this.resolveAggregateColumn(requestedColumn)
    const rows = await query.get<Record<string, unknown>>()
    if (rows.length === 0) {
      return null
    }

    const values = this.extractNumericValues(rows, key, 'min', requestedColumn)
    const result = values.length > 0 ? Math.min(...values) : null
    return result
  }

  async max(requestedColumn: string): Promise<number | null> {
    const { query, key } = this.resolveAggregateColumn(requestedColumn)
    const rows = await query.get<Record<string, unknown>>()
    if (rows.length === 0) {
      return null
    }

    const values = this.extractNumericValues(rows, key, 'max', requestedColumn)
    const result = values.length > 0 ? Math.max(...values) : null
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
    await this.invalidateInsertQueries('insert', captureReturningRows ? result.rows ?? rows : rows, result.lastInsertId, {
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

    await this.invalidateInsertQueries('insert', result.rows ?? rows, result.lastInsertId, {
      canReadRows: canReadRows && (captureReturningRows || result.affectedRows === rows.length),
      rowsAreWritten: !captureReturningRows,
    })
    return insertResult
  }

  static {
    keyedInsert = (query, values, keyColumn) => query.insertGetKey(values, keyColumn)
    sourceAliasing = (query, alias) => query.clone(withSource(query.plan, Object.freeze({ ...query.source, alias })))
    connectionNameFolding = (query) => {
      const compiler = createQueryCompiler(query.connection)
      const folding = compiler.compileTableNameFoldingLookup() ? resolvedTableNameFolding(query.connection) : compiler.tableNameFolding()
      return folding === undefined ? undefined : name => applyTableNameFolding(folding, name)
    }
    sourceRequalifying = (query, previousAlias) => query.clone(requalifyAliasedSource(query.plan, connectionNameFolding(query), previousAlias))
    keyColumnComparison = (query, column, compareTo, casts) => query.whereColumnWithBoolean('and', column, '=', compareTo, casts)
    keyColumnSelection = (query, column, casts) => query.clone({ ...query.plan, selections: Object.freeze([Object.freeze({ kind: 'column' as const, column, ...(casts.left ? { keyCast: casts.left } : {}), ...(casts.unknownKind ? { unknownKeyKind: casts.unknownKind } : {}) })]) })
    keyColumnJoin = (query, table, leftColumn, rightColumn, casts, alias) => query.clone(withJoin(query.plan, {
      type: 'inner',
      ...(table instanceof TableQueryBuilder ? { subquery: table.getPlan() } : resolveJoinTarget(table)),
      ...(alias === undefined ? {} : { alias }),
      leftColumn,
      operator: '=',
      rightColumn,
      ...(hasKeyCasts(casts) ? { keyCasts: casts } : {}),
    }))
  }

  async insertGetId(values: Readonly<Record<string, unknown>>): Promise<number | string | undefined> {
    await this.bindGeneratedTable()
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

    await this.invalidateInsertQueries('upsert', result.rows ?? rows, result.lastInsertId, {
      canReadRows: hasInvalidationListeners,
      conflictColumns: result.rows ? undefined : isMySQLConnection(this.connection) ? 'any' : uniqueBy,
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
    await query.bindGeneratedTable()
    const result = await this.connection.executeCompiled(this.getCompiler().compile(
      createInsertUsingQueryPlan(this.source, columns, query.getPlan(), { ignoreConflicts }),
    ))
    await this.invalidateTableQueries()
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
    await this.invalidateTableQueries()
  }

  async update(values: Readonly<Record<string, unknown>>): Promise<DriverExecutionResult> {
    assertQueryTablePath(this.source.tableName)
    await this.prepareMutation()
    const normalizedValues = this.normalizeUpdateValues(values)
    const hasInvalidationListeners = hasDatabaseDependencyInvalidationListeners()
    const writesDecimal = this.writesDecimalColumn(Object.keys(normalizedValues))
    const useReturningRows = writesDecimal && this.shouldUseReturningMutationRows(hasInvalidationListeners)
    const needsDecimalRows = writesDecimal && hasInvalidationListeners && !useReturningRows && this.resolveRowKeyColumns().length > 0
    if (needsDecimalRows && this.connection.getScope().kind === 'root') {
      return this.connection.writeTransaction(transaction => new TableQueryBuilder(
        this.source.table ?? this.source.tableName,
        transaction,
        this.plan,
        this.queryCacheConfig,
        internalPlanHandoff,
      ).update(values))
    }
    const previousKeys = needsDecimalRows
      ? await this.readDecimalUpdateKeys(normalizedValues)
      : undefined
    const result: MutationExecutionResult = useReturningRows
      ? await this.queryReturningMutationRows(
          createUpdateQueryPlan(this.source, this.plan.predicates, normalizedValues, { returning: true }),
        )
      : await this.connection.executeCompiled(this.getCompiler().compile(
        createUpdateQueryPlan(this.source, this.plan.predicates, normalizedValues),
      ))
    const writtenRows = result.rows ?? previousKeys
    if (result.affectedRows !== 0) {
      const rows = await this.readUpdatedDecimalRows(normalizedValues, writtenRows, useReturningRows)
      await this.invalidateMutationQueries(
        rows ? this.withReadDecimalValues(normalizedValues, rows) : normalizedValues,
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
    const result = await this.connection.executeCompiled(this.getCompiler().compile(
      createDeleteQueryPlan(this.source, this.plan.predicates),
    ))
    if (result.affectedRows !== 0) {
      await this.invalidateMutationQueries()
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

  private async readDecimalUpdateKeys(values: Readonly<Record<string, unknown>>): Promise<readonly Readonly<Record<string, unknown>>[] | undefined> {
    const keys = this.resolveRowKeyColumns()
    if (keys.length === 0) return undefined
    const plan = Object.freeze({
      ...createSelectQueryPlan(this.source),
      selections: keys.map(column => ({ kind: 'column' as const, column })),
      predicates: this.plan.predicates,
      lockMode: this.connection.getCapabilities().lockForUpdate && this.connection.getScope().kind !== 'root' ? 'update' : undefined,
    }) satisfies SelectQueryPlan
    const result = await this.connection.queryCompiled(this.getCompiler().compile(plan))
    return result.rows.length === 0 ? undefined : result.rows.map(row => Object.fromEntries(keys.map((key) => {
      const value = values[key]
      const current = row[key]
      return [key, value === undefined ? current : value instanceof NumericAdjustment && typeof current === 'number' ? current + value.amount : value]
    })))
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
    if (!this.writesDecimalColumn(Object.keys(values))) return undefined
    if (!rows) return null
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
    const keyOf = (row: Readonly<Record<string, unknown>>) => {
      const readRow = readIntegerColumns(this.resolveSourceTable(), row)
      return JSON.stringify(keys.map(key => readRow[key] instanceof Uint8Array ? `bytes:${Buffer.from(readRow[key]).toString('hex')}` : `text:${String(readRow[key])}`))
    }
    const source = new TableQueryBuilder<string, Record<string, unknown>>(this.source.tableName, this.connection)
    const query = keys.length === 1
      ? source.whereIn(keys[0]!, [...new Set(rows.map(row => row[keys[0]!]))])
      : source.where(group => [...new Map(rows.map(row => [keyOf(row), row])).values()].reduce(
          (current, row) => current.orWhere(match => keys.reduce((pair, key) => pair.where(key, row[key]), match)),
          group,
        ))
    const result = await this.connection.queryCompiled(this.getCompiler().compile(query.getPlan())).catch(() => undefined)
    if (!result) return undefined
    const rowsByKey = new Map(result.rows.map(row => [keyOf(row), row]))
    const readRows = rows.map(row => rowsByKey.get(keyOf(row)))
    return readRows.every(row => row !== undefined) ? Object.freeze(readRows) : undefined
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
    const rows = result.rows
    return {
      affectedRows: result.rowCount,
      lastInsertId: lastInsertIdColumn === undefined ? undefined : this.readReturnedLastInsertId(rows, lastInsertIdColumn),
      rows: rows.length === 0 ? undefined : rows,
    }
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

  private async invalidateTableQueries(): Promise<void> {
    const hasInvalidationListeners = hasDatabaseDependencyInvalidationListeners()
    if (!getDatabaseQueryCacheBridge() && !hasInvalidationListeners && !hasDatabaseDependencyInvalidationPublisher()) {
      return
    }
    if (needsFullQueryRefresh(this.connection)) {
      await invalidateQueryCacheDependencies(this.connection, [createTableCacheDependency(this.connection.getConnectionName(), this.source.tableName)])
      return
    }

    const connectionName = this.connection.getConnectionName()
    await invalidateQueryCacheDependencies(
      this.connection,
      [
        createTableCacheDependency(connectionName, this.source.tableName),
        createTableRowWildcardCacheDependency(connectionName, this.source.tableName),
      ],
      [],
      undefined,
    )
  }

  private async invalidateInsertQueries(
    kind: 'insert' | 'upsert',
    rows: readonly Readonly<Record<string, unknown>>[],
    lastInsertId?: number | string,
    options: {
      readonly canReadRows?: boolean
      readonly conflictColumns?: readonly string[] | 'any'
          readonly rowsAreWritten?: boolean
      readonly updatedColumns?: readonly string[]
    } = {},
  ): Promise<void> {
    const hasInvalidationListeners = hasDatabaseDependencyInvalidationListeners()
    if (!getDatabaseQueryCacheBridge() && !hasInvalidationListeners && !hasDatabaseDependencyInvalidationPublisher()) {
      return
    }
    if (needsFullQueryRefresh(this.connection)) {
      await invalidateQueryCacheDependencies(this.connection, [createTableCacheDependency(this.connection.getConnectionName(), this.source.tableName)])
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
    const needsStoredRows = hasInvalidationListeners && options.rowsAreWritten === true
    const databaseRows = !needsStoredRows
      ? keyedRows
      : options.canReadRows ? await this.readWrittenRows(keyedRows) : undefined
    const dependencyRows = databaseRows ?? [Object.freeze({})]
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
      hasInvalidationListeners && kind === 'upsert' ? [{ kind: 'upsert' }] : [],
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
    hasUnreadDecimals = false,
  ): Promise<void> {
    const hasInvalidationListeners = hasDatabaseDependencyInvalidationListeners()
    if (!getDatabaseQueryCacheBridge() && !hasInvalidationListeners && !hasDatabaseDependencyInvalidationPublisher()) {
      return
    }
    if (needsFullQueryRefresh(this.connection)) {
      await invalidateQueryCacheDependencies(this.connection, [createTableCacheDependency(this.connection.getConnectionName(), this.source.tableName)])
      return
    }

    const invalidation = inferAutomaticQueryCacheInvalidationPlan(
      this.plan,
      this.connection.getConnectionName(),
      hasUnreadDecimals ? this.withoutDecimalColumns(values) : values,
      hasInvalidationListeners,
      await this.resolveCaseInsensitiveColumns([values], this.plan.predicates),
    )
    await invalidateQueryCacheDependencies(
      this.connection,
      invalidation.dependencies,
      [],
      invalidation,
    )
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
    const rows = await uncachedSelection.getCompiledRows<Record<string, unknown>>(() => uncachedSelection.toSQL(), false, false, false)
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
    const { query, key } = this.resolveAggregateColumn(requestedColumn)
    const rows = await query.get<Record<string, unknown>>()
    const result = rows.length === 0
      ? 0
      : this.extractNumericValues(rows, key, kind, requestedColumn).reduce((sum, value) => sum + value, 0)
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
    const sourceColumn = this.resolveSourceColumnName(columnName) ?? columnName
    if (this.isDateColumn(columnName)) {
      const normalized = normalizeDateColumnPredicateValue(this.source.table, this.connection.getDriver(), sourceColumn, value, operator)
      return normalized.comparesCalendarDates ? { value: normalized.value, valueType: 'date' } : { value: normalized.value }
    }

    return {
      value: this.normalizePredicateValueForColumn(columnName, value, operator),
      ...(this.source.table?.columns[sourceColumn]?.kind === 'json' ? { valueType: 'json' as const } : {}),
    }
  }

  private normalizePredicateValueForColumn(columnName: string, value: unknown, operator: unknown = '='): unknown {
    return normalizeQueryPredicateValue(this.source.table, this.connection.getDriver(), this.resolveSourceColumnName(columnName) ?? columnName, value, operator)
  }
}

function internalSelectionContext(query: TableQueryBuilder<string, Record<string, unknown>>) {
  const append = trustedRawSelectionAppenders.get(query)
  if (!append) {
    throw new SecurityError('Internal selections need a query builder that Holo created.')
  }
  const connection = query.getConnection()
  if (!isGenuineDatabaseContext(connection)) {
    throw new SecurityError('Internal selections need a connection that Holo created.')
  }
  return { connection, append: (selection: QueryRawSelection) => append(selection) as TableQueryBuilder<string, Record<string, unknown>> }
}

export function addSelectDateExtrema(
  query: TableQueryBuilder<string, Record<string, unknown>>,
  column: string,
  minAlias: string,
  maxAlias: string,
): TableQueryBuilder<string, Record<string, unknown>> {
  const { connection, append } = internalSelectionContext(query)
  return append(createDateExtremaSelection(connection.getDialect(), column, minAlias, maxAlias))
}

export function addSelectFractionalCount(
  query: TableQueryBuilder<string, Record<string, unknown>>,
  column: string,
  alias: string,
): TableQueryBuilder<string, Record<string, unknown>> {
  const { connection, append } = internalSelectionContext(query)
  if (connection.getDialect().name !== 'sqlite') {
    throw new SecurityError('addSelectFractionalCount() only supports SQLite.')
  }
  return append(createFractionalCountSelection(column, alias))
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
