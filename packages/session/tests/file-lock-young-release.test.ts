import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileSessionDriverInternals } from '../src'

const tombstoneUnlinks = vi.hoisted(() => ({ attempts: 0 }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>()
  const { createWindowsFsModel } = await import('./support/windows-fs-model.mjs')
  const model = createWindowsFsModel(actual, { freshFileMs: 1_000 })
  return {
    ...actual,
    rename: model.rename,
    rmdir: model.rmdir,
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (String(args[0]).endsWith('.released')) tombstoneUnlinks.attempts += 1
      return await model.unlink(...args)
    },
  }
})

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
    const release = await fileSessionDriverInternals.acquireRecordLock(recordPath, mkdir)
    const started = Date.now()
    await release()
    expect(Date.now() - started).toBeLessThan(250)
    expect(fileSessionDriverInternals.heldRecordLockTokens.size).toBe(0)
  }, 15_000)

  it('lets the next writer acquire immediately after a young lease is released', async () => {
    await (await fileSessionDriverInternals.acquireRecordLock(recordPath, mkdir))()
    const started = Date.now()
    const next = await fileSessionDriverInternals.acquireRecordLock(recordPath, mkdir)
    expect(Date.now() - started).toBeLessThan(250)
    await next()
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
})
