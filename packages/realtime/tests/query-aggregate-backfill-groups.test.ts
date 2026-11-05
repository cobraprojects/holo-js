import { describe, expect, it } from 'vitest'
import { createMutationIndexKey, type DatabaseMutationEvent, type PredicateDependencyIndex } from '../src/runtime/dependencies'
import { collectGroupedAggregateQueries, createAggregateColumnsByScope } from '../src/runtime/query-aggregate-backfill-groups'
import type { AggregateBackfillEntry } from '../src/runtime/query-aggregate-common'
import type { BackfillCache, DatabaseQueryObservation } from '../src/runtime/query-state'

function aggregateQuery(column: string, groupId: number, patchable: boolean): DatabaseQueryObservation {
  return {
    aggregate: { column, kind: 'sum' },
    connectionName: 'default',
    dependencies: [],
    orderBy: [],
    patchable,
    predicates: [{ column: 'group_id', operator: '=', value: groupId }],
    selections: [],
    tableName: 'scores',
  }
}

describe('@holo-js/realtime aggregate backfill groups', () => {
  it('leaves aggregates that run again out of shared backfills', () => {
    const amounts = aggregateQuery('amount', 1, true)
    const flags = aggregateQuery('enabled', 2, false)
    const mutation: DatabaseMutationEvent = { connectionName: 'default', kind: 'update', predicates: [], tableName: 'scores' }
    const exactPredicates: PredicateDependencyIndex = new Map([['db:default:scores', new Map([['group_id', new Set(['1', '2'])]])]])
    const backfills = {
      entries: [{ queries: [amounts, flags] }],
      mutations: new Map([[createMutationIndexKey('default', 'scores'), [mutation]]]),
      mutationExactPredicates: new WeakMap([[mutation, exactPredicates]]),
    } as unknown as BackfillCache<AggregateBackfillEntry>

    expect(collectGroupedAggregateQueries(amounts, backfills).queries).toEqual([amounts])
    expect([...createAggregateColumnsByScope(backfills.entries).values()]).toEqual([['amount']])
  })
})
