import { describe, expect, it } from 'vitest'
import { createBackfillQueryKey } from '../src/runtime/query-metadata'
import type { DatabaseQueryObservation } from '../src/runtime/query-state'

function observation(readRow?: DatabaseQueryObservation['readRow']): DatabaseQueryObservation {
  return Object.freeze({
    connectionName: 'main',
    dependencies: [],
    orderBy: [{ column: 'id', direction: 'asc' as const }],
    patchable: true,
    predicates: [],
    readRow,
    tableName: 'posts',
  })
}

describe('backfill cache keys for converted rows', () => {
  it('shares raw backfills and scopes converted backfills to each subscription', () => {
    const readRow = (row: Readonly<Record<string, unknown>>) => row

    expect(createBackfillQueryKey(observation(), 1, 1)).toBe(createBackfillQueryKey(observation(), 1, 1))
    expect(createBackfillQueryKey(observation(readRow), 1, 1)).not.toBe(createBackfillQueryKey(observation(readRow), 1, 1))
  })
})
