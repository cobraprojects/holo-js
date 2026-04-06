import { CompilerError, SecurityError } from '../core/errors'
import { redactBindings } from '../security/policy'
import { compareChunkValuesAscending, compareChunkValuesDescending } from './chunkOrdering'
import {
  createCursorPaginator,
  createPaginator,
  createSimplePaginator,
} from './paginator'
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
  SelectQueryPlan,
} from './ast'

type SelectRow<TTableOrName extends string | TableDefinition>
  = TTableOrName extends TableDefinition ? InferSelect<TTableOrName> : Record<string, unknown>

type TableReference = string | TableDefinition
type BuilderCallback<TBuilder> = (query: TBuilder) => unknown
type ValueBuilderCallback<TBuilder, TValue> = (query: TBuilder, value: TValue) => unknown

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
    this.assertPositiveInteger(page, 'Page')
    this.assertPositiveInteger(perPage, 'Per-page value')

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

  async get<TRow extends Record<string, unknown> = TSelectedRow>(): Promise<TRow[]> {
    const result = await this.connection.queryCompiled<TRow>(this.toSQL())
    return result.rows
  }

  async first<TRow extends Record<string, unknown> = TSelectedRow>(): Promise<TRow | undefined> {
    const rows = await this.limit(1).get<TRow>()
    return rows[0]
  }

  async sole<TRow extends Record<string, unknown> = TSelectedRow>(): Promise<TRow> {
    const rows = await this.limit(2).get<TRow>()
    if (rows.length !== 1) {
      throw new CompilerError(`Query expected exactly one row but found ${rows.length}.`)
    }

    return rows[0]!
  }

  async paginate<TRow extends Record<string, unknown> = TSelectedRow>(
    perPage = 15,
    page = 1,
    options: PaginationOptions = {},
  ): Promise<PaginatedResult<TRow>> {
    this.assertPositiveInteger(perPage, 'Per-page value')
    this.assertPositiveInteger(page, 'Page')
    const pageName = this.normalizePaginationParameterName(options.pageName, 'page')

    const rows = await this.getUnpaginatedRows<TRow>()
    const total = rows.length
    const offset = (page - 1) * perPage
    const data = rows.slice(offset, offset + perPage)
    const from = data.length === 0 ? null : offset + 1
    const to = data.length === 0 ? null : offset + data.length

    return createPaginator(data, {
      total,
      perPage,
      pageName,
      currentPage: page,
      lastPage: Math.max(1, Math.ceil(total / perPage)),
      from,
      to,
      hasMorePages: offset + data.length < total,
    })
  }

  async simplePaginate<TRow extends Record<string, unknown> = TSelectedRow>(
    perPage = 15,
    page = 1,
    options: PaginationOptions = {},
  ): Promise<SimplePaginatedResult<TRow>> {
    this.assertPositiveInteger(perPage, 'Per-page value')
    this.assertPositiveInteger(page, 'Page')
    const pageName = this.normalizePaginationParameterName(options.pageName, 'page')

    const rows = await this.getUnpaginatedRows<TRow>()
    const offset = (page - 1) * perPage
    const pageRows = rows.slice(offset, offset + perPage + 1)
    const hasMorePages = pageRows.length > perPage
    const data = hasMorePages ? pageRows.slice(0, perPage) : pageRows
    const from = data.length === 0 ? null : offset + 1
    const to = data.length === 0 ? null : offset + data.length

    return createSimplePaginator(data, {
      perPage,
      pageName,
      currentPage: page,
      from,
      to,
      hasMorePages,
    })
  }

  async cursorPaginate<TRow extends Record<string, unknown> = TSelectedRow>(
    perPage = 15,
    cursor: string | null = null,
    options: CursorPaginationOptions = {},
  ): Promise<CursorPaginatedResult<TRow>> {
    this.assertPositiveInteger(perPage, 'Per-page value')
    const cursorName = this.normalizePaginationParameterName(options.cursorName, 'cursor')
    const offset = this.decodeCursor(cursor)
    const orderedQuery = this.prepareCursorPaginationQuery()
    const rows = await orderedQuery.getUnpaginatedRows<TRow>()
    const pageRows = rows.slice(offset, offset + perPage + 1)
    const hasMorePages = pageRows.length > perPage
    const data = hasMorePages ? pageRows.slice(0, perPage) : pageRows

    return createCursorPaginator(data, {
      perPage,
      cursorName,
      nextCursor: hasMorePages ? this.encodeCursor(offset + perPage) : null,
      prevCursor: cursor,
    })
  }

  async chunk<TRow extends Record<string, unknown> = TSelectedRow>(
    size: number,
    callback: (rows: readonly TRow[], page: number) => unknown | Promise<unknown>,
  ): Promise<void> {
    this.assertPositiveInteger(size, 'Chunk size')

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
    this.assertPositiveInteger(size, 'Chunk size')

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
    this.assertPositiveInteger(size, 'Chunk size')

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
    this.assertPositiveInteger(size, 'Chunk size')

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
    return (await this.get()).length
  }

  async exists(): Promise<boolean> {
    return (await this.count()) > 0
  }

  async doesntExist(): Promise<boolean> {
    return !(await this.exists())
  }

  async pluck<TKey extends SelectedColumnNames<TSelectedRow>>(
    column: TKey,
  ): Promise<Array<TSelectedRow[TKey]>> {
    const rows = await this.get<Record<string, unknown>>()
    return rows.map(row => row[column] as TSelectedRow[TKey])
  }

  async value<TKey extends SelectedColumnNames<TSelectedRow>>(
    column: TKey,
  ): Promise<TSelectedRow[TKey] | undefined> {
    const row = await this.first<Record<string, unknown>>()
    return row?.[column] as TSelectedRow[TKey] | undefined
  }

  async valueOrFail<TKey extends SelectedColumnNames<TSelectedRow>>(
    column: TKey,
  ): Promise<TSelectedRow[TKey]> {
    const row = await this.first<Record<string, unknown>>()
    if (!row || typeof row[column] === 'undefined') {
      throw new CompilerError(`Query returned no value for column "${column}".`)
    }

    return row[column] as TSelectedRow[TKey]
  }

  async soleValue<TKey extends SelectedColumnNames<TSelectedRow>>(
    column: TKey,
  ): Promise<TSelectedRow[TKey]> {
    const row = await this.sole<Record<string, unknown>>()
    if (typeof row[column] === 'undefined') {
      throw new CompilerError(`Query returned no value for column "${column}".`)
    }

    return row[column] as TSelectedRow[TKey]
  }

  async sum(column: string): Promise<number> {
    return this.aggregateNumeric(column, 'sum')
  }

  async avg(column: string): Promise<number | null> {
    const rows = await this.get<Record<string, unknown>>()
    if (rows.length === 0) {
      return null
    }

    const values = this.extractNumericValues(rows, column, 'avg')
    return values.reduce((sum, value) => sum + value, 0) / values.length
  }

  async min(column: string): Promise<number | null> {
    const rows = await this.get<Record<string, unknown>>()
    if (rows.length === 0) {
      return null
    }

    const values = this.extractNumericValues(rows, column, 'min')
    return Math.min(...values)
  }

  async max(column: string): Promise<number | null> {
    const rows = await this.get<Record<string, unknown>>()
    if (rows.length === 0) {
      return null
    }

    const values = this.extractNumericValues(rows, column, 'max')
    return Math.max(...values)
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
    return this.connection.executeCompiled(this.getCompiler().compile(
      createInsertQueryPlan(this.source, rows),
    ))
  }

  async insertOrIgnore(
    values: Readonly<Record<string, unknown>> | readonly Readonly<Record<string, unknown>>[],
  ): Promise<DriverExecutionResult> {
    const rows = Array.isArray(values)
      ? values.map(value => this.normalizeWriteRecord(value))
      : [this.normalizeWriteRecord(values as Readonly<Record<string, unknown>>)]
    return this.connection.executeCompiled(this.getCompiler().compile(
      createInsertQueryPlan(this.source, rows, { ignoreConflicts: true }),
    ))
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
    return this.connection.executeCompiled(this.getCompiler().compile(
      createUpsertQueryPlan(this.source, rows, uniqueBy, updateColumns),
    ))
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
    return this.connection.executeCompiled(this.getCompiler().compile(
      createUpdateQueryPlan(this.source, this.plan.predicates, this.normalizeUpdateValues(values)),
    ))
  }

  async updateJson(
    columnPath: string,
    value: unknown,
  ): Promise<DriverExecutionResult> {
    return this.update({ [columnPath]: value })
  }

  async delete(): Promise<DriverExecutionResult> {
    return this.connection.executeCompiled(this.getCompiler().compile(
      createDeleteQueryPlan(this.source, this.plan.predicates),
    ))
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
    return new TableQueryBuilder<TTableOrName, TRow>(table, this.connection, plan)
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
    const rows = await this.select(primaryKey as never, column as never).get() as Record<string, unknown>[]
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

  private assertPositiveInteger(value: number, kind: string): void {
    if (!Number.isInteger(value) || value <= 0) {
      throw new SecurityError(`${kind} must be a positive integer.`)
    }
  }

  private normalizePaginationParameterName(value: string | undefined, fallback: string): string {
    if (typeof value === 'undefined') {
      return fallback
    }

    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new SecurityError(
        `${fallback === 'cursor' ? 'Cursor' : 'Page'} parameter name must be a non-empty string.`,
      )
    }

    return value
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

  private encodeCursor(offset: number): string {
    return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url')
  }

  private decodeCursor(cursor: string | null): number {
    if (cursor === null) {
      return 0
    }

    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown }
      const offset = decoded.offset
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
        throw new Error('invalid offset')
      }

      return offset
    } catch {
      throw new SecurityError('Cursor is malformed.')
    }
  }

  private async aggregateNumeric(column: string, kind: 'sum'): Promise<number> {
    const rows = await this.get<Record<string, unknown>>()
    if (rows.length === 0) {
      return 0
    }

    return this.extractNumericValues(rows, column, kind).reduce((sum, value) => sum + value, 0)
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
