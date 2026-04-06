import { HydrationError, ModelNotFoundException, RelationError } from '../core/errors'
import {
  createCursorPaginator,
  createPaginator,
  createSimplePaginator,
} from '../query/paginator'
import { compareChunkValuesAscending, compareChunkValuesDescending } from '../query/chunkOrdering'
import { TableQueryBuilder } from '../query/TableQueryBuilder'
import { resolveMorphSelector } from './morphRegistry'
import type { ModelCollection } from './collection'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { DriverExecutionResult } from '../core/types'
import type {
  CursorPaginatedResult,
  CursorPaginationOptions,
  PaginatedResult,
  PaginationOptions,
  SimplePaginatedResult,
} from '../query/types'
import type { TableDefinition } from '../schema/types'
import type { Entity } from './Entity'
import type {
  EntityWithLoaded,
  ModelAttributeKey,
  ModelCastDefinition,
  ModelColumnName,
  ModelColumnReference,
  ModelJsonColumnPath,
  ModelRecord,
  ModelRelationPath,
  ModelSelectableColumn,
  RelatedColumnNameForRelationPath,
  RelationMap,
  ResolveEagerLoads,
} from './types'
import type { ModelRepository } from './ModelRepository'

type BuilderCallback<TBuilder> = (query: TBuilder) => unknown
type ValueBuilderCallback<TBuilder, TValue> = (query: TBuilder, value: TValue) => unknown
type RelationConstraint = (query: ModelQueryBuilder<TableDefinition>) => unknown
type SubqueryBuilder<TSubTable extends TableDefinition = TableDefinition>
  = TableQueryBuilder<TSubTable, Record<string, unknown>> | ModelQueryBuilder<TSubTable>
type RelationFilter = {
  relation: string
  negate: boolean
  constraint?: RelationConstraint
  boolean?: 'and' | 'or'
  morphTypes?: readonly string[]
}
type MorphEntityTarget = {
  exists(): boolean
  getRepository(): {
    definition: {
      morphClass: string
      primaryKey: string
    }
  }
  get(key: string): unknown
}
type MorphModelTarget = {
  definition?: {
    morphClass?: string
  }
}
type MorphTypeSelector = string | MorphModelTarget | MorphEntityTarget | null
type EagerLoad = {
  relation: string
  constraint?: RelationConstraint
}
type AggregateLoad = {
  relation: string
  kind: 'count' | 'exists' | 'sum' | 'avg' | 'min' | 'max'
  constraint?: RelationConstraint
  column?: string
  alias?: string
}
type RelationConstraintMap<TRelations extends RelationMap> = Readonly<
  Partial<Record<ModelRelationPath<TRelations>, RelationConstraint>>
>

export class ModelQueryBuilder<
  TTable extends TableDefinition = TableDefinition,
  TRelations extends RelationMap = RelationMap,
  TLoaded = unknown,
> {
  constructor(
    private readonly repository: ModelRepository<TTable>,
    private readonly tableQuery: TableQueryBuilder<TTable, Record<string, unknown>>,
    private readonly eagerLoads: readonly EagerLoad[] = [],
    private readonly relationFilters: readonly RelationFilter[] = [],
    private readonly aggregateLoads: readonly AggregateLoad[] = [],
    private readonly queryCasts: Readonly<Record<string, ModelCastDefinition>> = {},
  ) {}

  getConnection(): DatabaseContext {
    return this.tableQuery.getConnection()
  }

  getConnectionName(): string {
    return this.tableQuery.getConnectionName()
  }

  getTableQueryBuilder(): TableQueryBuilder<TTable, Record<string, unknown>> {
    return this.tableQuery
  }

  from(table: string): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.from(table) as unknown as TableQueryBuilder<TTable, Record<string, unknown>>)
  }

  where(
    callback: BuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded>>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded>
  where(column: ModelColumnName<TTable> | ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded>
  where(
    columnOrCallback: ModelColumnName<TTable> | ModelJsonColumnPath<TTable> | BuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded>>,
    operator?: unknown,
    value?: unknown,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    if (typeof columnOrCallback === 'function') {
      const nested = new ModelQueryBuilder<TTable, TRelations, TLoaded>(
        this.repository,
        new TableQueryBuilder(this.repository.definition.table, this.getConnection()),
      )
      const callbackResult = columnOrCallback(nested)
      const result = callbackResult instanceof ModelQueryBuilder ? callbackResult : nested
      const predicates = result.getTableQueryBuilder().getPlan().predicates
      if (predicates.length === 0) {
        return this
      }

      return this.clone(this.tableQuery.where((query) => {
        let next = query
        for (const predicate of predicates) {
          next = new TableQueryBuilder(
            this.repository.definition.table,
            this.getConnection(),
            {
              ...next.getPlan(),
              predicates: Object.freeze([...next.getPlan().predicates, predicate]),
            },
          )
        }
        return next
      }))
    }

    return this.clone(this.tableQuery.where(columnOrCallback as never, operator, value))
  }

  orWhere(
    callback: BuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded>>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded>
  orWhere(column: ModelColumnName<TTable> | ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded>
  orWhere(
    columnOrCallback: ModelColumnName<TTable> | ModelJsonColumnPath<TTable> | BuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded>>,
    operator?: unknown,
    value?: unknown,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    if (typeof columnOrCallback === 'function') {
      const nested = new ModelQueryBuilder<TTable, TRelations, TLoaded>(
        this.repository,
        new TableQueryBuilder(this.repository.definition.table, this.getConnection()),
      )
      const callbackResult = columnOrCallback(nested)
      const result = callbackResult instanceof ModelQueryBuilder ? callbackResult : nested
      const predicates = result.getTableQueryBuilder().getPlan().predicates
      if (predicates.length === 0) {
        return this
      }

      return this.clone(this.tableQuery.orWhere((query) => {
        let next = query
        for (const predicate of predicates) {
          next = new TableQueryBuilder(
            this.repository.definition.table,
            this.getConnection(),
            {
              ...next.getPlan(),
              predicates: Object.freeze([...next.getPlan().predicates, predicate]),
            },
          )
        }
        return next
      }))
    }

    return this.clone(this.tableQuery.orWhere(columnOrCallback as never, operator, value))
  }

  whereNot(
    callback: BuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded>>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    const nested = new ModelQueryBuilder<TTable, TRelations, TLoaded>(
      this.repository,
      new TableQueryBuilder(this.repository.definition.table, this.getConnection()),
    )
    const callbackResult = callback(nested)
    const result = callbackResult instanceof ModelQueryBuilder ? callbackResult : nested
    const predicates = result.getTableQueryBuilder().getPlan().predicates
    if (predicates.length === 0) {
      return this
    }

    return this.clone(this.tableQuery.whereNot((query) => {
      let next = query
      for (const predicate of predicates) {
        next = new TableQueryBuilder(
          this.repository.definition.table,
          this.getConnection(),
          {
            ...next.getPlan(),
            predicates: Object.freeze([...next.getPlan().predicates, predicate]),
          },
        )
      }
      return next
    }))
  }

  orWhereNot(
    callback: BuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded>>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    const nested = new ModelQueryBuilder<TTable, TRelations, TLoaded>(
      this.repository,
      new TableQueryBuilder(this.repository.definition.table, this.getConnection()),
    )
    const callbackResult = callback(nested)
    const result = callbackResult instanceof ModelQueryBuilder ? callbackResult : nested
    const predicates = result.getTableQueryBuilder().getPlan().predicates
    if (predicates.length === 0) {
      return this
    }

    return this.clone(this.tableQuery.orWhereNot((query) => {
      let next = query
      for (const predicate of predicates) {
        next = new TableQueryBuilder(
          this.repository.definition.table,
          this.getConnection(),
          {
            ...next.getPlan(),
            predicates: Object.freeze([...next.getPlan().predicates, predicate]),
          },
        )
      }
      return next
    }))
  }

  whereExists<TSubTable extends TableDefinition>(
    subquery: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereExists(this.normalizeExistsSubquery(subquery)))
  }

  orWhereExists<TSubTable extends TableDefinition>(
    subquery: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.orWhereExists(this.normalizeExistsSubquery(subquery)))
  }

  whereNotExists<TSubTable extends TableDefinition>(
    subquery: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereNotExists(this.normalizeExistsSubquery(subquery)))
  }

  orWhereNotExists<TSubTable extends TableDefinition>(
    subquery: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.orWhereNotExists(this.normalizeExistsSubquery(subquery)))
  }

  whereSub<TSubTable extends TableDefinition>(
    column: ModelColumnName<TTable>,
    operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'in' | 'not in' | 'like',
    subquery: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereSub(column as never, operator, this.normalizeExistsSubquery(subquery)))
  }

  orWhereSub<TSubTable extends TableDefinition>(
    column: ModelColumnName<TTable>,
    operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'in' | 'not in' | 'like',
    subquery: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.orWhereSub(column as never, operator, this.normalizeExistsSubquery(subquery)))
  }

  whereInSub<TSubTable extends TableDefinition>(
    column: ModelColumnName<TTable>,
    subquery: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereInSub(column as never, this.normalizeExistsSubquery(subquery)))
  }

  whereNotInSub<TSubTable extends TableDefinition>(
    column: ModelColumnName<TTable>,
    subquery: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereNotInSub(column as never, this.normalizeExistsSubquery(subquery)))
  }

  whereNull(column: ModelColumnName<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereNull(column as never))
  }

  orWhereNull(column: ModelColumnName<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.orWhereNull(column as never))
  }

  whereNotNull(column: ModelColumnName<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereNotNull(column as never))
  }

  orWhereNotNull(column: ModelColumnName<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.orWhereNotNull(column as never))
  }

  when<TValue>(
    value: TValue,
    callback: ValueBuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded>, TValue>,
    defaultCallback?: ValueBuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded>, TValue>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    if (value) {
      const result = callback(this, value)
      return result instanceof ModelQueryBuilder ? result : this
    }

    const result = defaultCallback?.(this, value)
    return result instanceof ModelQueryBuilder ? result : this
  }

  unless<TValue>(
    value: TValue,
    callback: ValueBuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded>, TValue>,
    defaultCallback?: ValueBuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded>, TValue>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    if (!value) {
      const result = callback(this, value)
      return result instanceof ModelQueryBuilder ? result : this
    }

    const result = defaultCallback?.(this, value)
    return result instanceof ModelQueryBuilder ? result : this
  }

  orderBy(column: ModelColumnName<TTable>, direction: 'asc' | 'desc' = 'asc'): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.orderBy(column as never, direction))
  }

  latest(column: ModelColumnName<TTable> = 'created_at' as ModelColumnName<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.latest(column as never))
  }

  oldest(column: ModelColumnName<TTable> = 'created_at' as ModelColumnName<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.oldest(column as never))
  }

  inRandomOrder(): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.inRandomOrder())
  }

  reorder(column?: ModelColumnName<TTable>, direction: 'asc' | 'desc' = 'asc'): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.reorder(column as never, direction))
  }

  lock(mode: 'update' | 'share'): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.lock(mode))
  }

  lockForUpdate(): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.lockForUpdate())
  }

  sharedLock(): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.sharedLock())
  }

  // Scope removal rebuilds the entire query from the repository because
  // there is no way to separate user-added eagerLoads / relationFilters /
  // aggregateLoads / queryCasts from those injected by the excluded scope.
  // TLoaded is dropped so the type does not claim relations are loaded when
  // the excluded scope may have been the one that added them.
  withoutGlobalScope(name: string): ModelQueryBuilder<TTable, TRelations> {
    return this.repository.queryWithoutGlobalScope(name) as ModelQueryBuilder<TTable, TRelations>
  }

  withoutGlobalScopes(names?: readonly string[]): ModelQueryBuilder<TTable, TRelations> {
    return this.repository.queryWithoutGlobalScopes(names) as ModelQueryBuilder<TTable, TRelations>
  }

  limit(value?: number): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.limit(value))
  }

  offset(value?: number): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.offset(value))
  }

  skip(value: number): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.offset(value)
  }

  take(value: number): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.limit(value)
  }

  forPage(page: number, perPage = 15): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.forPage(page, perPage))
  }

  select(...columns: readonly ModelSelectableColumn<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(
      (this.tableQuery as TableQueryBuilder<TableDefinition, Record<string, unknown>>).select(...columns) as TableQueryBuilder<TTable, Record<string, unknown>>,
    )
  }

  addSelect(...columns: readonly ModelSelectableColumn<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(
      (this.tableQuery as TableQueryBuilder<TableDefinition, Record<string, unknown>>).addSelect(...columns) as TableQueryBuilder<TTable, Record<string, unknown>>,
    )
  }

  selectSub<TSubTable extends TableDefinition>(
    query: SubqueryBuilder<TSubTable>,
    alias: string,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.selectSub(this.normalizeExistsSubquery(query), alias))
  }

  addSelectSub<TSubTable extends TableDefinition>(
    query: SubqueryBuilder<TSubTable>,
    alias: string,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.addSelectSub(this.normalizeExistsSubquery(query), alias))
  }

  distinct(): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.distinct())
  }

  withCasts(casts: Record<string, ModelCastDefinition>): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return new ModelQueryBuilder<TTable, TRelations, TLoaded>(
      this.repository,
      this.tableQuery,
      this.eagerLoads,
      this.relationFilters,
      this.aggregateLoads,
      Object.freeze({
        ...this.queryCasts,
        ...casts,
      }),
    )
  }

  whereColumn(
    column: ModelColumnReference<TTable>,
    operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like',
    compareTo: ModelColumnReference<TTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereColumn(column as never, operator, compareTo as never))
  }

  whereIn(column: ModelColumnName<TTable>, values: readonly unknown[]): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereIn(column as never, values))
  }

  whereNotIn(column: ModelColumnName<TTable>, values: readonly unknown[]): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereNotIn(column as never, values))
  }

  whereBetween(
    column: ModelColumnName<TTable>,
    range: readonly [unknown, unknown],
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereBetween(column as never, range))
  }

  whereNotBetween(
    column: ModelColumnName<TTable>,
    range: readonly [unknown, unknown],
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereNotBetween(column as never, range))
  }

  whereLike(column: ModelColumnName<TTable>, pattern: string): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereLike(column as never, pattern))
  }

  orWhereLike(column: ModelColumnName<TTable>, pattern: string): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.orWhereLike(column as never, pattern))
  }

  whereAny(columns: readonly ModelColumnName<TTable>[], operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereAny(columns as never, operator, value))
  }

  whereAll(columns: readonly ModelColumnName<TTable>[], operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereAll(columns as never, operator, value))
  }

  whereNone(columns: readonly ModelColumnName<TTable>[], operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereNone(columns as never, operator, value))
  }

  join(
    table: string,
    leftColumn: ModelColumnReference<TTable>,
    operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like',
    rightColumn: ModelColumnReference<TTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.join(table, leftColumn as never, operator, rightColumn as never))
  }

  leftJoin(
    table: string,
    leftColumn: ModelColumnReference<TTable>,
    operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like',
    rightColumn: ModelColumnReference<TTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.leftJoin(table, leftColumn as never, operator, rightColumn as never))
  }

  rightJoin(
    table: string,
    leftColumn: ModelColumnReference<TTable>,
    operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like',
    rightColumn: ModelColumnReference<TTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.rightJoin(table, leftColumn as never, operator, rightColumn as never))
  }

  crossJoin(table: string): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.crossJoin(table))
  }

  joinSub<TSubTable extends TableDefinition>(
    query: SubqueryBuilder<TSubTable>,
    alias: string,
    leftColumn: ModelColumnReference<TTable>,
    operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like',
    rightColumn: ModelColumnReference<TTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.joinSub(this.normalizeExistsSubquery(query), alias, leftColumn as never, operator, rightColumn as never))
  }

  leftJoinSub<TSubTable extends TableDefinition>(
    query: SubqueryBuilder<TSubTable>,
    alias: string,
    leftColumn: ModelColumnReference<TTable>,
    operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like',
    rightColumn: ModelColumnReference<TTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.leftJoinSub(this.normalizeExistsSubquery(query), alias, leftColumn as never, operator, rightColumn as never))
  }

  rightJoinSub<TSubTable extends TableDefinition>(
    query: SubqueryBuilder<TSubTable>,
    alias: string,
    leftColumn: ModelColumnReference<TTable>,
    operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like',
    rightColumn: ModelColumnReference<TTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.rightJoinSub(this.normalizeExistsSubquery(query), alias, leftColumn as never, operator, rightColumn as never))
  }

  joinLateral<TSubTable extends TableDefinition>(
    query: SubqueryBuilder<TSubTable>,
    alias: string,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.joinLateral(this.normalizeExistsSubquery(query), alias))
  }

  leftJoinLateral<TSubTable extends TableDefinition>(
    query: SubqueryBuilder<TSubTable>,
    alias: string,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.leftJoinLateral(this.normalizeExistsSubquery(query), alias))
  }

  union<TSubTable extends TableDefinition>(
    query: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.union(this.normalizeExistsSubquery(query)))
  }

  unionAll<TSubTable extends TableDefinition>(
    query: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.unionAll(this.normalizeExistsSubquery(query)))
  }

  groupBy(...columns: readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    const tableQuery = this.tableQuery as TableQueryBuilder<TTable, Record<string, unknown>> & {
      groupBy: (...args: readonly string[]) => TableQueryBuilder<TTable, Record<string, unknown>>
    }
    return this.clone(
      tableQuery.groupBy(...columns),
    )
  }

  having(expression: string, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.having(expression, operator, value))
  }

  havingBetween(expression: string, range: readonly [unknown, unknown]): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.havingBetween(expression, range))
  }

  unsafeWhere(sql: string, bindings: readonly unknown[]): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.unsafeWhere(sql, bindings))
  }

  orUnsafeWhere(sql: string, bindings: readonly unknown[]): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.orUnsafeWhere(sql, bindings))
  }

  whereDate(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereDate(column as never, operator, value))
  }

  whereMonth(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereMonth(column as never, operator, value))
  }

  whereDay(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereDay(column as never, operator, value))
  }

  whereYear(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereYear(column as never, operator, value))
  }

  whereTime(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereTime(column as never, operator, value))
  }

  whereJson(columnPath: ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereJson(columnPath as never, operator, value))
  }

  orWhereJson(columnPath: ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.orWhereJson(columnPath as never, operator, value))
  }

  whereJsonContains(columnPath: ModelJsonColumnPath<TTable>, value: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereJsonContains(columnPath as never, value))
  }

  orWhereJsonContains(columnPath: ModelJsonColumnPath<TTable>, value: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.orWhereJsonContains(columnPath as never, value))
  }

  whereJsonLength(columnPath: ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereJsonLength(columnPath as never, operator, value))
  }

  orWhereJsonLength(columnPath: ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.orWhereJsonLength(columnPath as never, operator, value))
  }

  whereFullText(
    columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[],
    value: string,
    options: { mode?: 'natural' | 'boolean' } = {},
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereFullText(columns as never, value, options))
  }

  orWhereFullText(
    columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[],
    value: string,
    options: { mode?: 'natural' | 'boolean' } = {},
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.orWhereFullText(columns as never, value, options))
  }

  whereVectorSimilarTo(
    column: ModelColumnName<TTable>,
    vector: readonly number[],
    minSimilarity = 0,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.whereVectorSimilarTo(column as never, vector, minSimilarity))
  }

  orWhereVectorSimilarTo(
    column: ModelColumnName<TTable>,
    vector: readonly number[],
    minSimilarity = 0,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.orWhereVectorSimilarTo(column as never, vector, minSimilarity))
  }

  unsafeOrderBy(sql: string, bindings: readonly unknown[]): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.clone(this.tableQuery.unsafeOrderBy(sql, bindings))
  }

  with<TPaths extends readonly ModelRelationPath<TRelations>[]>(...relations: TPaths): ModelQueryBuilder<TTable, TRelations, TLoaded & ResolveEagerLoads<TRelations, TPaths>>
  with<TPath extends ModelRelationPath<TRelations>>(relation: TPath, constraint: RelationConstraint): ModelQueryBuilder<TTable, TRelations, TLoaded & ResolveEagerLoads<TRelations, readonly [TPath]>>
  with(relations: Readonly<Partial<Record<ModelRelationPath<TRelations>, RelationConstraint>>>): ModelQueryBuilder<TTable, TRelations, TLoaded>
  with(
    first: ModelRelationPath<TRelations> | Readonly<Partial<Record<ModelRelationPath<TRelations>, RelationConstraint>>>,
    second?: ModelRelationPath<TRelations> | RelationConstraint,
    ...rest: readonly ModelRelationPath<TRelations>[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- return type varies per overload
  ): ModelQueryBuilder<TTable, TRelations, any> {
    const specs = this.normalizeEagerLoads(first, second, rest)
    return new ModelQueryBuilder<TTable, TRelations, TLoaded>(
      this.repository,
      this.tableQuery,
      this.mergeEagerLoads(specs),
      this.relationFilters,
    )
  }

  has(relation: ModelRelationPath<TRelations>): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.withRelationFilter({ relation, negate: false, boolean: 'and' })
  }

  orHas(relation: ModelRelationPath<TRelations>): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.withRelationFilter({ relation, negate: false, boolean: 'or' })
  }

  whereHas(
    relation: ModelRelationPath<TRelations>,
    constraint?: RelationConstraint,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.withRelationFilter({ relation, negate: false, constraint, boolean: 'and' })
  }

  orWhereHas(
    relation: ModelRelationPath<TRelations>,
    constraint?: RelationConstraint,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.withRelationFilter({ relation, negate: false, constraint, boolean: 'or' })
  }

  doesntHave(relation: ModelRelationPath<TRelations>): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.withRelationFilter({ relation, negate: true, boolean: 'and' })
  }

  orDoesntHave(relation: ModelRelationPath<TRelations>): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.withRelationFilter({ relation, negate: true, boolean: 'or' })
  }

  whereDoesntHave(
    relation: ModelRelationPath<TRelations>,
    constraint?: RelationConstraint,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.withRelationFilter({ relation, negate: true, constraint, boolean: 'and' })
  }

  orWhereDoesntHave(
    relation: ModelRelationPath<TRelations>,
    constraint?: RelationConstraint,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.withRelationFilter({ relation, negate: true, constraint, boolean: 'or' })
  }

  whereRelation<TRelationPath extends ModelRelationPath<TRelations>>(
    relation: TRelationPath,
    column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>,
    operator: unknown,
    value?: unknown,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.whereHas(relation, query => query.where(column, operator, value))
  }

  orWhereRelation<TRelationPath extends ModelRelationPath<TRelations>>(
    relation: TRelationPath,
    column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>,
    operator: unknown,
    value?: unknown,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.orWhereHas(relation, query => query.where(column, operator, value))
  }

  whereMorphRelation<TRelationPath extends ModelRelationPath<TRelations>>(
    relation: TRelationPath,
    types: string | { definition?: { morphClass?: string } } | readonly (string | { definition?: { morphClass?: string } })[],
    column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>,
    operator: unknown,
    value?: unknown,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    this.assertMorphToRelation(relation)
    return this.withRelationFilter({
      relation,
      negate: false,
      boolean: 'and',
      morphTypes: this.normalizeMorphTypes(types),
      constraint: query => query.where(column, operator, value),
    })
  }

  orWhereMorphRelation<TRelationPath extends ModelRelationPath<TRelations>>(
    relation: TRelationPath,
    types: string | { definition?: { morphClass?: string } } | readonly (string | { definition?: { morphClass?: string } })[],
    column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>,
    operator: unknown,
    value?: unknown,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    this.assertMorphToRelation(relation)
    return this.withRelationFilter({
      relation,
      negate: false,
      boolean: 'or',
      morphTypes: this.normalizeMorphTypes(types),
      constraint: query => query.where(column, operator, value),
    })
  }

  whereBelongsTo<TRelated extends TableDefinition>(
    relatedEntity: Entity<TRelated>,
    relationName?: ModelRelationPath<TRelations>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    const relation = this.resolveBelongsToRelation(relatedEntity, relationName)
    const ownerValue = relatedEntity.get(relation.ownerKey as never)

    return ownerValue === null || typeof ownerValue === 'undefined'
      ? this.whereDoesntHave(this.resolveBelongsToRelationName(relatedEntity, relationName))
      : this.whereHas(
          this.resolveBelongsToRelationName(relatedEntity, relationName),
          query => query.where(relation.ownerKey, ownerValue),
        )
  }

  orWhereBelongsTo<TRelated extends TableDefinition>(
    relatedEntity: Entity<TRelated>,
    relationName?: ModelRelationPath<TRelations>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    const relation = this.resolveBelongsToRelation(relatedEntity, relationName)
    const ownerValue = relatedEntity.get(relation.ownerKey as never)

    return ownerValue === null || typeof ownerValue === 'undefined'
      ? this.orWhereDoesntHave(this.resolveBelongsToRelationName(relatedEntity, relationName))
      : this.orWhereHas(
          this.resolveBelongsToRelationName(relatedEntity, relationName),
          query => query.where(relation.ownerKey, ownerValue),
        )
  }

  whereMorphedTo(
    relation: ModelRelationPath<TRelations>,
    target: MorphTypeSelector,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.applyMorphedToFilter(relation, target, false, 'and')
  }

  orWhereMorphedTo(
    relation: ModelRelationPath<TRelations>,
    target: MorphTypeSelector,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.applyMorphedToFilter(relation, target, false, 'or')
  }

  whereNotMorphedTo(
    relation: ModelRelationPath<TRelations>,
    target: MorphTypeSelector,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.applyMorphedToFilter(relation, target, true, 'and')
  }

  orWhereNotMorphedTo(
    relation: ModelRelationPath<TRelations>,
    target: MorphTypeSelector,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.applyMorphedToFilter(relation, target, true, 'or')
  }

  withWhereHas<TPath extends ModelRelationPath<TRelations>>(
    relation: TPath,
    constraint?: RelationConstraint,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded & ResolveEagerLoads<TRelations, readonly [TPath]>> {
    return (constraint
      ? this.whereHas(relation, constraint).with(relation, constraint)
      : this.whereHas(relation).with(relation)) as ModelQueryBuilder<TTable, TRelations, TLoaded & ResolveEagerLoads<TRelations, readonly [TPath]>>
  }

  withCount(...relations: readonly ModelRelationPath<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded>
  withCount(relations: Readonly<Partial<Record<ModelRelationPath<TRelations>, RelationConstraint>>>): ModelQueryBuilder<TTable, TRelations, TLoaded>
  withCount(
    first: ModelRelationPath<TRelations> | Readonly<Partial<Record<ModelRelationPath<TRelations>, RelationConstraint>>>,
    ...rest: readonly ModelRelationPath<TRelations>[]
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.withAggregateLoads(this.normalizeAggregateLoads('count', first, rest))
  }

  withExists(...relations: readonly ModelRelationPath<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded>
  withExists(relations: Readonly<Partial<Record<ModelRelationPath<TRelations>, RelationConstraint>>>): ModelQueryBuilder<TTable, TRelations, TLoaded>
  withExists(
    first: ModelRelationPath<TRelations> | Readonly<Partial<Record<ModelRelationPath<TRelations>, RelationConstraint>>>,
    ...rest: readonly ModelRelationPath<TRelations>[]
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.withAggregateLoads(this.normalizeAggregateLoads('exists', first, rest))
  }

  withSum<TRelationPath extends ModelRelationPath<TRelations>>(first: TRelationPath | Readonly<Partial<Record<ModelRelationPath<TRelations>, RelationConstraint>>>, column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>, ...rest: readonly ModelRelationPath<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.withAggregateLoads(this.normalizeColumnAggregateLoads('sum', first, column, rest))
  }

  withAvg<TRelationPath extends ModelRelationPath<TRelations>>(first: TRelationPath | Readonly<Partial<Record<ModelRelationPath<TRelations>, RelationConstraint>>>, column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>, ...rest: readonly ModelRelationPath<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.withAggregateLoads(this.normalizeColumnAggregateLoads('avg', first, column, rest))
  }

  withMin<TRelationPath extends ModelRelationPath<TRelations>>(first: TRelationPath | Readonly<Partial<Record<ModelRelationPath<TRelations>, RelationConstraint>>>, column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>, ...rest: readonly ModelRelationPath<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.withAggregateLoads(this.normalizeColumnAggregateLoads('min', first, column, rest))
  }

  withMax<TRelationPath extends ModelRelationPath<TRelations>>(first: TRelationPath | Readonly<Partial<Record<ModelRelationPath<TRelations>, RelationConstraint>>>, column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>, ...rest: readonly ModelRelationPath<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return this.withAggregateLoads(this.normalizeColumnAggregateLoads('max', first, column, rest))
  }

  toSQL() {
    return this.tableQuery.toSQL()
  }

  debug() {
    return this.tableQuery.debug()
  }

  dump(): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    this.tableQuery.dump()
    return this
  }

  async get(): Promise<ModelCollection<TTable, TRelations> & Array<EntityWithLoaded<TTable, TRelations, TLoaded>>> {
    const rows = await this.tableQuery.get<ModelRecord<TTable>>()
    const hasQueryCasts = Object.keys(this.queryCasts).length > 0
    let entities = await Promise.all(
      rows.map(row => (
        hasQueryCasts
          ? this.repository.retrieveWithCasts(row, this.queryCasts)
          : this.repository.retrieve(row)
      )),
    ) as unknown as Entity<TTable, TRelations>[]
    entities = await this.repository.filterByRelations(entities, this.relationFilters) as unknown as Entity<TTable, TRelations>[]
    this.repository.attachCollection(entities)
    await this.repository.loadRelations(entities, this.eagerLoads)
    await this.repository.loadRelationAggregates(entities, this.aggregateLoads)
    return this.repository.createCollection(entities) as ModelCollection<TTable, TRelations> & Array<EntityWithLoaded<TTable, TRelations, TLoaded>>
  }

  async first(): Promise<EntityWithLoaded<TTable, TRelations, TLoaded> | undefined> {
    const [entity] = await this.limit(1).get()
    return entity
  }

  async sole(): Promise<EntityWithLoaded<TTable, TRelations, TLoaded>> {
    const entities = await this.limit(2).get()
    if (entities.length === 0) {
      throw new ModelNotFoundException(this.repository.definition.name, `${this.repository.definition.name} query expected exactly one result but found 0.`)
    }
    if (entities.length !== 1) {
      throw new HydrationError(`${this.repository.definition.name} query expected exactly one result but found ${entities.length}.`)
    }

    return entities[0]!
  }

  async paginate(
    perPage = 15,
    page = 1,
    options: PaginationOptions = {},
  ): Promise<PaginatedResult<EntityWithLoaded<TTable, TRelations, TLoaded>>> {
    this.assertPositiveInteger(perPage, 'Per-page value')
    this.assertPositiveInteger(page, 'Page')
    const pageName = this.normalizePaginationParameterName(options.pageName, 'page')

    const entities = await this.getUnpaginatedEntities()
    const total = entities.length
    const offset = (page - 1) * perPage
    const data = entities.slice(offset, offset + perPage)
    const from = data.length === 0 ? null : offset + 1
    const to = data.length === 0 ? null : offset + data.length

    return createPaginator(this.repository.createCollection(data), {
      total,
      perPage,
      pageName,
      currentPage: page,
      lastPage: Math.max(1, Math.ceil(total / perPage)),
      from,
      to,
      hasMorePages: offset + data.length < total,
    }) as PaginatedResult<EntityWithLoaded<TTable, TRelations, TLoaded>>
  }

  async simplePaginate(
    perPage = 15,
    page = 1,
    options: PaginationOptions = {},
  ): Promise<SimplePaginatedResult<EntityWithLoaded<TTable, TRelations, TLoaded>>> {
    this.assertPositiveInteger(perPage, 'Per-page value')
    this.assertPositiveInteger(page, 'Page')
    const pageName = this.normalizePaginationParameterName(options.pageName, 'page')

    const entities = await this.getUnpaginatedEntities()
    const offset = (page - 1) * perPage
    const pageEntities = entities.slice(offset, offset + perPage + 1)
    const hasMorePages = pageEntities.length > perPage
    const data = hasMorePages ? pageEntities.slice(0, perPage) : pageEntities
    const from = data.length === 0 ? null : offset + 1
    const to = data.length === 0 ? null : offset + data.length

    return createSimplePaginator(this.repository.createCollection(data), {
      perPage,
      pageName,
      currentPage: page,
      from,
      to,
      hasMorePages,
    }) as SimplePaginatedResult<EntityWithLoaded<TTable, TRelations, TLoaded>>
  }

  async cursorPaginate(
    perPage = 15,
    cursor: string | null = null,
    options: CursorPaginationOptions = {},
  ): Promise<CursorPaginatedResult<EntityWithLoaded<TTable, TRelations, TLoaded>>> {
    this.assertPositiveInteger(perPage, 'Per-page value')
    const cursorName = this.normalizePaginationParameterName(options.cursorName, 'cursor')
    const offset = this.decodeCursor(cursor)
    const orderedQuery = this.prepareCursorPaginationQuery()
    const entities = await orderedQuery.getUnpaginatedEntities()
    const pageEntities = entities.slice(offset, offset + perPage + 1)
    const hasMorePages = pageEntities.length > perPage
    const data = hasMorePages ? pageEntities.slice(0, perPage) : pageEntities

    return createCursorPaginator(this.repository.createCollection(data), {
      perPage,
      cursorName,
      nextCursor: hasMorePages ? this.encodeCursor(offset + perPage) : null,
      prevCursor: cursor,
    }) as CursorPaginatedResult<EntityWithLoaded<TTable, TRelations, TLoaded>>
  }

  async chunk(
    size: number,
    callback: (rows: readonly EntityWithLoaded<TTable, TRelations, TLoaded>[], page: number) => unknown | Promise<unknown>,
  ): Promise<void> {
    this.assertPositiveInteger(size, 'Chunk size')

    const entities = await this.getUnpaginatedEntities()
    let page = 1

    for (let index = 0; index < entities.length; index += size) {
      const result = await callback(entities.slice(index, index + size) as unknown as EntityWithLoaded<TTable, TRelations, TLoaded>[], page)
      if (result === false) {
        return
      }

      page += 1
    }
  }

  async chunkById(
    size: number,
    callback: (rows: readonly EntityWithLoaded<TTable, TRelations, TLoaded>[], page: number) => unknown | Promise<unknown>,
    column: ModelAttributeKey<TTable> = this.repository.definition.primaryKey,
  ): Promise<void> {
    this.assertPositiveInteger(size, 'Chunk size')

    const entities = await this.getUnpaginatedEntities()
    const sorted = [...entities].sort((left, right) => {
      const a = left.get(column as never)
      const b = right.get(column as never)
      return compareChunkValuesAscending(a, b)
    })

    let page = 1
    for (let index = 0; index < sorted.length; index += size) {
      const result = await callback(sorted.slice(index, index + size) as unknown as EntityWithLoaded<TTable, TRelations, TLoaded>[], page)
      if (result === false) {
        return
      }

      page += 1
    }
  }

  async chunkByIdDesc(
    size: number,
    callback: (rows: readonly EntityWithLoaded<TTable, TRelations, TLoaded>[], page: number) => unknown | Promise<unknown>,
    column: ModelAttributeKey<TTable> = this.repository.definition.primaryKey,
  ): Promise<void> {
    this.assertPositiveInteger(size, 'Chunk size')

    const entities = await this.getUnpaginatedEntities()
    const sorted = [...entities].sort((left, right) => {
      const a = left.get(column as never)
      const b = right.get(column as never)
      return compareChunkValuesDescending(a, b)
    })

    let page = 1
    for (let index = 0; index < sorted.length; index += size) {
      const result = await callback(sorted.slice(index, index + size) as unknown as EntityWithLoaded<TTable, TRelations, TLoaded>[], page)
      if (result === false) {
        return
      }

      page += 1
    }
  }

  async* lazy(size = 1000): AsyncGenerator<EntityWithLoaded<TTable, TRelations, TLoaded>, void, unknown> {
    this.assertPositiveInteger(size, 'Chunk size')

    const entities = await this.getUnpaginatedEntities()
    for (let index = 0; index < entities.length; index += size) {
      for (const entity of entities.slice(index, index + size)) {
        yield entity as unknown as EntityWithLoaded<TTable, TRelations, TLoaded>
      }
    }
  }

  async* cursor(): AsyncGenerator<EntityWithLoaded<TTable, TRelations, TLoaded>, void, unknown> {
    const entities = await this.getUnpaginatedEntities()
    for (const entity of entities) {
      yield entity as unknown as EntityWithLoaded<TTable, TRelations, TLoaded>
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

  async pluck<TColumn extends ModelAttributeKey<TTable>>(column: TColumn): Promise<Array<ModelRecord<TTable>[TColumn]>> {
    const entities = await this.get()
    return entities.map(entity => entity.get(column)) as Array<ModelRecord<TTable>[TColumn]>
  }

  async value<TColumn extends ModelAttributeKey<TTable>>(column: TColumn): Promise<ModelRecord<TTable>[TColumn] | undefined> {
    const entity = await this.first()
    return entity?.get(column)
  }

  async valueOrFail<TColumn extends ModelAttributeKey<TTable>>(column: TColumn): Promise<ModelRecord<TTable>[TColumn]> {
    const entity = await this.first()
    if (!entity) {
      throw new ModelNotFoundException(this.repository.definition.name, `${this.repository.definition.name} query returned no value for column "${column}".`)
    }

    const value = entity.get(column as never)
    if (typeof value === 'undefined') {
      throw new HydrationError(`${this.repository.definition.name} query returned no value for column "${column}".`)
    }

    return value
  }

  async soleValue<TColumn extends ModelAttributeKey<TTable>>(column: TColumn): Promise<ModelRecord<TTable>[TColumn]> {
    const entity = await this.sole()
    const value = entity.get(column as never)
    if (typeof value === 'undefined') {
      throw new HydrationError(`${this.repository.definition.name} query returned no value for column "${column}".`)
    }

    return value
  }

  async sum(column: ModelColumnName<TTable>): Promise<number> {
    const entities = await this.get()
    if (entities.length === 0) {
      return 0
    }

    return this.extractNumericValues(entities, column, 'sum').reduce((sum, value) => sum + value, 0)
  }

  async avg(column: ModelColumnName<TTable>): Promise<number | null> {
    const entities = await this.get()
    if (entities.length === 0) {
      return null
    }

    const values = this.extractNumericValues(entities, column, 'avg')
    return values.reduce((sum, value) => sum + value, 0) / values.length
  }

  async min(column: ModelColumnName<TTable>): Promise<number | null> {
    const entities = await this.get()
    if (entities.length === 0) {
      return null
    }

    return Math.min(...this.extractNumericValues(entities, column, 'min'))
  }

  async max(column: ModelColumnName<TTable>): Promise<number | null> {
    const entities = await this.get()
    if (entities.length === 0) {
      return null
    }

    return Math.max(...this.extractNumericValues(entities, column, 'max'))
  }

  async firstOrFail(): Promise<EntityWithLoaded<TTable, TRelations, TLoaded>> {
    const entity = await this.first()
    if (!entity) {
      throw new ModelNotFoundException(this.repository.definition.name)
    }

    return entity
  }

  async find(value: unknown, column?: string): Promise<EntityWithLoaded<TTable, TRelations, TLoaded> | undefined> {
    const key = (column ?? this.repository.definition.primaryKey) as ModelColumnName<TTable>
    return this.where(key, value).first()
  }

  async findOrFail(value: unknown, column?: string): Promise<EntityWithLoaded<TTable, TRelations, TLoaded>> {
    const entity = await this.find(value, column)
    if (!entity) {
      const key = typeof column === 'undefined' ? this.repository.definition.primaryKey : column
      throw new ModelNotFoundException(this.repository.definition.name, `${this.repository.definition.name} record not found for key "${String(value)}" via "${key}".`)
    }

    return entity
  }

  async update(values: Partial<ModelRecord<TTable>>): Promise<DriverExecutionResult> {
    return this.tableQuery.update(this.repository.sanitizeWritePayload(values, 'update'))
  }

  async updateJson(
    columnPath: ModelJsonColumnPath<TTable>,
    value: unknown,
  ): Promise<DriverExecutionResult> {
    return this.tableQuery.update(this.repository.sanitizeWritePayload({ [columnPath]: value } as Record<string, unknown>, 'update'))
  }

  async increment(
    column: ModelColumnName<TTable>,
    amount = 1,
    extraValues: Partial<ModelRecord<TTable>> = {},
  ): Promise<DriverExecutionResult> {
    return this.tableQuery.increment(
      column,
      amount,
      this.repository.sanitizeWritePayload(extraValues, 'update'),
    )
  }

  async decrement(
    column: ModelColumnName<TTable>,
    amount = 1,
    extraValues: Partial<ModelRecord<TTable>> = {},
  ): Promise<DriverExecutionResult> {
    return this.tableQuery.decrement(
      column,
      amount,
      this.repository.sanitizeWritePayload(extraValues, 'update'),
    )
  }

  async upsert(
    values: Partial<ModelRecord<TTable>> | readonly Partial<ModelRecord<TTable>>[],
    uniqueBy: readonly ModelColumnName<TTable>[],
    updateColumns: readonly ModelColumnName<TTable>[] = [],
  ): Promise<DriverExecutionResult> {
    const rows = (Array.isArray(values) ? values : [values]).map(value => (
      this.repository.sanitizeWritePayload(value, 'create')
    ))
    return this.tableQuery.upsert(rows, uniqueBy, updateColumns)
  }

  async delete(): Promise<DriverExecutionResult> {
    const deletedAtColumn = this.repository.getDeletedAtColumn()
    if (deletedAtColumn) {
      return this.withoutTrashed().getTableQueryBuilder().update({
        [deletedAtColumn]: new Date().toISOString(),
      })
    }

    return this.tableQuery.delete()
  }

  withTrashed(): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    const column = this.repository.getDeletedAtColumn()
    if (!column) return this

    return this.clone(
      this.tableQuery
        .withoutWhereNull(column as never)
        .withoutWhereNotNull(column as never),
    )
  }

  onlyTrashed(): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    const column = this.repository.getDeletedAtColumn()
    if (!column) return this

    return this.clone(
      this.tableQuery
        .withoutWhereNull(column as never)
        .withoutWhereNotNull(column as never)
        .whereNotNull(column as never),
    )
  }

  withoutTrashed(): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    const column = this.repository.getDeletedAtColumn()
    if (!column) return this

    return this.clone(
      this.tableQuery
        .withoutWhereNotNull(column as never)
        .withoutWhereNull(column as never)
        .whereNull(column as never),
    )
  }

  async restore(): Promise<number> {
    const entities = await this.get()
    for (const entity of entities) {
      await entity.restore()
    }
    return entities.length
  }

  async forceDelete(): Promise<number> {
    const entities = await this.withTrashed().get()
    for (const entity of entities) {
      await entity.forceDelete()
    }
    return entities.length
  }

  private clone(tableQuery: TableQueryBuilder<TTable, Record<string, unknown>>): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return new ModelQueryBuilder<TTable, TRelations, TLoaded>(
      this.repository,
      tableQuery,
      this.eagerLoads,
      this.relationFilters,
      this.aggregateLoads,
      this.queryCasts,
    )
  }

  private normalizeExistsSubquery<TSubTable extends TableDefinition>(
    subquery: SubqueryBuilder<TSubTable>,
  ): TableQueryBuilder<TableDefinition, Record<string, unknown>> {
    return subquery instanceof ModelQueryBuilder
      ? subquery.getTableQueryBuilder()
      : subquery
  }

  private withRelationFilter(filter: RelationFilter): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    return new ModelQueryBuilder<TTable, TRelations, TLoaded>(
      this.repository,
      this.repository.applyRelationExistenceFilter(this.tableQuery, filter),
      this.eagerLoads,
      Object.freeze([...this.relationFilters, filter]),
      this.aggregateLoads,
      this.queryCasts,
    )
  }

  private withAggregateLoads(specs: readonly AggregateLoad[]): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    const merged = new Map<string, AggregateLoad>()

    for (const load of [...this.aggregateLoads, ...specs]) {
      merged.set(`${load.kind}:${load.relation}:${load.column ?? ''}:${load.alias ?? ''}`, load)
    }

    return new ModelQueryBuilder<TTable, TRelations, TLoaded>(
      this.repository,
      this.tableQuery,
      this.eagerLoads,
      this.relationFilters,
      Object.freeze([...merged.values()]),
      this.queryCasts,
    )
  }

  private normalizeEagerLoads(
    first: ModelRelationPath<TRelations> | RelationConstraintMap<TRelations>,
    second?: ModelRelationPath<TRelations> | RelationConstraint,
    rest: readonly ModelRelationPath<TRelations>[] = [],
  ): readonly EagerLoad[] {
    if (typeof first === 'string') {
      if (typeof second === 'function') {
        return [{ relation: first, constraint: second }]
      }

      const additional = typeof second === 'string' ? [second, ...rest] : [...rest]
      return [first, ...additional].map(relation => ({ relation }))
    }

    return Object.entries(first).map(([relation, constraint]) => ({
      relation,
      constraint,
    }))
  }

  private mergeEagerLoads(specs: readonly EagerLoad[]): readonly EagerLoad[] {
    const merged = new Map<string, EagerLoad>()

    for (const load of [...this.eagerLoads, ...specs]) {
      merged.set(load.relation, load)
    }

    return Object.freeze([...merged.values()])
  }

  private normalizeAggregateLoads(
    kind: AggregateLoad['kind'],
    first: ModelRelationPath<TRelations> | RelationConstraintMap<TRelations>,
    rest: readonly ModelRelationPath<TRelations>[] = [],
  ): readonly AggregateLoad[] {
    if (typeof first === 'string') {
      return [first, ...rest].map((relation) => {
        const parsed = this.parseAggregateRelation(relation)
        return {
          relation: parsed.relation,
          kind,
          alias: parsed.alias,
        }
      })
    }

    return Object.entries(first).map(([relation, constraint]) => {
      const parsed = this.parseAggregateRelation(relation)
      return {
        relation: parsed.relation,
        kind,
        constraint,
        alias: parsed.alias,
      }
    })
  }

  private normalizeMorphTypes(
    input: string | { definition?: { morphClass?: string } } | readonly (string | { definition?: { morphClass?: string } })[],
  ): readonly string[] {
    const values = Array.isArray(input) ? input : [input]
    const labels = values.map((value) => {
      if (typeof value === 'string') {
        const normalized = value.trim()
        if (!normalized) {
          throw new HydrationError('Morph type labels cannot be empty.')
        }
        if (!resolveMorphSelector(normalized)) {
          throw new RelationError(`Unknown morph type selector "${normalized}" on model "${this.repository.definition.name}".`)
        }
        return normalized
      }

      const morphClass = value?.definition?.morphClass
      if (typeof morphClass !== 'string' || morphClass.trim().length === 0) {
        throw new RelationError(`Morph type selectors on model "${this.repository.definition.name}" must be strings or model references.`)
      }

      return morphClass.trim()
    })

    return Object.freeze([...new Set(labels)])
  }

  private applyMorphedToFilter(
    relationName: ModelRelationPath<TRelations>,
    target: MorphTypeSelector,
    negate: boolean,
    boolean: 'and' | 'or',
  ): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    this.assertMorphToRelation(relationName)

    if (target === null) {
      return this.withRelationFilter({
        relation: relationName,
        negate: !negate,
        boolean,
      })
    }

    const { morphTypes, constraint } = this.normalizeMorphedToTarget(target)
    return this.withRelationFilter({
      relation: relationName,
      negate,
      boolean,
      morphTypes,
      constraint,
    })
  }

  private normalizeMorphedToTarget(target: Exclude<MorphTypeSelector, null>): {
    readonly morphTypes: readonly string[]
    readonly constraint?: RelationConstraint
  } {
    if (typeof target === 'object' && target !== null && 'definition' in target && target.definition) {
      return {
        morphTypes: this.getMorphTargetLabels(target.definition),
      }
    }

    if (this.isMorphEntityTarget(target)) {
      if (!target.exists()) {
        throw new HydrationError('whereMorphedTo targets must be persisted entities.')
      }

      const repository = target.getRepository()
      const primaryKey = repository.definition.primaryKey
      const primaryValue = target.get(primaryKey as never)

      if (primaryValue === null || typeof primaryValue === 'undefined') {
        throw new HydrationError('whereMorphedTo targets must have a defined primary key value.')
      }

      return {
        morphTypes: this.getMorphTargetLabels(repository.definition),
        constraint: query => query.where(primaryKey, primaryValue),
      }
    }

    return {
      morphTypes: this.normalizeMorphTypes(target),
    }
  }

  private isMorphEntityTarget(target: Exclude<MorphTypeSelector, null>): target is MorphEntityTarget {
    return typeof target === 'object'
      && target !== null
      && 'exists' in target
      && typeof target.exists === 'function'
      && !('definition' in target)
      && 'getRepository' in target
      && typeof target.getRepository === 'function'
      && 'get' in target
      && typeof target.get === 'function'
  }

  private getMorphTargetLabels(definition: {
    morphClass?: string
    name?: string
    table?: {
      tableName?: string
    }
  }): readonly string[] {
    const labels = [
      definition.morphClass,
      definition.name,
      definition.table?.tableName,
    ]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map(value => value.trim())

    if (labels.length === 0) {
      throw new RelationError(`Morph type selectors on model "${this.repository.definition.name}" must be strings or model references.`)
    }

    return Object.freeze([...new Set(labels)])
  }

  private assertMorphToRelation(relationName: ModelRelationPath<TRelations>): void {
    const relation = this.repository.getRelationDefinition(relationName)
    if (relation.kind !== 'morphTo') {
      throw new RelationError(`Relation "${relationName}" on model "${this.repository.definition.name}" does not support morph relation queries.`)
    }
  }

  private normalizeColumnAggregateLoads(
    kind: Extract<AggregateLoad['kind'], 'sum' | 'avg' | 'min' | 'max'>,
    first: ModelRelationPath<TRelations> | RelationConstraintMap<TRelations>,
    column: string,
    rest: readonly ModelRelationPath<TRelations>[] = [],
  ): readonly AggregateLoad[] {
    return this.normalizeAggregateLoads(kind, first, rest).map(load => ({
      ...load,
      column,
    }))
  }

  private parseAggregateRelation(spec: string): { relation: string, alias?: string } {
    const [relationPart, aliasPart] = spec.split(/\s+as\s+/i)
    const relation = relationPart?.trim()
    const alias = aliasPart?.trim()

    if (!relation) {
      throw new HydrationError('Aggregate relation names cannot be empty.')
    }

    if (typeof aliasPart !== 'undefined' && !alias) {
      throw new HydrationError('Aggregate relation aliases cannot be empty.')
    }

    return alias ? { relation, alias } : { relation }
  }

  private resolveBelongsToRelation<TRelated extends TableDefinition>(
    relatedEntity: Entity<TRelated>,
    relationName?: ModelRelationPath<TRelations>,
  ): Extract<ReturnType<ModelRepository<TTable>['getRelationDefinition']>, { kind: 'belongsTo' }> {
    const resolvedName = this.resolveBelongsToRelationName(relatedEntity, relationName)
    const relation = this.repository.getRelationDefinition(resolvedName)

    if (relation.kind !== 'belongsTo') {
      throw new RelationError(`Relation "${resolvedName}" on model "${this.repository.definition.name}" is not a belongs-to relation.`)
    }

    return relation
  }

  private resolveBelongsToRelationName<TRelated extends TableDefinition>(
    relatedEntity: Entity<TRelated>,
    relationName?: ModelRelationPath<TRelations>,
  ): ModelRelationPath<TRelations> {
    if (relationName) {
      return relationName
    }

    const relatedDefinition = relatedEntity.getRepository().definition
    const candidates = Object.entries(this.repository.definition.relations)
      .filter(([, relation]) => relation.kind === 'belongsTo')
      .map(([name, relation]) => [name, relation as Extract<typeof relation, { kind: 'belongsTo' }>] as const)
      .filter(([, relation]) => {
        const ref = relation.related()
        const definition = 'definition' in ref ? ref.definition : ref
        return definition.table.tableName === relatedDefinition.table.tableName
      })
      .map(([name]) => name as ModelRelationPath<TRelations>)

    if (candidates.length === 1) {
      return candidates[0]!
    }

    if (candidates.length === 0) {
      throw new RelationError(
        `No belongs-to relation on model "${this.repository.definition.name}" matches related model "${relatedDefinition.name}".`,
      )
    }

    throw new RelationError(
      `Multiple belongs-to relations on model "${this.repository.definition.name}" match related model "${relatedDefinition.name}". Specify the relation name explicitly.`,
    )
  }

  private extractNumericValues(
    entities: readonly Entity<TTable>[],
    column: string,
    kind: 'sum' | 'avg' | 'min' | 'max',
  ): number[] {
    return entities.map((entity) => {
      const value = entity.get(column as never)
      if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new HydrationError(`Model aggregate "${kind}" requires numeric values for column "${column}".`)
      }

      return value
    })
  }

  private async getUnpaginatedEntities(): Promise<ModelCollection<TTable, TRelations> & Array<EntityWithLoaded<TTable, TRelations, TLoaded>>> {
    return this.clone(this.tableQuery.limit(undefined).offset(undefined)).get()
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
      throw new HydrationError('Cursor is malformed.')
    }
  }

  private assertPositiveInteger(value: number, kind: string): void {
    if (!Number.isInteger(value) || value <= 0) {
      throw new HydrationError(`${kind} must be a positive integer.`)
    }
  }

  private normalizePaginationParameterName(value: string | undefined, fallback: string): string {
    if (typeof value === 'undefined') {
      return fallback
    }

    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new HydrationError(
        `${fallback === 'cursor' ? 'Cursor' : 'Page'} parameter name must be a non-empty string.`,
      )
    }

    return value
  }

  private prepareCursorPaginationQuery(): ModelQueryBuilder<TTable, TRelations, TLoaded> {
    const plan = this.tableQuery.getPlan()
    if (plan.orderBy.some(orderBy => orderBy.kind === 'random')) {
      throw new HydrationError('Cursor pagination cannot use random ordering.')
    }

    if (plan.orderBy.length === 0) {
      return this.clone(this.tableQuery.orderBy(this.repository.definition.primaryKey as never))
    }

    return this
  }
}
