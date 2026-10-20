import { hasActiveDatabaseDependencyCollector, readDatabaseQueryObservationCount, truncateDatabaseQueryObservations } from '../cache'
import type { TableQueryBuilder } from '../query/TableQueryBuilder'
import type { TableDefinition } from '../schema/types'
import type { SelectQueryPlan } from '../query/ast'
import type { Entity } from './Entity'
import type { ModelQueryBuilder } from './ModelQueryBuilder'

const RELATION_KEY_CHUNK_SIZE = 256

export function collectRelationKeys<TTable extends TableDefinition>(entities: readonly Entity<TTable>[], column: string): unknown[] {
  return [...new Set(entities.map(entity => entity.toAttributes()[column as keyof ReturnType<typeof entity.toAttributes>]).filter(value => value != null))]
}

function chunkRelationKeys(keys: readonly unknown[]): unknown[][] {
  const chunks: unknown[][] = []
  for (let offset = 0; offset < keys.length; offset += RELATION_KEY_CHUNK_SIZE) {
    const chunk = keys.slice(offset, offset + RELATION_KEY_CHUNK_SIZE)
    const width = 2 ** Math.ceil(Math.log2(chunk.length))
    const padding = Array.from({ length: width - chunk.length }, () => chunk[chunk.length - 1])
    chunks.push([...chunk, ...padding])
  }
  return chunks
}

export async function loadRelationKeyChunks<TRow>(
  keys: readonly unknown[],
  load: (chunk: readonly unknown[]) => Promise<readonly TRow[]>,
): Promise<TRow[]> {
  const rows: TRow[] = []
  for (const chunk of chunkRelationKeys(keys)) {
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
  for (const chunk of chunkRelationKeys(keys)) {
    const query = createQuery()
    if (typeof observationCount === 'number' && !plan) plan = query.getTableQueryBuilder().getPlan()
    for (const entity of await query.where(column, 'in', chunk).get()) entities.push(entity)
  }
  if (typeof observationCount === 'number') truncateDatabaseQueryObservations(observationCount)
  return { entities, plan }
}

export function indexRelation(entities: readonly Entity[], column: string): Map<unknown, Entity> {
  return new Map(entities.map(entity => [entity.get(column as never), entity]))
}

export function groupRelation(entities: readonly Entity[], column: string): Map<unknown, Entity[]> {
  const grouped = new Map<unknown, Entity[]>()
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
): Promise<{ rows: Record<string, unknown>[], related: Map<unknown, Entity> }> {
  if (parentKeys.length === 0) return { rows: [], related: new Map() }
  const rows = await loadRelationKeyChunks(parentKeys, chunk => createPivotQuery()
    .select(...pivotSelection)
    .where(parentColumn, 'in', chunk)
    .get<Record<string, unknown>>())
  const keys = [...new Set(rows.map(row => row[relatedColumn]).filter(value => value != null))]
  const { entities } = await retrieveRelation(keys, createRelatedQuery, relatedKey)
  return { rows, related: indexRelation(entities, relatedKey) }
}
