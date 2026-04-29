/* v8 ignore file -- type declarations only */
import type { DatabaseContext } from '../core/DatabaseContext'
import type { GeneratedSchemaTable } from '../schema/generated'
import type { InferInsert, InferSelect, InferUpdate, TableDefinition } from '../schema/types'
import type { Entity, ModelBase, ModelRelationMethods } from './Entity'
import type { ModelQueryBuilder } from './ModelQueryBuilder'
import type { ModelCollection } from './collection'

export type ModelInsertPayload<TTable extends TableDefinition> = Partial<InferInsert<TTable>>
export type ModelUpdatePayload<TTable extends TableDefinition> = Partial<InferUpdate<TTable>>
export type ModelRecord<TTable extends TableDefinition> = InferSelect<TTable>
export type { GeneratedSchemaTable }
export type ModelAttributeKey<TTable extends TableDefinition> = Extract<keyof InferSelect<TTable>, string>
export type ModelColumnName<TTable extends TableDefinition> = ModelAttributeKey<TTable> | `${string}.${ModelAttributeKey<TTable>}`
export type ModelColumnReference<TTable extends TableDefinition> = ModelColumnName<TTable> | `${string}.${string}`
export type ModelJsonColumnPath<TTable extends TableDefinition> = ModelColumnName<TTable> | `${ModelColumnName<TTable>}->${string}`
export type ModelSelectableColumn<TTable extends TableDefinition> = ModelColumnName<TTable> | `${ModelColumnName<TTable>} as ${string}`
export interface AnyModelDefinition {
  readonly kind: 'model'
  readonly table: TableDefinition
  readonly name: string
  readonly primaryKey: string
  readonly connectionName?: string
  readonly morphClass: string
  readonly with: readonly string[]
  readonly pendingAttributes: Partial<Record<string, unknown>>
  readonly preventLazyLoading: boolean
  readonly preventAccessingMissingAttributes: boolean
  readonly automaticEagerLoading: boolean
  readonly timestamps: boolean
  readonly createdAtColumn?: string
  readonly updatedAtColumn?: string
  readonly fillable: readonly string[]
  readonly hasExplicitFillable?: boolean
  readonly guarded: readonly string[]
  readonly relations: RelationMap
  readonly casts: Record<string, ModelCastDefinition>
  readonly accessors: Record<string, ModelAccessor>
  readonly mutators: Record<string, ModelMutator>
  readonly hidden: readonly string[]
  readonly visible: readonly string[]
  readonly appended: readonly string[]
  readonly serializeDate?: ModelDateSerializer
  readonly massPrunable: boolean
  readonly touches: readonly string[]
  readonly replicationExcludes: readonly string[]
  readonly softDeletes: boolean
  readonly deletedAtColumn?: string
  readonly events: Partial<Record<ModelLifecycleEventName, readonly ModelLifecycleEventHandler[]>>
  readonly observers: readonly unknown[]
}
export type AnyModelReference = ModelReference
export interface AnyEntity {
  getRepository(): { definition: AnyModelDefinition }
  toAttributes(): Record<string, unknown>
  getChanges(): Record<string, unknown>
}
export type AnyModelQueryBuilder = ModelQueryBuilder<TableDefinition>
export type ModelDefinitionLike<TTable extends TableDefinition = TableDefinition>
  = | (AnyModelDefinition & { readonly table: TTable })
    | { readonly definition: AnyModelDefinition & { readonly table: TTable } }

export interface ModelScopeMap<TTable extends TableDefinition = TableDefinition> {
  readonly [key: string]: (query: ModelQueryBuilder<TTable>, ...args: readonly unknown[]) => ModelQueryBuilder<TTable>
}

export type RelationConstraintDefinition = (query: ModelQueryBuilder<TableDefinition>) => unknown

export interface ScopedRelationDefinition {
  readonly constraint?: RelationConstraintDefinition
}

export type ModelDefinitionTable<TReference extends ModelDefinitionLike>
  = TReference extends { readonly definition: { readonly table: infer TTable extends TableDefinition } }
    ? TTable
    : TReference extends { readonly table: infer TTable extends TableDefinition }
      ? TTable
      : TableDefinition

export type PivotTableColumnName<TPivotTable extends string | TableDefinition>
  = TPivotTable extends TableDefinition ? Extract<keyof InferSelect<TPivotTable>, string> : string

export interface BelongsToRelationDefinition<TRelated extends ModelDefinitionLike = ModelDefinitionLike> extends ScopedRelationDefinition {
  readonly kind: 'belongsTo'
  readonly related: () => TRelated
  readonly foreignKey: string
  readonly ownerKey: string
}

export interface HasManyRelationDefinition<TRelated extends ModelDefinitionLike = ModelDefinitionLike> extends ScopedRelationDefinition {
  readonly kind: 'hasMany'
  readonly related: () => TRelated
  readonly foreignKey: string
  readonly localKey: string
}

export interface HasOneRelationDefinition<TRelated extends ModelDefinitionLike = ModelDefinitionLike> extends ScopedRelationDefinition {
  readonly kind: 'hasOne'
  readonly related: () => TRelated
  readonly foreignKey: string
  readonly localKey: string
}

export interface HasOneOfManyRelationDefinition<TRelated extends ModelDefinitionLike = ModelDefinitionLike> extends ScopedRelationDefinition {
  readonly kind: 'hasOneOfMany'
  readonly related: () => TRelated
  readonly foreignKey: string
  readonly localKey: string
  readonly aggregateColumn: string
  readonly aggregate: 'min' | 'max'
}

export interface MorphOneRelationDefinition<TRelated extends ModelDefinitionLike = ModelDefinitionLike> extends ScopedRelationDefinition {
  readonly kind: 'morphOne'
  readonly related: () => TRelated
  readonly morphName: string
  readonly morphTypeColumn: string
  readonly morphIdColumn: string
  readonly localKey: string
}

export interface MorphManyRelationDefinition<TRelated extends ModelDefinitionLike = ModelDefinitionLike> extends ScopedRelationDefinition {
  readonly kind: 'morphMany'
  readonly related: () => TRelated
  readonly morphName: string
  readonly morphTypeColumn: string
  readonly morphIdColumn: string
  readonly localKey: string
}

export interface MorphOneOfManyRelationDefinition<TRelated extends ModelDefinitionLike = ModelDefinitionLike> extends ScopedRelationDefinition {
  readonly kind: 'morphOneOfMany'
  readonly related: () => TRelated
  readonly morphName: string
  readonly morphTypeColumn: string
  readonly morphIdColumn: string
  readonly localKey: string
  readonly aggregateColumn: string
  readonly aggregate: 'min' | 'max'
}

export interface MorphToRelationDefinition<TTable extends TableDefinition = TableDefinition> extends ScopedRelationDefinition {
  readonly kind: 'morphTo'
  readonly morphName: string
  readonly morphTypeColumn: string
  readonly morphIdColumn: string
}

export interface BelongsToManyRelationDefinition<
  TRelated extends ModelDefinitionLike = ModelDefinitionLike,
  TPivotTable extends string | TableDefinition = string | TableDefinition,
> extends ScopedRelationDefinition {
  readonly kind: 'belongsToMany'
  readonly related: () => TRelated
  readonly pivotTable: TPivotTable
  readonly foreignPivotKey: string
  readonly relatedPivotKey: string
  readonly parentKey: string
  readonly relatedKey: string
  readonly pivotColumns: readonly PivotTableColumnName<TPivotTable>[]
  readonly pivotWheres: readonly PivotWhereDefinition[]
  readonly pivotOrderBy: readonly PivotOrderDefinition[]
  readonly pivotAccessor: string
  readonly pivotModel?: () => ModelDefinitionLike
  withPivot(...columns: readonly PivotTableColumnName<TPivotTable>[]): BelongsToManyRelationDefinition<TRelated, TPivotTable>
  wherePivot(column: PivotTableColumnName<TPivotTable>, operator: unknown, value?: unknown): BelongsToManyRelationDefinition<TRelated, TPivotTable>
  orderByPivot(column: PivotTableColumnName<TPivotTable>, direction?: 'asc' | 'desc'): BelongsToManyRelationDefinition<TRelated, TPivotTable>
  as(accessor: string): BelongsToManyRelationDefinition<TRelated, TPivotTable>
  using(model: () => ModelDefinitionLike): BelongsToManyRelationDefinition<TRelated, TPivotTable>
}

export interface MorphToManyRelationDefinition<
  TRelated extends ModelDefinitionLike = ModelDefinitionLike,
  TPivotTable extends string | TableDefinition = string | TableDefinition,
> extends ScopedRelationDefinition {
  readonly kind: 'morphToMany'
  readonly related: () => TRelated
  readonly pivotTable: TPivotTable
  readonly morphName: string
  readonly morphTypeColumn: string
  readonly morphIdColumn: string
  readonly foreignPivotKey: string
  readonly parentKey: string
  readonly relatedKey: string
  readonly pivotColumns: readonly PivotTableColumnName<TPivotTable>[]
  readonly pivotWheres: readonly PivotWhereDefinition[]
  readonly pivotOrderBy: readonly PivotOrderDefinition[]
  readonly pivotAccessor: string
  readonly pivotModel?: () => ModelDefinitionLike
  withPivot(...columns: readonly PivotTableColumnName<TPivotTable>[]): MorphToManyRelationDefinition<TRelated, TPivotTable>
  wherePivot(column: PivotTableColumnName<TPivotTable>, operator: unknown, value?: unknown): MorphToManyRelationDefinition<TRelated, TPivotTable>
  orderByPivot(column: PivotTableColumnName<TPivotTable>, direction?: 'asc' | 'desc'): MorphToManyRelationDefinition<TRelated, TPivotTable>
  as(accessor: string): MorphToManyRelationDefinition<TRelated, TPivotTable>
  using(model: () => ModelDefinitionLike): MorphToManyRelationDefinition<TRelated, TPivotTable>
}

export interface MorphedByManyRelationDefinition<
  TRelated extends ModelDefinitionLike = ModelDefinitionLike,
  TPivotTable extends string | TableDefinition = string | TableDefinition,
> extends ScopedRelationDefinition {
  readonly kind: 'morphedByMany'
  readonly related: () => TRelated
  readonly pivotTable: TPivotTable
  readonly morphName: string
  readonly morphTypeColumn: string
  readonly morphIdColumn: string
  readonly foreignPivotKey: string
  readonly parentKey: string
  readonly relatedKey: string
  readonly pivotColumns: readonly PivotTableColumnName<TPivotTable>[]
  readonly pivotWheres: readonly PivotWhereDefinition[]
  readonly pivotOrderBy: readonly PivotOrderDefinition[]
  readonly pivotAccessor: string
  readonly pivotModel?: () => ModelDefinitionLike
  withPivot(...columns: readonly PivotTableColumnName<TPivotTable>[]): MorphedByManyRelationDefinition<TRelated, TPivotTable>
  wherePivot(column: PivotTableColumnName<TPivotTable>, operator: unknown, value?: unknown): MorphedByManyRelationDefinition<TRelated, TPivotTable>
  orderByPivot(column: PivotTableColumnName<TPivotTable>, direction?: 'asc' | 'desc'): MorphedByManyRelationDefinition<TRelated, TPivotTable>
  as(accessor: string): MorphedByManyRelationDefinition<TRelated, TPivotTable>
  using(model: () => ModelDefinitionLike): MorphedByManyRelationDefinition<TRelated, TPivotTable>
}

export interface PivotWhereDefinition {
  readonly column: string
  readonly operator: string
  readonly value: unknown
}

export interface PivotOrderDefinition {
  readonly column: string
  readonly direction: 'asc' | 'desc'
}

export interface PivotRelationMethods<
  TRelation,
  TPivotTable extends string | TableDefinition = string | TableDefinition,
> {
  withPivot(...columns: readonly PivotTableColumnName<TPivotTable>[]): TRelation
  wherePivot(column: PivotTableColumnName<TPivotTable>, operator: unknown, value?: unknown): TRelation
  orderByPivot(column: PivotTableColumnName<TPivotTable>, direction?: 'asc' | 'desc'): TRelation
  as(accessor: string): TRelation
  using(model: () => ModelDefinitionLike): TRelation
}

export interface HasOneThroughRelationDefinition<
  TRelated extends ModelDefinitionLike = ModelDefinitionLike,
  TThrough extends ModelDefinitionLike = ModelDefinitionLike,
> extends ScopedRelationDefinition {
  readonly kind: 'hasOneThrough'
  readonly related: () => TRelated
  readonly through: () => TThrough
  readonly firstKey: string
  readonly secondKey: string
  readonly localKey: string
  readonly secondLocalKey: string
}

export interface HasManyThroughRelationDefinition<
  TRelated extends ModelDefinitionLike = ModelDefinitionLike,
  TThrough extends ModelDefinitionLike = ModelDefinitionLike,
> extends ScopedRelationDefinition {
  readonly kind: 'hasManyThrough'
  readonly related: () => TRelated
  readonly through: () => TThrough
  readonly firstKey: string
  readonly secondKey: string
  readonly localKey: string
  readonly secondLocalKey: string
}

export type RelationDefinition
  = | BelongsToRelationDefinition
    | HasManyRelationDefinition
    | HasOneRelationDefinition
    | HasOneOfManyRelationDefinition
    | MorphOneRelationDefinition
    | MorphManyRelationDefinition
    | MorphOneOfManyRelationDefinition
    | MorphToRelationDefinition
    | BelongsToManyRelationDefinition
    | MorphToManyRelationDefinition
    | MorphedByManyRelationDefinition
    | HasOneThroughRelationDefinition
    | HasManyThroughRelationDefinition

/**
 * Methods available on BelongsTo relations when called as a method (e.g., post.category())
 */
export interface BelongsToRelationMethods<TRelated> {
  associate(related: TRelated | null): void
  dissociate(): void
}

/**
 * Methods available on HasOne/HasOneThrough relations when called as a method
 */
export interface HasOneRelationMethods<TRelated> {
  create(values: Record<string, unknown>): Promise<TRelated>
  save(related: TRelated): Promise<TRelated>
}

/**
 * Methods available on HasMany/HasManyThrough relations when called as a method
 */
export interface HasManyRelationMethods<TRelated> {
  create(values: Record<string, unknown>): Promise<TRelated>
  createMany(values: readonly Record<string, unknown>[]): Promise<TRelated[]>
  save(related: TRelated): Promise<TRelated>
  saveMany(related: readonly TRelated[]): Promise<TRelated[]>
}

/**
 * Methods available on BelongsToMany relations when called as a method (e.g., post.tags())
 */
export interface BelongsToManyRelationMethods<TRelated, TPivot = Record<string, unknown>> {
  attach(ids: unknown | readonly unknown[], attributes?: TPivot): Promise<void>
  detach(ids?: unknown | readonly unknown[]): Promise<number>
  sync(ids: unknown): Promise<{ attached: unknown[], detached: unknown[], updated: unknown[] }>
  toggle(ids: unknown): Promise<{ attached: unknown[], detached: unknown[] }>
  updateExistingPivot(id: unknown, attributes: TPivot): Promise<number>
  create(values: Record<string, unknown>): Promise<TRelated>
  save(related: TRelated): Promise<TRelated>
}

/**
 * Converts a RelationDefinition to its corresponding methods type
 */
export type RelationMethodsOf<TRelation extends RelationDefinition>
  = TRelation extends BelongsToRelationDefinition
    ? BelongsToRelationMethods<unknown>
    : TRelation extends HasOneRelationDefinition
      ? HasOneRelationMethods<unknown>
      : TRelation extends HasOneOfManyRelationDefinition
        ? HasOneRelationMethods<unknown>
        : TRelation extends HasManyRelationDefinition
          ? HasManyRelationMethods<unknown>
          : TRelation extends HasOneThroughRelationDefinition
            ? HasOneRelationMethods<unknown>
            : TRelation extends HasManyThroughRelationDefinition
              ? HasManyRelationMethods<unknown>
              : TRelation extends BelongsToManyRelationDefinition<ModelDefinitionLike, infer TPivot>
                ? BelongsToManyRelationMethods<unknown, TPivot>
                : TRelation extends MorphOneRelationDefinition
                  ? HasOneRelationMethods<unknown>
                  : TRelation extends MorphManyRelationDefinition
                    ? HasManyRelationMethods<unknown>
                    : TRelation extends MorphToManyRelationDefinition<ModelDefinitionLike, infer TPivot>
                      ? BelongsToManyRelationMethods<unknown, TPivot>
                      : TRelation extends MorphedByManyRelationDefinition<ModelDefinitionLike, infer TPivot>
                        ? BelongsToManyRelationMethods<unknown, TPivot>
                        : never

export interface RelationMap {
  readonly [key: string]: RelationDefinition
}

export type ModelRelationName<TRelations extends RelationMap = RelationMap> = Extract<keyof TRelations, string>
export type ModelRelationPath<TRelations extends RelationMap = RelationMap>
  = InternalRelationPath<TRelations, 15>

type InternalRelationPath<TRelations extends RelationMap, TDepth extends number>
  = | ModelRelationName<TRelations>
    | NestedRelationPath<TRelations, TDepth>

type Prev = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]

type NestedRelationPath<TRelations extends RelationMap, TDepth extends number>
  = TDepth extends 0
    ? never
    : string extends ModelRelationName<TRelations>
      ? `${string}.${string}`
      : {
          [K in ModelRelationName<TRelations>]:
            TRelations[K] extends { readonly kind: 'morphTo' }
              ? `${K}.${string}`
              : TRelations[K] extends { readonly related: () => infer TRef }
                ? `${K}.${InternalRelationPath<RelatedRelationsOfDefinition<TRef>, Prev[TDepth]>}`
                : never
        }[ModelRelationName<TRelations>]

type RelationRootName<
  TRelations extends RelationMap,
  TRelationPath extends ModelRelationPath<TRelations>,
> = TRelationPath extends `${infer TRoot}.${string}`
  ? TRoot extends ModelRelationName<TRelations>
    ? TRoot
    : never
  : TRelationPath extends ModelRelationName<TRelations>
    ? TRelationPath
    : never

export type RelatedTableOfRelation<TRelation extends RelationDefinition>
  = TRelation extends { readonly related: () => infer TReference extends ModelDefinitionLike }
    ? ModelDefinitionTable<TReference>
    : TableDefinition

export type RelatedColumnNameOfRelation<TRelation extends RelationDefinition>
  = ModelAttributeKey<RelatedTableOfRelation<TRelation>>

export type RelatedColumnNameForRelationPath<
  TRelations extends RelationMap,
  TRelationPath extends ModelRelationPath<TRelations>,
> = RelatedColumnNameOfRelation<TRelations[RelationRootName<TRelations, TRelationPath>]>

// ---------------------------------------------------------------------------
// Eager-load type resolution
// ---------------------------------------------------------------------------

/**
 * Extracts the RelationMap from a related model definition referenced by a
 * relation. This enables recursive type resolution for nested eager loads
 * like `'posts.comments'`.
 */
export type RelatedRelationsOfDefinition<TRef>
  = TRef extends { readonly relations: infer R extends RelationMap } ? R
    : TRef extends { readonly definition: { readonly relations: infer R extends RelationMap } } ? R
      : RelationMap

export type RelatedRelationsOfRelation<TRelation extends RelationDefinition>
  = TRelation extends { readonly related: () => infer TRef }
    ? RelatedRelationsOfDefinition<TRef>
    : RelationMap

/** True for relation kinds that resolve to an array of entities. */
type IsToManyRelation<TRelation extends RelationDefinition>
  = TRelation extends { readonly kind: 'hasMany' | 'belongsToMany' | 'morphMany' | 'morphToMany' | 'morphedByMany' | 'hasManyThrough' }
    ? true
    : false

/** Resolves a single (non-nested) relation to its typed entity shape. */
type ResolveRelationEntity<TRelation extends RelationDefinition>
  = Entity<RelatedTableOfRelation<TRelation>, RelatedRelationsOfRelation<TRelation>>

type ResolveNestedRelationEntity<TRelation extends RelationDefinition, TLoaded>
  = EntityWithLoaded<
    RelatedTableOfRelation<TRelation>,
    RelatedRelationsOfRelation<TRelation>,
    TLoaded
  >

/**
 * Wraps a base entity type in the correct cardinality for a relation:
 * - to-many  → `TEntity[]`
 * - to-one   → `TEntity | null`
 */
type WrapRelationCardinality<TRelation extends RelationDefinition, TEntity>
  = IsToManyRelation<TRelation> extends true ? TEntity[] : TEntity | null

/**
 * Recursively resolves a dot-separated eager-load path against a RelationMap.
 *
 * - `'posts'`            → `{ posts: Entity<PostsTable>[] }`
 * - `'posts.comments'`   → `{ posts: (Entity<PostsTable> & { comments: Entity<CommentsTable>[] })[] }`
 * - `'profile'`          → `{ profile: Entity<ProfileTable> | null }`
 *
 * Depth is bounded by TS's recursion limit (~25), but real-world nesting
 * rarely exceeds 3-4 levels.
 */
export type ResolveEagerLoadPath<TRelations extends RelationMap, TPath extends string>
  = string extends TPath
    ? unknown
    : TPath extends `${infer TRoot}.${infer TRest}`
      ? TRoot extends keyof TRelations & string
        ? TRelations[TRoot] extends { readonly kind: 'morphTo' }
          ? {
              readonly [K in TRoot]: WrapRelationCardinality<
                TRelations[TRoot],
                ResolveRelationEntity<TRelations[TRoot]>
              >
            }
          : {
              readonly [K in TRoot]: WrapRelationCardinality<
                TRelations[TRoot],
                ResolveNestedRelationEntity<
                  TRelations[TRoot],
                  ResolveEagerLoadPath<RelatedRelationsOfRelation<TRelations[TRoot]>, TRest>
                >
              >
            }
        : never
      : TPath extends keyof TRelations & string
        ? {
            readonly [K in TPath]: WrapRelationCardinality<
              TRelations[TPath],
              ResolveRelationEntity<TRelations[TPath]>
            >
          }
        : never

/**
 * Merges multiple eager-load paths into a single intersection type.
 * Used by `with()` and `load()` to accumulate loaded relation shapes.
 */
export type ResolveEagerLoads<
  TRelations extends RelationMap,
  TPaths extends readonly string[],
> = TPaths extends readonly []
  ? unknown
  : TPaths extends readonly [infer TFirst extends string, ...infer TRest extends readonly string[]]
    ? ResolveEagerLoadPath<TRelations, TFirst> & ResolveEagerLoads<TRelations, TRest>
    : ResolveEagerLoadUnion<TRelations, TPaths[number]>

/**
 * Converts a union to an intersection via distributive conditional types.
 * `A | B` → `A & B`
 */
type UnionToIntersection<TUnion>
  = (TUnion extends unknown ? (x: TUnion) => void : never) extends (x: infer TIntersection) => void
    ? TIntersection
    : never

/**
 * Resolves a union of eager-load paths into an intersection of their
 * resolved shapes. Used by the object-form `with()` overload where
 * the paths come from `keyof TMap` (a union, not a tuple).
 */
export type ResolveEagerLoadUnion<
  TRelations extends RelationMap,
  TPaths extends string,
> = UnionToIntersection<
  TPaths extends unknown ? ResolveEagerLoadPath<TRelations, TPaths> : never
>

/**
 * Recursively converts an eager-loaded shape from entity types to their
 * serialized (JSON) form. Replaces `Entity<T>` with `ModelRecord<T>` and
 * recurses into nested loaded relations.
 *
 * - `Entity<T>[]`        → `ModelRecord<T>[]`
 * - `Entity<T> | null`   → `ModelRecord<T> | null`
 * - `Entity<T> & { r: Entity<U>[] }` → `ModelRecord<T> & { r: ModelRecord<U>[] }`
 */
type SerializeLoadedValue<TValue>
  = TValue extends readonly (infer TItem)[]
    ? SerializeLoadedValue<TItem>[]
    : TValue extends null
      ? null
      : TValue extends Entity<infer TTable, infer _TRelations>
        ? ModelRecord<TTable> & SerializeLoaded<Omit<TValue, keyof Entity<TTable, _TRelations>>>
        : TValue

export type SerializeLoaded<TLoaded>
  = unknown extends TLoaded
    ? unknown
    : { readonly [K in keyof TLoaded]: SerializeLoadedValue<TLoaded[K]> }

/**
 * The serialized (JSON) form of an entity with eager-loaded relations.
 * This is the return type of `toJSON()` when called on an entity that
 * has loaded relations via `with()` or `load()`.
 */
export type SerializedEntityWithLoaded<
  TTable extends TableDefinition,
  TLoaded,
> = ModelRecord<TTable> & SerializeLoaded<TLoaded>

/**
 * The entity type returned by terminal query methods when eager loads
 * have been accumulated via `with()`.
 */
export type EntityWithLoaded<
  TTable extends TableDefinition,
  TRelations extends RelationMap,
  TLoaded,
> = ModelBase<TTable, TRelations>
  & Omit<ModelRelationMethods<TRelations>, Extract<keyof TLoaded, string>>
  & TLoaded & {
  toJSON(): SerializedEntityWithLoaded<TTable, TLoaded>
}

export type PivotTableOfRelation<TRelation extends RelationDefinition>
  = TRelation extends { readonly pivotTable: infer TPivotTable extends string | TableDefinition }
    ? TPivotTable
    : string

export type PivotColumnNameOfRelation<TRelation extends RelationDefinition>
  = PivotTableColumnName<PivotTableOfRelation<TRelation>>

export type EmptyScopeMap = Record<never, never>
export type ModelScopesDefinition = Readonly<Record<string, unknown>>

export type ModelLifecycleEventName
  = | 'retrieved'
    | 'creating'
    | 'created'
    | 'updating'
    | 'updated'
    | 'saving'
    | 'saved'
    | 'deleting'
    | 'trashed'
    | 'forceDeleting'
    | 'forceDeleted'
    | 'restoring'
    | 'restored'
    | 'deleted'
    | 'replicating'

export type ModelLifecycleEventHandler = (...args: readonly unknown[]) => unknown | Promise<unknown>
export type BuiltInCastName
  = | 'boolean'
    | 'number'
    | 'string'
    | 'json'
    | 'date'
    | 'datetime'
    | 'timestamp'
    | 'vector'
export type BuiltInCastString = BuiltInCastName | `${BuiltInCastName}:${string}`
export type UniqueIdTraitKind = 'uuid' | 'ulid' | 'snowflake' | 'custom'
export type RelationAggregateKind = 'count' | 'exists' | 'sum' | 'avg' | 'min' | 'max'
export interface EnumCastDefinition {
  readonly kind: 'enum'
  readonly enumObject: Readonly<Record<string, string | number>>
  readonly values: readonly (string | number)[]
}
export interface CastableDefinition {
  castUsing(): ModelCastDefinition
}
export type ModelCastDefinition = BuiltInCastString | EnumCastDefinition | CastableDefinition | {
  get?: (value: unknown) => unknown
  set?: (value: unknown) => unknown
}
export type ModelAccessor = (value: unknown, entity: AnyEntity) => unknown
export type ModelMutator = (value: unknown, entity?: AnyEntity) => unknown
export type ModelDateSerializer = (value: Date) => unknown
export type ModelCollectionFactory<
  TTable extends TableDefinition = TableDefinition,
  TRelations extends RelationMap = RelationMap,
> = <TItem extends Entity<TTable, TRelations>>(items: readonly TItem[]) => ModelCollection<TTable, TRelations, TItem>
export type ModelPrunableDefinition<
  TTable extends TableDefinition = TableDefinition,
  TRelations extends RelationMap = RelationMap,
> = (query: ModelQueryBuilder<TTable, TRelations>) => unknown

export interface UniqueIdTrait<TTable extends TableDefinition = TableDefinition> {
  readonly kind: 'uniqueIds'
  readonly name: string
  readonly type: UniqueIdTraitKind
  readonly columns?: readonly ModelAttributeKey<TTable>[]
  readonly generator?: () => string
}

export type ModelTrait<TTable extends TableDefinition = TableDefinition> = UniqueIdTrait<TTable>

export interface UniqueIdRuntimeConfig<TTable extends TableDefinition = TableDefinition> {
  readonly usesUniqueIds: boolean
  readonly columns: readonly ModelAttributeKey<TTable>[]
  readonly generator: () => string
  readonly traitName: string
  readonly traitType: UniqueIdTraitKind
}

export interface DefineModelOptions<
  TTable extends TableDefinition = TableDefinition,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
  TRelations extends RelationMap = RelationMap,
> {
  name?: string
  primaryKey?: ModelAttributeKey<TTable>
  connectionName?: string
  morphClass?: string
  with?: readonly string[]
  pendingAttributes?: Partial<InferInsert<TTable>>
  preventLazyLoading?: boolean
  preventAccessingMissingAttributes?: boolean
  automaticEagerLoading?: boolean
  timestamps?: boolean
  createdAtColumn?: ModelAttributeKey<TTable>
  updatedAtColumn?: ModelAttributeKey<TTable>
  fillable?: readonly (ModelAttributeKey<TTable> | '*')[]
  guarded?: readonly (ModelAttributeKey<TTable> | '*')[]
  scopes?: TScopes
  globalScopes?: ModelScopeMap<TTable>
  relations?: TRelations
  casts?: Record<string, ModelCastDefinition>
  accessors?: Record<string, ModelAccessor>
  mutators?: Record<string, ModelMutator>
  hidden?: readonly string[]
  visible?: readonly string[]
  appended?: readonly string[]
  serializeDate?: ModelDateSerializer
  collection?: ModelCollectionFactory<TTable>
  prunable?: ModelPrunableDefinition<TTable>
  massPrunable?: boolean
  touches?: readonly string[]
  traits?: readonly ModelTrait<TTable>[]
  uniqueIds?: readonly ModelAttributeKey<TTable>[]
  newUniqueId?: () => string
  replicationExcludes?: readonly string[]
  softDeletes?: boolean
  deletedAtColumn?: ModelAttributeKey<TTable>
  events?: Partial<Record<ModelLifecycleEventName, ModelLifecycleEventHandler | readonly ModelLifecycleEventHandler[]>>
  observers?: readonly unknown[]
}

export interface ModelDefinition<
  TTable extends TableDefinition = TableDefinition,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
  TRelations extends RelationMap = RelationMap,
> {
  readonly kind: 'model'
  readonly table: TTable
  readonly name: string
  readonly primaryKey: ModelAttributeKey<TTable>
  readonly connectionName?: string
  readonly morphClass: string
  readonly with: readonly string[]
  readonly pendingAttributes: Partial<InferInsert<TTable>>
  readonly preventLazyLoading: boolean
  readonly preventAccessingMissingAttributes: boolean
  readonly automaticEagerLoading: boolean
  readonly timestamps: boolean
  readonly createdAtColumn?: ModelAttributeKey<TTable>
  readonly updatedAtColumn?: ModelAttributeKey<TTable>
  readonly fillable: readonly string[]
  readonly hasExplicitFillable?: boolean
  readonly guarded: readonly string[]
  readonly scopes: TScopes
  readonly globalScopes: ModelScopeMap<TTable>
  readonly relations: TRelations
  readonly casts: Record<string, ModelCastDefinition>
  readonly accessors: Record<string, ModelAccessor>
  readonly mutators: Record<string, ModelMutator>
  readonly hidden: readonly string[]
  readonly visible: readonly string[]
  readonly appended: readonly string[]
  readonly serializeDate?: ModelDateSerializer
  readonly collection?: ModelCollectionFactory<TTable>
  readonly prunable?: ModelPrunableDefinition<TTable>
  readonly massPrunable: boolean
  readonly touches: readonly string[]
  readonly traits: readonly ModelTrait<TTable>[]
  readonly uniqueIdConfig: UniqueIdRuntimeConfig<TTable> | null
  readonly replicationExcludes: readonly string[]
  readonly softDeletes: boolean
  readonly deletedAtColumn?: ModelAttributeKey<TTable>
  readonly events: Partial<Record<ModelLifecycleEventName, readonly ModelLifecycleEventHandler[]>>
  readonly observers: readonly unknown[]
}

export interface ModelReference<
  TTable extends TableDefinition = TableDefinition,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
  TRelations extends RelationMap = RelationMap,
> {
  readonly definition: ModelDefinition<TTable, TScopes, TRelations>
}

export type DynamicRelationResolver = () => RelationDefinition
export type ModelMorphLoadMap = Readonly<Record<string, string | readonly string[] | Readonly<Record<string, RelationConstraintDefinition>>>>
export type ModelAggregateLoad = {
  readonly relation: string
  readonly kind: RelationAggregateKind
  readonly column?: string
  readonly alias?: string
  readonly constraint?: RelationConstraintDefinition
}

export type ModelScopeArgs<TScope>
  = TScope extends (query: unknown, ...args: infer TArgs) => unknown ? TArgs : never

export type ModelScopeMethods<
  TTable extends TableDefinition,
  TScopes extends ModelScopesDefinition,
  TRelations extends RelationMap = RelationMap,
> = {
  [K in keyof TScopes]:
  TScopes[K] extends (query: ModelQueryBuilder<TTable, TRelations>, ...args: infer TArgs) => ModelQueryBuilder<TTable, TRelations>
    ? (...args: TArgs) => ModelQueryBuilder<TTable, TRelations>
    : never
}

export interface ModelRepositoryLike<
  TTable extends TableDefinition = TableDefinition,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
  TRelations extends RelationMap = RelationMap,
> {
  readonly definition: ModelDefinition<TTable, TScopes, TRelations>
  getConnection(): DatabaseContext
}
