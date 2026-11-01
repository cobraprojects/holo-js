import { ConfigurationError, HydrationError, ModelNotFoundException, RelationError } from '../core/errors'
import {
  createDatabaseQueryObservation,
  disableDatabaseQueryObservationPatching,
  hasActiveDatabaseDependencyCollector,
  rebindDatabaseQueryObservationHydratedResult,
  rebindDatabaseQueryObservationAggregate,
  rebindDatabaseQueryObservationResult,
  rebindDatabaseQueryObservationScalar,
  rebindDatabaseQueryObservationScalarList,
  type DatabaseQueryBelongsToHydrationObservation,
  type DatabaseQueryRelatedHydrationObservation,
  type QueryCacheConfig,
  type QueryCacheTtlInput,
} from '../cache'
import {
  createCursorPaginator,
  createPaginator,
  createSimplePaginator,
} from '../query/paginator'
import {
  assertPositiveInteger,
  decodeValueCursor,
  normalizePaginationParameterName,
} from '../query/pagination'
import { queryBatches, visitRows } from '../query/traversal'
import { TableQueryBuilder } from '../query/TableQueryBuilder'
import { createAggregateValueCounts } from '../query/aggregateValueCounts'
import { resolveMorphSelector } from './morphRegistry'
import { modelNeedsSerialization } from './serialize'
import type { ModelCollection } from './collection'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { DriverExecutionResult } from '../core/types'
import type {
  CursorPaginatedResult,
  CursorPaginationOptions,
  PaginatedResult,
  PaginationMeta,
  PaginationOptions,
  SimplePaginatedResult,
  SimplePaginationMeta,
} from '../query/types'
import type { TableDefinition } from '../schema/types'
import type { Entity } from './Entity'
import type { EmptyScopeMap, ModelScopeMethods, ModelScopesDefinition } from './types'
import type {
  AggregateRelationConstraintMap,
  AggregateRelatedColumnNameOfKeys,
  EntityWithLoaded,
  ModelAttributeKey,
  ModelCastDefinition,
  ModelColumnName,
  ModelColumnReference,
  ModelJsonColumnPath,
  ModelDefinitionLike,
  ModelRecord,
  ModelRelationName,
  ModelRelationPath,
  ModelSelectableColumn,
  RelatedColumnNameForRelationPath,
  RelatedColumnNameOfRelation,
  RelationConstraintFor,
  RelationConstraintMapGuarded,
  RelationConstraintRecord,
  RelationNameConstraintRecord,
  RelationNameConstraintMapGuarded,
  RelationDefinition,
  RelationMap,
  ResolveEagerLoads,
  SerializedEntityWithLoaded,
} from './types'
import type { ModelRepository } from './ModelRepository'

type BuilderCallback<TBuilder> = (query: TBuilder) => unknown
type ValueBuilderCallback<TBuilder, TValue> = (query: TBuilder, value: TValue) => unknown
type RelationConstraint = (query: ModelQueryBuilder<TableDefinition>) => unknown
type QueryableModelReference = ModelDefinitionLike<TableDefinition> & {
  query(): ModelQueryBuilder<TableDefinition>
}
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
type MorphRelationTypeInput = string | MorphModelTarget | readonly (string | MorphModelTarget)[]
type MorphTypeSelector = string | MorphModelTarget | MorphEntityTarget | null
type EagerLoad = {
  relation: string
  constraint?: RelationConstraint
}
type RelationWithRelatedModel = Extract<RelationDefinition, { kind: 'belongsTo' | 'belongsToMany' | 'morphToMany' | 'morphedByMany' }>
const BELONGS_TO_RELATION_KINDS: readonly RelationDefinition['kind'][] = ['belongsTo']
const MANY_TO_MANY_RELATION_KINDS: readonly RelationDefinition['kind'][] = ['belongsToMany', 'morphToMany', 'morphedByMany']
type AggregateLoad = {
  relation: string
  kind: 'count' | 'exists' | 'sum' | 'avg' | 'min' | 'max'
  constraint?: RelationConstraint
  column?: string
  alias?: string
}
type TableQueryPredicates<TTable extends TableDefinition> =
  ReturnType<TableQueryBuilder<TTable, Record<string, unknown>>['getPlan']>['predicates']

export const whereIntegerKeysIn = Symbol('whereIntegerKeysIn')
export const withoutRelationLoads = Symbol('withoutRelationLoads')
export const loadRelationsOn = Symbol('loadRelationsOn')

type ModelScopeFunction = (query: object, ...args: readonly unknown[]) => unknown

const MODEL_QUERY_BUILDER_RESERVED_NAMES: readonly string[] = [
  'then',
  'repository',
  'tableQuery',
  'eagerLoads',
  'relationFilters',
  'aggregateLoads',
  'queryCasts',
  'scopePredicates',
  'softDeleteMode',
]

export function assertModelScopeNameAvailable(name: string): void {
  if (name in ModelQueryBuilderBase.prototype || MODEL_QUERY_BUILDER_RESERVED_NAMES.includes(name)) {
    throw new ConfigurationError(`Model scope "${name}" conflicts with a ModelQueryBuilder member of the same name.`)
  }
}

class ModelQueryBuilderBase<
  TTable extends TableDefinition = TableDefinition,
  TRelations extends RelationMap = RelationMap,
  TLoaded = unknown,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
> {
  constructor(
    private readonly repository: ModelRepository<TTable, TScopes>,
    private readonly tableQuery: TableQueryBuilder<TTable, Record<string, unknown>>,
    private readonly eagerLoads: readonly EagerLoad[] = [],
    private readonly relationFilters: readonly RelationFilter[] = [],
    private readonly aggregateLoads: readonly AggregateLoad[] = [],
    private readonly queryCasts: Readonly<Record<string, ModelCastDefinition>> = {},
    private readonly scopePredicates: TableQueryPredicates<TTable> = [],
    private readonly softDeleteMode: 'with' | 'without' | 'only' = 'with',
  ) {
    const scopes = this.repository.definition.scopes as Readonly<Record<string, ModelScopeFunction>>
    for (const [name, scope] of Object.entries(scopes)) {
      Object.defineProperty(this, name, {
        value: (...args: readonly unknown[]) => scope(this, ...args),
      })
    }
  }

  getConnection(): DatabaseContext {
    return this.tableQuery.getConnection()
  }

  getConnectionName(): string {
    return this.tableQuery.getConnectionName()
  }

  getTableQueryBuilder(): TableQueryBuilder<TTable, Record<string, unknown>> {
    const column = this.repository.getDeletedAtColumn()
    if (this.scopePredicates.length === 0 && (!column || this.softDeleteMode === 'with')) return this.tableQuery

    const predicates = this.tableQuery.getPlan().predicates
    let query = this.tableQuery.withPredicates([
      ...this.scopePredicates,
      ...(predicates.length > 0 ? [{ kind: 'group' as const, predicates }] : []),
    ])
    if (column && this.softDeleteMode !== 'with') {
      query = this.softDeleteMode === 'only' ? query.whereNotNull(column as never) : query.whereNull(column as never)
    }
    return query
  }

  applyGlobalScope(scope: (query: ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>) => ModelQueryBuilder<TTable, TRelations, TLoaded>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    const query = scope(this.asScopedBuilder())
    const predicates = query.tableQuery.getPlan().predicates
    return new ModelQueryBuilderBase<TTable, TRelations, TLoaded, TScopes>(
      this.repository,
      query.tableQuery.withPredicates([]),
      query.eagerLoads,
      query.relationFilters,
      query.aggregateLoads,
      query.queryCasts,
      [...query.scopePredicates, ...(predicates.length > 0 ? [{ kind: 'group' as const, predicates }] : [])],
      query.softDeleteMode,
    ) as ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  }

  private collectNestedPredicates(
    callback: BuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>>,
  ): TableQueryPredicates<TTable> {
    const nested = new ModelQueryBuilderBase<TTable, TRelations, TLoaded, TScopes>(
      this.repository,
      new TableQueryBuilder(this.repository.definition.table, this.getConnection()),
    ) as ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
    const callbackResult = callback(nested)
    const result = callbackResult instanceof ModelQueryBuilderBase ? callbackResult : nested
    return result.getTableQueryBuilder().getPlan().predicates
  }

  private replayNestedPredicates(
    query: TableQueryBuilder<TTable, Record<string, unknown>>,
    predicates: TableQueryPredicates<TTable>,
  ): TableQueryBuilder<TTable, Record<string, unknown>> {
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
  }

  from(table: string): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.from(table) as unknown as TableQueryBuilder<TTable, Record<string, unknown>>)
  }

  where(
    callback: BuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  where(column: ModelColumnName<TTable> | ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  where(
    columnOrCallback: ModelColumnName<TTable> | ModelJsonColumnPath<TTable> | BuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>>,
    operator?: unknown,
    value?: unknown,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    if (typeof columnOrCallback === 'function') {
      const predicates = this.collectNestedPredicates(columnOrCallback)
      if (predicates.length === 0) {
        return this.asScopedBuilder()
      }

      return this.clone(this.tableQuery.where(query => this.replayNestedPredicates(query, predicates)))
    }

    return this.clone(this.tableQuery.where(columnOrCallback as never, operator, value))
  }

  orWhere(
    callback: BuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  orWhere(column: ModelColumnName<TTable> | ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  orWhere(
    columnOrCallback: ModelColumnName<TTable> | ModelJsonColumnPath<TTable> | BuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>>,
    operator?: unknown,
    value?: unknown,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    if (typeof columnOrCallback === 'function') {
      const predicates = this.collectNestedPredicates(columnOrCallback)
      if (predicates.length === 0) {
        return this.asScopedBuilder()
      }

      return this.clone(this.tableQuery.orWhere(query => this.replayNestedPredicates(query, predicates)))
    }

    return this.clone(this.tableQuery.orWhere(columnOrCallback as never, operator, value))
  }

  whereNot(
    callback: BuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    const predicates = this.collectNestedPredicates(callback)
    if (predicates.length === 0) {
      return this.asScopedBuilder()
    }

    return this.clone(this.tableQuery.whereNot(query => this.replayNestedPredicates(query, predicates)))
  }

  orWhereNot(
    callback: BuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    const predicates = this.collectNestedPredicates(callback)
    if (predicates.length === 0) {
      return this.asScopedBuilder()
    }

    return this.clone(this.tableQuery.orWhereNot(query => this.replayNestedPredicates(query, predicates)))
  }

  whereExists<TSubTable extends TableDefinition>(
    subquery: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereExists(this.normalizeExistsSubquery(subquery)))
  }

  orWhereExists<TSubTable extends TableDefinition>(
    subquery: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereExists(this.normalizeExistsSubquery(subquery)))
  }

  whereNotExists<TSubTable extends TableDefinition>(
    subquery: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereNotExists(this.normalizeExistsSubquery(subquery)))
  }

  orWhereNotExists<TSubTable extends TableDefinition>(
    subquery: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereNotExists(this.normalizeExistsSubquery(subquery)))
  }

  whereSub<TSubTable extends TableDefinition>(
    column: ModelColumnName<TTable>,
    operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'in' | 'not in' | 'like',
    subquery: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereSub(column as never, operator, this.normalizeExistsSubquery(subquery)))
  }

  orWhereSub<TSubTable extends TableDefinition>(
    column: ModelColumnName<TTable>,
    operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'in' | 'not in' | 'like',
    subquery: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereSub(column as never, operator, this.normalizeExistsSubquery(subquery)))
  }

  whereInSub<TSubTable extends TableDefinition>(
    column: ModelColumnName<TTable>,
    subquery: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereInSub(column as never, this.normalizeExistsSubquery(subquery)))
  }

  whereNotInSub<TSubTable extends TableDefinition>(
    column: ModelColumnName<TTable>,
    subquery: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereNotInSub(column as never, this.normalizeExistsSubquery(subquery)))
  }

  whereKey(value: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    const key = this.repository.definition.primaryKey as ModelColumnName<TTable>
    return Array.isArray(value) ? this.whereIn(key, value) : this.where(key, value)
  }

  whereKeyNot(value: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    const key = this.repository.definition.primaryKey as ModelColumnName<TTable>
    return Array.isArray(value) ? this.whereNotIn(key, value) : this.where(key, '!=', value)
  }

  whereNull(column: ModelColumnName<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereNull(column as never))
  }

  orWhereNull(column: ModelColumnName<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereNull(column as never))
  }

  whereNotNull(column: ModelColumnName<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereNotNull(column as never))
  }

  orWhereNotNull(column: ModelColumnName<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereNotNull(column as never))
  }

  when<TValue>(
    value: TValue,
    callback: ValueBuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>, TValue>,
    defaultCallback?: ValueBuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>, TValue>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    if (value) {
      return this.resolveBuilder(callback(this.asScopedBuilder(), value))
    }

    return this.resolveBuilder(defaultCallback?.(this.asScopedBuilder(), value))
  }

  unless<TValue>(
    value: TValue,
    callback: ValueBuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>, TValue>,
    defaultCallback?: ValueBuilderCallback<ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>, TValue>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    if (!value) {
      return this.resolveBuilder(callback(this.asScopedBuilder(), value))
    }

    return this.resolveBuilder(defaultCallback?.(this.asScopedBuilder(), value))
  }

  orderByDesc(column: ModelColumnName<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orderByDesc(column as never))
  }

  orderBy(column: ModelColumnName<TTable>, direction: 'asc' | 'desc' = 'asc'): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orderBy(column as never, direction))
  }

  latest(column: ModelColumnName<TTable> = 'created_at' as ModelColumnName<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.latest(column as never))
  }

  oldest(column: ModelColumnName<TTable> = 'created_at' as ModelColumnName<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.oldest(column as never))
  }

  inRandomOrder(): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.inRandomOrder())
  }

  reorder(column?: ModelColumnName<TTable>, direction: 'asc' | 'desc' = 'asc'): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.reorder(column as never, direction))
  }

  lock(mode: 'update' | 'share'): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.lock(mode))
  }

  lockForUpdate(): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.lockForUpdate())
  }

  sharedLock(): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.sharedLock())
  }

  // Scope removal rebuilds the entire query from the repository because
  // there is no way to separate user-added eagerLoads / relationFilters /
  // aggregateLoads / queryCasts from those injected by the excluded scope.
  // TLoaded is dropped so the type does not claim relations are loaded when
  // the excluded scope may have been the one that added them.
  withoutGlobalScope(name: string): ModelQueryBuilder<TTable, TRelations, unknown, TScopes> {
    return this.repository.queryWithoutGlobalScope(name) as ModelQueryBuilder<TTable, TRelations, unknown, TScopes>
  }

  withoutGlobalScopes(names?: readonly string[]): ModelQueryBuilder<TTable, TRelations, unknown, TScopes> {
    return this.repository.queryWithoutGlobalScopes(names) as ModelQueryBuilder<TTable, TRelations, unknown, TScopes>
  }

  limit(value?: number): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.limit(value))
  }

  offset(value?: number): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.offset(value))
  }

  skip(value: number): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.offset(value)
  }

  take(value: number): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.limit(value)
  }

  forPage(page: number, perPage = 15): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.forPage(page, perPage))
  }

  select(...columns: readonly ModelSelectableColumn<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(
      (this.tableQuery as TableQueryBuilder<TableDefinition, Record<string, unknown>>).select(...columns) as TableQueryBuilder<TTable, Record<string, unknown>>,
    )
  }

  addSelect(...columns: readonly ModelSelectableColumn<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(
      (this.tableQuery as TableQueryBuilder<TableDefinition, Record<string, unknown>>).addSelect(...columns) as TableQueryBuilder<TTable, Record<string, unknown>>,
    )
  }

  selectSub<TSubTable extends TableDefinition>(
    query: SubqueryBuilder<TSubTable>,
    alias: string,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.selectSub(this.normalizeExistsSubquery(query), alias))
  }

  addSelectSub<TSubTable extends TableDefinition>(
    query: SubqueryBuilder<TSubTable>,
    alias: string,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.addSelectSub(this.normalizeExistsSubquery(query), alias))
  }

  distinct(): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.distinct())
  }

  withCasts(casts: Record<string, ModelCastDefinition>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return new ModelQueryBuilderBase<TTable, TRelations, TLoaded, TScopes>(
      this.repository,
      this.tableQuery,
      this.eagerLoads,
      this.relationFilters,
      this.aggregateLoads,
      Object.freeze({
        ...this.queryCasts,
        ...casts,
      }),
      this.scopePredicates,
      this.softDeleteMode,
    ) as ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  }

  whereColumn(column: ModelColumnReference<TTable>, compareTo: ModelColumnReference<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  whereColumn(column: ModelColumnReference<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like', compareTo: ModelColumnReference<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  whereColumn(column: ModelColumnReference<TTable>, operatorOrCompareTo: string, compareTo?: ModelColumnReference<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return typeof compareTo === 'undefined'
      ? this.clone(this.tableQuery.whereColumn(column as never, operatorOrCompareTo as never))
      : this.clone(this.tableQuery.whereColumn(column as never, operatorOrCompareTo as never, compareTo as never))
  }

  orWhereColumn(column: ModelColumnReference<TTable>, compareTo: ModelColumnReference<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  orWhereColumn(column: ModelColumnReference<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like', compareTo: ModelColumnReference<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  orWhereColumn(column: ModelColumnReference<TTable>, operatorOrCompareTo: string, compareTo?: ModelColumnReference<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return typeof compareTo === 'undefined'
      ? this.clone(this.tableQuery.orWhereColumn(column as never, operatorOrCompareTo as never))
      : this.clone(this.tableQuery.orWhereColumn(column as never, operatorOrCompareTo as never, compareTo as never))
  }

  whereIn<TSubTable extends TableDefinition>(column: ModelColumnName<TTable>, values: readonly unknown[] | SubqueryBuilder<TSubTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereIn(column as never, this.normalizeWhereInValues(values)))
  }

  orWhereIn<TSubTable extends TableDefinition>(column: ModelColumnName<TTable>, values: readonly unknown[] | SubqueryBuilder<TSubTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereIn(column as never, this.normalizeWhereInValues(values)))
  }

  [withoutRelationLoads](): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return new ModelQueryBuilderBase<TTable, TRelations, TLoaded, TScopes>(
      this.repository,
      this.tableQuery,
      [],
      this.relationFilters,
      [],
      this.queryCasts,
      this.scopePredicates,
      this.softDeleteMode,
    ) as ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  }

  async [loadRelationsOn](entities: readonly Entity<TTable, TRelations>[]): Promise<void> {
    await this.repository.loadRelations(entities, this.eagerLoads)
    await this.repository.loadRelationAggregates(entities, this.aggregateLoads)
    const collection = this.repository.createCollection(entities as Entity<TTable, TRelations>[]) as
      ModelCollection<TTable, TRelations, EntityWithLoaded<TTable, TRelations, TLoaded>, TScopes>
    this.recordCollectionRelationObservations(collection)
    this.recordCollectionRelationAggregateObservations(collection)
  }

  [whereIntegerKeysIn](values: readonly (number | bigint)[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.withPredicates([
      ...this.tableQuery.getPlan().predicates,
      { kind: 'integer-in', boolean: 'and', column: this.repository.definition.primaryKey, values },
    ]))
  }

  whereNotIn<TSubTable extends TableDefinition>(column: ModelColumnName<TTable>, values: readonly unknown[] | SubqueryBuilder<TSubTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereNotIn(column as never, this.normalizeWhereInValues(values)))
  }

  orWhereNotIn<TSubTable extends TableDefinition>(column: ModelColumnName<TTable>, values: readonly unknown[] | SubqueryBuilder<TSubTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereNotIn(column as never, this.normalizeWhereInValues(values)))
  }

  whereBetween(
    column: ModelColumnName<TTable>,
    range: readonly [unknown, unknown],
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereBetween(column as never, range))
  }

  orWhereBetween(
    column: ModelColumnName<TTable>,
    range: readonly [unknown, unknown],
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereBetween(column as never, range))
  }

  whereNotBetween(
    column: ModelColumnName<TTable>,
    range: readonly [unknown, unknown],
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereNotBetween(column as never, range))
  }

  orWhereNotBetween(
    column: ModelColumnName<TTable>,
    range: readonly [unknown, unknown],
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereNotBetween(column as never, range))
  }

  whereBetweenColumns(column: ModelColumnName<TTable>, columns: readonly [ModelColumnName<TTable>, ModelColumnName<TTable>]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereBetweenColumns(column as never, columns as never))
  }

  orWhereBetweenColumns(column: ModelColumnName<TTable>, columns: readonly [ModelColumnName<TTable>, ModelColumnName<TTable>]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereBetweenColumns(column as never, columns as never))
  }

  whereNotBetweenColumns(column: ModelColumnName<TTable>, columns: readonly [ModelColumnName<TTable>, ModelColumnName<TTable>]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereNotBetweenColumns(column as never, columns as never))
  }

  orWhereNotBetweenColumns(column: ModelColumnName<TTable>, columns: readonly [ModelColumnName<TTable>, ModelColumnName<TTable>]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereNotBetweenColumns(column as never, columns as never))
  }

  whereValueBetween(value: unknown, columns: readonly [ModelColumnName<TTable>, ModelColumnName<TTable>]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereValueBetween(value, columns as never))
  }

  orWhereValueBetween(value: unknown, columns: readonly [ModelColumnName<TTable>, ModelColumnName<TTable>]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereValueBetween(value, columns as never))
  }

  whereValueNotBetween(value: unknown, columns: readonly [ModelColumnName<TTable>, ModelColumnName<TTable>]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereValueNotBetween(value, columns as never))
  }

  orWhereValueNotBetween(value: unknown, columns: readonly [ModelColumnName<TTable>, ModelColumnName<TTable>]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereValueNotBetween(value, columns as never))
  }

  wherePast(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.wherePast(columns as never))
  }

  orWherePast(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWherePast(columns as never))
  }

  whereNowOrPast(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereNowOrPast(columns as never))
  }

  orWhereNowOrPast(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereNowOrPast(columns as never))
  }

  whereFuture(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereFuture(columns as never))
  }

  orWhereFuture(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereFuture(columns as never))
  }

  whereNowOrFuture(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereNowOrFuture(columns as never))
  }

  orWhereNowOrFuture(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereNowOrFuture(columns as never))
  }

  whereToday(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereToday(columns as never))
  }

  orWhereToday(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereToday(columns as never))
  }

  whereBeforeToday(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereBeforeToday(columns as never))
  }

  orWhereBeforeToday(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereBeforeToday(columns as never))
  }

  whereTodayOrBefore(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereTodayOrBefore(columns as never))
  }

  orWhereTodayOrBefore(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereTodayOrBefore(columns as never))
  }

  whereAfterToday(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereAfterToday(columns as never))
  }

  orWhereAfterToday(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereAfterToday(columns as never))
  }

  whereTodayOrAfter(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereTodayOrAfter(columns as never))
  }

  orWhereTodayOrAfter(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereTodayOrAfter(columns as never))
  }

  whereLike(column: ModelColumnName<TTable>, value: string, caseSensitive = false): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereLike(column as never, value, caseSensitive))
  }

  orWhereLike(column: ModelColumnName<TTable>, value: string, caseSensitive = false): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereLike(column as never, value, caseSensitive))
  }

  whereNotLike(column: ModelColumnName<TTable>, value: string, caseSensitive = false): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereNotLike(column as never, value, caseSensitive))
  }

  orWhereNotLike(column: ModelColumnName<TTable>, value: string, caseSensitive = false): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereNotLike(column as never, value, caseSensitive))
  }

  whereAny(columns: readonly ModelColumnName<TTable>[], operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereAny(columns as never, operator, value))
  }

  orWhereAny(columns: readonly ModelColumnName<TTable>[], operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereAny(columns as never, operator, value))
  }

  whereAll(columns: readonly ModelColumnName<TTable>[], operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereAll(columns as never, operator, value))
  }

  orWhereAll(columns: readonly ModelColumnName<TTable>[], operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereAll(columns as never, operator, value))
  }

  whereNone(columns: readonly ModelColumnName<TTable>[], operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereNone(columns as never, operator, value))
  }

  orWhereNone(columns: readonly ModelColumnName<TTable>[], operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereNone(columns as never, operator, value))
  }

  join(
    table: string,
    leftColumn: ModelColumnReference<TTable>,
    operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like',
    rightColumn: ModelColumnReference<TTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.join(table, leftColumn as never, operator, rightColumn as never))
  }

  leftJoin(
    table: string,
    leftColumn: ModelColumnReference<TTable>,
    operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like',
    rightColumn: ModelColumnReference<TTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.leftJoin(table, leftColumn as never, operator, rightColumn as never))
  }

  rightJoin(
    table: string,
    leftColumn: ModelColumnReference<TTable>,
    operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like',
    rightColumn: ModelColumnReference<TTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.rightJoin(table, leftColumn as never, operator, rightColumn as never))
  }

  crossJoin(table: string): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.crossJoin(table))
  }

  joinSub<TSubTable extends TableDefinition>(
    query: SubqueryBuilder<TSubTable>,
    alias: string,
    leftColumn: ModelColumnReference<TTable>,
    operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like',
    rightColumn: ModelColumnReference<TTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.joinSub(this.normalizeExistsSubquery(query), alias, leftColumn as never, operator, rightColumn as never))
  }

  leftJoinSub<TSubTable extends TableDefinition>(
    query: SubqueryBuilder<TSubTable>,
    alias: string,
    leftColumn: ModelColumnReference<TTable>,
    operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like',
    rightColumn: ModelColumnReference<TTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.leftJoinSub(this.normalizeExistsSubquery(query), alias, leftColumn as never, operator, rightColumn as never))
  }

  rightJoinSub<TSubTable extends TableDefinition>(
    query: SubqueryBuilder<TSubTable>,
    alias: string,
    leftColumn: ModelColumnReference<TTable>,
    operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like',
    rightColumn: ModelColumnReference<TTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.rightJoinSub(this.normalizeExistsSubquery(query), alias, leftColumn as never, operator, rightColumn as never))
  }

  joinLateral<TSubTable extends TableDefinition>(
    query: SubqueryBuilder<TSubTable>,
    alias: string,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.joinLateral(this.normalizeExistsSubquery(query), alias))
  }

  leftJoinLateral<TSubTable extends TableDefinition>(
    query: SubqueryBuilder<TSubTable>,
    alias: string,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.leftJoinLateral(this.normalizeExistsSubquery(query), alias))
  }

  union<TSubTable extends TableDefinition>(
    query: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.union(this.normalizeExistsSubquery(query)))
  }

  unionAll<TSubTable extends TableDefinition>(
    query: SubqueryBuilder<TSubTable>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.unionAll(this.normalizeExistsSubquery(query)))
  }

  groupBy(...columns: readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    const tableQuery = this.tableQuery as TableQueryBuilder<TTable, Record<string, unknown>> & {
      groupBy: (...args: readonly string[]) => TableQueryBuilder<TTable, Record<string, unknown>>
    }
    return this.clone(
      tableQuery.groupBy(...columns),
    )
  }

  having(expression: string, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.having(expression, operator, value))
  }

  havingBetween(expression: string, range: readonly [unknown, unknown]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.havingBetween(expression, range))
  }

  orHaving(expression: string, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orHaving(expression, operator, value))
  }

  orHavingBetween(expression: string, range: readonly [unknown, unknown]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orHavingBetween(expression, range))
  }

  havingNotBetween(expression: string, range: readonly [unknown, unknown]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.havingNotBetween(expression, range))
  }

  orHavingNotBetween(expression: string, range: readonly [unknown, unknown]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orHavingNotBetween(expression, range))
  }

  havingNull(expressions: string | readonly string[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.havingNull(expressions))
  }

  orHavingNull(expressions: string | readonly string[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orHavingNull(expressions))
  }

  havingNotNull(expressions: string | readonly string[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.havingNotNull(expressions))
  }

  orHavingNotNull(expressions: string | readonly string[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orHavingNotNull(expressions))
  }

  unsafeWhere(sql: string, bindings: readonly unknown[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.unsafeWhere(sql, bindings))
  }

  orUnsafeWhere(sql: string, bindings: readonly unknown[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orUnsafeWhere(sql, bindings))
  }

  whereDate(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereDate(column as never, operator, value))
  }

  orWhereDate(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereDate(column as never, operator, value))
  }

  whereMonth(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereMonth(column as never, operator, value))
  }

  orWhereMonth(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereMonth(column as never, operator, value))
  }

  whereDay(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereDay(column as never, operator, value))
  }

  orWhereDay(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereDay(column as never, operator, value))
  }

  whereYear(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereYear(column as never, operator, value))
  }

  orWhereYear(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereYear(column as never, operator, value))
  }

  whereTime(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereTime(column as never, operator, value))
  }

  orWhereTime(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereTime(column as never, operator, value))
  }

  whereJson(columnPath: ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereJson(columnPath as never, operator, value))
  }

  orWhereJson(columnPath: ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereJson(columnPath as never, operator, value))
  }

  whereJsonContains(columnPath: ModelJsonColumnPath<TTable>, value: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereJsonContains(columnPath as never, value))
  }

  orWhereJsonContains(columnPath: ModelJsonColumnPath<TTable>, value: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereJsonContains(columnPath as never, value))
  }

  whereJsonDoesntContain(columnPath: ModelJsonColumnPath<TTable>, value: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereJsonDoesntContain(columnPath as never, value))
  }

  orWhereJsonDoesntContain(columnPath: ModelJsonColumnPath<TTable>, value: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereJsonDoesntContain(columnPath as never, value))
  }

  whereJsonContainsKey(columnPath: ModelJsonColumnPath<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereJsonContainsKey(columnPath as never))
  }

  orWhereJsonContainsKey(columnPath: ModelJsonColumnPath<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereJsonContainsKey(columnPath as never))
  }

  whereJsonDoesntContainKey(columnPath: ModelJsonColumnPath<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereJsonDoesntContainKey(columnPath as never))
  }

  orWhereJsonDoesntContainKey(columnPath: ModelJsonColumnPath<TTable>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereJsonDoesntContainKey(columnPath as never))
  }

  whereJsonLength(columnPath: ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereJsonLength(columnPath as never, operator, value))
  }

  orWhereJsonLength(columnPath: ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereJsonLength(columnPath as never, operator, value))
  }

  whereFullText(
    columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[],
    value: string,
    options: { mode?: 'natural' | 'boolean' } = {},
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereFullText(columns as never, value, options))
  }

  orWhereFullText(
    columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[],
    value: string,
    options: { mode?: 'natural' | 'boolean' } = {},
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereFullText(columns as never, value, options))
  }

  whereVectorSimilarTo(
    column: ModelColumnName<TTable>,
    vector: readonly number[],
    minSimilarity = 0,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.whereVectorSimilarTo(column as never, vector, minSimilarity))
  }

  orWhereVectorSimilarTo(
    column: ModelColumnName<TTable>,
    vector: readonly number[],
    minSimilarity = 0,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.orWhereVectorSimilarTo(column as never, vector, minSimilarity))
  }

  unsafeOrderBy(sql: string, bindings: readonly unknown[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.unsafeOrderBy(sql, bindings))
  }

  with<TPaths extends readonly ModelRelationPath<TRelations>[]>(...relations: TPaths): ModelQueryBuilder<TTable, TRelations, TLoaded & ResolveEagerLoads<TRelations, TPaths>, TScopes>
  with<TPath extends ModelRelationPath<TRelations>>(relation: TPath, constraint: RelationConstraintFor<TRelations, TPath>): ModelQueryBuilder<TTable, TRelations, TLoaded & ResolveEagerLoads<TRelations, readonly [TPath]>, TScopes>
  with<TConstraints extends RelationConstraintMapGuarded<TRelations, TConstraints>>(relations: TConstraints): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  with<TPaths extends readonly ModelRelationPath<TRelations>[]>(relations: TPaths): ModelQueryBuilder<TTable, TRelations, TLoaded & ResolveEagerLoads<TRelations, TPaths>, TScopes>
  with(
    first: ModelRelationPath<TRelations> | RelationConstraintRecord<TRelations> | readonly ModelRelationPath<TRelations>[],
    second?: ModelRelationPath<TRelations> | RelationConstraint,
    ...rest: readonly ModelRelationPath<TRelations>[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- return type varies per overload
  ): ModelQueryBuilder<TTable, TRelations, any, TScopes> {
    const specs = this.normalizeEagerLoads(first, second, rest)
    return new ModelQueryBuilderBase<TTable, TRelations, TLoaded, TScopes>(
      this.repository,
      this.tableQuery,
      this.mergeEagerLoads(specs),
      this.relationFilters,
      this.aggregateLoads,
      this.queryCasts,
      this.scopePredicates,
      this.softDeleteMode,
    ) as ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  }

  has(relation: ModelRelationPath<TRelations>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.withRelationFilter({ relation, negate: false, boolean: 'and' })
  }

  orHas(relation: ModelRelationPath<TRelations>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.withRelationFilter({ relation, negate: false, boolean: 'or' })
  }

  whereHas<TPath extends ModelRelationPath<TRelations>>(
    relation: TPath,
    constraint?: RelationConstraintFor<TRelations, TPath>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  whereHas(relation: ModelRelationPath<TRelations>, constraint?: RelationConstraint): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.withRelationFilter({ relation, negate: false, constraint, boolean: 'and' })
  }

  orWhereHas<TPath extends ModelRelationPath<TRelations>>(
    relation: TPath,
    constraint?: RelationConstraintFor<TRelations, TPath>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  orWhereHas(relation: ModelRelationPath<TRelations>, constraint?: RelationConstraint): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.withRelationFilter({ relation, negate: false, constraint, boolean: 'or' })
  }

  doesntHave(relation: ModelRelationPath<TRelations>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.withRelationFilter({ relation, negate: true, boolean: 'and' })
  }

  orDoesntHave(relation: ModelRelationPath<TRelations>): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.withRelationFilter({ relation, negate: true, boolean: 'or' })
  }

  whereDoesntHave<TPath extends ModelRelationPath<TRelations>>(
    relation: TPath,
    constraint?: RelationConstraintFor<TRelations, TPath>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  whereDoesntHave(relation: ModelRelationPath<TRelations>, constraint?: RelationConstraint): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.withRelationFilter({ relation, negate: true, constraint, boolean: 'and' })
  }

  orWhereDoesntHave<TPath extends ModelRelationPath<TRelations>>(
    relation: TPath,
    constraint?: RelationConstraintFor<TRelations, TPath>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  orWhereDoesntHave(relation: ModelRelationPath<TRelations>, constraint?: RelationConstraint): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.withRelationFilter({ relation, negate: true, constraint, boolean: 'or' })
  }

  whereRelation<TRelationPath extends ModelRelationPath<TRelations>>(
    relation: TRelationPath,
    column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>,
    operator: unknown,
    value?: unknown,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.whereHas(relation, query => query.where(column, operator, value))
  }

  orWhereRelation<TRelationPath extends ModelRelationPath<TRelations>>(
    relation: TRelationPath,
    column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>,
    operator: unknown,
    value?: unknown,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.orWhereHas(relation, query => query.where(column, operator, value))
  }

  whereDoesntHaveRelation<TRelationPath extends ModelRelationPath<TRelations>>(
    relation: TRelationPath,
    column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>,
    operator: unknown,
    value?: unknown,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.whereDoesntHave(relation, query => query.where(column, operator, value))
  }

  orWhereDoesntHaveRelation<TRelationPath extends ModelRelationPath<TRelations>>(
    relation: TRelationPath,
    column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>,
    operator: unknown,
    value?: unknown,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.orWhereDoesntHave(relation, query => query.where(column, operator, value))
  }

  hasMorph(relation: ModelRelationPath<TRelations>, types: MorphRelationTypeInput): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyHasMorphFilter(relation, types, false, 'and')
  }

  orHasMorph(relation: ModelRelationPath<TRelations>, types: MorphRelationTypeInput): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyHasMorphFilter(relation, types, false, 'or')
  }

  doesntHaveMorph(relation: ModelRelationPath<TRelations>, types: MorphRelationTypeInput): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyHasMorphFilter(relation, types, true, 'and')
  }

  orDoesntHaveMorph(relation: ModelRelationPath<TRelations>, types: MorphRelationTypeInput): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyHasMorphFilter(relation, types, true, 'or')
  }

  whereHasMorph(relation: ModelRelationPath<TRelations>, types: MorphRelationTypeInput, constraint?: RelationConstraint): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyHasMorphFilter(relation, types, false, 'and', constraint)
  }

  orWhereHasMorph(relation: ModelRelationPath<TRelations>, types: MorphRelationTypeInput, constraint?: RelationConstraint): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyHasMorphFilter(relation, types, false, 'or', constraint)
  }

  whereDoesntHaveMorph(relation: ModelRelationPath<TRelations>, types: MorphRelationTypeInput, constraint?: RelationConstraint): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyHasMorphFilter(relation, types, true, 'and', constraint)
  }

  orWhereDoesntHaveMorph(relation: ModelRelationPath<TRelations>, types: MorphRelationTypeInput, constraint?: RelationConstraint): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyHasMorphFilter(relation, types, true, 'or', constraint)
  }

  whereMorphRelation<TRelationPath extends ModelRelationPath<TRelations>>(
    relation: TRelationPath,
    types: MorphRelationTypeInput,
    column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>,
    operator: unknown,
    value?: unknown,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyMorphRelationFilter(relation, types, column, operator, value, 'and')
  }

  orWhereMorphRelation<TRelationPath extends ModelRelationPath<TRelations>>(
    relation: TRelationPath,
    types: MorphRelationTypeInput,
    column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>,
    operator: unknown,
    value?: unknown,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyMorphRelationFilter(relation, types, column, operator, value, 'or')
  }

  whereMorphDoesntHaveRelation<TRelationPath extends ModelRelationPath<TRelations>>(
    relation: TRelationPath,
    types: MorphRelationTypeInput,
    column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>,
    operator: unknown,
    value?: unknown,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyHasMorphFilter(relation, types, true, 'and', query => query.where(column, operator, value))
  }

  orWhereMorphDoesntHaveRelation<TRelationPath extends ModelRelationPath<TRelations>>(
    relation: TRelationPath,
    types: MorphRelationTypeInput,
    column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>,
    operator: unknown,
    value?: unknown,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyHasMorphFilter(relation, types, true, 'or', query => query.where(column, operator, value))
  }

  whereBelongsTo<TRelated extends TableDefinition, TRelatedRelations extends RelationMap = RelationMap>(
    relatedEntity: Entity<TRelated, TRelatedRelations>,
    relationName?: ModelRelationPath<TRelations>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyBelongsToFilter(relatedEntity, relationName, 'and')
  }

  orWhereBelongsTo<TRelated extends TableDefinition, TRelatedRelations extends RelationMap = RelationMap>(
    relatedEntity: Entity<TRelated, TRelatedRelations>,
    relationName?: ModelRelationPath<TRelations>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyBelongsToFilter(relatedEntity, relationName, 'or')
  }

  whereAttachedTo<TRelated extends TableDefinition, TRelatedRelations extends RelationMap = RelationMap>(
    related: Entity<TRelated, TRelatedRelations> | readonly Entity<TRelated, TRelatedRelations>[],
    relationName?: ModelRelationPath<TRelations>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyAttachedToFilter(related, relationName, 'and')
  }

  orWhereAttachedTo<TRelated extends TableDefinition, TRelatedRelations extends RelationMap = RelationMap>(
    related: Entity<TRelated, TRelatedRelations> | readonly Entity<TRelated, TRelatedRelations>[],
    relationName?: ModelRelationPath<TRelations>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyAttachedToFilter(related, relationName, 'or')
  }

  whereMorphedTo(
    relation: ModelRelationPath<TRelations>,
    target: MorphTypeSelector,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyMorphedToFilter(relation, target, false, 'and')
  }

  orWhereMorphedTo(
    relation: ModelRelationPath<TRelations>,
    target: MorphTypeSelector,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyMorphedToFilter(relation, target, false, 'or')
  }

  whereNotMorphedTo(
    relation: ModelRelationPath<TRelations>,
    target: MorphTypeSelector,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyMorphedToFilter(relation, target, true, 'and')
  }

  orWhereNotMorphedTo(
    relation: ModelRelationPath<TRelations>,
    target: MorphTypeSelector,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyMorphedToFilter(relation, target, true, 'or')
  }

  withWhereHas<TPath extends ModelRelationPath<TRelations>>(
    relation: TPath,
    constraint?: RelationConstraintFor<TRelations, TPath>,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded & ResolveEagerLoads<TRelations, readonly [TPath]>, TScopes> {
    return (constraint
      ? this.whereHas(relation, constraint).with(relation, constraint)
      : this.whereHas(relation).with(relation)) as ModelQueryBuilder<TTable, TRelations, TLoaded & ResolveEagerLoads<TRelations, readonly [TPath]>, TScopes>
  }

  withCount(...relations: readonly ModelRelationName<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withCount<TConstraints extends RelationNameConstraintMapGuarded<TRelations, TConstraints>>(relations: TConstraints): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withCount(
    first: ModelRelationName<TRelations> | RelationNameConstraintRecord<TRelations>,
    ...rest: readonly ModelRelationName<TRelations>[]
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.withAggregateLoads(this.normalizeAggregateLoads('count', first, rest))
  }

  withExists(...relations: readonly ModelRelationName<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withExists<TConstraints extends RelationNameConstraintMapGuarded<TRelations, TConstraints>>(relations: TConstraints): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withExists(
    first: ModelRelationName<TRelations> | RelationNameConstraintRecord<TRelations>,
    ...rest: readonly ModelRelationName<TRelations>[]
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.withAggregateLoads(this.normalizeAggregateLoads('exists', first, rest))
  }

  withAggregate<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: '*', aggregate: 'count' | 'exists'): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withAggregate<TKey extends string>(relations: NoInfer<TKey> | AggregateRelationConstraintMap<TRelations, TKey>, column: '*', aggregate: 'count' | 'exists'): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withAggregate<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>, aggregate: 'sum' | 'avg' | 'min' | 'max'): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withAggregate<TKey extends string>(relations: NoInfer<TKey> | AggregateRelationConstraintMap<TRelations, TKey>, column: AggregateRelatedColumnNameOfKeys<TRelations, TKey>, aggregate: 'sum' | 'avg' | 'min' | 'max'): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withAggregate(first: ModelRelationName<TRelations> | RelationNameConstraintRecord<TRelations>, column: string, aggregate: AggregateLoad['kind']): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    if (aggregate !== 'count' && aggregate !== 'exists') {
      return this.withAggregateLoads(this.normalizeColumnAggregateLoads(aggregate, first, column))
    }

    if (column !== '*') {
      throw new RelationError(`withAggregate() ${aggregate} loads count related rows; pass '*' as the column instead of "${column}".`)
    }

    return this.withAggregateLoads(this.normalizeAggregateLoads(aggregate, first))
  }

  withSum<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>, ...rest: readonly ModelRelationName<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withSum<TKey extends string>(relations: NoInfer<TKey> | AggregateRelationConstraintMap<TRelations, TKey>, column: AggregateRelatedColumnNameOfKeys<TRelations, TKey>, ...rest: readonly ModelRelationName<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withSum<TRelationName extends ModelRelationName<TRelations>>(relations: TRelationName | { readonly [K in TRelationName]?: RelationConstraintFor<TRelations, K> }, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>, ...rest: readonly ModelRelationName<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withSum(first: ModelRelationName<TRelations> | RelationNameConstraintRecord<TRelations>, column: string, ...rest: readonly ModelRelationName<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.withAggregateLoads(this.normalizeColumnAggregateLoads('sum', first, column, rest))
  }

  withAvg<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>, ...rest: readonly ModelRelationName<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withAvg<TKey extends string>(relations: NoInfer<TKey> | AggregateRelationConstraintMap<TRelations, TKey>, column: AggregateRelatedColumnNameOfKeys<TRelations, TKey>, ...rest: readonly ModelRelationName<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withAvg<TRelationName extends ModelRelationName<TRelations>>(relations: TRelationName | { readonly [K in TRelationName]?: RelationConstraintFor<TRelations, K> }, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>, ...rest: readonly ModelRelationName<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withAvg(first: ModelRelationName<TRelations> | RelationNameConstraintRecord<TRelations>, column: string, ...rest: readonly ModelRelationName<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.withAggregateLoads(this.normalizeColumnAggregateLoads('avg', first, column, rest))
  }

  withMin<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>, ...rest: readonly ModelRelationName<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withMin<TKey extends string>(relations: NoInfer<TKey> | AggregateRelationConstraintMap<TRelations, TKey>, column: AggregateRelatedColumnNameOfKeys<TRelations, TKey>, ...rest: readonly ModelRelationName<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withMin<TRelationName extends ModelRelationName<TRelations>>(relations: TRelationName | { readonly [K in TRelationName]?: RelationConstraintFor<TRelations, K> }, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>, ...rest: readonly ModelRelationName<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withMin(first: ModelRelationName<TRelations> | RelationNameConstraintRecord<TRelations>, column: string, ...rest: readonly ModelRelationName<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.withAggregateLoads(this.normalizeColumnAggregateLoads('min', first, column, rest))
  }

  withMax<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>, ...rest: readonly ModelRelationName<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withMax<TKey extends string>(relations: NoInfer<TKey> | AggregateRelationConstraintMap<TRelations, TKey>, column: AggregateRelatedColumnNameOfKeys<TRelations, TKey>, ...rest: readonly ModelRelationName<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withMax<TRelationName extends ModelRelationName<TRelations>>(relations: TRelationName | { readonly [K in TRelationName]?: RelationConstraintFor<TRelations, K> }, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>, ...rest: readonly ModelRelationName<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  withMax(first: ModelRelationName<TRelations> | RelationNameConstraintRecord<TRelations>, column: string, ...rest: readonly ModelRelationName<TRelations>[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.withAggregateLoads(this.normalizeColumnAggregateLoads('max', first, column, rest))
  }

  toSQL() {
    return this.getTableQueryBuilder().toSQL()
  }

  toRawSql(): string {
    return this.getTableQueryBuilder().toRawSql()
  }

  debug() {
    return this.getTableQueryBuilder().debug()
  }

  dump(): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    this.getTableQueryBuilder().dump()
    return this.asScopedBuilder()
  }

  cache(
    config: QueryCacheTtlInput | QueryCacheConfig,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery.cache(config))
  }

  async get(): Promise<
    ModelCollection<TTable, TRelations, EntityWithLoaded<TTable, TRelations, TLoaded>, TScopes>
  > {
    const rows = await this.getTableQueryBuilder().get<ModelRecord<TTable>>()
    const collection = await this.hydrateRows(rows)
    this.recordCollectionRelationObservations(collection)
    this.recordCollectionRelationAggregateObservations(collection)
    this.rebindRowsToSerializedResult(rows, collection)
    return collection
  }

  private async hydrateRows(
    rows: readonly ModelRecord<TTable>[],
  ): Promise<ModelCollection<TTable, TRelations, EntityWithLoaded<TTable, TRelations, TLoaded>, TScopes>> {
    const hasQueryCasts = Object.keys(this.queryCasts).length > 0
    const entities = await Promise.all(
      rows.map(row => (
        hasQueryCasts
          ? this.repository.retrieveWithCasts(row, this.queryCasts)
          : this.repository.retrieve(row)
      )),
    ) as unknown as Entity<TTable, TRelations>[]
    this.repository.attachCollection(entities)
    await this.repository.loadRelations(entities, this.eagerLoads)
    await this.repository.loadRelationAggregates(entities, this.aggregateLoads)
    return this.repository.createCollection(entities as EntityWithLoaded<TTable, TRelations, TLoaded>[]) as
      ModelCollection<TTable, TRelations, EntityWithLoaded<TTable, TRelations, TLoaded>, TScopes>
  }

  async getJson(): Promise<SerializedEntityWithLoaded<TTable, TLoaded>[]> {
    const rows = await this.getTableQueryBuilder().get<ModelRecord<TTable>>()
    const collection = await this.hydrateRows(rows)
    this.recordCollectionRelationObservations(collection)
    this.recordCollectionRelationAggregateObservations(collection)
    const data = collection.toJSON() as SerializedEntityWithLoaded<TTable, TLoaded>[]
    this.rebindRowsToSerializedResult(rows, data)
    return data
  }

  async first(): Promise<EntityWithLoaded<TTable, TRelations, TLoaded> | undefined> {
    const query = this.limit(1)
    const { collection, rows } = await query.getRowsAndEntities()
    const entity = collection[0]
    query.recordSingleRelationObservations(entity)
    query.recordSingleRelationAggregateObservations(entity)
    query.rebindRowsToSerializedResult(rows, entity)
    return entity
  }

  async firstJson(): Promise<SerializedEntityWithLoaded<TTable, TLoaded> | undefined> {
    const query = this.limit(1)
    const { collection, rows } = await query.getRowsAndEntities()
    const data = collection[0]?.toJSON() as SerializedEntityWithLoaded<TTable, TLoaded> | undefined
    query.recordSingleRelationObservations(collection[0])
    query.recordSingleRelationAggregateObservations(collection[0])
    query.rebindRowsToSerializedResult(rows, data)
    return data
  }

  async sole(): Promise<EntityWithLoaded<TTable, TRelations, TLoaded>> {
    const query = this.limit(2)
    const { collection, rows } = await query.getRowsAndEntities()
    if (collection.length === 0) {
      throw new ModelNotFoundException(this.repository.definition.name, `${this.repository.definition.name} query expected exactly one result but found 0.`)
    }
    if (collection.length !== 1) {
      throw new HydrationError(`${this.repository.definition.name} query expected exactly one result but found ${collection.length}.`)
    }

    const entity = collection[0]!
    query.recordSingleRelationObservations(entity)
    query.recordSingleRelationAggregateObservations(entity)
    query.rebindRowsToSerializedResult(rows, entity)
    return entity
  }

  async soleJson(): Promise<SerializedEntityWithLoaded<TTable, TLoaded>> {
    const query = this.limit(2)
    const { collection, rows } = await query.getRowsAndEntities()
    if (collection.length === 0) {
      throw new ModelNotFoundException(this.repository.definition.name, `${this.repository.definition.name} query expected exactly one result but found 0.`)
    }
    if (collection.length !== 1) {
      throw new HydrationError(`${this.repository.definition.name} query expected exactly one result but found ${collection.length}.`)
    }

    const data = collection[0]!.toJSON() as SerializedEntityWithLoaded<TTable, TLoaded>
    query.recordSingleRelationObservations(collection[0])
    query.recordSingleRelationAggregateObservations(collection[0])
    query.rebindRowsToSerializedResult(rows, data)
    return data
  }

  async paginate(
    perPage = 15,
    page = 1,
    options: PaginationOptions = {},
  ): Promise<PaginatedResult<EntityWithLoaded<TTable, TRelations, TLoaded>>> {
    assertPositiveInteger(perPage, 'Per-page value', message => new HydrationError(message))
    assertPositiveInteger(page, 'Page', message => new HydrationError(message))
    normalizePaginationParameterName(options.pageName, 'page', message => new HydrationError(message))
    const { page: pagination, collection } = await this.paginatedPage(perPage, page, options)
    const result = createPaginator(collection, pagination.meta)
    this.rebindRowsToSerializedResult(pagination.data, result.data)
    rebindDatabaseQueryObservationResult(pagination.meta, result.meta)
    return result
  }

  async paginateJson(
    perPage = 15,
    page = 1,
    options: PaginationOptions = {},
  ): Promise<{ data: readonly SerializedEntityWithLoaded<TTable, TLoaded>[], meta: PaginationMeta }> {
    assertPositiveInteger(perPage, 'Per-page value', message => new HydrationError(message))
    assertPositiveInteger(page, 'Page', message => new HydrationError(message))
    normalizePaginationParameterName(options.pageName, 'page', message => new HydrationError(message))
    const { page: pagination, collection } = await this.paginatedPage(perPage, page, options)
    const data = collection.toJSON() as SerializedEntityWithLoaded<TTable, TLoaded>[]
    const result = createPaginator(data, pagination.meta).toJSON()
    this.rebindRowsToSerializedResult(pagination.data, result.data)
    rebindDatabaseQueryObservationResult(pagination.meta, result.meta)
    return result
  }

  private async paginatedPage(perPage: number, pageNumber: number, options: PaginationOptions) {
    const page = await this.getTableQueryBuilder().paginate<ModelRecord<TTable>>(perPage, pageNumber, options)
    const collection = await this.hydrateRows(page.data)
    this.recordPaginatedRelationObservations(collection)
    this.recordPaginatedRelationAggregateObservations(collection)
    return { page, collection }
  }

  async simplePaginate(
    perPage = 15,
    page = 1,
    options: PaginationOptions = {},
  ): Promise<SimplePaginatedResult<EntityWithLoaded<TTable, TRelations, TLoaded>>> {
    assertPositiveInteger(perPage, 'Per-page value', message => new HydrationError(message))
    assertPositiveInteger(page, 'Page', message => new HydrationError(message))
    normalizePaginationParameterName(options.pageName, 'page', message => new HydrationError(message))
    const { page: pagination, collection } = await this.simplePaginatedPage(perPage, page, options)
    const result = createSimplePaginator(collection, pagination.meta)
    this.rebindRowsToSerializedResult(pagination.data, result.data)
    rebindDatabaseQueryObservationResult(pagination.meta, result.meta)
    return result
  }

  async simplePaginateJson(
    perPage = 15,
    page = 1,
    options: PaginationOptions = {},
  ): Promise<{ data: readonly SerializedEntityWithLoaded<TTable, TLoaded>[], meta: SimplePaginationMeta }> {
    assertPositiveInteger(perPage, 'Per-page value', message => new HydrationError(message))
    assertPositiveInteger(page, 'Page', message => new HydrationError(message))
    normalizePaginationParameterName(options.pageName, 'page', message => new HydrationError(message))
    const { page: pagination, collection } = await this.simplePaginatedPage(perPage, page, options)
    const data = collection.toJSON() as SerializedEntityWithLoaded<TTable, TLoaded>[]
    const result = createSimplePaginator(data, pagination.meta).toJSON()
    this.rebindRowsToSerializedResult(pagination.data, result.data)
    rebindDatabaseQueryObservationResult(pagination.meta, result.meta)
    return result
  }

  private async simplePaginatedPage(perPage: number, pageNumber: number, options: PaginationOptions) {
    const page = await this.getTableQueryBuilder().simplePaginate<ModelRecord<TTable>>(perPage, pageNumber, options)
    const collection = await this.hydrateRows(page.data)
    this.recordPaginatedRelationObservations(collection)
    this.recordPaginatedRelationAggregateObservations(collection)
    return { page, collection }
  }

  async cursorPaginate(
    perPage = 15,
    cursor: string | null = null,
    options: CursorPaginationOptions = {},
  ): Promise<CursorPaginatedResult<EntityWithLoaded<TTable, TRelations, TLoaded>>> {
    const { page, collection } = await this.cursorPage(perPage, cursor, options)
    const result = createCursorPaginator(collection, page)
    this.rebindRowsToSerializedResult(page.data, result.data)
    return result
  }

  async cursorPaginateJson(
    perPage = 15,
    cursor: string | null = null,
    options: CursorPaginationOptions = {},
  ): Promise<{
    data: readonly SerializedEntityWithLoaded<TTable, TLoaded>[]
    perPage: number
    cursorName: string
    nextCursor: string | null
    prevCursor: string | null
  }> {
    const { page, collection } = await this.cursorPage(perPage, cursor, options)
    const data = collection.toJSON() as SerializedEntityWithLoaded<TTable, TLoaded>[]
    const result = createCursorPaginator(data, page).toJSON()
    this.rebindRowsToSerializedResult(page.data, result.data)
    return result
  }

  private async cursorPage(perPage: number, cursor: string | null, options: CursorPaginationOptions, hiddenColumns: readonly string[] = []) {
    assertPositiveInteger(perPage, 'Per-page value', message => new HydrationError(message))
    normalizePaginationParameterName(options.cursorName, 'cursor', message => new HydrationError(message))
    decodeValueCursor(cursor, message => new HydrationError(message))
    const query = this.tableQuery.getPlan().orderBy.length === 0
      ? this.getTableQueryBuilder().orderBy(this.repository.definition.primaryKey)
      : this.getTableQueryBuilder()
    const page = await query.cursorPaginate<ModelRecord<TTable>>(perPage, cursor, options)
    const rows = hiddenColumns.length === 0 ? page.data : page.data.map(row => {
      const attributes = { ...row }
      for (const column of hiddenColumns) delete attributes[column]
      return attributes
    })
    const collection = await this.hydrateRows(rows)
    this.recordPaginatedRelationObservations(collection)
    this.recordPaginatedRelationAggregateObservations(collection)
    return { page, collection }
  }

  async chunk(
    size: number,
    callback: (rows: readonly EntityWithLoaded<TTable, TRelations, TLoaded>[], page: number) => unknown | Promise<unknown>,
  ): Promise<void> {
    assertPositiveInteger(size, 'Chunk size', message => new HydrationError(message))

    let page = 1
    for await (const rows of queryBatches(this.getTableQueryBuilder(), size, {
      primaryKey: this.repository.definition.primaryKey,
    }, (rows: readonly ModelRecord<TTable>[]) => this.hydrateTraversalRows(rows))) {
      if (await callback(rows, page) === false) return
      page += 1
    }
  }

  async chunkById(
    size: number,
    callback: (rows: readonly EntityWithLoaded<TTable, TRelations, TLoaded>[], page: number) => unknown | Promise<unknown>,
    column: ModelAttributeKey<TTable> = this.repository.definition.primaryKey,
  ): Promise<void> {
    assertPositiveInteger(size, 'Chunk size', message => new HydrationError(message))

    return this.chunkIds(size, callback, column, 'asc')
  }

  async chunkByIdDesc(
    size: number,
    callback: (rows: readonly EntityWithLoaded<TTable, TRelations, TLoaded>[], page: number) => unknown | Promise<unknown>,
    column: ModelAttributeKey<TTable> = this.repository.definition.primaryKey,
  ): Promise<void> {
    assertPositiveInteger(size, 'Chunk size', message => new HydrationError(message))
    return this.chunkIds(size, callback, column, 'desc')
  }

  private async chunkIds(
    size: number,
    callback: (rows: readonly EntityWithLoaded<TTable, TRelations, TLoaded>[], page: number) => unknown | Promise<unknown>,
    column: ModelAttributeKey<TTable>,
    direction: 'asc' | 'desc',
  ): Promise<void> {
    let page = 1
    for await (const rows of this.idBatches(size, column, direction)) {
      if (await callback(rows, page) === false) return
      page += 1
    }
  }

  private idBatches(size: number, column: ModelAttributeKey<TTable>, direction: 'asc' | 'desc') {
    return queryBatches(this.getTableQueryBuilder(), size, {
      column,
      direction,
      fallbackOrder: direction === 'asc' ? 'database' : 'rows',
      primaryKey: this.repository.definition.primaryKey,
    }, (rows: readonly ModelRecord<TTable>[]) => this.hydrateTraversalRows(rows))
  }

  async each(
    callback: (entity: EntityWithLoaded<TTable, TRelations, TLoaded>, index: number) => unknown | Promise<unknown>,
    count = 1000,
  ): Promise<void> {
    await this.chunk(count, rows => visitRows(rows, callback))
  }

  async eachById(
    callback: (entity: EntityWithLoaded<TTable, TRelations, TLoaded>, index: number) => unknown | Promise<unknown>,
    count = 1000,
    column: ModelAttributeKey<TTable> = this.repository.definition.primaryKey,
  ): Promise<void> {
    await this.chunkById(count, rows => visitRows(rows, callback), column)
  }

  async* lazyById(
    size = 1000,
    column: ModelAttributeKey<TTable> = this.repository.definition.primaryKey,
  ): AsyncGenerator<EntityWithLoaded<TTable, TRelations, TLoaded>, void, unknown> {
    assertPositiveInteger(size, 'Chunk size', message => new HydrationError(message))
    for await (const rows of this.idBatches(size, column, 'asc')) {
      yield* rows
    }
  }

  async* lazyByIdDesc(
    size = 1000,
    column: ModelAttributeKey<TTable> = this.repository.definition.primaryKey,
  ): AsyncGenerator<EntityWithLoaded<TTable, TRelations, TLoaded>, void, unknown> {
    assertPositiveInteger(size, 'Chunk size', message => new HydrationError(message))
    for await (const rows of this.idBatches(size, column, 'desc')) {
      yield* rows
    }
  }

  private async hydrateTraversalRows(rows: readonly ModelRecord<TTable>[]) {
    const collection = await this.hydrateRows(rows)
    this.recordCollectionRelationObservations(collection)
    this.recordCollectionRelationAggregateObservations(collection)
    this.rebindRowsToSerializedResult(rows, collection)
    return collection
  }

  async* lazy(size = 1000): AsyncGenerator<EntityWithLoaded<TTable, TRelations, TLoaded>, void, unknown> {
    assertPositiveInteger(size, 'Chunk size', message => new HydrationError(message))

    for await (const rows of queryBatches(this.getTableQueryBuilder(), size, {
      primaryKey: this.repository.definition.primaryKey,
    }, (rows: readonly ModelRecord<TTable>[]) => this.hydrateTraversalRows(rows))) {
      yield* rows
    }
  }

  async* cursor(): AsyncGenerator<EntityWithLoaded<TTable, TRelations, TLoaded>, void, unknown> {
    yield* this.lazy()
  }

  async count(): Promise<number> {
    return this.getTableQueryBuilder().count()
  }

  async exists(): Promise<boolean> {
    return this.getTableQueryBuilder().exists()
  }

  async doesntExist(): Promise<boolean> {
    return this.getTableQueryBuilder().doesntExist()
  }

  async existsOr<TResult>(callback: () => TResult | Promise<TResult>): Promise<true | TResult> {
    return this.getTableQueryBuilder().existsOr(callback)
  }

  async doesntExistOr<TResult>(callback: () => TResult | Promise<TResult>): Promise<true | TResult> {
    return this.getTableQueryBuilder().doesntExistOr(callback)
  }

  async implode<TColumn extends ModelAttributeKey<TTable>>(column: TColumn, glue = ''): Promise<string> {
    return (await this.pluck(column)).join(glue)
  }

  async pluck<TColumn extends ModelAttributeKey<TTable>>(column: TColumn): Promise<Array<ModelRecord<TTable>[TColumn]>> {
    const plan = this.tableQuery.getPlan()
    const query = plan.distinct && plan.selections.length === 0
      ? this.clone(this.tableQuery.select(column))
      : this
    const { collection, rows } = await query.getRowsAndEntities()
    const result = collection.map(entity => entity.get(column)) as Array<ModelRecord<TTable>[TColumn]>
    rebindDatabaseQueryObservationScalarList(rows, result, column)
    return result
  }

  async value<TColumn extends ModelAttributeKey<TTable>>(column: TColumn): Promise<ModelRecord<TTable>[TColumn] | undefined> {
    const entity = await this.first()
    const value = entity?.get(column)
    rebindDatabaseQueryObservationScalar(entity, value, column)
    return value
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

    rebindDatabaseQueryObservationScalar(entity, value, column)
    return value
  }

  async soleValue<TColumn extends ModelAttributeKey<TTable>>(column: TColumn): Promise<ModelRecord<TTable>[TColumn]> {
    const entity = await this.sole()
    const value = entity.get(column as never)
    if (typeof value === 'undefined') {
      throw new HydrationError(`${this.repository.definition.name} query returned no value for column "${column}".`)
    }

    rebindDatabaseQueryObservationScalar(entity, value, column)
    return value
  }

  async sum(column: ModelColumnName<TTable>): Promise<number> {
    const entities = await this.get()
    if (entities.length === 0) {
      if (hasActiveDatabaseDependencyCollector()) {
        rebindDatabaseQueryObservationAggregate(entities, 0, Object.freeze({ column, kind: 'sum' }))
      }
      return 0
    }

    const result = this.extractNumericValues(entities, column, 'sum').reduce((sum, value) => sum + value, 0)
    if (hasActiveDatabaseDependencyCollector()) {
      rebindDatabaseQueryObservationAggregate(entities, result, Object.freeze({ column, kind: 'sum' }))
    }
    return result
  }

  average(column: ModelColumnName<TTable>): Promise<number | null> {
    return this.avg(column)
  }

  async avg(column: ModelColumnName<TTable>): Promise<number | null> {
    const entities = await this.get()
    if (entities.length === 0) {
      if (hasActiveDatabaseDependencyCollector()) {
        rebindDatabaseQueryObservationAggregate(entities, null, Object.freeze({ column, count: 0, kind: 'avg', sum: 0 }))
      }
      return null
    }

    const values = this.extractNumericValues(entities, column, 'avg')
    const sum = values.reduce((total, value) => total + value, 0)
    const result = values.length > 0 ? sum / values.length : null
    if (hasActiveDatabaseDependencyCollector()) {
      rebindDatabaseQueryObservationAggregate(entities, result, Object.freeze({ column, count: values.length, kind: 'avg', sum }))
    }
    return result
  }

  async min(column: ModelColumnName<TTable>): Promise<number | null> {
    const entities = await this.get()
    if (entities.length === 0) {
      if (hasActiveDatabaseDependencyCollector()) {
        rebindDatabaseQueryObservationAggregate(entities, null, Object.freeze({ column, kind: 'min' }))
      }
      return null
    }

    const values = this.extractNumericValues(entities, column, 'min')
    const result = values.length > 0 ? Math.min(...values) : null
    if (hasActiveDatabaseDependencyCollector()) {
      rebindDatabaseQueryObservationAggregate(entities, result, Object.freeze({
        column,
        currentValueCount: values.filter(value => value === result).length,
        kind: 'min',
        valueCounts: createAggregateValueCounts(values),
      }))
    }
    return result
  }

  async max(column: ModelColumnName<TTable>): Promise<number | null> {
    const entities = await this.get()
    if (entities.length === 0) {
      if (hasActiveDatabaseDependencyCollector()) {
        rebindDatabaseQueryObservationAggregate(entities, null, Object.freeze({ column, kind: 'max' }))
      }
      return null
    }

    const values = this.extractNumericValues(entities, column, 'max')
    const result = values.length > 0 ? Math.max(...values) : null
    if (hasActiveDatabaseDependencyCollector()) {
      rebindDatabaseQueryObservationAggregate(entities, result, Object.freeze({
        column,
        currentValueCount: values.filter(value => value === result).length,
        kind: 'max',
        valueCounts: createAggregateValueCounts(values),
      }))
    }
    return result
  }

  async firstOrFail(): Promise<EntityWithLoaded<TTable, TRelations, TLoaded>> {
    const entity = await this.first()
    if (!entity) {
      throw new ModelNotFoundException(this.repository.definition.name)
    }

    return entity
  }

  async findOr<TResult>(value: unknown, callback: () => TResult | Promise<TResult>): Promise<EntityWithLoaded<TTable, TRelations, TLoaded> | TResult> {
    return await this.find(value) ?? callback()
  }

  async firstOr<TResult>(callback: () => TResult | Promise<TResult>): Promise<EntityWithLoaded<TTable, TRelations, TLoaded> | TResult> {
    return await this.first() ?? callback()
  }

  async findOrNew(value: unknown): Promise<EntityWithLoaded<TTable, TRelations, TLoaded> | Entity<TTable, TRelations>> {
    return await this.find(value) ?? this.repository.make() as Entity<TTable, TRelations>
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

  async findOrFailJson(value: unknown, column?: string): Promise<SerializedEntityWithLoaded<TTable, TLoaded>> {
    return (await this.findOrFail(value, column)).toJSON() as SerializedEntityWithLoaded<TTable, TLoaded>
  }

  async update(values: Partial<ModelRecord<TTable>>): Promise<DriverExecutionResult> {
    return this.getTableQueryBuilder().update(this.repository.withWriteTimestamps(this.repository.sanitizeWritePayload(values, 'update'), 'update'))
  }

  async updateJson(
    columnPath: ModelJsonColumnPath<TTable>,
    value: unknown,
  ): Promise<DriverExecutionResult> {
    return this.getTableQueryBuilder().update(this.repository.withWriteTimestamps(this.repository.sanitizeWritePayload({ [columnPath]: value } as Record<string, unknown>, 'update'), 'update'))
  }

  async increment(
    column: ModelColumnName<TTable>,
    amount = 1,
    extraValues: Partial<ModelRecord<TTable>> = {},
  ): Promise<DriverExecutionResult> {
    return this.getTableQueryBuilder().increment(
      column,
      amount,
      this.repository.withWriteTimestamps(this.repository.sanitizeWritePayload(extraValues, 'update'), 'update'),
    )
  }

  async decrement(
    column: ModelColumnName<TTable>,
    amount = 1,
    extraValues: Partial<ModelRecord<TTable>> = {},
  ): Promise<DriverExecutionResult> {
    return this.getTableQueryBuilder().decrement(
      column,
      amount,
      this.repository.withWriteTimestamps(this.repository.sanitizeWritePayload(extraValues, 'update'), 'update'),
    )
  }

  async incrementEach(
    columns: Partial<Record<ModelColumnName<TTable>, number>>,
    extraValues: Partial<ModelRecord<TTable>> = {},
  ): Promise<DriverExecutionResult> {
    return this.getTableQueryBuilder().incrementEach(
      columns as Readonly<Record<string, number>>,
      this.repository.withWriteTimestamps(this.repository.sanitizeWritePayload(extraValues, 'update'), 'update'),
    )
  }

  async decrementEach(
    columns: Partial<Record<ModelColumnName<TTable>, number>>,
    extraValues: Partial<ModelRecord<TTable>> = {},
  ): Promise<DriverExecutionResult> {
    return this.getTableQueryBuilder().decrementEach(
      columns as Readonly<Record<string, number>>,
      this.repository.withWriteTimestamps(this.repository.sanitizeWritePayload(extraValues, 'update'), 'update'),
    )
  }

  async insertUsing<TSubTable extends TableDefinition>(
    columns: readonly ModelColumnName<TTable>[],
    query: SubqueryBuilder<TSubTable>,
  ): Promise<DriverExecutionResult> {
    return this.getTableQueryBuilder().insertUsing(columns as never, this.normalizeExistsSubquery(query))
  }

  async insertOrIgnoreUsing<TSubTable extends TableDefinition>(
    columns: readonly ModelColumnName<TTable>[],
    query: SubqueryBuilder<TSubTable>,
  ): Promise<DriverExecutionResult> {
    return this.getTableQueryBuilder().insertOrIgnoreUsing(columns as never, this.normalizeExistsSubquery(query))
  }

  async truncate(): Promise<void> {
    await this.getTableQueryBuilder().truncate()
  }

  async upsert(
    values: Partial<ModelRecord<TTable>> | readonly Partial<ModelRecord<TTable>>[],
    uniqueBy: readonly ModelColumnName<TTable>[],
    updateColumns: readonly ModelColumnName<TTable>[] = [],
  ): Promise<DriverExecutionResult> {
    const timestamp = new Date().toISOString()
    const rows = (Array.isArray(values) ? values : [values]).map(value => (
      this.repository.withWriteTimestamps(this.repository.sanitizeWritePayload(value, 'create'), 'create', timestamp)
    ))
    const { updatedAtColumn } = this.repository.definition
    const timestampedUpdateColumns = updatedAtColumn && updateColumns.length > 0 && !updateColumns.includes(updatedAtColumn as ModelColumnName<TTable>)
      ? [...updateColumns, updatedAtColumn as ModelColumnName<TTable>]
      : updateColumns
    return this.tableQuery.upsert(rows, uniqueBy, timestampedUpdateColumns)
  }

  async delete(): Promise<DriverExecutionResult> {
    const deletedAtColumn = this.repository.getDeletedAtColumn()
    if (deletedAtColumn) {
      const deletedAt = new Date().toISOString()
      return this.withoutTrashed().getTableQueryBuilder().update(
        this.repository.withWriteTimestamps({ [deletedAtColumn]: deletedAt }, 'update', deletedAt),
      )
    }

    return this.getTableQueryBuilder().delete()
  }

  withTrashed(): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery, 'with')
  }

  onlyTrashed(): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery, 'only')
  }

  withoutTrashed(): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.clone(this.tableQuery, 'without')
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

  private asScopedBuilder(): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this as ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  }

  private resolveBuilder(result: unknown): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return result instanceof ModelQueryBuilderBase ? result as ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> : this.asScopedBuilder()
  }

  private clone(tableQuery: TableQueryBuilder<TTable, Record<string, unknown>>, softDeleteMode = this.softDeleteMode): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return new ModelQueryBuilderBase<TTable, TRelations, TLoaded, TScopes>(
      this.repository,
      tableQuery,
      this.eagerLoads,
      this.relationFilters,
      this.aggregateLoads,
      this.queryCasts,
      this.scopePredicates,
      softDeleteMode,
    ) as ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  }

  private normalizeWhereInValues<TSubTable extends TableDefinition>(
    values: readonly unknown[] | SubqueryBuilder<TSubTable>,
  ): readonly unknown[] | TableQueryBuilder<TableDefinition, Record<string, unknown>> {
    return Array.isArray(values) ? values : this.normalizeExistsSubquery(values as SubqueryBuilder<TSubTable>)
  }

  private normalizeExistsSubquery<TSubTable extends TableDefinition>(
    subquery: SubqueryBuilder<TSubTable>,
  ): TableQueryBuilder<TableDefinition, Record<string, unknown>> {
    return subquery instanceof ModelQueryBuilderBase
      ? subquery.getTableQueryBuilder()
      : subquery
  }

  private withRelationFilter(filter: RelationFilter): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return new ModelQueryBuilderBase<TTable, TRelations, TLoaded, TScopes>(
      this.repository,
      this.repository.applyRelationExistenceFilter(this.tableQuery, filter),
      this.eagerLoads,
      Object.freeze([...this.relationFilters, filter]),
      this.aggregateLoads,
      this.queryCasts,
      this.scopePredicates,
      this.softDeleteMode,
    ) as ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  }

  private withAggregateLoads(specs: readonly AggregateLoad[]): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    const merged = new Map<string, AggregateLoad>()

    for (const load of [...this.aggregateLoads, ...specs]) {
      merged.set(`${load.kind}:${load.relation}:${load.column ?? ''}:${load.alias ?? ''}`, load)
    }

    return new ModelQueryBuilderBase<TTable, TRelations, TLoaded, TScopes>(
      this.repository,
      this.tableQuery,
      this.eagerLoads,
      this.relationFilters,
      Object.freeze([...merged.values()]),
      this.queryCasts,
      this.scopePredicates,
      this.softDeleteMode,
    ) as ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
  }

  private normalizeEagerLoads(
    first: ModelRelationPath<TRelations> | RelationConstraintRecord<TRelations> | readonly ModelRelationPath<TRelations>[],
    second?: ModelRelationPath<TRelations> | RelationConstraint,
    rest: readonly ModelRelationPath<TRelations>[] = [],
  ): readonly EagerLoad[] {
    if (Array.isArray(first)) {
      return first.map((relation) => ({ relation }))
    }

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
    first: ModelRelationName<TRelations> | RelationNameConstraintRecord<TRelations>,
    rest: readonly ModelRelationName<TRelations>[] = [],
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
    input: MorphRelationTypeInput,
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
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
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

  private applyMorphRelationFilter<TRelationPath extends ModelRelationPath<TRelations>>(
    relation: TRelationPath,
    types: MorphRelationTypeInput,
    column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>,
    operator: unknown,
    value: unknown,
    boolean: 'and' | 'or',
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    return this.applyHasMorphFilter(relation, types, false, boolean, query => query.where(column, operator, value))
  }

  private applyHasMorphFilter(
    relation: ModelRelationPath<TRelations>,
    types: MorphRelationTypeInput,
    negate: boolean,
    boolean: 'and' | 'or',
    constraint?: RelationConstraint,
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    this.assertMorphToRelation(relation)
    return this.withRelationFilter({
      relation,
      negate,
      boolean,
      morphTypes: this.normalizeMorphTypes(types),
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
    first: ModelRelationName<TRelations> | RelationNameConstraintRecord<TRelations>,
    column: string,
    rest: readonly ModelRelationName<TRelations>[] = [],
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

  private resolveBelongsToRelation<TRelated extends TableDefinition, TRelatedRelations extends RelationMap = RelationMap>(
    relatedEntity: Entity<TRelated, TRelatedRelations>,
    relationName?: ModelRelationPath<TRelations>,
  ): Extract<ReturnType<ModelRepository<TTable>['getRelationDefinition']>, { kind: 'belongsTo' }> {
    const resolvedName = this.resolveBelongsToRelationName(relatedEntity, relationName)
    const relation = this.repository.getRelationDefinition(resolvedName)

    if (relation.kind !== 'belongsTo') {
      throw new RelationError(`Relation "${resolvedName}" on model "${this.repository.definition.name}" is not a belongs-to relation.`)
    }

    return relation
  }

  private applyBelongsToFilter<TRelated extends TableDefinition, TRelatedRelations extends RelationMap = RelationMap>(
    relatedEntity: Entity<TRelated, TRelatedRelations>,
    relationName: ModelRelationPath<TRelations> | undefined,
    boolean: 'and' | 'or',
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    const resolvedRelationName = this.resolveBelongsToRelationName(relatedEntity, relationName)
    const relation = this.resolveBelongsToRelation(relatedEntity, resolvedRelationName)
    const ownerValue = relatedEntity.get(relation.ownerKey as never)

    if (ownerValue === null || typeof ownerValue === 'undefined') {
      return boolean === 'and'
        ? this.whereDoesntHave(resolvedRelationName)
        : this.orWhereDoesntHave(resolvedRelationName)
    }

    return boolean === 'and'
      ? this.withRelationFilter({ relation: resolvedRelationName, negate: false, constraint: query => query.where(relation.ownerKey, ownerValue), boolean: 'and' })
      : this.withRelationFilter({ relation: resolvedRelationName, negate: false, constraint: query => query.where(relation.ownerKey, ownerValue), boolean: 'or' })
  }

  private resolveBelongsToRelationName<TRelated extends TableDefinition, TRelatedRelations extends RelationMap = RelationMap>(
    relatedEntity: Entity<TRelated, TRelatedRelations>,
    relationName?: ModelRelationPath<TRelations>,
  ): ModelRelationPath<TRelations> {
    return relationName ?? this.inferRelationNameFor(relatedEntity, BELONGS_TO_RELATION_KINDS, 'belongs-to')
  }

  private inferRelationNameFor<TRelated extends TableDefinition, TRelatedRelations extends RelationMap = RelationMap>(
    relatedEntity: Entity<TRelated, TRelatedRelations>,
    kinds: readonly RelationDefinition['kind'][],
    label: string,
  ): ModelRelationPath<TRelations> {
    const relatedDefinition = relatedEntity.getRepository().definition
    const candidates = Object.entries(this.repository.definition.relations)
      .filter(([, relation]) => kinds.includes(relation.kind))
      .filter(([, relation]) => {
        const ref = (relation as RelationWithRelatedModel).related()
        const definition = 'definition' in ref ? ref.definition : ref
        return definition.table.tableName === relatedDefinition.table.tableName
      })
      .map(([name]) => name as ModelRelationPath<TRelations>)

    if (candidates.length === 1) {
      return candidates[0]!
    }

    if (candidates.length === 0) {
      throw new RelationError(
        `No ${label} relation on model "${this.repository.definition.name}" matches related model "${relatedDefinition.name}".`,
      )
    }

    throw new RelationError(
      `Multiple ${label} relations on model "${this.repository.definition.name}" match related model "${relatedDefinition.name}". Specify the relation name explicitly.`,
    )
  }

  private applyAttachedToFilter<TRelated extends TableDefinition, TRelatedRelations extends RelationMap = RelationMap>(
    related: Entity<TRelated, TRelatedRelations> | readonly Entity<TRelated, TRelatedRelations>[],
    relationName: ModelRelationPath<TRelations> | undefined,
    boolean: 'and' | 'or',
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes> {
    const entities = Array.isArray(related) ? related : [related as Entity<TRelated, TRelatedRelations>]
    const [first] = entities
    if (!first) {
      throw new RelationError('whereAttachedTo() requires at least one related model.')
    }

    const resolvedName = relationName ?? this.inferRelationNameFor(first, MANY_TO_MANY_RELATION_KINDS, 'many-to-many')
    if (!MANY_TO_MANY_RELATION_KINDS.includes(this.repository.getRelationDefinition(resolvedName).kind)) {
      throw new RelationError(`Relation "${resolvedName}" on model "${this.repository.definition.name}" is not a many-to-many relation.`)
    }

    const relatedKey = first.getRepository().definition.primaryKey
    const keys = entities.map(entity => entity.get(relatedKey as never))
    return this.withRelationFilter({
      relation: resolvedName,
      negate: false,
      boolean,
      constraint: query => query.whereIn(relatedKey as never, keys),
    })
  }

  private extractNumericValues(
    entities: readonly Entity<TTable>[],
    column: string,
    kind: 'sum' | 'avg' | 'min' | 'max',
  ): number[] {
    return entities.flatMap((entity) => {
      const value = entity.get(column as never)
      if (value === null) return []
      if (typeof value !== 'number' || Number.isNaN(value)) {
        throw new HydrationError(`Model aggregate "${kind}" requires numeric values for column "${column}".`)
      }

      return [value]
    })
  }

  private async getRowsAndEntities(): Promise<{
    readonly collection: ModelCollection<TTable, TRelations, EntityWithLoaded<TTable, TRelations, TLoaded>, TScopes>
    readonly rows: readonly ModelRecord<TTable>[]
  }> {
    const rows = await this.getTableQueryBuilder().get<ModelRecord<TTable>>()
    return {
      collection: await this.hydrateRows(rows),
      rows,
    }
  }

  private recordCollectionRelationAggregateObservations(
    collection: readonly Entity<TTable>[],
  ): void {
    this.repository.recordRelationAggregateObservations(
      collection,
      this.aggregateLoads,
      (index, key) => Object.freeze([index, key]),
    )
  }

  private recordCollectionRelationObservations(
    collection: readonly Entity<TTable>[],
  ): void {
    this.repository.recordRelationObservations(
      collection,
      this.eagerLoads,
      (index, relationName) => Object.freeze([index, relationName]),
    )
  }

  private recordSingleRelationObservations(
    entity: Entity<TTable> | undefined,
  ): void {
    if (!entity) {
      return
    }

    this.repository.recordRelationObservations(
      [entity],
      this.eagerLoads,
      (_index, relationName) => Object.freeze([relationName]),
    )
  }

  private recordPaginatedRelationObservations(
    collection: readonly Entity<TTable>[],
  ): void {
    this.repository.recordRelationObservations(
      collection,
      this.eagerLoads,
      (index, relationName) => Object.freeze(['data', index, relationName]),
    )
  }

  private recordSingleRelationAggregateObservations(
    entity: Entity<TTable> | undefined,
  ): void {
    if (!entity) {
      return
    }

    this.repository.recordRelationAggregateObservations(
      [entity],
      this.aggregateLoads,
      (_index, key) => Object.freeze([key]),
    )
  }

  private recordPaginatedRelationAggregateObservations(
    collection: readonly Entity<TTable>[],
  ): void {
    this.repository.recordRelationAggregateObservations(
      collection,
      this.aggregateLoads,
      (index, key) => Object.freeze(['data', index, key]),
    )
  }

  private canBindRowsToSerializedResultBase(): boolean {
    return !modelNeedsSerialization(this.repository.definition)
      && Object.keys(this.queryCasts).length === 0
      && this.relationFilters.length === 0
      && this.aggregateLoads.length === 0
  }

  private canBindRowsToSerializedResult(): boolean {
    return this.canBindRowsToSerializedResultBase()
      && this.eagerLoads.length === 0
  }

  private createPatchableEagerRelationHydrations(): {
    readonly belongsToHydrations?: readonly DatabaseQueryBelongsToHydrationObservation[]
    readonly relatedHydrations?: readonly DatabaseQueryRelatedHydrationObservation[]
  } | undefined {
    if (!this.canBindRowsToSerializedResultBase() || this.eagerLoads.length === 0) {
      return undefined
    }

    const belongsToHydrations: DatabaseQueryBelongsToHydrationObservation[] = []
    const relatedHydrations: DatabaseQueryRelatedHydrationObservation[] = []
    for (const load of this.eagerLoads) {
      if (load.relation.includes('.')) {
        return undefined
      }

      const relation = this.repository.getRelationDefinition(load.relation)
      if (relation.kind === 'belongsTo') {
        if (relation.constraint || load.constraint) {
          return undefined
        }

        const related = relation.related()
        const relatedDefinition = 'definition' in related ? related.definition : related
        if (modelNeedsSerialization(relatedDefinition)) {
          return undefined
        }

        belongsToHydrations.push(Object.freeze({
          foreignKey: relation.foreignKey,
          ownerKey: relation.ownerKey,
          relationKey: load.relation,
          relatedConnectionName: relatedDefinition.connectionName ?? this.getConnectionName(),
          relatedTableName: relatedDefinition.table.tableName,
        }))
        continue
      }

      if (relation.kind === 'hasMany' || relation.kind === 'hasOne') {
        const hydrationQuery = this.createPatchableRelatedHydrationQuery(relation, load.constraint)
        if (!hydrationQuery) {
          return undefined
        }

        const related = relation.related()
        const relatedDefinition = 'definition' in related ? related.definition : related
        if (modelNeedsSerialization(relatedDefinition)) {
          return undefined
        }

        relatedHydrations.push(Object.freeze({
          foreignKey: relation.foreignKey,
          kind: relation.kind,
          localKey: relation.localKey,
          orderBy: hydrationQuery.orderBy,
          predicates: hydrationQuery.predicates,
          relationKey: load.relation,
          relatedConnectionName: relatedDefinition.connectionName ?? this.getConnectionName(),
          relatedTableName: relatedDefinition.table.tableName,
        }))
        continue
      }

      return undefined
    }

    return Object.freeze({
      belongsToHydrations: belongsToHydrations.length > 0
        ? Object.freeze(belongsToHydrations)
        : undefined,
      relatedHydrations: relatedHydrations.length > 0
        ? Object.freeze(relatedHydrations)
        : undefined,
    })
  }

  private createPatchableRelatedHydrationQuery(
    relation: Extract<RelationDefinition, { kind: 'hasMany' | 'hasOne' }>,
    constraint?: RelationConstraint,
  ): Pick<DatabaseQueryRelatedHydrationObservation, 'orderBy' | 'predicates'> | undefined {
    if (!relation.constraint && !constraint) {
      return Object.freeze({
        orderBy: Object.freeze([]),
        predicates: Object.freeze([]),
      })
    }

    const related = relation.related()
    if (!this.isQueryableModelReference(related)) {
      return undefined
    }

    let query = related.query()
    const relationResult = relation.constraint?.(query)
    query = relationResult instanceof ModelQueryBuilderBase ? relationResult as typeof query : query

    if (constraint) {
      const result = constraint(query)
      query = result instanceof ModelQueryBuilderBase ? result as typeof query : query
    }

    const plan = query.getTableQueryBuilder().getPlan()
    const relatedDefinition = 'definition' in related ? related.definition : related
    const observation = createDatabaseQueryObservation(
      plan,
      relatedDefinition.connectionName ?? this.getConnectionName(),
      Object.freeze([]),
    )
    if (!observation?.patchable || typeof observation.limit !== 'undefined' || typeof observation.offset !== 'undefined') {
      return undefined
    }

    return Object.freeze({
      orderBy: observation.orderBy,
      predicates: observation.predicates,
    })
  }

  private isQueryableModelReference(
    value: ModelDefinitionLike<TableDefinition>,
  ): value is QueryableModelReference {
    return 'query' in value && typeof value.query === 'function'
  }

  private rebindRowsToSerializedResult(
    rows: readonly ModelRecord<TTable>[],
    result: unknown,
  ): void {
    if (!hasActiveDatabaseDependencyCollector()) {
      return
    }

    if (this.canBindRowsToSerializedResult()) {
      rebindDatabaseQueryObservationResult(rows, result)
      return
    }

    const hydrations = this.createPatchableEagerRelationHydrations()
    if (hydrations) {
      rebindDatabaseQueryObservationHydratedResult(
        rows,
        result,
        hydrations.belongsToHydrations ?? Object.freeze([]),
        hydrations.relatedHydrations,
      )
      return
    }

    disableDatabaseQueryObservationPatching(rows, {
      serialized: this.rowsNeedSerialization(),
    })
  }

  private rowsNeedSerialization(): boolean {
    return modelNeedsSerialization(this.repository.definition)
      || Object.keys(this.queryCasts).length > 0
  }

}

export type ModelQueryBuilder<
  TTable extends TableDefinition = TableDefinition,
  TRelations extends RelationMap = RelationMap,
  TLoaded = unknown,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
> = ModelQueryBuilderBase<TTable, TRelations, TLoaded, TScopes>
  & ModelScopeMethods<TTable, TScopes, TRelations, TLoaded>

export interface ModelQueryBuilderConstructor {
  new <
    TTable extends TableDefinition = TableDefinition,
    TRelations extends RelationMap = RelationMap,
    TLoaded = unknown,
    TScopes extends ModelScopesDefinition = EmptyScopeMap,
  >(
    repository: ModelRepository<TTable, TScopes>,
    tableQuery: TableQueryBuilder<TTable, Record<string, unknown>>,
    eagerLoads?: readonly EagerLoad[],
    relationFilters?: readonly RelationFilter[],
    aggregateLoads?: readonly AggregateLoad[],
    queryCasts?: Readonly<Record<string, ModelCastDefinition>>,
    scopePredicates?: TableQueryPredicates<TTable>,
    softDeleteMode?: 'with' | 'without' | 'only',
  ): ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>
}

export const ModelQueryBuilder = ModelQueryBuilderBase as unknown as ModelQueryBuilderConstructor
