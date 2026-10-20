import { expect, it, onTestFinished } from 'vitest'
import { realtimeServerInternals } from '../src/server'
import { openRealtimeDatabase } from './helpers/native-database'

it('rejects a remote invalidation whose metadata is malformed instead of dropping the batch it joins', async () => {
  await openRealtimeDatabase()
  const bridge = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()

  await expect(bridge.receive({ connectionName: 'main', dependencies: ['db:main:records'], metadata: {} }))
    .rejects.toThrow('Remote database invalidation payload is malformed.')
})

it('keeps the publisher of a running bridge when another bridge in the same process disconnects', async () => {
  const { db } = await openRealtimeDatabase()
  const published: unknown[] = []
  const first = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()
  const second = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()
  const disconnectFirst = first.connect(async invalidation => { published.push(['first', invalidation]) })
  onTestFinished(() => disconnectFirst())
  const disconnectSecond = second.connect(async invalidation => { published.push(['second', invalidation]) })

  disconnectSecond()
  await db.table('records').where('id', 1).update({ score: 1 })

  await expect.poll(() => published.map(entry => (entry as [string])[0])).toEqual(['first'])
})
