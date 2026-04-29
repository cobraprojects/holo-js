import { HydrationError } from '../core/errors'
import type { TableDefinition } from '../schema/types'
import type { Entity } from './Entity'
import type { ModelQueryBuilder } from './ModelQueryBuilder'
import type { ModelAggregateLoad, ModelMorphLoadMap, ModelRelationName, ModelRelationPath, ModelRecord, RelatedColumnNameOfRelation, RelationMap, ResolveEagerLoads, SerializeLoaded } from './types'

type CollectionRepository<TTable extends TableDefinition, TRelations extends RelationMap> = {
  readonly definition: { readonly primaryKey: string }
  query(): ModelQueryBuilder<TTable, TRelations>
  loadRelations(
    items: readonly Entity<TTable, TRelations>[],
    relations: readonly ModelRelationPath<TRelations>[],
    missingOnly: boolean,
  ): Promise<void>
  loadMorphRelations(
    items: readonly Entity<TTable, TRelations>[],
    relation: ModelRelationName<TRelations>,
    mapping: ModelMorphLoadMap,
  ): Promise<void>
  loadRelationAggregates(items: readonly Entity<TTable, TRelations>[], aggregates: readonly ModelAggregateLoad[]): Promise<void>
  createCollection?<TItem extends Entity<TTable, TRelations>>(items: readonly TItem[]): ModelCollection<TTable, TRelations, TItem>
}

type CollectionLoadedItem<
  TItem,
  TTable extends TableDefinition,
  TRelations extends RelationMap,
  TPaths extends readonly ModelRelationPath<TRelations>[],
> = Omit<TItem, keyof ResolveEagerLoads<TRelations, TPaths>>
  & ResolveEagerLoads<TRelations, TPaths>
  & (TItem extends { toJSON(): infer TSerialized }
    ? { toJSON(): TSerialized & SerializeLoaded<ResolveEagerLoads<TRelations, TPaths>> }
    : { toJSON(): ModelRecord<TTable> & SerializeLoaded<ResolveEagerLoads<TRelations, TPaths>> })

type CollectionSerializedItem<TItem, TTable extends TableDefinition>
  = TItem extends { toJSON(): infer TSerialized }
    ? TSerialized
    : ModelRecord<TTable>

export interface ModelCollectionMethods<
  TTable extends TableDefinition = TableDefinition,
  TRelations extends RelationMap = RelationMap,
  TItem = Entity<TTable, TRelations>,
> {
  modelKeys(): unknown[]
  toQuery(): ModelQueryBuilder<TTable, TRelations>
  toJSON(): Array<CollectionSerializedItem<TItem, TTable>>
  load<TPaths extends readonly ModelRelationPath<TRelations>[]>(...relations: TPaths): Promise<
    ModelCollection<TTable, TRelations, CollectionLoadedItem<TItem, TTable, TRelations, TPaths>>
  >
  loadMissing<TPaths extends readonly ModelRelationPath<TRelations>[]>(...relations: TPaths): Promise<
    ModelCollection<TTable, TRelations, CollectionLoadedItem<TItem, TTable, TRelations, TPaths>>
  >
  loadMorph(
    relation: ModelRelationName<TRelations>,
    mapping: ModelMorphLoadMap,
  ): Promise<ModelCollection<TTable, TRelations, TItem>>
  loadCount(...relations: readonly ModelRelationName<TRelations>[]): Promise<ModelCollection<TTable, TRelations, TItem>>
  loadExists(...relations: readonly ModelRelationName<TRelations>[]): Promise<ModelCollection<TTable, TRelations, TItem>>
  loadSum<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<ModelCollection<TTable, TRelations, TItem>>
  loadAvg<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<ModelCollection<TTable, TRelations, TItem>>
  loadMin<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<ModelCollection<TTable, TRelations, TItem>>
  loadMax<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<ModelCollection<TTable, TRelations, TItem>>
  fresh(): Promise<ModelCollection<TTable, TRelations>>
  append(...keys: readonly string[]): ModelCollection<TTable, TRelations, TItem>
  withoutAppends(): ModelCollection<TTable, TRelations, TItem>
  makeVisible(...keys: readonly string[]): ModelCollection<TTable, TRelations, TItem>
  makeHidden(...keys: readonly string[]): ModelCollection<TTable, TRelations, TItem>
  setVisible(keys: readonly string[]): ModelCollection<TTable, TRelations, TItem>
  setHidden(keys: readonly string[]): ModelCollection<TTable, TRelations, TItem>
}

export type ModelCollection<
  TTable extends TableDefinition = TableDefinition,
  TRelations extends RelationMap = RelationMap,
  TItem = Entity<TTable, TRelations>,
> = Array<TItem> & ModelCollectionMethods<TTable, TRelations, TItem>

export function createModelCollection<
  TTable extends TableDefinition = TableDefinition,
  TRelations extends RelationMap = RelationMap,
  TItem extends Entity<TTable, TRelations> = Entity<TTable, TRelations>,
>(
  items: readonly TItem[],
): ModelCollection<TTable, TRelations, TItem> {
  const collection = [...items] as ModelCollection<TTable, TRelations, TItem>
  const getRepository = (entity: Entity<TTable, TRelations>): CollectionRepository<TTable, TRelations> => (
    entity.getRepository() as unknown as CollectionRepository<TTable, TRelations>
  )
  const methods = {
    modelKeys(): unknown[] {
      return collection.map((entity) => {
        const repo = getRepository(entity)
        return entity.get(repo.definition.primaryKey as never)
      })
    },
    toQuery(): ModelQueryBuilder<TTable, TRelations> {
      const first = collection[0]
      if (!first) {
        throw new HydrationError('Cannot create a query from an empty model collection.')
      }

      const repo = getRepository(first)
      return repo.query().where(repo.definition.primaryKey as never, 'in', this.modelKeys()) as ModelQueryBuilder<TTable, TRelations>
    },
    toJSON(): Array<CollectionSerializedItem<TItem, TTable>> {
      return collection.map(item => item.toJSON() as CollectionSerializedItem<TItem, TTable>)
    },
    async load(...relations: readonly ModelRelationPath<TRelations>[]): Promise<ModelCollection<TTable, TRelations, CollectionLoadedItem<TItem, TTable, TRelations, typeof relations>>> {
      const first = collection[0]
      if (!first || relations.length === 0) {
        return collection as ModelCollection<TTable, TRelations, CollectionLoadedItem<TItem, TTable, TRelations, typeof relations>>
      }

      const repo = getRepository(first)
      await repo.loadRelations(collection, relations, false)
      return collection as ModelCollection<TTable, TRelations, CollectionLoadedItem<TItem, TTable, TRelations, typeof relations>>
    },
    async loadMissing(...relations: readonly ModelRelationPath<TRelations>[]): Promise<ModelCollection<TTable, TRelations, CollectionLoadedItem<TItem, TTable, TRelations, typeof relations>>> {
      const first = collection[0]
      if (!first || relations.length === 0) {
        return collection as ModelCollection<TTable, TRelations, CollectionLoadedItem<TItem, TTable, TRelations, typeof relations>>
      }

      const repo = getRepository(first)
      await repo.loadRelations(collection, relations, true)
      return collection as ModelCollection<TTable, TRelations, CollectionLoadedItem<TItem, TTable, TRelations, typeof relations>>
    },
    async loadMorph(
      relation: ModelRelationName<TRelations>,
      mapping: ModelMorphLoadMap,
    ): Promise<ModelCollection<TTable, TRelations, TItem>> {
      const first = collection[0]
      if (!first || !relation) {
        return collection
      }

      const repo = getRepository(first)
      if (typeof repo.loadMorphRelations !== 'function') {
        throw new HydrationError('The bound repository cannot load morph relations.')
      }
      await repo.loadMorphRelations(collection, relation, mapping)
      return collection
    },
    async loadCount(...relations: readonly ModelRelationName<TRelations>[]): Promise<ModelCollection<TTable, TRelations, TItem>> {
      const first = collection[0]
      if (!first || relations.length === 0) {
        return collection
      }

      const repo = getRepository(first)
      await repo.loadRelationAggregates(collection, relations.map(relation => ({ relation, kind: 'count' })))
      return collection
    },
    async loadExists(...relations: readonly ModelRelationName<TRelations>[]): Promise<ModelCollection<TTable, TRelations, TItem>> {
      const first = collection[0]
      if (!first || relations.length === 0) {
        return collection
      }

      const repo = getRepository(first)
      await repo.loadRelationAggregates(collection, relations.map(relation => ({ relation, kind: 'exists' })))
      return collection
    },
    async loadSum<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<ModelCollection<TTable, TRelations, TItem>> {
      const first = collection[0]
      if (!first || !relation) {
        return collection
      }

      const repo = getRepository(first)
      await repo.loadRelationAggregates(collection, [{ relation, kind: 'sum', column }])
      return collection
    },
    async loadAvg<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<ModelCollection<TTable, TRelations, TItem>> {
      const first = collection[0]
      if (!first || !relation) {
        return collection
      }

      const repo = getRepository(first)
      await repo.loadRelationAggregates(collection, [{ relation, kind: 'avg', column }])
      return collection
    },
    async loadMin<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<ModelCollection<TTable, TRelations, TItem>> {
      const first = collection[0]
      if (!first || !relation) {
        return collection
      }

      const repo = getRepository(first)
      await repo.loadRelationAggregates(collection, [{ relation, kind: 'min', column }])
      return collection
    },
    async loadMax<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<ModelCollection<TTable, TRelations, TItem>> {
      const first = collection[0]
      if (!first || !relation) {
        return collection
      }

      const repo = getRepository(first)
      await repo.loadRelationAggregates(collection, [{ relation, kind: 'max', column }])
      return collection
    },
    async fresh(): Promise<ModelCollection<TTable, TRelations>> {
      const refreshed: Array<Entity<TTable, TRelations> | undefined> = await Promise.all(
        collection.map(entity => entity.fresh()),
      )
      const items = refreshed.filter((entity): entity is Entity<TTable, TRelations> => entity !== undefined)
      const first = items[0]
      if (!first) {
        return createModelCollection<TTable, TRelations>(items)
      }

      const repo = getRepository(first)
      return typeof repo.createCollection === 'function'
        ? repo.createCollection(items)
        : createModelCollection<TTable, TRelations>(items)
    },
    append(...keys: readonly string[]): ModelCollection<TTable, TRelations, TItem> {
      for (const entity of collection) {
        entity.append(...keys)
      }
      return collection
    },
    withoutAppends(): ModelCollection<TTable, TRelations, TItem> {
      for (const entity of collection) {
        entity.withoutAppends()
      }
      return collection
    },
    makeVisible(...keys: readonly string[]): ModelCollection<TTable, TRelations, TItem> {
      for (const entity of collection) {
        entity.makeVisible(...keys)
      }
      return collection
    },
    makeHidden(...keys: readonly string[]): ModelCollection<TTable, TRelations, TItem> {
      for (const entity of collection) {
        entity.makeHidden(...keys)
      }
      return collection
    },
    setVisible(keys: readonly string[]): ModelCollection<TTable, TRelations, TItem> {
      for (const entity of collection) {
        entity.setVisible(keys)
      }
      return collection
    },
    setHidden(keys: readonly string[]): ModelCollection<TTable, TRelations, TItem> {
      for (const entity of collection) {
        entity.setHidden(keys)
      }
      return collection
    },
  }

  Object.defineProperties(
    collection,
    Object.fromEntries(
      Object.entries(methods).map(([name, value]) => [
        name,
        {
          value,
          enumerable: false,
          configurable: true,
          writable: true,
        },
      ]),
    ),
  )

  return collection
}
