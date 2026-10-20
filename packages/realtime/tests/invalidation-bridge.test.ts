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
