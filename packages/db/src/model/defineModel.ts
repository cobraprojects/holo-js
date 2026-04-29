import { SchemaError } from '../core/errors'
import { TableDefinitionBuilder } from '../schema/TableDefinitionBuilder'
import { getGeneratedTableDefinition } from '../schema/generated'
import { registerDynamicRelation } from './dynamicRelations'
import { withoutModelEvents, withoutModelGuards } from './eventState'
import { ModelRepository } from './ModelRepository'
import { registerMorphModel } from './morphRegistry'
import { setAutomaticEagerLoading, setPreventAccessingMissingAttributes, setPreventLazyLoading } from './runtimeSettings'
import { resolveUniqueIdConfig, validateUniqueIdConfig } from './uniqueIds'
import type { ColumnInput } from '../schema/columns'
import type { BoundTableDefinition } from '../schema/defineTable'
import type { ModelQueryBuilder } from './ModelQueryBuilder'
import type { Entity } from './Entity'
import type { ModelCollection } from './collection'
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
  DefineModelOptions,
  EntityWithLoaded,
  EmptyScopeMap,
  GeneratedSchemaTable,
  ModelCastDefinition,
  ModelAttributeKey,
  ModelColumnName,
  ModelColumnReference,
  ModelDefinition,
  ModelJsonColumnPath,
  ModelLifecycleEventHandler,
  ModelLifecycleEventName,
  ModelRelationPath,
  ModelRecord,
  ModelReference,
  ModelSelectableColumn,
  ModelScopesDefinition,
  ModelScopeMethods,
  ModelUpdatePayload,
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
type ColumnShapeInput = Record<string, ColumnInput>
type EmptyColumnShape = Record<never, never>
type ModelTableBuilderResult<
  TName extends string,
  TColumns extends ColumnShapeInput,
> = {
  build(): BoundTableDefinition<TName, TColumns>
}

function buildModelTable<
  TName extends string,
  TColumns extends ColumnShapeInput,
>(
  tableName: TName,
  builder: (table: TableDefinitionBuilder<TName, EmptyColumnShape>) => ModelTableBuilderResult<TName, TColumns>,
): BoundTableDefinition<TName, TColumns> {
  return builder(new TableDefinitionBuilder(tableName)).build()
}

function inferModelName(tableName: string): string {
  const singular = tableName.endsWith('s') ? tableName.slice(0, -1) : tableName
  return singular
    .split(/[_-]/g)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

function inferPrimaryKey<TTable extends TableDefinition>(table: TTable): Extract<keyof TTable['columns'], string> {
  const primaryKey = Object.values(table.columns).find(column => column.primaryKey)
  if (!primaryKey) {
    throw new SchemaError(`Table "${table.tableName}" does not define a primary key column.`)
  }

  return primaryKey.name as Extract<keyof TTable['columns'], string>
}

function resolveGeneratedModelTable(tableName: string): TableDefinition {
  const table = getGeneratedTableDefinition(tableName)
  if (!table) {
    throw new SchemaError(
      `Model "${tableName}" is not present in the generated schema registry. Import your generated schema module and run "holo migrate" to refresh it.`,
    )
  }

  return table
}

function resolveDeletedAtColumn<TTable extends TableDefinition>(
  table: TTable,
  options: DefineModelOptions<TTable>,
): Extract<keyof TTable['columns'], string> | undefined {
  if (!options.softDeletes) {
    return undefined
  }

  const deletedAtColumn = (options.deletedAtColumn ?? 'deleted_at') as Extract<keyof TTable['columns'], string>
  if (!(deletedAtColumn in table.columns)) {
    throw new SchemaError(`Soft-deleting model "${options.name ?? inferModelName(table.tableName)}" requires a "${String(deletedAtColumn)}" column.`)
  }

  return deletedAtColumn
}

function resolveTimestampColumn<TTable extends TableDefinition>(
  table: TTable,
  explicit: string | undefined,
  fallback: string,
): Extract<keyof TTable['columns'], string> | undefined {
  const candidate = (explicit ?? fallback) as Extract<keyof TTable['columns'], string>
  return candidate in table.columns ? candidate : undefined
}

function normalizeEventHandlers(
  events: DefineModelOptions['events'],
): Partial<Record<ModelLifecycleEventName, readonly ModelLifecycleEventHandler[]>> {
  if (!events) return {}

  return Object.fromEntries(
    Object.entries(events).map(([name, handlers]) => [
      name,
      Object.freeze(Array.isArray(handlers) ? [...handlers] : [handlers]),
    ]),
  ) as Partial<Record<ModelLifecycleEventName, readonly ModelLifecycleEventHandler[]>>
}

function validateTouches(
  modelName: string,
  relations: RelationMap,
  touches: readonly string[],
): readonly string[] {
  for (const relationName of touches) {
    const relation = relations[relationName]
    if (!relation) {
      throw new SchemaError(`Touched relation "${relationName}" is not defined on model "${modelName}".`)
    }

    if (relation.kind !== 'belongsTo' && relation.kind !== 'morphTo') {
      throw new SchemaError(`Touched relation "${relationName}" on model "${modelName}" must be a belongs-to or morph-to relation.`)
    }
  }

  return Object.freeze([...touches])
}

type StaticModelApi<
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
  whereBelongsTo<TRelated extends TableDefinition>(entity: Entity<TRelated>, relationName?: ModelRelationPath<TRelations>): ModelQueryBuilder<TTable, TRelations>
  orWhereBelongsTo<TRelated extends TableDefinition>(entity: Entity<TRelated>, relationName?: ModelRelationPath<TRelations>): ModelQueryBuilder<TTable, TRelations>
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
  chunk(size: number, callback: (rows: readonly Entity<TTable, TRelations>[], page: number) => unknown | Promise<unknown>): Promise<void>
  chunkById(size: number, callback: (rows: readonly Entity<TTable, TRelations>[], page: number) => unknown | Promise<unknown>, column?: ModelAttributeKey<TTable>): Promise<void>
  chunkByIdDesc(size: number, callback: (rows: readonly Entity<TTable, TRelations>[], page: number) => unknown | Promise<unknown>, column?: ModelAttributeKey<TTable>): Promise<void>
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

export function defineModel<
  TTable extends TableDefinition,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
  TRelations extends RelationMap = RelationMap,
>(
  table: TTable,
  options?: DefineModelOptions<TTable, TScopes, TRelations>,
): StaticModelApi<TTable, TScopes, TRelations>
export function defineModel<
  TName extends string,
  TColumns extends ColumnShapeInput,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
  TRelations extends RelationMap = RelationMap,
>(
  tableName: TName,
  builder: (table: TableDefinitionBuilder<TName, EmptyColumnShape>) => ModelTableBuilderResult<TName, TColumns>,
  options?: DefineModelOptions<BoundTableDefinition<TName, TColumns>, TScopes, TRelations>,
): StaticModelApi<BoundTableDefinition<TName, TColumns>, TScopes, TRelations>
export function defineModel<
  TName extends string,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
  TRelations extends RelationMap = RelationMap,
>(
  tableName: TName,
  options?: DefineModelOptions<GeneratedSchemaTable<TName>, TScopes, TRelations>,
): StaticModelApi<GeneratedSchemaTable<TName>, TScopes, TRelations>
export function defineModel(
  tableOrName: string | TableDefinition,
  builderOrOptions?:
    | DefineModelOptions<TableDefinition>
    | ((table: TableDefinitionBuilder<string, EmptyColumnShape>) => ModelTableBuilderResult<string, ColumnShapeInput>),
  options?: DefineModelOptions<TableDefinition>,
): unknown {
  if (typeof tableOrName !== 'string') {
    return defineModelFromResolvedTable(tableOrName, (builderOrOptions ?? {}) as DefineModelOptions<TableDefinition>)
  }

  if (typeof builderOrOptions === 'function') {
    return defineModelFromResolvedTable(
      buildModelTable(tableOrName, builderOrOptions),
      (options ?? {}) as DefineModelOptions<TableDefinition>,
    )
  }

  return defineModelFromGeneratedTableName(
    tableOrName,
    (builderOrOptions ?? {}) as DefineModelOptions<TableDefinition>,
  )
}

export function defineModelFromTable<
  TTable extends TableDefinition,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
  TRelations extends RelationMap = RelationMap,
>(
  table: TTable,
  options?: DefineModelOptions<TTable, TScopes, TRelations>,
): StaticModelApi<TTable, TScopes, TRelations>
export function defineModelFromTable(
  table: TableDefinition,
  options?: DefineModelOptions<TableDefinition>,
): unknown {
  return defineModelFromResolvedTable(
    table,
    (options ?? {}) as DefineModelOptions<TableDefinition>,
  )
}

function defineModelFromGeneratedTableName<
  TName extends string,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
  TRelations extends RelationMap = RelationMap,
>(
  tableName: TName,
  options: DefineModelOptions<GeneratedSchemaTable<TName>, TScopes, TRelations> = {},
): StaticModelApi<GeneratedSchemaTable<TName>, TScopes, TRelations> {
  const resolvedAtDefinition = getGeneratedTableDefinition(tableName) as GeneratedSchemaTable<TName> | undefined
  const inferredName = options.name ?? inferModelName(tableName)
  const relations = { ...(options.relations ?? {}) } as TRelations
  const touches = validateTouches(inferredName, relations, options.touches ?? [])

  const resolveTable = (): GeneratedSchemaTable<TName> => resolveGeneratedModelTable(tableName) as GeneratedSchemaTable<TName>
  const resolvePrimaryKey = (): Extract<keyof GeneratedSchemaTable<TName>['columns'], string> => (
    (options.primaryKey ?? inferPrimaryKey(resolveTable())) as Extract<keyof GeneratedSchemaTable<TName>['columns'], string>
  )
  const resolveCreatedAtColumn = (): Extract<keyof GeneratedSchemaTable<TName>['columns'], string> | undefined => {
    const timestamps = options.timestamps ?? true
    return timestamps
      ? resolveTimestampColumn(resolveTable(), options.createdAtColumn, 'created_at')
      : undefined
  }
  const resolveUpdatedAtColumn = (): Extract<keyof GeneratedSchemaTable<TName>['columns'], string> | undefined => {
    const timestamps = options.timestamps ?? true
    return timestamps
      ? resolveTimestampColumn(resolveTable(), options.updatedAtColumn, 'updated_at')
      : undefined
  }
  const resolveDeletedAt = (): Extract<keyof GeneratedSchemaTable<TName>['columns'], string> | undefined => (
    resolveDeletedAtColumn(resolveTable(), options)
  )
  const uniqueIdConfig = resolvedAtDefinition
    ? resolveUniqueIdConfig(
        options.traits,
        resolvePrimaryKey(),
        options.uniqueIds,
        options.newUniqueId,
      )
    : resolveUniqueIdConfig(
        options.traits,
        (options.primaryKey ?? 'id') as Extract<keyof GeneratedSchemaTable<TName>['columns'], string>,
        options.uniqueIds,
        options.newUniqueId,
      )

  if (resolvedAtDefinition) {
    validateUniqueIdConfig(resolvedAtDefinition, inferredName, uniqueIdConfig)
  }

  const definition = {
    kind: 'model' as const,
    name: inferredName,
    connectionName: options.connectionName,
    morphClass: options.morphClass ?? inferredName,
    with: Object.freeze([...(options.with ?? [])]),
    pendingAttributes: Object.freeze({ ...(options.pendingAttributes ?? {}) }),
    preventLazyLoading: options.preventLazyLoading ?? false,
    preventAccessingMissingAttributes: options.preventAccessingMissingAttributes ?? false,
    automaticEagerLoading: options.automaticEagerLoading ?? false,
    timestamps: options.timestamps ?? true,
    fillable: Object.freeze([...(options.fillable ?? [])]),
    hasExplicitFillable: typeof options.fillable !== 'undefined',
    guarded: Object.freeze([...(options.guarded ?? [])]),
    scopes: (options.scopes ?? {}) as TScopes,
    globalScopes: { ...(options.globalScopes ?? {}) },
    relations,
    casts: { ...(options.casts ?? {}) },
    accessors: { ...(options.accessors ?? {}) },
    mutators: { ...(options.mutators ?? {}) },
    hidden: Object.freeze([...(options.hidden ?? [])]),
    visible: Object.freeze([...(options.visible ?? [])]),
    appended: Object.freeze([...(options.appended ?? [])]),
    serializeDate: options.serializeDate,
    collection: options.collection,
    prunable: options.prunable,
    massPrunable: options.massPrunable ?? false,
    touches,
    traits: Object.freeze([...(options.traits ?? [])]),
    uniqueIdConfig,
    replicationExcludes: Object.freeze([...(options.replicationExcludes ?? [])]),
    softDeletes: options.softDeletes ?? false,
    events: normalizeEventHandlers(options.events),
    observers: Object.freeze([...(options.observers ?? [])]),
  } as Omit<ModelDefinition<GeneratedSchemaTable<TName>, TScopes, TRelations>, 'table' | 'primaryKey' | 'createdAtColumn' | 'updatedAtColumn' | 'deletedAtColumn'>
    & Pick<ModelDefinition<GeneratedSchemaTable<TName>, TScopes, TRelations>, 'table' | 'primaryKey' | 'createdAtColumn' | 'updatedAtColumn' | 'deletedAtColumn'>

  Object.defineProperties(definition, {
    table: {
      enumerable: true,
      get: resolveTable,
    },
    primaryKey: {
      enumerable: true,
      get: resolvePrimaryKey,
    },
    createdAtColumn: {
      enumerable: true,
      get: resolveCreatedAtColumn,
    },
    updatedAtColumn: {
      enumerable: true,
      get: resolveUpdatedAtColumn,
    },
    deletedAtColumn: {
      enumerable: true,
      get: resolveDeletedAt,
    },
  })

  return createStaticModelApi(Object.freeze(definition) as ModelDefinition<GeneratedSchemaTable<TName>, TScopes, TRelations>)
}

function defineModelFromResolvedTable<
  TTable extends TableDefinition,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
  TRelations extends RelationMap = RelationMap,
>(
  table: TTable,
  options: DefineModelOptions<TTable, TScopes, TRelations> = {},
): StaticModelApi<TTable, TScopes, TRelations> {
  const deletedAtColumn = resolveDeletedAtColumn(table, options)
  const inferredName = options.name ?? inferModelName(table.tableName)
  const primaryKey = (options.primaryKey ?? inferPrimaryKey(table)) as Extract<keyof TTable['columns'], string>
  const timestamps = options.timestamps ?? true
  const createdAtColumn = timestamps
    ? resolveTimestampColumn(table, options.createdAtColumn, 'created_at')
    : undefined
  const updatedAtColumn = timestamps
    ? resolveTimestampColumn(table, options.updatedAtColumn, 'updated_at')
    : undefined
  const uniqueIdConfig = resolveUniqueIdConfig(
    options.traits,
    primaryKey,
    options.uniqueIds,
    options.newUniqueId,
  )
  validateUniqueIdConfig(table, inferredName, uniqueIdConfig)
  const relations = { ...(options.relations ?? {}) } as TRelations
  const touches = validateTouches(inferredName, relations, options.touches ?? [])

  const definition: ModelDefinition<TTable, TScopes, TRelations> = Object.freeze({
    kind: 'model',
    table,
    name: inferredName,
    primaryKey,
    connectionName: options.connectionName,
    morphClass: options.morphClass ?? inferredName,
    with: Object.freeze([...(options.with ?? [])]),
    pendingAttributes: Object.freeze({ ...(options.pendingAttributes ?? {}) }),
    preventLazyLoading: options.preventLazyLoading ?? false,
    preventAccessingMissingAttributes: options.preventAccessingMissingAttributes ?? false,
    automaticEagerLoading: options.automaticEagerLoading ?? false,
    timestamps,
    createdAtColumn,
    updatedAtColumn,
    fillable: Object.freeze([...(options.fillable ?? [])]),
    hasExplicitFillable: typeof options.fillable !== 'undefined',
    guarded: Object.freeze([...(options.guarded ?? [])]),
    scopes: (options.scopes ?? {}) as TScopes,
    globalScopes: { ...(options.globalScopes ?? {}) },
    relations,
    casts: { ...(options.casts ?? {}) },
    accessors: { ...(options.accessors ?? {}) },
    mutators: { ...(options.mutators ?? {}) },
    hidden: Object.freeze([...(options.hidden ?? [])]),
    visible: Object.freeze([...(options.visible ?? [])]),
    appended: Object.freeze([...(options.appended ?? [])]),
    serializeDate: options.serializeDate,
    collection: options.collection,
    prunable: options.prunable,
    massPrunable: options.massPrunable ?? false,
    touches,
    traits: Object.freeze([...(options.traits ?? [])]),
    uniqueIdConfig,
    replicationExcludes: Object.freeze([...(options.replicationExcludes ?? [])]),
    softDeletes: options.softDeletes ?? false,
    deletedAtColumn,
    events: normalizeEventHandlers(options.events),
    observers: Object.freeze([...(options.observers ?? [])]),
  })

  return createStaticModelApi(definition)
}

function createStaticModelApi<
  TTable extends TableDefinition,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
  TRelations extends RelationMap = RelationMap,
>(
  definition: ModelDefinition<TTable, TScopes, TRelations>,
): StaticModelApi<TTable, TScopes, TRelations> {
  const model: StaticModelApi<TTable, TScopes, TRelations> = {
    definition,
    query() {
      return this.getRepository().query()
    },
    newQuery() {
      return this.getRepository().newQuery()
    },
    newModelQuery() {
      return this.getRepository().newModelQuery()
    },
    newQueryWithoutScopes() {
      return this.getRepository().newQueryWithoutScopes()
    },
    newQueryWithoutRelationships() {
      return this.getRepository().newQueryWithoutRelationships()
    },
    from(table: string) {
      return this.query().from(table)
    },
    debug() {
      return this.query().debug()
    },
    dump() {
      return this.query().dump()
    },
    preventLazyLoading(value: boolean = true) {
      setPreventLazyLoading(definition, value)
      return this
    },
    preventAccessingMissingAttributes(value: boolean = true) {
      setPreventAccessingMissingAttributes(definition, value)
      return this
    },
    automaticallyEagerLoadRelationships(value: boolean = true) {
      setAutomaticEagerLoading(definition, value)
      return this
    },
    withoutEvents<TResult>(callback: () => TResult | Promise<TResult>) {
      return withoutModelEvents(callback)
    },
    unguarded<TResult>(callback: () => TResult | Promise<TResult>) {
      return withoutModelGuards(callback)
    },
    where(columnOrCallback: ModelColumnName<TTable> | BuilderCallback<ModelQueryBuilder<TTable, TRelations>>, operator?: unknown, value?: unknown) {
      return typeof columnOrCallback === 'function'
        ? this.query().where(columnOrCallback)
        : this.query().where(columnOrCallback, operator, value)
    },
    orWhere(columnOrCallback: ModelColumnName<TTable> | BuilderCallback<ModelQueryBuilder<TTable, TRelations>>, operator?: unknown, value?: unknown) {
      return typeof columnOrCallback === 'function'
        ? this.query().orWhere(columnOrCallback)
        : this.query().orWhere(columnOrCallback, operator, value)
    },
    whereNot(callback: BuilderCallback<ModelQueryBuilder<TTable, TRelations>>) {
      return this.query().whereNot(callback)
    },
    orWhereNot(callback: BuilderCallback<ModelQueryBuilder<TTable, TRelations>>) {
      return this.query().orWhereNot(callback)
    },
    whereExists<TSubTable extends TableDefinition>(subquery: SubqueryBuilder<TSubTable>) {
      return this.query().whereExists(subquery)
    },
    orWhereExists<TSubTable extends TableDefinition>(subquery: SubqueryBuilder<TSubTable>) {
      return this.query().orWhereExists(subquery)
    },
    whereNotExists<TSubTable extends TableDefinition>(subquery: SubqueryBuilder<TSubTable>) {
      return this.query().whereNotExists(subquery)
    },
    orWhereNotExists<TSubTable extends TableDefinition>(subquery: SubqueryBuilder<TSubTable>) {
      return this.query().orWhereNotExists(subquery)
    },
    whereSub<TSubTable extends TableDefinition>(column: ModelColumnName<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'in' | 'not in' | 'like', subquery: SubqueryBuilder<TSubTable>) {
      return this.query().whereSub(column, operator, subquery)
    },
    orWhereSub<TSubTable extends TableDefinition>(column: ModelColumnName<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'in' | 'not in' | 'like', subquery: SubqueryBuilder<TSubTable>) {
      return this.query().orWhereSub(column, operator, subquery)
    },
    whereInSub<TSubTable extends TableDefinition>(column: ModelColumnName<TTable>, subquery: SubqueryBuilder<TSubTable>) {
      return this.query().whereInSub(column, subquery)
    },
    whereNotInSub<TSubTable extends TableDefinition>(column: ModelColumnName<TTable>, subquery: SubqueryBuilder<TSubTable>) {
      return this.query().whereNotInSub(column, subquery)
    },
    select(...columns: readonly ModelSelectableColumn<TTable>[]) {
      return this.query().select(...columns)
    },
    addSelect(...columns: readonly ModelSelectableColumn<TTable>[]) {
      return this.query().addSelect(...columns)
    },
    withCasts(casts: Record<string, ModelCastDefinition>) {
      return this.query().withCasts(casts)
    },
    selectSub<TSubTable extends TableDefinition>(query: SubqueryBuilder<TSubTable>, alias: string) {
      return this.query().selectSub(query, alias)
    },
    addSelectSub<TSubTable extends TableDefinition>(query: SubqueryBuilder<TSubTable>, alias: string) {
      return this.query().addSelectSub(query, alias)
    },
    whereNull(column: ModelColumnName<TTable>) {
      return this.query().whereNull(column)
    },
    orWhereNull(column: ModelColumnName<TTable>) {
      return this.query().orWhereNull(column)
    },
    whereNotNull(column: ModelColumnName<TTable>) {
      return this.query().whereNotNull(column)
    },
    orWhereNotNull(column: ModelColumnName<TTable>) {
      return this.query().orWhereNotNull(column)
    },
    when<TValue>(value: TValue, callback: ValueBuilderCallback<ModelQueryBuilder<TTable, TRelations>, TValue>, defaultCallback?: ValueBuilderCallback<ModelQueryBuilder<TTable, TRelations>, TValue>) {
      return this.query().when(value, callback, defaultCallback)
    },
    unless<TValue>(value: TValue, callback: ValueBuilderCallback<ModelQueryBuilder<TTable, TRelations>, TValue>, defaultCallback?: ValueBuilderCallback<ModelQueryBuilder<TTable, TRelations>, TValue>) {
      return this.query().unless(value, callback, defaultCallback)
    },
    distinct() {
      return this.query().distinct()
    },
    whereColumn(column: ModelColumnReference<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like', compareTo: ModelColumnReference<TTable>) {
      return this.query().whereColumn(column, operator, compareTo)
    },
    whereIn(column: ModelColumnName<TTable>, values: readonly unknown[]) {
      return this.query().whereIn(column, values)
    },
    whereNotIn(column: ModelColumnName<TTable>, values: readonly unknown[]) {
      return this.query().whereNotIn(column, values)
    },
    whereBetween(column: ModelColumnName<TTable>, range: readonly [unknown, unknown]) {
      return this.query().whereBetween(column, range)
    },
    whereNotBetween(column: ModelColumnName<TTable>, range: readonly [unknown, unknown]) {
      return this.query().whereNotBetween(column, range)
    },
    whereLike(column: ModelColumnName<TTable>, pattern: string) {
      return this.query().whereLike(column, pattern)
    },
    orWhereLike(column: ModelColumnName<TTable>, pattern: string) {
      return this.query().orWhereLike(column, pattern)
    },
    whereAny(columns: readonly ModelColumnName<TTable>[], operator: unknown, value?: unknown) {
      return this.query().whereAny(columns, operator, value)
    },
    whereAll(columns: readonly ModelColumnName<TTable>[], operator: unknown, value?: unknown) {
      return this.query().whereAll(columns, operator, value)
    },
    whereNone(columns: readonly ModelColumnName<TTable>[], operator: unknown, value?: unknown) {
      return this.query().whereNone(columns, operator, value)
    },
    join(table: string, leftColumn: ModelColumnReference<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like', rightColumn: ModelColumnReference<TTable>) {
      return this.query().join(table, leftColumn, operator, rightColumn)
    },
    leftJoin(table: string, leftColumn: ModelColumnReference<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like', rightColumn: ModelColumnReference<TTable>) {
      return this.query().leftJoin(table, leftColumn, operator, rightColumn)
    },
    rightJoin(table: string, leftColumn: ModelColumnReference<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like', rightColumn: ModelColumnReference<TTable>) {
      return this.query().rightJoin(table, leftColumn, operator, rightColumn)
    },
    crossJoin(table: string) {
      return this.query().crossJoin(table)
    },
    joinSub<TSubTable extends TableDefinition>(query: SubqueryBuilder<TSubTable>, alias: string, leftColumn: ModelColumnReference<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like', rightColumn: ModelColumnReference<TTable>) {
      return this.query().joinSub(query, alias, leftColumn, operator, rightColumn)
    },
    leftJoinSub<TSubTable extends TableDefinition>(query: SubqueryBuilder<TSubTable>, alias: string, leftColumn: ModelColumnReference<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like', rightColumn: ModelColumnReference<TTable>) {
      return this.query().leftJoinSub(query, alias, leftColumn, operator, rightColumn)
    },
    rightJoinSub<TSubTable extends TableDefinition>(query: SubqueryBuilder<TSubTable>, alias: string, leftColumn: ModelColumnReference<TTable>, operator: '!=' | '=' | '>' | '>=' | '<' | '<=' | 'like', rightColumn: ModelColumnReference<TTable>) {
      return this.query().rightJoinSub(query, alias, leftColumn, operator, rightColumn)
    },
    joinLateral<TSubTable extends TableDefinition>(query: SubqueryBuilder<TSubTable>, alias: string) {
      return this.query().joinLateral(query, alias)
    },
    leftJoinLateral<TSubTable extends TableDefinition>(query: SubqueryBuilder<TSubTable>, alias: string) {
      return this.query().leftJoinLateral(query, alias)
    },
    union<TSubTable extends TableDefinition>(query: SubqueryBuilder<TSubTable>) {
      return this.query().union(query)
    },
    unionAll<TSubTable extends TableDefinition>(query: SubqueryBuilder<TSubTable>) {
      return this.query().unionAll(query)
    },
    groupBy(...columns: readonly ModelColumnName<TTable>[]) {
      return this.query().groupBy(...columns)
    },
    having(expression: string, operator: unknown, value?: unknown) {
      return this.query().having(expression, operator, value)
    },
    havingBetween(expression: string, range: readonly [unknown, unknown]) {
      return this.query().havingBetween(expression, range)
    },
    unsafeWhere(sql: string, bindings: readonly unknown[]) {
      return this.query().unsafeWhere(sql, bindings)
    },
    orUnsafeWhere(sql: string, bindings: readonly unknown[]) {
      return this.query().orUnsafeWhere(sql, bindings)
    },
    whereDate(column: ModelColumnName<TTable>, operator: unknown, value?: unknown) {
      return this.query().whereDate(column, operator, value)
    },
    whereMonth(column: ModelColumnName<TTable>, operator: unknown, value?: unknown) {
      return this.query().whereMonth(column, operator, value)
    },
    whereDay(column: ModelColumnName<TTable>, operator: unknown, value?: unknown) {
      return this.query().whereDay(column, operator, value)
    },
    whereYear(column: ModelColumnName<TTable>, operator: unknown, value?: unknown) {
      return this.query().whereYear(column, operator, value)
    },
    whereTime(column: ModelColumnName<TTable>, operator: unknown, value?: unknown) {
      return this.query().whereTime(column, operator, value)
    },
    whereJson(columnPath: ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown) {
      return this.query().whereJson(columnPath, operator, value)
    },
    orWhereJson(columnPath: ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown) {
      return this.query().orWhereJson(columnPath, operator, value)
    },
    whereJsonContains(columnPath: ModelJsonColumnPath<TTable>, value: unknown) {
      return this.query().whereJsonContains(columnPath, value)
    },
    orWhereJsonContains(columnPath: ModelJsonColumnPath<TTable>, value: unknown) {
      return this.query().orWhereJsonContains(columnPath, value)
    },
    whereJsonLength(columnPath: ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown) {
      return this.query().whereJsonLength(columnPath, operator, value)
    },
    orWhereJsonLength(columnPath: ModelJsonColumnPath<TTable>, operator: unknown, value?: unknown) {
      return this.query().orWhereJsonLength(columnPath, operator, value)
    },
    whereFullText(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[], value: string, options: { mode?: 'natural' | 'boolean' } = {}) {
      return this.query().whereFullText(columns, value, options)
    },
    orWhereFullText(columns: ModelColumnName<TTable> | readonly ModelColumnName<TTable>[], value: string, options: { mode?: 'natural' | 'boolean' } = {}) {
      return this.query().orWhereFullText(columns, value, options)
    },
    whereVectorSimilarTo(column: ModelColumnName<TTable>, vector: readonly number[], minSimilarity: number = 0) {
      return this.query().whereVectorSimilarTo(column, vector, minSimilarity)
    },
    orWhereVectorSimilarTo(column: ModelColumnName<TTable>, vector: readonly number[], minSimilarity: number = 0) {
      return this.query().orWhereVectorSimilarTo(column, vector, minSimilarity)
    },
    orderBy(column: ModelColumnName<TTable>, direction: 'asc' | 'desc' = 'asc') {
      return this.query().orderBy(column, direction)
    },
    latest(column?: ModelColumnName<TTable>) {
      return this.query().latest(column)
    },
    oldest(column?: ModelColumnName<TTable>) {
      return this.query().oldest(column)
    },
    inRandomOrder() {
      return this.query().inRandomOrder()
    },
    reorder(column?: ModelColumnName<TTable>, direction?: 'asc' | 'desc') {
      return this.query().reorder(column, direction)
    },
    unsafeOrderBy(sql: string, bindings: readonly unknown[]) {
      return this.query().unsafeOrderBy(sql, bindings)
    },
    lock(mode: 'update' | 'share') {
      return this.query().lock(mode)
    },
    lockForUpdate() {
      return this.query().lockForUpdate()
    },
    sharedLock() {
      return this.query().sharedLock()
    },
    with(
      first: ModelRelationPath<TRelations> | RelationConstraintMap<TRelations> | readonly ModelRelationPath<TRelations>[],
      second?: ModelRelationPath<TRelations> | RelationConstraintCallback,
      ...rest: readonly ModelRelationPath<TRelations>[]
    ) {
      if (Array.isArray(first)) {
        return this.query().with(first as readonly ModelRelationPath<TRelations>[])
      }
      if (typeof first === 'object') {
        return this.query().with(first as RelationConstraintMap<TRelations>)
      }
      if (typeof second === 'function') {
        return this.query().with(first, second)
      }
      return this.query().with(first, ...(typeof second === 'string' ? [second, ...rest] : rest))
    },
    withCount(first: ModelRelationPath<TRelations> | RelationConstraintMap<TRelations>, ...rest: readonly ModelRelationPath<TRelations>[]) {
      return typeof first === 'string'
        ? this.query().withCount(first, ...rest)
        : this.query().withCount(first)
    },
    withExists(first: ModelRelationPath<TRelations> | RelationConstraintMap<TRelations>, ...rest: readonly ModelRelationPath<TRelations>[]) {
      return typeof first === 'string'
        ? this.query().withExists(first, ...rest)
        : this.query().withExists(first)
    },
    withSum<TRelationPath extends ModelRelationPath<TRelations>>(first: TRelationPath | RelationConstraintMap<TRelations>, column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>, ...rest: readonly ModelRelationPath<TRelations>[]) {
      return this.query().withSum(first, column, ...rest)
    },
    withAvg<TRelationPath extends ModelRelationPath<TRelations>>(first: TRelationPath | RelationConstraintMap<TRelations>, column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>, ...rest: readonly ModelRelationPath<TRelations>[]) {
      return this.query().withAvg(first, column, ...rest)
    },
    withMin<TRelationPath extends ModelRelationPath<TRelations>>(first: TRelationPath | RelationConstraintMap<TRelations>, column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>, ...rest: readonly ModelRelationPath<TRelations>[]) {
      return this.query().withMin(first, column, ...rest)
    },
    withMax<TRelationPath extends ModelRelationPath<TRelations>>(first: TRelationPath | RelationConstraintMap<TRelations>, column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>, ...rest: readonly ModelRelationPath<TRelations>[]) {
      return this.query().withMax(first, column, ...rest)
    },
    has(relation: ModelRelationPath<TRelations>) {
      return this.query().has(relation)
    },
    orHas(relation: ModelRelationPath<TRelations>) {
      return this.query().orHas(relation)
    },
    whereHas(relation: ModelRelationPath<TRelations>, constraint?: RelationConstraintCallback) {
      return this.query().whereHas(relation, constraint)
    },
    orWhereHas(relation: ModelRelationPath<TRelations>, constraint?: RelationConstraintCallback) {
      return this.query().orWhereHas(relation, constraint)
    },
    doesntHave(relation: ModelRelationPath<TRelations>) {
      return this.query().doesntHave(relation)
    },
    orDoesntHave(relation: ModelRelationPath<TRelations>) {
      return this.query().orDoesntHave(relation)
    },
    whereDoesntHave(relation: ModelRelationPath<TRelations>, constraint?: RelationConstraintCallback) {
      return this.query().whereDoesntHave(relation, constraint)
    },
    orWhereDoesntHave(relation: ModelRelationPath<TRelations>, constraint?: RelationConstraintCallback) {
      return this.query().orWhereDoesntHave(relation, constraint)
    },
    whereRelation<TRelationPath extends ModelRelationPath<TRelations>>(relation: TRelationPath, column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>, operator: unknown, value?: unknown) {
      return this.query().whereRelation(relation, column, operator, value)
    },
    orWhereRelation<TRelationPath extends ModelRelationPath<TRelations>>(relation: TRelationPath, column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>, operator: unknown, value?: unknown) {
      return this.query().orWhereRelation(relation, column, operator, value)
    },
    whereBelongsTo<TRelated extends TableDefinition>(entity: Entity<TRelated>, relationName?: ModelRelationPath<TRelations>) {
      return this.query().whereBelongsTo(entity, relationName)
    },
    orWhereBelongsTo<TRelated extends TableDefinition>(entity: Entity<TRelated>, relationName?: ModelRelationPath<TRelations>) {
      return this.query().orWhereBelongsTo(entity, relationName)
    },
    whereMorphedTo(relation: ModelRelationPath<TRelations>, target: MorphTypeSelector) {
      return this.query().whereMorphedTo(relation, target)
    },
    orWhereMorphedTo(relation: ModelRelationPath<TRelations>, target: MorphTypeSelector) {
      return this.query().orWhereMorphedTo(relation, target)
    },
    whereNotMorphedTo(relation: ModelRelationPath<TRelations>, target: MorphTypeSelector) {
      return this.query().whereNotMorphedTo(relation, target)
    },
    orWhereNotMorphedTo(relation: ModelRelationPath<TRelations>, target: MorphTypeSelector) {
      return this.query().orWhereNotMorphedTo(relation, target)
    },
    withWhereHas(relation: ModelRelationPath<TRelations>, constraint?: RelationConstraintCallback) {
      return this.query().withWhereHas(relation, constraint)
    },
    find(value: unknown) {
      return this.getRepository().find(value)
    },
    findMany(values: readonly unknown[]) {
      return this.getRepository().findMany(values)
    },
    findOrFail(value: unknown) {
      return this.getRepository().findOrFail(value)
    },
    findOrFailJson(value: unknown) {
      return this.query().findOrFailJson(value)
    },
    first() {
      return this.getRepository().first()
    },
    firstJson() {
      return this.query().firstJson()
    },
    firstOrFail() {
      return this.getRepository().firstOrFail()
    },
    sole() {
      return this.getRepository().sole()
    },
    soleJson() {
      return this.query().soleJson()
    },
    firstWhere(column: ModelColumnName<TTable>, operator: unknown, value?: unknown) {
      return this.getRepository().firstWhere(column, operator, value)
    },
    get() {
      return this.getRepository().get()
    },
    getJson() {
      return this.query().getJson()
    },
    all() {
      return this.getRepository().all()
    },
    paginate(perPage: number = 15, page: number = 1, options: PaginationOptions = {}) {
      return this.query().paginate(perPage, page, options)
    },
    paginateJson(perPage: number = 15, page: number = 1, options: PaginationOptions = {}) {
      return this.query().paginateJson(perPage, page, options)
    },
    simplePaginate(perPage: number = 15, page: number = 1, options: PaginationOptions = {}) {
      return this.query().simplePaginate(perPage, page, options)
    },
    simplePaginateJson(perPage: number = 15, page: number = 1, options: PaginationOptions = {}) {
      return this.query().simplePaginateJson(perPage, page, options)
    },
    cursorPaginate(perPage: number = 15, cursor: string | null = null, options: CursorPaginationOptions = {}) {
      return this.query().cursorPaginate(perPage, cursor, options)
    },
    cursorPaginateJson(perPage: number = 15, cursor: string | null = null, options: CursorPaginationOptions = {}) {
      return this.query().cursorPaginateJson(perPage, cursor, options)
    },
    chunk(size: number, callback: (rows: readonly EntityWithLoaded<TTable, TRelations, unknown>[], page: number) => unknown | Promise<unknown>) {
      return this.query().chunk(size, callback)
    },
    chunkById(size: number, callback: (rows: readonly EntityWithLoaded<TTable, TRelations, unknown>[], page: number) => unknown | Promise<unknown>, column?: ModelAttributeKey<TTable>) {
      return this.query().chunkById(size, callback, column)
    },
    chunkByIdDesc(size: number, callback: (rows: readonly EntityWithLoaded<TTable, TRelations, unknown>[], page: number) => unknown | Promise<unknown>, column?: ModelAttributeKey<TTable>) {
      return this.query().chunkByIdDesc(size, callback, column)
    },
    lazy(size: number = 1000) {
      return this.query().lazy(size)
    },
    cursor() {
      return this.query().cursor()
    },
    count() {
      return this.query().count()
    },
    exists() {
      return this.query().exists()
    },
    doesntExist() {
      return this.query().doesntExist()
    },
    pluck<TColumn extends ModelAttributeKey<TTable>>(column: TColumn) {
      return this.query().pluck(column)
    },
    value<TColumn extends ModelAttributeKey<TTable>>(column: TColumn) {
      return this.query().value(column)
    },
    valueOrFail<TColumn extends ModelAttributeKey<TTable>>(column: TColumn) {
      return this.query().valueOrFail(column)
    },
    soleValue<TColumn extends ModelAttributeKey<TTable>>(column: TColumn) {
      return this.query().soleValue(column)
    },
    sum(column: ModelColumnName<TTable>) {
      return this.query().sum(column)
    },
    avg(column: ModelColumnName<TTable>) {
      return this.query().avg(column)
    },
    min(column: ModelColumnName<TTable>) {
      return this.query().min(column)
    },
    max(column: ModelColumnName<TTable>) {
      return this.query().max(column)
    },
    withTrashed() {
      return this.getRepository().query().withTrashed()
    },
    onlyTrashed() {
      return this.getRepository().query().onlyTrashed()
    },
    create(values: Partial<ModelRecord<TTable>>) {
      return this.getRepository().create(values)
    },
    createMany(values: readonly Partial<ModelRecord<TTable>>[]) {
      return this.getRepository().createMany(values)
    },
    createQuietly(values: Partial<ModelRecord<TTable>>) {
      return this.getRepository().createQuietly(values)
    },
    createManyQuietly(values: readonly Partial<ModelRecord<TTable>>[]) {
      return this.getRepository().createManyQuietly(values)
    },
    update(id: unknown, values: ModelUpdatePayload<TTable>) {
      return this.getRepository().update(id, values)
    },
    prune() {
      return this.getRepository().prune()
    },
    increment(column: ModelColumnName<TTable>, amount: number = 1, extraValues: Partial<ModelRecord<TTable>> = {}) {
      return this.query().increment(column, amount, extraValues)
    },
    decrement(column: ModelColumnName<TTable>, amount: number = 1, extraValues: Partial<ModelRecord<TTable>> = {}) {
      return this.query().decrement(column, amount, extraValues)
    },
    delete(id: unknown) {
      return this.getRepository().delete(id)
    },
    destroy(ids: readonly unknown[]) {
      return this.getRepository().destroy(ids)
    },
    restore(id: unknown) {
      return this.getRepository().restore(id)
    },
    forceDelete(id: unknown) {
      return this.getRepository().forceDelete(id)
    },
    updateOrCreate(match: Partial<ModelRecord<TTable>>, values: Partial<ModelRecord<TTable>> = {}) {
      return this.getRepository().updateOrCreate(match, values)
    },
    upsert(match: Partial<ModelRecord<TTable>>, values: Partial<ModelRecord<TTable>> = {}) {
      return this.getRepository().upsert(match, values)
    },
    firstOrNew(match: Partial<ModelRecord<TTable>>, values: Partial<ModelRecord<TTable>> = {}) {
      return this.getRepository().firstOrNew(match, values)
    },
    firstOrCreate(match: Partial<ModelRecord<TTable>>, values: Partial<ModelRecord<TTable>> = {}) {
      return this.getRepository().firstOrCreate(match, values)
    },
    saveMany(entities: readonly EntityWithLoaded<TTable, TRelations, unknown>[]) {
      return this.getRepository().saveMany(entities)
    },
    resolveRelationUsing(name: string, resolver: DynamicRelationResolver) {
      registerDynamicRelation(definition, name, resolver)
      return this
    },
    make(values: Partial<ModelRecord<TTable>> = {}) {
      return this.getRepository().make(values)
    },
    getRepository() {
      return ModelRepository.from(definition)
    },
    getConnectionName() {
      return definition.connectionName
    },
    getTableName() {
      return definition.table.tableName
    },
  } as StaticModelApi<TTable, TScopes, TRelations>

  for (const [name, scope] of Object.entries(definition.scopes)) {
    const scoped = scope as (query: ModelQueryBuilder<TTable, TRelations>, ...args: readonly unknown[]) => ModelQueryBuilder<TTable, TRelations>
    ;(model as Record<string, unknown>)[name] = (...args: readonly unknown[]) => scoped(model.query(), ...args)
  }

  registerMorphModel(definition.morphClass, model)

  return Object.freeze(model) as unknown as StaticModelApi<TTable, TScopes, TRelations>
}
