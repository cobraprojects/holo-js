import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { errorReportingInternals, type HoloErrorReportContext } from '@holo-js/kernel/error-reporting'
import { fileSessionDriverInternals } from '../src'

const faults = vi.hoisted(() => ({ rmdir: 0, unlink: false, windowsDirectoryRename: false }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      if (faults.unlink) {
        throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' })
      }
      return await actual.unlink(...args)
    },
    rename: async (source: string, target: string) => {
      if (faults.windowsDirectoryRename && await actual.stat(target).then(value => value.isDirectory(), () => false)) {
        throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
      }
      return await actual.rename(source, target)
    },
    rmdir: async (...args: Parameters<typeof actual.rmdir>) => {
      if (faults.rmdir > 0) {
        faults.rmdir -= 1
        throw Object.assign(new Error('EPERM: operation not permitted, rmdir'), { code: 'EPERM' })
      }
      return await actual.rmdir(...args)
    },
  }
})

async function createRecordPath() {
  const root = await mkdtemp(join(tmpdir(), 'holo-file-lock-busy-'))
  onTestFinished(() => rm(root, { force: true, recursive: true }))
  return { root, recordPath: join(root, `${randomUUID()}.json`) }
}

beforeEach(() => {
  faults.windowsDirectoryRename = true
})

afterEach(() => {
  faults.rmdir = 0
  faults.unlink = false
  faults.windowsDirectoryRename = false
})

describe('file session lock reclamation under busy file errors', () => {
  it('reclaims an empty lock directory without waiting for the stale interval', async () => {
    const { recordPath } = await createRecordPath()
    await mkdir(`${recordPath}.lock`)
    const started = Date.now()
    const release = await fileSessionDriverInternals.acquireRecordLock(recordPath, mkdir)
    expect(Date.now() - started).toBeLessThan(2_000)
    await release()
  }, 15_000)

  it('retries a transient busy error while removing a stale lock', async () => {
    const { recordPath } = await createRecordPath()
    const lockPath = `${recordPath}.lock`
    const token = randomUUID()
    await mkdir(lockPath)
    await writeFile(join(lockPath, `owner.${token}.json`), JSON.stringify({ host: hostname(), pid: 2_147_483_640, token }))
    faults.rmdir = 1
    const started = Date.now()
    const release = await fileSessionDriverInternals.acquireRecordLock(recordPath, mkdir)
    expect(Date.now() - started).toBeLessThan(2_000)
    await release()
  }, 15_000)

  it('reports a release that cannot remove its owner file and lets a later acquire in the same process reclaim the lock', async () => {
    const reports: Array<{ error: unknown, context: HoloErrorReportContext }> = []
    errorReportingInternals.configure({ report: (error, context) => { reports.push({ error, context }) } })
    onTestFinished(() => { errorReportingInternals.configure(undefined) })
    const { recordPath } = await createRecordPath()
    const release = await fileSessionDriverInternals.acquireRecordLock(recordPath, mkdir)
    faults.unlink = true
    await release()
    faults.unlink = false
    expect(reports).toEqual([{ error: expect.any(Error), context: { capability: 'session', operation: 'file.releaseLock' } }])
    const started = Date.now()
    const next = await fileSessionDriverInternals.acquireRecordLock(recordPath, mkdir)
    expect(Date.now() - started).toBeLessThan(2_000)
    await next()
  }, 15_000)
})
