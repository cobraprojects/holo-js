import { expect, it, onTestFinished } from 'vitest'
import { realtimeServerInternals } from '../src/server'
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
