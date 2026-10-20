import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileSessionDriverInternals } from '../src'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>()
  const { createWindowsFsModel } = await import('./support/windows-fs-model.mjs')
  const model = createWindowsFsModel(actual, { freshFileMs: 1_000 })
  return { ...actual, rename: model.rename, rmdir: model.rmdir, unlink: model.unlink }
})

let root: string
let recordPath: string

describe('releasing a freshly created lease under a Windows filesystem', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'holo-file-lock-young-'))
    recordPath = join(root, 'session.json')
  })

  afterEach(async () => {
    await rm(root, { force: true, recursive: true })
  })

  it('releases a young lease without waiting on the file system', async () => {
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
})
