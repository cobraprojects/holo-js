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
  EntityWithLoaded,
  ModelCollection,
  ModelRelationPath,
  ModelQueryBuilder,
  PaginatedResult,
  RelatedColumnNameForRelationPath,
  RelationMap,
  RelationConstraintDefinition,
  ResolveEagerLoads,
  SimplePaginatedResult,
  TableDefinition,
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

type MediaEnabledEntityResult<
  TEntity,
  TCollectionName extends string,
  TConversionName extends string,
> = TEntity extends EntityWithLoaded<infer _TTable extends TableDefinition, infer _TRelations extends RelationMap, infer _TLoaded>
  ? unknown extends _TLoaded
    ? MediaEnabledEntity<_TTable, TCollectionName, TConversionName, _TRelations>
    : TEntity & MediaEnabledEntityMethods<TCollectionName, TConversionName>
  : TEntity extends Entity<infer _TTable extends TableDefinition, infer _TRelations extends RelationMap>
  ? TEntity & MediaEnabledEntityMethods<TCollectionName, TConversionName>
  : TEntity

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

type MediaEnabledQueryBuilder<
  TBuilder,
  TCollectionName extends string,
  TConversionName extends string,
> = {
  [K in keyof TBuilder]: K extends 'with'
    ? MediaEnabledQueryBuilderWith<TBuilder, TCollectionName, TConversionName>
    : K extends 'withCount' | 'withExists'
      ? MediaEnabledRelationAggregate<TBuilder, TCollectionName, TConversionName>
      : K extends 'withSum' | 'withAvg' | 'withMin' | 'withMax'
        ? MediaEnabledRelationColumnAggregate<TBuilder, TCollectionName, TConversionName>
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
    : TValue extends ModelQueryBuilder<infer TTable extends TableDefinition, infer TRelations extends RelationMap, infer TLoaded>
      ? MediaEnabledQueryBuilder<ModelQueryBuilder<TTable, TRelations, TLoaded>, TCollectionName, TConversionName>
      : TValue extends ModelCollection<infer TTable extends TableDefinition, infer TRelations extends RelationMap, infer TItem>
        ? TItem extends Entity<TTable, TRelations>
          ? ModelCollection<TTable, TRelations, MediaEnabledEntityResult<TItem, TCollectionName, TConversionName>>
          : TValue
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
              : MediaEnabledEntityResult<TValue, TCollectionName, TConversionName>

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

type MediaRelationConstraint<
  TTable extends TableDefinition,
  TRelations extends RelationMap,
> = RelationConstraintDefinition & ((query: ModelQueryBuilder<TTable, TRelations>) => unknown)

type MediaRelationConstraintMap<TRelations extends RelationMap>
  = Readonly<Partial<Record<MediaRelationPath<TRelations>, MediaRelationConstraint<TableDefinition, TRelations>>>>

type MediaEnabledQueryBuilderWith<
  TBuilder,
  TCollectionName extends string,
  TConversionName extends string,
> = TBuilder extends ModelQueryBuilder<infer TTable extends TableDefinition, infer TRelations extends RelationMap, infer TLoaded>
  ? {
      <TPaths extends readonly MediaRelationPath<TRelations>[]>(
        ...relations: TPaths
      ): MediaEnabledQueryBuilder<
        ModelQueryBuilder<TTable, TRelations, TLoaded & ResolveEagerLoads<TRelations, TPaths>>,
        TCollectionName,
        TConversionName
      >
      <TPath extends MediaRelationPath<TRelations>>(
        relation: TPath,
        constraint: MediaRelationConstraint<TTable, TRelations>
      ): MediaEnabledQueryBuilder<
        ModelQueryBuilder<TTable, TRelations, TLoaded & ResolveEagerLoads<TRelations, readonly [TPath]>>,
        TCollectionName,
        TConversionName
      >
      (
        relations: MediaRelationConstraintMap<TRelations>
      ): MediaEnabledQueryBuilder<ModelQueryBuilder<TTable, TRelations, TLoaded>, TCollectionName, TConversionName>
      <TPaths extends readonly MediaRelationPath<TRelations>[]>(
        relations: TPaths
      ): MediaEnabledQueryBuilder<
        ModelQueryBuilder<TTable, TRelations, TLoaded & ResolveEagerLoads<TRelations, TPaths>>,
        TCollectionName,
        TConversionName
      >
    }
  : TBuilder extends { with: infer TWith }
    ? MediaEnabledFunction<TWith, TCollectionName, TConversionName>
    : never

type MediaEnabledRelationAggregate<
  TBuilder,
  TCollectionName extends string,
  TConversionName extends string,
> = TBuilder extends ModelQueryBuilder<infer TTable extends TableDefinition, infer TRelations extends RelationMap, infer TLoaded>
  ? {
      (...relations: readonly MediaRelationPath<TRelations>[]): MediaEnabledQueryBuilder<ModelQueryBuilder<TTable, TRelations, TLoaded>, TCollectionName, TConversionName>
      (relations: MediaRelationConstraintMap<TRelations>): MediaEnabledQueryBuilder<ModelQueryBuilder<TTable, TRelations, TLoaded>, TCollectionName, TConversionName>
    }
  : never

type MediaEnabledRelationColumnAggregate<
  TBuilder,
  TCollectionName extends string,
  TConversionName extends string,
> = TBuilder extends ModelQueryBuilder<infer TTable extends TableDefinition, infer TRelations extends RelationMap, infer TLoaded>
  ? <TPath extends MediaRelationPath<TRelations>>(
      first: TPath | MediaRelationConstraintMap<TRelations>,
      column: RelatedColumnNameForRelationPath<TRelations, TPath>,
      ...rest: readonly MediaRelationPath<TRelations>[]
    ) => MediaEnabledQueryBuilder<ModelQueryBuilder<TTable, TRelations, TLoaded>, TCollectionName, TConversionName>
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

export type MediaEnabledModel<
  TModel extends MediaModelStatic,
  TDefinition extends MediaDefinitionInput,
> = {
  [K in keyof TModel]: K extends 'with'
    ? MediaEnabledStaticWith<TModel, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>>
    : MediaEnabledFunction<
        TModel[K],
        MediaCollectionName<TDefinition>,
        MediaConversionName<TDefinition>
      >
} & TModel

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
