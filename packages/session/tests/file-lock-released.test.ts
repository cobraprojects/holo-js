import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SessionModule from '../src'
import type { WindowsFsState } from './support/windows-fs'

const windowsFs = vi.hoisted((): WindowsFsState => ({ blockedRenamePrefixes: new Set(), blockedRenameSources: new Set(), blockedUnlinkPrefixes: new Set(), blockedWritePrefixes: new Set(), ioErrorOpenPrefixes: new Set(), ioErrorRenamePrefixes: new Set(), ioErrorUnlinkPrefixes: new Set(), renameAttempts: new Map(), writeAttempts: new Map() }))
const tornLeaseReads = vi.hoisted(() => ({ armed: false, ownerReads: 0 }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>()
  const { windowsFsOverrides } = await import('./support/windows-fs')
  return {
    ...actual,
    ...windowsFsOverrides(actual, windowsFs),
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const contents = await actual.readFile(...args)
      if (!String(args[0]).includes('owner.')) return contents
      tornLeaseReads.ownerReads += 1
      if (!tornLeaseReads.armed || !String(contents).includes('"released":true')) return contents
      tornLeaseReads.armed = false
      return String(contents).replace(/[^\n]/g, ' ')
    },
  }
})

type SessionApi = typeof SessionModule
type AtomicStore = Omit<SessionModule.SessionStore, 'flash' | 'take'> & Required<Pick<SessionModule.SessionStore, 'flash' | 'take'>>

const WAIT_TIMEOUT_MS = 4_000

let root: string
let recordPath: string
let lockPath: string
const reports: unknown[] = []

function leasePrefix(path: string): string {
  return join(path, 'owner.')
}

function lockPathFor(sessionId: string): string {
  return `${join(root, `${sessionId}.json`)}.lock`
}

function sessionRecord(id: string): SessionModule.SessionRecord {
  const now = new Date()
  return { id, store: 'file', data: {}, createdAt: now, lastActivityAt: now, expiresAt: new Date(now.getTime() + 60_000) }
}

async function loadProcess(): Promise<SessionApi> {
  vi.resetModules()
  const session = await import('../src')
  const { errorReportingInternals } = await import('@holo-js/kernel/error-reporting')
  errorReportingInternals.configure({ report: error => { reports.push(error) } })
  return session
}

async function openStore(session: SessionApi): Promise<AtomicStore> {
  const store = session.createFileSessionStore(root)
  const { flash, take } = store
  if (!flash || !take) throw new Error('File sessions must support atomic flash and take')
  return { ...store, flash, take }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function isAbsent(path: string): Promise<boolean> {
  return await readdir(path).then(() => false, isMissing)
}

async function publishedAsReleased(lock: string): Promise<boolean> {
  const leaseName = (await readdir(lock).catch((): string[] => [])).find(name => name.startsWith('owner.'))
  return leaseName !== undefined && (await readFile(join(lock, leaseName), 'utf8')).includes('"released":true')
}

async function waitFor(description: string, condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`)
    await delay(5)
  }
}

function clearFilesystemFaults(): void {
  windowsFs.blockedRenamePrefixes.clear()
  windowsFs.blockedUnlinkPrefixes.clear()
  windowsFs.blockedWritePrefixes.clear()
  windowsFs.ioErrorOpenPrefixes.clear()
  windowsFs.ioErrorRenamePrefixes.clear()
  windowsFs.ioErrorUnlinkPrefixes.clear()
}

describe('released file locks across processes', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'holo-file-lock-released-'))
    recordPath = join(root, 'session.json')
    lockPath = `${recordPath}.lock`
    reports.length = 0
    tornLeaseReads.armed = false
    tornLeaseReads.ownerReads = 0
  })

  afterEach(async () => {
    clearFilesystemFaults()
    await rm(root, { force: true, recursive: true })
  })

  it('a second store on the same root completes its flash after the first store releases the lock', async () => {
    const firstStore = await openStore(await loadProcess())
    const secondStore = await openStore(await loadProcess())
    await firstStore.write(sessionRecord('session'))

    await Promise.all([firstStore.flash('session', 'first', 1), secondStore.flash('session', 'second', 2)])

    expect(await firstStore.take('session', 'first')).toEqual({ found: true, value: 1 })
    expect(await firstStore.take('session', 'second')).toEqual({ found: true, value: 2 })
  }, 15_000)

  it('a completed operation leaves no lock directory on disk', async () => {
    const store = await openStore(await loadProcess())

    await store.write(sessionRecord('session'))
    await expect(readdir(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

    await store.flash('session', 'key', 'value')
    await expect(readdir(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 15_000)

  it('a retry frees the lock of every record whose release could neither move the lease aside nor publish it', async () => {
    const store = await openStore(await loadProcess())
    const sessionIds = ['session-a', 'session-b', 'session-c']
    for (const sessionId of sessionIds) await store.write(sessionRecord(sessionId))

    for (const sessionId of sessionIds) {
      windowsFs.blockedRenamePrefixes.add(leasePrefix(lockPathFor(sessionId)))
      windowsFs.blockedWritePrefixes.add(lockPathFor(sessionId))
      await store.flash(sessionId, 'key', sessionId)
    }
    for (const sessionId of sessionIds) expect(await readdir(lockPathFor(sessionId))).toHaveLength(1)

    clearFilesystemFaults()
    for (const sessionId of sessionIds) {
      await waitFor(`the lock for ${sessionId} to be removed by its retry`, () => isAbsent(lockPathFor(sessionId)))
    }
  }, 15_000)

  it('another store reclaims a lease whose release was published as released because it could not be moved aside', async () => {
    const releasingStore = await openStore(await loadProcess())
    const successor = await openStore(await loadProcess())
    await releasingStore.write(sessionRecord('session'))
    windowsFs.blockedRenamePrefixes.add(leasePrefix(lockPath))
    await releasingStore.flash('session', 'first', 1)
    windowsFs.blockedRenamePrefixes.clear()
    expect(reports).toHaveLength(1)
    expect((reports[0] as Error).message).toContain('the next writer will reclaim it')

    await successor.flash('session', 'second', 2)

    expect(await successor.take('session', 'second')).toEqual({ found: true, value: 2 })
    expect(await isAbsent(lockPath)).toBe(true)
  }, 15_000)

  it('the releasing store reclaims its own unpublished lease on its next operation', async () => {
    const store = await openStore(await loadProcess())
    await store.write(sessionRecord('session'))
    windowsFs.blockedRenamePrefixes.add(leasePrefix(lockPath))
    windowsFs.blockedWritePrefixes.add(lockPath)
    await store.flash('session', 'first', 1)

    await store.flash('session', 'second', 2)

    clearFilesystemFaults()
    await waitFor('the lock to be removed once the faults clear', () => isAbsent(lockPath))
    expect(await store.take('session', 'first')).toEqual({ found: true, value: 1 })
    expect(await store.take('session', 'second')).toEqual({ found: true, value: 2 })
  }, 15_000)

  it('reports that other processes must wait once the release retries stop publishing it', async () => {
    const store = await openStore(await loadProcess())
    await store.write(sessionRecord('session'))
    windowsFs.blockedRenamePrefixes.add(leasePrefix(lockPath))
    windowsFs.blockedWritePrefixes.add(lockPath)
    await store.flash('session', 'key', 1)

    await waitFor('the release retries to give up and report', async () => reports.length > 0)
    expect(reports).toHaveLength(1)
    expect((reports[0] as Error).message).toContain('other processes may wait until this process reclaims the lease or exits')
    expect(await readdir(lockPath)).toHaveLength(1)
    expect((reports[0] as Error).cause).toMatchObject({ code: 'EPERM' })
  }, 15_000)

  it('an I/O error while moving the lease aside rejects the release and the next operation recovers', async () => {
    const store = await openStore(await loadProcess())
    await store.write(sessionRecord('session'))
    windowsFs.ioErrorRenamePrefixes.add(leasePrefix(lockPath))
    windowsFs.blockedWritePrefixes.add(lockPath)
    await expect(store.flash('session', 'first', 1)).rejects.toMatchObject({ code: 'EIO' })
    await waitFor('the scheduled release retry to report its failure', async () => reports.length > 0)
    windowsFs.ioErrorRenamePrefixes.clear()
    windowsFs.blockedWritePrefixes.clear()

    await store.flash('session', 'second', 2)

    expect(await store.take('session', 'second')).toEqual({ found: true, value: 2 })
    expect(await isAbsent(lockPath)).toBe(true)
  }, 15_000)

  it('an I/O error during acquisition leaves no pending lock directory and the next operation recovers', async () => {
    const store = await openStore(await loadProcess())
    await store.write(sessionRecord('session'))
    windowsFs.ioErrorOpenPrefixes.add(root)
    await expect(store.flash('session', 'first', 1)).rejects.toMatchObject({ code: 'EIO' })
    expect((await readdir(root)).filter(name => name.endsWith('.pending'))).toEqual([])

    windowsFs.ioErrorOpenPrefixes.clear()
    await store.flash('session', 'second', 2)

    expect(await store.take('session', 'second')).toEqual({ found: true, value: 2 })
  }, 15_000)

  it('lets another store proceed once a scheduled retry publishes the release', async () => {
    const releasingStore = await openStore(await loadProcess())
    const successor = await openStore(await loadProcess())
    await releasingStore.write(sessionRecord('session'))
    windowsFs.blockedRenamePrefixes.add(leasePrefix(lockPath))
    windowsFs.blockedWritePrefixes.add(lockPath)
    await releasingStore.flash('session', 'first', 1)

    windowsFs.blockedWritePrefixes.clear()
    await waitFor('the retry to publish the released marker', () => publishedAsReleased(lockPath))
    windowsFs.blockedRenamePrefixes.clear()
    await successor.flash('session', 'second', 2)

    expect(await successor.take('session', 'second')).toEqual({ found: true, value: 2 })
    expect(await isAbsent(lockPath)).toBe(true)
  }, 15_000)

  it('takes over when a waiter first reads a torn released lease', async () => {
    const holderProcess = await loadProcess()
    await (await openStore(holderProcess)).write(sessionRecord('session'))
    const holder = await holderProcess.fileSessionDriverInternals.acquireRecordLock(recordPath, mkdir)
    const waiter = await openStore(await loadProcess())
    const waiting = waiter.flash('session', 'key', 1)
    await waitFor('the waiter to read the held lease', async () => tornLeaseReads.ownerReads > 0)
    tornLeaseReads.armed = true
    windowsFs.blockedRenamePrefixes.add(leasePrefix(lockPath))
    await holder()
    windowsFs.blockedRenamePrefixes.clear()

    await waiting
    expect(tornLeaseReads.armed).toBe(false)
    expect(await waiter.take('session', 'key')).toEqual({ found: true, value: 1 })
  }, 15_000)

  it('does not reclaim a lease its own process still holds', async () => {
    const session = await loadProcess()
    const store = await openStore(session)
    await store.write(sessionRecord('session'))
    const holder = await session.fileSessionDriverInternals.acquireRecordLock(recordPath, mkdir)

    await expect(store.flash('session', 'key', 1)).rejects.toThrow('Timed out acquiring file session lock')
    await holder()
    await store.flash('session', 'key', 1)

    expect(await store.take('session', 'key')).toEqual({ found: true, value: 1 })
  }, 15_000)

  it('does not mistake a live lease from another instance with the same PID for its own', async () => {
    const store = await openStore(await loadProcess())
    const token = randomUUID()
    await mkdir(lockPath)
    await writeFile(join(lockPath, `owner.${token}.json`), JSON.stringify({ host: hostname(), pid: process.pid, processToken: randomUUID(), token }))

    await expect(store.write(sessionRecord('session'))).rejects.toThrow('Timed out acquiring file session lock')
  }, 15_000)
})
