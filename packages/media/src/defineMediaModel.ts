import { morphMany } from '@holo-js/db'
import {
  normalizeMediaDefinition,
  resolveMediaDefinition,
  type CollectionNamesOf,
  type ConversionNamesOf,
  type MediaDefinitionFactory,
  type MediaDefinitionInput,
} from './definitions/config'
import { Media } from './model/Media'
import { installEntityMediaMethods } from './model/entity'
import { observeMediaModelDeletion } from './model/observer'
import { registerMediaDefinition } from './registry'
import type {
  CursorPaginatedResult,
  DynamicRelationResolver,
  Entity,
  ModelCollection,
  ModelRelationName,
  ModelRelationPath,
  ModelQueryBuilder,
  PaginatedResult,
  RelatedColumnNameForRelationPath,
  RelationAggregateMethods,
  RelationAggregateQueryResult,
  RelationConstraintFor,
  RelationConstraintMap,
  RelationMap,
  ResolveEagerLoads,
  SimplePaginatedResult,
  TableDefinition,
  WithAggregateAttributes,
} from '@holo-js/db'
import type { MediaAdder, MediaSourceInput } from './model/adder'
import type { MediaItem } from './model/item'

type MediaCollectionName<TDefinition extends MediaDefinitionInput>
  = 'default' | CollectionNamesOf<TDefinition>

type MediaConversionName<TDefinition extends MediaDefinitionInput>
  = ConversionNamesOf<TDefinition>

export type MediaEnabledEntity<
  TTable extends TableDefinition = TableDefinition,
  TCollectionName extends string = string,
  TConversionName extends string = string,
  TRelations extends RelationMap = RelationMap,
> = Entity<TTable, TRelations> & MediaEnabledEntityMethods<
  TCollectionName,
  TConversionName
>

type MediaEnabledEntityMethods<
  TCollectionName extends string,
  TConversionName extends string,
> = {
  addMedia(source: MediaSourceInput): MediaAdder<Entity<TableDefinition>, TCollectionName, TConversionName>
  addMediaFromUrl(url: string): MediaAdder<Entity<TableDefinition>, TCollectionName, TConversionName>
  addMediaFromDisk(path: string, disk: string): MediaAdder<Entity<TableDefinition>, TCollectionName, TConversionName>
  getMedia(collectionName?: TCollectionName): Promise<MediaItem<TCollectionName, TConversionName, Entity<TableDefinition>>[]>
  getMediaUrls(collectionName?: TCollectionName, conversionName?: TConversionName): Promise<string[]>
  getMediaPaths(collectionName?: TCollectionName, conversionName?: TConversionName): Promise<string[]>
  getFirstMedia(collectionName?: TCollectionName): Promise<MediaItem<TCollectionName, TConversionName, Entity<TableDefinition>> | null>
  getFirstMediaUrl(collectionName?: TCollectionName, conversionName?: TConversionName): Promise<string | null>
  getFirstMediaPath(collectionName?: TCollectionName, conversionName?: TConversionName): Promise<string | null>
  getFirstTemporaryUrl(
    collectionName?: TCollectionName,
    conversionName?: TConversionName,
    options?: { expiresAt?: Date | number | string, expiresIn?: number },
  ): Promise<string | null>
  hasMedia(collectionName?: TCollectionName): Promise<boolean>
  clearMediaCollection(collectionName?: TCollectionName): Promise<void>
  regenerateMedia(collectionName?: TCollectionName, conversions?: TConversionName | readonly TConversionName[]): Promise<void>
}

type MediaEnabledFunction<
  TFunction,
  TCollectionName extends string,
  TConversionName extends string,
> = TFunction extends {
  (...args: infer TArgs1): infer TReturn1
  (...args: infer TArgs2): infer TReturn2
  (...args: infer TArgs3): infer TReturn3
  (...args: infer TArgs4): infer TReturn4
}
  ? {
      (...args: TArgs1): MediaEnabledResult<TReturn1, TCollectionName, TConversionName>
      (...args: TArgs2): MediaEnabledResult<TReturn2, TCollectionName, TConversionName>
      (...args: TArgs3): MediaEnabledResult<TReturn3, TCollectionName, TConversionName>
      (...args: TArgs4): MediaEnabledResult<TReturn4, TCollectionName, TConversionName>
    }
  : TFunction extends {
    (...args: infer TArgs1): infer TReturn1
    (...args: infer TArgs2): infer TReturn2
    (...args: infer TArgs3): infer TReturn3
  }
    ? {
        (...args: TArgs1): MediaEnabledResult<TReturn1, TCollectionName, TConversionName>
        (...args: TArgs2): MediaEnabledResult<TReturn2, TCollectionName, TConversionName>
        (...args: TArgs3): MediaEnabledResult<TReturn3, TCollectionName, TConversionName>
      }
    : TFunction extends {
      (...args: infer TArgs1): infer TReturn1
      (...args: infer TArgs2): infer TReturn2
    }
      ? {
          (...args: TArgs1): MediaEnabledResult<TReturn1, TCollectionName, TConversionName>
          (...args: TArgs2): MediaEnabledResult<TReturn2, TCollectionName, TConversionName>
        }
      : TFunction extends (...args: infer TArgs) => infer TReturn
        ? (...args: TArgs) => MediaEnabledResult<TReturn, TCollectionName, TConversionName>
        : TFunction

type MediaRelationCallbackMethod
  = 'whereHas'
    | 'orWhereHas'
    | 'whereDoesntHave'
    | 'orWhereDoesntHave'
    | 'whereRelation'
    | 'orWhereRelation'
    | 'withWhereHas'
    | AggregateMethodName

type MediaEnabledQueryBuilder<
  TBuilder,
  TCollectionName extends string,
  TConversionName extends string,
> = {
  [K in keyof TBuilder]: K extends 'with'
    ? MediaEnabledQueryBuilderWith<TBuilder, TCollectionName, TConversionName>
    : K extends AggregateMethodName
      ? MediaAggregateMethods<TBuilder, TCollectionName, TConversionName>[K]
    : K extends 'whereHas' | 'orWhereHas' | 'whereDoesntHave' | 'orWhereDoesntHave'
      ? MediaEnabledRelationFilter<TBuilder, TCollectionName, TConversionName>
    : K extends 'whereRelation' | 'orWhereRelation'
      ? MediaEnabledRelationColumnFilter<TBuilder, TCollectionName, TConversionName>
    : K extends 'withWhereHas'
      ? MediaEnabledWithWhereHas<TBuilder, TCollectionName, TConversionName>
    : MediaEnabledFunction<TBuilder[K], TCollectionName, TConversionName>
}

type MediaEnabledPaginatedResult<
  TResult,
  TPaginator,
  TCollectionName extends string,
  TConversionName extends string,
> = Omit<TResult, keyof TPaginator>
  & TPaginator
  & (TResult extends { readonly data: infer TData }
    ? { readonly data: MediaEnabledResult<TData, TCollectionName, TConversionName> }
    : Record<never, never>)

type MediaEnabledResult<
  TValue,
  TCollectionName extends string,
  TConversionName extends string,
> = TValue extends Promise<infer TResult>
  ? Promise<MediaEnabledResult<TResult, TCollectionName, TConversionName>>
  : TValue extends AsyncGenerator<infer TYield, infer TReturn, infer TNext>
    ? AsyncGenerator<MediaEnabledResult<TYield, TCollectionName, TConversionName>, TReturn, TNext>
    : TValue extends { toAttributes(): object, getLoadedRelations(): Readonly<Record<string, unknown>> }
      ? TValue & MediaEnabledEntityMethods<TCollectionName, TConversionName>
    : TValue extends ModelQueryBuilder<infer TTable extends TableDefinition, infer TRelations extends RelationMap, infer TLoaded, infer TScopes extends Readonly<Record<string, unknown>>>
      ? MediaEnabledQueryBuilder<ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>, TCollectionName, TConversionName>
      : TValue extends ModelCollection<infer TTable extends TableDefinition, infer TRelations extends RelationMap, infer TItem, infer TScopes extends Readonly<Record<string, unknown>>>
        ? ModelCollection<TTable, TRelations, MediaEnabledResult<TItem, TCollectionName, TConversionName>, TScopes>
        : TValue extends PaginatedResult<infer TItem>
          ? MediaEnabledPaginatedResult<
              TValue,
              PaginatedResult<MediaEnabledResult<TItem, TCollectionName, TConversionName>>,
              TCollectionName,
              TConversionName
            >
          : TValue extends SimplePaginatedResult<infer TItem>
            ? MediaEnabledPaginatedResult<
                TValue,
                SimplePaginatedResult<MediaEnabledResult<TItem, TCollectionName, TConversionName>>,
                TCollectionName,
                TConversionName
              >
            : TValue extends CursorPaginatedResult<infer TItem>
              ? MediaEnabledPaginatedResult<
                  TValue,
                  CursorPaginatedResult<MediaEnabledResult<TItem, TCollectionName, TConversionName>>,
                  TCollectionName,
                  TConversionName
                >
              : TValue

type MediaModelStatic = {
  readonly definition: {
    readonly name: string
    readonly softDeletes: boolean
    readonly table: TableDefinition
  }
  readonly resolveRelationUsing: (name: string, resolver: DynamicRelationResolver) => unknown
}

type MediaRelationPath<TRelations extends RelationMap>
  = ModelRelationPath<TRelations>

type MediaEnabledQueryBuilderWith<
  TBuilder,
  TCollectionName extends string,
  TConversionName extends string,
> = TBuilder extends ModelQueryBuilder<infer TTable extends TableDefinition, infer TRelations extends RelationMap, infer TLoaded, infer TScopes extends Readonly<Record<string, unknown>>>
  ? {
      <TPaths extends readonly MediaRelationPath<TRelations>[]>(
        ...relations: TPaths
      ): MediaEnabledQueryBuilder<
        ModelQueryBuilder<TTable, TRelations, TLoaded & ResolveEagerLoads<TRelations, TPaths>, TScopes>,
        TCollectionName,
        TConversionName
      >
      <TPath extends MediaRelationPath<TRelations>>(
        relation: TPath,
        constraint: RelationConstraintFor<TRelations, TPath>
      ): MediaEnabledQueryBuilder<
        ModelQueryBuilder<TTable, TRelations, TLoaded & ResolveEagerLoads<TRelations, readonly [TPath]>, TScopes>,
        TCollectionName,
        TConversionName
      >
      (
        relations: RelationConstraintMap<TRelations>
      ): MediaEnabledQueryBuilder<ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>, TCollectionName, TConversionName>
      <TPaths extends readonly MediaRelationPath<TRelations>[]>(
        relations: TPaths
      ): MediaEnabledQueryBuilder<
        ModelQueryBuilder<TTable, TRelations, TLoaded & ResolveEagerLoads<TRelations, TPaths>, TScopes>,
        TCollectionName,
        TConversionName
      >
    }
  : TBuilder extends { with: infer TWith }
    ? MediaEnabledFunction<TWith, TCollectionName, TConversionName>
    : never

type AggregateMethodName = keyof RelationAggregateMethods<RelationMap, RelationAggregateQueryResult>

interface MediaAggregateBuilderResult<
  TTable extends TableDefinition,
  TRelations extends RelationMap,
  TLoaded,
  TScopes extends Readonly<Record<string, unknown>>,
  TJoinedTables extends string,
  TCollectionName extends string,
  TConversionName extends string,
> extends RelationAggregateQueryResult {
  readonly query: MediaEnabledQueryBuilder<
    ModelQueryBuilder<TTable, TRelations, WithAggregateAttributes<TLoaded, this['attributes']>, TScopes, TJoinedTables>,
    TCollectionName,
    TConversionName
  >
}

type MediaAggregateMethods<
  TBuilder,
  TCollectionName extends string,
  TConversionName extends string,
> = TBuilder extends ModelQueryBuilder<infer TTable, infer TRelations, infer TLoaded, infer TScopes, infer TJoinedTables>
  ? RelationAggregateMethods<
      TRelations,
      MediaAggregateBuilderResult<TTable, TRelations, TLoaded, TScopes, TJoinedTables, TCollectionName, TConversionName>,
      readonly [ModelRelationName<TRelations>, ...ModelRelationName<TRelations>[]]
    >
  : never

type MediaEnabledRelationFilter<
  TBuilder,
  TCollectionName extends string,
  TConversionName extends string,
> = TBuilder extends ModelQueryBuilder<infer TTable extends TableDefinition, infer TRelations extends RelationMap, infer TLoaded, infer TScopes extends Readonly<Record<string, unknown>>>
  ? <TPath extends MediaRelationPath<TRelations>>(
      relation: TPath,
      constraint?: RelationConstraintFor<TRelations, TPath>,
    ) => MediaEnabledQueryBuilder<ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>, TCollectionName, TConversionName>
  : never

type MediaEnabledRelationColumnFilter<
  TBuilder,
  TCollectionName extends string,
  TConversionName extends string,
> = TBuilder extends ModelQueryBuilder<infer TTable extends TableDefinition, infer TRelations extends RelationMap, infer TLoaded, infer TScopes extends Readonly<Record<string, unknown>>>
  ? <TRelationPath extends MediaRelationPath<TRelations>>(
      relation: TRelationPath,
      column: RelatedColumnNameForRelationPath<TRelations, TRelationPath>,
      operator: unknown,
      value?: unknown,
    ) => MediaEnabledQueryBuilder<ModelQueryBuilder<TTable, TRelations, TLoaded, TScopes>, TCollectionName, TConversionName>
  : never

type MediaEnabledWithWhereHas<
  TBuilder,
  TCollectionName extends string,
  TConversionName extends string,
> = TBuilder extends ModelQueryBuilder<infer TTable extends TableDefinition, infer TRelations extends RelationMap, infer TLoaded, infer TScopes extends Readonly<Record<string, unknown>>>
  ? <TPath extends MediaRelationPath<TRelations>>(
      relation: TPath,
      constraint?: RelationConstraintFor<TRelations, TPath>,
    ) => MediaEnabledQueryBuilder<
      ModelQueryBuilder<TTable, TRelations, TLoaded & ResolveEagerLoads<TRelations, readonly [TPath]>, TScopes>,
      TCollectionName,
      TConversionName
    >
  : never

type MediaEnabledStaticWith<
  TModel extends MediaModelStatic,
  TCollectionName extends string,
  TConversionName extends string,
> = TModel extends { query(): infer TBuilder }
  ? MediaEnabledQueryBuilderWith<TBuilder, TCollectionName, TConversionName>
  : TModel extends { with: infer TWith }
    ? MediaEnabledFunction<TWith, TCollectionName, TConversionName>
    : never

type MediaEnabledStaticRelationCallbackMethod<
  TModel,
  TKey extends keyof TModel,
  TCollectionName extends string,
  TConversionName extends string,
> = TModel extends { query(): infer TBuilder }
  ? TKey extends keyof TBuilder
    ? MediaEnabledQueryBuilder<TBuilder, TCollectionName, TConversionName>[TKey]
    : never
  : never

export type MediaEnabledModel<
  TModel extends MediaModelStatic,
  TDefinition extends MediaDefinitionInput,
> = {
  [K in keyof TModel]: K extends 'with'
    ? MediaEnabledStaticWith<TModel, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>>
    : K extends MediaRelationCallbackMethod
      ? MediaEnabledStaticRelationCallbackMethod<TModel, K, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>>
    : MediaEnabledFunction<
        TModel[K],
        MediaCollectionName<TDefinition>,
        MediaConversionName<TDefinition>
      >
}

export function defineMediaModel<
  TModel extends MediaModelStatic,
  const TDefinition extends MediaDefinitionInput,
>(
  model: TModel,
  definition: TDefinition | MediaDefinitionFactory<TDefinition>,
): MediaEnabledModel<TModel, TDefinition> {
  installEntityMediaMethods()

  const resolvedDefinition = normalizeMediaDefinition(
    resolveMediaDefinition(definition),
  )
  registerMediaDefinition(model, resolvedDefinition)
  observeMediaModelDeletion(model)

  model.resolveRelationUsing('media', () => morphMany(
    () => Media,
    'model',
  ))

  return model as unknown as MediaEnabledModel<TModel, TDefinition>
}
