import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SessionModule from '../src'
import type { WindowsFsState } from './support/windows-fs'

const windowsFs = vi.hoisted((): WindowsFsState => ({ blockedRenamePrefixes: new Set(), blockedRenameSources: new Set(), blockedUnlinkPrefixes: new Set(), blockedWritePrefixes: new Set(), ioErrorOpenPrefixes: new Set(), ioErrorRenamePrefixes: new Set(), ioErrorUnlinkPrefixes: new Set(), renameAttempts: new Map(), writeAttempts: new Map() }))
const tornLeaseReads = vi.hoisted(() => ({ armed: false }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>()
  const { windowsFsOverrides } = await import('./support/windows-fs')
  return {
    ...actual,
    ...windowsFsOverrides(actual, windowsFs),
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const contents = await actual.readFile(...args)
      if (!tornLeaseReads.armed || !String(args[0]).includes('owner.')) return contents
      tornLeaseReads.armed = false
      return String(contents).replace(/[^\n]/g, ' ')
    },
  }
})

type Driver = typeof SessionModule.fileSessionDriverInternals

let root: string
let recordPath: string
let lockPath: string
const reports: unknown[] = []

function leasePrefix(path: string): string {
  return join(path, 'owner.')
}

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
    windowsFs.writeAttempts!.clear()
  })

  afterEach(async () => {
    windowsFs.blockedRenamePrefixes.clear()
    windowsFs.blockedUnlinkPrefixes.clear()
    windowsFs.blockedWritePrefixes.clear()
    windowsFs.ioErrorRenamePrefixes.clear()
    windowsFs.ioErrorUnlinkPrefixes.clear()
    await rm(root, { force: true, recursive: true })
  })

  it('reclaims through the published released marker and keeps no state in the releasing process', async () => {
    const releasing = await loadProcess()
    const holder = await releasing.acquireRecordLock(recordPath, mkdir)
    windowsFs.blockedRenamePrefixes.add(leasePrefix(lockPath))
    await holder()
    expect(reports).toHaveLength(1)
    expect(releasing.heldRecordLockTokens.size).toBe(0)

    windowsFs.blockedRenamePrefixes.clear()
    const successor = await loadProcess()
    await (await successor.acquireRecordLock(recordPath, mkdir))()
    expect(successor.heldRecordLockTokens.size).toBe(0)
  }, 15_000)

  it('reclaims its own lease after the release could neither move it aside nor publish, and keeps no state', async () => {
    const owner = await loadProcess()
    const holder = await owner.acquireRecordLock(recordPath, mkdir)
    windowsFs.blockedRenamePrefixes.add(leasePrefix(lockPath))
    windowsFs.blockedWritePrefixes.add(lockPath)
    await holder()
    expect(owner.heldRecordLockTokens.size).toBe(0)
    expect(await readdir(lockPath)).toHaveLength(1)

    windowsFs.blockedRenamePrefixes.clear()
    windowsFs.blockedWritePrefixes.clear()
    await (await owner.acquireRecordLock(recordPath, mkdir))()
    expect(owner.heldRecordLockTokens.size).toBe(0)
  }, 15_000)

  it('keeps every lease reclaimable by its owner after failed releases, with no state beyond one retry each', async () => {
    const owner = await loadProcess()
    const paths = Array.from({ length: 3 }, (_, index) => join(root, `session-${index}.json`))
    const holders: Array<() => Promise<void>> = []
    for (const path of paths) holders.push(await owner.acquireRecordLock(path, mkdir))

    for (const path of paths) windowsFs.blockedRenamePrefixes.add(leasePrefix(`${path}.lock`))
    windowsFs.blockedWritePrefixes.add(root)
    await Promise.all(holders.map(release => release()))
    expect(owner.heldRecordLockTokens.size).toBe(0)
    expect(owner.pendingRecordLockReleaseRetries.size).toBe(paths.length)

    await Promise.all(owner.pendingRecordLockReleaseRetries)
    expect(owner.pendingRecordLockReleaseRetries.size).toBe(0)

    windowsFs.blockedRenamePrefixes.clear()
    windowsFs.blockedWritePrefixes.clear()
    for (const path of paths) await (await owner.acquireRecordLock(path, mkdir))()
    expect(owner.heldRecordLockTokens.size).toBe(0)
    expect(owner.pendingRecordLockReleaseRetries.size).toBe(0)
  }, 15_000)

  it('an I/O error while moving the lease aside rejects the release, keeps no held state, and the owner reclaims after recovery', async () => {
    const owner = await loadProcess()
    const holder = await owner.acquireRecordLock(recordPath, mkdir)
    windowsFs.ioErrorRenamePrefixes.add(leasePrefix(lockPath))
    windowsFs.blockedWritePrefixes.add(lockPath)
    await expect(holder()).rejects.toMatchObject({ code: 'EIO' })
    expect(owner.heldRecordLockTokens.size).toBe(0)
    expect(await readdir(lockPath)).toHaveLength(1)

    windowsFs.ioErrorRenamePrefixes.clear()
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

  it('reports that other processes must wait once the release retries stop publishing it', async () => {
    const owner = await loadProcess()
    const holder = await owner.acquireRecordLock(recordPath, mkdir)
    windowsFs.blockedRenamePrefixes.add(leasePrefix(lockPath))
    windowsFs.blockedWritePrefixes.add(lockPath)
    await holder()

    expect(owner.pendingRecordLockReleaseRetries.size).toBe(1)
    await Promise.all(owner.pendingRecordLockReleaseRetries)
    expect(reports).toHaveLength(1)
    expect((reports[0] as Error).message).toContain('other processes may wait until this process reclaims the lease or exits')
    windowsFs.blockedRenamePrefixes.clear()
    windowsFs.blockedWritePrefixes.clear()
  }, 15_000)

  it('lets another process reclaim the lease once a scheduled retry publishes the release', async () => {
    const owner = await loadProcess()
    const holder = await owner.acquireRecordLock(recordPath, mkdir)
    windowsFs.blockedRenamePrefixes.add(leasePrefix(lockPath))
    windowsFs.blockedWritePrefixes.add(lockPath)
    await holder()

    windowsFs.blockedWritePrefixes.clear()
    await Promise.all(owner.pendingRecordLockReleaseRetries)
    expect(owner.pendingRecordLockReleaseRetries.size).toBe(0)

    windowsFs.blockedRenamePrefixes.clear()
    const other = await loadProcess()
    await (await other.acquireRecordLock(recordPath, mkdir))()
    expect(other.heldRecordLockTokens.size).toBe(0)
  }, 15_000)

  it('does not hold the releasing call while the publish of a busy lease keeps failing', async () => {
    const owner = await loadProcess()
    const holder = await owner.acquireRecordLock(recordPath, mkdir)
    windowsFs.blockedRenamePrefixes.add(leasePrefix(lockPath))
    windowsFs.blockedWritePrefixes.add(lockPath)
    await holder()

    const leaseWriteAttempts = [...windowsFs.writeAttempts!].filter(([path]) => path.startsWith(leasePrefix(lockPath))).reduce((total, [, count]) => total + count, 0)
    expect(leaseWriteAttempts).toBeLessThanOrEqual(3)
    windowsFs.blockedRenamePrefixes.clear()
    windowsFs.blockedWritePrefixes.clear()
    await Promise.all(owner.pendingRecordLockReleaseRetries)
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

  it('takes over when a waiter first reads a torn released lease at its final size', async () => {
    const owner = await loadProcess()
    const holder = await owner.acquireRecordLock(recordPath, mkdir)
    const waiter = owner.acquireRecordLock(recordPath, mkdir)
    await new Promise(resolve => setTimeout(resolve, 200))
    tornLeaseReads.armed = true
    windowsFs.blockedRenamePrefixes.add(leasePrefix(lockPath))
    windowsFs.blockedUnlinkPrefixes.add(lockPath)
    await holder()
    windowsFs.blockedRenamePrefixes.clear()
    windowsFs.blockedUnlinkPrefixes.clear()

    const release = await waiter
    expect(tornLeaseReads.armed).toBe(false)
    await release()
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
