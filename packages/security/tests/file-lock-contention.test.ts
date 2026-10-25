import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorReportingInternals, type HoloExceptionsConfig } from '@holo-js/kernel/error-reporting'
import { createFileRateLimitStore } from '../src'
import { advanceUntil, useFakeClock } from '../../../tests/support/fake-clock'
import { createMemoryFs, type MemoryFs } from '../../../tests/support/memory-fs'

const memory = vi.hoisted((): { fs?: MemoryFs } => ({}))

vi.mock('node:fs/promises', async () => (await import('../../../tests/support/memory-fs')).memoryFsModule(() => memory.fs))

const root = resolve('/memory/rate-limits')
const now = new Date('2026-04-16T12:00:00.000Z')
const LOCK_TIMEOUT_MS = 200
const WAITERS = 6
const policy = { maxAttempts: 10, decaySeconds: 60 }

let fs: MemoryFs
let reported: unknown[]
let previousExceptions: HoloExceptionsConfig | undefined

function filesUnder(directory: string): string[] {
  return fs.names(directory).flatMap((name) => {
    const path = join(directory, name)
    return fs.names(path).length > 0 ? filesUnder(path) : [path]
  })
}

describe('file rate-limit bucket lock contention', () => {
  beforeEach(() => {
    useFakeClock()
    vi.setSystemTime(now)
    fs = createMemoryFs({ platform: 'posix' })
    memory.fs = fs
    reported = []
    previousExceptions = errorReportingInternals.configure({ report: (error) => { reported.push(error) } })
  })

  afterEach(() => {
    errorReportingInternals.configure(previousExceptions)
    vi.useRealTimers()
    memory.fs = undefined
  })

  it('serializes concurrent waiters reclaiming the same stale bucket lock', async () => {
    const key = 'limiter:login|user:stale-lock-contended'
    const store = createFileRateLimitStore(root, {
      now: () => now,
      lockRetryDelayMs: 1,
      lockTimeoutMs: LOCK_TIMEOUT_MS,
    })
    await store.hit(key, policy)
    const [bucketPath] = filesUnder(join(root, 'buckets'))
    const lockPath = `${bucketPath}.lock`
    await fs.promises.rm(bucketPath!)
    await fs.promises.mkdir(lockPath)
    await fs.promises.utimes(lockPath, now, new Date(now.getTime() - 60_000))

    // Script the race the reclaim must survive. Every waiter sees the stale lock, which has no owner
    // file. The second removal of the lock waits until a waiter holds a live lock, so a waiter that
    // removes the stale lock late would delete the live one. The first holder's bucket write waits
    // for that removal, for at most a few milliseconds, so a second holder would read the bucket
    // before the write lands.
    const liveLockExists = () => fs.names(lockPath).length > 0
    const tick = () => new Promise(resolve => setTimeout(resolve, 1))
    let lockAttempts = 0
    let lockRemovals = 0
    let lateRemovalReleased = false
    let bucketWrites = 0
    fs.addHook(async (operation, path) => {
      if (operation === 'rename' && path.startsWith(`${bucketPath}.`) && ++bucketWrites === 1) {
        const until = Date.now() + 5
        while (!lateRemovalReleased && Date.now() < until) await tick()
      }
      if (path !== lockPath) return
      if (operation === 'mkdir') lockAttempts += 1
      if (operation !== 'rm' || ++lockRemovals !== 2) return
      while (!liveLockExists()) await tick()
      lateRemovalReleased = true
    })

    let settled = false
    const hits = Promise.all(Array.from({ length: WAITERS }, () => store.hit(key, policy))).finally(() => { settled = true })
    hits.catch(() => undefined)
    await advanceUntil(() => settled, `${WAITERS} contended hits`, LOCK_TIMEOUT_MS)
    const results = await hits

    expect(lockAttempts).toBeGreaterThan(WAITERS)
    expect(results.map(hit => hit.snapshot.attempts).sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6])
    expect((await store.hit(key, policy)).snapshot.attempts).toBe(WAITERS + 1)
    expect(reported).toEqual([])
  })
})
