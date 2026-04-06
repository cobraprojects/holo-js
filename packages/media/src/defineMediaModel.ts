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
import { registerMediaDefinition } from './registry'
import type {
  DynamicRelationResolver,
  Entity,
  ModelCollection,
  ModelRecord,
  TableDefinition,
} from '@holo-js/db'
import type { MediaAdder, MediaSourceInput } from './model/adder'
import type { MediaItem } from './model/item'

type MediaCollectionName<TDefinition extends MediaDefinitionInput>
  = 'default' | CollectionNamesOf<TDefinition>

type MediaConversionName<TDefinition extends MediaDefinitionInput>
  = ConversionNamesOf<TDefinition>

type ModelTableOf<TModel>
  = TModel extends { readonly definition: { readonly table: infer TTable extends TableDefinition } }
    ? TTable
    : TableDefinition

export type MediaEnabledEntity<
  TTable extends TableDefinition = TableDefinition,
  TCollectionName extends string = string,
  TConversionName extends string = string,
> = Entity<TTable> & {
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

type MediaEnabledCollection<
  TTable extends TableDefinition,
  TCollectionName extends string,
  TConversionName extends string,
> = ModelCollection<TTable> & MediaEnabledEntity<TTable, TCollectionName, TConversionName>[]

type MediaModelStatic = {
  readonly definition: {
    readonly name: string
    readonly table: TableDefinition
  }
  readonly resolveRelationUsing: (name: string, resolver: DynamicRelationResolver) => unknown
}

type OverrideKeys
  = | 'find'
    | 'findOrFail'
    | 'first'
    | 'firstOrFail'
    | 'sole'
    | 'get'
    | 'all'
    | 'findMany'
    | 'make'
    | 'create'
    | 'createQuietly'
    | 'createMany'
    | 'createManyQuietly'
    | 'firstOrNew'
    | 'firstOrCreate'
    | 'updateOrCreate'
    | 'upsert'

export type MediaEnabledModel<
  TModel extends MediaModelStatic,
  TDefinition extends MediaDefinitionInput,
> = Omit<TModel, OverrideKeys> & {
  find(value: unknown): Promise<MediaEnabledEntity<ModelTableOf<TModel>, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>> | undefined>
  findOrFail(value: unknown): Promise<MediaEnabledEntity<ModelTableOf<TModel>, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>>>
  first(): Promise<MediaEnabledEntity<ModelTableOf<TModel>, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>> | undefined>
  firstOrFail(): Promise<MediaEnabledEntity<ModelTableOf<TModel>, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>>>
  sole(): Promise<MediaEnabledEntity<ModelTableOf<TModel>, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>>>
  get(): Promise<MediaEnabledCollection<ModelTableOf<TModel>, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>>>
  all(): Promise<MediaEnabledCollection<ModelTableOf<TModel>, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>>>
  findMany(values: readonly unknown[]): Promise<MediaEnabledCollection<ModelTableOf<TModel>, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>>>
  make(values?: Partial<ModelRecord<ModelTableOf<TModel>>>): MediaEnabledEntity<ModelTableOf<TModel>, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>>
  create(values: Partial<ModelRecord<ModelTableOf<TModel>>>): Promise<MediaEnabledEntity<ModelTableOf<TModel>, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>>>
  createQuietly(values: Partial<ModelRecord<ModelTableOf<TModel>>>): Promise<MediaEnabledEntity<ModelTableOf<TModel>, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>>>
  createMany(values: readonly Partial<ModelRecord<ModelTableOf<TModel>>>[]): Promise<MediaEnabledCollection<ModelTableOf<TModel>, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>>>
  createManyQuietly(values: readonly Partial<ModelRecord<ModelTableOf<TModel>>>[]): Promise<MediaEnabledCollection<ModelTableOf<TModel>, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>>>
  firstOrNew(match: Partial<ModelRecord<ModelTableOf<TModel>>>, values?: Partial<ModelRecord<ModelTableOf<TModel>>>): Promise<MediaEnabledEntity<ModelTableOf<TModel>, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>>>
  firstOrCreate(match: Partial<ModelRecord<ModelTableOf<TModel>>>, values?: Partial<ModelRecord<ModelTableOf<TModel>>>): Promise<MediaEnabledEntity<ModelTableOf<TModel>, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>>>
  updateOrCreate(match: Partial<ModelRecord<ModelTableOf<TModel>>>, values?: Partial<ModelRecord<ModelTableOf<TModel>>>): Promise<MediaEnabledEntity<ModelTableOf<TModel>, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>>>
  upsert(match: Partial<ModelRecord<ModelTableOf<TModel>>>, values?: Partial<ModelRecord<ModelTableOf<TModel>>>): Promise<MediaEnabledEntity<ModelTableOf<TModel>, MediaCollectionName<TDefinition>, MediaConversionName<TDefinition>>>
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

  model.resolveRelationUsing('media', () => morphMany(
    () => Media,
    'model',
  ))

  return model as unknown as MediaEnabledModel<TModel, TDefinition>
}
