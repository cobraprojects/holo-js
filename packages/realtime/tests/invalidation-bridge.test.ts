import { randomUUID } from 'node:crypto'
import { expect, it, onTestFinished, vi } from 'vitest'
import { errorReportingInternals, type HoloErrorReportContext } from '@holo-js/kernel/error-reporting'
import { cacheQueryBridgeInternals, configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { query } from '../src'
import { configureRealtimeRuntime, realtimeServerInternals, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'
import { openRealtimeDatabase } from './helpers/native-database'

function remoteInvalidation(dependencies: readonly string[]) {
  return { id: randomUUID(), connectionName: 'main', dependencies }
}

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

  await bridge.receive(remoteInvalidation(['db:main:records']))

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

  await Promise.all(Array.from({ length: 10 }, () => bridge.receive(remoteInvalidation(['db:main:records']))))
  await new Promise(resolve => setTimeout(resolve, 600))

  for (const [name, count] of runs) {
    expect(count - (before.get(name) ?? 0)).toBeLessThanOrEqual(2)
  }
  expect(maxActive).toBeLessThanOrEqual(4)
}, 30_000)

it('limits a sustained remote write loop to about one refresh per 100 ms and always delivers the final state', async () => {
  const { adapter, db } = await openRealtimeDatabase()
  let runs = 0
  let lastScore: unknown
  const sustained = query({
    name: 'records.sustained',
    access: 'public',
    handler: async () => {
      runs += 1
      const score = await db.table('records').where('id', 1).value('score')
      lastScore = score
      return { score }
    },
  })
  await subscribeRealtimeQuery(sustained)
  const before = runs
  const bridge = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()
  const received: Promise<void>[] = []

  for (let value = 1; value <= 50; value += 1) {
    await adapter.execute(`UPDATE records SET score = ${value} WHERE id = 1`)
    received.push(bridge.receive(remoteInvalidation(['db:main:records'])))
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await Promise.all(received)
  await new Promise(resolve => setTimeout(resolve, 400))

  expect(runs - before).toBeLessThanOrEqual(7)
  expect(lastScore).toBe(50)
}, 30_000)

it('keeps a remote refresh after a reset that happens while stuck remote refreshes hold the concurrency slots', async () => {
  const { adapter, db } = await openRealtimeDatabase()
  let blocking = false
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  for (let index = 0; index < 8; index += 1) {
    const stuck = query({
      name: `records.stuck.${index}`,
      access: 'public',
      handler: async () => {
        if (blocking) await gate
        return { records: await db.table('records').orderBy('id').get() }
      },
    })
    await subscribeRealtimeQuery(stuck)
  }
  const bridge = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()
  blocking = true
  void bridge.receive(remoteInvalidation(['db:main:records']))
  await new Promise(resolve => setTimeout(resolve, 100))

  resetRealtimeRuntime()
  configureRealtimeRuntime({ db: () => db })
  let fresh = 0
  let freshScore: unknown
  const freshQuery = query({
    name: 'records.fresh',
    access: 'public',
    handler: async () => {
      fresh += 1
      freshScore = await db.table('records').where('id', 1).value('score')
      return { score: freshScore }
    },
  })
  await subscribeRealtimeQuery(freshQuery)
  const before = fresh
  await adapter.execute('UPDATE records SET score = 77 WHERE id = 1')

  void bridge.receive(remoteInvalidation(['db:main:records']))
  await new Promise(resolve => setTimeout(resolve, 300))
  release()

  expect(fresh - before).toBeGreaterThanOrEqual(1)
  expect(freshScore).toBe(77)
}, 30_000)

it('runs nothing from a refresh queue that a reset cancels, even when the next runtime reuses its subscription keys', async () => {
  const { adapter, db } = await openRealtimeDatabase()
  const runs = new Map<string, number>()
  let blocking = false
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  for (let index = 0; index < 8; index += 1) {
    const name = `records.queued.${index}`
    const queued = query({
      name,
      access: 'public',
      handler: async () => {
        runs.set(name, (runs.get(name) ?? 0) + 1)
        if (blocking) await gate
        return { records: await db.table('records').orderBy('id').get() }
      },
    })
    await subscribeRealtimeQuery(queued)
  }
  runs.clear()
  const bridge = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()
  blocking = true
  void bridge.receive(remoteInvalidation(['db:main:records']))
  await new Promise(resolve => setTimeout(resolve, 100))
  const startedBeforeReset = [...runs.keys()].sort()
  expect(startedBeforeReset.length).toBe(4)

  resetRealtimeRuntime()
  configureRealtimeRuntime({ db: () => db })
  const nextRuns: string[] = []
  for (let index = 0; index < 5; index += 1) {
    const name = `records.next.${index}`
    const nextQuery = query({
      name,
      access: 'public',
      handler: async () => {
        nextRuns.push(name)
        return { records: await db.table('records').orderBy('id').get() }
      },
    })
    await subscribeRealtimeQuery(nextQuery)
  }
  const nextBefore = nextRuns.length
  await adapter.execute('UPDATE records SET score = 88 WHERE id = 1')
  release()
  await new Promise(resolve => setTimeout(resolve, 400))

  expect([...runs.keys()].sort()).toEqual(startedBeforeReset)
  expect(nextRuns.length).toBe(nextBefore)
}, 30_000)

function createGate() {
  let open: () => void = () => undefined
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

it('does not let a refresh that started before a reset hand its slot to the replacement runtime', async () => {
  const { db } = await openRealtimeDatabase()
  let currentGate: ReturnType<typeof createGate> | undefined
  const gated = new Map<string, number>()
  const createGatedQuery = (name: string) => query({
    name,
    access: 'public',
    handler: async () => {
      const gate = currentGate
      if (gate) {
        gated.set(name, (gated.get(name) ?? 0) + 1)
        await gate.promise
      }
      return { records: await db.table('records').orderBy('id').get() }
    },
  })
  const countGated = (names: readonly string[]) => names.reduce((total, name) => total + (gated.get(name) ?? 0), 0)

  const staleNames = Array.from({ length: 5 }, (_, index) => `records.staleSlot.${index}`)
  for (const name of staleNames) {
    await subscribeRealtimeQuery(createGatedQuery(name))
  }
  const staleGate = createGate()
  currentGate = staleGate
  const bridge = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()
  const staleReceived = bridge.receive(remoteInvalidation(['db:main:records']))
  await expect.poll(() => countGated(staleNames), { timeout: 5_000 }).toBe(4)

  resetRealtimeRuntime()
  configureRealtimeRuntime({ db: () => db })
  currentGate = undefined
  const replacementNames = Array.from({ length: 5 }, (_, index) => `records.replacementSlot.${index}`)
  for (const name of replacementNames) {
    await subscribeRealtimeQuery(createGatedQuery(name))
  }
  const replacementGate = createGate()
  currentGate = replacementGate
  const replacementReceived = bridge.receive(remoteInvalidation(['db:main:records']))
  await expect.poll(() => countGated(replacementNames), { timeout: 5_000 }).toBe(4)

  staleGate.open()
  await staleReceived
  expect(countGated(replacementNames)).toBe(4)

  replacementGate.open()
  await replacementReceived
  expect(countGated(replacementNames)).toBe(5)
}, 30_000)

it('cancels a subscription\'s deferred remote refresh when it unsubscribes', async () => {
  const { db } = await openRealtimeDatabase()
  let runs = 0
  const scheduled = query({
    name: 'records.scheduled',
    access: 'public',
    handler: async () => {
      runs += 1
      return { records: await db.table('records').orderBy('id').get() }
    },
  })
  const subscription = await subscribeRealtimeQuery(scheduled)
  const bridge = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()
  await bridge.receive(remoteInvalidation(['db:main:records']))
  expect(runs).toBe(2)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  onTestFinished(() => { vi.useRealTimers() })

  void bridge.receive(remoteInvalidation(['db:main:records']))
  await new Promise(resolve => setImmediate(resolve))
  vi.advanceTimersByTime(10)
  expect(vi.getTimerCount()).toBe(1)
  expect(runs).toBe(2)

  subscription.unsubscribe()

  expect(vi.getTimerCount()).toBe(0)
  vi.advanceTimersByTime(250)
  expect(runs).toBe(2)
}, 30_000)

function createHeldScoreQuery(db: Awaited<ReturnType<typeof openRealtimeDatabase>>['db']) {
  let holdFirst = true
  let release: () => void = () => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  let markRead: () => void = () => undefined
  const read = new Promise<void>(resolve => { markRead = resolve })
  let runs = 0
  const scoreQuery = query({
    name: 'records.heldScore',
    access: 'public',
    handler: async () => {
      runs += 1
      const score = await db.table('records').where('id', 1).value('score')
      if (holdFirst) {
        holdFirst = false
        markRead()
        await gate
      }
      return { score }
    },
  })
  return { scoreQuery, read, release, runs: () => runs }
}

it('refreshes a subscription whose initial query overlapped a remote invalidation for its table', async () => {
  const { adapter, db } = await openRealtimeDatabase()
  const held = createHeldScoreQuery(db)
  const seen: unknown[] = []
  const subscribing = subscribeRealtimeQuery(held.scoreQuery, {}, {
    onData: snapshot => { seen.push((snapshot as unknown as { data: { score: unknown } }).data.score) },
  })
  await held.read
  await adapter.execute('UPDATE records SET score = 77 WHERE id = 1')
  await realtimeServerInternals.createRealtimeDatabaseInvalidationBridge().receive(remoteInvalidation(['db:main:records']))
  held.release()
  await subscribing

  await expect.poll(() => seen.at(-1), { timeout: 5_000 }).toBe(77)
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(held.runs()).toBe(2)
}, 30_000)

it('refreshes a subscription whose initial query overlapped a local write to its table', async () => {
  const { db } = await openRealtimeDatabase()
  const held = createHeldScoreQuery(db)
  const seen: unknown[] = []
  const subscribing = subscribeRealtimeQuery(held.scoreQuery, {}, {
    onData: snapshot => { seen.push((snapshot as unknown as { data: { score: unknown } }).data.score) },
  })
  await held.read
  await db.table('records').where('id', 1).update({ score: 77 })
  held.release()
  await subscribing

  await expect.poll(() => seen.at(-1), { timeout: 5_000 }).toBe(77)
  await new Promise(resolve => setTimeout(resolve, 100))
  expect(held.runs()).toBe(2)
}, 30_000)

function configureFailingCacheIndex(): void {
  const failure = async (): Promise<never> => {
    throw new Error('dependency index unavailable')
  }
  const base = cacheQueryBridgeInternals.createMemoryDependencyIndex()
  configureCacheRuntime({
    config: { default: 'memory', drivers: { memory: { driver: 'memory' } } },
    dependencyIndex: { ...base, listKeys: failure, listDependencies: failure },
  })
  onTestFinished(() => resetCacheRuntime())
}

function captureErrorReports(): Array<{ readonly error: unknown, readonly context: HoloErrorReportContext }> {
  const reports: Array<{ readonly error: unknown, readonly context: HoloErrorReportContext }> = []
  errorReportingInternals.configure({ report: (error, context) => { reports.push({ error, context }) } })
  onTestFinished(() => { errorReportingInternals.configure(undefined) })
  return reports
}

it('still refreshes a live query and reports the error when a remote invalidation fails to evict cached results', async () => {
  const { adapter, db } = await openRealtimeDatabase()
  configureFailingCacheIndex()
  const reports = captureErrorReports()
  const seen: unknown[] = []
  const scoreQuery = query({
    name: 'records.evictionFailure',
    access: 'public',
    handler: async () => ({ score: await db.table('records').where('id', 1).value('score') }),
  })
  await subscribeRealtimeQuery(scoreQuery, {}, {
    onData: snapshot => { seen.push((snapshot as unknown as { data: { score: unknown } }).data.score) },
  })
  await adapter.execute('UPDATE records SET score = 77 WHERE id = 1')

  await realtimeServerInternals.createRealtimeDatabaseInvalidationBridge().receive(remoteInvalidation(['db:main:records']))

  await expect.poll(() => seen.at(-1), { timeout: 5_000 }).toBe(77)
  expect(reports.map(report => (report.error as Error).message)).toContain('dependency index unavailable')
}, 30_000)

it('still refreshes a live query and reports the error when a local write fails to evict cached results', async () => {
  const { db } = await openRealtimeDatabase()
  configureFailingCacheIndex()
  const reports = captureErrorReports()
  const seen: unknown[] = []
  const scoreQuery = query({
    name: 'records.localEvictionFailure',
    access: 'public',
    handler: async () => ({ score: await db.table('records').where('id', 1).value('score') }),
  })
  await subscribeRealtimeQuery(scoreQuery, {}, {
    onData: snapshot => { seen.push((snapshot as unknown as { data: { score: unknown } }).data.score) },
  })

  await db.table('records').where('id', 1).update({ score: 77 })

  await expect.poll(() => seen.at(-1), { timeout: 5_000 }).toBe(77)
  expect(reports.map(report => (report.error as Error).message)).toContain('dependency index unavailable')
}, 30_000)
