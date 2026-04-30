import type { ModelQueryBuilder } from './ModelQueryBuilder'
import type { Entity } from './Entity'
import type { ModelCollection } from './collection'
import type { ModelRepository } from './ModelRepository'
import type { TableQueryBuilder } from '../query/TableQueryBuilder'
import type {
  CursorPaginatedResult,
  CursorPaginationOptions,
  PaginatedResult,
  PaginationMeta,
  PaginationOptions,
  SimplePaginatedResult,
  SimplePaginationMeta,
} from '../query/types'
import type { DriverExecutionResult } from '../core/types'
import type { InferInsert, TableDefinition } from '../schema/types'
import type {
  RelationMap,
  DynamicRelationResolver,
  EntityWithLoaded,
  ModelCastDefinition,
  ModelAttributeKey,
  ModelColumnName,
  ModelColumnReference,
  ModelJsonColumnPath,
  ModelRecord,
  ModelReference,
  ModelSelectableColumn,
  ModelScopesDefinition,
  ModelScopeMethods,
  ModelUpdatePayload,
  ModelRelationPath,
  RelatedColumnNameForRelationPath,
  ResolveEagerLoads,
  SerializedEntityWithLoaded,
} from './types'

type BuilderCallback<TBuilder> = (query: TBuilder) => unknown
type ValueBuilderCallback<TBuilder, TValue> = (query: TBuilder, value: TValue) => unknown
type RelationConstraintCallback = (query: ModelQueryBuilder<TableDefinition>) => unknown
type RelationConstraintMap<TRelations extends RelationMap> = Readonly<
  Partial<Record<ModelRelationPath<TRelations>, RelationConstraintCallback>>
>
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
type SubqueryBuilder<TSubTable extends TableDefinition = TableDefinition>
  = ModelQueryBuilder<TSubTable> | TableQueryBuilder<TSubTable, Record<string, unknown>>

export type StaticModelApi<
  TTable extends TableDefinition,
  TScopes extends ModelScopesDefinition,
  TRelations extends RelationMap = RelationMap,
> = ModelReference<TTable, TScopes, TRelations> & ModelScopeMethods<TTable, TScopes, TRelations> & {
  query(): ModelQueryBuilder<TTable, TRelations>
  newQuery(): ModelQueryBuilder<TTable, TRelations>
  newModelQuery(): ModelQueryBuilder<TTable, TRelations>
  newQueryWithoutScopes(): ModelQueryBuilder<TTable, TRelations>
  newQueryWithoutRelationships(): ModelQueryBuilder<TTable, TRelations>
  from(table: string): ModelQueryBuilder<TTable, TRelations>
  debug(): ReturnType<ModelQueryBuilder<TTable, TRelations>['debug']>
  dump(): ModelQueryBuilder<TTable, TRelations>
  preventLazyLoading(value?: boolean): StaticModelApi<TTable, TScopes, TRelations>
  preventAccessingMissingAttributes(value?: boolean): StaticModelApi<TTable, TScopes, TRelations>
  automaticallyEagerLoadRelationships(value?: boolean): StaticModelApi<TTable, TScopes, TRelations>
  withoutEvents<TResult>(callback: () => TResult | Promise<TResult>): Promise<TResult>
  unguarded<TResult>(callback: () => TResult | Promise<TResult>): Promise<TResult>
  where(callback: BuilderCallback<ModelQueryBuilder<TTable, TRelations>>): ModelQueryBuilder<TTable, TRelations>
  where(column: ModelColumnName<TTable> | ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations>
  orWhere(callback: BuilderCallback<ModelQueryBuilder<TTable, TRelations>>): ModelQueryBuilder<TTable, TRelations>
  orWhere(column: ModelColumnName<TTable> | ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations>
  whereNot(callback: BuilderCallback<ModelQueryBuilder<TTable, TRelations>>): ModelQueryBuilder<TTable, TRelations>
  orWhereNot(callback: BuilderCallback<ModelQueryBuilder<TTable, TRelations>>): ModelQueryBuilder<TTable, TRelations>
  whereExists<TSubTable extends TableDefinition>(subquery: SubqueryBuilder<TSubTable>): ModelQueryBuilder<TTable, TRelations>
  orWhereExists<TSubTable extends TableDefinition>(subquery: SubqueryBuilder<TSubTable>): ModelQueryBuilder<TTable, TRelations>
  whereNotExists<TSubTable extends TableDefinition>(subquery: SubqueryBuilder<TSubTable>): ModelQueryBuilder<TTable, TRelations>
  orWhereNotExists<TSubTable extends TableDefinition>(subquery: SubqueryBuilder<TSubTable>): ModelQueryBuilder<TTable, TRelations>
  whereSub<TSubTable extends TableDefinition>(column: ModelColumnName<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'in' | 'not in' | 'like', subquery: SubqueryBuilder<TSubTable>): ModelQueryBuilder<TTable, TRelations>
  orWhereSub<TSubTable extends TableDefinition>(column: ModelColumnName<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'in' | 'not in' | 'like', subquery: SubqueryBuilder<TSubTable>): ModelQueryBuilder<TTable, TRelations>
  whereInSub<TSubTable extends TableDefinition>(column: ModelColumnName<TTable>, subquery: SubqueryBuilder<TSubTable>): ModelQueryBuilder<TTable, TRelations>
  whereNotInSub<TSubTable extends TableDefinition>(column: ModelColumnName<TTable>, subquery: SubqueryBuilder<TSubTable>): ModelQueryBuilder<TTable, TRelations>
  select(...columns: readonly ModelSelectableColumn<TTable>[]): ModelQueryBuilder<TTable, TRelations>
  addSelect(...columns: readonly ModelSelectableColumn<TTable>[]): ModelQueryBuilder<TTable, TRelations>
  withCasts(casts: Record<string, ModelCastDefinition>): ModelQueryBuilder<TTable, TRelations>
  selectSub<TSubTable extends TableDefinition>(query: SubqueryBuilder<TSubTable>, alias: string): ModelQueryBuilder<TTable, TRelations>
  addSelectSub<TSubTable extends TableDefinition>(query: SubqueryBuilder<TSubTable>, alias: string): ModelQueryBuilder<TTable, TRelations>
  whereNull(column: ModelColumnName<TTable>): ModelQueryBuilder<TTable, TRelations>
  orWhereNull(column: ModelColumnName<TTable>): ModelQueryBuilder<TTable, TRelations>
  whereNotNull(column: ModelColumnName<TTable>): ModelQueryBuilder<TTable, TRelations>
  orWhereNotNull(column: ModelColumnName<TTable>): ModelQueryBuilder<TTable, TRelations>
  when<TValue>(value: TValue, callback: ValueBuilderCallback<ModelQueryBuilder<TTable, TRelations>, TValue>, defaultCallback?: ValueBuilderCallback<ModelQueryBuilder<TTable, TRelations>, TValue>): ModelQueryBuilder<TTable, TRelations>
  unless<TValue>(value: TValue, callback: ValueBuilderCallback<ModelQueryBuilder<TTable, TRelations>, TValue>, defaultCallback?: ValueBuilderCallback<ModelQueryBuilder<TTable, TRelations>, TValue>): ModelQueryBuilder<TTable, TRelations>
  distinct(): ModelQueryBuilder<TTable, TRelations>
  whereColumn(column: ModelColumnReference<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like', compareTo: ModelColumnReference<TTable>): ModelQueryBuilder<TTable, TRelations>
  whereIn(column: ModelColumnName<TTable>, values: readonly unknown[]): ModelQueryBuilder<TTable, TRelations>
  whereNotIn(column: ModelColumnName<TTable>, values: readonly unknown[]): ModelQueryBuilder<TTable, TRelations>
  whereBetween(column: ModelColumnName<TTable>, range: readonly [unknown, unknown]): ModelQueryBuilder<TTable, TRelations>
  whereNotBetween(column: ModelColumnName<TTable>, range: readonly [unknown, unknown]): ModelQueryBuilder<TTable, TRelations>
  whereLike(column: ModelColumnName<TTable>, pattern: string): ModelQueryBuilder<TTable, TRelations>
  orWhereLike(column: ModelColumnName<TTable>, pattern: string): ModelQueryBuilder<TTable, TRelations>
  whereAny(columns: readonly ModelColumnName<TTable>[], operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations>
  whereAll(columns: readonly ModelColumnName<TTable>[], operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations>
  whereNone(columns: readonly ModelColumnName<TTable>[], operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations>
  join(table: string, leftColumn: ModelColumnReference<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like', rightColumn: ModelColumnReference<TTable>): ModelQueryBuilder<TTable, TRelations>
  leftJoin(table: string, leftColumn: ModelColumnReference<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like', rightColumn: ModelColumnReference<TTable>): ModelQueryBuilder<TTable, TRelations>
  rightJoin(table: string, leftColumn: ModelColumnReference<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like', rightColumn: ModelColumnReference<TTable>): ModelQueryBuilder<TTable, TRelations>
  crossJoin(table: string): ModelQueryBuilder<TTable, TRelations>
  joinSub<TSubTable extends TableDefinition>(query: SubqueryBuilder<TSubTable>, alias: string, leftColumn: ModelColumnReference<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like', rightColumn: ModelColumnReference<TTable>): ModelQueryBuilder<TTable, TRelations>
  leftJoinSub<TSubTable extends TableDefinition>(query: SubqueryBuilder<TSubTable>, alias: string, leftColumn: ModelColumnReference<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like', rightColumn: ModelColumnReference<TTable>): ModelQueryBuilder<TTable, TRelations>
  rightJoinSub<TSubTable extends TableDefinition>(query: SubqueryBuilder<TSubTable>, alias: string, leftColumn: ModelColumnReference<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like', rightColumn: ModelColumnReference<TTable>): ModelQueryBuilder<TTable, TRelations>
  joinLateral<TSubTable extends TableDefinition>(query: SubqueryBuilder<TSubTable>, alias: string): ModelQueryBuilder<TTable, TRelations>
  leftJoinLateral<TSubTable extends TableDefinition>(query: SubqueryBuilder<TSubTable>, alias: string): ModelQueryBuilder<TTable, TRelations>
  union<TSubTable extends TableDefinition>(query: SubqueryBuilder<TSubTable>): ModelQueryBuilder<TTable, TRelations>
  unionAll<TSubTable extends TableDefinition>(query: SubqueryBuilder<TSubTable>): ModelQueryBuilder<TTable, TRelations>
  groupBy(...columns: readonly ModelColumnName<TTable>[]): ModelQueryBuilder<TTable, TRelations>
  having(expression: string, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations>
  havingBetween(expression: string, range: readonly [unknown, unknown]): ModelQueryBuilder<TTable, TRelations>
  unsafeWhere(sql: string, bindings: readonly unknown[]): ModelQueryBuilder<TTable, TRelations>
  orUnsafeWhere(sql: string, bindings: readonly unknown[]): ModelQueryBuilder<TTable, TRelations>
  whereDate(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations>
  whereMonth(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations>
  whereDay(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations>
  whereYear(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations>
  whereTime(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations>
  whereJson(columnPath: ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations>
  orWhereJson(columnPath: ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations>
  whereJsonContains(columnPath: ModelJsonColumnPath<TTable>, value: unknown): ModelQueryBuilder<TTable, TRelations>
  orWhereJsonContains(columnPath: ModelJsonColumnPath<TTable>, value: unknown): ModelQueryBuilder<TTable, TRelations>
  whereJsonLength(columnPath: ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations>
  orWhereJsonLength(columnPath: ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations>
  whereFullText(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[], value: string, options?: { mode?: 'natural' | 'boolean' }): ModelQueryBuilder<TTable, TRelations>
  orWhereFullText(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[], value: string, options?: { mode?: 'natural' | 'boolean' }): ModelQueryBuilder<TTable, TRelations>
  whereVectorSimilarTo(column: ModelColumnName<TTable>, vector: readonly number[], minSimilarity?: number): ModelQueryBuilder<TTable, TRelations>
  orWhereVectorSimilarTo(column: ModelColumnName<TTable>, vector: readonly number[], minSimilarity?: number): ModelQueryBuilder<TTable, TRelations>
  orderBy(column: ModelColumnName<TTable>, direction?: 'asc' | 'desc'): ModelQueryBuilder<TTable, TRelations>
  latest(column?: ModelColumnName<TTable>): ModelQueryBuilder<TTable, TRelations>
  oldest(column?: ModelColumnName<TTable>): ModelQueryBuilder<TTable, TRelations>
  inRandomOrder(): ModelQueryBuilder<TTable, TRelations>
  reorder(column?: ModelColumnName<TTable>, direction?: 'asc' | 'desc'): ModelQueryBuilder<TTable, TRelations>
  unsafeOrderBy(sql: string, bindings: readonly unknown[]): ModelQueryBuilder<TTable, TRelations>
  lock(mode: 'update' | 'share'): ModelQueryBuilder<TTable, TRelations>
  lockForUpdate(): ModelQueryBuilder<TTable, TRelations>
  sharedLock(): ModelQueryBuilder<TTable, TRelations>
  with<TPaths extends readonly ModelRelationPath<TRelations>[]>(...relations: TPaths): ModelQueryBuilder<TTable, TRelations, ResolveEagerLoads<TRelations, TPaths>>
  with<TPaths extends readonly ModelRelationPath<TRelations>[]>(relations: TPaths): ModelQueryBuilder<TTable, TRelations, ResolveEagerLoads<TRelations, TPaths>>
  with<TPath extends ModelRelationPath<TRelations>>(relation: TPath, constraint: RelationConstraintCallback): ModelQueryBuilder<TTable, TRelations, ResolveEagerLoads<TRelations, readonly [TPath]>>
  with<TMap extends Readonly<Partial<Record<ModelRelationPath<TRelations>, RelationConstraintCallback>>>>(relations: TMap): ModelQueryBuilder<TTable, TRelations>
  withCount(...relations: readonly ModelRelationPath<TRelations>[]): ModelQueryBuilder<TTable, TRelations>
  withCount(relations: RelationConstraintMap<TRelations>): ModelQueryBuilder<TTable, TRelations>
  withExists(...relations: readonly ModelRelationPath<TRelations>[]): ModelQueryBuilder<TTable, TRelations>
  withExists(relations: RelationConstraintMap<TRelations>): ModelQueryBuilder<TTable, TRelations>
  withSum<TRelationPath extends ModelRelationPath<TRelations>>(relation: TRelationPath | RelationConstraintMap<TRelations>, column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>, ...rest: readonly ModelRelationPath<TRelations>[]): ModelQueryBuilder<TTable, TRelations>
  withAvg<TRelationPath extends ModelRelationPath<TRelations>>(relation: TRelationPath | RelationConstraintMap<TRelations>, column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>, ...rest: readonly ModelRelationPath<TRelations>[]): ModelQueryBuilder<TTable, TRelations>
  withMin<TRelationPath extends ModelRelationPath<TRelations>>(relation: TRelationPath | RelationConstraintMap<TRelations>, column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>, ...rest: readonly ModelRelationPath<TRelations>[]): ModelQueryBuilder<TTable, TRelations>
  withMax<TRelationPath extends ModelRelationPath<TRelations>>(relation: TRelationPath | RelationConstraintMap<TRelations>, column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>, ...rest: readonly ModelRelationPath<TRelations>[]): ModelQueryBuilder<TTable, TRelations>
  has(relation: ModelRelationPath<TRelations>): ModelQueryBuilder<TTable, TRelations>
  orHas(relation: ModelRelationPath<TRelations>): ModelQueryBuilder<TTable, TRelations>
  whereHas(relation: ModelRelationPath<TRelations>, constraint?: RelationConstraintCallback): ModelQueryBuilder<TTable, TRelations>
  orWhereHas(relation: ModelRelationPath<TRelations>, constraint?: RelationConstraintCallback): ModelQueryBuilder<TTable, TRelations>
  doesntHave(relation: ModelRelationPath<TRelations>): ModelQueryBuilder<TTable, TRelations>
  orDoesntHave(relation: ModelRelationPath<TRelations>): ModelQueryBuilder<TTable, TRelations>
  whereDoesntHave(relation: ModelRelationPath<TRelations>, constraint?: RelationConstraintCallback): ModelQueryBuilder<TTable, TRelations>
  orWhereDoesntHave(relation: ModelRelationPath<TRelations>, constraint?: RelationConstraintCallback): ModelQueryBuilder<TTable, TRelations>
  whereRelation<TRelationPath extends ModelRelationPath<TRelations>>(relation: TRelationPath, column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations>
  orWhereRelation<TRelationPath extends ModelRelationPath<TRelations>>(relation: TRelationPath, column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>, operator: unknown, value?: unknown): ModelQueryBuilder<TTable, TRelations>
  whereBelongsTo<TRelated extends TableDefinition, TRelatedRelations extends RelationMap = RelationMap>(entity: Entity<TRelated, TRelatedRelations>, relationName?: ModelRelationPath<TRelations>): ModelQueryBuilder<TTable, TRelations>
  orWhereBelongsTo<TRelated extends TableDefinition, TRelatedRelations extends RelationMap = RelationMap>(entity: Entity<TRelated, TRelatedRelations>, relationName?: ModelRelationPath<TRelations>): ModelQueryBuilder<TTable, TRelations>
  whereMorphedTo(relation: ModelRelationPath<TRelations>, target: MorphTypeSelector): ModelQueryBuilder<TTable, TRelations>
  orWhereMorphedTo(relation: ModelRelationPath<TRelations>, target: MorphTypeSelector): ModelQueryBuilder<TTable, TRelations>
  whereNotMorphedTo(relation: ModelRelationPath<TRelations>, target: MorphTypeSelector): ModelQueryBuilder<TTable, TRelations>
  orWhereNotMorphedTo(relation: ModelRelationPath<TRelations>, target: MorphTypeSelector): ModelQueryBuilder<TTable, TRelations>
  withWhereHas<TPath extends ModelRelationPath<TRelations>>(relation: TPath, constraint?: RelationConstraintCallback): ModelQueryBuilder<TTable, TRelations, ResolveEagerLoads<TRelations, readonly [TPath]>>
  find(value: unknown): Promise<Entity<TTable, TRelations> | undefined>
  findMany(values: readonly unknown[]): Promise<ModelCollection<TTable, TRelations>>
  findOrFail(value: unknown): Promise<Entity<TTable, TRelations>>
  findOrFailJson(value: unknown): Promise<SerializedEntityWithLoaded<TTable, unknown>>
  first(): Promise<Entity<TTable, TRelations> | undefined>
  firstJson(): Promise<SerializedEntityWithLoaded<TTable, unknown> | undefined>
  firstOrFail(): Promise<Entity<TTable, TRelations>>
  sole(): Promise<Entity<TTable, TRelations>>
  soleJson(): Promise<SerializedEntityWithLoaded<TTable, unknown>>
  firstWhere(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): Promise<Entity<TTable, TRelations> | undefined>
  get(): Promise<ModelCollection<TTable, TRelations>>
  getJson(): Promise<SerializedEntityWithLoaded<TTable, unknown>[]>
  all(): Promise<ModelCollection<TTable, TRelations>>
  paginate(perPage?: number, page?: number, options?: PaginationOptions): Promise<PaginatedResult<Entity<TTable, TRelations>> & { data: ModelCollection<TTable, TRelations> }>
  paginateJson(perPage?: number, page?: number, options?: PaginationOptions): Promise<{ data: readonly SerializedEntityWithLoaded<TTable, unknown>[], meta: PaginationMeta }>
  simplePaginate(perPage?: number, page?: number, options?: PaginationOptions): Promise<SimplePaginatedResult<Entity<TTable, TRelations>> & { data: ModelCollection<TTable, TRelations> }>
  simplePaginateJson(perPage?: number, page?: number, options?: PaginationOptions): Promise<{ data: readonly SerializedEntityWithLoaded<TTable, unknown>[], meta: SimplePaginationMeta }>
  cursorPaginate(perPage?: number, cursor?: string | null, options?: CursorPaginationOptions): Promise<CursorPaginatedResult<Entity<TTable, TRelations>> & { data: ModelCollection<TTable, TRelations> }>
  cursorPaginateJson(perPage?: number, cursor?: string | null, options?: CursorPaginationOptions): Promise<{
    data: readonly SerializedEntityWithLoaded<TTable, unknown>[]
    perPage: number
    cursorName: string
    nextCursor: string | null
    prevCursor: string | null
  }>
  chunk(size: number, callback: (rows: readonly EntityWithLoaded<TTable, TRelations, unknown>[], page: number) => unknown | Promise<unknown>): Promise<void>
  chunkById(size: number, callback: (rows: readonly EntityWithLoaded<TTable, TRelations, unknown>[], page: number) => unknown | Promise<unknown>, column?: ModelAttributeKey<TTable>): Promise<void>
  chunkByIdDesc(size: number, callback: (rows: readonly EntityWithLoaded<TTable, TRelations, unknown>[], page: number) => unknown | Promise<unknown>, column?: ModelAttributeKey<TTable>): Promise<void>
  lazy(size?: number): AsyncGenerator<Entity<TTable, TRelations>, void, unknown>
  cursor(): AsyncGenerator<Entity<TTable, TRelations>, void, unknown>
  count(): Promise<number>
  exists(): Promise<boolean>
  doesntExist(): Promise<boolean>
  pluck<TColumn extends ModelAttributeKey<TTable>>(column: TColumn): Promise<Array<ModelRecord<TTable>[TColumn]>>
  value<TColumn extends ModelAttributeKey<TTable>>(column: TColumn): Promise<ModelRecord<TTable>[TColumn] | undefined>
  valueOrFail<TColumn extends ModelAttributeKey<TTable>>(column: TColumn): Promise<ModelRecord<TTable>[TColumn]>
  soleValue<TColumn extends ModelAttributeKey<TTable>>(column: TColumn): Promise<ModelRecord<TTable>[TColumn]>
  sum(column: ModelColumnName<TTable>): Promise<number>
  avg(column: ModelColumnName<TTable>): Promise<number | null>
  min(column: ModelColumnName<TTable>): Promise<number | null>
  max(column: ModelColumnName<TTable>): Promise<number | null>
  create(values: Partial<ModelRecord<TTable>>): Promise<Entity<TTable, TRelations>>
  create(values: InferInsert<TTable>): Promise<Entity<TTable, TRelations>>
  createMany(values: readonly Partial<ModelRecord<TTable>>[]): Promise<ModelCollection<TTable, TRelations>>
  createMany(values: readonly InferInsert<TTable>[]): Promise<ModelCollection<TTable, TRelations>>
  createQuietly(values: Partial<ModelRecord<TTable>>): Promise<Entity<TTable, TRelations>>
  createQuietly(values: InferInsert<TTable>): Promise<Entity<TTable, TRelations>>
  createManyQuietly(values: readonly Partial<ModelRecord<TTable>>[]): Promise<ModelCollection<TTable, TRelations>>
  createManyQuietly(values: readonly InferInsert<TTable>[]): Promise<ModelCollection<TTable, TRelations>>
  update(id: unknown, values: ModelUpdatePayload<TTable>): Promise<Entity<TTable, TRelations>>
  prune(): Promise<number>
  increment(column: ModelColumnName<TTable>, amount?: number, extraValues?: Partial<ModelRecord<TTable>>): Promise<DriverExecutionResult>
  decrement(column: ModelColumnName<TTable>, amount?: number, extraValues?: Partial<ModelRecord<TTable>>): Promise<DriverExecutionResult>
  delete(id: unknown): Promise<void>
  destroy(ids: readonly unknown[]): Promise<number>
  restore(id: unknown): Promise<Entity<TTable, TRelations>>
  forceDelete(id: unknown): Promise<void>
  withTrashed(): ModelQueryBuilder<TTable, TRelations>
  onlyTrashed(): ModelQueryBuilder<TTable, TRelations>
  updateOrCreate(match: Partial<ModelRecord<TTable>>, values?: Partial<ModelRecord<TTable>>): Promise<Entity<TTable, TRelations>>
  upsert(match: Partial<ModelRecord<TTable>>, values?: Partial<ModelRecord<TTable>>): Promise<Entity<TTable, TRelations>>
  firstOrNew(match: Partial<ModelRecord<TTable>>, values?: Partial<ModelRecord<TTable>>): Promise<Entity<TTable, TRelations>>
  firstOrCreate(match: Partial<ModelRecord<TTable>>, values?: Partial<ModelRecord<TTable>>): Promise<Entity<TTable, TRelations>>
  saveMany(entities: readonly EntityWithLoaded<TTable, TRelations, unknown>[]): Promise<ModelCollection<TTable, TRelations>>
  resolveRelationUsing(name: string, resolver: DynamicRelationResolver): StaticModelApi<TTable, TScopes, TRelations>
  make(values?: Partial<ModelRecord<TTable>>): Entity<TTable, TRelations>
  getRepository(): ModelRepository<TTable>
  getConnectionName(): string | undefined
  getTableName(): string
}
