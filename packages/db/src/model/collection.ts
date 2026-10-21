import { markDatabaseQueryObservationsSerialized } from '../cache'
import { HydrationError } from '../core/errors'
import { integerKeysToInline, singleStatementRelationKeys } from './relationRetrieval'
import { whereIntegerKeysIn } from './ModelQueryBuilder'
import type { TableDefinition } from '../schema/types'
import type { Entity } from './Entity'
import type { ModelQueryBuilder } from './ModelQueryBuilder'
import type { EmptyScopeMap, ModelAggregateLoad, ModelMorphLoadMap, ModelRelationName, ModelRelationPath, ModelRecord, ModelScopesDefinition, RelatedColumnNameOfRelation, RelationMap, ResolveEagerLoads, SerializeLoaded } from './types'

type CollectionRepository<
  TTable extends TableDefinition,
  TRelations extends RelationMap,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
> = {
  readonly definition: { readonly primaryKey: string, readonly table: TableDefinition }
  query(): ModelQueryBuilder<TTable, TRelations, unknown, TScopes>
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
  createCollection?<TItem extends Entity<TTable, TRelations>>(items: readonly TItem[]): ModelCollection<TTable, TRelations, TItem, TScopes>
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
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
> {
  modelKeys(): unknown[]
  toQuery(): ModelQueryBuilder<TTable, TRelations, unknown, TScopes>
  toJSON(): Array<CollectionSerializedItem<TItem, TTable>>
  load<TPaths extends readonly ModelRelationPath<TRelations>[]>(...relations: TPaths): Promise<
    ModelCollection<TTable, TRelations, CollectionLoadedItem<TItem, TTable, TRelations, TPaths>, TScopes>
  >
  loadMissing<TPaths extends readonly ModelRelationPath<TRelations>[]>(...relations: TPaths): Promise<
    ModelCollection<TTable, TRelations, CollectionLoadedItem<TItem, TTable, TRelations, TPaths>, TScopes>
  >
  loadMorph(
    relation: ModelRelationName<TRelations>,
    mapping: ModelMorphLoadMap,
  ): Promise<ModelCollection<TTable, TRelations, TItem, TScopes>>
  loadCount(...relations: readonly ModelRelationName<TRelations>[]): Promise<ModelCollection<TTable, TRelations, TItem, TScopes>>
  loadExists(...relations: readonly ModelRelationName<TRelations>[]): Promise<ModelCollection<TTable, TRelations, TItem, TScopes>>
  loadSum<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<ModelCollection<TTable, TRelations, TItem, TScopes>>
  loadAvg<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<ModelCollection<TTable, TRelations, TItem, TScopes>>
  loadMin<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<ModelCollection<TTable, TRelations, TItem, TScopes>>
  loadMax<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<ModelCollection<TTable, TRelations, TItem, TScopes>>
  fresh(): Promise<ModelCollection<TTable, TRelations, Entity<TTable, TRelations>, TScopes>>
  append(...keys: readonly string[]): ModelCollection<TTable, TRelations, TItem, TScopes>
  withoutAppends(): ModelCollection<TTable, TRelations, TItem, TScopes>
  makeVisible(...keys: readonly string[]): ModelCollection<TTable, TRelations, TItem, TScopes>
  makeHidden(...keys: readonly string[]): ModelCollection<TTable, TRelations, TItem, TScopes>
  setVisible(keys: readonly string[]): ModelCollection<TTable, TRelations, TItem, TScopes>
  setHidden(keys: readonly string[]): ModelCollection<TTable, TRelations, TItem, TScopes>
}

export type ModelCollection<
  TTable extends TableDefinition = TableDefinition,
  TRelations extends RelationMap = RelationMap,
  TItem = Entity<TTable, TRelations>,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
> = Array<TItem> & ModelCollectionMethods<TTable, TRelations, TItem, TScopes>

export function createModelCollection<
  TTable extends TableDefinition = TableDefinition,
  TRelations extends RelationMap = RelationMap,
  TItem extends Entity<TTable, TRelations> = Entity<TTable, TRelations>,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
>(
  items: readonly TItem[],
): ModelCollection<TTable, TRelations, TItem, TScopes> {
  const collection = [...items] as ModelCollection<TTable, TRelations, TItem, TScopes>
  const getRepository = (entity: Entity<TTable, TRelations>): CollectionRepository<TTable, TRelations, TScopes> => (
    entity.getRepository() as unknown as CollectionRepository<TTable, TRelations, TScopes>
  )
  const loadRelationAggregates = async (
    aggregates: readonly ModelAggregateLoad[],
  ): Promise<ModelCollection<TTable, TRelations, TItem, TScopes>> => {
    const first = collection[0]
    if (!first || aggregates.length === 0) {
      return collection
    }

    await getRepository(first).loadRelationAggregates(collection, aggregates)
    return collection
  }
  const methods = {
    modelKeys(): unknown[] {
      return collection.map((entity) => {
        const repo = getRepository(entity)
        return entity.get(repo.definition.primaryKey as never)
      })
    },
    toQuery(): ModelQueryBuilder<TTable, TRelations, unknown, TScopes> {
      const first = collection[0]
      if (!first) {
        throw new HydrationError('Cannot create a query from an empty model collection.')
      }

      const repo = getRepository(first)
      const keys = this.modelKeys()
      const integerKeys = integerKeysToInline(keys, repo.definition.table.columns[repo.definition.primaryKey])
      if (integerKeys) {
        return repo.query()[whereIntegerKeysIn](integerKeys) as ModelQueryBuilder<TTable, TRelations, unknown, TScopes>
      }

      return repo.query().where(repo.definition.primaryKey as never, 'in', singleStatementRelationKeys(keys)) as ModelQueryBuilder<TTable, TRelations, unknown, TScopes>
    },
    toJSON(): Array<CollectionSerializedItem<TItem, TTable>> {
      return collection.map(item => item.toJSON() as CollectionSerializedItem<TItem, TTable>)
    },
    async load(...relations: readonly ModelRelationPath<TRelations>[]): Promise<ModelCollection<TTable, TRelations, CollectionLoadedItem<TItem, TTable, TRelations, typeof relations>, TScopes>> {
      const first = collection[0]
      if (!first || relations.length === 0) {
        return collection as ModelCollection<TTable, TRelations, CollectionLoadedItem<TItem, TTable, TRelations, typeof relations>, TScopes>
      }

      const repo = getRepository(first)
      await repo.loadRelations(collection, relations, false)
      return collection as ModelCollection<TTable, TRelations, CollectionLoadedItem<TItem, TTable, TRelations, typeof relations>, TScopes>
    },
    async loadMissing(...relations: readonly ModelRelationPath<TRelations>[]): Promise<ModelCollection<TTable, TRelations, CollectionLoadedItem<TItem, TTable, TRelations, typeof relations>, TScopes>> {
      const first = collection[0]
      if (!first || relations.length === 0) {
        return collection as ModelCollection<TTable, TRelations, CollectionLoadedItem<TItem, TTable, TRelations, typeof relations>, TScopes>
      }

      const repo = getRepository(first)
      await repo.loadRelations(collection, relations, true)
      return collection as ModelCollection<TTable, TRelations, CollectionLoadedItem<TItem, TTable, TRelations, typeof relations>, TScopes>
    },
    async loadMorph(
      relation: ModelRelationName<TRelations>,
      mapping: ModelMorphLoadMap,
    ): Promise<ModelCollection<TTable, TRelations, TItem, TScopes>> {
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
    async loadCount(...relations: readonly ModelRelationName<TRelations>[]): Promise<ModelCollection<TTable, TRelations, TItem, TScopes>> {
      return loadRelationAggregates(relations.map(relation => ({ relation, kind: 'count' })))
    },
    async loadExists(...relations: readonly ModelRelationName<TRelations>[]): Promise<ModelCollection<TTable, TRelations, TItem, TScopes>> {
      return loadRelationAggregates(relations.map(relation => ({ relation, kind: 'exists' })))
    },
    async loadSum<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<ModelCollection<TTable, TRelations, TItem, TScopes>> {
      return loadRelationAggregates([{ relation, kind: 'sum', column }])
    },
    async loadAvg<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<ModelCollection<TTable, TRelations, TItem, TScopes>> {
      return loadRelationAggregates([{ relation, kind: 'avg', column }])
    },
    async loadMin<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<ModelCollection<TTable, TRelations, TItem, TScopes>> {
      return loadRelationAggregates([{ relation, kind: 'min', column }])
    },
    async loadMax<TRelationName extends ModelRelationName<TRelations>>(relation: TRelationName, column: RelatedColumnNameOfRelation<TRelations[TRelationName]>): Promise<ModelCollection<TTable, TRelations, TItem, TScopes>> {
      return loadRelationAggregates([{ relation, kind: 'max', column }])
    },
    async fresh(): Promise<ModelCollection<TTable, TRelations, Entity<TTable, TRelations>, TScopes>> {
      const refreshed: Array<Entity<TTable, TRelations> | undefined> = await Promise.all(
        collection.map(entity => entity.fresh()),
      )
      const items = refreshed.filter((entity): entity is Entity<TTable, TRelations> => entity !== undefined)
      const first = items[0]
      if (!first) {
        return createModelCollection<TTable, TRelations, Entity<TTable, TRelations>, TScopes>(items)
      }

      const repo = getRepository(first)
      return typeof repo.createCollection === 'function'
        ? repo.createCollection(items)
        : createModelCollection<TTable, TRelations, Entity<TTable, TRelations>, TScopes>(items)
    },
    append(...keys: readonly string[]): ModelCollection<TTable, TRelations, TItem, TScopes> {
      for (const entity of collection) {
        entity.append(...keys)
      }
      markDatabaseQueryObservationsSerialized()
      return collection
    },
    withoutAppends(): ModelCollection<TTable, TRelations, TItem, TScopes> {
      for (const entity of collection) {
        entity.withoutAppends()
      }
      markDatabaseQueryObservationsSerialized()
      return collection
    },
    makeVisible(...keys: readonly string[]): ModelCollection<TTable, TRelations, TItem, TScopes> {
      for (const entity of collection) {
        entity.makeVisible(...keys)
      }
      markDatabaseQueryObservationsSerialized()
      return collection
    },
    makeHidden(...keys: readonly string[]): ModelCollection<TTable, TRelations, TItem, TScopes> {
      for (const entity of collection) {
        entity.makeHidden(...keys)
      }
      markDatabaseQueryObservationsSerialized()
      return collection
    },
    setVisible(keys: readonly string[]): ModelCollection<TTable, TRelations, TItem, TScopes> {
      for (const entity of collection) {
        entity.setVisible(keys)
      }
      markDatabaseQueryObservationsSerialized()
      return collection
    },
    setHidden(keys: readonly string[]): ModelCollection<TTable, TRelations, TItem, TScopes> {
      for (const entity of collection) {
        entity.setHidden(keys)
      }
      markDatabaseQueryObservationsSerialized()
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
