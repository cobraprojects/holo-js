import { CompilerError, ConfigurationError, SecurityError } from '../core/errors'
import { redactBindings } from '../security/policy'
import {
  getDatabaseQueryCacheBridge,
  hasActiveDatabaseDependencyCollector,
  hasDatabaseDependencyInvalidationListeners,
  invalidateQueryCacheDependencies,
  createDatabaseMutationEvent,
  createDatabaseQueryFallbackObservation,
  createDatabaseQueryObservation,
  inferAutomaticInsertCacheInvalidationPlan,
  inferAutomaticQueryCacheInvalidationPlan,
  inferDatabaseQueryObservationDependencies,
  normalizeQueryCacheConfig,
  rebindDatabaseQueryObservationAggregate,
  rebindDatabaseQueryObservationCursorPagination,
  rebindDatabaseQueryObservationPagination,
  rebindDatabaseQueryObservationResult,
  rebindDatabaseQueryObservationScalar,
  rebindDatabaseQueryObservationScalarList,
  recordDatabaseQueryDependencies,
  recordDatabaseQueryObservation,
  resolveQueryCacheDependencies,
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
import { compareChunkValuesAscending, compareChunkValuesDescending } from './chunkOrdering'
import {
  createCursorPaginator,
  createPaginator,
  createSimplePaginator,
} from './paginator'
import {
  assertPositiveInteger,
  decodeValueCursor,
  encodeValueCursor,
  isRowAfterCursor,
  normalizePaginationParameterName,
} from './pagination'
import {
  createDeleteQueryPlan,
  createInsertQueryPlan,
  createSelectQueryPlan,
  createTableSource,
  createUpdateQueryPlan,
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
import { SQLiteQueryCompiler } from './SQLiteQueryCompiler.impl'
import { PostgresQueryCompiler } from './PostgresQueryCompiler'
import { MySQLQueryCompiler } from './MySQLQueryCompiler'
import type { SQLQueryCompiler } from './SQLQueryCompiler'
import { normalizeDialectWriteValue } from '../schema/normalization'
import type { CursorPaginatedResult, CursorPaginationOptions, PaginatedResult, PaginationOptions, SimplePaginatedResult } from './types'
import type { AnyColumnDefinition, InferSelect, TableDefinition } from '../schema/types'
import type { DriverExecutionResult, DriverQueryResult, UnsafeStatement } from '../core/types'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { SchemaDialectName } from '../schema/typeMapping'
import type {
  QueryAggregateSelection,
  QueryDirection,
  QueryJsonUpdateOperation,
  QueryOperator,
  QueryPredicateNode,
  QuerySelection,
  SelectQueryPlan,
} from './ast'

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
type ExactDeclaredColumnName<TTableOrName extends TableReference>
  = TTableOrName extends TableDefinition ? Extract<keyof SelectRow<TTableOrName>, string> : string
type DeclaredColumnName<TTableOrName extends TableReference>
  = TTableOrName extends TableDefinition ? ExactDeclaredColumnName<TTableOrName> | `${string}.${ExactDeclaredColumnName<TTableOrName>}` : string
type AliasedColumnSelection<TTableOrName extends TableReference>
  = TTableOrName extends TableDefinition ? `${DeclaredColumnName<TTableOrName>} as ${string}` : string
type ColumnReference<TTableOrName extends TableReference>
  = TTableOrName extends TableDefinition ? DeclaredColumnName<TTableOrName> | `${string}.${string}` : string
type JsonColumnPath<TTableOrName extends TableReference>
  = TTableOrName extends TableDefinition ? DeclaredColumnName<TTableOrName> | `${DeclaredColumnName<TTableOrName>}->${string}` : string
type SelectionResult<
  TTableOrName extends TableReference,
  TCurrentRow extends Record<string, unknown>,
  TColumns extends readonly SelectedColumnNames<SelectRow<TTableOrName>>[],
> = TColumns extends readonly []
  ? TCurrentRow
  : Pick<SelectRow<TTableOrName>, TColumns[number]>

type MergeSelections<
  TTableOrName extends TableReference,
  TCurrentRow extends Record<string, unknown>,
  TColumns extends readonly SelectedColumnNames<SelectRow<TTableOrName>>[],
> = TCurrentRow & Pick<SelectRow<TTableOrName>, TColumns[number]>

type AggregateSelectionResult<TAlias extends string, TValue> = Record<TAlias, TValue>

const GROUPED_AVERAGE_COUNT_KEY = '__holo_grouped_average_count'
const GROUPED_AVERAGE_ROW_COUNT_KEY = '__holo_grouped_average_row_count'
const GROUPED_AVERAGE_SUM_KEY = '__holo_grouped_average_sum'
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
> {
  private readonly source: ReturnType<typeof createTableSource>
  private readonly plan: SelectQueryPlan

  constructor(
    table: TTableOrName,
    private readonly connection: DatabaseContext,
    plan?: SelectQueryPlan,
    private readonly queryCacheConfig?: NormalizedQueryCacheConfig,
  ) {
    this.source = createTableSource(table)
    this.plan = plan ?? createSelectQueryPlan(this.source)
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

  from(table: string): TableQueryBuilder<string, TSelectedRow> {
    return new TableQueryBuilder(
      table,
      this.connection,
      withSource(this.plan, createTableSource(table)),
      this.queryCacheConfig,
    )
  }

  select<const TColumns extends readonly SelectedColumnNames<SelectRow<TTableOrName>>[]>(
    ...columns: TColumns
  ): TableQueryBuilder<TTableOrName, SelectionResult<TTableOrName, TSelectedRow, TColumns>>
  select(...columns: readonly (DeclaredColumnName<TTableOrName> | AliasedColumnSelection<TTableOrName>)[]): TableQueryBuilder<TTableOrName, Record<string, unknown>>
  select<const TColumns extends readonly SelectedColumnNames<SelectRow<TTableOrName>>[]>(
    ...columns: TColumns
  ): TableQueryBuilder<TTableOrName, SelectionResult<TTableOrName, TSelectedRow, TColumns>> {
    return this.clone(withSelections(this.plan, columns))
  }

  addSelect<const TColumns extends readonly SelectedColumnNames<SelectRow<TTableOrName>>[]>(
    ...columns: TColumns
  ): TableQueryBuilder<TTableOrName, MergeSelections<TTableOrName, TSelectedRow, TColumns>>
  addSelect(...columns: readonly (DeclaredColumnName<TTableOrName> | AliasedColumnSelection<TTableOrName>)[]): TableQueryBuilder<TTableOrName, Record<string, unknown>>
  addSelect<const TColumns extends readonly SelectedColumnNames<SelectRow<TTableOrName>>[]>(
    ...columns: TColumns
  ): TableQueryBuilder<TTableOrName, MergeSelections<TTableOrName, TSelectedRow, TColumns>> {
    return this.clone(appendSelections(this.plan, columns))
  }

  selectCount<TAlias extends string = 'count'>(
    alias?: TAlias,
    column: DeclaredColumnName<TTableOrName> | '*' = '*',
  ): TableQueryBuilder<TTableOrName, AggregateSelectionResult<TAlias, number>> {
    return this.clone(
      withAggregateSelection(this.plan, this.createAggregateSelection('count', alias ?? 'count' as TAlias, column)),
    )
  }

  addSelectCount<TAlias extends string = 'count'>(
    alias?: TAlias,
    column: DeclaredColumnName<TTableOrName> | '*' = '*',
  ): TableQueryBuilder<TTableOrName, TSelectedRow & AggregateSelectionResult<TAlias, number>> {
    return this.clone(
      appendAggregateSelection(this.plan, this.createAggregateSelection('count', alias ?? 'count' as TAlias, column)),
    )
  }

  selectSum<TAlias extends string>(
    alias: TAlias,
    column: DeclaredColumnName<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, AggregateSelectionResult<TAlias, number | null>> {
    return this.clone(
      withAggregateSelection(this.plan, this.createAggregateSelection('sum', alias, column)),
    )
  }

  addSelectSum<TAlias extends string>(
    alias: TAlias,
    column: DeclaredColumnName<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow & AggregateSelectionResult<TAlias, number | null>> {
    return this.clone(
      appendAggregateSelection(this.plan, this.createAggregateSelection('sum', alias, column)),
    )
  }

  selectAvg<TAlias extends string>(
    alias: TAlias,
    column: DeclaredColumnName<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, AggregateSelectionResult<TAlias, number | null>> {
    return this.clone(
      withAggregateSelection(this.plan, this.createAggregateSelection('avg', alias, column)),
    )
  }

  addSelectAvg<TAlias extends string>(
    alias: TAlias,
    column: DeclaredColumnName<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow & AggregateSelectionResult<TAlias, number | null>> {
    return this.clone(
      appendAggregateSelection(this.plan, this.createAggregateSelection('avg', alias, column)),
    )
  }

  selectMin<TAlias extends string>(
    alias: TAlias,
    column: DeclaredColumnName<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, AggregateSelectionResult<TAlias, number | null>> {
    return this.clone(
      withAggregateSelection(this.plan, this.createAggregateSelection('min', alias, column)),
    )
  }

  addSelectMin<TAlias extends string>(
    alias: TAlias,
    column: DeclaredColumnName<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow & AggregateSelectionResult<TAlias, number | null>> {
    return this.clone(
      appendAggregateSelection(this.plan, this.createAggregateSelection('min', alias, column)),
    )
  }

  selectMax<TAlias extends string>(
    alias: TAlias,
    column: DeclaredColumnName<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, AggregateSelectionResult<TAlias, number | null>> {
    return this.clone(
      withAggregateSelection(this.plan, this.createAggregateSelection('max', alias, column)),
    )
  }

  addSelectMax<TAlias extends string>(
    alias: TAlias,
    column: DeclaredColumnName<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow & AggregateSelectionResult<TAlias, number | null>> {
    return this.clone(
      appendAggregateSelection(this.plan, this.createAggregateSelection('max', alias, column)),
    )
  }

  unsafeSelect(
    sql: string,
    bindings: readonly unknown[],
  ): TableQueryBuilder<TTableOrName, Record<string, unknown>> {
    return this.clone(withRawSelection(this.plan, {
      kind: 'raw',
      sql,
      bindings: Object.freeze([...bindings]),
    }))
  }

  addUnsafeSelect(
    sql: string,
    bindings: readonly unknown[],
  ): TableQueryBuilder<TTableOrName, Record<string, unknown>> {
    return this.clone(appendRawSelection(this.plan, {
      kind: 'raw',
      sql,
      bindings: Object.freeze([...bindings]),
    }))
  }

  selectSub(
    query: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
    alias: string,
  ): TableQueryBuilder<TTableOrName, Record<string, unknown>> {
    return this.clone(withSubquerySelection(this.plan, query.getPlan(), alias))
  }

  addSelectSub(
    query: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
    alias: string,
  ): TableQueryBuilder<TTableOrName, Record<string, unknown>> {
    return this.clone(appendSubquerySelection(this.plan, query.getPlan(), alias))
  }

  distinct(): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withDistinct(this.plan))
  }

  where(
    callback: BuilderCallback<TableQueryBuilder<TTableOrName, SelectRow<TTableOrName>>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow>
  where(
    column: JsonColumnPath<TTableOrName>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow>
  where(
    columnOrCallback: string | BuilderCallback<TableQueryBuilder<TTableOrName, SelectRow<TTableOrName>>>,
    operator?: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    if (typeof columnOrCallback === 'function') {
      return this.whereGroupWithBoolean('and', columnOrCallback)
    }

    const column = columnOrCallback
    return this.whereWithBoolean('and', column, operator, value)
  }

  orWhere(
    callback: BuilderCallback<TableQueryBuilder<TTableOrName, SelectRow<TTableOrName>>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow>
  orWhere(
    column: JsonColumnPath<TTableOrName>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow>
  orWhere(
    columnOrCallback: string | BuilderCallback<TableQueryBuilder<TTableOrName, SelectRow<TTableOrName>>>,
    operator?: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    if (typeof columnOrCallback === 'function') {
      return this.whereGroupWithBoolean('or', columnOrCallback)
    }

    const column = columnOrCallback
    return this.whereWithBoolean('or', column, operator, value)
  }

  private whereGroupWithBoolean(
    boolean: 'and' | 'or',
    callback: BuilderCallback<TableQueryBuilder<TTableOrName, SelectRow<TTableOrName>>>,
    negated = false,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    const table = (this.source.table ?? this.source.tableName) as TTableOrName
    const nestedBuilder = new TableQueryBuilder<TTableOrName, SelectRow<TTableOrName>>(table, this.connection)
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
    callback: BuilderCallback<TableQueryBuilder<TTableOrName, SelectRow<TTableOrName>>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereGroupWithBoolean('and', callback, true)
  }

  orWhereNot(
    callback: BuilderCallback<TableQueryBuilder<TTableOrName, SelectRow<TTableOrName>>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereGroupWithBoolean('or', callback, true)
  }

  whereExists(
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereExistsWithBoolean('and', subquery, false)
  }

  orWhereExists(
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereExistsWithBoolean('or', subquery, false)
  }

  whereNotExists(
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereExistsWithBoolean('and', subquery, true)
  }

  orWhereNotExists(
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereExistsWithBoolean('or', subquery, true)
  }

  whereSub(
    column: DeclaredColumnName<TTableOrName>,
    operator: QueryOperator,
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereSubWithBoolean('and', column, operator, subquery)
  }

  orWhereSub(
    column: DeclaredColumnName<TTableOrName>,
    operator: QueryOperator,
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereSubWithBoolean('or', column, operator, subquery)
  }

  whereInSub(
    column: DeclaredColumnName<TTableOrName>,
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereSubWithBoolean('and', column, 'in', subquery)
  }

  whereNotInSub(
    column: DeclaredColumnName<TTableOrName>,
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereSubWithBoolean('and', column, 'not in', subquery)
  }

  private whereWithBoolean(
    boolean: 'and' | 'or',
    column: string,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    if (column.includes('->')) {
      return this.whereJsonValueWithBoolean(boolean, column as JsonColumnPath<TTableOrName>, operator, value)
    }

    const normalized = this.normalizeOperatorValue(operator, value)

    return this.clone(withPredicate(this.plan, {
      kind: 'comparison',
      boolean,
      column,
      operator: normalized.operator as QueryOperator,
      value: this.normalizePredicateValueForColumn(column, normalized.value),
    }))
  }

  private whereExistsWithBoolean(
    boolean: 'and' | 'or',
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
    negated: boolean,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
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
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
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
    part: 'date' | 'month' | 'day' | 'year' | 'time',
    column: string,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    const normalized = this.normalizeOperatorValue(operator, value)

    return this.clone(withPredicate(this.plan, {
      kind: 'date',
      boolean,
      column,
      part,
      operator: normalized.operator as Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
      value: this.normalizePredicateValueForColumn(column, normalized.value),
    }))
  }

  private isScalarJsonValue(value: unknown): boolean {
    return value === null || ['string', 'number', 'boolean'].includes(typeof value)
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

  private assertJsonRootColumn(column: string, methodName: string): void {
    const columnDefinition = this.getColumnDefinition(column)
    if (columnDefinition && columnDefinition.kind !== 'json') {
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
    columnPath: JsonColumnPath<TTableOrName>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    const { column, path } = this.parseJsonPath(columnPath, true, 'whereJson')
    const normalizedOperator = typeof value === 'undefined' ? '=' : operator as QueryOperator
    const normalizedValue = typeof value === 'undefined' ? operator : value

    if (!this.isScalarJsonValue(normalizedValue)) {
      throw new SecurityError(`whereJson() only supports scalar JSON comparisons on "${columnPath}"; use whereJsonContains() for arrays or objects.`)
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
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
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
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
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

  whereNull(column: DeclaredColumnName<TTableOrName>): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereNullWithBoolean('and', column)
  }

  orWhereNull(column: DeclaredColumnName<TTableOrName>): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereNullWithBoolean('or', column)
  }

  private whereNullWithBoolean(
    boolean: 'and' | 'or',
    column: string,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withPredicate(this.plan, {
      kind: 'null',
      boolean,
      column,
      negated: false,
    }))
  }

  whereNotNull(column: DeclaredColumnName<TTableOrName>): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereNotNullWithBoolean('and', column)
  }

  orWhereNotNull(column: DeclaredColumnName<TTableOrName>): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereNotNullWithBoolean('or', column)
  }

  private whereNotNullWithBoolean(
    boolean: 'and' | 'or',
    column: string,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withPredicate(this.plan, {
      kind: 'null',
      boolean,
      column,
      negated: true,
    }))
  }

  whereColumn(
    column: ColumnReference<TTableOrName>,
    operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
    compareTo: ColumnReference<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withPredicate(this.plan, {
      kind: 'column',
      boolean: 'and',
      column,
      operator,
      compareTo,
    }))
  }

  whereIn(column: DeclaredColumnName<TTableOrName>, values: readonly unknown[]): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withPredicate(this.plan, {
      kind: 'comparison',
      boolean: 'and',
      column,
      operator: 'in',
      value: this.normalizePredicateValueForColumn(column, values),
    }))
  }

  whereNotIn(column: DeclaredColumnName<TTableOrName>, values: readonly unknown[]): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withPredicate(this.plan, {
      kind: 'comparison',
      boolean: 'and',
      column,
      operator: 'not in',
      value: this.normalizePredicateValueForColumn(column, values),
    }))
  }

  whereBetween(
    column: DeclaredColumnName<TTableOrName>,
    range: readonly [unknown, unknown],
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withPredicate(this.plan, {
      kind: 'comparison',
      boolean: 'and',
      column,
      operator: 'between',
      value: this.normalizePredicateValueForColumn(column, range) as readonly [unknown, unknown],
    }))
  }

  whereNotBetween(
    column: DeclaredColumnName<TTableOrName>,
    range: readonly [unknown, unknown],
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withPredicate(this.plan, {
      kind: 'comparison',
      boolean: 'and',
      column,
      operator: 'not between',
      value: this.normalizePredicateValueForColumn(column, range) as readonly [unknown, unknown],
    }))
  }

  whereLike(column: DeclaredColumnName<TTableOrName>, pattern: string): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.where(column as JsonColumnPath<TTableOrName>, 'like', pattern)
  }

  orWhereLike(column: DeclaredColumnName<TTableOrName>, pattern: string): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.orWhere(column as JsonColumnPath<TTableOrName>, 'like', pattern)
  }

  whereAny(
    columns: readonly DeclaredColumnName<TTableOrName>[],
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereMultiColumns('any', columns, operator, value)
  }

  whereAll(
    columns: readonly DeclaredColumnName<TTableOrName>[],
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereMultiColumns('all', columns, operator, value)
  }

  whereNone(
    columns: readonly DeclaredColumnName<TTableOrName>[],
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereMultiColumns('none', columns, operator, value)
  }

  whereDate(
    column: DeclaredColumnName<TTableOrName>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereDatePart('and', 'date', column, operator, value)
  }

  whereMonth(
    column: DeclaredColumnName<TTableOrName>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereDatePart('and', 'month', column, operator, value)
  }

  whereDay(
    column: DeclaredColumnName<TTableOrName>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereDatePart('and', 'day', column, operator, value)
  }

  whereYear(
    column: DeclaredColumnName<TTableOrName>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereDatePart('and', 'year', column, operator, value)
  }

  whereTime(
    column: DeclaredColumnName<TTableOrName>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereDatePart('and', 'time', column, operator, value)
  }

  whereJson(
    columnPath: JsonColumnPath<TTableOrName>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereJsonValueWithBoolean('and', columnPath, operator, value)
  }

  orWhereJson(
    columnPath: JsonColumnPath<TTableOrName>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereJsonValueWithBoolean('or', columnPath, operator, value)
  }

  whereJsonContains(
    columnPath: JsonColumnPath<TTableOrName>,
    value: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereJsonContainsWithBoolean('and', columnPath, value)
  }

  orWhereJsonContains(
    columnPath: JsonColumnPath<TTableOrName>,
    value: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereJsonContainsWithBoolean('or', columnPath, value)
  }

  whereJsonLength(
    columnPath: JsonColumnPath<TTableOrName>,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereJsonLengthWithBoolean('and', columnPath, operator, value)
  }

  groupBy(...columns: readonly DeclaredColumnName<TTableOrName>[]): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withGroupBy(this.plan, columns))
  }

  join(
    table: string,
    leftColumn: ColumnReference<TTableOrName>,
    operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
    rightColumn: ColumnReference<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withJoin(this.plan, {
      type: 'inner',
      table,
      leftColumn,
      operator,
      rightColumn,
    }))
  }

  leftJoin(
    table: string,
    leftColumn: ColumnReference<TTableOrName>,
    operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
    rightColumn: ColumnReference<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withJoin(this.plan, {
      type: 'left',
      table,
      leftColumn,
      operator,
      rightColumn,
    }))
  }

  rightJoin(
    table: string,
    leftColumn: ColumnReference<TTableOrName>,
    operator: Exclude<QueryOperator, 'in' | 'not in' | 'between' | 'not between'>,
    rightColumn: ColumnReference<TTableOrName>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withJoin(this.plan, {
      type: 'right',
      table,
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
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
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
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
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
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
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
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
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
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withJoin(this.plan, {
      type: 'left',
      subquery: query.getPlan(),
      alias,
      lateral: true,
    }))
  }

  crossJoin(
    table: string,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withJoin(this.plan, {
      type: 'cross',
      table,
    }))
  }

  union(
    query: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withUnion(this.plan, {
      all: false,
      query: query.getPlan(),
    }))
  }

  unionAll(
    query: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withUnion(this.plan, {
      all: true,
      query: query.getPlan(),
    }))
  }

  having(
    expression: string,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    const normalizedOperator = typeof value === 'undefined' ? '=' : operator as QueryOperator
    const normalizedValue = typeof value === 'undefined' ? operator : value
    return this.clone(withHaving(this.plan, {
      expression,
      operator: normalizedOperator as Exclude<QueryOperator, 'in' | 'not in'>,
      value: normalizedValue,
    }))
  }

  havingBetween(
    expression: string,
    range: readonly [unknown, unknown],
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withHaving(this.plan, {
      expression,
      operator: 'between',
      value: range,
    }))
  }

  orWhereJsonLength(
    columnPath: string,
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereJsonLengthWithBoolean('or', columnPath, operator, value)
  }

  unsafeWhere(
    sql: string,
    bindings: readonly unknown[],
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
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
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withPredicate(this.plan, {
      kind: 'raw',
      boolean: 'or',
      sql,
      bindings: Object.freeze([...bindings]),
    }))
  }

  whereFullText(
    columns: DeclaredColumnName<TTableOrName> | readonly DeclaredColumnName<TTableOrName>[],
    value: string,
    options: { mode?: 'natural' | 'boolean' } = {},
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereFullTextWithBoolean('and', columns, value, options)
  }

  orWhereFullText(
    columns: DeclaredColumnName<TTableOrName> | readonly DeclaredColumnName<TTableOrName>[],
    value: string,
    options: { mode?: 'natural' | 'boolean' } = {},
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereFullTextWithBoolean('or', columns, value, options)
  }

  whereVectorSimilarTo(
    column: DeclaredColumnName<TTableOrName>,
    vector: readonly number[],
    minSimilarity = 0,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereVectorSimilarToWithBoolean('and', column, vector, minSimilarity)
  }

  orWhereVectorSimilarTo(
    column: DeclaredColumnName<TTableOrName>,
    vector: readonly number[],
    minSimilarity = 0,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.whereVectorSimilarToWithBoolean('or', column, vector, minSimilarity)
  }

  when<TValue>(
    value: TValue,
    callback: ValueBuilderCallback<TableQueryBuilder<TTableOrName, TSelectedRow>, TValue>,
    defaultCallback?: ValueBuilderCallback<TableQueryBuilder<TTableOrName, TSelectedRow>, TValue>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    if (value) {
      const result = callback(this, value)
      return result instanceof TableQueryBuilder ? result : this
    }

    const result = defaultCallback?.(this, value)
    return result instanceof TableQueryBuilder ? result : this
  }

  unless<TValue>(
    value: TValue,
    callback: ValueBuilderCallback<TableQueryBuilder<TTableOrName, TSelectedRow>, TValue>,
    defaultCallback?: ValueBuilderCallback<TableQueryBuilder<TTableOrName, TSelectedRow>, TValue>,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    if (!value) {
      const result = callback(this, value)
      return result instanceof TableQueryBuilder ? result : this
    }

    const result = defaultCallback?.(this, value)
    return result instanceof TableQueryBuilder ? result : this
  }

  withoutWhereNull(column: DeclaredColumnName<TTableOrName>): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withoutPredicates(this.plan, predicate => (
      predicate.kind === 'null' && predicate.column === column && predicate.negated === false
    )))
  }

  withoutWhereNotNull(column: DeclaredColumnName<TTableOrName>): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withoutPredicates(this.plan, predicate => (
      predicate.kind === 'null' && predicate.column === column && predicate.negated === true
    )))
  }

  orderBy(
    column: DeclaredColumnName<TTableOrName>,
    direction: QueryDirection = 'asc',
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withOrderBy(this.plan, {
      kind: 'column',
      column,
      direction,
    }))
  }

  unsafeOrderBy(
    sql: string,
    bindings: readonly unknown[],
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withOrderBy(this.plan, {
      kind: 'raw',
      sql,
      bindings: Object.freeze([...bindings]),
    }))
  }

  inRandomOrder(): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(replaceOrderBy(this.plan, [Object.freeze({
      kind: 'random' as const,
    })]))
  }

  latest(column: DeclaredColumnName<TTableOrName> = 'created_at' as DeclaredColumnName<TTableOrName>): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.orderBy(column, 'desc')
  }

  oldest(column: DeclaredColumnName<TTableOrName> = 'created_at' as DeclaredColumnName<TTableOrName>): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.orderBy(column, 'asc')
  }

  reorder(
    column?: DeclaredColumnName<TTableOrName>,
    direction: QueryDirection = 'asc',
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
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
    column: DeclaredColumnName<TTableOrName>,
    vector: readonly number[],
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withOrderBy(this.plan, {
      kind: 'vector',
      column,
      vector: Object.freeze([...vector]),
    }))
  }

  lock(mode: 'update' | 'share'): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withLockMode(this.plan, mode))
  }

  lockForUpdate(): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.lock('update')
  }

  sharedLock(): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.lock('share')
  }

  limit(value?: number): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withLimit(this.plan, value))
  }

  offset(value?: number): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.clone(withOffset(this.plan, value))
  }

  skip(value: number): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.offset(value)
  }

  take(value: number): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return this.limit(value)
  }

  forPage(page: number, perPage = 15): TableQueryBuilder<TTableOrName, TSelectedRow> {
    assertPositiveInteger(page, 'Page', message => new SecurityError(message))
    assertPositiveInteger(perPage, 'Per-page value', message => new SecurityError(message))

    return this.limit(perPage).offset((page - 1) * perPage)
  }

  toSQL() {
    return this.getCompiler().compile(this.plan)
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

  dump(): TableQueryBuilder<TTableOrName, TSelectedRow> {
    console.log(this.debug())
    return this
  }

  cache(
    config: QueryCacheTtlInput | QueryCacheConfig,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    return new TableQueryBuilder<TTableOrName, TSelectedRow>(
      (this.source.table ?? this.source.tableName) as TTableOrName,
      this.connection,
      this.plan,
      normalizeQueryCacheConfig(config),
    )
  }

  async get<TRow extends Record<string, unknown> = TSelectedRow>(): Promise<TRow[]> {
    const statement = this.toSQL()
    const cacheConfig = this.queryCacheConfig
    const activeDependencyCollector = hasActiveDatabaseDependencyCollector()
    const dependencies = this.plan.lockMode
      || (!cacheConfig && !activeDependencyCollector)
      ? undefined
      : resolveQueryCacheDependencies(
          this.plan,
          this.connection.getConnectionName(),
          cacheConfig?.invalidate,
    )
    const observationDependencies = activeDependencyCollector && !this.plan.lockMode
      ? dependencies ?? inferDatabaseQueryObservationDependencies(this.plan, this.connection.getConnectionName())
      : dependencies
    const createObservation: DatabaseQueryObservationFactory = dependencies
      ? createDatabaseQueryObservation
      : createDatabaseQueryFallbackObservation
    recordDatabaseQueryDependencies(observationDependencies)
    if (!cacheConfig || this.plan.lockMode) {
      const result = await this.connection.queryCompiled<TRow>(statement)
      await this.recordCollectedQueryObservation(
        activeDependencyCollector,
        observationDependencies,
        createObservation,
        result.rows,
      )
      return result.rows
    }

    const bridge = getDatabaseQueryCacheBridge()
    if (!bridge) {
      throw new ConfigurationError('[@holo-js/db] Query caching requires @holo-js/cache to be installed and configured.')
    }

    const cacheKey = resolveQueryCacheKey(statement, this.connection.getConnectionName(), cacheConfig)

    if (cacheConfig.flexible) {
      const rows = await bridge.flexible(
        cacheKey,
        cacheConfig.flexible,
        async () => {
          const result = await this.connection.queryCompiled<TRow>(statement)
          return result.rows
        },
        {
          driver: cacheConfig.driver,
          dependencies,
        },
      )
      await this.recordCollectedQueryObservation(
        activeDependencyCollector,
        observationDependencies,
        createObservation,
        rows,
      )
      return rows
    }

    if (typeof cacheConfig.ttl === 'undefined') {
      throw new ConfigurationError('[@holo-js/db] Query cache config requires "ttl" or "flexible".')
    }

    const rows = await bridge.flexible(
      cacheKey,
      normalizeAtomicQueryCacheTtl(cacheConfig.ttl),
      async () => {
        const result = await this.connection.queryCompiled<TRow>(statement)
        return result.rows
      },
      {
        driver: cacheConfig.driver,
        dependencies,
      },
    )
    await this.recordCollectedQueryObservation(
      activeDependencyCollector,
      observationDependencies,
      createObservation,
      rows,
    )
    return rows
  }

  private async recordCollectedQueryObservation<TRow extends Record<string, unknown>>(
    activeDependencyCollector: boolean,
    observationDependencies: readonly string[] | undefined,
    createObservation: DatabaseQueryObservationFactory,
    rows: readonly TRow[],
  ): Promise<void> {
    if (!activeDependencyCollector || !observationDependencies) {
      return
    }

    const observation = createObservation(
      this.plan,
      this.connection.getConnectionName(),
      observationDependencies,
      rows,
    )
    const groupedAggregate = observation?.groupedAggregate
    if (
      !observation?.patchable
      || !groupedAggregate
    ) {
      recordDatabaseQueryObservation(observation)
      return
    }

    const averageStates = groupedAggregate.kind === 'avg' && groupedAggregate.aggregateColumn
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

  private async readGroupedAverageStates(
    groupedAggregate: DatabaseQueryGroupedAggregateObservation,
  ): Promise<readonly DatabaseQueryGroupedAverageStateObservation[] | undefined> {
    const aggregateColumn = groupedAggregate.aggregateColumn
    if (!aggregateColumn) {
      return undefined
    }

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
    const result = await this.connection.queryCompiled<Record<string, unknown>>(this.getCompiler().compile(metadataPlan))
    const states: DatabaseQueryGroupedAverageStateObservation[] = []
    for (const row of result.rows) {
      const count = this.normalizeAggregateMetadataNumber(row[GROUPED_AVERAGE_COUNT_KEY])
      const rowCount = this.normalizeAggregateMetadataNumber(row[GROUPED_AVERAGE_ROW_COUNT_KEY])
      const sum = this.normalizeAggregateMetadataNumber(row[GROUPED_AVERAGE_SUM_KEY] ?? 0)
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
    if (!aggregateSelection) {
      return undefined
    }

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
    const result = await this.connection.queryCompiled<Record<string, unknown>>(this.getCompiler().compile(metadataPlan))
    const states: DatabaseQueryGroupedAggregateStateObservation[] = []
    for (const row of result.rows) {
      const aggregateValue = this.normalizeGroupedAggregateStateValue(
        groupedAggregate,
        row[GROUPED_AGGREGATE_VALUE_KEY],
      )
      const rowCount = this.normalizeAggregateMetadataNumber(row[GROUPED_AGGREGATE_ROW_COUNT_KEY])
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

    const aggregateColumn = groupedAggregate.aggregateColumn
    if (!aggregateColumn) {
      return undefined
    }

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
    const result = await this.connection.queryCompiled<Record<string, unknown>>(this.getCompiler().compile(metadataPlan))
    const groups: DatabaseQueryGroupedAggregateValueCountGroupObservation[] = []
    for (const row of result.rows) {
      const groupValue = row[GROUPED_AGGREGATE_GROUP_KEY]
      const value = this.normalizeGroupedAggregateStateValue(
        groupedAggregate,
        row[GROUPED_AGGREGATE_VALUE_COUNT_VALUE_KEY],
      )
      const count = this.normalizeAggregateMetadataNumber(row[GROUPED_AGGREGATE_VALUE_COUNT_KEY])
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
  ): QuerySelection | undefined {
    if (groupedAggregate.kind === 'count') {
      return this.createAggregateSelection('count', GROUPED_AGGREGATE_VALUE_KEY, '*')
    }

    if (
      (
        groupedAggregate.kind === 'sum'
        || groupedAggregate.kind === 'min'
        || groupedAggregate.kind === 'max'
      )
      && groupedAggregate.aggregateColumn
    ) {
      return this.createAggregateSelection(
        groupedAggregate.kind,
        GROUPED_AGGREGATE_VALUE_KEY,
        groupedAggregate.aggregateColumn,
      )
    }

    return undefined
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

    return this.normalizeAggregateMetadataNumber(value)
  }

  private normalizeAggregateMetadataNumber(value: unknown): number | undefined {
    if (value === null) {
      return 0
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

    const rows = await this.getUnpaginatedRows<TRow>()
    const total = rows.length
    const offset = (page - 1) * perPage
    const data = rows.slice(offset, offset + perPage)
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
    rebindDatabaseQueryObservationPagination(rows, result.data, result.meta, Object.freeze({
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

    const rows = await this.getUnpaginatedRows<TRow>()
    const offset = (page - 1) * perPage
    const pageRows = rows.slice(offset, offset + perPage + 1)
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
    rebindDatabaseQueryObservationPagination(rows, result.data, result.meta, Object.freeze({
      currentPage: page,
      hasMorePages,
      kind: 'simple',
      pageName,
      perPage,
      rowCount: rows.length,
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
    const rows = await orderedQuery.getUnpaginatedRows<TRow>()
    const filteredRows = decodedCursor
      ? rows.filter(row => isRowAfterCursor(
        cursorOrders.map(order => orderedQuery.readCursorColumnValue(row, order.column)),
        decodedCursor.values,
        cursorOrders,
      ))
      : rows
    const pageRows = filteredRows.slice(0, perPage + 1)
    const hasMorePages = pageRows.length > perPage
    const data = hasMorePages ? pageRows.slice(0, perPage) : pageRows
    const lastRow = data.at(-1)
    const result = createCursorPaginator(data, {
      perPage,
      cursorName,
      nextCursor: hasMorePages && lastRow
        ? encodeValueCursor(cursorOrders.map(order => orderedQuery.readCursorColumnValue(lastRow, order.column)))
        : null,
      prevCursor: cursor,
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

    const rows = await this.getUnpaginatedRows<TRow>()
    let page = 1

    for (let index = 0; index < rows.length; index += size) {
      const result = await callback(rows.slice(index, index + size), page)
      if (result === false) {
        return
      }

      page += 1
    }
  }

  async chunkById<TRow extends Record<string, unknown> = TSelectedRow>(
    size: number,
    callback: (rows: readonly TRow[], page: number) => unknown | Promise<unknown>,
    column = 'id',
  ): Promise<void> {
    assertPositiveInteger(size, 'Chunk size', message => new SecurityError(message))

    const rows = await this.getUnpaginatedRows<TRow>()
    const sortedRows = [...rows].sort((left, right) => {
      const a = left[column]
      const b = right[column]
      return compareChunkValuesAscending(a, b)
    })

    let page = 1
    for (let index = 0; index < sortedRows.length; index += size) {
      const result = await callback(sortedRows.slice(index, index + size), page)
      if (result === false) {
        return
      }

      page += 1
    }
  }

  async chunkByIdDesc<TRow extends Record<string, unknown> = TSelectedRow>(
    size: number,
    callback: (rows: readonly TRow[], page: number) => unknown | Promise<unknown>,
    column = 'id',
  ): Promise<void> {
    assertPositiveInteger(size, 'Chunk size', message => new SecurityError(message))

    const rows = await this.getUnpaginatedRows<TRow>()
    const sortedRows = [...rows].sort((left, right) => {
      const a = left[column]
      const b = right[column]
      return compareChunkValuesDescending(a, b)
    })

    let page = 1
    for (let index = 0; index < sortedRows.length; index += size) {
      const result = await callback(sortedRows.slice(index, index + size), page)
      if (result === false) {
        return
      }

      page += 1
    }
  }

  async* lazy<TRow extends Record<string, unknown> = TSelectedRow>(
    size = 1000,
  ): AsyncGenerator<TRow, void, unknown> {
    assertPositiveInteger(size, 'Chunk size', message => new SecurityError(message))

    const rows = await this.getUnpaginatedRows<TRow>()
    for (let index = 0; index < rows.length; index += size) {
      for (const row of rows.slice(index, index + size)) {
        yield row
      }
    }
  }

  async* cursor<TRow extends Record<string, unknown> = TSelectedRow>(): AsyncGenerator<TRow, void, unknown> {
    const rows = await this.getUnpaginatedRows<TRow>()
    for (const row of rows) {
      yield row
    }
  }

  async count(): Promise<number> {
    const rows = await this.get()
    const result = rows.length
    if (hasActiveDatabaseDependencyCollector()) {
      rebindDatabaseQueryObservationAggregate(rows, result, Object.freeze({ kind: 'count' }))
    }
    return result
  }

  async exists(): Promise<boolean> {
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

  async pluck<TKey extends SelectedColumnNames<TSelectedRow>>(
    column: TKey,
  ): Promise<Array<TSelectedRow[TKey]>> {
    const rows = await this.get<Record<string, unknown>>()
    const result = rows.map(row => row[column] as TSelectedRow[TKey])
    rebindDatabaseQueryObservationScalarList(rows, result, column)
    return result
  }

  async value<TKey extends SelectedColumnNames<TSelectedRow>>(
    column: TKey,
  ): Promise<TSelectedRow[TKey] | undefined> {
    const row = await this.first<Record<string, unknown>>()
    const result = row?.[column] as TSelectedRow[TKey] | undefined
    rebindDatabaseQueryObservationScalar(row, result, column)
    return result
  }

  async valueOrFail<TKey extends SelectedColumnNames<TSelectedRow>>(
    column: TKey,
  ): Promise<TSelectedRow[TKey]> {
    const row = await this.first<Record<string, unknown>>()
    if (!row || typeof row[column] === 'undefined') {
      throw new CompilerError(`Query returned no value for column "${column}".`)
    }

    const result = row[column] as TSelectedRow[TKey]
    rebindDatabaseQueryObservationScalar(row, result, column)
    return result
  }

  async soleValue<TKey extends SelectedColumnNames<TSelectedRow>>(
    column: TKey,
  ): Promise<TSelectedRow[TKey]> {
    const row = await this.sole<Record<string, unknown>>()
    if (typeof row[column] === 'undefined') {
      throw new CompilerError(`Query returned no value for column "${column}".`)
    }

    const result = row[column] as TSelectedRow[TKey]
    rebindDatabaseQueryObservationScalar(row, result, column)
    return result
  }

  async sum(column: string): Promise<number> {
    return this.aggregateNumeric(column, 'sum')
  }

  async avg(column: string): Promise<number | null> {
    const rows = await this.get<Record<string, unknown>>()
    if (rows.length === 0) {
      if (hasActiveDatabaseDependencyCollector()) {
        rebindDatabaseQueryObservationAggregate(rows, null, Object.freeze({ column, count: 0, kind: 'avg', sum: 0 }))
      }
      return null
    }

    const values = this.extractNumericValues(rows, column, 'avg')
    const sum = values.reduce((total, value) => total + value, 0)
    const result = sum / values.length
    if (hasActiveDatabaseDependencyCollector()) {
      rebindDatabaseQueryObservationAggregate(rows, result, Object.freeze({ column, count: values.length, kind: 'avg', sum }))
    }
    return result
  }

  async min(column: string): Promise<number | null> {
    const rows = await this.get<Record<string, unknown>>()
    if (rows.length === 0) {
      if (hasActiveDatabaseDependencyCollector()) {
        rebindDatabaseQueryObservationAggregate(rows, null, Object.freeze({ column, kind: 'min' }))
      }
      return null
    }

    const values = this.extractNumericValues(rows, column, 'min')
    const result = Math.min(...values)
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

  async max(column: string): Promise<number | null> {
    const rows = await this.get<Record<string, unknown>>()
    if (rows.length === 0) {
      if (hasActiveDatabaseDependencyCollector()) {
        rebindDatabaseQueryObservationAggregate(rows, null, Object.freeze({ column, kind: 'max' }))
      }
      return null
    }

    const values = this.extractNumericValues(rows, column, 'max')
    const result = Math.max(...values)
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
    const rows = Array.isArray(values)
      ? values.map(value => this.normalizeWriteRecord(value))
      : [this.normalizeWriteRecord(values as Readonly<Record<string, unknown>>)]
    const hasInvalidationListeners = hasDatabaseDependencyInvalidationListeners()
    const useReturningRows = this.shouldUseReturningMutationRows(hasInvalidationListeners)
    const result: MutationExecutionResult = useReturningRows
      ? await this.queryReturningMutationRows(
          createInsertQueryPlan(this.source, rows, { returning: true }),
          true,
        )
      : await this.connection.executeCompiled(this.getCompiler().compile(
          createInsertQueryPlan(this.source, rows),
        ))
    await this.invalidateInsertQueries('insert', result.rows?.rows ?? rows, result.lastInsertId)
    return {
      affectedRows: result.affectedRows,
      lastInsertId: result.lastInsertId,
    }
  }

  async insertOrIgnore(
    values: Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[],
  ): Promise<DriverExecutionResult> {
    const rows = Array.isArray(values)
      ? values.map(value => this.normalizeWriteRecord(value))
      : [this.normalizeWriteRecord(values as Readonly<Record<string, unknown>>)]
    const hasInvalidationListeners = hasDatabaseDependencyInvalidationListeners()
    const useReturningRows = this.shouldUseReturningMutationRows(hasInvalidationListeners)
    const result: MutationExecutionResult = useReturningRows
      ? await this.queryReturningMutationRows(
          createInsertQueryPlan(this.source, rows, { ignoreConflicts: true, returning: true }),
          true,
        )
      : await this.connection.executeCompiled(this.getCompiler().compile(
          createInsertQueryPlan(this.source, rows, { ignoreConflicts: true }),
        ))
    if (!useReturningRows || result.affectedRows !== 0) {
      await this.invalidateInsertQueries('insert', result.rows?.rows ?? rows, result.lastInsertId)
    }
    return {
      affectedRows: result.affectedRows,
      lastInsertId: result.lastInsertId,
    }
  }

  async insertGetId(values: Readonly<Record<string, unknown>>): Promise<number | string | undefined> {
    const result = await this.insert(values)
    return result.lastInsertId
  }

  async upsert(
    values: Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[],
    uniqueBy: readonly string[],
    updateColumns: readonly string[] = [],
  ): Promise<DriverExecutionResult> {
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
          true,
        )
      : await this.connection.executeCompiled(this.getCompiler().compile(
          createUpsertQueryPlan(this.source, rows, uniqueBy, updateColumns),
        ))
    if (!useReturningRows || result.affectedRows !== 0) {
      await this.invalidateInsertQueries('upsert', result.rows?.rows ?? rows, result.lastInsertId, previousRows)
    }
    return {
      affectedRows: result.affectedRows,
      lastInsertId: result.lastInsertId,
    }
  }

  async increment(
    column: string,
    amount = 1,
    extraValues: Readonly<Record<string, unknown>> = {},
  ): Promise<DriverExecutionResult> {
    return this.adjustNumericColumn(column, amount, extraValues)
  }

  async decrement(
    column: string,
    amount = 1,
    extraValues: Readonly<Record<string, unknown>> = {},
  ): Promise<DriverExecutionResult> {
    return this.adjustNumericColumn(column, -amount, extraValues)
  }

  async update(values: Readonly<Record<string, unknown>>): Promise<DriverExecutionResult> {
    const normalizedValues = this.normalizeUpdateValues(values)
    const hasInvalidationListeners = hasDatabaseDependencyInvalidationListeners()
    const useReturningRows = this.shouldUseReturningMutationRows(hasInvalidationListeners)
    const mutationRows = hasInvalidationListeners && !useReturningRows
      ? await this.captureUpdatedMutationRows(normalizedValues)
      : undefined
    const result: MutationExecutionResult = useReturningRows
      ? await this.queryReturningMutationRows(
          createUpdateQueryPlan(this.source, this.plan.predicates, normalizedValues, { returning: true }),
        )
      : await this.connection.executeCompiled(this.getCompiler().compile(
        createUpdateQueryPlan(this.source, this.plan.predicates, normalizedValues),
      ))
    const capturedRows = result.rows ?? mutationRows
    if (result.affectedRows !== 0) {
      await this.invalidateMutationQueries(normalizedValues, capturedRows)
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

  private clone<TRow extends Record<string, unknown> = TSelectedRow>(
    plan: SelectQueryPlan,
  ): TableQueryBuilder<TTableOrName, TRow> {
    const table = (this.source.table ?? this.source.tableName) as TTableOrName
    return new TableQueryBuilder<TTableOrName, TRow>(table, this.connection, plan, this.queryCacheConfig)
  }

  private async captureUpdatedMutationRows(
    values: Readonly<Record<string, unknown>>,
  ): Promise<CapturedMutationRows | undefined> {
    const plan = Object.freeze({
      ...createSelectQueryPlan(this.source),
      predicates: this.plan.predicates,
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
    const firstUniqueColumn = uniqueBy[0]
    if (!firstUniqueColumn || rows.length === 0 || !rows.every(row => this.hasUniqueByValues(row, uniqueBy))) {
      return undefined
    }

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

      const previousRow = result.rows[resultIndex]
      if (!previousRow) {
        continue
      }

      usedResultIndexes.add(resultIndex)
      previousRows.push(Object.freeze({ ...previousRow }))
    }

    return Object.freeze(previousRows)
  }

  private hasUniqueByValues(
    row: Readonly<Record<string, unknown>>,
    uniqueBy: readonly string[],
  ): boolean {
    return uniqueBy.every(column => Object.prototype.hasOwnProperty.call(row, column))
  }

  private rowsMatchUniqueBy(
    left: Readonly<Record<string, unknown>>,
    right: Readonly<Record<string, unknown>>,
    uniqueBy: readonly string[],
  ): boolean {
    return uniqueBy.every(column => left[column] === right[column])
  }

  private shouldUseReturningMutationRows(hasInvalidationListeners: boolean): boolean {
    return hasInvalidationListeners && this.connection.getCapabilities().returning
  }

  private async queryReturningMutationRows(
    plan:
      | ReturnType<typeof createInsertQueryPlan>
      | ReturnType<typeof createUpsertQueryPlan>
      | ReturnType<typeof createUpdateQueryPlan>
      | ReturnType<typeof createDeleteQueryPlan>,
    includeLastInsertId = false,
  ): Promise<MutationExecutionResult> {
    const result = await this.connection.queryCompiled(this.getCompiler().compile(plan))
    const rows = this.freezeMutationRows(result.rows)
    return {
      affectedRows: result.rowCount,
      lastInsertId: includeLastInsertId ? this.readReturnedLastInsertId(rows) : undefined,
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

  private readReturnedLastInsertId(
    rows: readonly Readonly<Record<string, unknown>>[],
  ): number | string | undefined {
    if (rows.length !== 1) {
      return undefined
    }

    const value = rows[0]?.[this.resolvePrimaryKeyColumn()]
    return typeof value === 'number' || typeof value === 'string'
      ? value
      : undefined
  }

  private async invalidateInsertQueries(
    kind: 'insert' | 'upsert',
    rows: readonly Readonly<Record<string, unknown>>[],
    lastInsertId?: number | string,
    previousRows?: readonly Readonly<Record<string, unknown>>[],
  ): Promise<void> {
    const hasInvalidationListeners = hasDatabaseDependencyInvalidationListeners()
    if (!getDatabaseQueryCacheBridge() && !hasInvalidationListeners) {
      return
    }

    const mutations = hasInvalidationListeners
      ? [
          createDatabaseMutationEvent(
            kind,
            this.connection.getConnectionName(),
            this.source.tableName,
            [],
            undefined,
            rows.length === 1
              && typeof lastInsertId !== 'undefined'
              && !Object.prototype.hasOwnProperty.call(rows[0], 'id')
              ? Object.freeze([Object.freeze({
                  ...rows[0],
                  id: lastInsertId,
                })])
              : rows,
            previousRows,
          ),
        ]
      : []
    const invalidation = inferAutomaticInsertCacheInvalidationPlan(
      this.connection.getConnectionName(),
      this.source.tableName,
      rows,
      lastInsertId,
      hasInvalidationListeners,
    )

    await invalidateQueryCacheDependencies(
      this.connection,
      invalidation.dependencies,
      mutations,
      invalidation,
    )
  }

  private async invalidateMutationQueries(
    values: Readonly<Record<string, unknown>> = {},
    capturedRows?: CapturedMutationRows,
  ): Promise<void> {
    const hasInvalidationListeners = hasDatabaseDependencyInvalidationListeners()
    if (!getDatabaseQueryCacheBridge() && !hasInvalidationListeners) {
      return
    }

    const hasValues = Object.keys(values).length > 0
    const invalidation = inferAutomaticQueryCacheInvalidationPlan(
      this.plan,
      this.connection.getConnectionName(),
      values,
      hasInvalidationListeners,
    )
    await invalidateQueryCacheDependencies(
      this.connection,
      invalidation.dependencies,
      hasInvalidationListeners
        ? [
            createDatabaseMutationEvent(
              hasValues ? 'update' : 'delete',
              this.connection.getConnectionName(),
              this.source.tableName,
              this.plan.predicates,
              hasValues ? values : undefined,
              capturedRows?.rows,
              capturedRows?.previousRows,
            ),
          ]
        : [],
      invalidation,
    )
  }

  private getCompiler(): SQLQueryCompiler {
    const dialect = this.connection.getDialect()

    if (dialect.name.startsWith('sqlite')) {
      return new SQLiteQueryCompiler(
        identifier => dialect.quoteIdentifier(identifier),
        index => dialect.createPlaceholder(index),
      )
    }

    if (dialect.name.startsWith('postgres')) {
      return new PostgresQueryCompiler(
        identifier => dialect.quoteIdentifier(identifier),
        index => dialect.createPlaceholder(index),
      )
    }

    if (dialect.name.startsWith('mysql')) {
      return new MySQLQueryCompiler(
        identifier => dialect.quoteIdentifier(identifier),
        index => dialect.createPlaceholder(index),
      )
    }

    throw new CompilerError(
      `The active query compiler does not support dialect "${dialect.name}".`,
    )
  }

  private async getUnpaginatedRows<TRow extends Record<string, unknown>>(): Promise<TRow[]> {
    return this.limit(undefined).offset(undefined).get<TRow>()
  }

  private resolvePrimaryKeyColumn(): string {
    const columns = this.source.table?.columns
    if (!columns) {
      return 'id'
    }

    const primaryKey = Object.values(columns).find(column => column.primaryKey)
    return primaryKey?.name ?? 'id'
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

  private async adjustNumericColumn(
    column: string,
    amount: number,
    extraValues: Readonly<Record<string, unknown>>,
  ): Promise<DriverExecutionResult> {
    if (typeof amount !== 'number' || Number.isNaN(amount)) {
      throw new SecurityError('Increment/decrement amount must be a valid number.')
    }

    const primaryKey = this.resolvePrimaryKeyColumn()
    const uncachedSelection = new TableQueryBuilder<TTableOrName, Record<string, unknown>>(
      (this.source.table ?? this.source.tableName) as TTableOrName,
      this.connection,
      withSelections(this.plan, [primaryKey as never, column as never]),
    )
    const rows = await uncachedSelection.get() as Record<string, unknown>[]
    let affectedRows = 0
    let lastInsertId: number | string | undefined

    for (const row of rows) {
      const currentValue = row[column]
      if (typeof currentValue !== 'number' || Number.isNaN(currentValue)) {
        throw new CompilerError(`Cannot increment/decrement non-numeric column "${column}".`)
      }

      const identifier = row[primaryKey]
      const payload: Record<string, unknown> = {
        ...extraValues,
        [column]: currentValue + amount,
      }
      const result = await this.where(primaryKey as never, identifier).update(payload)
      affectedRows += result.affectedRows ?? 0
      lastInsertId = result.lastInsertId ?? lastInsertId
    }

    return { affectedRows, lastInsertId }
  }

  private whereMultiColumns(
    mode: 'any' | 'all' | 'none',
    columns: readonly string[],
    operator: QueryOperator | unknown,
    value?: unknown,
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
    if (columns.length === 0) {
      throw new SecurityError(`where${mode.charAt(0).toUpperCase()}${mode.slice(1)}() requires at least one column.`)
    }

    const boolean = mode === 'all' ? 'and' : 'or'
    const callback = (query: TableQueryBuilder<TTableOrName, SelectRow<TTableOrName>>) => {
      let next = query.where(columns[0]! as never, operator, value)
      for (const column of columns.slice(1)) {
        next = boolean === 'and'
          ? next.where(column as never, operator, value)
          : next.orWhere(column as never, operator, value)
      }
      return next
    }

    if (mode === 'none') {
      return this.whereNot(callback)
    }

    return this.where(callback)
  }

  private whereFullTextWithBoolean(
    boolean: 'and' | 'or',
    columns: string | readonly string[],
    value: string,
    options: { mode?: 'natural' | 'boolean' } = {},
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
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
  ): TableQueryBuilder<TTableOrName, TSelectedRow> {
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

  private prepareCursorPaginationQuery(): TableQueryBuilder<TTableOrName, TSelectedRow> {
    if (this.plan.orderBy.some(orderBy => orderBy.kind === 'random')) {
      throw new SecurityError('Cursor pagination cannot use random ordering.')
    }

    if (this.plan.orderBy.length === 0) {
      if (!this.source.table) {
        throw new SecurityError('Cursor pagination requires an explicit stable orderBy clause.')
      }

      return this.orderBy(this.resolvePrimaryKeyColumn() as never)
    }

    return this
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
    if (column in row) {
      return row[column]
    }

    const unqualifiedColumn = column.split('.').at(-1)
    return unqualifiedColumn ? row[unqualifiedColumn] : undefined
  }

  private async aggregateNumeric(column: string, kind: 'sum'): Promise<number> {
    const rows = await this.get<Record<string, unknown>>()
    const result = rows.length === 0
      ? 0
      : this.extractNumericValues(rows, column, kind).reduce((sum, value) => sum + value, 0)
    if (hasActiveDatabaseDependencyCollector()) {
      rebindDatabaseQueryObservationAggregate(rows, result, Object.freeze({ column, kind }))
    }
    return result
  }

  private extractNumericValues(
    rows: readonly Record<string, unknown>[],
    column: string,
    kind: 'sum' | 'avg' | 'min' | 'max',
  ): number[] {
    return rows.map((row) => {
      const value = row[column]
      if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new CompilerError(`Query aggregate "${kind}" requires numeric values for column "${column}".`)
      }

      return value
    })
  }

  private normalizeUpdateValues(
    values: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown | readonly QueryJsonUpdateOperation[]>> {
    const normalized: Record<string, unknown | QueryJsonUpdateOperation[]> = {}

    for (const [key, value] of Object.entries(values)) {
      if (!key.includes('->')) {
        normalized[key] = this.normalizeWriteValueForColumn(key, value)
        continue
      }

      const { column, path } = this.parseJsonPath(key, false, 'update')
      if (typeof normalized[column] !== 'undefined' && !Array.isArray(normalized[column])) {
        throw new SecurityError(`Cannot mix direct and nested JSON assignments for column "${column}" in one update.`)
      }

      const operations = Array.isArray(normalized[column]) ? normalized[column] as QueryJsonUpdateOperation[] : []
      operations.push(Object.freeze({
        kind: 'json-set' as const,
        path,
        value,
      }))
      normalized[column] = operations
    }

    return Object.freeze(Object.fromEntries(
      Object.entries(normalized).map(([column, value]) => [
        column,
        Array.isArray(value) ? Object.freeze([...value]) : value,
      ]),
    ))
  }

  private normalizeWriteRecord(values: Readonly<Record<string, unknown>>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, this.normalizeWriteValueForColumn(key, value)]),
    )
  }

  private normalizeWriteValueForColumn(columnName: string, value: unknown): unknown {
    const column = this.source.table?.columns[columnName]
    if (!column) {
      return value
    }

    return normalizeDialectWriteValue(this.connection.getDriver() as SchemaDialectName, column as AnyColumnDefinition, value)
  }

  private normalizePredicateValueForColumn(columnName: string, value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(item => this.normalizeWriteValueForColumn(columnName, item))
    }

    return this.normalizeWriteValueForColumn(columnName, value)
  }
}
