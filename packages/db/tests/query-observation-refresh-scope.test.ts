import { describe, expect, it } from 'vitest'
import { queryCacheInternals, readDatabaseQueryObservationCount, rebindDatabaseQueryObservationResult, recordDatabaseQueryObservation, runRequiringDatabaseQueryRefresh, truncateDatabaseQueryObservations, type DatabaseQueryObservation } from '../src/cache'

function observation(tableName: string): DatabaseQueryObservation {
  return Object.freeze({
    connectionName: 'default',
    dependencies: Object.freeze([`db:default:${tableName}`]),
    orderBy: Object.freeze([]),
    patchable: true,
    predicates: Object.freeze([]),
    selections: Object.freeze([]),
    tableName,
  })
}

describe('refresh-only query observations', () => {
  it('marks only the observations recorded inside the scope, not those of queries finishing concurrently', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      recordDatabaseQueryObservation(observation('before'))
      await Promise.all([
        runRequiringDatabaseQueryRefresh(async () => {
          recordDatabaseQueryObservation(observation('inside_first'))
          await gate
          recordDatabaseQueryObservation(observation('inside_last'))
        }),
        (async () => {
          await Promise.resolve()
          recordDatabaseQueryObservation(observation('concurrent'))
          release()
        })(),
      ])
      recordDatabaseQueryObservation(observation('after'))
    }) as { queries: readonly DatabaseQueryObservation[] }

    expect(result.queries.map(query => [query.tableName, query.patchable, query.serialized === true])).toEqual([
      ['before', true, false],
      ['inside_first', false, true],
      ['concurrent', true, false],
      ['inside_last', false, true],
      ['after', true, false],
    ])
  })

  it('keeps a concurrent query patchable when it reuses a position the scoped load truncated', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let truncated!: () => void
    const truncation = new Promise<void>((resolve) => { truncated = resolve })
    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      await Promise.all([
        runRequiringDatabaseQueryRefresh(async () => {
          recordDatabaseQueryObservation(observation('inside_kept'))
          const count = readDatabaseQueryObservationCount()
          recordDatabaseQueryObservation(observation('inside_truncated'))
          truncateDatabaseQueryObservations(count)
          truncated()
          await gate
        }),
        (async () => {
          await truncation
          recordDatabaseQueryObservation(observation('concurrent'))
          release()
        })(),
      ])
    }) as { queries: readonly DatabaseQueryObservation[] }

    expect(result.queries.map(query => [query.tableName, query.patchable, query.serialized === true])).toEqual([
      ['inside_kept', false, true],
      ['concurrent', true, false],
      ['inside_truncated', false, true],
    ])
  })

  it('keeps refresh-only observations that a later loader truncates, even after rebinding their result', async () => {
    const rows = [{ id: 1 }]
    const rebound = [{ id: 1 }]
    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      recordDatabaseQueryObservation(observation('before'))
      const count = readDatabaseQueryObservationCount()
      await runRequiringDatabaseQueryRefresh(async () => {
        recordDatabaseQueryObservation(Object.freeze({ ...observation('rebound'), result: rows }))
        recordDatabaseQueryObservation(observation('plain'))
      })
      rebindDatabaseQueryObservationResult(rows, rebound)
      recordDatabaseQueryObservation(observation('truncated'))
      truncateDatabaseQueryObservations(count)
    }) as { queries: readonly DatabaseQueryObservation[] }

    expect(result.queries.map(query => [query.tableName, query.patchable, query.serialized === true])).toEqual([
      ['before', true, false],
      ['rebound', false, true],
      ['plain', false, true],
    ])
  })

  it('keeps no result rows on the refresh-only observations a truncation moves', async () => {
    const rows = [{ id: 1 }, { id: 2 }]
    const result = await queryCacheInternals.collectDatabaseQueryDependencies(async () => {
      const count = readDatabaseQueryObservationCount()
      await runRequiringDatabaseQueryRefresh(async () => {
        recordDatabaseQueryObservation(Object.freeze({ ...observation('rows'), result: rows, cursorRows: rows, scalarListRows: rows, resultPath: Object.freeze(['items']) }))
      })
      truncateDatabaseQueryObservations(count)
    }) as { queries: readonly DatabaseQueryObservation[] }

    expect(result.queries).toEqual([Object.freeze({
      connectionName: 'default',
      dependencies: ['db:default:rows'],
      orderBy: [],
      patchable: false,
      predicates: [],
      selections: [],
      serialized: true,
      tableName: 'rows',
    })])
  })

  it('returns the value of the scoped load outside a collector', async () => {
    await expect(runRequiringDatabaseQueryRefresh(async () => 'loaded')).resolves.toBe('loaded')
  })
})
