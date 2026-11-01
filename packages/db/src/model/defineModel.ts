import { registerDynamicRelation } from './dynamicRelations'
import { withoutModelEvents, withoutModelGuards } from './eventState'
import { registerModelObserver } from './modelObservers'
import { ModelRepository } from './ModelRepository'
import { registerGlobalModel } from './ModelRegistry'
import { registerMorphModel } from './morphRegistry'
import { setAutomaticEagerLoading, setPreventAccessingMissingAttributes, setPreventLazyLoading } from './runtimeSettings'
import { resolveUniqueIdConfig, validateUniqueIdConfig } from './uniqueIds'
import {
  buildModelTable,
  inferModelName,
  inferPrimaryKey,
  normalizeEventHandlers,
  resolveDeletedAtColumn,
  resolveGeneratedModelTable,
  resolveTimestampColumn,
  validateTouches,
} from './defineModelHelpers'
import type { ColumnInput } from '../schema/columns'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { BoundTableDefinition } from '../schema/defineTable'
import type { TableDefinitionBuilder } from '../schema/TableDefinitionBuilder'
import { assertModelScopeNameAvailable, type ModelQueryBuilder } from './ModelQueryBuilder'
import type {
  CursorPaginationOptions,
  PaginationOptions,
} from '../query/types'
import type { TableDefinition } from '../schema/types'
import type {
  RelationMap,
  DynamicRelationResolver,
  DefineModelOptions,
  EntityWithLoaded,
  EmptyScopeMap,
  GeneratedSchemaTable,
  ModelAttributeKey,
  ModelColumnName,
  ModelDefinition,
  ModelRecord,
  ModelScopesDefinition,
  ModelUpdatePayload,
  UniqueIdRuntimeConfig,
} from './types'
import { STATIC_MODEL_QUERY_FORWARD_METHODS, type StaticModelApi } from './staticModelApi'

const HOLO_MODEL_REFERENCE_REGISTRY = Symbol.for('holo-js.db.model-reference-registry')
const HOLO_MODEL_OBSERVER_REGISTRAR = Symbol.for('holo-js.db.model-observer-registrar')
type ColumnShapeInput = Record<string, ColumnInput>
type EmptyColumnShape = Record<never, never>
type ModelTableBuilderResult<
  TName extends string,
  TColumns extends ColumnShapeInput,
> = {
  build(): BoundTableDefinition<TName, TColumns>
}
type SharedModelDefinitionFields<
  TTable extends TableDefinition,
  TScopes extends ModelScopesDefinition,
  TRelations extends RelationMap,
> = Omit<
  ModelDefinition<TTable, TScopes, TRelations>,
  'table' | 'primaryKey' | 'createdAtColumn' | 'updatedAtColumn' | 'deletedAtColumn' | 'uniqueIdConfig'
>

function snapshotModelScopes<TScopes extends ModelScopesDefinition>(scopes: TScopes): TScopes {
  for (const name of Object.keys(scopes)) {
    assertModelScopeNameAvailable(name)
  }

  return Object.freeze({ ...scopes })
}

function createSharedModelDefinitionFields<
  TTable extends TableDefinition,
  TScopes extends ModelScopesDefinition,
  TRelations extends RelationMap,
>(
  inferredName: string,
  relations: TRelations,
  touches: readonly string[],
  options: DefineModelOptions<TTable, TScopes, TRelations>,
): SharedModelDefinitionFields<TTable, TScopes, TRelations> {
  return {
    kind: 'model',
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
    hasExplicitGuarded: typeof options.guarded !== 'undefined',
    scopes: snapshotModelScopes((options.scopes ?? {}) as TScopes),
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
    replicationExcludes: Object.freeze([...(options.replicationExcludes ?? [])]),
    softDeletes: options.softDeletes ?? false,
    events: normalizeEventHandlers(options.events),
    observers: Object.freeze([...(options.observers ?? [])]),
  }
}

export function defineModel<
  TTable extends TableDefinition,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
  TRelations extends RelationMap = RelationMap,
  const THidden extends readonly string[] = readonly string[],
>(
  table: TTable,
  options?: DefineModelOptions<TTable, TScopes, TRelations> & { readonly hidden?: THidden },
): StaticModelApi<TTable, TScopes, TRelations, THidden>
export function defineModel<
  TName extends string,
  TColumns extends ColumnShapeInput,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
  TRelations extends RelationMap = RelationMap,
  const THidden extends readonly string[] = readonly string[],
>(
  tableName: TName,
  builder: (table: TableDefinitionBuilder<TName, EmptyColumnShape>) => ModelTableBuilderResult<TName, TColumns>,
  options?: DefineModelOptions<BoundTableDefinition<TName, TColumns>, TScopes, TRelations> & { readonly hidden?: THidden },
): StaticModelApi<BoundTableDefinition<TName, TColumns>, TScopes, TRelations, THidden>
export function defineModel<
  TName extends string,
  TScopes extends ModelScopesDefinition = EmptyScopeMap,
  TRelations extends RelationMap = RelationMap,
  const THidden extends readonly string[] = readonly string[],
>(
  tableName: TName,
  options?: DefineModelOptions<GeneratedSchemaTable<TName>, TScopes, TRelations> & { readonly hidden?: THidden },
): StaticModelApi<GeneratedSchemaTable<TName>, TScopes, TRelations, THidden>
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
  const THidden extends readonly string[] = readonly string[],
>(
  table: TTable,
  options?: DefineModelOptions<TTable, TScopes, TRelations> & { readonly hidden?: THidden },
): StaticModelApi<TTable, TScopes, TRelations, THidden>
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
  const inferredName = options.name ?? inferModelName(tableName)
  const relations = { ...(options.relations ?? {}) } as TRelations
  const touches = validateTouches(inferredName, relations, options.touches ?? [])

  const resolveTableDefinition = (): GeneratedSchemaTable<TName> => (
    resolveGeneratedModelTable(tableName, options.connectionName) as GeneratedSchemaTable<TName>
  )
  const resolvePrimaryKeyFromTable = (
    table: GeneratedSchemaTable<TName>,
  ): Extract<keyof GeneratedSchemaTable<TName>['columns'], string> => (
    (options.primaryKey ?? inferPrimaryKey(table)) as Extract<keyof GeneratedSchemaTable<TName>['columns'], string>
  )
  const resolveUniqueIdFromTable = (
    table: GeneratedSchemaTable<TName>,
  ): UniqueIdRuntimeConfig<GeneratedSchemaTable<TName>> | null => {
    return resolveUniqueIdConfig(
      options.traits,
      resolvePrimaryKeyFromTable(table),
      options.uniqueIds,
      options.newUniqueId,
    )
  }
  const resolveTable = (): GeneratedSchemaTable<TName> => {
    const table = resolveTableDefinition()
    validateUniqueIdConfig(table, inferredName, resolveUniqueIdFromTable(table))
    return table
  }
  const resolvePrimaryKey = (): Extract<keyof GeneratedSchemaTable<TName>['columns'], string> => (
    resolvePrimaryKeyFromTable(resolveTable())
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
  const resolveUniqueId = (): UniqueIdRuntimeConfig<GeneratedSchemaTable<TName>> | null => {
    return resolveUniqueIdFromTable(resolveTable())
  }

  const definition = {
    ...createSharedModelDefinitionFields(inferredName, relations, touches, options),
  } as Omit<ModelDefinition<GeneratedSchemaTable<TName>, TScopes, TRelations>, 'table' | 'primaryKey' | 'createdAtColumn' | 'updatedAtColumn' | 'deletedAtColumn' | 'uniqueIdConfig'>
    & Pick<ModelDefinition<GeneratedSchemaTable<TName>, TScopes, TRelations>, 'table' | 'primaryKey' | 'createdAtColumn' | 'updatedAtColumn' | 'deletedAtColumn' | 'uniqueIdConfig'>

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
    uniqueIdConfig: {
      enumerable: true,
      get: resolveUniqueId,
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
    ...createSharedModelDefinitionFields(inferredName, relations, touches, options),
    table,
    primaryKey,
    createdAtColumn,
    updatedAtColumn,
    uniqueIdConfig,
    deletedAtColumn,
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
    hydrate(row: Partial<ModelRecord<TTable>>, sourceConnection?: DatabaseContext) {
      return this.getRepository().retrieve(row, sourceConnection)
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

  for (const method of STATIC_MODEL_QUERY_FORWARD_METHODS) {
    const forward = (...args: readonly unknown[]) => {
      const query = model.query()
      return Reflect.apply(query[method], query, args)
    }
    ;(model as Record<string, unknown>)[method] = forward
  }

  for (const [name, scope] of Object.entries(definition.scopes)) {
    const scoped = scope as (query: ModelQueryBuilder<TTable, TRelations, unknown, TScopes>, ...args: readonly unknown[]) => ModelQueryBuilder<TTable, TRelations, unknown, TScopes>
    ;(model as Record<string, unknown>)[name] = (...args: readonly unknown[]) => scoped(model.query(), ...args)
  }

  Object.defineProperty(model, HOLO_MODEL_OBSERVER_REGISTRAR, {
    value(observer: unknown) {
      registerModelObserver(definition, observer)
    },
  })

  registerGlobalModel(model)
  registerMorphModel(definition.morphClass, model)

  getHoloModelReferenceRegistry().add(model)

  return Object.freeze(model) as unknown as StaticModelApi<TTable, TScopes, TRelations>
}

function getHoloModelReferenceRegistry(): WeakSet<object> {
  const registryGlobal = globalThis as typeof globalThis & Record<symbol, WeakSet<object> | undefined>
  const existing = registryGlobal[HOLO_MODEL_REFERENCE_REGISTRY]
  if (existing) {
    return existing
  }

  const registry = new WeakSet<object>()
  Object.defineProperty(globalThis, HOLO_MODEL_REFERENCE_REGISTRY, {
    value: registry,
  })

  return registry
}
