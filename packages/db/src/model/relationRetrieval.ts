import { hasActiveDatabaseDependencyCollector, readDatabaseQueryObservationCount, truncateDatabaseQueryObservations } from '../cache'
import { isInlineIntegerValue } from '../query/ast'
import { hasQueryCache } from '../query/TableQueryBuilder'
import { canonicalStoredKey } from './entityRuntime'
import { StoredKeyMap } from './storedKeyCollections'
import type { TableQueryBuilder } from '../query/TableQueryBuilder'
import type { ColumnDefinition, LogicalColumnKind, TableDefinition } from '../schema/types'
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

export async function retrieveRelation(
  keys: readonly unknown[],
  createQuery: () => ModelQueryBuilder,
  column: string,
  observe = false,
): Promise<{ entities: Entity[], plan?: SelectQueryPlan }> {
  if (keys.length === 0) return { entities: [] }
  const observationCount = observe && hasActiveDatabaseDependencyCollector() ? readDatabaseQueryObservationCount() : undefined
  let plan: SelectQueryPlan | undefined
  const entities: Entity[] = []
  const probe = createQuery()
  const paginated = isPaginatedRelationQuery(probe)
  if (typeof observationCount === 'number') plan = probe.getTableQueryBuilder().getPlan()
  for (const [index, chunk] of chunkRelationKeys(keys, paginated).entries()) {
    const query = index === 0 ? probe : createQuery()
    for (const entity of await query.where(column, 'in', chunk).get()) entities.push(entity)
  }
  if (typeof observationCount === 'number') truncateDatabaseQueryObservations(observationCount)
  return { entities, plan }
}

export function indexRelation(entities: readonly Entity[], column: string): StoredKeyMap<Entity> {
  return new StoredKeyMap(entities.map(entity => [entity.get(column as never), entity]))
}

export function groupRelation(entities: readonly Entity[], column: string): StoredKeyMap<Entity[]> {
  const grouped = new StoredKeyMap<Entity[]>()
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
): Promise<{ rows: Record<string, unknown>[], related: StoredKeyMap<Entity> }> {
  if (parentKeys.length === 0) return { rows: [], related: new StoredKeyMap() }
  const rows = await loadRelationKeyChunks(parentKeys, false, chunk => createPivotQuery()
    .select(...pivotSelection)
    .where(parentColumn, 'in', chunk)
    .get<Record<string, unknown>>())
  const keys = distinctStoredKeys(rows.map(row => row[relatedColumn]).filter(value => value != null))
  const { entities } = await retrieveRelation(keys, createRelatedQuery, relatedKey)
  return { rows, related: indexRelation(entities, relatedKey) }
}
