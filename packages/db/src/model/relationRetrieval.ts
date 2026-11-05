import { hasActiveDatabaseDependencyCollector, readDatabaseQueryObservationCount, truncateDatabaseQueryObservations } from '../cache'
import { isInlineIntegerValue } from '../query/ast'
import { hasQueryCache } from '../query/TableQueryBuilder'
import { readFractionalDecimalKey, readIntegralDecimalKey, readsAsInteger } from '../schema/normalization'
import { canonicalStoredKey, ownEntry } from './entityRuntime'
import { StoredKeyMap, StoredKeySet, type StoredKeyOptions } from './storedKeyCollections'
import type { TableQueryBuilder } from '../query/TableQueryBuilder'
import type { AnyColumnDefinition, ColumnDefinition, LogicalColumnKind, TableDefinition } from '../schema/types'
import type { QueryPredicateNode, SelectQueryPlan } from '../query/ast'
import type { Entity } from './Entity'
import type { ModelQueryBuilder } from './ModelQueryBuilder'

const RELATION_KEY_CHUNK_SIZE = 256
const INTEGER_KEY_KINDS: ReadonlySet<LogicalColumnKind> = new Set(['id', 'integer', 'bigInteger'])

export function collectRelationKeys<TTable extends TableDefinition>(entities: readonly Entity<TTable>[], column: string): unknown[] {
  return distinctStoredKeys(entities.map(entity => entity.toAttributes()[column as keyof ReturnType<typeof entity.toAttributes>]).filter(value => value != null))
}

export function isKeySeparableQuery<TTable extends TableDefinition>(query: ModelQueryBuilder<TTable>): boolean {
  const tableQuery = query.getTableQueryBuilder()
  const plan = tableQuery.getPlan()
  return !tableQuery[hasQueryCache]()
    && !planHasRawSql(plan)
    && typeof plan.limit !== 'number'
    && typeof plan.offset !== 'number'
    && plan.orderBy.length === 0
    && plan.groupBy.length === 0
    && plan.having.length === 0
    && plan.unions.length === 0
    && !plan.distinct
}

function planHasRawSql(plan: SelectQueryPlan): boolean {
  return plan.selections.some(selection => selection.kind === 'raw' || (selection.kind === 'subquery' && planHasRawSql(selection.query)))
    || plan.joins.some(join => join.subquery !== undefined && planHasRawSql(join.subquery))
    || plan.unions.some(union => planHasRawSql(union.query))
    || plan.predicates.some(predicate => predicateHasRawSql(predicate))
    || plan.orderBy.some(orderBy => orderBy.kind === 'raw')
}

function predicateHasRawSql(predicate: QueryPredicateNode): boolean {
  if (predicate.kind === 'raw') {
    return true
  }

  if (predicate.kind === 'group') {
    return predicate.predicates.some(nested => predicateHasRawSql(nested))
  }

  if (predicate.kind === 'exists' || predicate.kind === 'subquery') {
    return planHasRawSql(predicate.subquery)
  }

  return false
}

export function isPaginatedRelationQuery(query: ModelQueryBuilder): boolean {
  const plan = query.getTableQueryBuilder().getPlan()
  return typeof plan.limit === 'number' || typeof plan.offset === 'number'
}

function padRelationKeys(keys: readonly unknown[]): unknown[] {
  const width = 2 ** Math.ceil(Math.log2(keys.length))
  const padding = Array.from({ length: width - keys.length }, () => keys[keys.length - 1])
  return [...keys, ...padding]
}

export function singleStatementRelationKeys(values: readonly unknown[]): unknown[] {
  const keys = [...new Set(values)]
  return keys.length <= RELATION_KEY_CHUNK_SIZE ? padRelationKeys(keys) : keys
}

export function distinctStoredKeys(values: readonly unknown[]): unknown[] {
  const seen = new Set<unknown>()
  const distinct: unknown[] = []
  for (const value of values) {
    const identity = canonicalStoredKey(value)
    if (!seen.has(identity)) {
      seen.add(identity)
      distinct.push(value)
    }
  }
  return distinct
}

export function integerKeysToInline(
  values: readonly unknown[],
  primaryKey: Pick<ColumnDefinition, 'kind'> | undefined,
): readonly (number | bigint)[] | undefined {
  if (!primaryKey || !INTEGER_KEY_KINDS.has(primaryKey.kind)) return undefined
  const keys = [...new Set(values)]
  return keys.length > RELATION_KEY_CHUNK_SIZE && keys.every(isInlineIntegerValue) ? keys : undefined
}

function chunkRelationKeys(keys: readonly unknown[], paginated: boolean): unknown[][] {
  if (paginated) return keys.length === 0 ? [] : [[...keys]]
  const chunks: unknown[][] = []
  for (let offset = 0; offset < keys.length; offset += RELATION_KEY_CHUNK_SIZE) {
    chunks.push(padRelationKeys(keys.slice(offset, offset + RELATION_KEY_CHUNK_SIZE)))
  }
  return chunks
}

export async function loadRelationKeyChunks<TRow>(
  keys: readonly unknown[],
  paginated: boolean,
  load: (chunk: readonly unknown[]) => Promise<readonly TRow[]>,
): Promise<TRow[]> {
  const rows: TRow[] = []
  for (const chunk of chunkRelationKeys(keys, paginated)) {
    for (const row of await load(chunk)) rows.push(row)
  }
  return rows
}

export function isFractionalKeyFor(definition: AnyColumnDefinition | undefined, value: unknown): boolean {
  return definition !== undefined && readsAsInteger(definition) && readFractionalDecimalKey(value) !== undefined
}

export function keysForColumn(keys: readonly unknown[], definition: AnyColumnDefinition | undefined): unknown[] {
  if (!definition || !isNumericKeyColumn(definition)) return [...keys]
  const columnKeys = readsAsInteger(definition) ? keys.filter(key => !isFractionalKeyFor(definition, key)).map(readIntegralDecimalKey) : keys
  return [...new StoredKeySet(columnKeys, { numeric: true })]
}

function columnDefinition(query: TableQueryBuilder<string | TableDefinition>, column: string): AnyColumnDefinition | undefined {
  const table = query.getPlan().source.table
  return table ? ownEntry(table.columns, column) : undefined
}

function isNumericKeyColumn(definition: AnyColumnDefinition | undefined): boolean {
  return definition !== undefined && (definition.kind === 'decimal' || readsAsInteger(definition))
}

export function relationKeyOptions(parentKey: AnyColumnDefinition | undefined, relatedKey: AnyColumnDefinition | undefined): StoredKeyOptions {
  return { numeric: isNumericKeyColumn(parentKey) || isNumericKeyColumn(relatedKey) }
}

export async function retrieveRelation(
  keys: readonly unknown[],
  createQuery: () => ModelQueryBuilder,
  column: string,
  observe = false,
  definition?: AnyColumnDefinition,
): Promise<{ entities: Entity[], plan?: SelectQueryPlan }> {
  if (keys.length === 0) return { entities: [] }
  const observationCount = observe && hasActiveDatabaseDependencyCollector() ? readDatabaseQueryObservationCount() : undefined
  let plan: SelectQueryPlan | undefined
  const entities: Entity[] = []
  const probe = createQuery()
  const columnKeys = keysForColumn(keys, definition ?? columnDefinition(probe.getTableQueryBuilder(), column))
  const paginated = isPaginatedRelationQuery(probe)
  if (typeof observationCount === 'number') plan = probe.getTableQueryBuilder().getPlan()
  for (const [index, chunk] of chunkRelationKeys(columnKeys, paginated).entries()) {
    const query = index === 0 ? probe : createQuery()
    for (const entity of await query.where(column, 'in', chunk).get()) entities.push(entity)
  }
  if (typeof observationCount === 'number') truncateDatabaseQueryObservations(observationCount)
  return { entities, plan }
}

export function indexRelation(entities: readonly Entity[], column: string, options: StoredKeyOptions = {}): StoredKeyMap<Entity> {
  return new StoredKeyMap(entities.map(entity => [entity.get(column as never), entity]), options)
}

export function groupRelation(entities: readonly Entity[], column: string, options: StoredKeyOptions = {}): StoredKeyMap<Entity[]> {
  const grouped = new StoredKeyMap<Entity[]>([], options)
  for (const entity of entities) {
    const key = entity.get(column as never)
    const bucket = grouped.get(key)
    if (bucket) bucket.push(entity)
    else grouped.set(key, [entity])
  }
  return grouped
}

export async function retrievePivotRelation(
  parentKeys: readonly unknown[],
  createPivotQuery: () => TableQueryBuilder<string | TableDefinition>,
  parentColumn: string,
  relatedColumn: string,
  createRelatedQuery: () => ModelQueryBuilder,
  relatedKey: string,
  pivotSelection: readonly string[],
  readPivotRows: (rows: readonly Record<string, unknown>[]) => Record<string, unknown>[],
  keyDefinitions: { readonly parentKey?: AnyColumnDefinition, readonly relatedKey?: AnyColumnDefinition } = {},
): Promise<{ rows: Record<string, unknown>[], related: StoredKeyMap<Entity> }> {
  if (parentKeys.length === 0) return { rows: [], related: new StoredKeyMap() }
  const pivotQuery = createPivotQuery()
  const pivotParentKey = columnDefinition(pivotQuery, parentColumn)
  const pivotKeys = keysForColumn(parentKeys, pivotParentKey ?? keyDefinitions.parentKey)
  const rows = await loadRelationKeyChunks(pivotKeys, false, async chunk => readPivotRows(await createPivotQuery()
    .select(...pivotSelection)
    .where(parentColumn, 'in', chunk)
    .get<Record<string, unknown>>()))
  const keys = distinctStoredKeys(rows.map(row => row[relatedColumn]).filter(value => value != null))
  const { entities } = await retrieveRelation(keys, createRelatedQuery, relatedKey, false, keyDefinitions.relatedKey)
  return { rows, related: indexRelation(entities, relatedKey, relationKeyOptions(keyDefinitions.relatedKey, columnDefinition(pivotQuery, relatedColumn))) }
}
