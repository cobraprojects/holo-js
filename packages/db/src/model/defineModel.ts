import { registerDynamicRelation } from './dynamicRelations'
import { withoutModelEvents, withoutModelGuards } from './eventState'
import { ModelRepository } from './ModelRepository'
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
import type { BoundTableDefinition } from '../schema/defineTable'
import type { TableDefinitionBuilder } from '../schema/TableDefinitionBuilder'
import type { ModelQueryBuilder } from './ModelQueryBuilder'
import type { Entity } from './Entity'
import type { TableQueryBuilder } from '../query/TableQueryBuilder'
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
  ModelCastDefinition,
  ModelAttributeKey,
  ModelColumnName,
  ModelColumnReference,
  ModelDefinition,
  ModelJsonColumnPath,
  ModelRecord,
  ModelSelectableColumn,
  ModelScopesDefinition,
  ModelUpdatePayload,
  ModelRelationPath,
  RelatedColumnNameForRelationPath,
  UniqueIdRuntimeConfig,
} from './types'
import type { StaticModelApi } from './staticModelApi'

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
  const resolvedAtDefinition = resolveGeneratedModelTableSafely(tableName)
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
  const resolveUniqueId = (): UniqueIdRuntimeConfig<GeneratedSchemaTable<TName>> | null => {
    return resolveUniqueIdConfig(
      options.traits,
      resolvePrimaryKey(),
      options.uniqueIds,
      options.newUniqueId,
    )
  }

  if (resolvedAtDefinition) {
    validateUniqueIdConfig(resolvedAtDefinition, inferredName, resolveUniqueId())
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
    replicationExcludes: Object.freeze([...(options.replicationExcludes ?? [])]),
    softDeletes: options.softDeletes ?? false,
    events: normalizeEventHandlers(options.events),
    observers: Object.freeze([...(options.observers ?? [])]),
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
    whereBelongsTo<TRelated extends TableDefinition, TRelatedRelations extends RelationMap = RelationMap>(entity: Entity<TRelated, TRelatedRelations>, relationName?: ModelRelationPath<TRelations>) {
      return this.query().whereBelongsTo(entity, relationName)
    },
    orWhereBelongsTo<TRelated extends TableDefinition, TRelatedRelations extends RelationMap = RelationMap>(entity: Entity<TRelated, TRelatedRelations>, relationName?: ModelRelationPath<TRelations>) {
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

function resolveGeneratedModelTableSafely<TName extends string>(
  tableName: TName,
): GeneratedSchemaTable<TName> | undefined {
  try {
    return resolveGeneratedModelTable(tableName) as GeneratedSchemaTable<TName>
  } catch {
    return undefined
  }
}
