import type { ModelQueryBuilder } from './ModelQueryBuilder'
import type { Entity } from './Entity'
import type { ModelCollection } from './collection'
import type { ModelRepository } from './ModelRepository'
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
  ModelAttributeKey,
  ModelColumnName,
  ModelRecord,
  ModelReference,
  ModelScopesDefinition,
  ModelScopeMethods,
  ModelUpdatePayload,
  SerializedEntityWithLoaded,
} from './types'

type PrimaryKeyName<TTable extends TableDefinition> = Extract<{
  [K in keyof TTable['columns']]: TTable['columns'][K] extends { readonly primaryKey: true } ? K : never
}[keyof TTable['columns']], keyof ModelRecord<TTable> & string>
type ModelPrimaryKeyValue<TTable extends TableDefinition>
  = [PrimaryKeyName<TTable>] extends [never]
    ? unknown
    : ModelRecord<TTable>[PrimaryKeyName<TTable>]
type StaticModelQueryForwardMethod =
  | 'from'
  | 'debug'
  | 'dump'
  | 'where'
  | 'orWhere'
  | 'whereNot'
  | 'orWhereNot'
  | 'whereExists'
  | 'orWhereExists'
  | 'whereNotExists'
  | 'orWhereNotExists'
  | 'whereSub'
  | 'orWhereSub'
  | 'whereInSub'
  | 'whereNotInSub'
  | 'select'
  | 'addSelect'
  | 'withCasts'
  | 'selectSub'
  | 'addSelectSub'
  | 'whereNull'
  | 'orWhereNull'
  | 'whereNotNull'
  | 'orWhereNotNull'
  | 'when'
  | 'unless'
  | 'distinct'
  | 'whereColumn'
  | 'whereIn'
  | 'whereNotIn'
  | 'whereBetween'
  | 'whereNotBetween'
  | 'whereLike'
  | 'orWhereLike'
  | 'whereAny'
  | 'whereAll'
  | 'whereNone'
  | 'join'
  | 'leftJoin'
  | 'rightJoin'
  | 'crossJoin'
  | 'joinSub'
  | 'leftJoinSub'
  | 'rightJoinSub'
  | 'joinLateral'
  | 'leftJoinLateral'
  | 'union'
  | 'unionAll'
  | 'groupBy'
  | 'having'
  | 'havingBetween'
  | 'unsafeWhere'
  | 'orUnsafeWhere'
  | 'whereDate'
  | 'whereMonth'
  | 'whereDay'
  | 'whereYear'
  | 'whereTime'
  | 'whereJson'
  | 'orWhereJson'
  | 'whereJsonContains'
  | 'orWhereJsonContains'
  | 'whereJsonLength'
  | 'orWhereJsonLength'
  | 'whereFullText'
  | 'orWhereFullText'
  | 'whereVectorSimilarTo'
  | 'orWhereVectorSimilarTo'
  | 'orderBy'
  | 'latest'
  | 'oldest'
  | 'inRandomOrder'
  | 'reorder'
  | 'unsafeOrderBy'
  | 'lock'
  | 'lockForUpdate'
  | 'sharedLock'
  | 'withoutGlobalScope'
  | 'withoutGlobalScopes'
  | 'with'
  | 'withCount'
  | 'withExists'
  | 'withSum'
  | 'withAvg'
  | 'withMin'
  | 'withMax'
  | 'has'
  | 'orHas'
  | 'whereHas'
  | 'orWhereHas'
  | 'doesntHave'
  | 'orDoesntHave'
  | 'whereDoesntHave'
  | 'orWhereDoesntHave'
  | 'whereRelation'
  | 'orWhereRelation'
  | 'whereBelongsTo'
  | 'orWhereBelongsTo'
  | 'whereMorphedTo'
  | 'orWhereMorphedTo'
  | 'whereNotMorphedTo'
  | 'orWhereNotMorphedTo'
  | 'withWhereHas'
type StaticModelQueryForwarders<
  TTable extends TableDefinition,
  TRelations extends RelationMap,
> = Pick<ModelQueryBuilder<TTable, TRelations>, StaticModelQueryForwardMethod>

export type StaticModelApi<
  TTable extends TableDefinition,
  TScopes extends ModelScopesDefinition,
  TRelations extends RelationMap = RelationMap,
> = ModelReference<TTable, TScopes, TRelations>
  & ModelScopeMethods<TTable, TScopes, TRelations>
  & StaticModelQueryForwarders<TTable, TRelations>
  & {
  query(): ModelQueryBuilder<TTable, TRelations>
  newQuery(): ModelQueryBuilder<TTable, TRelations>
  newModelQuery(): ModelQueryBuilder<TTable, TRelations>
  newQueryWithoutScopes(): ModelQueryBuilder<TTable, TRelations>
  newQueryWithoutRelationships(): ModelQueryBuilder<TTable, TRelations>
  preventLazyLoading(value?: boolean): StaticModelApi<TTable, TScopes, TRelations>
  preventAccessingMissingAttributes(value?: boolean): StaticModelApi<TTable, TScopes, TRelations>
  automaticallyEagerLoadRelationships(value?: boolean): StaticModelApi<TTable, TScopes, TRelations>
  withoutEvents<TResult>(callback: () => TResult | Promise<TResult>): Promise<TResult>
  unguarded<TResult>(callback: () => TResult | Promise<TResult>): Promise<TResult>
  find(value: ModelPrimaryKeyValue<TTable>): Promise<Entity<TTable, TRelations> | undefined>
  findMany(values: readonly ModelPrimaryKeyValue<TTable>[]): Promise<ModelCollection<TTable, TRelations>>
  findOrFail(value: ModelPrimaryKeyValue<TTable>): Promise<Entity<TTable, TRelations>>
  findOrFailJson(value: ModelPrimaryKeyValue<TTable>): Promise<SerializedEntityWithLoaded<TTable, unknown>>
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
  update(id: ModelPrimaryKeyValue<TTable>, values: ModelUpdatePayload<TTable>): Promise<Entity<TTable, TRelations>>
  prune(): Promise<number>
  increment(column: ModelColumnName<TTable>, amount?: number, extraValues?: Partial<ModelRecord<TTable>>): Promise<DriverExecutionResult>
  decrement(column: ModelColumnName<TTable>, amount?: number, extraValues?: Partial<ModelRecord<TTable>>): Promise<DriverExecutionResult>
  delete(id: ModelPrimaryKeyValue<TTable>): Promise<void>
  destroy(ids: readonly ModelPrimaryKeyValue<TTable>[]): Promise<number>
  restore(id: ModelPrimaryKeyValue<TTable>): Promise<Entity<TTable, TRelations>>
  forceDelete(id: ModelPrimaryKeyValue<TTable>): Promise<void>
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
