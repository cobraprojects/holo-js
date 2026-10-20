import { expect, it, onTestFinished } from 'vitest'
import { realtimeServerInternals } from '../src/server'
import { openRealtimeDatabase } from './helpers/native-database'

it('rejects a remote invalidation whose metadata is malformed instead of dropping the batch it joins', async () => {
  await openRealtimeDatabase()
  const bridge = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()

  await expect(bridge.receive({ connectionName: 'main', dependencies: ['db:main:records'], metadata: {} }))
    .rejects.toThrow('Remote database invalidation payload is malformed.')
})

it('leaves the current publisher in place when a bridge that was replaced disconnects', async () => {
  const { db } = await openRealtimeDatabase()
  const published: string[] = []
  const first = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()
  const second = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()
  const disconnectFirst = first.connect(async () => { published.push('first') })
  onTestFinished(() => disconnectFirst())
  const disconnectSecond = second.connect(async () => { published.push('second') })
  onTestFinished(() => disconnectSecond())

  disconnectFirst()
  await db.table('records').where('id', 1).update({ score: 1 })

  await expect.poll(() => published).toEqual(['second'])
})
