import { column, defineGeneratedTable } from '@holo-js/db'
import { describe, expect, it } from 'vitest'
import type { DatabaseMutationEvent } from '../src/runtime/dependencies'
import { readMutationsForQuery } from '../src/runtime/query-backfill'
import type { DatabaseQueryObservation } from '../src/runtime/query-state'
import type { BackfillCache } from '../src/runtime/state'

describe('@holo-js/realtime mutation reads', () => {
  it('reads each mutation through the definition of its own connection when two connections share a table name', () => {
    const parentItems = defineGeneratedTable('items', { id: column.id(), enabled: column.integer() })
    const relatedItems = defineGeneratedTable('items', { id: column.id(), enabled: column.boolean() })
    const query: DatabaseQueryObservation = {
      connectionName: 'primary',
      dependencies: [],
      orderBy: [],
      patchable: true,
      predicates: [],
      relatedHydrations: [{
        foreignKey: 'item_id',
        kind: 'hasMany',
        localKey: 'id',
        orderBy: [],
        predicates: [],
        relationKey: 'children',
        relatedConnectionName: 'secondary',
        relatedTable: relatedItems,
        relatedTableName: 'items',
      }],
      selections: [],
      table: parentItems,
      tableName: 'items',
    }
    const parentUpdate: DatabaseMutationEvent = { connectionName: 'primary', kind: 'update', predicates: [], rows: [{ id: 1, enabled: 1 }], tableName: 'items' }
    const relatedUpdate: DatabaseMutationEvent = { connectionName: 'secondary', kind: 'update', predicates: [], rows: [{ id: 1, enabled: 1 }], tableName: 'items' }
    const backfills = { mutationExactPredicates: new WeakMap() } as unknown as BackfillCache

    const read = readMutationsForQuery(query, [parentUpdate, relatedUpdate], backfills)

    expect(read?.map(mutation => mutation.rows)).toEqual([[{ id: 1, enabled: 1 }], [{ id: 1, enabled: true }]])
  })
})
