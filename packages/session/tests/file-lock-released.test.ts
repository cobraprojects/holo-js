import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SessionModule from '../src'
import type { WindowsFsState } from './support/windows-fs'

const windowsFs = vi.hoisted((): WindowsFsState => ({ blockedRenameSources: new Set(), blockedUnlinkPrefixes: new Set(), blockedWritePrefixes: new Set(), renameAttempts: new Map() }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>()
  const { windowsFsOverrides } = await import('./support/windows-fs')
  return { ...actual, ...windowsFsOverrides(actual, windowsFs) }
})

type Driver = typeof SessionModule.fileSessionDriverInternals

let root: string
let recordPath: string
let lockPath: string
const reports: unknown[] = []

async function loadProcess(): Promise<Driver> {
  vi.resetModules()
  const { fileSessionDriverInternals } = await import('../src')
  const { errorReportingInternals } = await import('@holo-js/kernel/error-reporting')
  errorReportingInternals.configure({ report: error => { reports.push(error) } })
  return fileSessionDriverInternals
}

describe('released file locks across processes', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'holo-file-lock-released-'))
    recordPath = join(root, 'session.json')
    lockPath = `${recordPath}.lock`
    reports.length = 0
  })

  afterEach(async () => {
    windowsFs.blockedUnlinkPrefixes.clear()
    windowsFs.blockedWritePrefixes.clear()
    await rm(root, { force: true, recursive: true })
  })

  it('leaves the releasing process with no local fallback once the released marker is published', async () => {
    const releasing = await loadProcess()
    const holder = await releasing.acquireRecordLock(recordPath, mkdir)
    windowsFs.blockedUnlinkPrefixes.add(lockPath)
    await holder()
    expect(reports).toHaveLength(1)
    expect(releasing.releasedRecordLocks.size).toBe(0)

    windowsFs.blockedUnlinkPrefixes.clear()
    const successor = await loadProcess()
    const handoff = await successor.acquireRecordLock(recordPath, mkdir)
    await handoff()
    expect(releasing.releasedRecordLocks.size).toBe(0)
    expect(successor.releasedRecordLocks.size).toBe(0)
  }, 15_000)

  it('keeps the local fallback only while the released marker cannot be published, and drops it on reclaim', async () => {
    const releasing = await loadProcess()
    const holder = await releasing.acquireRecordLock(recordPath, mkdir)
    windowsFs.blockedUnlinkPrefixes.add(lockPath)
    windowsFs.blockedWritePrefixes.add(lockPath)
    await holder()
    expect(releasing.releasedRecordLocks.has(lockPath)).toBe(true)

    windowsFs.blockedUnlinkPrefixes.clear()
    windowsFs.blockedWritePrefixes.clear()
    const next = await releasing.acquireRecordLock(recordPath, mkdir)
    await next()
    expect(releasing.releasedRecordLocks.size).toBe(0)
  }, 15_000)

  it('bounds the local fallback however many locks fail to publish', async () => {
    const releasing = await loadProcess()
    const { RELEASED_RECORD_LOCK_LIMIT, rememberReleasedRecordLock, releasedRecordLocks } = releasing
    for (let index = 0; index < RELEASED_RECORD_LOCK_LIMIT * 2; index += 1) {
      rememberReleasedRecordLock(`/locks/${index}.lock`, `token-${index}`)
    }
    expect(releasedRecordLocks.size).toBe(RELEASED_RECORD_LOCK_LIMIT)
    expect(releasedRecordLocks.has('/locks/0.lock')).toBe(false)
  })
})
