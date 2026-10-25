import type { PathLike } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SessionModule from '../src'
import { advanceTo, advanceUntil, finishesWithoutTheClock, useFakeClock } from '../../../tests/support/fake-clock'
import { busyError, createMemoryFs, type MemoryFs } from '../../../tests/support/memory-fs'

const memory = vi.hoisted((): { fs?: MemoryFs } => ({}))

vi.mock('node:fs/promises', async () => (await import('../../../tests/support/memory-fs')).memoryFsModule(() => memory.fs))
vi.mock('node:timers/promises', async () => (await import('../../../tests/support/fake-clock')).fakeTimersPromises())

const FRESH_FILE_MS = 1_000
const TOMBSTONE_RETRY_BUDGET_MS = 5_000

const root = resolve('/memory/young-release')
const recordPath = join(root, 'session.json')
let fs: MemoryFs
let session: typeof SessionModule
let tombstoneUnlinks: { attempts: number, gate?: Promise<void> }

function holdTombstoneRemovals(): () => void {
  let open: () => void = () => undefined
  tombstoneUnlinks.gate = new Promise<void>(resolve => { open = resolve })
  return () => {
    tombstoneUnlinks.gate = undefined
    open()
  }
}

function leftoverTombstones(): string[] {
  return fs.names(root).filter(name => name.endsWith('.released'))
}

async function makeDirectory(path: PathLike): Promise<undefined> {
  await fs.promises.mkdir(String(path))
  return undefined
}

async function acquireAndRelease(): Promise<void> {
  await (await session.fileSessionDriverInternals.acquireRecordLock(recordPath, makeDirectory))()
}

describe('releasing a freshly created lease under a Windows filesystem', () => {
  beforeEach(async () => {
    useFakeClock()
    fs = createMemoryFs({ platform: 'win32' })
    memory.fs = fs
    tombstoneUnlinks = { attempts: 0 }
    fs.addHook(async (operation, path) => {
      if (operation !== 'unlink') return
      if (path.endsWith('.released')) {
        tombstoneUnlinks.attempts += 1
        if (tombstoneUnlinks.gate) await tombstoneUnlinks.gate
      }
      const born = await fs.promises.stat(path).then(stats => stats.birthtimeMs, () => undefined)
      if (born !== undefined && Date.now() - born < FRESH_FILE_MS) throw busyError('unlink', path)
    })
    await fs.promises.mkdir(root, { recursive: true })
    vi.resetModules()
    session = await import('../src')
  })

  afterEach(() => {
    vi.useRealTimers()
    memory.fs = undefined
  })

  it('does not block the release on unlinking the young owner file', async () => {
    const openGate = holdTombstoneRemovals()
    await finishesWithoutTheClock(acquireAndRelease(), 'Releasing a young lease')
    expect(leftoverTombstones()).toHaveLength(1)
    expect(fs.names(root)).not.toContain('session.json.lock')
    openGate()
  })

  it('lets the next writer acquire while the released young lease is still being unlinked', async () => {
    const openGate = holdTombstoneRemovals()
    await finishesWithoutTheClock(acquireAndRelease(), 'Releasing a young lease')
    const next = await finishesWithoutTheClock(session.fileSessionDriverInternals.acquireRecordLock(recordPath, makeDirectory), 'The next acquisition')
    expect(leftoverTombstones()).toHaveLength(1)
    await next()
    openGate()
  })

  it('bounds the unlink attempts for a burst of releases and removes every tombstone', async () => {
    const releases = 30
    await finishesWithoutTheClock((async () => {
      for (let index = 0; index < releases; index += 1) await acquireAndRelease()
    })(), 'A burst of uncontended releases')
    expect(leftoverTombstones()).toHaveLength(releases)

    await advanceUntil(() => leftoverTombstones().length === 0, 'every tombstone to be removed', TOMBSTONE_RETRY_BUDGET_MS)
    expect(tombstoneUnlinks.attempts).toBeLessThanOrEqual(releases * 10)
  })

  it('does not wait for queued tombstone removals during a sustained burst, and caps the queue, leaving the overflow for the GC sweep', async () => {
    const releases = 300
    const openGate = holdTombstoneRemovals()
    await finishesWithoutTheClock((async () => {
      for (let index = 0; index < releases; index += 1) await acquireAndRelease()
    })(), 'A sustained burst of releases')
    expect(leftoverTombstones()).toHaveLength(releases)
    openGate()

    await advanceUntil(() => leftoverTombstones().length < releases, 'the first queued tombstone removal', TOMBSTONE_RETRY_BUDGET_MS)
    await advanceTo(Date.now() + 2 * TOMBSTONE_RETRY_BUDGET_MS)
    const overflow = leftoverTombstones()
    expect(overflow.length).toBeGreaterThan(0)
    expect(overflow.length).toBeLessThan(releases)
    await advanceTo(Date.now() + 2 * TOMBSTONE_RETRY_BUDGET_MS)
    expect(leftoverTombstones()).toEqual(overflow)

    await session.createFileSessionStore(root).sweepExpired?.(new Date())
    expect(leftoverTombstones()).toEqual([])
  })
})
