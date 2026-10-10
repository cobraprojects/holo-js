import { hasActiveDatabaseDependencyCollector, readDatabaseQueryObservationCount, truncateDatabaseQueryObservations } from '../cache'
import type { TableQueryBuilder } from '../query/TableQueryBuilder'
import type { TableDefinition } from '../schema/types'
import type { SelectQueryPlan } from '../query/ast'
import type { Entity } from './Entity'
import type { ModelQueryBuilder } from './ModelQueryBuilder'

export function collectRelationKeys<TTable extends TableDefinition>(entities: readonly Entity<TTable>[], column: string): unknown[] {
  return [...new Set(entities.map(entity => entity.toAttributes()[column as keyof ReturnType<typeof entity.toAttributes>]).filter(value => value != null))]
}

export async function retrieveRelation(
  keys: readonly unknown[],
  createQuery: () => ModelQueryBuilder,
  column: string,
  observe = false,
): Promise<{ entities: Entity[], plan?: SelectQueryPlan }> {
  if (keys.length === 0) return { entities: [] }
  const observationCount = observe && hasActiveDatabaseDependencyCollector() ? readDatabaseQueryObservationCount() : undefined
  const query = createQuery()
  const plan = typeof observationCount === 'number' ? query.getTableQueryBuilder().getPlan() : undefined
  const entities = await query.where(column, 'in', keys).get()
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
): Promise<{ rows: Record<string, unknown>[], related: Map<unknown, Entity> }> {
  if (parentKeys.length === 0) return { rows: [], related: new Map() }
  const rows = await createPivotQuery().where(parentColumn, 'in', parentKeys).get<Record<string, unknown>>()
  const keys = [...new Set(rows.map(row => row[relatedColumn]).filter(value => value != null))]
  const { entities } = await retrieveRelation(keys, createRelatedQuery, relatedKey)
  return { rows, related: indexRelation(entities, relatedKey) }
}
