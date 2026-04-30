import { connectionAsyncContext } from '../concurrency/AsyncConnectionContext'
import { DB } from '../facade/DB'
import { ConfigurationError, DatabaseError, HydrationError, ModelNotFoundException, RelationError, SecurityError } from '../core/errors'
import { TableQueryBuilder } from '../query/TableQueryBuilder'
import { Entity } from './Entity'
import { createModelCollection, type ModelCollection } from './collection'
import { listDynamicRelationNames, resolveDynamicRelation } from './dynamicRelations'
import { areModelEventsMuted, areModelGuardsDisabled, withoutModelEvents } from './eventState'
import { ModelQueryBuilder } from './ModelQueryBuilder'
import { listMorphModels, resolveMorphModel } from './morphRegistry'
import { getModelRuntimeSettings } from './runtimeSettings'
import { normalizeDialectReadValue, normalizeDialectWriteValue } from '../schema/normalization'
import type { TableDefinition } from '../schema/types'
import type { SchemaDialectName } from '../schema/typeMapping'
import type { DatabaseContext } from '../core/DatabaseContext'
import type {
  AnyModelDefinition,
  BuiltInCastName,
  ModelDefinitionLike,
  ModelCastDefinition,
  ModelColumnName,
  ModelLifecycleEventName,
  ModelDefinition,
  ModelRecord,
  ModelReference,
  RelationDefinition,
  RelationAggregateKind,
  ModelUpdatePayload,
  RelationMap,
} from './types'

type WriteMode = 'create' | 'update'
type PivotAttributes = Record<string, unknown>
type PivotMutationEntry = { id: unknown, attributes: PivotAttributes }
type PivotSyncResult = { attached: unknown[], detached: unknown[], updated: unknown[] }
type PivotToggleResult = { attached: unknown[], detached: unknown[] }
type RelationConstraint = (query: ModelQueryBuilder<TableDefinition>) => unknown
type RelationFilter = {
  relation: string
  negate: boolean
  constraint?: RelationConstraint
  boolean?: 'and' | 'or'
  morphTypes?: readonly string[]
}
type EagerLoad = { relation: string, constraint?: RelationConstraint }
type AggregateLoad = {
  relation: string
  kind: RelationAggregateKind
  constraint?: RelationConstraint
  column?: string
  alias?: string
}
type PivotRelationDefinition = Extract<RelationDefinition, { kind: 'belongsToMany' | 'morphToMany' | 'morphedByMany' }>
type PivotMutationRelationDefinition = PivotRelationDefinition

function hasDefinition<TTable extends TableDefinition>(
  reference: ModelDefinitionLike | ModelDefinition<TTable> | ModelReference<TTable>,
): reference is ModelReference<TTable> | { definition: AnyModelDefinition } {
  return 'definition' in reference
}

function isEntity(value: unknown): value is Entity {
  return value instanceof Entity
}

export function getModelDefinition<TTable extends TableDefinition>(
  reference: ModelDefinitionLike | ModelDefinition<TTable> | ModelReference<TTable>,
): ModelDefinition<TTable> {
  return (hasDefinition(reference) ? reference.definition : reference) as ModelDefinition<TTable>
}

function resolveModelConnection<TTable extends TableDefinition>(
  definition: ModelDefinition<TTable>,
): DatabaseContext {
  const active = connectionAsyncContext.getActive()
  if (active && (!definition.connectionName || active.connectionName === definition.connectionName)) {
    return active.connection
  }

  return DB.connection(definition.connectionName)
}

export class ModelRepository<TTable extends TableDefinition = TableDefinition> {
  readonly definition: ModelDefinition<TTable>

  constructor(
    definition: ModelDefinition<TTable>,
    private readonly connection: DatabaseContext,
  ) {
    this.definition = definition
  }

  static from<TTable extends TableDefinition>(
    reference: ModelDefinitionLike | ModelDefinition<TTable> | ModelReference<TTable>,
    connection?: DatabaseContext,
  ): ModelRepository<TTable> {
    const definition = getModelDefinition(reference)
    return new ModelRepository(definition, connection ?? resolveModelConnection(definition))
  }

  getConnection(): DatabaseContext {
    return this.connection
  }

  getConnectionName(): string {
    return this.connection.getConnectionName()
  }

  getDeletedAtColumn(): string | undefined {
    return this.definition.deletedAtColumn
  }

  getRelationNames(): readonly string[] {
    const names = new Set<string>([
      ...Object.keys(this.definition.relations),
      ...listDynamicRelationNames(this.definition),
    ])

    return [...names]
  }

  getRelationDefinition(name: string): RelationDefinition {
    const relation = resolveDynamicRelation(this.definition, name) ?? this.definition.relations[name]
    if (!relation) {
      throw new SecurityError(`Relation "${name}" is not defined on model "${this.definition.name}".`)
    }

    return relation
  }

  createCollection<TItem extends Entity<TTable>>(items: readonly TItem[]): ModelCollection<TTable, RelationMap, TItem> {
    return this.definition.collection
      ? this.definition.collection(items)
      : createModelCollection(items)
  }

  query(): ModelQueryBuilder<TTable> {
    return this.createQuery(true, true, true)
  }

  newQuery(): ModelQueryBuilder<TTable> {
    return this.createQuery(true, true, true)
  }

  newModelQuery(): ModelQueryBuilder<TTable> {
    return this.createQuery(true, true, true)
  }

  newQueryWithoutScopes(): ModelQueryBuilder<TTable> {
    return this.createQuery(false, false, true)
  }

  queryWithoutGlobalScope(name: string): ModelQueryBuilder<TTable> {
    return this.createQuery(true, true, true, new Set([name]))
  }

  queryWithoutGlobalScopes(names?: readonly string[]): ModelQueryBuilder<TTable> {
    if (names && names.length > 0) {
      return this.createQuery(true, true, true, new Set(names))
    }

    return this.createQuery(false, false, true)
  }

  newQueryWithoutRelationships(): ModelQueryBuilder<TTable> {
    return this.createQuery(true, true, false)
  }

  async find(value: unknown): Promise<Entity<TTable> | undefined> {
    return this.query().find(value, this.definition.primaryKey)
  }

  async findOrFail(value: unknown): Promise<Entity<TTable>> {
    const model = await this.find(value)
    if (!model) {
      throw new ModelNotFoundException(this.definition.name, `${this.definition.name} record not found for key "${String(value)}".`)
    }

    return model
  }

  async first(): Promise<Entity<TTable> | undefined> {
    return this.query().first()
  }

  async firstOrFail(): Promise<Entity<TTable>> {
    const model = await this.first()
    if (!model) {
      throw new ModelNotFoundException(this.definition.name)
    }

    return model
  }

  async get(): Promise<ModelCollection<TTable>> {
    return this.query().get()
  }

  async sole(): Promise<Entity<TTable>> {
    return this.query().sole()
  }

  async all(): Promise<ModelCollection<TTable>> {
    return this.get()
  }

  async findMany(values: readonly unknown[]): Promise<ModelCollection<TTable>> {
    if (values.length === 0) {
      return this.createCollection([])
    }

    return this.query().where(this.definition.primaryKey, 'in', [...values]).get()
  }

  async firstWhere(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): Promise<Entity<TTable> | undefined> {
    return this.query().where(column as never, operator, value).first()
  }

  async firstOrNew(
    match: Partial<ModelRecord<TTable>>,
    values: Partial<ModelRecord<TTable>> = {},
  ): Promise<Entity<TTable>> {
    let query = this.query()
    for (const [column, value] of Object.entries(match)) {
      query = query.where(column as never, value)
    }

    const existing = await query.first()
    if (existing) {
      return existing
    }

    return this.make({ ...match, ...values })
  }

  async firstOrCreate(
    match: Partial<ModelRecord<TTable>>,
    values: Partial<ModelRecord<TTable>> = {},
  ): Promise<Entity<TTable>> {
    let query = this.query()
    for (const [column, value] of Object.entries(match)) {
      query = query.where(column as never, value)
    }

    const existing = await query.first()
    if (existing) {
      return existing
    }

    return this.create({ ...match, ...values })
  }

  make(values: Partial<ModelRecord<TTable>> = {}): Entity<TTable> {
    return new Entity(this, this.sanitizeWritePayload(this.applyPendingAttributes(values), 'create'), false)
  }

  hydrate(values: Partial<ModelRecord<TTable>>): Entity<TTable> {
    return new Entity(this, this.normalizeFromStorage(values), true)
  }

  async retrieve(values: Partial<ModelRecord<TTable>>): Promise<Entity<TTable>> {
    const entity = this.hydrate(values)
    await this.dispatchEvent('retrieved', entity)
    return entity
  }

  async retrieveWithCasts(
    values: Partial<ModelRecord<TTable>>,
    casts: Record<string, ModelCastDefinition>,
  ): Promise<Entity<TTable>> {
    const entity = new Entity(this, this.normalizeFromStorage(values, casts), true)
    await this.dispatchEvent('retrieved', entity)
    return entity
  }

  async freshEntity(entity: Entity<TTable>): Promise<Entity<TTable> | undefined> {
    const key = entity.toAttributes()[this.definition.primaryKey as keyof ReturnType<typeof entity.toAttributes>]
    if (key === null || typeof key === 'undefined') {
      return undefined
    }

    const query = this.getDeletedAtColumn() ? this.query().withTrashed() : this.query()
    return query.find(key, this.definition.primaryKey)
  }

  async refreshEntity(entity: Entity<TTable>): Promise<Entity<TTable>> {
    const refreshed = await this.freshEntity(entity)
    if (!refreshed) {
      throw new HydrationError(`Cannot refresh ${this.definition.name} without a persisted primary key value.`)
    }

    return refreshed
  }

  async loadRelations(
    entities: readonly Entity<TTable>[],
    relations: readonly (string | EagerLoad)[],
    missingOnly = false,
  ): Promise<void> {
    if (entities.length === 0 || relations.length === 0) {
      return
    }

    const relationTree = new Map<string, { constraint?: RelationConstraint, children: EagerLoad[] }>()
    for (const entry of this.normalizeEagerLoads(relations)) {
      const [root, ...rest] = entry.relation.split('.')
      if (!root) {
        throw new SecurityError('Relation names cannot be empty.')
      }

      const nested = rest.join('.')
      const node = relationTree.get(root) ?? { children: [] as EagerLoad[], constraint: undefined }
      if (typeof entry.constraint !== 'undefined') {
        node.constraint = entry.constraint
      }
      if (nested.length > 0 && !node.children.some(child => child.relation === nested)) {
        node.children.push({
          relation: nested,
          constraint: entry.constraint,
        })
      }
      relationTree.set(root, node)
    }

    for (const [relationName, node] of relationTree.entries()) {
      const relation = this.getRelationDefinition(relationName)
      const pending = missingOnly
        ? entities.filter(entity => !entity.hasRelation(relationName))
        : [...entities]

      if (pending.length === 0) {
        continue
      }

      await this.loadRelation(pending, relationName, relation, node.constraint)

      if (node.children.length > 0) {
        const relatedEntities = this.collectLoadedRelationEntities(pending, relationName)
        if (relatedEntities.length > 0) {
          if (relation.kind === 'morphTo') {
            const grouped = new Map<string, Entity[]>()

            for (const relatedEntity of relatedEntities) {
              const repository = relatedEntity.getRepository() as ModelRepository
              const key = `${repository.getConnectionName()}:${repository.definition.table.tableName}`
              const bucket = grouped.get(key) ?? []
              bucket.push(relatedEntity)
              grouped.set(key, bucket)
            }

            for (const group of grouped.values()) {
              const repository = group[0]!.getRepository() as ModelRepository
              await repository.loadRelations(group, node.children, missingOnly)
            }
          } else {
            await this.resolveRelatedRepository(relation.related).loadRelations(relatedEntities, node.children, missingOnly)
          }
        }
      }
    }
  }

  async filterByRelations(
    entities: readonly Entity<TTable>[],
    filters: readonly RelationFilter[],
  ): Promise<Array<Entity<TTable>>> {
    if (entities.length === 0 || filters.length === 0) {
      return [...entities]
    }

    const allEntities = [...entities]
    let current = [...allEntities]
    let hasAppliedFilter = false

    for (const filter of filters) {
      const relation = this.getRelationDefinition(filter.relation)
      const matching = await this.getMatchingParentKeys(allEntities, relation, filter.constraint, filter.morphTypes)
      const matchedEntities = allEntities.filter((entity) => {
        const parentKey = this.getRelationParentValue(entity, relation)
        const matched = matching.has(parentKey)
        return filter.negate ? !matched : matched
      })

      if (filter.boolean === 'or' && hasAppliedFilter) {
        const merged = new Map<unknown, Entity<TTable>>()
        for (const entity of current) {
          merged.set(entity.get(this.definition.primaryKey), entity)
        }
        for (const entity of matchedEntities) {
          merged.set(entity.get(this.definition.primaryKey), entity)
        }
        current = [...merged.values()]
        continue
      }

      current = matchedEntities
      hasAppliedFilter = true
    }

    return current
  }

  applyRelationExistenceFilter(
    query: TableQueryBuilder<TTable, Record<string, unknown>>,
    filter: RelationFilter,
  ): TableQueryBuilder<TTable, Record<string, unknown>> {
    const [rootRelation, ...nestedPath] = filter.relation.split('.')
    const relation = this.getRelationDefinition(rootRelation!)
    this.assertRelationExistenceSupported(rootRelation!, relation, filter.morphTypes)
    const constraint = nestedPath.length === 0
      ? filter.constraint
      : (builder: ModelQueryBuilder<TableDefinition>) => {
          const nestedRelation = nestedPath.join('.')
          const nested = filter.constraint
            ? builder.whereHas(nestedRelation, filter.constraint)
            : builder.has(nestedRelation)
          return nested
        }

    const subqueries = this.buildRelationExistenceSubqueries(
      relation,
      constraint,
      filter.morphTypes,
    )

    if (subqueries.length === 0) {
      if (filter.negate) {
        return query
      }

      const impossible = (builder: TableQueryBuilder<TTable, Record<string, unknown>>) => (
        builder
          .whereNull(this.qualifyParentColumn(this.definition.primaryKey) as never)
          .whereNotNull(this.qualifyParentColumn(this.definition.primaryKey) as never)
      )

      switch (filter.boolean) {
        case 'or':
          return query.orWhere(impossible)
        default:
          return query.where(impossible)
      }
    }

    if (subqueries.length === 1) {
      return this.applyExistsBoolean(query, subqueries[0]!, filter.boolean ?? 'and', filter.negate)
    }

    return this.applyExistsBooleanGroup(query, subqueries, filter.boolean ?? 'and', filter.negate)
  }

  async loadMorphRelations(
    entities: readonly Entity<TTable>[],
    relationName: string,
    mapping: Readonly<Record<string, string | readonly string[] | Readonly<Record<string, RelationConstraint>>>>,
  ): Promise<void> {
    if (entities.length === 0) {
      return
    }

    const relation = this.getRelationDefinition(relationName)
    if (relation.kind !== 'morphTo') {
      throw new SecurityError(`Relation "${relationName}" does not support morph loading.`)
    }

    const pending = entities.filter(entity => !entity.hasRelation(relationName))
    if (pending.length > 0) {
      await this.loadMorphToRelation(pending, relationName, relation)
    }

    const groups = new Map<string, {
      repository: ModelRepository
      relations: readonly (string | EagerLoad)[]
      entities: Entity[]
    }>()

    for (const entity of entities) {
      const loaded = entity.getRelation<unknown>(relationName)
      const relatedEntities = Array.isArray(loaded)
        ? loaded.filter(isEntity)
        : isEntity(loaded)
          ? [loaded]
          : []

      if (relatedEntities.length === 0) {
        continue
      }

      const actualType = entity.toAttributes()[relation.morphTypeColumn as keyof ReturnType<typeof entity.toAttributes>]
      for (const relatedEntity of relatedEntities) {
        const relatedRepository = relatedEntity.getRepository() as ModelRepository
        const relations = this.resolveMorphLoadTargets(mapping, actualType, relatedRepository)
        if (relations.length === 0) {
          continue
        }

        const groupKey = `${relatedRepository.getConnectionName()}:${relatedRepository.definition.table.tableName}:${JSON.stringify(this.serializeMorphLoadTargets(relations))}`
        const group = groups.get(groupKey) ?? {
          repository: relatedRepository,
          relations,
          entities: [],
        }
        group.entities.push(relatedEntity)
        groups.set(groupKey, group)
      }
    }

    for (const group of groups.values()) {
      await group.repository.loadRelations(group.entities, group.relations, false)
    }
  }

  async loadRelationAggregates(
    entities: readonly Entity<TTable>[],
    aggregates: readonly AggregateLoad[],
  ): Promise<void> {
    if (entities.length === 0 || aggregates.length === 0) {
      return
    }

    for (const aggregate of aggregates) {
      if (aggregate.relation.includes('.')) {
        throw new SecurityError('Nested relation aggregates are not supported yet.')
      }

      const relation = this.getRelationDefinition(aggregate.relation)
      const key = this.getAggregateAttributeKey(aggregate)

      if (aggregate.kind === 'count' || aggregate.kind === 'exists') {
        const counts = await this.getRelationMatchCounts(entities, relation, aggregate.constraint)

        for (const entity of entities) {
          const parentKey = this.getRelationParentValue(entity, relation)
          const count = counts.get(parentKey) ?? 0
          entity.setComputed(key, aggregate.kind === 'count' ? count : count > 0)
        }

        continue
      }

      if (!aggregate.column) {
        throw new SecurityError(`Relation aggregate "${aggregate.kind}" requires a target column.`)
      }

      const values = await this.getRelationAggregateValues(entities, relation, aggregate)
      for (const entity of entities) {
        const parentKey = this.getRelationParentValue(entity, relation)
        entity.setComputed(key, values.get(parentKey) ?? null)
      }
    }
  }

  async create(values: Partial<ModelRecord<TTable>>): Promise<Entity<TTable>> {
    return this.createRecord(values)
  }

  async createQuietly(values: Partial<ModelRecord<TTable>>): Promise<Entity<TTable>> {
    return withoutModelEvents(() => this.createRecord(values))
  }

  async createMany(
    values: readonly Partial<ModelRecord<TTable>>[],
  ): Promise<ModelCollection<TTable>> {
    const created: Entity<TTable>[] = []
    for (const value of values) {
      created.push(await this.createRecord(value))
    }
    return this.createCollection(created)
  }

  async createManyQuietly(
    values: readonly Partial<ModelRecord<TTable>>[],
  ): Promise<ModelCollection<TTable>> {
    return withoutModelEvents(() => this.createMany(values))
  }

  async saveMany(
    entities: readonly Entity<TTable>[],
  ): Promise<ModelCollection<TTable>> {
    const saved: Entity<TTable>[] = []
    for (const entity of entities) {
      saved.push(await entity.save())
    }
    return this.createCollection(saved)
  }

  async saveManyQuietly(
    entities: readonly Entity<TTable>[],
  ): Promise<ModelCollection<TTable>> {
    return withoutModelEvents(() => this.saveMany(entities))
  }

  async update(id: unknown, values: Partial<ModelRecord<TTable>>): Promise<Entity<TTable>> {
    const existing = await this.findOrFail(id)
    existing.fill(values)
    return existing.save()
  }

  async delete(id: unknown): Promise<void> {
    const existing = await this.findOrFail(id)
    await existing.delete()
  }

  async destroy(ids: readonly unknown[]): Promise<number> {
    let deleted = 0
    for (const id of ids) {
      const existing = await this.find(id)
      if (!existing) {
        continue
      }

      await existing.delete()
      deleted += 1
    }

    return deleted
  }

  async prune(): Promise<number> {
    if (!this.definition.prunable) {
      throw new ConfigurationError(`Model "${this.definition.name}" does not define a prunable query.`)
    }

    const baseQuery = this.newQueryWithoutScopes()
    const configuredQuery = (this.definition.prunable(baseQuery) ?? baseQuery) as ModelQueryBuilder<TTable>

    if (this.definition.massPrunable) {
      const result = await configuredQuery.delete()
      return Number(result.affectedRows ?? 0)
    }

    const entities = await configuredQuery.get()
    for (const entity of entities) {
      if (this.definition.softDeletes) {
        await entity.forceDelete()
      } else {
        await entity.delete()
      }
    }

    return entities.length
  }

  associateRelation(
    entity: Entity<TTable>,
    relationName: string,
    relatedEntity: Entity | null,
  ): Entity<TTable> {
    const relation = this.getRelationDefinition(relationName)

    switch (relation.kind) {
      case 'belongsTo': {
        if (relatedEntity === null) {
          entity.set(relation.foreignKey as never, null as never)
          entity.setRelation(relationName, null)
          return entity
        }

        const related = this.resolveCompatibleRelatedRepository(relation.related, relationName, relatedEntity)
        const ownerKey = relatedEntity.get(relation.ownerKey as never)
        if (ownerKey === null || typeof ownerKey === 'undefined') {
          throw new HydrationError(`Cannot associate relation "${relationName}" with an unsaved ${related.definition.name}.`)
        }

        entity.set(relation.foreignKey as never, ownerKey as never)
        entity.setRelation(relationName, relatedEntity)
        return entity
      }
      case 'morphTo': {
        if (relatedEntity === null) {
          entity.set(relation.morphTypeColumn as never, null as never)
          entity.set(relation.morphIdColumn as never, null as never)
          entity.setRelation(relationName, null)
          return entity
        }

        const relatedRepository = relatedEntity.getRepository() as ModelRepository
        const relatedKey = relatedEntity.get(relatedRepository.definition.primaryKey as never)
        if (relatedKey === null || typeof relatedKey === 'undefined') {
          throw new HydrationError(`Cannot associate relation "${relationName}" with an unsaved ${relatedRepository.definition.name}.`)
        }

        entity.set(relation.morphTypeColumn as never, relatedRepository.definition.morphClass as never)
        entity.set(relation.morphIdColumn as never, relatedKey as never)
        entity.setRelation(relationName, relatedEntity)
        return entity
      }
      default:
        throw new SecurityError(`Relation "${relationName}" on model "${this.definition.name}" does not support association helpers.`)
    }
  }

  dissociateRelation(
    entity: Entity<TTable>,
    relationName: string,
  ): Entity<TTable> {
    return this.associateRelation(entity, relationName, null)
  }

  async saveRelatedEntity(
    entity: Entity<TTable>,
    relationName: string,
    relatedEntity: Entity,
  ): Promise<Entity> {
    const relation = this.getRelationDefinition(relationName)

    switch (relation.kind) {
      case 'belongsTo': {
        const related = this.resolveCompatibleRelatedRepository(relation.related, relationName, relatedEntity)
        const savedRelated = await related.saveEntity(relatedEntity)
        this.associateRelation(entity, relationName, savedRelated)
        entity.syncPersisted(await this.saveEntity(entity, new Set([relation.foreignKey])))
        return savedRelated
      }
      case 'morphTo': {
        const related = relatedEntity.getRepository() as ModelRepository
        const savedRelated = await related.saveEntity(relatedEntity)
        this.associateRelation(entity, relationName, savedRelated)
        entity.syncPersisted(await this.saveEntity(entity, new Set([relation.morphTypeColumn, relation.morphIdColumn])))
        return savedRelated
      }
      case 'hasMany':
      case 'hasOne':
      case 'hasOneOfMany': {
        this.assertPersistedParentForRelation(entity, relationName)
        const parentKey = entity.get(relation.localKey as never)
        const related = this.resolveCompatibleRelatedRepository(relation.related, relationName, relatedEntity)
        relatedEntity.set(relation.foreignKey as never, parentKey as never)
        const savedRelated = await related.saveEntity(relatedEntity, new Set([relation.foreignKey]))
        this.syncRelationAfterPersistence(entity, relationName, relation, savedRelated)
        return savedRelated
      }
      case 'morphOne':
      case 'morphMany':
      case 'morphOneOfMany': {
        this.assertPersistedParentForRelation(entity, relationName)
        const parentKey = entity.get(relation.localKey as never)
        const related = this.resolveCompatibleRelatedRepository(relation.related, relationName, relatedEntity)
        relatedEntity.set(relation.morphTypeColumn as never, this.getMorphTypeValue() as never)
        relatedEntity.set(relation.morphIdColumn as never, parentKey as never)
        const savedRelated = await related.saveEntity(
          relatedEntity,
          new Set([relation.morphTypeColumn, relation.morphIdColumn]),
        )
        this.syncRelationAfterPersistence(entity, relationName, relation, savedRelated)
        return savedRelated
      }
      case 'belongsToMany':
      case 'morphToMany':
      case 'morphedByMany': {
        this.assertPersistedParentForRelation(entity, relationName)
        const related = this.resolveCompatibleRelatedRepository(relation.related, relationName, relatedEntity)
        const savedRelated = await related.saveEntity(relatedEntity)
        const relatedId = savedRelated.get(related.definition.primaryKey as never)
        await this.attachRelation(entity, relationName, relatedId)
        this.syncRelationAfterPersistence(entity, relationName, relation, savedRelated)
        return savedRelated
      }
      default:
        throw new SecurityError(`Relation "${relationName}" on model "${this.definition.name}" does not support save helpers.`)
    }
  }

  async saveRelatedEntityQuietly(
    entity: Entity<TTable>,
    relationName: string,
    relatedEntity: Entity,
  ): Promise<Entity> {
    return withoutModelEvents(() => this.saveRelatedEntity(entity, relationName, relatedEntity))
  }

  async saveManyRelatedEntities(
    entity: Entity<TTable>,
    relationName: string,
    relatedEntities: readonly Entity[],
  ): Promise<Entity[]> {
    const relation = this.getRelationDefinition(relationName)
    this.assertRelationSupportsManyWrites(relationName, relation, relatedEntities.length)

    const saved: Entity[] = []
    for (const relatedEntity of relatedEntities) {
      saved.push(await this.saveRelatedEntity(entity, relationName, relatedEntity))
    }
    return saved
  }

  async saveManyRelatedEntitiesQuietly(
    entity: Entity<TTable>,
    relationName: string,
    relatedEntities: readonly Entity[],
  ): Promise<Entity[]> {
    return withoutModelEvents(() => this.saveManyRelatedEntities(entity, relationName, relatedEntities))
  }

  async createRelatedEntity(
    entity: Entity<TTable>,
    relationName: string,
    values: Record<string, unknown>,
  ): Promise<Entity> {
    const relation = this.getRelationDefinition(relationName)

    switch (relation.kind) {
      case 'belongsTo': {
        const related = this.resolveRelatedRepository(relation.related)
        const created = await related.createRecord(values as Partial<ModelRecord<typeof related.definition.table>>)
        this.associateRelation(entity, relationName, created)
        entity.syncPersisted(await this.saveEntity(entity, new Set([relation.foreignKey])))
        return created
      }
      case 'morphTo': {
        throw new SecurityError(`Relation "${relationName}" on model "${this.definition.name}" cannot create a morph target without an explicit related model type.`)
      }
      case 'hasMany':
      case 'hasOne':
      case 'hasOneOfMany': {
        this.assertPersistedParentForRelation(entity, relationName)
        const parentKey = entity.get(relation.localKey as never)
        const related = this.resolveRelatedRepository(relation.related)
        const created = await related.createRecord(
          {
            ...values,
            [relation.foreignKey]: parentKey,
          } as Partial<ModelRecord<typeof related.definition.table>>,
          new Set([relation.foreignKey]),
        )
        this.syncRelationAfterPersistence(entity, relationName, relation, created)
        return created
      }
      case 'morphOne':
      case 'morphMany':
      case 'morphOneOfMany': {
        this.assertPersistedParentForRelation(entity, relationName)
        const parentKey = entity.get(relation.localKey as never)
        const related = this.resolveRelatedRepository(relation.related)
        const created = await related.createRecord(
          {
            ...values,
            [relation.morphTypeColumn]: this.getMorphTypeValue(),
            [relation.morphIdColumn]: parentKey,
          } as Partial<ModelRecord<typeof related.definition.table>>,
          new Set([relation.morphTypeColumn, relation.morphIdColumn]),
        )
        this.syncRelationAfterPersistence(entity, relationName, relation, created)
        return created
      }
      case 'belongsToMany':
      case 'morphToMany':
      case 'morphedByMany': {
        this.assertPersistedParentForRelation(entity, relationName)
        const related = this.resolveRelatedRepository(relation.related)
        const created = await related.createRecord(values as Partial<ModelRecord<typeof related.definition.table>>)
        const relatedId = created.get(related.definition.primaryKey as never)
        await this.attachRelation(entity, relationName, relatedId)
        this.syncRelationAfterPersistence(entity, relationName, relation, created)
        return created
      }
      default:
        throw new SecurityError(`Relation "${relationName}" on model "${this.definition.name}" does not support create helpers.`)
    }
  }

  async createRelatedEntityQuietly(
    entity: Entity<TTable>,
    relationName: string,
    values: Record<string, unknown>,
  ): Promise<Entity> {
    return withoutModelEvents(() => this.createRelatedEntity(entity, relationName, values))
  }

  async createManyRelatedEntities(
    entity: Entity<TTable>,
    relationName: string,
    values: readonly Record<string, unknown>[],
  ): Promise<ModelCollection> {
    const relation = this.getRelationDefinition(relationName)
    this.assertRelationSupportsManyWrites(relationName, relation, values.length)

    const created: Entity[] = []
    for (const value of values) {
      created.push(await this.createRelatedEntity(entity, relationName, value))
    }
    return createModelCollection(created)
  }

  async createManyRelatedEntitiesQuietly(
    entity: Entity<TTable>,
    relationName: string,
    values: readonly Record<string, unknown>[],
  ): Promise<ModelCollection> {
    return withoutModelEvents(() => this.createManyRelatedEntities(entity, relationName, values))
  }

  private async createRecord(
    values: Partial<ModelRecord<TTable>>,
    internalColumns: ReadonlySet<string> = new Set(),
  ): Promise<Entity<TTable>> {
    return this.runWriteUnit(async () => {
      const generatedColumns = new Set<string>()
      for (const column of internalColumns) {
        generatedColumns.add(column)
      }
      if (this.definition.createdAtColumn) {
        generatedColumns.add(this.definition.createdAtColumn)
      }
      if (this.definition.updatedAtColumn) {
        generatedColumns.add(this.definition.updatedAtColumn)
      }
      const payload = this.sanitizeWritePayload(
        this.applyTimestampDefaults(
          this.applyGeneratedUniqueIds(this.applyPendingAttributes(values), generatedColumns),
          'create',
        ),
        'create',
        generatedColumns,
      )
      const entity = new Entity(this, payload, false)
      await this.dispatchCancelableEvent('saving', entity)
      await this.dispatchCancelableEvent('creating', entity)
      const result = await this.query().getTableQueryBuilder().insert(payload)
      const hasPrimaryKeyValue = Object.prototype.hasOwnProperty.call(payload, this.definition.primaryKey)
      const attributes = {
        ...payload,
        ...(!hasPrimaryKeyValue && typeof result.lastInsertId !== 'undefined'
          ? { [this.definition.primaryKey]: result.lastInsertId }
          : {}),
      } as Partial<ModelRecord<TTable>>
      const created = this.hydrate(attributes).syncOriginal()
      await this.dispatchEvent('created', created)
      await this.dispatchEvent('saved', created)
      await this.touchOwners(created)
      return created
    })
  }

  async restore(id: unknown): Promise<Entity<TTable>> {
    const primaryKey = this.definition.primaryKey
    const existing = await this.query().withTrashed().find(id, primaryKey)
    if (!existing) {
      throw new HydrationError(`${this.definition.name} record not found for key "${String(id)}".`)
    }

    return existing.restore()
  }

  async forceDelete(id: unknown): Promise<void> {
    const primaryKey = this.definition.primaryKey
    const existing = await this.query().withTrashed().find(id, primaryKey)
    if (!existing) {
      throw new HydrationError(`${this.definition.name} record not found for key "${String(id)}".`)
    }

    await this.forceDeleteEntity(existing)
  }

  async upsert(
    match: Partial<ModelRecord<TTable>>,
    values: Partial<ModelRecord<TTable>> = {},
  ): Promise<Entity<TTable>> {
    let query = this.query()
    for (const [column, value] of Object.entries(match)) {
      query = query.where(column as never, value)
    }

    const existing = await query.first()
    if (existing) {
      existing.fill(values)
      return existing.save()
    }

    return this.create({ ...match, ...values })
  }

  async updateOrCreate(
    match: Partial<ModelRecord<TTable>>,
    values: Partial<ModelRecord<TTable>> = {},
  ): Promise<Entity<TTable>> {
    return this.upsert(match, values)
  }

  sanitizeWritePayload(
    values: Partial<ModelRecord<TTable>> | Record<string, unknown>,
    mode: WriteMode,
    internalColumns: ReadonlySet<string> = new Set(),
  ): Partial<ModelUpdatePayload<TTable>> {
    const entries = Object.entries(values)

    if (entries.length === 0) {
      return {}
    }

    const sanitized = Object.fromEntries(entries.map(([key, value]) => {
      const columnName = key.includes('->') ? key.split('->')[0]! : key
      const column = this.definition.table.columns[columnName]
      if (!column) {
        throw new SecurityError(`Column "${columnName}" is not defined on model "${this.definition.name}".`)
      }

      if (typeof value === 'undefined') {
        throw new SecurityError(`${mode === 'create' ? 'Create' : 'Update'} value for column "${key}" cannot be undefined.`)
      }

      if (column.generated) {
        throw new SecurityError(`Column "${columnName}" is generated and cannot be written directly.`)
      }

      if (!internalColumns.has(columnName) && !this.isWritableColumn(columnName)) {
        throw new SecurityError(`Column "${columnName}" is not writable on model "${this.definition.name}".`)
      }

      if (key.includes('->')) {
        if (column.kind !== 'json') {
          throw new SecurityError(`Column "${columnName}" must be a JSON column to support nested JSON updates.`)
        }

        return [key, value]
      }

      return [key, this.normalizeForStorage(key, value)]
    }))

    return sanitized as Partial<ModelUpdatePayload<TTable>>
  }

  async saveEntity(
    entity: Entity<TTable>,
    internalColumns: ReadonlySet<string> = new Set(),
  ): Promise<Entity<TTable>> {
    if (!entity.exists()) {
      return this.createRecord(entity.toAttributes(), internalColumns)
    }

    return this.runWriteUnit(async () => {
      const primaryKey = this.definition.primaryKey
      const id = entity.get(primaryKey)
      if (typeof id === 'undefined' || id === null) {
        throw new HydrationError(`Cannot persist ${this.definition.name} without a primary key value.`)
      }

      const writableInternalColumns = new Set<string>(internalColumns)
      if (this.definition.updatedAtColumn) {
        writableInternalColumns.add(this.definition.updatedAtColumn)
      }
      const dirty = this.sanitizeWritePayload(
        this.applyTimestampDefaults(entity.getDirty() as Partial<ModelRecord<TTable>>, 'update'),
        'update',
        writableInternalColumns,
      )
      if (Object.keys(dirty).length === 0) {
        return entity
      }

      await this.dispatchCancelableEvent('saving', entity)
      await this.dispatchCancelableEvent('updating', entity)
      await this.query().where(primaryKey, id).getTableQueryBuilder().update(dirty)
      const updated = this.hydrate(entity.toAttributes())
      updated.syncOriginal()
      await this.dispatchEvent('updated', updated)
      await this.dispatchEvent('saved', updated)
      await this.touchOwners(updated)
      return updated
    })
  }

  async saveEntityQuietly(
    entity: Entity<TTable>,
    internalColumns: ReadonlySet<string> = new Set(),
  ): Promise<Entity<TTable>> {
    return withoutModelEvents(() => this.saveEntity(entity, internalColumns))
  }

  async deleteEntity(entity: Entity<TTable>): Promise<void> {
    await this.runWriteUnit(async () => {
      const primaryKey = this.definition.primaryKey
      const id = entity.get(primaryKey)
      if (typeof id === 'undefined' || id === null) {
        throw new HydrationError(`Cannot delete ${this.definition.name} without a primary key value.`)
      }

      await this.dispatchCancelableEvent('deleting', entity)
      const deletedAtColumn = this.getDeletedAtColumn()
      if (deletedAtColumn) {
        const deletedAt = new Date().toISOString()
        await this.query().withTrashed().getTableQueryBuilder().where(primaryKey as never, id).update({
          [deletedAtColumn]: deletedAt,
        })
        entity.set(deletedAtColumn as never, this.applyCastGet(this.definition.casts[deletedAtColumn], deletedAt) as never)
        await this.dispatchEvent('trashed', entity)
      } else {
        await this.query().where(primaryKey, id).delete()
      }

      await this.dispatchEvent('deleted', entity)
      await this.touchOwners(entity)
    })
  }

  async deleteEntityQuietly(entity: Entity<TTable>): Promise<void> {
    return withoutModelEvents(() => this.deleteEntity(entity))
  }

  shouldKeepEntityPersistedOnDelete(): boolean {
    return this.definition.softDeletes
  }

  async restoreEntity(entity: Entity<TTable>): Promise<Entity<TTable>> {
    return this.runWriteUnit(async () => {
      const deletedAtColumn = this.getDeletedAtColumn()
      if (!deletedAtColumn) {
        throw new HydrationError(`${this.definition.name} does not support soft deletes.`)
      }

      const primaryKey = this.definition.primaryKey
      const id = entity.get(primaryKey)
      if (typeof id === 'undefined' || id === null) {
        throw new HydrationError(`Cannot restore ${this.definition.name} without a primary key value.`)
      }

      await this.dispatchCancelableEvent('restoring', entity)
      await this.query().withTrashed().getTableQueryBuilder().where(primaryKey as never, id).update({
        [deletedAtColumn]: null,
      })
      entity.set(deletedAtColumn as never, null as never)
      const restored = this.hydrate(entity.toAttributes())
      restored.syncOriginal()
      await this.dispatchEvent('restored', restored)
      await this.touchOwners(restored)
      return restored
    })
  }

  async restoreEntityQuietly(entity: Entity<TTable>): Promise<Entity<TTable>> {
    return withoutModelEvents(() => this.restoreEntity(entity))
  }

  async forceDeleteEntity(entity: Entity<TTable>): Promise<void> {
    await this.runWriteUnit(async () => {
      const primaryKey = this.definition.primaryKey
      const id = entity.get(primaryKey)
      if (typeof id === 'undefined' || id === null) {
        throw new HydrationError(`Cannot force-delete ${this.definition.name} without a primary key value.`)
      }

      await this.dispatchCancelableEvent('deleting', entity)
      await this.dispatchCancelableEvent('forceDeleting', entity)
      await this.query().withTrashed().getTableQueryBuilder().where(primaryKey as never, id).delete()
      await this.dispatchEvent('forceDeleted', entity)
      await this.dispatchEvent('deleted', entity)
      await this.touchOwners(entity)
    })
  }

  private async runWriteUnit<TResult>(callback: () => Promise<TResult>): Promise<TResult> {
    if (this.connection.getScope().kind !== 'root') {
      return callback()
    }

    return this.connection.transaction(async () => callback())
  }

  async forceDeleteEntityQuietly(entity: Entity<TTable>): Promise<void> {
    return withoutModelEvents(() => this.forceDeleteEntity(entity))
  }

  replicateEntity(entity: Entity<TTable>, except: readonly string[] = []): Entity<TTable> {
    this.dispatchSyncEvent('replicating', entity)
    const stripped = new Set<string>([
      this.definition.primaryKey,
      ...this.definition.replicationExcludes,
      ...(this.definition.uniqueIdConfig?.columns ?? []),
      ...except,
    ])

    if (this.definition.createdAtColumn) {
      stripped.add(this.definition.createdAtColumn)
    }

    if (this.definition.updatedAtColumn) {
      stripped.add(this.definition.updatedAtColumn)
    }

    if (this.definition.deletedAtColumn) {
      stripped.add(this.definition.deletedAtColumn)
    }

    const attributes = Object.fromEntries(
      Object.entries(entity.toAttributes()).filter(([key]) => !stripped.has(key)),
    ) as Partial<ModelRecord<TTable>>

    return new Entity(this, attributes, false)
  }

  async attachRelation(
    entity: Entity<TTable>,
    relationName: string,
    ids: unknown,
    attributes: PivotAttributes = {},
  ): Promise<void> {
    const context = this.getPivotMutationContext(entity, relationName)
    const entries = this.normalizePivotInput(ids, attributes)
    this.assertValidPivotEntries(relationName, entries, context.relation)
    if (entries.length === 0) {
      return
    }

    await this.connection.transaction(async (tx) => {
      const currentRows = await this.getPivotRows(context, tx, entries.map(entry => entry.id))
      const currentMap = this.indexPivotRows(currentRows, this.getPivotRelatedIdColumn(context.relation))

      for (const entry of entries) {
        const existing = currentMap.get(String(entry.id))
        if (existing) {
          if (this.pivotAttributesChanged(existing, entry.attributes, context.relation)) {
            await this.updatePivotRow(context, tx, entry.id, entry.attributes)
          }
          continue
        }

        await this.insertPivotRow(context, tx, entry.id, entry.attributes)
      }
    })
  }

  async detachRelation(
    entity: Entity<TTable>,
    relationName: string,
    ids?: unknown,
  ): Promise<number> {
    const context = this.getPivotMutationContext(entity, relationName)

    return this.connection.transaction(async (tx) => {
      if (typeof ids === 'undefined' || ids === null) {
        return this.deletePivotRows(context, tx)
      }

      const entries = this.normalizePivotInput(ids)
      if (entries.length === 0) {
        return 0
      }

      return this.deletePivotRows(context, tx, entries.map(entry => entry.id))
    })
  }

  async syncRelation(
    entity: Entity<TTable>,
    relationName: string,
    ids: unknown,
    detachMissing: boolean,
  ): Promise<PivotSyncResult> {
    const context = this.getPivotMutationContext(entity, relationName)
    const entries = this.normalizePivotInput(ids)
    this.assertValidPivotEntries(relationName, entries, context.relation)
    const desiredMap = new Map(entries.map(entry => [String(entry.id), entry]))
    const result: PivotSyncResult = { attached: [], detached: [], updated: [] }

    await this.connection.transaction(async (tx) => {
      const currentRows = await this.getPivotRows(context, tx)
      const currentMap = this.indexPivotRows(currentRows, this.getPivotRelatedIdColumn(context.relation))

      for (const entry of entries) {
        const existing = currentMap.get(String(entry.id))
        if (!existing) {
          await this.insertPivotRow(context, tx, entry.id, entry.attributes)
          result.attached.push(entry.id)
          continue
        }

        if (this.pivotAttributesChanged(existing, entry.attributes, context.relation)) {
          await this.updatePivotRow(context, tx, entry.id, entry.attributes)
          result.updated.push(entry.id)
        }
      }

      if (detachMissing) {
        const idsToDetach = [...currentMap.keys()]
          .filter(key => !desiredMap.has(key))
          .map(key => currentMap.get(key)?.[this.getPivotRelatedIdColumn(context.relation)])
          .filter(value => typeof value !== 'undefined')

        if (idsToDetach.length > 0) {
          await this.deletePivotRows(context, tx, idsToDetach)
          result.detached.push(...idsToDetach)
        }
      }
    })

    return result
  }

  async updateExistingPivot(
    entity: Entity<TTable>,
    relationName: string,
    id: unknown,
    attributes: PivotAttributes,
  ): Promise<number> {
    const context = this.getPivotMutationContext(entity, relationName)
    this.assertValidPivotAttributes(relationName, attributes, context.relation)
    if (Object.keys(attributes).length === 0) return 0
    const [existing] = await this.getPivotRows(context, this.connection, [id])
    if (!existing) return 0
    if (!this.pivotAttributesChanged(existing, attributes, context.relation)) return 0
    await this.updatePivotRow(context, this.connection, id, attributes)
    return 1
  }

  async toggleRelation(
    entity: Entity<TTable>,
    relationName: string,
    ids: unknown,
  ): Promise<PivotToggleResult> {
    const context = this.getPivotMutationContext(entity, relationName)
    const entries = this.normalizePivotInput(ids)
    this.assertValidPivotEntries(relationName, entries, context.relation)
    const result: PivotToggleResult = { attached: [], detached: [] }

    if (entries.length === 0) {
      return result
    }

    await this.connection.transaction(async (tx) => {
      const currentRows = await this.getPivotRows(context, tx, entries.map(entry => entry.id))
      const currentMap = this.indexPivotRows(currentRows, this.getPivotRelatedIdColumn(context.relation))

      for (const entry of entries) {
        if (currentMap.has(String(entry.id))) {
          await this.deletePivotRows(context, tx, [entry.id])
          result.detached.push(entry.id)
          continue
        }

        await this.insertPivotRow(context, tx, entry.id, entry.attributes)
        result.attached.push(entry.id)
      }
    })

    return result
  }

  private async loadRelation(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: RelationDefinition,
    constraint?: RelationConstraint,
  ): Promise<void> {
    switch (relation.kind) {
      case 'belongsTo':
        await this.loadBelongsToRelation(entities, relationName, relation, constraint)
        return
      case 'morphTo':
        await this.loadMorphToRelation(entities, relationName, relation, constraint)
        return
      case 'hasMany':
        await this.loadHasManyRelation(entities, relationName, relation, constraint)
        return
      case 'hasOne':
        await this.loadHasOneRelation(entities, relationName, relation, constraint)
        return
      case 'hasOneOfMany':
        await this.loadHasOneOfManyRelation(entities, relationName, relation, constraint)
        return
      case 'morphOne':
        await this.loadMorphOneRelation(entities, relationName, relation, constraint)
        return
      case 'morphMany':
        await this.loadMorphManyRelation(entities, relationName, relation, constraint)
        return
      case 'morphOneOfMany':
        await this.loadMorphOneOfManyRelation(entities, relationName, relation, constraint)
        return
      case 'hasOneThrough':
        await this.loadHasOneThroughRelation(entities, relationName, relation, constraint)
        return
      case 'hasManyThrough':
        await this.loadHasManyThroughRelation(entities, relationName, relation, constraint)
        return
      case 'belongsToMany':
        await this.loadBelongsToManyRelation(entities, relationName, relation, constraint)
        return
      case 'morphToMany':
        await this.loadMorphToManyRelation(entities, relationName, relation, constraint)
        return
      case 'morphedByMany':
        await this.loadMorphedByManyRelation(entities, relationName, relation, constraint)
        return
    }
  }

  private createQuery(
    applySoftDeletes: boolean,
    applyGlobalScopes: boolean,
    applyDefaultRelations: boolean,
    excludedGlobalScopes: ReadonlySet<string> = new Set(),
  ): ModelQueryBuilder<TTable> {
    let query = new ModelQueryBuilder(
      this,
      new TableQueryBuilder(this.definition.table, this.connection),
    )

    const deletedAtColumn = this.getDeletedAtColumn()
    if (applySoftDeletes && deletedAtColumn) {
      query = query.whereNull(deletedAtColumn as never)
    }

    if (applyGlobalScopes) {
      for (const [name, scope] of Object.entries(this.definition.globalScopes)) {
        if (excludedGlobalScopes.has(name)) {
          continue
        }
        query = (scope as (query: ModelQueryBuilder<TTable>) => ModelQueryBuilder<TTable> | unknown)(query) as ModelQueryBuilder<TTable>
      }
    }

    if (applyDefaultRelations && this.definition.with.length > 0) {
      query = query.with(...this.definition.with)
    }

    return query
  }

  private collectLoadedRelationEntities(
    entities: readonly Entity<TTable>[],
    relationName: string,
  ): Entity[] {
    const collected: Entity[] = []

    for (const entity of entities) {
      const loaded = entity.getRelation<unknown>(relationName)
      if (Array.isArray(loaded)) {
        for (const item of loaded) {
          if (isEntity(item)) {
            collected.push(item)
          }
        }
        continue
      }

      if (isEntity(loaded)) {
        collected.push(loaded)
      }
    }

    return collected
  }

  private async loadBelongsToRelation(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'belongsTo' }>,
    constraint?: RelationConstraint,
  ): Promise<void> {
    const foreignKeys = [...new Set(
      entities
        .map(entity => entity.toAttributes()[relation.foreignKey as keyof ReturnType<typeof entity.toAttributes>])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (foreignKeys.length === 0) {
      for (const entity of entities) {
        entity.setRelation(relationName, null)
      }
      return
    }

    const related = this.resolveRelatedRepository(relation.related)
    const relatedEntities = await this.applyRelationConstraint(relation, related, constraint)
      .where(relation.ownerKey, 'in', foreignKeys)
      .get()
    const relatedMap = new Map(
      relatedEntities.map(entity => [entity.get(relation.ownerKey as never), entity]),
    )

    for (const entity of entities) {
      const foreignKey = entity.toAttributes()[relation.foreignKey as keyof ReturnType<typeof entity.toAttributes>]
      entity.setRelation(relationName, relatedMap.get(foreignKey) ?? null)
    }
  }

  private async loadHasManyRelation(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'hasMany' }>,
    constraint?: RelationConstraint,
  ): Promise<void> {
    const localKeys = [...new Set(
      entities
        .map(entity => entity.toAttributes()[relation.localKey as keyof ReturnType<typeof entity.toAttributes>])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (localKeys.length === 0) {
      for (const entity of entities) {
        entity.setRelation(relationName, [])
      }
      return
    }

    const related = this.resolveRelatedRepository(relation.related)
    const relatedEntities = await this.applyRelationConstraint(relation, related, constraint)
      .where(relation.foreignKey, 'in', localKeys)
      .get()
    const grouped = new Map<unknown, unknown[]>()

    for (const relatedEntity of relatedEntities) {
      const foreignKey = relatedEntity.get(relation.foreignKey as never)
      const bucket = grouped.get(foreignKey) ?? []
      bucket.push(relatedEntity)
      grouped.set(foreignKey, bucket)
    }

    for (const entity of entities) {
      const localKey = entity.toAttributes()[relation.localKey as keyof ReturnType<typeof entity.toAttributes>]
      entity.setRelation(relationName, grouped.get(localKey) ?? [])
    }
  }

  private async loadHasOneRelation(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'hasOne' }>,
    constraint?: RelationConstraint,
  ): Promise<void> {
    await this.loadHasManyRelation(entities, relationName, {
      ...relation,
      kind: 'hasMany',
    }, constraint)

    for (const entity of entities) {
      const loaded = entity.getRelation<unknown[]>(relationName)
      entity.setRelation(relationName, loaded[0] ?? null)
    }
  }

  private async loadHasOneOfManyRelation(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'hasOneOfMany' }>,
    constraint?: RelationConstraint,
  ): Promise<void> {
    const grouped = await this.getHasManyEntitiesByParentKey(entities, relation, constraint)

    for (const entity of entities) {
      const localKey = entity.toAttributes()[relation.localKey as keyof ReturnType<typeof entity.toAttributes>]
      entity.setRelation(relationName, grouped.get(localKey)?.[0] ?? null)
    }
  }

  private async loadMorphManyRelation(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'morphMany' }>,
    constraint?: RelationConstraint,
  ): Promise<void> {
    const grouped = await this.getMorphManyEntitiesByParentKey(entities, relation, constraint)

    for (const entity of entities) {
      const localKey = entity.toAttributes()[relation.localKey as keyof ReturnType<typeof entity.toAttributes>]
      entity.setRelation(relationName, grouped.get(localKey) ?? [])
    }
  }

  private async loadMorphOneRelation(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'morphOne' }>,
    constraint?: RelationConstraint,
  ): Promise<void> {
    const grouped = await this.getMorphManyEntitiesByParentKey(entities, relation, constraint)

    for (const entity of entities) {
      const localKey = entity.toAttributes()[relation.localKey as keyof ReturnType<typeof entity.toAttributes>]
      entity.setRelation(relationName, grouped.get(localKey)?.[0] ?? null)
    }
  }

  private async loadMorphOneOfManyRelation(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'morphOneOfMany' }>,
    constraint?: RelationConstraint,
  ): Promise<void> {
    const grouped = await this.getMorphManyEntitiesByParentKey(entities, relation, constraint)

    for (const entity of entities) {
      const localKey = entity.toAttributes()[relation.localKey as keyof ReturnType<typeof entity.toAttributes>]
      entity.setRelation(relationName, grouped.get(localKey)?.[0] ?? null)
    }
  }

  private async loadMorphToRelation(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'morphTo' }>,
    constraint?: RelationConstraint,
  ): Promise<void> {
    const grouped = await this.getMorphToEntitiesByParentKey(entities, relation, constraint)

    for (const entity of entities) {
      const key = entity.get(this.definition.primaryKey as never)
      entity.setRelation(relationName, grouped.get(key)?.[0] ?? null)
    }
  }

  private async loadHasManyThroughRelation(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'hasManyThrough' }>,
    constraint?: RelationConstraint,
  ): Promise<void> {
    const grouped = await this.getThroughEntitiesByParentKey(entities, relation, constraint)

    for (const entity of entities) {
      const parentKey = this.getRelationParentValue(entity, relation)
      entity.setRelation(relationName, grouped.get(parentKey) ?? [])
    }
  }

  private async loadHasOneThroughRelation(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'hasOneThrough' }>,
    constraint?: RelationConstraint,
  ): Promise<void> {
    const grouped = await this.getThroughEntitiesByParentKey(entities, relation, constraint)

    for (const entity of entities) {
      const parentKey = this.getRelationParentValue(entity, relation)
      entity.setRelation(relationName, grouped.get(parentKey)?.[0] ?? null)
    }
  }

  private async loadBelongsToManyRelation(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'belongsToMany' }>,
    constraint?: RelationConstraint,
  ): Promise<void> {
    const parentKeys = [...new Set(
      entities
        .map(entity => entity.toAttributes()[relation.parentKey as keyof ReturnType<typeof entity.toAttributes>])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (parentKeys.length === 0) {
      for (const entity of entities) {
        entity.setRelation(relationName, [])
      }
      return
    }

    const pivotRows = await this.createBelongsToManyPivotQuery(relation, this.connection)
      .where(relation.foreignPivotKey, 'in', parentKeys)
      .get<Record<string, unknown>>()

    if (pivotRows.length === 0) {
      for (const entity of entities) {
        entity.setRelation(relationName, [])
      }
      return
    }

    const relatedIds = [...new Set(
      pivotRows
        .map(row => row[relation.relatedPivotKey])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (relatedIds.length === 0) {
      for (const entity of entities) {
        entity.setRelation(relationName, [])
      }
      return
    }

    const related = this.resolveRelatedRepository(relation.related)
    const relatedEntities = await this.applyRelationConstraint(relation, related, constraint)
      .where(relation.relatedKey, 'in', relatedIds)
      .get()
    const relatedMap = new Map(
      relatedEntities.map(entity => [entity.get(relation.relatedKey as never), entity]),
    )
    const grouped = new Map<unknown, Entity[]>()

    for (const row of pivotRows) {
      const parentKey = row[relation.foreignPivotKey]
      const relatedKey = row[relation.relatedPivotKey]
      const relatedEntity = relatedMap.get(relatedKey)
      if (!relatedEntity) {
        continue
      }

      const bucket = grouped.get(parentKey) ?? []
      bucket.push(this.attachPivotAttributes(relatedEntity, row, relation))
      grouped.set(parentKey, bucket)
    }

    for (const entity of entities) {
      const parentKey = entity.toAttributes()[relation.parentKey as keyof ReturnType<typeof entity.toAttributes>]
      entity.setRelation(relationName, grouped.get(parentKey) ?? [])
    }
  }

  private async loadMorphToManyRelation(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'morphToMany' }>,
    constraint?: RelationConstraint,
  ): Promise<void> {
    const grouped = await this.getMorphToManyEntitiesByParentKey(entities, relation, constraint)

    for (const entity of entities) {
      const parentKey = entity.toAttributes()[relation.parentKey as keyof ReturnType<typeof entity.toAttributes>]
      entity.setRelation(relationName, grouped.get(parentKey) ?? [])
    }
  }

  private async loadMorphedByManyRelation(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'morphedByMany' }>,
    constraint?: RelationConstraint,
  ): Promise<void> {
    const grouped = await this.getMorphedByManyEntitiesByParentKey(entities, relation, constraint)

    for (const entity of entities) {
      const parentKey = entity.toAttributes()[relation.parentKey as keyof ReturnType<typeof entity.toAttributes>]
      entity.setRelation(relationName, grouped.get(parentKey) ?? [])
    }
  }

  private resolveRelatedRepository(related: () => ModelDefinitionLike): ModelRepository {
    return ModelRepository.from(related())
  }

  private resolveThroughRepository(through: () => ModelDefinitionLike): ModelRepository {
    return ModelRepository.from(through())
  }

  private getMorphTypeValue(): string {
    return this.definition.morphClass
  }

  private resolveMorphRepository(type: string): ModelRepository {
    const reference = resolveMorphModel(type)
    if (!reference) {
      throw new HydrationError(`Morph type "${type}" is not registered.`)
    }

    return ModelRepository.from(reference)
  }

  private normalizeEagerLoads(
    relations: readonly (string | EagerLoad)[],
  ): readonly EagerLoad[] {
    return relations.map((relation) => {
      if (typeof relation === 'string') {
        return { relation }
      }

      return relation
    })
  }

  private async getMatchingParentKeys(
    entities: readonly Entity<TTable>[],
    relation: RelationDefinition,
    constraint?: RelationConstraint,
    morphTypes?: readonly string[],
  ): Promise<Set<unknown>> {
    switch (relation.kind) {
      case 'belongsTo':
        return this.getMatchingBelongsToParentKeys(entities, relation, constraint)
      case 'morphTo':
        return this.getMatchingMorphToParentKeys(entities, relation, constraint, morphTypes)
      case 'hasMany':
      case 'hasOne':
      case 'hasOneOfMany':
        return this.getMatchingHasManyParentKeys(entities, relation, constraint)
      case 'morphOne':
      case 'morphMany':
      case 'morphOneOfMany':
        return this.getMatchingMorphManyParentKeys(entities, relation, constraint)
      case 'hasOneThrough':
      case 'hasManyThrough':
        return this.getMatchingThroughParentKeys(entities, relation, constraint)
      case 'belongsToMany':
        return this.getMatchingBelongsToManyParentKeys(entities, relation, constraint)
      case 'morphToMany':
        return this.getMatchingMorphToManyParentKeys(entities, relation, constraint)
      case 'morphedByMany':
        return this.getMatchingMorphedByManyParentKeys(entities, relation, constraint)
    }
  }

  private async getRelationMatchCounts(
    entities: readonly Entity<TTable>[],
    relation: RelationDefinition,
    constraint?: RelationConstraint,
  ): Promise<Map<unknown, number>> {
    switch (relation.kind) {
      case 'belongsTo':
        return this.getBelongsToMatchCounts(entities, relation, constraint)
      case 'morphTo':
        return this.getMorphToMatchCounts(entities, relation, constraint)
      case 'hasMany':
      case 'hasOne':
      case 'hasOneOfMany':
        return this.getHasManyMatchCounts(entities, relation, constraint)
      case 'morphOne':
      case 'morphMany':
      case 'morphOneOfMany':
        return this.getMorphManyMatchCounts(entities, relation, constraint)
      case 'hasOneThrough':
      case 'hasManyThrough':
        return this.getThroughMatchCounts(entities, relation, constraint)
      case 'belongsToMany':
        return this.getBelongsToManyMatchCounts(entities, relation, constraint)
      case 'morphToMany':
        return this.getMorphToManyMatchCounts(entities, relation, constraint)
      case 'morphedByMany':
        return this.getMorphedByManyMatchCounts(entities, relation, constraint)
    }
  }

  private applyRelationConstraint(
    relation: RelationDefinition,
    repository: ModelRepository,
    constraint?: RelationConstraint,
  ): ModelQueryBuilder {
    const query = repository.query()
    const relationConstraint = relation.constraint
    const relationResult = relationConstraint?.(query)
    const constrained = relationResult instanceof ModelQueryBuilder ? relationResult : query

    if (!constraint) {
      return constrained
    }

    const result = constraint(constrained)
    return result instanceof ModelQueryBuilder ? result : constrained
  }

  private buildRelationExistenceSubqueries(
    relation: RelationDefinition,
    constraint?: RelationConstraint,
    morphTypes?: readonly string[],
  ): readonly TableQueryBuilder<TableDefinition, Record<string, unknown>>[] {
    switch (relation.kind) {
      case 'belongsTo': {
        const related = this.resolveRelatedRepository(relation.related)
        return [this.applyRelationConstraint(relation, related, constraint)
          .getTableQueryBuilder()
          .whereColumn(relation.ownerKey, '=', this.qualifyParentColumn(relation.foreignKey))]
      }
      case 'hasMany':
      case 'hasOne':
      case 'hasOneOfMany': {
        const related = this.resolveRelatedRepository(relation.related)
        return [this.applyRelationConstraint(relation, related, constraint)
          .getTableQueryBuilder()
          .whereColumn(relation.foreignKey, '=', this.qualifyParentColumn(relation.localKey))]
      }
      case 'morphOne':
      case 'morphMany':
      case 'morphOneOfMany': {
        const related = this.resolveRelatedRepository(relation.related)
        return [this.applyRelationConstraint(relation, related, constraint)
          .getTableQueryBuilder()
          .where(relation.morphTypeColumn, this.getMorphTypeValue())
          .whereColumn(relation.morphIdColumn, '=', this.qualifyParentColumn(relation.localKey))]
      }
      case 'morphTo': {
        const references = this.resolveMorphExistenceReferences(morphTypes)
        return references.map((reference) => {
          const related = ModelRepository.from(reference)
          return this.applyRelationConstraint(relation, related, constraint)
            .getTableQueryBuilder()
            .where(this.qualifyParentColumn(relation.morphTypeColumn), related.definition.morphClass)
            .whereColumn(related.definition.primaryKey, '=', this.qualifyParentColumn(relation.morphIdColumn))
        })
      }
      case 'hasOneThrough':
      case 'hasManyThrough': {
        const through = this.resolveThroughRepository(relation.through)
        const related = this.resolveRelatedRepository(relation.related)
        const throughTable = through.definition.table.tableName
        const relatedTable = related.definition.table.tableName

        return [this.applyRelationConstraint(relation, related, constraint)
          .getTableQueryBuilder()
          .join(
            throughTable,
            `${throughTable}.${relation.secondLocalKey}`,
            '=',
            `${relatedTable}.${relation.secondKey}`,
          )
          .whereColumn(`${throughTable}.${relation.firstKey}`, '=', this.qualifyParentColumn(relation.localKey))]
      }
      case 'belongsToMany': {
        const related = this.resolveRelatedRepository(relation.related)
        const pivotSubquery = this.createBelongsToManyPivotQuery(relation, this.connection)
          .select(relation.relatedPivotKey)
          .whereColumn(relation.foreignPivotKey, '=', this.qualifyParentColumn(relation.parentKey))

        return [this.applyRelationConstraint(relation, related, constraint)
          .getTableQueryBuilder()
          .whereInSub(relation.relatedKey, pivotSubquery)]
      }
      case 'morphToMany': {
        const related = this.resolveRelatedRepository(relation.related)
        const pivotSubquery = this.createMorphToManyPivotQuery(relation, this.connection)
          .select(relation.foreignPivotKey)
          .where(relation.morphTypeColumn, this.getMorphTypeValue())
          .whereColumn(relation.morphIdColumn, '=', this.qualifyParentColumn(relation.parentKey))

        return [this.applyRelationConstraint(relation, related, constraint)
          .getTableQueryBuilder()
          .whereInSub(relation.relatedKey, pivotSubquery)]
      }
      case 'morphedByMany': {
        const related = this.resolveRelatedRepository(relation.related)
        const pivotSubquery = this.createMorphedByManyPivotQuery(relation, related.definition.morphClass, this.connection)
          .select(relation.morphIdColumn)
          .whereColumn(relation.foreignPivotKey, '=', this.qualifyParentColumn(relation.parentKey))

        return [this.applyRelationConstraint(relation, related, constraint)
          .getTableQueryBuilder()
          .whereInSub(relation.relatedKey, pivotSubquery)]
      }
    }
  }

  private resolveMorphExistenceReferences(
    selectors?: readonly string[],
  ): readonly ModelDefinitionLike[] {
    const references = listMorphModels()
    if (!selectors || selectors.length === 0) {
      return references
    }

    return references.filter((reference) => {
      const definition = getModelDefinition(reference)
      const candidates = new Set([
        definition.morphClass,
        definition.morphClass.toLowerCase(),
        definition.name,
        definition.name.toLowerCase(),
        definition.table.tableName,
        definition.table.tableName.toLowerCase(),
      ])

      return selectors.some((selector) => {
        const normalized = selector.toLowerCase()
        return candidates.has(selector) || candidates.has(normalized)
      })
    })
  }

  private assertRelationExistenceSupported(
    relationName: string,
    relation: RelationDefinition,
    morphTypes?: readonly string[],
  ): void {
    const parentConnectionName = this.getConnectionName()
    const ensureSameConnection = (repository: ModelRepository, target: 'related' | 'through' = 'related') => {
      const targetConnectionName = repository.getConnectionName()
      if (targetConnectionName === parentConnectionName) {
        return
      }

      throw new RelationError(
        `Cross-connection relation existence queries are not supported for relation "${relationName}" on model "${this.definition.name}". `
        + `The parent query uses connection "${parentConnectionName}" but the ${target} model uses "${targetConnectionName}". `
        + 'Use eager loading, relation aggregates, or explicit multi-step queries instead.',
      )
    }

    switch (relation.kind) {
      case 'belongsTo':
      case 'hasMany':
      case 'hasOne':
      case 'hasOneOfMany':
      case 'morphOne':
      case 'morphMany':
      case 'morphOneOfMany':
      case 'belongsToMany':
      case 'morphToMany':
      case 'morphedByMany':
        ensureSameConnection(this.resolveRelatedRepository(relation.related))
        return
      case 'hasOneThrough':
      case 'hasManyThrough':
        ensureSameConnection(this.resolveThroughRepository(relation.through), 'through')
        ensureSameConnection(this.resolveRelatedRepository(relation.related))
        return
      case 'morphTo':
        for (const reference of this.resolveMorphExistenceReferences(morphTypes)) {
          ensureSameConnection(ModelRepository.from(reference))
        }
    }
  }

  private applyExistsBoolean(
    query: TableQueryBuilder<TTable, Record<string, unknown>>,
    subquery: TableQueryBuilder<TableDefinition, Record<string, unknown>>,
    boolean: 'and' | 'or',
    negate: boolean,
  ): TableQueryBuilder<TTable, Record<string, unknown>> {
    if (boolean === 'or') {
      return negate
        ? query.orWhereNotExists(subquery)
        : query.orWhereExists(subquery)
    }

    return negate
      ? query.whereNotExists(subquery)
      : query.whereExists(subquery)
  }

  private applyExistsBooleanGroup(
    query: TableQueryBuilder<TTable, Record<string, unknown>>,
    subqueries: readonly TableQueryBuilder<TableDefinition, Record<string, unknown>>[],
    boolean: 'and' | 'or',
    negate: boolean,
  ): TableQueryBuilder<TTable, Record<string, unknown>> {
    const callback = (builder: TableQueryBuilder<TTable, Record<string, unknown>>) => {
      let next = builder
      for (const [index, subquery] of subqueries.entries()) {
        const method = index === 0 ? 'whereExists' : 'orWhereExists'
        next = next[method](subquery as never) as TableQueryBuilder<TTable, Record<string, unknown>>
      }
      return next
    }

    if (boolean === 'or') {
      return negate
        ? query.orWhereNot(callback)
        : query.orWhere(callback)
    }

    return negate
      ? query.whereNot(callback)
      : query.where(callback)
  }

  private qualifyParentColumn(column: string): string {
    return `${this.definition.table.tableName}.${column}`
  }

  private getRelationParentValue(
    entity: Entity<TTable>,
    relation: RelationDefinition,
  ): unknown {
    switch (relation.kind) {
      case 'belongsTo':
        return entity.toAttributes()[relation.foreignKey as keyof ReturnType<typeof entity.toAttributes>]
      case 'morphTo':
        return entity.toAttributes()[this.definition.primaryKey as keyof ReturnType<typeof entity.toAttributes>]
      case 'hasMany':
      case 'hasOne':
      case 'hasOneOfMany':
      case 'morphOne':
      case 'morphMany':
      case 'morphOneOfMany':
      case 'hasOneThrough':
      case 'hasManyThrough':
        return entity.toAttributes()[relation.localKey as keyof ReturnType<typeof entity.toAttributes>]
      case 'belongsToMany':
      case 'morphToMany':
      case 'morphedByMany':
        return entity.toAttributes()[relation.parentKey as keyof ReturnType<typeof entity.toAttributes>]
    }
  }

  private getAggregateAttributeKey(aggregate: AggregateLoad): string {
    if (aggregate.alias) {
      return aggregate.alias
    }

    if (aggregate.kind === 'count' || aggregate.kind === 'exists') {
      return `${aggregate.relation}_${aggregate.kind}`
    }

    return `${aggregate.relation}_${aggregate.kind}_${aggregate.column}`
  }

  private async getRelationAggregateValues(
    entities: readonly Entity<TTable>[],
    relation: RelationDefinition,
    aggregate: AggregateLoad,
  ): Promise<Map<unknown, unknown>> {
    if (aggregate.kind === 'count' || aggregate.kind === 'exists') {
      throw new SecurityError(`Relation aggregate "${aggregate.kind}" does not require a value pipeline.`)
    }

    const column = aggregate.column
    if (!column) {
      throw new SecurityError(`Relation aggregate "${aggregate.kind}" requires a target column.`)
    }

    if (relation.kind === 'morphTo') {
      throw new SecurityError('Column relation aggregates are not supported for morph-to relations.')
    }

    const related = this.resolveRelatedRepository(relation.related)
    if (!(column in related.definition.table.columns)) {
      throw new SecurityError(`Column "${column}" is not defined on related model "${related.definition.name}".`)
    }

    const grouped = await this.getRelatedEntitiesByParentKey(entities, relation, aggregate.constraint)
    const values = new Map<unknown, unknown>()

    for (const entity of entities) {
      const parentKey = this.getRelationParentValue(entity, relation)
      const relatedEntities = grouped.get(parentKey) ?? []
      values.set(parentKey, this.computeAggregateValue(aggregate.kind, relatedEntities, column))
    }

    return values
  }

  private computeAggregateValue(
    kind: Exclude<RelationAggregateKind, 'count' | 'exists'>,
    entities: readonly Entity[],
    column: string,
  ): number | null {
    const values = entities.map(entity => entity.toAttributes()[column as keyof ReturnType<typeof entity.toAttributes>])

    switch (kind) {
      case 'sum': {
        const numbers = values.map(value => this.assertNumericAggregateValue(value, kind, column))
        return numbers.reduce((sum, value) => sum + value, 0)
      }
      case 'avg': {
        const numbers = values.map(value => this.assertNumericAggregateValue(value, kind, column))
        if (numbers.length === 0) {
          return null
        }
        return numbers.reduce((sum, value) => sum + value, 0) / numbers.length
      }
      case 'min': {
        const numbers = values.map(value => this.assertNumericAggregateValue(value, kind, column))
        if (numbers.length === 0) {
          return null
        }
        return Math.min(...numbers)
      }
      case 'max': {
        const numbers = values.map(value => this.assertNumericAggregateValue(value, kind, column))
        if (numbers.length === 0) {
          return null
        }
        return Math.max(...numbers)
      }
    }
  }

  private assertNumericAggregateValue(
    value: unknown,
    kind: Exclude<RelationAggregateKind, 'count' | 'exists'>,
    column: string,
  ): number {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new DatabaseError(`Relation aggregate "${kind}" requires numeric values for column "${column}".`)
    }

    return value
  }

  private async getRelatedEntitiesByParentKey(
    entities: readonly Entity<TTable>[],
    relation: Exclude<RelationDefinition, { kind: 'morphTo' }>,
    constraint?: RelationConstraint,
  ): Promise<Map<unknown, Entity[]>> {
    switch (relation.kind) {
      case 'belongsTo':
        return this.getBelongsToEntitiesByParentKey(entities, relation, constraint)
      case 'hasMany':
      case 'hasOne':
      case 'hasOneOfMany':
        return this.getHasManyEntitiesByParentKey(entities, relation, constraint)
      case 'morphOne':
      case 'morphMany':
      case 'morphOneOfMany':
        return this.getMorphManyEntitiesByParentKey(entities, relation, constraint)
      case 'hasOneThrough':
      case 'hasManyThrough':
        return this.getThroughEntitiesByParentKey(entities, relation, constraint)
      case 'belongsToMany':
        return this.getBelongsToManyEntitiesByParentKey(entities, relation, constraint)
      case 'morphToMany':
        return this.getMorphToManyEntitiesByParentKey(entities, relation, constraint)
      case 'morphedByMany':
        return this.getMorphedByManyEntitiesByParentKey(entities, relation, constraint)
    }
  }

  attachCollection(entities: readonly Entity<TTable>[]): readonly Entity<TTable>[] {
    for (const entity of entities) {
      entity.bindPeerCollection(entities)
    }

    return entities
  }

  resolveRelationProperty(entity: Entity<TTable>, relationName: string): unknown {
    const relation = this.getRelationDefinition(relationName)
    const pending = entity.getPendingRelationLoad(relationName)
    if (pending) {
      return pending.then(() => entity.getRelation(relationName))
    }

    const settings = getModelRuntimeSettings(this.definition)
    if (settings.preventLazyLoading && !settings.automaticEagerLoading) {
      throw new HydrationError(
        `Lazy loading relation "${relationName}" is disabled on model "${this.definition.name}".`,
      )
    }

    const peers = (
      settings.automaticEagerLoading
        ? (entity.getPeerCollection()?.filter(peer => !peer.hasRelation(relationName)) ?? [entity])
        : [entity]
    ) as readonly Entity<TTable>[]

    const load = this.loadRelations(peers, [{ relation: relationName }], false)
      .then(() => {
        switch (relation.kind) {
          case 'hasMany':
          case 'belongsToMany':
          case 'morphMany':
          case 'morphToMany':
          case 'morphedByMany':
          case 'hasManyThrough':
            return entity.getRelation(relationName)
          default:
            return entity.getRelation(relationName)
        }
      })
      .finally(() => {
        entity.clearPendingRelationLoad(relationName)
      })

    entity.setPendingRelationLoad(relationName, load)
    return load
  }

  private async getMatchingBelongsToParentKeys(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'belongsTo' }>,
    constraint?: RelationConstraint,
  ): Promise<Set<unknown>> {
    const foreignKeys = [...new Set(
      entities
        .map(entity => entity.toAttributes()[relation.foreignKey as keyof ReturnType<typeof entity.toAttributes>])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (foreignKeys.length === 0) {
      return new Set()
    }

    const related = this.resolveRelatedRepository(relation.related)
    const relatedEntities = await this.applyRelationConstraint(relation, related, constraint)
      .where(relation.ownerKey, 'in', foreignKeys)
      .get()

    return new Set(relatedEntities.map(entity => entity.get(relation.ownerKey as never)))
  }

  private async getBelongsToMatchCounts(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'belongsTo' }>,
    constraint?: RelationConstraint,
  ): Promise<Map<unknown, number>> {
    const foreignKeys = [...new Set(
      entities
        .map(entity => entity.toAttributes()[relation.foreignKey as keyof ReturnType<typeof entity.toAttributes>])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (foreignKeys.length === 0) {
      return new Map()
    }

    const related = this.resolveRelatedRepository(relation.related)
    const relatedEntities = await this.applyRelationConstraint(relation, related, constraint)
      .where(relation.ownerKey, 'in', foreignKeys)
      .get()
    const matching = new Set(relatedEntities.map(entity => entity.get(relation.ownerKey as never)))
    const counts = new Map<unknown, number>()

    for (const entity of entities) {
      const parentKey = this.getRelationParentValue(entity, relation)
      if (matching.has(parentKey)) {
        counts.set(parentKey, 1)
      }
    }

    return counts
  }

  private async getBelongsToEntitiesByParentKey(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'belongsTo' }>,
    constraint?: RelationConstraint,
  ): Promise<Map<unknown, Entity[]>> {
    const foreignKeys = [...new Set(
      entities
        .map(entity => entity.toAttributes()[relation.foreignKey as keyof ReturnType<typeof entity.toAttributes>])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (foreignKeys.length === 0) {
      return new Map()
    }

    const related = this.resolveRelatedRepository(relation.related)
    const relatedEntities = await this.applyRelationConstraint(relation, related, constraint)
      .where(relation.ownerKey, 'in', foreignKeys)
      .get()
    const relatedMap = new Map(
      relatedEntities.map(entity => [entity.get(relation.ownerKey as never), entity]),
    )
    const grouped = new Map<unknown, Entity[]>()

    for (const entity of entities) {
      const parentKey = this.getRelationParentValue(entity, relation)
      const relatedEntity = relatedMap.get(parentKey)
      grouped.set(parentKey, relatedEntity ? [relatedEntity] : [])
    }

    return grouped
  }

  private async getMatchingHasManyParentKeys(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'hasMany' | 'hasOne' | 'hasOneOfMany' }>,
    constraint?: RelationConstraint,
  ): Promise<Set<unknown>> {
    const grouped = await this.getHasManyEntitiesByParentKey(entities, relation, constraint)
    return new Set([...grouped.entries()].filter(([, related]) => related.length > 0).map(([key]) => key))
  }

  private async getMatchingMorphManyParentKeys(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphOne' | 'morphMany' | 'morphOneOfMany' }>,
    constraint?: RelationConstraint,
  ): Promise<Set<unknown>> {
    const grouped = await this.getMorphManyEntitiesByParentKey(entities, relation, constraint)
    return new Set([...grouped.entries()].filter(([, related]) => related.length > 0).map(([key]) => key))
  }

  private async getHasManyMatchCounts(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'hasMany' | 'hasOne' | 'hasOneOfMany' }>,
    constraint?: RelationConstraint,
  ): Promise<Map<unknown, number>> {
    const counts = new Map<unknown, number>()
    const grouped = await this.getHasManyEntitiesByParentKey(entities, relation, constraint)

    for (const [key, related] of grouped.entries()) {
      counts.set(key, related.length)
    }

    return counts
  }

  private async getMorphManyMatchCounts(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphOne' | 'morphMany' | 'morphOneOfMany' }>,
    constraint?: RelationConstraint,
  ): Promise<Map<unknown, number>> {
    const counts = new Map<unknown, number>()
    const grouped = await this.getMorphManyEntitiesByParentKey(entities, relation, constraint)

    for (const [key, related] of grouped.entries()) {
      counts.set(key, relation.kind === 'morphMany' ? related.length : Math.min(1, related.length))
    }

    return counts
  }

  private async getMatchingMorphToParentKeys(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphTo' }>,
    constraint?: RelationConstraint,
    morphTypes?: readonly string[],
  ): Promise<Set<unknown>> {
    const grouped = await this.getMorphToEntitiesByParentKey(entities, relation, constraint, morphTypes)
    return new Set([...grouped.entries()].filter(([, related]) => related.length > 0).map(([key]) => key))
  }

  private async getMorphToMatchCounts(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphTo' }>,
    constraint?: RelationConstraint,
  ): Promise<Map<unknown, number>> {
    const counts = new Map<unknown, number>()
    const grouped = await this.getMorphToEntitiesByParentKey(entities, relation, constraint)

    for (const [key, related] of grouped.entries()) {
      counts.set(key, related.length)
    }

    return counts
  }

  private async getMatchingThroughParentKeys(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'hasOneThrough' | 'hasManyThrough' }>,
    constraint?: RelationConstraint,
  ): Promise<Set<unknown>> {
    const grouped = await this.getThroughEntitiesByParentKey(entities, relation, constraint)
    const matching = new Set<unknown>()

    for (const entity of entities) {
      const parentKey = this.getRelationParentValue(entity, relation)
      if ((grouped.get(parentKey) ?? []).length > 0) {
        matching.add(parentKey)
      }
    }

    return matching
  }

  private async getThroughMatchCounts(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'hasOneThrough' | 'hasManyThrough' }>,
    constraint?: RelationConstraint,
  ): Promise<Map<unknown, number>> {
    const grouped = await this.getThroughEntitiesByParentKey(entities, relation, constraint)
    const counts = new Map<unknown, number>()

    for (const entity of entities) {
      const parentKey = this.getRelationParentValue(entity, relation)
      counts.set(parentKey, (grouped.get(parentKey) ?? []).length)
    }

    return counts
  }

  private async getHasManyEntitiesByParentKey(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'hasMany' | 'hasOne' | 'hasOneOfMany' }>,
    constraint?: RelationConstraint,
  ): Promise<Map<unknown, Entity[]>> {
    const localKeys = [...new Set(
      entities
        .map(entity => entity.toAttributes()[relation.localKey as keyof ReturnType<typeof entity.toAttributes>])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (localKeys.length === 0) {
      return new Map()
    }

    const related = this.resolveRelatedRepository(relation.related)
    const relatedEntities = await this.applyRelationConstraint(relation, related, constraint)
      .where(relation.foreignKey, 'in', localKeys)
      .get()
    const grouped = new Map<unknown, Entity[]>()

    for (const relatedEntity of relatedEntities) {
      const key = relatedEntity.get(relation.foreignKey as never)
      const bucket = grouped.get(key) ?? []
      bucket.push(relatedEntity)
      grouped.set(key, bucket)
    }

    if (relation.kind === 'hasOneOfMany') {
      const selected = new Map<unknown, Entity[]>()
      for (const [key, bucket] of grouped.entries()) {
        const chosen = this.selectOneOfManyEntity(bucket as [Entity, ...Entity[]], relation)
        selected.set(key, [chosen])
      }
      return selected
    }

    return grouped
  }

  private async getMorphManyEntitiesByParentKey(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphOne' | 'morphMany' | 'morphOneOfMany' }>,
    constraint?: RelationConstraint,
  ): Promise<Map<unknown, Entity[]>> {
    const localKeys = [...new Set(
      entities
        .map(entity => entity.toAttributes()[relation.localKey as keyof ReturnType<typeof entity.toAttributes>])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (localKeys.length === 0) {
      return new Map()
    }

    const related = this.resolveRelatedRepository(relation.related)
    const relatedEntities = await this.applyRelationConstraint(relation, related, constraint)
      .where(relation.morphTypeColumn, this.getMorphTypeValue())
      .where(relation.morphIdColumn, 'in', localKeys)
      .get()
    const grouped = new Map<unknown, Entity[]>()

    for (const relatedEntity of relatedEntities) {
      const key = relatedEntity.get(relation.morphIdColumn as never)
      const bucket = grouped.get(key) ?? []
      bucket.push(relatedEntity)
      grouped.set(key, bucket)
    }

    if (relation.kind === 'morphOneOfMany') {
      const selected = new Map<unknown, Entity[]>()
      for (const [key, bucket] of grouped.entries()) {
        const chosen = this.selectMorphOneOfManyEntity(bucket as [Entity, ...Entity[]], relation)
        selected.set(key, [chosen])
      }
      return selected
    }

    return grouped
  }

  private async getMorphToEntitiesByParentKey(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphTo' }>,
    constraint?: RelationConstraint,
    morphTypes?: readonly string[],
  ): Promise<Map<unknown, Entity[]>> {
    const groups = new Map<string, { repository: ModelRepository, ids: unknown[], parents: Entity<TTable>[] }>()

    for (const entity of entities) {
      const type = entity.toAttributes()[relation.morphTypeColumn as keyof ReturnType<typeof entity.toAttributes>]
      const id = entity.toAttributes()[relation.morphIdColumn as keyof ReturnType<typeof entity.toAttributes>]
      if (typeof type !== 'string' || !type || id === null || typeof id === 'undefined') {
        continue
      }

      const repository = this.resolveMorphRepository(type)
      if (!this.matchesMorphType(repository, type, morphTypes)) {
        continue
      }
      const key = `${repository.getConnectionName()}:${repository.definition.table.tableName}:${type}`
      const group = groups.get(key) ?? { repository, ids: [], parents: [] }
      group.ids.push(id)
      group.parents.push(entity)
      groups.set(key, group)
    }

    const grouped = new Map<unknown, Entity[]>()

    for (const group of groups.values()) {
      const relatedEntities = await this.applyRelationConstraint(relation, group.repository, constraint)
        .where(group.repository.definition.primaryKey, 'in', [...new Set(group.ids)])
        .get()
      const relatedMap = new Map(
        relatedEntities.map(entity => [entity.get(group.repository.definition.primaryKey as never), entity]),
      )

      for (const parent of group.parents) {
        const relationId = parent.toAttributes()[relation.morphIdColumn as keyof ReturnType<typeof parent.toAttributes>]
        const parentKey = parent.get(this.definition.primaryKey as never)
        const relatedEntity = relatedMap.get(relationId)
        grouped.set(parentKey, relatedEntity ? [relatedEntity] : [])
      }
    }

    return grouped
  }

  private matchesMorphType(
    repository: ModelRepository,
    actualType: string,
    selectors?: readonly string[],
  ): boolean {
    if (!selectors || selectors.length === 0) {
      return true
    }

    const candidates = new Set<string>([
      actualType,
      actualType.toLowerCase(),
      repository.definition.morphClass,
      repository.definition.morphClass.toLowerCase(),
      repository.definition.name,
      repository.definition.name.toLowerCase(),
      repository.definition.table.tableName,
      repository.definition.table.tableName.toLowerCase(),
    ])

    return selectors.some((selector) => {
      const normalized = selector.toLowerCase()
      return candidates.has(selector) || candidates.has(normalized)
    })
  }

  private resolveMorphLoadTargets(
    mapping: Readonly<Record<string, string | readonly string[] | Readonly<Record<string, RelationConstraint>>>>,
    actualType: unknown,
    repository: ModelRepository,
  ): readonly (string | EagerLoad)[] {
    for (const [label, relations] of Object.entries(mapping)) {
      if (this.matchesMorphType(repository, typeof actualType === 'string' ? actualType : repository.definition.morphClass, [label])) {
        return this.normalizeMorphLoadTargets(relations)
      }
    }

    return []
  }

  private normalizeMorphLoadTargets(
    relations: string | readonly string[] | Readonly<Record<string, RelationConstraint>>,
  ): readonly (string | EagerLoad)[] {
    if (typeof relations === 'string') {
      return relations.trim().length === 0 ? [] : [relations]
    }

    if (Array.isArray(relations)) {
      return relations.filter(relation => relation.trim().length > 0)
    }

    return Object.entries(relations).map(([relation, constraint]) => ({
      relation,
      constraint,
    }))
  }

  private serializeMorphLoadTargets(
    relations: readonly (string | EagerLoad)[],
  ): readonly string[] {
    return relations.map((relation) => {
      if (typeof relation === 'string') {
        return relation
      }

      return relation.constraint
        ? `${relation.relation}:constraint`
        : relation.relation
    })
  }

  private selectOneOfManyEntity(
    entities: readonly [Entity, ...Entity[]],
    relation: Extract<RelationDefinition, { kind: 'hasOneOfMany' }>,
  ): Entity {
    type ComparableValue = string | number | bigint | Date
    let selected = entities[0]

    for (const entity of entities.slice(1)) {
      const current = selected.toAttributes()[relation.aggregateColumn]
      const candidate = entity.toAttributes()[relation.aggregateColumn]

      if (current == null && candidate != null) {
        selected = entity
        continue
      }

      if (candidate == null) {
        continue
      }

      const currentComparable = current as ComparableValue | null | undefined
      const candidateComparable = candidate as ComparableValue

      if (relation.aggregate === 'max'
        ? candidateComparable > currentComparable!
        : candidateComparable < currentComparable!) {
        selected = entity
      }
    }

    return selected
  }

  private selectMorphOneOfManyEntity(
    entities: readonly [Entity, ...Entity[]],
    relation: Extract<RelationDefinition, { kind: 'morphOneOfMany' }>,
  ): Entity {
    type ComparableValue = string | number | bigint | Date
    let selected = entities[0]

    for (const entity of entities.slice(1)) {
      const current = selected.toAttributes()[relation.aggregateColumn]
      const candidate = entity.toAttributes()[relation.aggregateColumn]

      if (current == null && candidate != null) {
        selected = entity
        continue
      }

      if (candidate == null) {
        continue
      }

      const currentComparable = current as ComparableValue | null | undefined
      const candidateComparable = candidate as ComparableValue

      if (relation.aggregate === 'max'
        ? candidateComparable > currentComparable!
        : candidateComparable < currentComparable!) {
        selected = entity
      }
    }

    return selected
  }

  private async getThroughEntitiesByParentKey(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'hasOneThrough' | 'hasManyThrough' }>,
    constraint?: RelationConstraint,
  ): Promise<Map<unknown, Entity[]>> {
    const parentKeys = [...new Set(
      entities
        .map(entity => entity.toAttributes()[relation.localKey as keyof ReturnType<typeof entity.toAttributes>])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (parentKeys.length === 0) {
      return new Map()
    }

    const through = this.resolveThroughRepository(relation.through)
    const throughEntities = await through.query()
      .where(relation.firstKey, 'in', parentKeys)
      .get()

    if (throughEntities.length === 0) {
      return new Map()
    }

    const throughByParent = new Map<unknown, Entity[]>()
    const secondLocalValues = [...new Set(
      throughEntities
        .map(entity => entity.get(relation.secondLocalKey as never))
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (secondLocalValues.length === 0) {
      return new Map()
    }

    for (const throughEntity of throughEntities) {
      const parentKey = throughEntity.get(relation.firstKey as never)
      const bucket = throughByParent.get(parentKey) ?? []
      bucket.push(throughEntity)
      throughByParent.set(parentKey, bucket)
    }

    const related = this.resolveRelatedRepository(relation.related)
    const relatedEntities = await this.applyRelationConstraint(relation, related, constraint)
      .where(relation.secondKey, 'in', secondLocalValues)
      .get()
    const relatedBySecondKey = new Map<unknown, Entity[]>()

    for (const relatedEntity of relatedEntities) {
      const secondKey = relatedEntity.get(relation.secondKey as never)
      const bucket = relatedBySecondKey.get(secondKey) ?? []
      bucket.push(relatedEntity)
      relatedBySecondKey.set(secondKey, bucket)
    }

    const grouped = new Map<unknown, Entity[]>()

    for (const [parentKey, links] of throughByParent.entries()) {
      const matches: Entity[] = []
      for (const throughEntity of links) {
        const secondLocalValue = throughEntity.get(relation.secondLocalKey as never)
        matches.push(...(relatedBySecondKey.get(secondLocalValue) ?? []))
      }
      grouped.set(parentKey, matches)
    }

    return grouped
  }

  private async getMatchingBelongsToManyParentKeys(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'belongsToMany' }>,
    constraint?: RelationConstraint,
  ): Promise<Set<unknown>> {
    const parentKeys = [...new Set(
      entities
        .map(entity => entity.toAttributes()[relation.parentKey as keyof ReturnType<typeof entity.toAttributes>])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (parentKeys.length === 0) {
      return new Set()
    }

    const pivotRows = await this.createBelongsToManyPivotQuery(relation, this.connection)
      .where(relation.foreignPivotKey, 'in', parentKeys)
      .get<Record<string, unknown>>()

    const relatedIds = [...new Set(
      pivotRows
        .map(row => row[relation.relatedPivotKey])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (relatedIds.length === 0) {
      return new Set()
    }

    const related = this.resolveRelatedRepository(relation.related)
    const relatedEntities = await this.applyRelationConstraint(relation, related, constraint)
      .where(relation.relatedKey, 'in', relatedIds)
      .get()
    const matchingRelated = new Set(relatedEntities.map(entity => entity.get(relation.relatedKey as never)))
    const matchingParents = new Set<unknown>()

    for (const row of pivotRows) {
      if (matchingRelated.has(row[relation.relatedPivotKey])) {
        matchingParents.add(row[relation.foreignPivotKey])
      }
    }

    return matchingParents
  }

  private async getMatchingMorphToManyParentKeys(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphToMany' }>,
    constraint?: RelationConstraint,
  ): Promise<Set<unknown>> {
    const grouped = await this.getMorphToManyEntitiesByParentKey(entities, relation, constraint)
    return new Set([...grouped.entries()].filter(([, related]) => related.length > 0).map(([key]) => key))
  }

  private async getMatchingMorphedByManyParentKeys(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphedByMany' }>,
    constraint?: RelationConstraint,
  ): Promise<Set<unknown>> {
    const grouped = await this.getMorphedByManyEntitiesByParentKey(entities, relation, constraint)
    return new Set([...grouped.entries()].filter(([, related]) => related.length > 0).map(([key]) => key))
  }

  private async getBelongsToManyMatchCounts(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'belongsToMany' }>,
    constraint?: RelationConstraint,
  ): Promise<Map<unknown, number>> {
    const parentKeys = [...new Set(
      entities
        .map(entity => entity.toAttributes()[relation.parentKey as keyof ReturnType<typeof entity.toAttributes>])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (parentKeys.length === 0) {
      return new Map()
    }

    const pivotRows = await this.createBelongsToManyPivotQuery(relation, this.connection)
      .where(relation.foreignPivotKey, 'in', parentKeys)
      .get<Record<string, unknown>>()

    const relatedIds = [...new Set(
      pivotRows
        .map(row => row[relation.relatedPivotKey])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (relatedIds.length === 0) {
      return new Map()
    }

    const related = this.resolveRelatedRepository(relation.related)
    const relatedEntities = await this.applyRelationConstraint(relation, related, constraint)
      .where(relation.relatedKey, 'in', relatedIds)
      .get()
    const matchingRelated = new Set(relatedEntities.map(entity => entity.get(relation.relatedKey as never)))
    const counts = new Map<unknown, number>()

    for (const row of pivotRows) {
      if (!matchingRelated.has(row[relation.relatedPivotKey])) {
        continue
      }

      const parentKey = row[relation.foreignPivotKey]
      counts.set(parentKey, (counts.get(parentKey) ?? 0) + 1)
    }

    return counts
  }

  private async getMorphToManyMatchCounts(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphToMany' }>,
    constraint?: RelationConstraint,
  ): Promise<Map<unknown, number>> {
    const counts = new Map<unknown, number>()
    const grouped = await this.getMorphToManyEntitiesByParentKey(entities, relation, constraint)

    for (const [key, related] of grouped.entries()) {
      counts.set(key, related.length)
    }

    return counts
  }

  private async getMorphedByManyMatchCounts(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphedByMany' }>,
    constraint?: RelationConstraint,
  ): Promise<Map<unknown, number>> {
    const counts = new Map<unknown, number>()
    const grouped = await this.getMorphedByManyEntitiesByParentKey(entities, relation, constraint)

    for (const [key, related] of grouped.entries()) {
      counts.set(key, related.length)
    }

    return counts
  }

  private async getBelongsToManyEntitiesByParentKey(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'belongsToMany' }>,
    constraint?: RelationConstraint,
  ): Promise<Map<unknown, Entity[]>> {
    const parentKeys = [...new Set(
      entities
        .map(entity => entity.toAttributes()[relation.parentKey as keyof ReturnType<typeof entity.toAttributes>])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (parentKeys.length === 0) {
      return new Map()
    }

    const pivotRows = await this.createBelongsToManyPivotQuery(relation, this.connection)
      .where(relation.foreignPivotKey, 'in', parentKeys)
      .get<Record<string, unknown>>()

    const relatedIds = [...new Set(
      pivotRows
        .map(row => row[relation.relatedPivotKey])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (relatedIds.length === 0) {
      return new Map()
    }

    const related = this.resolveRelatedRepository(relation.related)
    const relatedEntities = await this.applyRelationConstraint(relation, related, constraint)
      .where(relation.relatedKey, 'in', relatedIds)
      .get()
    const relatedMap = new Map(
      relatedEntities.map(entity => [entity.get(relation.relatedKey as never), entity]),
    )
    const grouped = new Map<unknown, Entity[]>()

    for (const row of pivotRows) {
      const parentKey = row[relation.foreignPivotKey]
      const relatedKey = row[relation.relatedPivotKey]
      const relatedEntity = relatedMap.get(relatedKey)
      if (!relatedEntity) {
        continue
      }

      const bucket = grouped.get(parentKey) ?? []
      bucket.push(this.attachPivotAttributes(relatedEntity, row, relation))
      grouped.set(parentKey, bucket)
    }

    return grouped
  }

  private async getMorphToManyEntitiesByParentKey(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphToMany' }>,
    constraint?: RelationConstraint,
  ): Promise<Map<unknown, Entity[]>> {
    const parentKeys = [...new Set(
      entities
        .map(entity => entity.toAttributes()[relation.parentKey as keyof ReturnType<typeof entity.toAttributes>])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (parentKeys.length === 0) {
      return new Map()
    }

    const pivotRows = await this.createMorphToManyPivotQuery(relation, this.connection)
      .where(relation.morphTypeColumn, this.getMorphTypeValue())
      .where(relation.morphIdColumn, 'in', parentKeys)
      .get<Record<string, unknown>>()

    const relatedIds = [...new Set(
      pivotRows
        .map(row => row[relation.foreignPivotKey])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (relatedIds.length === 0) {
      return new Map()
    }

    const related = this.resolveRelatedRepository(relation.related)
    const relatedEntities = await this.applyRelationConstraint(relation, related, constraint)
      .where(relation.relatedKey, 'in', relatedIds)
      .get()
    const relatedMap = new Map(
      relatedEntities.map(entity => [entity.get(relation.relatedKey as never), entity]),
    )
    const grouped = new Map<unknown, Entity[]>()

    for (const row of pivotRows) {
      const parentKey = row[relation.morphIdColumn]
      const relatedKey = row[relation.foreignPivotKey]
      const relatedEntity = relatedMap.get(relatedKey)
      if (!relatedEntity) {
        continue
      }

      const bucket = grouped.get(parentKey) ?? []
      bucket.push(this.attachPivotAttributes(relatedEntity, row, relation))
      grouped.set(parentKey, bucket)
    }

    return grouped
  }

  private async getMorphedByManyEntitiesByParentKey(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphedByMany' }>,
    constraint?: RelationConstraint,
  ): Promise<Map<unknown, Entity[]>> {
    const parentKeys = [...new Set(
      entities
        .map(entity => entity.toAttributes()[relation.parentKey as keyof ReturnType<typeof entity.toAttributes>])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (parentKeys.length === 0) {
      return new Map()
    }

    const related = this.resolveRelatedRepository(relation.related)
    const pivotRows = await this.createMorphedByManyPivotQuery(relation, related.definition.morphClass, this.connection)
      .where(relation.foreignPivotKey, 'in', parentKeys)
      .get<Record<string, unknown>>()

    const relatedIds = [...new Set(
      pivotRows
        .map(row => row[relation.morphIdColumn])
        .filter(value => value !== null && typeof value !== 'undefined'),
    )]

    if (relatedIds.length === 0) {
      return new Map()
    }

    const relatedEntities = await this.applyRelationConstraint(relation, related, constraint)
      .where(relation.relatedKey, 'in', relatedIds)
      .get()
    const relatedMap = new Map(
      relatedEntities.map(entity => [entity.get(relation.relatedKey as never), entity]),
    )
    const grouped = new Map<unknown, Entity[]>()

    for (const row of pivotRows) {
      const parentKey = row[relation.foreignPivotKey]
      const relatedKey = row[relation.morphIdColumn]
      const relatedEntity = relatedMap.get(relatedKey)
      if (!relatedEntity) {
        continue
      }

      const bucket = grouped.get(parentKey) ?? []
      bucket.push(this.attachPivotAttributes(relatedEntity, row, relation))
      grouped.set(parentKey, bucket)
    }

    return grouped
  }

  private createBelongsToManyPivotQuery(
    relation: Extract<RelationDefinition, { kind: 'belongsToMany' }>,
    connection: DatabaseContext,
  ): TableQueryBuilder<string | TableDefinition> {
    return this.applyPivotQueryConfig(new TableQueryBuilder(relation.pivotTable, connection), relation)
  }

  private createMorphToManyPivotQuery(
    relation: Extract<RelationDefinition, { kind: 'morphToMany' }>,
    connection: DatabaseContext,
  ): TableQueryBuilder<string | TableDefinition> {
    return this.applyPivotQueryConfig(new TableQueryBuilder(relation.pivotTable, connection), relation)
  }

  private createMorphedByManyPivotQuery(
    relation: Extract<RelationDefinition, { kind: 'morphedByMany' }>,
    morphClass: string,
    connection: DatabaseContext,
  ): TableQueryBuilder<string | TableDefinition> {
    return this.applyPivotQueryConfig(
      new TableQueryBuilder(relation.pivotTable, connection).where(relation.morphTypeColumn, morphClass),
      relation,
    )
  }

  private applyPivotQueryConfig(
    query: TableQueryBuilder<string | TableDefinition>,
    relation: PivotRelationDefinition,
  ): TableQueryBuilder<string | TableDefinition> {
    let configured = query

    for (const filter of relation.pivotWheres) {
      configured = configured.where(filter.column, filter.operator, filter.value)
    }

    for (const order of relation.pivotOrderBy) {
      configured = configured.orderBy(order.column, order.direction)
    }

    return configured
  }

  private attachPivotAttributes(
    entity: Entity,
    row: Record<string, unknown>,
    relation: PivotRelationDefinition,
  ): Entity {
    const relatedRepository = entity.getRepository() as ModelRepository
    const cloned = relatedRepository.hydrate(entity.toAttributes())
    cloned.setRelation(relation.pivotAccessor, this.extractPivotAttributes(row, relation))
    return cloned
  }

  private extractPivotAttributes(
    row: Record<string, unknown>,
    relation: PivotRelationDefinition,
  ): Record<string, unknown> | Entity {
    if (relation.pivotModel) {
      const pivotRepository = this.resolveRelatedRepository(relation.pivotModel)
      return pivotRepository.hydrate(row)
    }

    const selectedColumns = new Set<string>([
      ...this.getDefaultPivotColumns(relation),
      ...relation.pivotColumns,
    ])

    return Object.fromEntries(
      [...selectedColumns]
        .filter(column => Object.prototype.hasOwnProperty.call(row, column))
        .map(column => [column, row[column]]),
    )
  }

  private getDefaultPivotColumns(relation: PivotRelationDefinition): readonly string[] {
    switch (relation.kind) {
      case 'belongsToMany':
        return [relation.foreignPivotKey, relation.relatedPivotKey]
      case 'morphToMany':
        return [relation.morphTypeColumn, relation.morphIdColumn, relation.foreignPivotKey]
      case 'morphedByMany':
        return [relation.foreignPivotKey, relation.morphTypeColumn, relation.morphIdColumn]
    }
  }

  private getPivotMutationContext(
    entity: Entity<TTable>,
    relationName: string,
  ): {
    relation: PivotMutationRelationDefinition
    parentId: unknown
  } {
    if (!entity.exists()) {
      throw new HydrationError(`Cannot mutate relation "${relationName}" on an unsaved ${this.definition.name}.`)
    }

    const relation = this.getRelationDefinition(relationName)
    if (
      relation.kind !== 'belongsToMany'
      && relation.kind !== 'morphToMany'
      && relation.kind !== 'morphedByMany'
    ) {
      throw new SecurityError(`Relation "${relationName}" on model "${this.definition.name}" does not support pivot mutations.`)
    }

    const parentId = entity.get(relation.parentKey as never)
    if (typeof parentId === 'undefined' || parentId === null) {
      throw new HydrationError(`Cannot mutate relation "${relationName}" without a parent key value.`)
    }

    return { relation, parentId }
  }

  private normalizePivotInput(
    ids: unknown,
    attributes: PivotAttributes = {},
  ): PivotMutationEntry[] {
    if (ids == null) {
      return []
    }

    if (Array.isArray(ids)) {
      return ids.map(id => ({ id, attributes: { ...attributes } }))
    }

    if (typeof ids === 'object') {
      return Object.entries(ids as Record<string, PivotAttributes>).map(([id, value]) => ({
        id: /^-?\d+$/.test(id) ? Number(id) : id,
        attributes: { ...(value ?? {}) },
      }))
    }

    return [{ id: ids, attributes: { ...attributes } }]
  }

  private assertValidPivotEntries(
    relationName: string,
    entries: readonly PivotMutationEntry[],
    relation: PivotMutationRelationDefinition,
  ): void {
    for (const entry of entries) {
      this.assertValidPivotAttributes(relationName, entry.attributes, relation)
    }
  }

  private assertValidPivotAttributes(
    relationName: string,
    attributes: PivotAttributes,
    relation: PivotMutationRelationDefinition,
  ): void {
    const reserved = new Set<string>(this.getReservedPivotColumns(relation))
    const allowed = new Set<string>(relation.pivotColumns)

    for (const key of Object.keys(attributes)) {
      if (reserved.has(key)) {
        throw new SecurityError(`Pivot attribute "${key}" on relation "${relationName}" is reserved and cannot be set explicitly.`)
      }

      if (!allowed.has(key)) {
        throw new SecurityError(`Pivot attribute "${key}" on relation "${relationName}" must be declared with withPivot(...) before it can be written.`)
      }
    }
  }

  private async getPivotRows(
    context: {
      relation: PivotMutationRelationDefinition
      parentId: unknown
    },
    connection: DatabaseContext,
    relatedIds?: readonly unknown[],
  ): Promise<Record<string, unknown>[]> {
    let query = this.createPivotMutationQuery(context, connection)

    if (relatedIds && relatedIds.length > 0) {
      query = query.where(this.getPivotRelatedIdColumn(context.relation), 'in', relatedIds)
    }

    return query.get<Record<string, unknown>>()
  }

  private indexPivotRows(
    rows: readonly Record<string, unknown>[],
    key: string,
  ): Map<string, Record<string, unknown>> {
    return new Map(rows.map(row => [String(row[key]), row]))
  }

  private pivotAttributesChanged(
    existing: Record<string, unknown>,
    attributes: PivotAttributes,
    _relation: PivotMutationRelationDefinition,
  ): boolean {
    return Object.entries(attributes).some(([key, value]) => existing[key] !== value)
  }

  private async insertPivotRow(
    context: {
      relation: PivotMutationRelationDefinition
      parentId: unknown
    },
    connection: DatabaseContext,
    relatedId: unknown,
    attributes: PivotAttributes,
  ): Promise<void> {
    await new TableQueryBuilder(context.relation.pivotTable, connection)
      .insert(this.buildPivotInsertPayload(context, relatedId, attributes))
  }

  private async updatePivotRow(
    context: {
      relation: PivotMutationRelationDefinition
      parentId: unknown
    },
    connection: DatabaseContext,
    relatedId: unknown,
    attributes: PivotAttributes,
  ): Promise<void> {
    await this.createPivotMutationQuery(context, connection)
      .where(this.getPivotRelatedIdColumn(context.relation), relatedId)
      .update(attributes)
  }

  private async deletePivotRows(
    context: {
      relation: PivotMutationRelationDefinition
      parentId: unknown
    },
    connection: DatabaseContext,
    relatedIds?: readonly unknown[],
  ): Promise<number> {
    let query = this.createPivotMutationQuery(context, connection)

    if (relatedIds && relatedIds.length > 0) {
      query = query.where(this.getPivotRelatedIdColumn(context.relation), 'in', relatedIds)
    }

    const result = await query.delete()
    return result.affectedRows ?? 0
  }

  private isWritableColumn(column: string): boolean {
    if (areModelGuardsDisabled()) {
      return true
    }

    const fillable = new Set(this.definition.fillable)
    const guarded = new Set(this.definition.guarded)

    if (guarded.has('*')) return false
    if (fillable.has('*')) return !guarded.has(column)
    if (this.definition.hasExplicitFillable === true) return fillable.has(column) && !guarded.has(column)
    if (fillable.size > 0) return fillable.has(column) && !guarded.has(column)
    return !guarded.has(column)
  }

  private assertPersistedParentForRelation(
    entity: Entity<TTable>,
    relationName: string,
  ): void {
    if (!entity.exists()) {
      throw new HydrationError(`Cannot persist relation "${relationName}" on an unsaved ${this.definition.name}.`)
    }
  }

  private assertRelationSupportsManyWrites(
    relationName: string,
    relation: RelationDefinition,
    count: number,
  ): void {
    if (count <= 1) {
      return
    }

    switch (relation.kind) {
      case 'hasMany':
      case 'morphMany':
      case 'belongsToMany':
      case 'morphToMany':
      case 'morphedByMany':
        return
      default:
        throw new SecurityError(`Relation "${relationName}" on model "${this.definition.name}" only accepts a single related model.`)
    }
  }

  private async touchOwners(entity: Entity<TTable>): Promise<void> {
    if (this.definition.touches.length === 0) {
      return
    }

    const touchedAt = new Date().toISOString()

    for (const relationName of this.definition.touches) {
      const relation = this.getRelationDefinition(relationName)

      switch (relation.kind) {
        case 'belongsTo': {
          const ownerId = entity.get(relation.foreignKey as never)
          if (ownerId === null || typeof ownerId === 'undefined') {
            continue
          }

          const related = this.resolveRelatedRepository(relation.related)
          if (!related.definition.updatedAtColumn) {
            continue
          }

          let query = related.query()
          if (related.getDeletedAtColumn()) {
            query = query.withTrashed()
          }

          await query.getTableQueryBuilder()
            .where(relation.ownerKey, ownerId)
            .update({
              [related.definition.updatedAtColumn]: touchedAt,
            })
          break
        }
        case 'morphTo': {
          const type = entity.get(relation.morphTypeColumn as never)
          const ownerId = entity.get(relation.morphIdColumn as never)
          if (typeof type !== 'string' || type.length === 0 || ownerId === null || typeof ownerId === 'undefined') {
            continue
          }

          const related = this.resolveMorphRepository(type)
          if (!related.definition.updatedAtColumn) {
            continue
          }

          let query = related.query()
          if (related.getDeletedAtColumn()) {
            query = query.withTrashed()
          }

          await query.getTableQueryBuilder()
            .where(related.definition.primaryKey, ownerId)
            .update({
              [related.definition.updatedAtColumn]: touchedAt,
            })
          break
        }
      }
    }
  }

  private resolveCompatibleRelatedRepository(
    related: () => ModelDefinitionLike,
    relationName: string,
    entity: Entity,
  ): ModelRepository {
    const expected = this.resolveRelatedRepository(related)
    const actual = entity.getRepository() as ModelRepository

    if (
      expected.definition.table.tableName !== actual.definition.table.tableName
      || expected.definition.name !== actual.definition.name
    ) {
      throw new SecurityError(`Relation "${relationName}" on model "${this.definition.name}" expects related model "${expected.definition.name}".`)
    }

    return expected
  }

  private syncRelationAfterPersistence(
    entity: Entity<TTable>,
    relationName: string,
    relation: RelationDefinition,
    relatedEntity: Entity,
  ): void {
    switch (relation.kind) {
      case 'hasOne':
      case 'hasOneOfMany':
      case 'morphOne':
      case 'morphOneOfMany':
        entity.setRelation(relationName, relatedEntity)
        return
      default:
        entity.forgetRelation(relationName)
    }
  }

  private createPivotMutationQuery(
    context: {
      relation: PivotMutationRelationDefinition
      parentId: unknown
    },
    connection: DatabaseContext,
  ): TableQueryBuilder<string | TableDefinition> {
    switch (context.relation.kind) {
      case 'belongsToMany':
        return new TableQueryBuilder(context.relation.pivotTable, connection)
          .where(context.relation.foreignPivotKey, context.parentId)
      case 'morphToMany':
        return new TableQueryBuilder(context.relation.pivotTable, connection)
          .where(context.relation.morphTypeColumn, this.getMorphTypeValue())
          .where(context.relation.morphIdColumn, context.parentId)
      case 'morphedByMany': {
        const related = this.resolveRelatedRepository(context.relation.related)
        return new TableQueryBuilder(context.relation.pivotTable, connection)
          .where(context.relation.foreignPivotKey, context.parentId)
          .where(context.relation.morphTypeColumn, related.definition.morphClass)
      }
    }
  }

  private getPivotRelatedIdColumn(
    relation: PivotMutationRelationDefinition,
  ): string {
    switch (relation.kind) {
      case 'belongsToMany':
        return relation.relatedPivotKey
      case 'morphToMany':
        return relation.foreignPivotKey
      case 'morphedByMany':
        return relation.morphIdColumn
    }
  }

  private getReservedPivotColumns(
    relation: PivotMutationRelationDefinition,
  ): readonly string[] {
    switch (relation.kind) {
      case 'belongsToMany':
        return [relation.foreignPivotKey, relation.relatedPivotKey]
      case 'morphToMany':
        return [relation.morphTypeColumn, relation.morphIdColumn, relation.foreignPivotKey]
      case 'morphedByMany':
        return [relation.foreignPivotKey, relation.morphTypeColumn, relation.morphIdColumn]
    }
  }

  private buildPivotInsertPayload(
    context: {
      relation: PivotMutationRelationDefinition
      parentId: unknown
    },
    relatedId: unknown,
    attributes: PivotAttributes,
  ): Record<string, unknown> {
    switch (context.relation.kind) {
      case 'belongsToMany':
        return {
          [context.relation.foreignPivotKey]: context.parentId,
          [context.relation.relatedPivotKey]: relatedId,
          ...attributes,
        }
      case 'morphToMany':
        return {
          [context.relation.morphTypeColumn]: this.getMorphTypeValue(),
          [context.relation.morphIdColumn]: context.parentId,
          [context.relation.foreignPivotKey]: relatedId,
          ...attributes,
        }
      case 'morphedByMany': {
        const related = this.resolveRelatedRepository(context.relation.related)
        return {
          [context.relation.foreignPivotKey]: context.parentId,
          [context.relation.morphTypeColumn]: related.definition.morphClass,
          [context.relation.morphIdColumn]: relatedId,
          ...attributes,
        }
      }
    }
  }

  private applyGeneratedUniqueIds(
    values: Partial<ModelRecord<TTable>>,
    generatedColumns: Set<string>,
  ): Partial<ModelRecord<TTable>> {
    const config = this.definition.uniqueIdConfig
    if (!config) {
      return values
    }

    const output: Partial<ModelRecord<TTable>> = { ...values }

    for (const column of config.columns) {
      const current = output[column]
      if (typeof current !== 'undefined' && current !== null && current !== '') {
        continue
      }

      const generated = config.generator()
      if (typeof generated !== 'string' || generated.trim().length === 0) {
        throw new DatabaseError(`${this.definition.name} unique ID generator must return a non-empty string.`, 'INVALID_UNIQUE_ID')
      }

      output[column] = generated as ModelRecord<TTable>[typeof column]
      generatedColumns.add(column)
    }

    return output
  }

  private applyPendingAttributes(
    values: Partial<ModelRecord<TTable>>,
  ): Partial<ModelRecord<TTable>> {
    if (Object.keys(this.definition.pendingAttributes).length === 0) {
      return values
    }

    return {
      ...this.definition.pendingAttributes,
      ...values,
    }
  }

  private getObserverInstances(): unknown[] {
    return this.definition.observers.map((observer) => {
      if (typeof observer === 'function') {
        return new (observer as new () => unknown)()
      }

      return observer
    })
  }

  private async dispatchCancelableEvent(
    eventName: Extract<ModelLifecycleEventName, 'saving' | 'creating' | 'updating' | 'deleting' | 'restoring' | 'forceDeleting'>,
    entity: Entity<TTable>,
  ): Promise<void> {
    const results = await this.dispatchEvent(eventName, entity, true)
    if (results.includes(false)) {
      throw new DatabaseError(
        `${this.definition.name} ${eventName} event cancelled the operation.`,
        'MODEL_EVENT_CANCELLED',
      )
    }
  }

  private async dispatchEvent(
    eventName: ModelLifecycleEventName,
    entity: Entity<TTable>,
    collectResults = false,
  ): Promise<unknown[]> {
    if (areModelEventsMuted()) {
      return []
    }

    const handlers = this.definition.events[eventName] ?? []
    const observerHandlers = this.getObserverInstances()
      .map(observer => (observer as Record<string, unknown>)[eventName])
      .filter((handler): handler is (...args: unknown[]) => unknown => typeof handler === 'function')

    const results: unknown[] = []

    for (const handler of [...handlers, ...observerHandlers]) {
      const result = await handler(entity, this)
      if (collectResults) {
        results.push(result)
      }
    }

    return results
  }

  private dispatchSyncEvent(
    eventName: Extract<ModelLifecycleEventName, 'replicating'>,
    entity: Entity<TTable>,
  ): void {
    if (areModelEventsMuted()) {
      return
    }

    const handlers = this.definition.events[eventName] ?? []
    const observerHandlers = this.getObserverInstances()
      .map(observer => (observer as Record<string, unknown>)[eventName])
      .filter((handler): handler is (...args: unknown[]) => unknown => typeof handler === 'function')

    for (const handler of [...handlers, ...observerHandlers]) {
      handler(entity, this)
    }
  }

  resolveAttribute(key: string, entity: Entity<TTable>, value: unknown): unknown {
    const accessor = this.definition.accessors[key]
    return accessor ? accessor(value, entity) : value
  }

  shouldPreventAccessingMissingAttributes(key: string): boolean {
    const settings = getModelRuntimeSettings(this.definition)
    if (!settings.preventAccessingMissingAttributes) {
      return false
    }

    return !Object.prototype.hasOwnProperty.call(this.definition.accessors, key)
  }

  serializeEntity(entity: Entity<TTable>): Record<string, unknown> {
    const serializationEntity = entity as Entity<TTable> & {
      getSerializationConfig?: () => {
        hidden: ReadonlySet<string>
        visible: ReadonlySet<string>
        visibleOnly: readonly string[] | null
        appended: readonly string[] | null
      }
    }
    const config = typeof serializationEntity.getSerializationConfig === 'function'
      ? serializationEntity.getSerializationConfig()
      : null
    const hidden = new Set(this.definition.hidden)
    const visible = new Set(config?.visibleOnly ?? this.definition.visible)

    for (const key of config?.hidden ?? []) {
      hidden.add(key)
    }

    for (const key of config?.visible ?? []) {
      hidden.delete(key)
      visible.add(key)
    }

    const useVisibleAllowlist = visible.size > 0
    const output = Object.fromEntries(
      Object.entries(entity.toAttributes())
        .filter(([key]) => !hidden.has(key) && (!useVisibleAllowlist || visible.has(key)))
        .map(([key]) => [
          key,
          this.serializeAttributeValue(
            key,
            this.resolveAttribute(key, entity, entity.toAttributes()[key as keyof ReturnType<typeof entity.toAttributes>]),
          ),
        ]),
    )

    for (const key of config?.appended ?? this.definition.appended) {
      if (hidden.has(key)) continue
      if (useVisibleAllowlist && !visible.has(key)) continue
      output[key] = this.serializeAttributeValue(
        key,
        this.resolveAttribute(key, entity, entity.toAttributes()[key as keyof ReturnType<typeof entity.toAttributes>]),
      )
    }

    for (const [relationName, relationValue] of Object.entries(entity.getLoadedRelations())) {
      if (hidden.has(relationName)) continue
      if (useVisibleAllowlist && !visible.has(relationName)) continue

      output[relationName] = this.serializeRelationValue(relationValue)
    }

    return output
  }

  private serializeRelationValue(value: unknown): unknown {
    if (value instanceof Entity) {
      return (value as Entity).toJSON()
    }

    if (Array.isArray(value)) {
      return value.map(item => this.serializeRelationValue(item))
    }

    if (value instanceof Date && this.definition.serializeDate) {
      return this.definition.serializeDate(value)
    }

    return value
  }

  private serializeOutputValue(value: unknown): unknown {
    if (value instanceof Date && this.definition.serializeDate) {
      return this.definition.serializeDate(value)
    }

    return value
  }

  serializeAttributeValue(key: string, value: unknown): unknown {
    const builtInCast = this.parseBuiltInCast(this.definition.casts[key])
    if (
      value instanceof Date
      && builtInCast
      && ['date', 'datetime', 'timestamp'].includes(builtInCast.name)
      && builtInCast.parameter
    ) {
      return this.formatDateCast(value, builtInCast.parameter)
    }

    return this.serializeOutputValue(value)
  }

  private normalizeFromStorage(
    values: Partial<ModelRecord<TTable>>,
    extraCasts: Record<string, ModelCastDefinition> = {},
  ): Partial<ModelRecord<TTable>> {
    const casts = { ...this.definition.casts, ...extraCasts }
    return Object.fromEntries(
      Object.entries(values).map(([key, value]) => {
        const normalized = this.applySchemaReadNormalization(key, value)
        return [key, this.applyCastGet(casts[key], normalized)]
      }),
    ) as Partial<ModelRecord<TTable>>
  }

  private applyTimestampDefaults(
    values: Partial<ModelRecord<TTable>>,
    mode: WriteMode,
  ): Partial<ModelRecord<TTable>> {
    if (!this.definition.timestamps) {
      return values
    }

    const timestamp = new Date().toISOString()
    const nextValues = { ...values }

    if (mode === 'create' && this.definition.createdAtColumn && typeof nextValues[this.definition.createdAtColumn] === 'undefined') {
      nextValues[this.definition.createdAtColumn] = timestamp as never
    }

    if (this.definition.updatedAtColumn && typeof nextValues[this.definition.updatedAtColumn] === 'undefined') {
      nextValues[this.definition.updatedAtColumn] = timestamp as never
    }

    return nextValues
  }

  private normalizeForStorage(key: string, value: unknown): unknown {
    const mutator = this.definition.mutators[key]
    const mutated = mutator ? mutator(value) : value
    const casted = this.applyCastSet(this.definition.casts[key], mutated)
    return this.applySchemaWriteNormalization(key, casted)
  }

  private applySchemaReadNormalization(key: string, value: unknown): unknown {
    const column = this.definition.table.columns[key]
    if (!column) {
      return value
    }

    return normalizeDialectReadValue(this.getSchemaDialectName(), column, value)
  }

  private applySchemaWriteNormalization(key: string, value: unknown): unknown {
    const column = this.definition.table.columns[key]
    if (!column) {
      return value
    }

    return normalizeDialectWriteValue(this.getSchemaDialectName(), column, value)
  }

  private getSchemaDialectName(): SchemaDialectName {
    return this.connection.getDriver() as SchemaDialectName
  }

  private applyCastGet(cast: ModelCastDefinition | undefined, value: unknown): unknown {
    const builtInCast = this.parseBuiltInCast(cast)
    if (builtInCast) {
      switch (builtInCast.name) {
        case 'boolean':
          return value == null ? value : Boolean(value)
        case 'number':
          return value == null ? value : Number(value)
        case 'string':
          return value == null ? value : String(value)
        case 'json':
          /* v8 ignore next -- repository hydration exercises this path, but V8 does not attribute the inline parse expression reliably here. */
          return typeof value === 'string' ? JSON.parse(value) : value
        case 'date':
        case 'datetime':
        case 'timestamp':
          return value == null || value instanceof Date ? value : new Date(String(value))
        case 'vector':
          return this.parseVectorValue(value, builtInCast.parameter)
      }
    }

    cast = this.resolveCastDefinition(cast)
    if (typeof cast === 'undefined') return value

    if (typeof cast === 'object' && 'kind' in cast && cast.kind === 'enum') {
      if (value == null) {
        return value
      }

      if (!cast.values.includes(value as string | number)) {
        throw new HydrationError(`Enum cast received unsupported value "${String(value)}".`)
      }

      return value
    }

    return (typeof cast === 'object' && 'get' in cast && cast.get) ? cast.get(value) : value
  }

  private applyCastSet(cast: ModelCastDefinition | undefined, value: unknown): unknown {
    const builtInCast = this.parseBuiltInCast(cast)
    if (builtInCast) {
      switch (builtInCast.name) {
        case 'boolean':
          return value == null ? value : Boolean(value)
        case 'number':
          return value == null ? value : Number(value)
        case 'string':
          return value == null ? value : String(value)
        case 'json':
          return typeof value === 'string' ? value : JSON.stringify(value)
        case 'date':
        case 'datetime':
        case 'timestamp':
          return value instanceof Date ? value.toISOString() : value
        case 'vector':
          return this.serializeVectorValue(value, builtInCast.parameter)
      }
    }

    cast = this.resolveCastDefinition(cast)
    if (typeof cast === 'undefined') return value

    if (typeof cast === 'object' && 'kind' in cast && cast.kind === 'enum') {
      if (value == null) {
        return value
      }

      if (!cast.values.includes(value as string | number)) {
        throw new HydrationError(`Enum cast rejected unsupported value "${String(value)}".`)
      }

      return value
    }

    return (typeof cast === 'object' && 'set' in cast && cast.set) ? cast.set(value) : value
  }

  private resolveCastDefinition(cast: ModelCastDefinition | undefined): Exclude<ModelCastDefinition, { castUsing(): ModelCastDefinition }> | undefined {
    if (!cast) {
      return cast
    }

    if (typeof cast === 'object' && 'castUsing' in cast && typeof cast.castUsing === 'function') {
      return this.resolveCastDefinition(cast.castUsing()) as Exclude<ModelCastDefinition, { castUsing(): ModelCastDefinition }>
    }

    return cast as Exclude<ModelCastDefinition, { castUsing(): ModelCastDefinition }>
  }

  private parseBuiltInCast(
    cast: ModelCastDefinition | undefined,
  ): { name: BuiltInCastName, parameter?: string } | null {
    if (typeof cast !== 'string') {
      return null
    }

    const [rawName, ...rest] = cast.split(':')
    const name = rawName as BuiltInCastName

    const parameter = rest.length > 0 ? rest.join(':').trim() : undefined
    return { name, parameter: parameter || undefined }
  }

  private parseVectorValue(value: unknown, parameter?: string): number[] | null | undefined {
    if (value == null) {
      return value as null | undefined
    }

    const numbers = Array.isArray(value)
      ? value
      : this.parseVectorString(value)

    if (numbers.some(entry => typeof entry !== 'number' || Number.isNaN(entry))) {
      throw new HydrationError('Vector casts require numeric array values.')
    }

    const expectedDimensions = this.parseVectorDimensions(parameter)
    if (expectedDimensions !== null && numbers.length !== expectedDimensions) {
      throw new HydrationError(`Vector cast requires exactly ${expectedDimensions} dimensions.`)
    }

    return [...numbers]
  }

  private serializeVectorValue(value: unknown, parameter?: string): string | null | undefined {
    const parsed = this.parseVectorValue(value, parameter)
    if (parsed == null) {
      return parsed
    }

    return `[${parsed.join(',')}]`
  }

  private parseVectorString(value: unknown): number[] {
    if (typeof value !== 'string') {
      throw new HydrationError('Vector casts require an array or string payload.')
    }

    const trimmed = value.trim()
    if (!trimmed) {
      throw new HydrationError('Vector casts require a non-empty payload.')
    }

    try {
      const parsed = JSON.parse(trimmed)
      if (!Array.isArray(parsed)) {
        throw new TypeError('Vector cast payload must deserialize to an array.')
      }
      return parsed.map(entry => Number(entry))
    } catch {
      // Fall through to the typed hydration error below.
    }

    throw new HydrationError('Vector casts require a JSON array or PostgreSQL-style vector literal.')
  }

  private parseVectorDimensions(parameter?: string): number | null {
    if (!parameter) {
      return null
    }

    const dimensions = Number(parameter)
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new HydrationError(`Vector cast parameter "${parameter}" must be a positive integer.`)
    }

    return dimensions
  }

  private formatDateCast(value: Date, parameter: string): number | string {
    if (parameter === 'unix') {
      return Math.floor(value.getTime() / 1000)
    }

    const parts = {
      Y: value.getUTCFullYear().toString().padStart(4, '0'),
      m: String(value.getUTCMonth() + 1).padStart(2, '0'),
      d: String(value.getUTCDate()).padStart(2, '0'),
      H: String(value.getUTCHours()).padStart(2, '0'),
      i: String(value.getUTCMinutes()).padStart(2, '0'),
      s: String(value.getUTCSeconds()).padStart(2, '0'),
    }

    return parameter.replaceAll(/[YmdHis]/g, token => parts[token as keyof typeof parts])
  }
}
