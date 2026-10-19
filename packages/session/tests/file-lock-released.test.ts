import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SessionModule from '../src'
import type { WindowsFsState } from './support/windows-fs'

const windowsFs = vi.hoisted((): WindowsFsState => ({ blockedRenameSources: new Set(), blockedUnlinkPrefixes: new Set(), blockedWritePrefixes: new Set(), ioErrorOpenPrefixes: new Set(), ioErrorUnlinkPrefixes: new Set(), renameAttempts: new Map() }))

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

  it('reclaims through the published released marker and keeps no state in the releasing process', async () => {
    const releasing = await loadProcess()
    const holder = await releasing.acquireRecordLock(recordPath, mkdir)
    windowsFs.blockedUnlinkPrefixes.add(lockPath)
    await holder()
    expect(reports).toHaveLength(1)
    expect(releasing.heldRecordLockTokens.size).toBe(0)

    windowsFs.blockedUnlinkPrefixes.clear()
    const successor = await loadProcess()
    await (await successor.acquireRecordLock(recordPath, mkdir))()
    expect(successor.heldRecordLockTokens.size).toBe(0)
  }, 15_000)

  it('reclaims its own lease after the release could neither unlink nor publish, and keeps no state', async () => {
    const owner = await loadProcess()
    const holder = await owner.acquireRecordLock(recordPath, mkdir)
    windowsFs.blockedUnlinkPrefixes.add(lockPath)
    windowsFs.blockedWritePrefixes.add(lockPath)
    await holder()
    expect(owner.heldRecordLockTokens.size).toBe(0)
    expect(await readdir(lockPath)).toHaveLength(1)

    windowsFs.blockedUnlinkPrefixes.clear()
    windowsFs.blockedWritePrefixes.clear()
    await (await owner.acquireRecordLock(recordPath, mkdir))()
    expect(owner.heldRecordLockTokens.size).toBe(0)
  }, 15_000)

  it('keeps every lease reclaimable by its owner after more than 1,024 failed releases', async () => {
    const owner = await loadProcess()
    const paths = Array.from({ length: 1_025 }, (_, index) => join(root, `session-${index}.json`))
    const holders: Array<() => Promise<void>> = []
    for (const path of paths) holders.push(await owner.acquireRecordLock(path, mkdir))

    windowsFs.blockedUnlinkPrefixes.add(root)
    windowsFs.blockedWritePrefixes.add(root)
    await Promise.all(holders.map(release => release()))
    expect(owner.heldRecordLockTokens.size).toBe(0)

    windowsFs.blockedUnlinkPrefixes.clear()
    windowsFs.blockedWritePrefixes.clear()
    for (const path of paths) await (await owner.acquireRecordLock(path, mkdir))()
    expect(owner.heldRecordLockTokens.size).toBe(0)
  }, 60_000)

  it('an I/O error on unlink rejects the release, keeps no held state, and the owner reclaims after recovery', async () => {
    const owner = await loadProcess()
    const holder = await owner.acquireRecordLock(recordPath, mkdir)
    windowsFs.ioErrorUnlinkPrefixes.add(lockPath)
    windowsFs.blockedWritePrefixes.add(lockPath)
    await expect(holder()).rejects.toMatchObject({ code: 'EIO' })
    expect(owner.heldRecordLockTokens.size).toBe(0)
    expect(await readdir(lockPath)).toHaveLength(1)

    windowsFs.ioErrorUnlinkPrefixes.clear()
    windowsFs.blockedWritePrefixes.clear()
    await (await owner.acquireRecordLock(recordPath, mkdir))()
    expect(owner.heldRecordLockTokens.size).toBe(0)
  }, 15_000)

  it('an I/O error during acquisition, after the token is held, leaves no held state', async () => {
    const owner = await loadProcess()
    windowsFs.ioErrorOpenPrefixes.add(root)
    await expect(owner.acquireRecordLock(recordPath, mkdir)).rejects.toMatchObject({ code: 'EIO' })
    expect(owner.heldRecordLockTokens.size).toBe(0)

    windowsFs.ioErrorOpenPrefixes.clear()
    await (await owner.acquireRecordLock(recordPath, mkdir))()
    expect(owner.heldRecordLockTokens.size).toBe(0)
  }, 15_000)

  it('reports that other processes must wait when the release cannot be published, and schedules one retry', async () => {
    const owner = await loadProcess()
    const holder = await owner.acquireRecordLock(recordPath, mkdir)
    windowsFs.blockedUnlinkPrefixes.add(lockPath)
    windowsFs.blockedWritePrefixes.add(lockPath)
    await holder()

    expect(reports).toHaveLength(1)
    expect((reports[0] as Error).message).toContain('other processes may wait until this process reclaims the lease or exits')
    expect(owner.pendingRecordLockReleaseRetries.size).toBe(1)
    windowsFs.blockedUnlinkPrefixes.clear()
    windowsFs.blockedWritePrefixes.clear()
    await Promise.all(owner.pendingRecordLockReleaseRetries)
  }, 15_000)

  it('lets another process reclaim the lease once a scheduled retry publishes the release', async () => {
    const owner = await loadProcess()
    const holder = await owner.acquireRecordLock(recordPath, mkdir)
    windowsFs.blockedUnlinkPrefixes.add(lockPath)
    windowsFs.blockedWritePrefixes.add(lockPath)
    await holder()

    windowsFs.blockedWritePrefixes.clear()
    await Promise.all(owner.pendingRecordLockReleaseRetries)
    expect(owner.pendingRecordLockReleaseRetries.size).toBe(0)

    windowsFs.blockedUnlinkPrefixes.clear()
    const other = await loadProcess()
    await (await other.acquireRecordLock(recordPath, mkdir))()
    expect(other.heldRecordLockTokens.size).toBe(0)
  }, 15_000)

  it('does not reclaim a lease its own process still holds', async () => {
    const owner = await loadProcess()
    const holder = await owner.acquireRecordLock(recordPath, mkdir)
    expect(owner.heldRecordLockTokens.size).toBe(1)

    await expect(owner.acquireRecordLock(recordPath, mkdir)).rejects.toThrow('Timed out acquiring file session lock')
    expect(owner.heldRecordLockTokens.size).toBe(1)

    await holder()
    expect(owner.heldRecordLockTokens.size).toBe(0)
  }, 15_000)

  it('does not mistake a live lease from another instance with the same PID for its own', async () => {
    const other = await loadProcess()
    expect(other.heldRecordLockTokens.size).toBe(0)
    const token = randomUUID()
    await mkdir(lockPath)
    await writeFile(join(lockPath, `owner.${token}.json`), JSON.stringify({ host: hostname(), pid: process.pid, processToken: randomUUID(), token }))

    await expect(other.acquireRecordLock(recordPath, mkdir)).rejects.toThrow('Timed out acquiring file session lock')
    expect(other.heldRecordLockTokens.size).toBe(0)
  }, 15_000)
})
