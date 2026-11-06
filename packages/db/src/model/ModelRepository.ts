import { connectionAsyncContext } from '../concurrency/AsyncConnectionContext'
import { DB } from '../facade/DB'
import { ConfigurationError, HydrationError, ModelNotFoundException, RelationError, SecurityError } from '../core/errors'
import { assertQueryTablePath } from '../query/validator'
import {
  createDatabaseQueryFallbackObservation,
  createDatabaseQueryObservation,
  createTableCacheDependency,
  createTablePredicateCacheDependency,
  hasActiveDatabaseDependencyCollector,
  inferDatabaseQueryObservationDependencies,
  readDatabaseQueryObservationCount,
  recordDatabaseQueryObservation,
  resolveQueryCacheDependencies,
  runRequiringDatabaseQueryRefresh,
  truncateDatabaseQueryObservations,
  type DatabaseQueryAggregateObservation,
  type DatabaseQueryObservation,
  type DatabaseQueryPredicateObservation,
  type DatabaseQueryResultPathSegment,
} from '../cache'
import { TableQueryBuilder, insertGetIdByKey, joinOnKeyColumns, selectKeyColumn, whereKeyColumn } from '../query/TableQueryBuilder'
import { getLoadedColumnListing, getLoadedTableDefinition, loadColumnListing, loadTableDefinition } from '../schema/columnListing'
import { getConnectionGeneratedTableDefinition, isUnresolvedGeneratedPrimaryKey } from '../schema/generated'
import { textMatchesAnyNumber } from '../schema/connectionDialect'
import { normalizeDialectReadValue, storesJson, storesText } from '../schema/normalization'
import { resolveModelRowKey } from './defineModelHelpers'
import { createSelectQueryPlan, createTableSource, withLockMode, withOneOfManyAggregateMarker, withPredicate, type QueryPredicateNode, type SelectQueryPlan } from '../query/ast'
import { commitFailureRestoreFor } from '../core/commitFailureCallbacks'
import { Entity, captureEntityWriteState, createEntityCommitRestore, getEntityKeyForSave, restoreEntityWriteState } from './Entity'
import { assertAttributeNameAllowed, assertColumnWritable, canonicalStoredKey, ownEntry, type RejectedGeneratedColumns, snapshotAttributes, valuesAreEqual } from './entityRuntime'
import { StoredKeyMap, StoredKeySet, type StoredKeyOptions } from './storedKeyCollections'
import { PivotMutation } from './PivotMutation'
import { PIVOT_TIMESTAMP_COLUMNS } from './relations'
import { collectRelationKeys, distinctStoredKeys, integerKeysToInline, isFractionalKeyFor, isKeySeparableQuery, keysForColumn, pivotKeyCasts, sourceKeyCast, relationKeyOptions, isPaginatedRelationQuery, loadRelationKeyChunks, retrieveRelation, retrievePivotRelation, indexRelation, groupRelation, singleStatementRelationKeys } from './relationRetrieval'
import { assertEntitiesBelongTo, createModelCollection, setModelCollectionOwner, type ModelCollection } from './collection'
import { isUniqueConstraintError } from './constraintErrors'
import { listDynamicRelationNames, resolveDynamicRelation } from './dynamicRelations'
import { normalizeQualifiedRelationKeys } from './qualifiedRelationKeys'
import { areModelGuardsDisabled, withoutModelEvents } from './eventState'
import { ModelQueryBuilder, loadRelationsOn, whereIntegerKeysIn, withoutRelationLoads } from './ModelQueryBuilder'
import { ModelEventDispatcher } from './ModelEventDispatcher'
import { ModelValueTransformer } from './ModelValueTransformer'
import {
  RelationAggregateCalculator,
  type RelationAggregateComputation,
} from './RelationAggregateCalculator'
import { listMorphModels, resolveMorphModel } from './morphRegistry'
import { getModelRuntimeSettings } from './runtimeSettings'
import { modelNeedsSerialization } from './serialize'
import { applyGeneratedUniqueIds, applyPendingModelAttributes } from './uniqueIds'
import type { AnyColumnDefinition, TableDefinition } from '../schema/types'
import type { SchemaDialectName } from '../schema/typeMapping'
import type { DatabaseContext } from '../core/DatabaseContext'
import { canonicalTableName } from '../schema/tableIdentityRegistry'
import { resolveGeneratedTableIdentity } from '../query/tableIdentity'
import type {
  AnyModelDefinition,
  ModelDefinitionLike,
  ModelCastDefinition,
  ModelColumnName,
  ModelLifecycleEventName,
  ModelDefinition,
  ModelInsertPayload,
  ModelRecord,
  ModelReference,
  RelationDefinition,
  RelationAggregateKind,
  ModelUpdatePayload,
  EmptyScopeMap,
  ModelScopesDefinition,
  RelationMap,
} from './types'

type WriteMode = 'create' | 'update'
type WriteMarks = {
  readonly sqlCompleted: () => void
  readonly normalized: () => void
}
type PivotAttributes = Record<string, unknown>
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
type RelationAggregateObservationTarget = {
  readonly column: string
  readonly connectionName: string
  readonly primaryKey: string | undefined
  readonly table: TableDefinition
  readonly tableName: string
  readonly value: unknown
}
type BelongsToManyRelatedObservationMetadata = {
  readonly dependencies: readonly string[]
  readonly values: readonly unknown[]
}
type PivotRelationDefinition = Extract<RelationDefinition, { kind: 'belongsToMany' | 'morphToMany' | 'morphedByMany' }>
type ThroughRelationDefinition = Extract<RelationDefinition, { kind: 'hasOneThrough' | 'hasManyThrough' }>
type PivotMutationRelationDefinition = PivotRelationDefinition

function readsSQLiteDecimals(connection: DatabaseContext, table: string | TableDefinition | undefined): boolean {
  return connection.getDriver() === 'sqlite' && typeof table === 'object' && Object.values(table.columns).some(column => column.kind === 'decimal')
}

function relatedRowsArePatchable(related: ModelRepository): boolean {
  return !modelNeedsSerialization(related.definition) && !readsSQLiteDecimals(related.getConnection(), related.definition.table)
}

function hasTypedComparison(predicates: readonly QueryPredicateNode[]): boolean {
  return predicates.some(predicate => (predicate.kind === 'comparison' && typeof predicate.valueType !== 'undefined')
    || (predicate.kind === 'group' && hasTypedComparison(predicate.predicates)))
}

function createRelationQueryObservation(plan: SelectQueryPlan, connectionName: string, textMatchesAnyNumber: boolean): DatabaseQueryObservation | undefined {
  const dependencies = resolveQueryCacheDependencies(plan, connectionName, undefined, textMatchesAnyNumber)
  const observation = dependencies ? createDatabaseQueryObservation(plan, connectionName, dependencies) : undefined
  return observation ?? createDatabaseQueryFallbackObservation(
    plan,
    connectionName,
    inferDatabaseQueryObservationDependencies(plan, connectionName) ?? [createTableCacheDependency(connectionName, plan.source.tableName)],
  )
}

function serializedFlag(serialized: boolean): { readonly serialized?: true } {
  return serialized ? { serialized: true } : {}
}

const relationAggregateObservationMetadata = new WeakMap<object, Map<string, DatabaseQueryAggregateObservation>>()
const relationQueryObservationMetadata = new WeakMap<object, Map<string, DatabaseQueryObservation>>()

function findWriteColumn(definition: AnyModelDefinition, key: string, rejected: RejectedGeneratedColumns) {
  const attribute = key.includes('->') ? key.split('->')[0]! : key
  const ownTablePrefix = `${definition.table.tableName}.`
  const columnName = attribute.startsWith(ownTablePrefix) ? attribute.slice(ownTablePrefix.length) : attribute
  assertAttributeNameAllowed(columnName)
  const column = ownEntry(definition.table.columns, columnName)
  if (!column && !definition.untyped) {
    throw new SecurityError(`Column "${columnName}" is not defined on model "${definition.name}".`)
  }

  assertColumnWritable(columnName, column, rejected)

  return { columnName, column }
}

function isClassCast(cast: ModelCastDefinition | undefined): boolean {
  return typeof cast === 'object' && !('kind' in cast && cast.kind === 'enum')
}

function hasDefinition<TTable extends TableDefinition>(
  reference: ModelDefinitionLike | ModelDefinition<TTable> | ModelReference<TTable>,
): reference is ModelReference<TTable> | { definition: AnyModelDefinition } {
  return 'definition' in reference
}

function isEntity(value: unknown): value is Entity {
  return value instanceof Entity
}

export function getModelDefinition<TTable extends TableDefinition, TScopes extends ModelScopesDefinition = EmptyScopeMap>(
  reference: ModelDefinitionLike | ModelDefinition<TTable, TScopes> | ModelReference<TTable, TScopes>,
): ModelDefinition<TTable, TScopes> {
  return (hasDefinition(reference) ? reference.definition : reference) as ModelDefinition<TTable, TScopes>
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

function resolveActiveConnection(connection: DatabaseContext): DatabaseContext {
  const active = connectionAsyncContext.getActive()
  if (
    active
    && active.connectionName === connection.getConnectionName()
    && active.connection.getContextId() === connection.getContextId()
  ) {
    return active.connection
  }

  return connection
}

type PivotKeyColumns = {
  readonly parentKey: AnyColumnDefinition | undefined
  readonly relatedKey: AnyColumnDefinition | undefined
  readonly introspected: boolean
}

export class ModelRepository<
  TTable extends TableDefinition = TableDefinition,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
> {
  readonly definition: ModelDefinition<TTable, TScopes>
  private readonly eventDispatcher: ModelEventDispatcher<TTable>
  private readonly relationAggregateCalculator = new RelationAggregateCalculator()
  private readonly valueTransformer: ModelValueTransformer<TTable>

  constructor(
    definition: ModelDefinition<TTable, TScopes>,
    private readonly connection: DatabaseContext,
  ) {
    this.definition = definition
    this.eventDispatcher = new ModelEventDispatcher(definition, this)
    this.valueTransformer = new ModelValueTransformer(definition, () => this.getConnection().getDriver() as SchemaDialectName)
  }

  static from<TTable extends TableDefinition, TScopes extends ModelScopesDefinition = EmptyScopeMap>(
    reference: ModelDefinitionLike | ModelDefinition<TTable, TScopes> | ModelReference<TTable, TScopes>,
    connection?: DatabaseContext,
  ): ModelRepository<TTable, TScopes> {
    const definition = getModelDefinition(reference)
    return new ModelRepository(definition, connection ?? resolveModelConnection(definition))
  }

  getConnection(): DatabaseContext {
    return resolveActiveConnection(this.connection)
  }

  getConnectionName(): string {
    return this.getConnection().getConnectionName()
  }

  private textMatchesAnyNumber(connectionName: string): boolean {
    if (connectionName === this.getConnectionName()) {
      return textMatchesAnyNumber(this.getConnection())
    }

    try {
      return textMatchesAnyNumber(DB.connection(connectionName))
    } catch {
      return true
    }
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

    return normalizeQualifiedRelationKeys(this.definition, name, relation)
  }

  createCollection<TItem extends Entity<TTable>>(items: readonly TItem[]): ModelCollection<TTable, RelationMap, TItem, TScopes> {
    this.assertOwnedEntities(items)
    const collection = this.definition.collection
      ? this.definition.collection(items) as ModelCollection<TTable, RelationMap, TItem, TScopes>
      : createModelCollection<TTable, RelationMap, TItem, TScopes>(items)
    return setModelCollectionOwner(collection, this)
  }

  private assertOwnedEntities(entities: readonly Entity<TTable>[]): void {
    assertEntitiesBelongTo(entities, this)
  }

  query(): ModelQueryBuilder<TTable, RelationMap, unknown, TScopes> {
    return this.createQuery(true, true, true)
  }

  newQuery(): ModelQueryBuilder<TTable, RelationMap, unknown, TScopes> {
    return this.createQuery(true, true, true)
  }

  newModelQuery(): ModelQueryBuilder<TTable, RelationMap, unknown, TScopes> {
    return this.createQuery(true, true, true)
  }

  newQueryWithoutScopes(): ModelQueryBuilder<TTable, RelationMap, unknown, TScopes> {
    return this.createQuery(false, false, true)
  }

  queryWithoutGlobalScope(name: string): ModelQueryBuilder<TTable, RelationMap, unknown, TScopes> {
    return this.createQuery(true, true, true, new Set([name]))
  }

  queryWithoutGlobalScopes(names?: readonly string[]): ModelQueryBuilder<TTable, RelationMap, unknown, TScopes> {
    if (names && names.length > 0) {
      return this.createQuery(true, true, true, new Set(names))
    }

    return this.createQuery(false, false, true)
  }

  newQueryWithoutRelationships(): ModelQueryBuilder<TTable, RelationMap, unknown, TScopes> {
    return this.createQuery(true, true, false)
  }

  async resolveTableIdentity(): Promise<void> {
    await resolveGeneratedTableIdentity(this.getConnection(), this.definition.table.tableName)
  }

  async find(value: unknown): Promise<Entity<TTable> | undefined> {
    await this.resolveTableIdentity()
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

  async get(): Promise<ModelCollection<TTable, RelationMap, Entity<TTable>, TScopes>> {
    return this.query().get()
  }

  async sole(): Promise<Entity<TTable>> {
    return this.query().sole()
  }

  async all(): Promise<ModelCollection<TTable, RelationMap, Entity<TTable>, TScopes>> {
    return this.get()
  }

  async findMany(values: readonly unknown[]): Promise<ModelCollection<TTable, RelationMap, Entity<TTable>, TScopes>> {
    await this.resolveTableIdentity()
    const primaryKey = this.definition.primaryKey
    const keys = [...new Set(values)]
    if (keys.length === 0) {
      return this.createCollection([])
    }

    const scoped = this.query()
    if (!isKeySeparableQuery(scoped)) {
      const integerKeys = integerKeysToInline(keys, this.definition.table.columns[primaryKey])
      return integerKeys
        ? scoped[whereIntegerKeysIn](integerKeys).get()
        : scoped.where(primaryKey, 'in', singleStatementRelationKeys(keys)).get()
    }

    const storedRows = await loadRelationKeyChunks(keys, false, chunk => scoped
      .getTableQueryBuilder()
      .select(primaryKey as never)
      .where(primaryKey, 'in', chunk)
      .get<Record<string, unknown>>())
    const storedKeys = distinctStoredKeys(storedRows.map(row => row[primaryKey]))
    const hydration = scoped[withoutRelationLoads]()
    const entities = await loadRelationKeyChunks(storedKeys, false, chunk => hydration
      .where(primaryKey, 'in', chunk)
      .get())
    this.attachCollection(entities)
    await scoped[loadRelationsOn](entities)
    return this.createCollection(entities)
  }

  async firstWhere(column: ModelColumnName<TTable>, operator: unknown, value?: unknown): Promise<Entity<TTable> | undefined> {
    return this.query().where(column as never, operator, value).first()
  }

  async firstOrNew(
    match: Partial<ModelRecord<TTable>>,
    values: ModelInsertPayload<TTable> = {},
  ): Promise<Entity<TTable>> {
    const query = this.queryMatching(match)

    const existing = await query.first()
    if (existing) {
      return existing
    }

    return this.make({ ...match, ...values })
  }

  async firstOrCreate(
    match: Partial<ModelRecord<TTable>>,
    values: ModelInsertPayload<TTable> = {},
  ): Promise<Entity<TTable>> {
    const query = this.queryMatching(match)

    const existing = await query.first()
    if (existing) {
      return existing
    }

    try {
      return await this.create({ ...match, ...values })
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error
      }

      const concurrent = await query.first()
      if (concurrent) {
        return concurrent
      }

      throw error
    }
  }

  async createOrFirst(
    match: Partial<ModelRecord<TTable>>,
    values: ModelInsertPayload<TTable> = {},
  ): Promise<Entity<TTable>> {
    if (Object.keys(match).length === 0) {
      throw new HydrationError('createOrFirst() requires at least one attribute to match the existing row.')
    }

    assertQueryTablePath(this.definition.table.tableName)
    const connection = this.getConnection()
    const create = () => this.create({ ...match, ...values })
    try {
      return connection.getScope().kind === 'root' ? await create() : await connection.transaction(create)
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error
      }

      const existing = await this.queryMatching(match).first()
      if (existing) {
        return existing
      }

      throw error
    }
  }

  private queryMatching(match: Partial<ModelRecord<TTable>>) {
    return Object.entries(match)
      .reduce((query, [column, value]) => query.where(column as never, value), this.query())
  }

  make(values: ModelInsertPayload<TTable> = {}): Entity<TTable> {
    return new Entity(
      this,
      this.assertMassAssignable(applyPendingModelAttributes(this.definition, values)),
      false,
    )
  }

  hydrate(values: Partial<ModelRecord<TTable>>): Entity<TTable> {
    return new Entity(this, this.normalizeFromStorage(values), true)
  }

  async retrieve(values: Partial<ModelRecord<TTable>>, sourceConnection: DatabaseContext = this.getConnection()): Promise<Entity<TTable>> {
    return this.retrieveWithCasts(values, {}, sourceConnection.getDriver() as SchemaDialectName)
  }

  async retrieveWithCasts(
    values: Partial<ModelRecord<TTable>>,
    casts: Record<string, ModelCastDefinition>,
    sourceDialect?: SchemaDialectName,
  ): Promise<Entity<TTable>> {
    const entity = new Entity(this, this.valueTransformer.normalizeFromStorage(values, casts, 'database', sourceDialect), true)
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
      if (typeof entry.constraint !== 'undefined' && nested.length === 0) {
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

      if (node.children.length > 0) {
        await this.loadRequiringQueryRefresh(() => this.loadRelationTree(pending, relationName, relation, node, missingOnly))
        continue
      }

      await this.loadRelation(pending, relationName, relation, node.constraint)
    }
  }

  private async loadRelationTree(
    pending: readonly Entity<TTable>[],
    relationName: string,
    relation: RelationDefinition,
    node: { readonly constraint?: RelationConstraint, readonly children: readonly EagerLoad[] },
    missingOnly: boolean,
  ): Promise<void> {
    await this.loadRelation(pending, relationName, relation, node.constraint)
    this.forgetPatchableRelationObservations(pending, relationName)

    const relatedEntities = this.collectLoadedRelationEntities(pending, relationName)
    if (relatedEntities.length === 0) {
      return
    }

    if (relation.kind !== 'morphTo') {
      await this.resolveRelatedRepository(relation.related).loadRelations(relatedEntities, node.children, missingOnly)
      return
    }

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
        const merged = new StoredKeyMap<Entity<TTable>>()
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
        return filter.boolean === 'or'
          ? query.orWhere(builder => builder
              .whereNull(this.qualifyParentColumn(this.definition.primaryKey) as never)
              .orWhereNotNull(this.qualifyParentColumn(this.definition.primaryKey) as never))
          : query
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

    await this.loadRequiringQueryRefresh(() => this.loadMorphTargets(entities, relationName, relation, mapping))
  }

  private async loadMorphTargets(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'morphTo' }>,
    mapping: Readonly<Record<string, string | readonly string[] | Readonly<Record<string, RelationConstraint>>>>,
  ): Promise<void> {
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

    const observationCount = hasActiveDatabaseDependencyCollector()
      ? readDatabaseQueryObservationCount()
      : undefined

    for (const aggregate of aggregates) {
      if (aggregate.relation.includes('.')) {
        throw new SecurityError('Nested relation aggregates are not supported yet.')
      }

      const relation = this.getRelationDefinition(aggregate.relation)
      const key = this.relationAggregateCalculator.getAttributeKey(aggregate)
      const constrained = Boolean(aggregate.constraint || relation.constraint)

      if (aggregate.kind === 'count' || aggregate.kind === 'exists') {
        const counts = await this.loadRequiringQueryRefreshWhen(constrained, () => this.getRelationMatchCounts(entities, relation, aggregate.constraint))

        for (const entity of entities) {
          const parentKey = this.getRelationParentValue(entity, relation)
          const count = counts.get(parentKey) ?? 0
          entity.setComputed(key, aggregate.kind === 'count' ? count : count > 0)
          if (aggregate.kind === 'exists' && typeof observationCount === 'number') {
            this.setRelationAggregateObservationMetadata(entity, key, Object.freeze({
              count,
              kind: 'count',
            }))
          }
        }

        continue
      }

      if (!aggregate.column) {
        throw new SecurityError(`Relation aggregate "${aggregate.kind}" requires a target column.`)
      }

      const values = await this.loadRequiringQueryRefreshWhen(constrained, () => this.getRelationAggregateValues(entities, relation, aggregate))
      for (const entity of entities) {
        const parentKey = this.getRelationParentValue(entity, relation)
        const computation = values.get(parentKey)
        entity.setComputed(key, computation?.value ?? null)
        if (computation?.metadata && typeof observationCount === 'number') {
          this.setRelationAggregateObservationMetadata(entity, key, computation.metadata)
        }
      }
    }

    if (typeof observationCount === 'number') {
      truncateDatabaseQueryObservations(observationCount)
    }
  }

  recordRelationAggregateObservations(
    entities: readonly Entity<TTable>[],
    aggregates: readonly AggregateLoad[],
    createPath: (index: number, key: string) => readonly DatabaseQueryResultPathSegment[],
  ): void {
    if (!hasActiveDatabaseDependencyCollector() || entities.length === 0 || aggregates.length === 0) {
      return
    }

    for (const aggregate of aggregates) {
      if (aggregate.relation.includes('.')) {
        continue
      }

      const relation = this.getRelationDefinition(aggregate.relation)
      const key = this.relationAggregateCalculator.getAttributeKey(aggregate)

      for (let index = 0; index < entities.length; index += 1) {
        const entity = entities[index]
        if (!entity) {
          continue
        }

        const target = this.createRelationAggregateObservationTarget(entity, relation)
        if (!target) {
          continue
        }

        const aggregateObservation = this.createRelationAggregateObservation(aggregate, entity, key)
        if (!aggregateObservation) {
          continue
        }

        const predicateDependency = createTablePredicateCacheDependency(
          target.connectionName,
          target.tableName,
          target.column,
          target.value,
          this.textMatchesAnyNumber(target.connectionName),
        )
        const dependencies = predicateDependency
          ? Object.freeze([
              createTableCacheDependency(target.connectionName, target.tableName),
              predicateDependency,
            ])
          : Object.freeze([createTableCacheDependency(target.connectionName, target.tableName)])
        const resultPath = createPath(index, key)
        const data = entity.toJSON() as Readonly<Record<string, unknown>>
        const primaryKey = target.primaryKey
        recordDatabaseQueryObservation(Object.freeze({
          aggregate: aggregate.kind === 'exists'
            ? Object.freeze({
                ...aggregateObservation,
                output: 'boolean',
              })
            : aggregateObservation,
          connectionName: target.connectionName,
          dependencies,
          orderBy: [],
          patchable: primaryKey !== undefined && (aggregate.column === undefined || target.table.columns[aggregate.column]?.kind !== 'boolean'),
          ...serializedFlag(modelNeedsSerialization(this.definition)),
          predicates: Object.freeze([Object.freeze({
            column: target.column,
            operator: '=' as const,
            value: target.value,
          })]),
          primaryKey,
          result: data[key],
          resultPath,
          selections: [],
          tableName: target.tableName,
        }))
      }
    }
  }

  recordRelationObservations(
    entities: readonly Entity<TTable>[],
    relations: readonly (string | EagerLoad)[],
    createPath: (index: number, relationName: string) => readonly DatabaseQueryResultPathSegment[],
  ): void {
    if (!hasActiveDatabaseDependencyCollector() || entities.length === 0 || relations.length === 0) {
      return
    }

    for (const entry of this.normalizeEagerLoads(relations)) {
      if (entry.relation.includes('.')) {
        continue
      }

      const relationName = entry.relation
      const relation = this.getRelationDefinition(relationName)

      if (relation.kind === 'hasMany') {
        this.recordHasManyRelationObservations(entities, relationName, relation, createPath)
        continue
      }

      if (relation.kind === 'hasOne') {
        this.recordHasOneRelationObservations(entities, relationName, relation, createPath)
        continue
      }

      if (relation.kind === 'belongsTo') {
        this.recordBelongsToRelationObservations(entities, relationName, relation, entry.constraint, createPath)
        continue
      }

      if (relation.constraint || entry.constraint) {
        continue
      }

      if (relation.kind === 'belongsToMany') {
        this.recordBelongsToManyRelationObservations(entities, relationName, relation, createPath)
      }
    }
  }

  private recordHasManyRelationObservations(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'hasMany' }>,
    createPath: (index: number, relationName: string) => readonly DatabaseQueryResultPathSegment[],
  ): void {
    const related = this.resolveRelatedRepository(relation.related)
    for (let index = 0; index < entities.length; index += 1) {
      const entity = entities[index]
      if (!entity || !entity.hasRelation(relationName)) {
        continue
      }

      const observed = this.getRelationQueryObservation(entity, relationName)
      if (observed) {
        recordDatabaseQueryObservation(Object.freeze({
          ...observed,
          patchable: observed.patchable && relatedRowsArePatchable(related),
          ...serializedFlag(!relatedRowsArePatchable(related)),
          resultPath: createPath(index, relationName),
        }))
        continue
      }

      if (relation.constraint) {
        continue
      }

      const parentKey = this.getRelationParentValue(entity, relation)
      const predicateDependency = createTablePredicateCacheDependency(
        related.getConnectionName(),
        related.definition.table.tableName,
        relation.foreignKey,
        parentKey,
        this.textMatchesAnyNumber(related.getConnectionName()),
      )
      const dependencies = Object.freeze([
        createTableCacheDependency(related.getConnectionName(), related.definition.table.tableName),
        ...(predicateDependency ? [predicateDependency] : []),
      ])

      const primaryKey = resolveModelRowKey(related.definition)
      recordDatabaseQueryObservation(Object.freeze({
        connectionName: related.getConnectionName(),
        dependencies,
        orderBy: [],
        patchable: relatedRowsArePatchable(related) && primaryKey !== undefined,
        ...serializedFlag(!relatedRowsArePatchable(related)),
        predicates: Object.freeze([Object.freeze({
          column: relation.foreignKey,
          operator: '=' as const,
          value: parentKey,
        })]),
        primaryKey,
        resultPath: createPath(index, relationName),
        selections: [],
        table: related.definition.table,
        tableName: related.definition.table.tableName,
      }))
    }
  }

  private recordHasOneRelationObservations(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'hasOne' }>,
    createPath: (index: number, relationName: string) => readonly DatabaseQueryResultPathSegment[],
  ): void {
    const related = this.resolveRelatedRepository(relation.related)
    for (let index = 0; index < entities.length; index += 1) {
      const entity = entities[index]
      if (!entity || !entity.hasRelation(relationName)) {
        continue
      }

      const resultPath = createPath(index, relationName)
      const observed = this.getRelationQueryObservation(entity, relationName)
      if (observed) {
        recordDatabaseQueryObservation(this.createNullableSingleRecordRelationObservation({
          ...observed,
          patchable: observed.patchable && relatedRowsArePatchable(related),
          ...serializedFlag(!relatedRowsArePatchable(related)),
        }, resultPath))
        continue
      }

      if (relation.constraint) {
        continue
      }

      const parentKey = this.getRelationParentValue(entity, relation)
      const predicateDependency = createTablePredicateCacheDependency(
        related.getConnectionName(),
        related.definition.table.tableName,
        relation.foreignKey,
        parentKey,
        this.textMatchesAnyNumber(related.getConnectionName()),
      )
      const dependencies = Object.freeze([
        createTableCacheDependency(related.getConnectionName(), related.definition.table.tableName),
        ...(predicateDependency ? [predicateDependency] : []),
      ])

      recordDatabaseQueryObservation(this.createNullableSingleRecordRelationObservation(Object.freeze({
        connectionName: related.getConnectionName(),
        dependencies,
        orderBy: [],
        patchable: relatedRowsArePatchable(related),
        ...serializedFlag(!relatedRowsArePatchable(related)),
        predicates: Object.freeze([Object.freeze({
          column: relation.foreignKey,
          operator: '=' as const,
          value: parentKey,
        })]),
        selections: [],
        table: related.definition.table,
        tableName: related.definition.table.tableName,
      }), resultPath))
    }
  }

  private recordBelongsToRelationObservations(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'belongsTo' }>,
    constraint: RelationConstraint | undefined,
    createPath: (index: number, relationName: string) => readonly DatabaseQueryResultPathSegment[],
  ): void {
    const related = this.resolveRelatedRepository(relation.related)
    const ownerPredicates = this.resolveBelongsToOwnerPredicates(relation, constraint)
    for (let index = 0; index < entities.length; index += 1) {
      const entity = entities[index]
      if (!entity || !entity.hasRelation(relationName)) {
        continue
      }

      const resultPath = createPath(index, relationName)
      const observed = this.getRelationQueryObservation(entity, relationName)
      recordDatabaseQueryObservation(this.createBelongsToParentKeyRelationObservation(
        entity,
        relationName,
        relation,
        resultPath.slice(0, -1),
        ownerPredicates,
      ))
      if (observed) {
        recordDatabaseQueryObservation(this.createNullableSingleRecordRelationObservation({
          ...observed,
          patchable: observed.patchable && relatedRowsArePatchable(related),
          ...serializedFlag(!relatedRowsArePatchable(related)),
        }, resultPath))
        continue
      }

      if (relation.constraint) {
        continue
      }

      const ownerKey = this.getRelationParentValue(entity, relation)
      if (ownerKey === null || typeof ownerKey === 'undefined') {
        continue
      }

      const predicateDependency = createTablePredicateCacheDependency(
        related.getConnectionName(),
        related.definition.table.tableName,
        relation.ownerKey,
        ownerKey,
        this.textMatchesAnyNumber(related.getConnectionName()),
      )
      const dependencies = Object.freeze([
        createTableCacheDependency(related.getConnectionName(), related.definition.table.tableName),
        ...(predicateDependency ? [predicateDependency] : []),
      ])

      recordDatabaseQueryObservation(this.createNullableSingleRecordRelationObservation(Object.freeze({
        connectionName: related.getConnectionName(),
        dependencies,
        orderBy: [],
        patchable: typeof ownerPredicates !== 'undefined',
        ...serializedFlag(!relatedRowsArePatchable(related)),
        predicates: Object.freeze([Object.freeze({
          column: relation.ownerKey,
          operator: '=' as const,
          value: ownerKey,
        }), ...(ownerPredicates ?? [])]),
        selections: [],
        table: related.definition.table,
        tableName: related.definition.table.tableName,
      }), resultPath))
    }
  }

  private createBelongsToParentKeyRelationObservation(
    entity: Entity<TTable>,
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'belongsTo' }>,
    resultPath: readonly DatabaseQueryResultPathSegment[],
    ownerPredicates: readonly DatabaseQueryPredicateObservation[] | undefined,
  ): DatabaseQueryObservation | undefined {
    const parentKey = entity.toAttributes()[this.definition.primaryKey as keyof ReturnType<typeof entity.toAttributes>]
    if (parentKey === null || typeof parentKey === 'undefined') {
      return undefined
    }

    const predicateDependency = createTablePredicateCacheDependency(
      this.getConnectionName(),
      this.definition.table.tableName,
      this.definition.primaryKey,
      parentKey,
      this.textMatchesAnyNumber(this.getConnectionName()),
    )
    const dependencies = Object.freeze([
      createTableCacheDependency(this.getConnectionName(), this.definition.table.tableName),
      ...(predicateDependency ? [predicateDependency] : []),
    ])
    const related = this.resolveRelatedRepository(relation.related)

    return Object.freeze({
      connectionName: this.getConnectionName(),
      dependencies,
      orderBy: [],
      patchable: typeof ownerPredicates !== 'undefined',
      ...serializedFlag(!relatedRowsArePatchable(related)),
      predicates: Object.freeze([Object.freeze({
        column: this.definition.primaryKey,
        operator: '=' as const,
        value: parentKey,
      })]),
      relation: Object.freeze({
        foreignKey: relation.foreignKey,
        kind: 'belongsToParentKey' as const,
        ownerKey: relation.ownerKey,
        predicates: ownerPredicates ?? Object.freeze([]),
        relationKey: relationName,
        relatedConnectionName: related.getConnectionName(),
        relatedTableName: canonicalTableName(related.getConnectionName(), related.definition.table.tableName),
        relatedTable: related.definition.table,
      }),
      resultPath,
      selections: Object.freeze([Object.freeze({
        column: relation.foreignKey,
        resultKey: relation.foreignKey,
      })]),
      table: this.definition.table,
      tableName: this.definition.table.tableName,
    })
  }

  private createNullableSingleRecordRelationObservation(
    observation: DatabaseQueryObservation,
    resultPath: readonly DatabaseQueryResultPathSegment[],
  ): DatabaseQueryObservation {
    return Object.freeze({
      ...observation,
      emptyRecordValue: null,
      limit: 1,
      resultPath,
      rowWindowMode: 'single',
    })
  }

  private rememberHasManyRelationObservation(
    entity: Entity<TTable>,
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'hasMany' }>,
    related: ModelRepository,
    constrainedPlan: SelectQueryPlan,
    parentKey: unknown,
    rowsPatchable: boolean,
  ): void {
    const created = this.createHasManyRelationObservation(relation, related, constrainedPlan, parentKey)
    if (!created) {
      return
    }

    const observation = rowsPatchable ? created : Object.freeze({ ...created, patchable: false })

    const observations = relationQueryObservationMetadata.get(entity) ?? new Map<string, DatabaseQueryObservation>()
    observations.set(relationName, observation)
    relationQueryObservationMetadata.set(entity, observations)
  }

  private rememberBelongsToRelationObservation(
    entity: Entity<TTable>,
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'belongsTo' }>,
    related: ModelRepository,
    constrainedPlan: SelectQueryPlan,
    ownerKey: unknown,
    rowsPatchable: boolean,
  ): void {
    const created = this.createBelongsToRelationObservation(relation, related, constrainedPlan, ownerKey)
    if (!created) {
      return
    }

    const observation = rowsPatchable ? created : Object.freeze({ ...created, patchable: false })

    const observations = relationQueryObservationMetadata.get(entity) ?? new Map<string, DatabaseQueryObservation>()
    observations.set(relationName, observation)
    relationQueryObservationMetadata.set(entity, observations)
  }

  private forgetPatchableRelationObservations(
    entities: readonly Entity<TTable>[],
    relationName: string,
  ): void {
    for (const entity of entities) {
      const observations = relationQueryObservationMetadata.get(entity)
      const observation = observations?.get(relationName)
      if (observations && observation?.patchable) {
        observations.set(relationName, Object.freeze({ ...observation, patchable: false }))
      }
    }
  }

  private getRelationQueryObservation(
    entity: Entity<TTable>,
    relationName: string,
  ): DatabaseQueryObservation | undefined {
    return relationQueryObservationMetadata.get(entity)?.get(relationName)
  }

  private createHasManyRelationObservation(
    relation: Extract<RelationDefinition, { kind: 'hasMany' }>,
    related: ModelRepository,
    constrainedPlan: SelectQueryPlan,
    parentKey: unknown,
  ): DatabaseQueryObservation | undefined {
    if (parentKey === null || typeof parentKey === 'undefined') {
      return undefined
    }

    const parentPlan = withPredicate(constrainedPlan, {
      kind: 'comparison',
      column: relation.foreignKey,
      operator: '=',
      value: parentKey,
    })
    return createRelationQueryObservation(parentPlan, related.getConnectionName(), this.textMatchesAnyNumber(related.getConnectionName()))
  }

  private createBelongsToRelationObservation(
    relation: Extract<RelationDefinition, { kind: 'belongsTo' }>,
    related: ModelRepository,
    constrainedPlan: SelectQueryPlan,
    ownerKey: unknown,
  ): DatabaseQueryObservation | undefined {
    if (ownerKey === null || typeof ownerKey === 'undefined') {
      return undefined
    }

    const ownerPlan = withPredicate(constrainedPlan, {
      kind: 'comparison',
      column: relation.ownerKey,
      operator: '=',
      value: ownerKey,
    })
    return createRelationQueryObservation(ownerPlan, related.getConnectionName(), this.textMatchesAnyNumber(related.getConnectionName()))
  }

  private recordBelongsToManyRelationObservations(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'belongsToMany' }>,
    createPath: (index: number, relationName: string) => readonly DatabaseQueryResultPathSegment[],
  ): void {
    const related = this.resolveRelatedRepository(relation.related)
    const pivotTableName = this.resolvePivotTableName(relation.pivotTable)
    const resolvedPivotTable = this.resolvePivotTable(relation.pivotTable, this.getConnection())
    const pivotTable = typeof resolvedPivotTable === 'string' ? undefined : resolvedPivotTable
    for (let index = 0; index < entities.length; index += 1) {
      const entity = entities[index]
      if (!entity || !entity.hasRelation(relationName)) {
        continue
      }

      const parentKey = this.getRelationParentValue(entity, relation)
      const predicateDependency = createTablePredicateCacheDependency(
        this.getConnectionName(),
        pivotTableName,
        relation.foreignPivotKey,
        parentKey,
        this.textMatchesAnyNumber(this.getConnectionName()),
      )
      const relatedMetadata = this.createBelongsToManyRelatedObservationMetadata(entity, relationName, relation, related)
      const dependencies = predicateDependency
        ? Object.freeze([
            createTableCacheDependency(this.getConnectionName(), pivotTableName),
            predicateDependency,
            ...relatedMetadata.dependencies,
          ])
        : Object.freeze([
            createTableCacheDependency(this.getConnectionName(), pivotTableName),
            ...relatedMetadata.dependencies,
          ])

      const relationObservation = Object.freeze({
        foreignPivotKey: relation.foreignPivotKey,
        kind: 'belongsToMany' as const,
        pivotAccessor: relation.pivotAccessor,
        pivotColumns: relation.pivotColumns,
        pivotOrderBy: relation.pivotOrderBy,
        relatedConnectionName: related.getConnectionName(),
        relatedKey: relation.relatedKey,
        relatedPivotKey: relation.relatedPivotKey,
        relatedTableName: canonicalTableName(related.getConnectionName(), related.definition.table.tableName),
        relatedTable: related.definition.table,
      })

      recordDatabaseQueryObservation(Object.freeze({
        connectionName: this.getConnectionName(),
        dependencies,
        orderBy: relation.pivotOrderBy,
        patchable: relation.pivotWheres.length === 0 && relatedRowsArePatchable(related) && this.pivotRowsArePatchable(relation),
        ...serializedFlag(!relatedRowsArePatchable(related) || !this.pivotRowsArePatchable(relation)),
        predicates: Object.freeze([Object.freeze({
          column: relation.foreignPivotKey,
          operator: '=' as const,
          value: parentKey,
        })]),
        relation: relationObservation,
        resultPath: createPath(index, relationName),
        selections: [],
        table: pivotTable,
        tableName: pivotTableName,
      }))

      if (relatedMetadata.values.length === 0) {
        continue
      }

      recordDatabaseQueryObservation(Object.freeze({
        connectionName: related.getConnectionName(),
        dependencies: Object.freeze([
          createTableCacheDependency(related.getConnectionName(), related.definition.table.tableName),
          ...relatedMetadata.dependencies,
        ]),
        orderBy: [],
        patchable: relatedRowsArePatchable(related),
        ...serializedFlag(!relatedRowsArePatchable(related)),
        predicates: Object.freeze([Object.freeze({
          column: relation.relatedKey,
          operator: 'in' as const,
          value: relatedMetadata.values,
        })]),
        relation: relationObservation,
        resultPath: createPath(index, relationName),
        selections: [],
        table: related.definition.table,
        tableName: related.definition.table.tableName,
      }))
    }
  }

  private pivotRowsArePatchable(relation: PivotRelationDefinition): boolean {
    const connection = this.getConnection()
    if (readsSQLiteDecimals(connection, this.resolvePivotTable(relation.pivotTable, connection))) return false
    if (!relation.pivotModel) return true
    const pivot = this.resolveRelatedRepository(relation.pivotModel)
    return !modelNeedsSerialization(pivot.definition) && !readsSQLiteDecimals(connection, pivot.definition.table)
  }

  private createBelongsToManyRelatedObservationMetadata(
    entity: Entity<TTable>,
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'belongsToMany' }>,
    related: ModelRepository,
  ): BelongsToManyRelatedObservationMetadata {
    const loaded = entity.getRelation<readonly unknown[]>(relationName)
    const dependencies: string[] = []
    const values: unknown[] = []
    for (const relatedEntity of loaded) {
      if (!isEntity(relatedEntity)) {
        continue
      }

      const relatedValue = relatedEntity.get(relation.relatedKey as never)
      values.push(relatedValue)
      const dependency = createTablePredicateCacheDependency(
        related.getConnectionName(),
        related.definition.table.tableName,
        relation.relatedKey,
        relatedValue,
        this.textMatchesAnyNumber(related.getConnectionName()),
      )
      if (dependency) {
        dependencies.push(dependency)
      }
    }

    return Object.freeze({
      dependencies: Object.freeze(dependencies),
      values: Object.freeze(values),
    })
  }

  private createRelationAggregateObservation(
    aggregate: AggregateLoad,
    entity: Entity<TTable>,
    key: string,
  ): DatabaseQueryAggregateObservation | undefined {
    const metadata = this.getRelationAggregateObservationMetadata(entity, key)
    if (metadata) {
      return metadata
    }

    if (aggregate.kind === 'count' || aggregate.kind === 'exists') {
      return Object.freeze({
        kind: 'count',
      })
    }

    if (!aggregate.column) {
      return undefined
    }

    return Object.freeze({
      column: aggregate.column,
      kind: aggregate.kind,
    })
  }

  private setRelationAggregateObservationMetadata(
    entity: Entity<TTable>,
    key: string,
    metadata: DatabaseQueryAggregateObservation,
  ): void {
    const byKey = relationAggregateObservationMetadata.get(entity) ?? new Map<string, DatabaseQueryAggregateObservation>()
    byKey.set(key, metadata)
    relationAggregateObservationMetadata.set(entity, byKey)
  }

  private getRelationAggregateObservationMetadata(
    entity: Entity<TTable>,
    key: string,
  ): DatabaseQueryAggregateObservation | undefined {
    return relationAggregateObservationMetadata.get(entity)?.get(key)
  }

  private createRelationAggregateObservationTarget(
    entity: Entity<TTable>,
    relation: RelationDefinition,
  ): RelationAggregateObservationTarget | undefined {
    switch (relation.kind) {
      case 'belongsTo': {
        const related = this.resolveRelatedRepository(relation.related)
        return {
          column: relation.ownerKey,
          connectionName: related.getConnectionName(),
          primaryKey: resolveModelRowKey(related.definition),
          table: related.definition.table,
          tableName: related.definition.table.tableName,
          value: this.getRelationParentValue(entity, relation),
        }
      }
      case 'hasMany':
      case 'hasOne':
      case 'hasOneOfMany': {
        const related = this.resolveRelatedRepository(relation.related)
        return {
          column: relation.foreignKey,
          connectionName: related.getConnectionName(),
          primaryKey: resolveModelRowKey(related.definition),
          table: related.definition.table,
          tableName: related.definition.table.tableName,
          value: this.getRelationParentValue(entity, relation),
        }
      }
      default:
        return undefined
    }
  }

  async create(values: ModelInsertPayload<TTable>): Promise<Entity<TTable>> {
    await this.loadGuardableColumns()
    this.assertMassAssignable(applyPendingModelAttributes(this.definition, values))
    return this.createRecord(values)
  }

  async createQuietly(values: ModelInsertPayload<TTable>): Promise<Entity<TTable>> {
    return withoutModelEvents(() => this.create(values))
  }

  async createMany(
    values: readonly ModelInsertPayload<TTable>[],
  ): Promise<ModelCollection<TTable, RelationMap, Entity<TTable>, TScopes>> {
    const created: Entity<TTable>[] = []
    for (const value of values) {
      created.push(await this.create(value))
    }
    return this.createCollection(created)
  }

  async createManyQuietly(
    values: readonly ModelInsertPayload<TTable>[],
  ): Promise<ModelCollection<TTable, RelationMap, Entity<TTable>, TScopes>> {
    return withoutModelEvents(() => this.createMany(values))
  }

  async saveMany(
    entities: readonly Entity<TTable>[],
  ): Promise<ModelCollection<TTable, RelationMap, Entity<TTable>, TScopes>> {
    this.assertOwnedEntities(entities)
    const saved: Entity<TTable>[] = []
    for (const entity of entities) {
      saved.push(await entity.save())
    }
    return this.createCollection(saved)
  }

  async saveManyQuietly(
    entities: readonly Entity<TTable>[],
  ): Promise<ModelCollection<TTable, RelationMap, Entity<TTable>, TScopes>> {
    return withoutModelEvents(() => this.saveMany(entities))
  }

  async update(id: unknown, values: ModelUpdatePayload<TTable>): Promise<Entity<TTable>> {
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
    const configuredQuery = (this.definition.prunable(baseQuery) ?? baseQuery) as ModelQueryBuilder<TTable, RelationMap, unknown, TScopes>

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
          entity.forceFill({ [relation.foreignKey]: null } as never)
          entity.setRelation(relationName, null)
          return entity
        }

        const related = this.resolveCompatibleRelatedRepository(relation.related, relationName, relatedEntity)
        const ownerKey = relatedEntity.get(relation.ownerKey as never)
        if (ownerKey === null || typeof ownerKey === 'undefined') {
          throw new HydrationError(`Cannot associate relation "${relationName}" with an unsaved ${related.definition.name}.`)
        }

        entity.forceFill({ [relation.foreignKey]: ownerKey } as never)
        entity.setRelation(relationName, relatedEntity)
        return entity
      }
      case 'morphTo': {
        if (relatedEntity === null) {
          entity.forceFill({ [relation.morphTypeColumn]: null, [relation.morphIdColumn]: null } as never)
          entity.setRelation(relationName, null)
          return entity
        }

        const relatedRepository = relatedEntity.getRepository() as ModelRepository
        const relatedKey = relatedEntity.get(relatedRepository.definition.primaryKey as never)
        if (relatedKey === null || typeof relatedKey === 'undefined') {
          throw new HydrationError(`Cannot associate relation "${relationName}" with an unsaved ${relatedRepository.definition.name}.`)
        }

        entity.forceFill({
          [relation.morphTypeColumn]: relatedRepository.definition.morphClass,
          [relation.morphIdColumn]: relatedKey,
        } as never)
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
        entity.syncPersisted(await this.saveEntity(entity))
        return savedRelated
      }
      case 'morphTo': {
        const related = relatedEntity.getRepository() as ModelRepository
        const savedRelated = await related.saveEntity(relatedEntity)
        this.associateRelation(entity, relationName, savedRelated)
        entity.syncPersisted(await this.saveEntity(entity))
        return savedRelated
      }
      case 'hasMany':
      case 'hasOne':
      case 'hasOneOfMany': {
        this.assertPersistedParentForRelation(entity, relationName)
        const parentKey = entity.get(relation.localKey as never)
        const related = this.resolveCompatibleRelatedRepository(relation.related, relationName, relatedEntity)
        relatedEntity.forceFill({ [relation.foreignKey]: parentKey } as never)
        const savedRelated = await related.saveEntity(relatedEntity)
        this.syncRelationAfterPersistence(entity, relationName, relation, savedRelated)
        return savedRelated
      }
      case 'morphOne':
      case 'morphMany':
      case 'morphOneOfMany': {
        this.assertPersistedParentForRelation(entity, relationName)
        const parentKey = entity.get(relation.localKey as never)
        const related = this.resolveCompatibleRelatedRepository(relation.related, relationName, relatedEntity)
        relatedEntity.forceFill({
          [relation.morphTypeColumn]: this.getMorphTypeValue(),
          [relation.morphIdColumn]: parentKey,
        } as never)
        const savedRelated = await related.saveEntity(relatedEntity)
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
        const created = await related.create(values as Partial<ModelRecord<typeof related.definition.table>>)
        this.associateRelation(entity, relationName, created)
        entity.syncPersisted(await this.saveEntity(entity))
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
        const created = await related.createRecord({
          ...related.assertMassAssignable(applyPendingModelAttributes(related.definition, values as Partial<ModelRecord<typeof related.definition.table>>)),
          [relation.foreignKey]: parentKey,
        } as Partial<ModelRecord<typeof related.definition.table>>)
        this.syncRelationAfterPersistence(entity, relationName, relation, created)
        return created
      }
      case 'morphOne':
      case 'morphMany':
      case 'morphOneOfMany': {
        this.assertPersistedParentForRelation(entity, relationName)
        const parentKey = entity.get(relation.localKey as never)
        const related = this.resolveRelatedRepository(relation.related)
        const created = await related.createRecord({
          ...related.assertMassAssignable(applyPendingModelAttributes(related.definition, values as Partial<ModelRecord<typeof related.definition.table>>)),
          [relation.morphTypeColumn]: this.getMorphTypeValue(),
          [relation.morphIdColumn]: parentKey,
        } as Partial<ModelRecord<typeof related.definition.table>>)
        this.syncRelationAfterPersistence(entity, relationName, relation, created)
        return created
      }
      case 'belongsToMany':
      case 'morphToMany':
      case 'morphedByMany': {
        this.assertPersistedParentForRelation(entity, relationName)
        const related = this.resolveRelatedRepository(relation.related)
        const created = await related.create(values as Partial<ModelRecord<typeof related.definition.table>>)
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

  private async createRecord(values: ModelInsertPayload<TTable>): Promise<Entity<TTable>> {
    return this.insertEntity(new Entity(this, values, false))
  }

  private async insertEntity(entity: Entity<TTable>): Promise<Entity<TTable>> {
    return this.writeUnit(entity, async marks => {
      entity.forceFill(applyGeneratedUniqueIds(this.definition, applyPendingModelAttributes(this.definition, entity.toAttributes())))
      this.applyWriteMutators(entity, Object.keys(entity.toAttributes()))
      await this.dispatchCancelableEvent('saving', entity)
      await this.dispatchCancelableEvent('creating', entity)
      const beforeTimestamps = snapshotAttributes(entity.toAttributes())
      entity.forceFill(this.applyTimestampDefaults(entity.toAttributes(), 'create'))
      this.applyWriteMutators(entity, this.changedKeysSince(entity, beforeTimestamps))
      await this.assertGuardableAttributes(entity.toAttributes())
      const payload = this.sanitizeStoredValues(entity.toAttributes(), 'create')
      const hasPrimaryKeyValue = Object.prototype.hasOwnProperty.call(payload, this.definition.primaryKey)
      const query = this.query().getTableQueryBuilder()
      const result = hasPrimaryKeyValue
        ? await query.insert(payload)
        : { lastInsertId: await insertGetIdByKey(query, payload, this.definition.primaryKey) }
      const attributes = {
        ...payload,
        ...(!hasPrimaryKeyValue && typeof result.lastInsertId !== 'undefined'
          ? { [this.definition.primaryKey]: result.lastInsertId }
          : {}),
      } as Partial<ModelRecord<TTable>>
      marks.sqlCompleted()
      this.applyStoredValues(entity, attributes, {}, marks)
      await this.dispatchEvent('created', entity)
      await this.dispatchEvent('saved', entity)
      await this.touchOwners(entity)
      entity.finishSave()
      return entity
    })
  }

  async restore(id: unknown): Promise<Entity<TTable>> {
    await this.resolveTableIdentity()
    const primaryKey = this.definition.primaryKey
    const existing = await this.query().withTrashed().find(id, primaryKey)
    if (!existing) {
      throw new HydrationError(`${this.definition.name} record not found for key "${String(id)}".`)
    }

    return existing.restore()
  }

  async forceDelete(id: unknown): Promise<void> {
    await this.resolveTableIdentity()
    const primaryKey = this.definition.primaryKey
    const existing = await this.query().withTrashed().find(id, primaryKey)
    if (!existing) {
      throw new HydrationError(`${this.definition.name} record not found for key "${String(id)}".`)
    }

    await this.forceDeleteEntity(existing)
  }

  async upsert(
    match: Partial<ModelRecord<TTable>>,
    values: ModelUpdatePayload<TTable> = {},
  ): Promise<Entity<TTable>> {
    const query = this.queryMatching(match)

    const existing = await query.first()
    if (existing) {
      existing.fill(values)
      return existing.save()
    }

    return this.create({ ...match, ...values })
  }

  async updateOrCreate(
    match: Partial<ModelRecord<TTable>>,
    values: ModelUpdatePayload<TTable> = {},
  ): Promise<Entity<TTable>> {
    return this.upsert(match, values)
  }

  withWriteTimestamps(
    payload: Readonly<Record<string, unknown>>,
    mode: WriteMode,
    timestamp = this.valueTransformer.freshTimestamp(),
  ): Record<string, unknown> {
    const { createdAtColumn, updatedAtColumn } = this.definition
    const timestamped: Record<string, unknown> = { ...payload }
    if (mode === 'create' && createdAtColumn && !(createdAtColumn in payload)) {
      this.assertConfiguredColumnWritable(createdAtColumn)
      timestamped[createdAtColumn] = this.normalizeForStorage(createdAtColumn, timestamp)
    }

    if (updatedAtColumn && !(updatedAtColumn in payload)) {
      this.assertConfiguredColumnWritable(updatedAtColumn)
      timestamped[updatedAtColumn] = this.normalizeForStorage(updatedAtColumn, timestamp)
    }

    return timestamped
  }

  softDeleteWrite(deletedAtColumn: string, deletedAt = this.valueTransformer.freshTimestamp()): Record<string, unknown> {
    this.assertConfiguredColumnWritable(deletedAtColumn)
    return this.withWriteTimestamps({ [deletedAtColumn]: this.castForStorage(deletedAtColumn, deletedAt) }, 'update', deletedAt)
  }

  private assertConfiguredColumnWritable(columnName: string): void {
    assertColumnWritable(columnName, ownEntry(this.definition.table.columns, columnName), 'computed')
  }

  assertWriteTargets(columns: readonly string[]): void {
    for (const column of columns) {
      findWriteColumn(this.definition, column, 'computed')
    }
  }

  sanitizeWritePayload(
    values: Partial<ModelRecord<TTable>> | Record<string, unknown>,
    mode: WriteMode,
  ): ModelUpdatePayload<TTable> {
    return this.sanitizeWriteValues(values, mode, { massAssignment: true, mutate: true, rejected: 'generated' }) as ModelUpdatePayload<TTable>
  }

  sanitizeUpsertRow(values: Partial<ModelRecord<TTable>> | Record<string, unknown>, acceptsPrimaryKey: boolean): ModelUpdatePayload<TTable> {
    return this.sanitizeWriteValues(values, 'create', { massAssignment: true, mutate: true, rejected: 'computed', unguarded: acceptsPrimaryKey ? [this.definition.primaryKey] : [] }) as ModelUpdatePayload<TTable>
  }

  assertUpsertUpdateColumns(columns: readonly string[]): void {
    for (const column of columns) {
      const { columnName } = findWriteColumn(this.definition, column, 'computed')
      if (columnName !== this.definition.updatedAtColumn) {
        this.assertWritableColumn(columnName, column)
      }
    }
  }

  private sanitizeStoredValues(values: Partial<ModelRecord<TTable>> | Record<string, unknown>, mode: WriteMode): Partial<ModelRecord<TTable>> {
    return this.sanitizeWriteValues(values, mode, { massAssignment: false, mutate: false, rejected: 'generated' }) as Partial<ModelRecord<TTable>>
  }

  private sanitizeWriteValues(
    values: Partial<ModelRecord<TTable>> | Record<string, unknown>,
    mode: WriteMode,
    rules: { readonly massAssignment: boolean, readonly mutate: boolean, readonly rejected: RejectedGeneratedColumns, readonly unguarded?: readonly string[] },
  ): Record<string, unknown> {
    const entries = Object.entries(values)

    if (entries.length === 0) {
      return {}
    }

    return Object.fromEntries(entries.map(([key, value]) => {
      const { columnName, column } = findWriteColumn(this.definition, key, rules.rejected)

      if (typeof value === 'undefined') {
        throw new SecurityError(`${mode === 'create' ? 'Create' : 'Update'} value for column "${key}" cannot be undefined.`)
      }

      if (rules.massAssignment && !rules.unguarded?.includes(columnName)) {
        this.assertWritableColumn(columnName, key)
      }

      if (key.includes('->')) {
        if (column && !storesJson(this.getConnection().getDriver() as SchemaDialectName, column)) {
          throw new SecurityError(`Column "${columnName}" must be a JSON column to support nested JSON updates.`)
        }

        return [key, value]
      }

      return [columnName, rules.mutate ? this.normalizeForStorage(columnName, value) : this.castForStorage(columnName, value)]
    }))
  }

  async saveEntity(entity: Entity<TTable>): Promise<Entity<TTable>> {
    if (!entity.exists()) {
      return this.insertEntity(entity)
    }

    return this.writeUnit(entity, async marks => {
      const primaryKey = this.definition.primaryKey
      const id = getEntityKeyForSave(entity, primaryKey)
      if (typeof id === 'undefined' || id === null) {
        throw new HydrationError(`Cannot persist ${this.definition.name} without a primary key value.`)
      }

      this.applyWriteMutators(entity, Object.keys(entity.getDirty()))
      await this.dispatchCancelableEvent('saving', entity)
      if (Object.keys(entity.getDirty()).length === 0) {
        return this.finishUnchangedSave(entity)
      }

      await this.dispatchCancelableEvent('updating', entity)
      const beforeTimestamps = snapshotAttributes(entity.toAttributes())
      entity.forceFill(this.applyTimestampDefaults(entity.getDirty() as Partial<ModelRecord<TTable>>, 'update'))
      this.applyWriteMutators(entity, this.changedKeysSince(entity, beforeTimestamps))
      const written = entity.getDirty()
      await this.assertGuardableAttributes(written)
      const dirty = this.sanitizeStoredValues(written, 'update')
      if (Object.keys(dirty).length === 0) {
        return this.finishUnchangedSave(entity)
      }

      await this.writeQuery().where(primaryKey, id).getTableQueryBuilder().update(dirty)
      marks.sqlCompleted()
      this.applyStoredValues(entity, dirty, written, marks)
      await this.dispatchEvent('updated', entity)
      await this.dispatchEvent('saved', entity)
      await this.touchOwners(entity)
      entity.finishSave()
      return entity
    })
  }

  private writeQuery(): ModelQueryBuilder<TTable, RelationMap, unknown, TScopes> {
    return this.createQuery(false, true, false)
  }

  private async writeUnit<TResult>(
    entity: Entity<TTable>,
    write: (marks: WriteMarks) => Promise<TResult>,
  ): Promise<TResult> {
    const ownsTransaction = this.getConnection().getScope().kind === 'root'
    const state = captureEntityWriteState(entity)
    const dirtyKeys = Object.keys(entity.getDirty())
    return this.runWriteUnit(async () => {
      let written = false
      const restoreForWrite = () => commitFailureRestoreFor(this.getConnection(), entity, () => createEntityCommitRestore(entity, state))
      try {
        return await write({
          sqlCompleted: () => {
            written = true
            restoreForWrite().recordWrite(state, dirtyKeys)
          },
          normalized: () => restoreForWrite().recordWritten(),
        })
      } catch (error) {
        if (ownsTransaction || !written) {
          restoreEntityWriteState(entity, state)
        }
        throw error
      }
    })
  }

  private applyStoredValues(
    entity: Entity<TTable>,
    stored: Partial<ModelRecord<TTable>>,
    changes: Record<string, unknown>,
    marks: WriteMarks | undefined,
  ): void {
    entity.recordChanges(changes)
    try {
      entity.forceFill(this.normalizeFromStorage(stored))
    } catch (error) {
      entity.forceFill(stored)
      entity.finishSave()
      marks?.normalized()
      throw error
    }
    marks?.normalized()
  }

  private async finishUnchangedSave(entity: Entity<TTable>): Promise<Entity<TTable>> {
    entity.recordChanges({})
    await this.dispatchEvent('saved', entity)
    entity.finishSave()
    return entity
  }

  async saveEntityQuietly(entity: Entity<TTable>): Promise<Entity<TTable>> {
    return withoutModelEvents(() => this.saveEntity(entity))
  }

  async deleteEntity(entity: Entity<TTable>): Promise<void> {
    await this.runWriteUnit(async () => {
      const primaryKey = this.definition.primaryKey
      const id = getEntityKeyForSave(entity, primaryKey)
      if (typeof id === 'undefined' || id === null) {
        throw new HydrationError(`Cannot delete ${this.definition.name} without a primary key value.`)
      }

      await this.dispatchCancelableEvent('deleting', entity)
      const deletedAtColumn = this.getDeletedAtColumn()
      if (deletedAtColumn) {
        const deletedAt = this.valueTransformer.freshTimestamp()
        const written = this.softDeleteWrite(deletedAtColumn, deletedAt)
        await this.query().withTrashed().getTableQueryBuilder().where(primaryKey as never, id).update(written)
        entity.forceFill(this.normalizeFromStorage(written as Partial<ModelRecord<TTable>>))
        entity.syncOriginalAttributes(Object.keys(written))
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
    return this.writeUnit(entity, async marks => {
      const deletedAtColumn = this.getDeletedAtColumn()
      if (!deletedAtColumn) {
        throw new HydrationError(`${this.definition.name} does not support soft deletes.`)
      }

      const primaryKey = this.definition.primaryKey
      const id = getEntityKeyForSave(entity, primaryKey)
      if (typeof id === 'undefined' || id === null) {
        throw new HydrationError(`Cannot restore ${this.definition.name} without a primary key value.`)
      }

      await this.dispatchCancelableEvent('restoring', entity)
      entity.forceFill({ [deletedAtColumn]: null } as never)
      entity.forceFill(this.applyTimestampDefaults(entity.getDirty() as Partial<ModelRecord<TTable>>, 'update'))
      this.applyWriteMutators(entity, Object.keys(entity.getDirty()))
      const written = entity.getDirty()
      const dirty = this.sanitizeStoredValues(written, 'update')
      const wrote = Object.keys(dirty).length > 0
      if (wrote) {
        await this.query().withTrashed().getTableQueryBuilder().where(primaryKey as never, id).update(dirty)
        marks.sqlCompleted()
      }

      this.applyStoredValues(entity, dirty, written, wrote ? marks : undefined)
      entity.finishSave()
      await this.dispatchEvent('restored', entity)
      await this.touchOwners(entity)
      return entity
    })
  }

  async restoreEntityQuietly(entity: Entity<TTable>): Promise<Entity<TTable>> {
    return withoutModelEvents(() => this.restoreEntity(entity))
  }

  async forceDeleteEntity(entity: Entity<TTable>): Promise<void> {
    await this.runWriteUnit(async () => {
      const primaryKey = this.definition.primaryKey
      const id = getEntityKeyForSave(entity, primaryKey)
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
    assertQueryTablePath(this.definition.table.tableName)
    const connection = this.getConnection()
    if (connection.getScope().kind !== 'root') {
      return callback()
    }

    return connection.transaction(async () => callback())
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

  async attachRelation(entity: Entity<TTable>, relationName: string, ids: unknown, attributes: PivotAttributes = {}): Promise<void> {
    await this.createPivotMutation(entity, relationName).attach(ids, attributes)
  }

  async detachRelation(entity: Entity<TTable>, relationName: string, ids?: unknown): Promise<number> {
    return this.createPivotMutation(entity, relationName).detach(ids)
  }

  async syncRelation(entity: Entity<TTable>, relationName: string, ids: unknown, detachMissing: boolean): Promise<PivotSyncResult> {
    return this.createPivotMutation(entity, relationName).sync(ids, detachMissing)
  }

  async updateExistingPivot(entity: Entity<TTable>, relationName: string, id: unknown, attributes: PivotAttributes): Promise<number> {
    return this.createPivotMutation(entity, relationName).update(id, attributes)
  }

  async toggleRelation(entity: Entity<TTable>, relationName: string, ids: unknown): Promise<PivotToggleResult> {
    return this.createPivotMutation(entity, relationName).toggle(ids)
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
        await this.loadRequiringQueryRefresh(() => this.loadMorphToRelation(entities, relationName, relation, constraint))
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
        await this.loadRequiringQueryRefresh(() => this.loadMorphOneRelation(entities, relationName, relation, constraint))
        return
      case 'morphMany':
        await this.loadRequiringQueryRefresh(() => this.loadMorphManyRelation(entities, relationName, relation, constraint))
        return
      case 'morphOneOfMany':
        await this.loadRequiringQueryRefresh(() => this.loadMorphOneOfManyRelation(entities, relationName, relation, constraint))
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
        await this.loadRequiringQueryRefresh(() => this.loadMorphToManyRelation(entities, relationName, relation, constraint))
        return
      case 'morphedByMany':
        await this.loadRequiringQueryRefresh(() => this.loadMorphedByManyRelation(entities, relationName, relation, constraint))
        return
    }
  }

  private async loadRequiringQueryRefresh(load: () => Promise<void>): Promise<void> {
    await runRequiringDatabaseQueryRefresh(load)
  }

  private async loadRequiringQueryRefreshWhen<TValue>(required: boolean, load: () => Promise<TValue>): Promise<TValue> {
    return required ? await runRequiringDatabaseQueryRefresh(load) : await load()
  }

  createTableQuery(connection: DatabaseContext = this.getConnection()): TableQueryBuilder<TTable> {
    const table = this.definition.table
    const source = createTableSource(this.definition.untyped ? table.tableName : table)
    const primaryKey = resolveModelRowKey(this.definition)
    return new TableQueryBuilder(table, connection, createSelectQueryPlan(primaryKey === undefined ? source : Object.freeze({ ...source, primaryKey })))
  }

  private createQuery(
    applySoftDeletes: boolean,
    applyGlobalScopes: boolean,
    applyDefaultRelations: boolean,
    excludedGlobalScopes: ReadonlySet<string> = new Set(),
  ): ModelQueryBuilder<TTable, RelationMap, unknown, TScopes> {
    let query = new ModelQueryBuilder(this, this.createTableQuery())

    const deletedAtColumn = this.getDeletedAtColumn()
    if (applySoftDeletes && deletedAtColumn) {
      query = query.withoutTrashed()
    }

    if (applyGlobalScopes) {
      for (const [name, scope] of Object.entries(this.definition.globalScopes)) {
        if (excludedGlobalScopes.has(name)) {
          continue
        }
        query = query.applyGlobalScope(scope)
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
        collected.push(...loaded.filter(isEntity))
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
    const foreignKeys = collectRelationKeys(entities, relation.foreignKey)

    if (foreignKeys.length === 0) {
      for (const entity of entities) {
        entity.setRelation(relationName, null)
      }
      return
    }

    const related = this.resolveRelatedRepository(relation.related)
    const { entities: relatedEntities, plan: constrainedPlan, rowsPatchable } = await retrieveRelation(
      foreignKeys,
      () => this.applyRelationConstraint(relation, related, constraint),
      relation.ownerKey,
      true,
      ownEntry(related.definition.table.columns, relation.ownerKey),
    )
    const relatedMap = indexRelation(relatedEntities, relation.ownerKey, this.keyOptionsFor(related, relation.foreignKey, relation.ownerKey))

    for (const entity of entities) {
      const foreignKey = entity.toAttributes()[relation.foreignKey as keyof ReturnType<typeof entity.toAttributes>]
      entity.setRelation(relationName, relatedMap.get(foreignKey) ?? null)
      if (constrainedPlan) {
        this.rememberBelongsToRelationObservation(entity, relationName, relation, related, constrainedPlan, foreignKey, rowsPatchable !== false)
      }
    }
  }

  private async loadHasManyRelation(
    entities: readonly Entity<TTable>[],
    relationName: string,
    relation: Extract<RelationDefinition, { kind: 'hasMany' }>,
    constraint?: RelationConstraint,
  ): Promise<void> {
    const localKeys = collectRelationKeys(entities, relation.localKey)

    if (localKeys.length === 0) {
      for (const entity of entities) {
        entity.setRelation(relationName, [])
      }
      return
    }

    const related = this.resolveRelatedRepository(relation.related)
    const { entities: relatedEntities, plan: constrainedPlan, rowsPatchable } = await retrieveRelation(
      localKeys,
      () => this.applyRelationConstraint(relation, related, constraint),
      relation.foreignKey,
      true,
      ownEntry(related.definition.table.columns, relation.foreignKey),
    )
    const grouped = groupRelation(relatedEntities, relation.foreignKey, this.keyOptionsFor(related, relation.localKey, relation.foreignKey))

    for (const entity of entities) {
      const localKey = entity.toAttributes()[relation.localKey as keyof ReturnType<typeof entity.toAttributes>]
      entity.setRelation(relationName, grouped.get(localKey) ?? [])
      if (constrainedPlan) {
        this.rememberHasManyRelationObservation(entity, relationName, relation, related, constrainedPlan, localKey, rowsPatchable !== false)
      }
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
    const constrained = Boolean(constraint || relation.constraint)
    const observationCount = !constrained && hasActiveDatabaseDependencyCollector() ? readDatabaseQueryObservationCount() : undefined
    const { rows, related, options } = constrained
      ? await runRequiringDatabaseQueryRefresh(() => this.retrievePivotRows(entities, relation, constraint))
      : await this.retrievePivotRows(entities, relation, constraint)
    if (typeof observationCount === 'number') truncateDatabaseQueryObservations(observationCount)
    const grouped = this.groupPivotRows(rows, related, relation, options)
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

  resolveRelationHydrationQuery(
    relation: Extract<RelationDefinition, { kind: 'belongsTo' | 'hasMany' | 'hasOne' }>,
    constraint?: RelationConstraint,
  ): { readonly observation: DatabaseQueryObservation, readonly rowsPatchable: boolean } | undefined {
    const related = this.resolveRelatedRepository(relation.related)
    const query = this.applyRelationConstraint(relation, related, constraint)
    const plan = query.getTableQueryBuilder().getPlan()
    if (hasTypedComparison(plan.predicates)) {
      return undefined
    }

    const observation = createDatabaseQueryObservation(plan, related.getConnectionName(), [])
    if (!observation?.patchable || typeof observation.limit !== 'undefined' || typeof observation.offset !== 'undefined') {
      return undefined
    }

    return Object.freeze({
      observation,
      rowsPatchable: relatedRowsArePatchable(related) && query.canPatchLoadedRows() && observation.selections.length === 0,
    })
  }

  resolveBelongsToOwnerPredicates(
    relation: Extract<RelationDefinition, { kind: 'belongsTo' }>,
    constraint?: RelationConstraint,
  ): readonly DatabaseQueryPredicateObservation[] | undefined {
    const resolved = this.resolveRelationHydrationQuery(relation, constraint)
    return resolved?.rowsPatchable ? resolved.observation.predicates : undefined
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
  ): Promise<StoredKeySet> {
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
  ): Promise<StoredKeyMap<number>> {
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
    const constrained = relationResult instanceof ModelQueryBuilder ? relationResult as ModelQueryBuilder : query

    if (!constraint) {
      return constrained
    }

    const result = constraint(constrained)
    return result instanceof ModelQueryBuilder ? result as ModelQueryBuilder : constrained
  }

  private buildRelationExistenceSubqueries(
    relation: RelationDefinition,
    constraint?: RelationConstraint,
    morphTypes?: readonly string[],
  ): readonly TableQueryBuilder<TableDefinition, Record<string, unknown>>[] {
    switch (relation.kind) {
      case 'belongsTo': {
        const related = this.resolveRelatedRepository(relation.related)
        return [this.whereParentKey(this.applyRelationConstraint(relation, related, constraint).getTableQueryBuilder(), related.definition.table, relation.ownerKey, relation.foreignKey)]
      }
      case 'hasMany':
      case 'hasOne':
      case 'hasOneOfMany': {
        const related = this.resolveRelatedRepository(relation.related)
        return [this.whereParentKey(this.applyRelationConstraint(relation, related, constraint).getTableQueryBuilder(), related.definition.table, relation.foreignKey, relation.localKey)]
      }
      case 'morphOne':
      case 'morphMany':
      case 'morphOneOfMany': {
        const related = this.resolveRelatedRepository(relation.related)
        return [this.whereParentKey(
          this.applyRelationConstraint(relation, related, constraint).getTableQueryBuilder().where(relation.morphTypeColumn, this.getMorphTypeValue()),
          related.definition.table,
          relation.morphIdColumn,
          relation.localKey,
        )]
      }
      case 'morphTo': {
        const references = this.resolveMorphExistenceReferences(morphTypes)
        return references.map((reference) => {
          const related = ModelRepository.from(reference)
          return this.whereParentKey(
            this.applyRelationConstraint(relation, related, constraint)
              .getTableQueryBuilder()
              .where(this.qualifyParentColumn(relation.morphTypeColumn), related.definition.morphClass),
            related.definition.table,
            related.definition.primaryKey,
            relation.morphIdColumn,
          )
        })
      }
      case 'hasOneThrough':
      case 'hasManyThrough': {
        const through = this.resolveThroughRepository(relation.through)
        const related = this.resolveRelatedRepository(relation.related)
        const throughTable = through.definition.table.tableName
        const relatedTable = related.definition.table.tableName
        const throughColumns = through.definition.table.columns
        const joined = joinOnKeyColumns(
          this.applyRelationConstraint(relation, related, constraint).getTableQueryBuilder(),
          throughTable,
          `${throughTable}.${relation.secondLocalKey}`,
          `${relatedTable}.${relation.secondKey}`,
          { left: sourceKeyCast(ownEntry(throughColumns, relation.secondLocalKey), ownEntry(related.definition.table.columns, relation.secondKey)) },
        )

        return [this.whereParentKey(joined, through.definition.table, relation.firstKey, relation.localKey, `${throughTable}.${relation.firstKey}`)]
      }
      case 'belongsToMany': {
        const related = this.resolveRelatedRepository(relation.related)
        const pivot = this.createBelongsToManyPivotQuery(relation, this.getConnection())
        return [this.whereHasPivot(relation, related, constraint, pivot, relation.foreignPivotKey, relation.relatedPivotKey)]
      }
      case 'morphToMany': {
        const related = this.resolveRelatedRepository(relation.related)
        const pivot = this.createMorphToManyPivotQuery(relation, this.getConnection()).where(relation.morphTypeColumn, this.getMorphTypeValue())
        return [this.whereHasPivot(relation, related, constraint, pivot, relation.morphIdColumn, relation.foreignPivotKey)]
      }
      case 'morphedByMany': {
        const related = this.resolveRelatedRepository(relation.related)
        const pivot = this.createMorphedByManyPivotQuery(relation, related.definition.morphClass, this.getConnection())
        return [this.whereHasPivot(relation, related, constraint, pivot, relation.foreignPivotKey, relation.morphIdColumn)]
      }
    }
  }

  private whereParentKey<TQuery extends TableQueryBuilder<string | TableDefinition, Record<string, unknown>>>(
    query: TQuery,
    table: TableDefinition | undefined,
    column: string,
    parentColumn: string,
    reference = column,
  ): TQuery {
    const cast = sourceKeyCast(ownEntry(this.definition.table.columns, parentColumn), table ? ownEntry(table.columns, column) : undefined)
    return whereKeyColumn(query, reference, this.qualifyParentColumn(parentColumn), { right: cast })
  }

  private whereHasPivot(
    relation: PivotRelationDefinition,
    related: ModelRepository,
    constraint: RelationConstraint | undefined,
    pivot: TableQueryBuilder<string | TableDefinition>,
    parentPivotColumn: string,
    relatedPivotColumn: string,
  ): TableQueryBuilder<TableDefinition, Record<string, unknown>> {
    const connection = this.getConnection()
    const resolved = this.resolvePivotTable(relation.pivotTable, connection)
    const pivotTable = typeof resolved === 'string' ? getLoadedTableDefinition(connection, resolved) ?? resolved : resolved
    const relatedTable = related.definition.table
    const parentKeyed = whereKeyColumn(pivot, parentPivotColumn, this.qualifyParentColumn(relation.parentKey), pivotKeyCasts(pivotTable, parentPivotColumn, ownEntry(this.definition.table.columns, relation.parentKey), 'other'))
    const pivotKeys = selectKeyColumn(parentKeyed, relatedPivotColumn, pivotKeyCasts(pivotTable, relatedPivotColumn, ownEntry(relatedTable.columns, relation.relatedKey), 'pivot'))

    const relatedQuery = this.applyRelationConstraint(relation, related, constraint).getTableQueryBuilder()
    const source = relatedQuery.getPlan().source
    return relatedQuery.whereInSub(`${source.alias ?? source.tableName}.${relation.relatedKey}`, pivotKeys)
  }

  private resolveMorphExistenceReferences(
    selectors?: readonly string[],
  ): readonly ModelDefinitionLike[] {
    const references = listMorphModels()
    if (!selectors) {
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

  private keyOptionsFor(related: ModelRepository, parentColumn: string, relatedColumn: string): StoredKeyOptions {
    return relationKeyOptions(ownEntry(this.definition.table.columns, parentColumn), ownEntry(related.definition.table.columns, relatedColumn))
  }

  private pivotKeyOptions(relation: PivotRelationDefinition, pivotParentKey: AnyColumnDefinition | undefined): StoredKeyOptions {
    return relationKeyOptions(ownEntry(this.definition.table.columns, relation.parentKey), pivotParentKey)
  }

  private async loadPivotKeyColumns(relation: PivotRelationDefinition): Promise<PivotKeyColumns> {
    const connection = this.getConnection()
    const resolved = this.resolvePivotTable(relation.pivotTable, connection)
    const table = typeof resolved === 'string' ? await loadTableDefinition(connection, resolved) : resolved
    return {
      parentKey: table ? ownEntry(table.columns, this.pivotParentColumn(relation)) : undefined,
      relatedKey: table ? ownEntry(table.columns, this.pivotRelatedColumn(relation)) : undefined,
      introspected: typeof resolved === 'string',
    }
  }

  private pivotParentColumn(relation: PivotRelationDefinition): string {
    return relation.kind === 'morphToMany' ? relation.morphIdColumn : relation.foreignPivotKey
  }

  private pivotRelatedColumn(relation: PivotRelationDefinition): string {
    return relation.kind === 'belongsToMany' ? relation.relatedPivotKey : relation.kind === 'morphToMany' ? relation.foreignPivotKey : relation.morphIdColumn
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

  private async getRelationAggregateValues(
    entities: readonly Entity<TTable>[],
    relation: RelationDefinition,
    aggregate: AggregateLoad,
  ): Promise<StoredKeyMap<RelationAggregateComputation>> {
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
    if (!related.definition.untyped && !(column in related.definition.table.columns)) {
      throw new SecurityError(`Column "${column}" is not defined on related model "${related.definition.name}".`)
    }

    const grouped = await this.getRelatedEntitiesByParentKey(entities, relation, aggregate.constraint)
    const values = new StoredKeyMap<RelationAggregateComputation>()

    for (const entity of entities) {
      const parentKey = this.getRelationParentValue(entity, relation)
      const relatedEntities = grouped.get(parentKey) ?? []
      values.set(parentKey, this.relationAggregateCalculator.computeValue(aggregate.kind, relatedEntities, column))
    }

    return values
  }

  private async getRelatedEntitiesByParentKey(
    entities: readonly Entity<TTable>[],
    relation: Exclude<RelationDefinition, { kind: 'morphTo' }>,
    constraint?: RelationConstraint,
  ): Promise<StoredKeyMap<Entity[]>> {
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
  ): Promise<StoredKeySet> {
    const foreignKeys = collectRelationKeys(entities, relation.foreignKey)

    if (foreignKeys.length === 0) {
      return new StoredKeySet()
    }

    const related = this.resolveRelatedRepository(relation.related)
    const { entities: relatedEntities } = await retrieveRelation(
      foreignKeys,
      () => this.applyRelationConstraint(relation, related, constraint),
      relation.ownerKey,
      false,
      ownEntry(related.definition.table.columns, relation.ownerKey),
    )

    return new StoredKeySet(relatedEntities.map(entity => entity.get(relation.ownerKey as never)), this.keyOptionsFor(related, relation.foreignKey, relation.ownerKey))
  }

  private async getBelongsToMatchCounts(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'belongsTo' }>,
    constraint?: RelationConstraint,
  ): Promise<StoredKeyMap<number>> {
    const foreignKeys = collectRelationKeys(entities, relation.foreignKey)

    if (foreignKeys.length === 0) {
      return new StoredKeyMap()
    }

    const related = this.resolveRelatedRepository(relation.related)
    const { entities: relatedEntities } = await retrieveRelation(
      foreignKeys,
      () => this.applyRelationConstraint(relation, related, constraint),
      relation.ownerKey,
      false,
      ownEntry(related.definition.table.columns, relation.ownerKey),
    )
    const matching = new StoredKeySet(relatedEntities.map(entity => entity.get(relation.ownerKey as never)), this.keyOptionsFor(related, relation.foreignKey, relation.ownerKey))
    const counts = new StoredKeyMap<number>()

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
  ): Promise<StoredKeyMap<Entity[]>> {
    const foreignKeys = collectRelationKeys(entities, relation.foreignKey)

    if (foreignKeys.length === 0) {
      return new StoredKeyMap()
    }

    const related = this.resolveRelatedRepository(relation.related)
    const { entities: relatedEntities } = await retrieveRelation(
      foreignKeys,
      () => this.applyRelationConstraint(relation, related, constraint),
      relation.ownerKey,
      false,
      ownEntry(related.definition.table.columns, relation.ownerKey),
    )
    const relatedMap = indexRelation(relatedEntities, relation.ownerKey, this.keyOptionsFor(related, relation.foreignKey, relation.ownerKey))
    const grouped = new StoredKeyMap<Entity[]>()

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
  ): Promise<StoredKeySet> {
    const grouped = await this.getHasManyEntitiesByParentKey(entities, relation, constraint)
    return new StoredKeySet([...grouped.entries()].filter(([, related]) => related.length > 0).map(([key]) => key), grouped.options)
  }

  private async getMatchingMorphManyParentKeys(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphOne' | 'morphMany' | 'morphOneOfMany' }>,
    constraint?: RelationConstraint,
  ): Promise<StoredKeySet> {
    const grouped = await this.getMorphManyEntitiesByParentKey(entities, relation, constraint)
    return new StoredKeySet([...grouped.entries()].filter(([, related]) => related.length > 0).map(([key]) => key), grouped.options)
  }

  private async getHasManyMatchCounts(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'hasMany' | 'hasOne' | 'hasOneOfMany' }>,
    constraint?: RelationConstraint,
  ): Promise<StoredKeyMap<number>> {
    const grouped = await this.getHasManyEntitiesByParentKey(entities, relation, constraint)
    const counts = new StoredKeyMap<number>([], grouped.options)

    for (const [key, related] of grouped.entries()) {
      counts.set(key, related.length)
    }

    return counts
  }

  private async getMorphManyMatchCounts(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphOne' | 'morphMany' | 'morphOneOfMany' }>,
    constraint?: RelationConstraint,
  ): Promise<StoredKeyMap<number>> {
    const grouped = await this.getMorphManyEntitiesByParentKey(entities, relation, constraint)
    const counts = new StoredKeyMap<number>([], grouped.options)

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
  ): Promise<StoredKeySet> {
    const grouped = await this.getMorphToEntitiesByParentKey(entities, relation, constraint, morphTypes)
    return new StoredKeySet([...grouped.entries()].filter(([, related]) => related.length > 0).map(([key]) => key))
  }

  private async getMorphToMatchCounts(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphTo' }>,
    constraint?: RelationConstraint,
  ): Promise<StoredKeyMap<number>> {
    const counts = new StoredKeyMap<number>()
    const grouped = await this.getMorphToEntitiesByParentKey(entities, relation, constraint)

    for (const [key, related] of grouped.entries()) {
      counts.set(key, related.length)
    }

    return counts
  }

  private async getMatchingThroughParentKeys(
    entities: readonly Entity<TTable>[],
    relation: ThroughRelationDefinition,
    constraint?: RelationConstraint,
  ): Promise<StoredKeySet> {
    const grouped = await this.getThroughEntitiesByParentKey(entities, relation, constraint)
    const matching = new StoredKeySet()

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
    relation: ThroughRelationDefinition,
    constraint?: RelationConstraint,
  ): Promise<StoredKeyMap<number>> {
    const grouped = await this.getThroughEntitiesByParentKey(entities, relation, constraint)
    const counts = new StoredKeyMap<number>()

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
  ): Promise<StoredKeyMap<Entity[]>> {
    if (relation.kind === 'hasOneOfMany') {
      return this.getOneOfManyEntitiesByParentKey(entities, relation, constraint)
    }

    const localKeys = collectRelationKeys(entities, relation.localKey)

    if (localKeys.length === 0) {
      return new StoredKeyMap()
    }

    const related = this.resolveRelatedRepository(relation.related)
    const { entities: relatedEntities } = await retrieveRelation(
      localKeys,
      () => this.applyRelationConstraint(relation, related, constraint),
      relation.foreignKey,
      false,
      ownEntry(related.definition.table.columns, relation.foreignKey),
    )
    return groupRelation(relatedEntities, relation.foreignKey, this.keyOptionsFor(related, relation.localKey, relation.foreignKey))
  }

  private async getMorphManyEntitiesByParentKey(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphOne' | 'morphMany' | 'morphOneOfMany' }>,
    constraint?: RelationConstraint,
  ): Promise<StoredKeyMap<Entity[]>> {
    const localKeys = collectRelationKeys(entities, relation.localKey)

    if (localKeys.length === 0) {
      return new StoredKeyMap()
    }

    if (relation.kind === 'morphOneOfMany') {
      return this.getOneOfManyEntitiesByParentKey(entities, relation, constraint)
    }

    const related = this.resolveRelatedRepository(relation.related)
    const paginated = isPaginatedRelationQuery(this.applyRelationConstraint(relation, related, constraint))
    const relatedEntities = await loadRelationKeyChunks(keysForColumn(localKeys, ownEntry(related.definition.table.columns, relation.morphIdColumn), related.getConnection().getDriver()), paginated, chunk => this.applyRelationConstraint(relation, related, constraint)
      .where(relation.morphTypeColumn, this.getMorphTypeValue())
      .where(relation.morphIdColumn, 'in', chunk)
      .get())
    return groupRelation(relatedEntities, relation.morphIdColumn, this.keyOptionsFor(related, relation.localKey, relation.morphIdColumn))
  }

  private async getMorphToEntitiesByParentKey(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphTo' }>,
    constraint?: RelationConstraint,
    morphTypes?: readonly string[],
  ): Promise<StoredKeyMap<Entity[]>> {
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

    const grouped = new StoredKeyMap<Entity[]>()

    for (const group of groups.values()) {
      const paginated = isPaginatedRelationQuery(this.applyRelationConstraint(relation, group.repository, constraint))
      const relatedKey = group.repository.definition.primaryKey
      const relatedKeyDefinition = ownEntry(group.repository.definition.table.columns, relatedKey)
      const relatedEntities = await loadRelationKeyChunks(keysForColumn(distinctStoredKeys(group.ids), relatedKeyDefinition, group.repository.getConnection().getDriver()), paginated, chunk => this.applyRelationConstraint(relation, group.repository, constraint)
        .where(relatedKey, 'in', chunk)
        .get())
      const relatedMap = indexRelation(relatedEntities, relatedKey, this.keyOptionsFor(group.repository, relation.morphIdColumn, relatedKey))

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
    if (!selectors) {
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

  private async getOneOfManyEntitiesByParentKey(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'hasOneOfMany' | 'morphOneOfMany' }>,
    constraint?: RelationConstraint,
  ): Promise<StoredKeyMap<Entity[]>> {
    const parentKeys = collectRelationKeys(entities, relation.localKey)

    if (parentKeys.length === 0) {
      return new StoredKeyMap()
    }

    const parentColumn = relation.kind === 'morphOneOfMany' ? relation.morphIdColumn : relation.foreignKey
    const related = this.resolveRelatedRepository(relation.related)
    const paginated = isPaginatedRelationQuery(this.applyRelationConstraint(relation, related, constraint))
    const latestEntities = await loadRelationKeyChunks(keysForColumn(parentKeys, ownEntry(related.definition.table.columns, parentColumn), related.getConnection().getDriver()), paginated, chunk => this.createOneOfManyQuery(relation, related, parentColumn, chunk, constraint).get())
    const options = this.keyOptionsFor(related, relation.localKey, parentColumn)
    const grouped = new StoredKeyMap<Entity[]>([], options)

    for (const [key, bucket] of groupRelation(latestEntities, parentColumn, options).entries()) {
      this.assertOneStoredOneOfManyKey(related, parentColumn, bucket)
      grouped.set(key, [bucket[0]!])
    }

    return grouped
  }

  private assertOneStoredOneOfManyKey(related: ModelRepository, parentColumn: string, bucket: readonly Entity[]): void {
    const storedKeys = new Map(bucket.map(entity => [canonicalStoredKey(entity.get(parentColumn as never)), entity.get(parentColumn as never)]))
    if (storedKeys.size > 1) {
      throw new RelationError(`One-of-many relation on model "${this.definition.name}" found "${related.definition.name}" rows whose "${parentColumn}" stores the same key in different forms (${[...storedKeys.values()].map(value => JSON.stringify(value)).join(', ')}). Store each key in one form.`)
    }
  }

  private createOneOfManyQuery(
    relation: Extract<RelationDefinition, { kind: 'hasOneOfMany' | 'morphOneOfMany' }>,
    related: ModelRepository,
    parentColumn: string,
    parentKeys: readonly unknown[],
    constraint?: RelationConstraint,
  ): ModelQueryBuilder {
    const relatedTable = related.definition.table.tableName
    const latestAlias = '__holo_latest'
    const latestKey = '__holo_latest_key'
    const latestValue = '__holo_latest_value'
    const constrainedSource = this.applyRelationConstraint(relation, related, constraint).getTableQueryBuilder().reorder().limit().offset()
    const latestSource = new TableQueryBuilder(relatedTable, constrainedSource.getConnection(), withLockMode(constrainedSource.getPlan(), undefined))
    const scopedSource = relation.kind === 'morphOneOfMany'
      ? latestSource.where(relation.morphTypeColumn, this.getMorphTypeValue())
      : latestSource
    const latestGroups = scopedSource
      .where(parentColumn, 'in', parentKeys)
      .select(`${parentColumn} as ${latestKey}`)
    const latestAggregate = relation.aggregate === 'max'
      ? latestGroups.addSelectMax(latestValue, relation.aggregateColumn)
      : latestGroups.addSelectMin(latestValue, relation.aggregateColumn)
    const latestQuery = new TableQueryBuilder(relatedTable, latestAggregate.getConnection(), withOneOfManyAggregateMarker(latestAggregate.getPlan()))
    const outer = this.applyRelationConstraint(relation, related, constraint)
    const projected = outer.getTableQueryBuilder().getPlan().selections.length > 0
    const scopedOuter = relation.kind === 'morphOneOfMany'
      ? outer.where(`${relatedTable}.${relation.morphTypeColumn}`, this.getMorphTypeValue())
      : outer
    const joined = scopedOuter
      .joinSub(latestQuery.groupBy(parentColumn), latestAlias, `${relatedTable}.${parentColumn}`, '=', `${latestAlias}.${latestKey}`)
      .whereColumn(`${latestAlias}.${latestValue}`, '=', `${relatedTable}.${relation.aggregateColumn}`)

    return projected
      ? joined
      : joined.select(...this.listRelatedColumnSelections(related, relatedTable))
  }

  private listRelatedColumnSelections(related: ModelRepository, relatedTable: string): readonly string[] {
    return related.definition.untyped
      ? [`${relatedTable}.*`]
      : Object.keys(related.definition.table.columns).map(column => `${relatedTable}.${column}`)
  }

  private async getThroughEntitiesByParentKey(
    entities: readonly Entity<TTable>[],
    relation: ThroughRelationDefinition,
    constraint?: RelationConstraint,
  ): Promise<StoredKeyMap<Entity[]>> {
    return await runRequiringDatabaseQueryRefresh(() => this.queryThroughEntitiesByParentKey(entities, relation, constraint))
  }

  private async queryThroughEntitiesByParentKey(
    entities: readonly Entity<TTable>[],
    relation: ThroughRelationDefinition,
    constraint?: RelationConstraint,
  ): Promise<StoredKeyMap<Entity[]>> {
    const parentKeys = collectRelationKeys(entities, relation.localKey)

    if (parentKeys.length === 0) {
      return new StoredKeyMap()
    }

    const through = this.resolveThroughRepository(relation.through)
    const throughEntities = await loadRelationKeyChunks(keysForColumn(parentKeys, ownEntry(through.definition.table.columns, relation.firstKey), through.getConnection().getDriver()), false, chunk => through.query()
      .where(relation.firstKey, 'in', chunk)
      .get())

    if (throughEntities.length === 0) {
      return new StoredKeyMap()
    }

    const throughByParent = groupRelation(throughEntities, relation.firstKey, this.keyOptionsFor(through, relation.localKey, relation.firstKey))
    const secondLocalValues = distinctStoredKeys(
      throughEntities
        .map(entity => entity.get(relation.secondLocalKey as never))
        .filter(value => value !== null && typeof value !== 'undefined'),
    )

    if (secondLocalValues.length === 0) {
      return new StoredKeyMap()
    }

    const related = this.resolveRelatedRepository(relation.related)
    const secondKeyDefinition = ownEntry(related.definition.table.columns, relation.secondKey)
    const { entities: relatedEntities } = await retrieveRelation(
      secondLocalValues,
      () => this.applyRelationConstraint(relation, related, constraint),
      relation.secondKey,
      false,
      secondKeyDefinition,
    )
    const relatedBySecondKey = groupRelation(relatedEntities, relation.secondKey, relationKeyOptions(ownEntry(through.definition.table.columns, relation.secondLocalKey), secondKeyDefinition))
    const grouped = new StoredKeyMap<Entity[]>([], throughByParent.options)

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
  ): Promise<StoredKeySet> {
    const { rows: pivotRows, related: relatedMap, options } = await this.retrievePivotRows(entities, relation, constraint)
    const matchingParents = new StoredKeySet([], options)

    for (const row of pivotRows) {
      if (relatedMap.has(row[relation.relatedPivotKey])) {
        matchingParents.add(row[relation.foreignPivotKey])
      }
    }

    return matchingParents
  }

  private async getMatchingMorphToManyParentKeys(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphToMany' }>,
    constraint?: RelationConstraint,
  ): Promise<StoredKeySet> {
    const grouped = await this.getMorphToManyEntitiesByParentKey(entities, relation, constraint)
    return new StoredKeySet([...grouped.entries()].filter(([, related]) => related.length > 0).map(([key]) => key), grouped.options)
  }

  private async getMatchingMorphedByManyParentKeys(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphedByMany' }>,
    constraint?: RelationConstraint,
  ): Promise<StoredKeySet> {
    const grouped = await this.getMorphedByManyEntitiesByParentKey(entities, relation, constraint)
    return new StoredKeySet([...grouped.entries()].filter(([, related]) => related.length > 0).map(([key]) => key), grouped.options)
  }

  private async getBelongsToManyMatchCounts(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'belongsToMany' }>,
    constraint?: RelationConstraint,
  ): Promise<StoredKeyMap<number>> {
    const { rows: pivotRows, related: relatedMap, options } = await this.retrievePivotRows(entities, relation, constraint)
    const counts = new StoredKeyMap<number>([], options)

    for (const row of pivotRows) {
      if (!relatedMap.has(row[relation.relatedPivotKey])) {
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
  ): Promise<StoredKeyMap<number>> {
    const grouped = await this.getMorphToManyEntitiesByParentKey(entities, relation, constraint)
    const counts = new StoredKeyMap<number>([], grouped.options)

    for (const [key, related] of grouped.entries()) {
      counts.set(key, related.length)
    }

    return counts
  }

  private async getMorphedByManyMatchCounts(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphedByMany' }>,
    constraint?: RelationConstraint,
  ): Promise<StoredKeyMap<number>> {
    const grouped = await this.getMorphedByManyEntitiesByParentKey(entities, relation, constraint)
    const counts = new StoredKeyMap<number>([], grouped.options)

    for (const [key, related] of grouped.entries()) {
      counts.set(key, related.length)
    }

    return counts
  }

  private async getBelongsToManyEntitiesByParentKey(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'belongsToMany' }>,
    constraint?: RelationConstraint,
  ): Promise<StoredKeyMap<Entity[]>> {
    const { rows: pivotRows, related: relatedMap, options } = await this.retrievePivotRows(entities, relation, constraint)
    return this.groupPivotRows(pivotRows, relatedMap, relation, options)
  }

  private async retrievePivotRows(
    entities: readonly Entity<TTable>[],
    relation: PivotRelationDefinition,
    constraint?: RelationConstraint,
  ): Promise<{ rows: Record<string, unknown>[], related: StoredKeyMap<Entity>, options: StoredKeyOptions }> {
    const related = this.resolveRelatedRepository(relation.related)
    const parentColumn = this.pivotParentColumn(relation)
    const relatedColumn = this.pivotRelatedColumn(relation)
    const parentKeys = collectRelationKeys(entities, relation.parentKey)
    if (parentKeys.length === 0) return { rows: [], related: new StoredKeyMap(), options: this.pivotKeyOptions(relation, undefined) }
    const pivot = await this.loadPivotKeyColumns(relation)
    const { rows, related: relatedMap } = await retrievePivotRelation(
      parentKeys,
      () => this.createPivotQuery(relation, related),
      parentColumn,
      relatedColumn,
      () => this.applyRelationConstraint(relation, related, constraint),
      relation.relatedKey,
      this.getPivotSelection(relation, relation.kind === 'belongsToMany' ? [parentColumn, relatedColumn] : [parentColumn, relatedColumn, relation.morphTypeColumn]),
      rows => this.readPivotKeys(rows, [
        [parentColumn, this.definition.table, relation.parentKey, pivot.introspected ? pivot.parentKey : undefined],
        [relatedColumn, related.definition.table, relation.relatedKey, pivot.introspected ? pivot.relatedKey : undefined],
      ]),
      {
        parentKey: ownEntry(this.definition.table.columns, relation.parentKey),
        relatedKey: ownEntry(related.definition.table.columns, relation.relatedKey),
        pivotParentKey: pivot.parentKey,
        pivotRelatedKey: pivot.relatedKey,
      },
    )
    return { rows, related: relatedMap, options: this.pivotKeyOptions(relation, pivot.parentKey) }
  }

  private createPivotQuery(relation: PivotRelationDefinition, related: ModelRepository): TableQueryBuilder<string | TableDefinition> {
    const connection = this.getConnection()
    switch (relation.kind) {
      case 'belongsToMany':
        return this.createBelongsToManyPivotQuery(relation, connection)
      case 'morphToMany':
        return this.createMorphToManyPivotQuery(relation, connection).where(relation.morphTypeColumn, this.getMorphTypeValue())
      case 'morphedByMany':
        return this.createMorphedByManyPivotQuery(relation, related.definition.morphClass, connection)
    }
  }

  private groupPivotRows(
    rows: readonly Record<string, unknown>[],
    related: StoredKeyMap<Entity>,
    relation: PivotRelationDefinition,
    options: StoredKeyOptions,
  ): StoredKeyMap<Entity[]> {
    const grouped = new StoredKeyMap<Entity[]>([], options)
    for (const row of rows) {
      const entity = related.get(row[this.pivotRelatedColumn(relation)])
      if (!entity) continue
      const key = row[this.pivotParentColumn(relation)]
      const bucket = grouped.get(key) ?? []
      bucket.push(this.attachPivotAttributes(entity, row, relation))
      grouped.set(key, bucket)
    }
    return grouped
  }

  private async getMorphToManyEntitiesByParentKey(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphToMany' }>,
    constraint?: RelationConstraint,
  ): Promise<StoredKeyMap<Entity[]>> {
    const { rows, related, options } = await this.retrievePivotRows(entities, relation, constraint)
    return this.groupPivotRows(rows, related, relation, options)
  }

  private async getMorphedByManyEntitiesByParentKey(
    entities: readonly Entity<TTable>[],
    relation: Extract<RelationDefinition, { kind: 'morphedByMany' }>,
    constraint?: RelationConstraint,
  ): Promise<StoredKeyMap<Entity[]>> {
    const { rows, related, options } = await this.retrievePivotRows(entities, relation, constraint)
    return this.groupPivotRows(rows, related, relation, options)
  }

  private createBelongsToManyPivotQuery(
    relation: Extract<RelationDefinition, { kind: 'belongsToMany' }>,
    connection: DatabaseContext,
  ): TableQueryBuilder<string | TableDefinition> {
    return this.applyPivotQueryConfig(new TableQueryBuilder(this.resolvePivotTable(relation.pivotTable, connection), connection), relation)
  }

  private resolvePivotTable(pivotTable: string | TableDefinition, connection: DatabaseContext): string | TableDefinition {
    if (typeof pivotTable !== 'string') return pivotTable
    return getConnectionGeneratedTableDefinition(pivotTable, connection.getConnectionName()) ?? pivotTable
  }

  private resolvePivotTableName(pivotTable: string | TableDefinition): string {
    return typeof pivotTable === 'string' ? pivotTable : pivotTable.tableName
  }

  private createMorphToManyPivotQuery(
    relation: Extract<RelationDefinition, { kind: 'morphToMany' }>,
    connection: DatabaseContext,
  ): TableQueryBuilder<string | TableDefinition> {
    return this.applyPivotQueryConfig(new TableQueryBuilder(this.resolvePivotTable(relation.pivotTable, connection), connection), relation)
  }

  private createMorphedByManyPivotQuery(
    relation: Extract<RelationDefinition, { kind: 'morphedByMany' }>,
    morphClass: string,
    connection: DatabaseContext,
  ): TableQueryBuilder<string | TableDefinition> {
    return this.applyPivotQueryConfig(
      new TableQueryBuilder(this.resolvePivotTable(relation.pivotTable, connection), connection).where(relation.morphTypeColumn, morphClass),
      relation,
    )
  }

  private readPivotKeys(
    rows: readonly Record<string, unknown>[],
    keys: readonly (readonly [pivotColumn: string, ownerTable: TableDefinition, ownerColumn: string, introspected: AnyColumnDefinition | undefined])[],
  ): Record<string, unknown>[] {
    const dialect = this.getConnection().getDriver() as SchemaDialectName
    const columns = keys.map(([pivotColumn, ownerTable, ownerColumn, introspected]) => [pivotColumn, ownEntry(ownerTable.columns, ownerColumn), introspected] as const)
    return rows.map(row => {
      const read = { ...row }
      for (const [pivotColumn, definition, introspected] of columns) {
        const stored = introspected?.kind === 'decimal' ? normalizeDialectReadValue(dialect, introspected, row[pivotColumn]) : row[pivotColumn]
        read[pivotColumn] = definition && !isFractionalKeyFor(definition, stored) ? normalizeDialectReadValue(dialect, definition, stored) : stored
      }
      return read
    })
  }

  private getPivotSelection(relation: PivotRelationDefinition, keys: readonly string[]): readonly string[] {
    return [...new Set([...keys, ...relation.pivotColumns])]
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

    const connection = this.getConnection()
    const table = this.resolvePivotTable(relation.pivotTable, connection)
    const dialect = connection.getDriver() as SchemaDialectName
    const timestampColumns: readonly string[] = relation.pivotTimestamps ? PIVOT_TIMESTAMP_COLUMNS : []
    return Object.fromEntries(
      Object.entries(row).map(([column, value]) => {
        const definition = typeof table === 'string' ? undefined : table.columns[column]
        const normalized = definition ? normalizeDialectReadValue(dialect, definition, value) : value
        const readsAsDate = timestampColumns.includes(column) && (!definition || storesText(definition))
        return [column, readsAsDate ? this.applyCastGet('datetime', normalized) : normalized]
      }),
    )
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

  assertMassAssignable<TValues extends Partial<ModelRecord<TTable>> | Record<string, unknown>>(values: TValues): TValues {
    for (const key of Object.keys(values)) {
      const { columnName } = findWriteColumn(this.definition, key, 'generated')

      this.assertWritableColumn(columnName, key)
    }

    return values
  }

  async loadGuardableColumns(): Promise<void> {
    await this.resolveTableIdentity()
    if (this.guardsByColumnListing()) {
      await loadColumnListing(this.getConnection(), this.definition.table.tableName)
    }
  }

  private async assertGuardableAttributes(values: Record<string, unknown>): Promise<void> {
    if (!this.guardsByColumnListing() || areModelGuardsDisabled()) {
      return
    }

    const columns = await loadColumnListing(this.getConnection(), this.definition.table.tableName)
    const unknownKey = Object.keys(values).find(key => !key.includes('->') && !this.isGuardableColumn(key, columns))
    if (unknownKey !== undefined) {
      throw new SecurityError(`Column "${unknownKey}" is not writable on model "${this.definition.name}".`)
    }
  }

  private guardsByColumnListing(): boolean {
    return this.definition.untyped && this.definition.hasExplicitFillable !== true && this.definition.guarded.length > 0
  }

  private isGuardableColumn(
    key: string,
    columns = getLoadedColumnListing(this.getConnection(), this.definition.table.tableName),
  ): boolean {
    if (ownEntry(this.definition.mutators, key) || isClassCast(ownEntry(this.definition.casts, key))) return true
    if (key.includes('->')) return false
    return columns === undefined || columns.size === 0 || columns.has(key)
  }

  private assertWritableColumn(column: string, key: string): void {
    if (!this.isWritableColumn(column)) {
      throw new SecurityError(`Column "${column}" is not writable on model "${this.definition.name}".`)
    }

    if (this.guardsByColumnListing() && !areModelGuardsDisabled() && !this.isGuardableColumn(key)) {
      throw new SecurityError(`Column "${key}" is not writable on model "${this.definition.name}".`)
    }
  }

  private isWritableColumn(column: string): boolean {
    if (areModelGuardsDisabled()) {
      return true
    }

    const fillable = new Set(this.definition.fillable)
    const guarded = new Set(this.definition.guarded)

    if (guarded.has('*') || guarded.has(column)) return false
    if (fillable.has(column)) return true
    if (isUnresolvedGeneratedPrimaryKey(this.definition.table.tableName, this.definition.connectionName, column)) return false
    if (this.isAutomaticallyGuardedColumn(column)) return false
    if (fillable.has('*')) return true
    return this.definition.hasExplicitFillable !== true && this.definition.hasExplicitGuarded === true
  }

  private isAutomaticallyGuardedColumn(column: string): boolean {
    return column === this.definition.primaryKey
      || column === this.definition.createdAtColumn
      || column === this.definition.updatedAtColumn
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

          const query = related.query().withTrashed()

          await query.getTableQueryBuilder()
            .where(relation.ownerKey, ownerId)
            .update(related.withWriteTimestamps({}, 'update', touchedAt))
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

          const query = related.query().withTrashed()

          await query.getTableQueryBuilder()
            .where(related.definition.primaryKey, ownerId)
            .update(related.withWriteTimestamps({}, 'update', touchedAt))
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

  private createPivotMutation(entity: Entity<TTable>, relationName: string): PivotMutation {
    const { relation, parentId } = this.getPivotMutationContext(entity, relationName)
    const scope: Record<string, unknown> = {}
    let relatedColumn: string
    switch (relation.kind) {
      case 'belongsToMany':
        scope[relation.foreignPivotKey] = parentId
        relatedColumn = relation.relatedPivotKey
        break
      case 'morphToMany':
        scope[relation.morphTypeColumn] = this.getMorphTypeValue()
        scope[relation.morphIdColumn] = parentId
        relatedColumn = relation.foreignPivotKey
        break
      case 'morphedByMany':
        scope[relation.foreignPivotKey] = parentId
        scope[relation.morphTypeColumn] = this.resolveRelatedRepository(relation.related).definition.morphClass
        relatedColumn = relation.morphIdColumn
        break
    }
    const connection = this.getConnection()
    const table = this.resolvePivotTable(relation.pivotTable, connection)
    const relatedKey = typeof table === 'string' ? undefined : ownEntry(table.columns, relatedColumn)
    return new PivotMutation({
      table,
      scope,
      relatedColumn,
      relatedKey,
      dialect: connection.getDriver() as SchemaDialectName,
      allowedColumns: relation.pivotColumns,
      timestamps: relation.pivotTimestamps === true,
      relationName,
    }, connection)
  }

  private async dispatchCancelableEvent(
    eventName: Extract<ModelLifecycleEventName, 'saving' | 'creating' | 'updating' | 'deleting' | 'restoring' | 'forceDeleting'>,
    entity: Entity<TTable>,
  ): Promise<void> {
    await this.eventDispatcher.dispatchCancelable(eventName, entity, (target, before) => {
      this.applyWriteMutators(target, this.changedKeysSince(target, before))
    })
  }

  private async dispatchEvent(
    eventName: ModelLifecycleEventName,
    entity: Entity<TTable>,
    collectResults = false,
  ): Promise<unknown[]> {
    return this.eventDispatcher.dispatch(eventName, entity, collectResults)
  }

  private dispatchSyncEvent(
    eventName: Extract<ModelLifecycleEventName, 'replicating'>,
    entity: Entity<TTable>,
  ): void {
    this.eventDispatcher.dispatchSync(eventName, entity)
  }

  resolveAttribute(key: string, entity: Entity<TTable>, value: unknown): unknown {
    return this.valueTransformer.resolveAttribute(key, entity, value)
  }

  shouldPreventAccessingMissingAttributes(key: string): boolean {
    return this.valueTransformer.shouldPreventAccessingMissingAttributes(key)
  }

  serializeEntity(entity: Entity<TTable>): Record<string, unknown> {
    return this.valueTransformer.serializeEntity(entity)
  }

  serializeAttributeValue(key: string, value: unknown): unknown {
    return this.valueTransformer.serializeAttributeValue(key, value)
  }

  private normalizeFromStorage(values: Partial<ModelRecord<TTable>>, extraCasts: Record<string, ModelCastDefinition> = {}): Partial<ModelRecord<TTable>> {
    return this.valueTransformer.normalizeFromStorage(values, extraCasts)
  }

  private applyTimestampDefaults(values: Partial<ModelRecord<TTable>>, mode: WriteMode): Partial<ModelRecord<TTable>> {
    return this.valueTransformer.applyTimestampDefaults(values, mode)
  }

  private normalizeForStorage(key: string, value: unknown): unknown {
    return this.valueTransformer.normalizeForStorage(key, value)
  }

  private castForStorage(key: string, value: unknown): unknown {
    return this.valueTransformer.castForStorage(key, value)
  }

  private applyWriteMutators(entity: Entity<TTable>, keys: readonly string[]): void {
    const attributes = entity.toAttributes() as Record<string, unknown>
    const mutated = Object.fromEntries(
      keys
        .filter(key => ownEntry(this.definition.mutators, key) !== undefined)
        .map(key => [key, this.valueTransformer.applyMutator(key, attributes[key])]),
    )
    entity.forceFill(mutated as never)
  }

  private changedKeysSince(entity: Entity<TTable>, before: Record<string, unknown>): string[] {
    const attributes = entity.toAttributes() as Record<string, unknown>
    return Object.keys(attributes).filter(key => !valuesAreEqual(attributes[key], before[key]))
  }

  private applyCastGet(cast: ModelCastDefinition | undefined, value: unknown): unknown {
    return this.valueTransformer.applyCastGet(cast, value)
  }

}
