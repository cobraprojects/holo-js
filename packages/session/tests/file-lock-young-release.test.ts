import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileSessionStore, fileSessionDriverInternals } from '../src'

const tombstoneUnlinks = vi.hoisted((): { attempts: number, gate?: Promise<void> } => ({ attempts: 0 }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>()
  const { createWindowsFsModel } = await import('./support/windows-fs-model.mjs')
  const model = createWindowsFsModel(actual, { freshFileMs: 1_000 })
  return {
    ...actual,
    rename: model.rename,
    rmdir: model.rmdir,
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (String(args[0]).endsWith('.released')) {
        tombstoneUnlinks.attempts += 1
        if (tombstoneUnlinks.gate) await tombstoneUnlinks.gate
      }
      return await model.unlink(...args)
    },
  }
})

// Holds every tombstone removal until the returned function runs. A release that waited on
// removals would never return, so the tests assert the property instead of a wall-clock bound.
function holdTombstoneRemovals(): () => void {
  let open: () => void = () => undefined
  tombstoneUnlinks.gate = new Promise<void>(resolve => { open = resolve })
  return () => {
    tombstoneUnlinks.gate = undefined
    open()
  }
}

let root: string
let recordPath: string

async function leftoverTombstones(): Promise<string[]> {
  return (await readdir(root)).filter(name => name.endsWith('.released'))
}

describe('releasing a freshly created lease under a Windows filesystem', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'holo-file-lock-young-'))
    recordPath = join(root, 'session.json')
    tombstoneUnlinks.attempts = 0
  })

  afterEach(async () => {
    await rm(root, { force: true, recursive: true })
  })

  it('does not block the release on unlinking the young owner file', async () => {
    const openGate = holdTombstoneRemovals()
    try {
      const release = await fileSessionDriverInternals.acquireRecordLock(recordPath, mkdir)
      await release()
      expect(await leftoverTombstones()).toHaveLength(1)
    } finally {
      openGate()
    }
    expect(fileSessionDriverInternals.heldRecordLockTokens.size).toBe(0)
  }, 15_000)

  it('lets the next writer acquire while the released young lease is still being unlinked', async () => {
    const openGate = holdTombstoneRemovals()
    try {
      await (await fileSessionDriverInternals.acquireRecordLock(recordPath, mkdir))()
      const next = await fileSessionDriverInternals.acquireRecordLock(recordPath, mkdir)
      expect(await leftoverTombstones()).toHaveLength(1)
      await next()
    } finally {
      openGate()
    }
  }, 15_000)

  it('bounds the unlink attempts for a burst of releases and removes every tombstone', async () => {
    const releases = 30
    for (let index = 0; index < releases; index += 1) {
      await (await fileSessionDriverInternals.acquireRecordLock(recordPath, mkdir))()
    }

    const deadline = Date.now() + 10_000
    while ((await leftoverTombstones()).length > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    expect(await leftoverTombstones()).toEqual([])
    expect(tombstoneUnlinks.attempts).toBeLessThanOrEqual(releases * 10)
  }, 20_000)

  it('does not wait for queued tombstone removals during a sustained burst, and caps the queue, leaving the overflow for the GC sweep', async () => {
    const openGate = holdTombstoneRemovals()
    const queue = fileSessionDriverInternals.pendingTombstoneRemovals
    let longestQueue = 0
    try {
      for (let index = 0; index < 300; index += 1) {
        const release = await fileSessionDriverInternals.acquireRecordLock(recordPath, mkdir)
        await release()
        longestQueue = Math.max(longestQueue, queue.length)
      }
      expect(await leftoverTombstones()).toHaveLength(300)
    } finally {
      openGate()
    }

    expect(longestQueue).toBeLessThanOrEqual(fileSessionDriverInternals.tombstoneQueueLimit)

    await new Promise(resolve => setTimeout(resolve, 1_100))
    await createFileSessionStore(root).sweepExpired?.(new Date())
    expect(await leftoverTombstones()).toEqual([])
  }, 60_000)
})
