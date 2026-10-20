import { expect, it, onTestFinished } from 'vitest'
import { query } from '../src'
import { realtimeServerInternals, subscribeRealtimeQuery } from '../src/server'
import { openRealtimeDatabase } from './helpers/native-database'

it('rejects a remote invalidation whose dependencies are not a list of strings', async () => {
  await openRealtimeDatabase()
  const bridge = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()

  await expect(bridge.receive({ connectionName: 'main', dependencies: 'db:main:records' }))
    .rejects.toThrow('Remote database invalidation payload is malformed.')
})

it('attaches a later bridge without replacing the registered publisher, and a disconnect that never registered leaves it in place', async () => {
  const { db } = await openRealtimeDatabase()
  const published: string[] = []
  const first = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()
  const second = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()
  const disconnectFirst = first.connect(async () => { published.push('first') })
  onTestFinished(() => disconnectFirst())
  const disconnectSecond = second.connect(async () => { published.push('second') })
  disconnectSecond()

  await db.table('records').where('id', 1).update({ score: 1 })

  await expect.poll(() => published).toEqual(['first'])
})

it('refreshes a table-wide and a column-level subscription exactly once for one remote table invalidation', async () => {
  const { db } = await openRealtimeDatabase()
  const runs = { tableWide: 0, columnLevel: 0 }
  const tableWide = query({
    name: 'records.all',
    access: 'public',
    handler: async () => {
      runs.tableWide += 1
      return { records: await db.table('records').orderBy('id').get() }
    },
  })
  const columnLevel = query({
    name: 'records.groupOne',
    access: 'public',
    handler: async () => {
      runs.columnLevel += 1
      return { records: await db.table('records').where('group_id', 1).orderBy('id').get() }
    },
  })
  await subscribeRealtimeQuery(tableWide)
  await subscribeRealtimeQuery(columnLevel)
  const before = { ...runs }
  const bridge = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()

  await bridge.receive({ connectionName: 'main', dependencies: ['db:main:records'] })

  expect(runs.tableWide - before.tableWide).toBe(1)
  expect(runs.columnLevel - before.columnLevel).toBe(1)
})

it('coalesces a burst of remote invalidations for one table and limits concurrent remote refreshes', async () => {
  const { db } = await openRealtimeDatabase()
  const runs = new Map<string, number>()
  let active = 0
  let maxActive = 0
  for (let index = 0; index < 8; index += 1) {
    const name = `records.burst.${index}`
    const burstQuery = query({
      name,
      access: 'public',
      handler: async () => {
        runs.set(name, (runs.get(name) ?? 0) + 1)
        active += 1
        maxActive = Math.max(maxActive, active)
        try {
          await new Promise(resolve => setTimeout(resolve, 25))
          return { records: await db.table('records').orderBy('id').get() }
        } finally {
          active -= 1
        }
      },
    })
    await subscribeRealtimeQuery(burstQuery)
  }
  const before = new Map(runs)
  maxActive = 0
  const bridge = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()

  await Promise.all(Array.from({ length: 10 }, () => bridge.receive({ connectionName: 'main', dependencies: ['db:main:records'] })))
  await new Promise(resolve => setTimeout(resolve, 600))

  for (const [name, count] of runs) {
    expect(count - (before.get(name) ?? 0)).toBeLessThanOrEqual(2)
  }
  expect(maxActive).toBeLessThanOrEqual(4)
}, 30_000)
