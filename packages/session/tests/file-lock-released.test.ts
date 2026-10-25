import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SessionModule from '../src'
import { advanceUntil, finishesWithoutTheClock, useFakeClock } from '../../../tests/support/fake-clock'
import { busyError, createMemoryFs, type MemoryFs } from '../../../tests/support/memory-fs'

const memory = vi.hoisted((): { fs?: MemoryFs } => ({}))

vi.mock('node:fs/promises', async () => (await import('../../../tests/support/memory-fs')).memoryFsModule(() => memory.fs))
vi.mock('node:timers/promises', async () => (await import('../../../tests/support/fake-clock')).fakeTimersPromises())

type SessionApi = typeof SessionModule
type AtomicStore = Omit<SessionModule.SessionStore, 'flash' | 'take'> & Required<Pick<SessionModule.SessionStore, 'flash' | 'take'>>

const STALL_MS = 5_000
const POLL_MS = 5
const RELEASE_RETRY_FIRST_MS = 5
const RELEASE_RETRY_BUDGET_MS = 1_000

const root = resolve('/memory/released')
const recordPath = join(root, 'session.json')
const lockPath = `${recordPath}.lock`
const reports: unknown[] = []
const faults = {
  blockedRenamePrefixes: new Set<string>(),
  blockedWritePrefixes: new Set<string>(),
  ioErrorOpenPrefixes: new Set<string>(),
  ioErrorRenamePrefixes: new Set<string>(),
}
let fs: MemoryFs
let publishedReleases: Set<string>
let tornLeaseReads: { armed: boolean, ownerReads: number }

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

function startsWithAny(path: string, prefixes: Set<string>): boolean {
  for (const prefix of prefixes) if (path.startsWith(prefix)) return true
  return false
}

function ioError(operation: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EIO: i/o error, ${operation} '${path}'`), { code: 'EIO', path })
}

function clearFilesystemFaults(): void {
  for (const prefixes of Object.values(faults)) prefixes.clear()
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

function isAbsent(path: string): boolean {
  return !fs.names(root).includes(path.slice(root.length + 1))
}

function track<T>(operation: Promise<T>): { readonly settled: () => boolean, readonly result: Promise<T> } {
  let settled = false
  const result = operation.finally(() => { settled = true })
  result.catch(() => undefined)
  return { settled: () => settled, result }
}

function interceptLeaseContents(): void {
  const { readFile, writeFile } = fs.promises
  fs.promises.readFile = async (path: string) => {
    const contents = await readFile(path)
    if (!path.includes('owner.')) return contents
    tornLeaseReads.ownerReads += 1
    if (!tornLeaseReads.armed || !contents.includes('"released":true')) return contents
    tornLeaseReads.armed = false
    return contents.replace(/[^\n]/g, ' ')
  }
  fs.promises.writeFile = async (path: string, data: string, options?: { readonly flag?: string }) => {
    await writeFile(path, data, options)
    if (data.includes('"released":true')) publishedReleases.add(resolve(path))
  }
}

describe.each(['posix', 'win32'] as const)('released file locks across processes on a %s filesystem', platform => {
  beforeEach(async () => {
    useFakeClock()
    fs = createMemoryFs({ platform })
    memory.fs = fs
    reports.length = 0
    publishedReleases = new Set()
    tornLeaseReads = { armed: false, ownerReads: 0 }
    fs.addHook((operation, path) => {
      if (operation === 'open' && startsWithAny(path, faults.ioErrorOpenPrefixes)) throw ioError('open', path)
      if (operation === 'writeFile' && startsWithAny(path, faults.blockedWritePrefixes)) throw busyError('write', path)
      if (operation === 'rename' && startsWithAny(path, faults.ioErrorRenamePrefixes)) throw ioError('rename', path)
      if (operation === 'rename' && startsWithAny(path, faults.blockedRenamePrefixes)) throw busyError('rename', path)
    })
    interceptLeaseContents()
    await fs.promises.mkdir(root, { recursive: true })
  })

  afterEach(() => {
    clearFilesystemFaults()
    vi.useRealTimers()
    memory.fs = undefined
  })

  it('a second store on the same root completes its flash after the first store releases the lock', async () => {
    const firstStore = await openStore(await loadProcess())
    const secondStore = await openStore(await loadProcess())
    await finishesWithoutTheClock(firstStore.write(sessionRecord('session')), 'Writing an uncontended session')

    const flashes = track(Promise.all([firstStore.flash('session', 'first', 1), secondStore.flash('session', 'second', 2)]))
    await advanceUntil(flashes.settled, 'both flashes to finish', 2 * POLL_MS)
    await flashes.result

    expect(await firstStore.take('session', 'first')).toEqual({ found: true, value: 1 })
    expect(await firstStore.take('session', 'second')).toEqual({ found: true, value: 2 })
  })

  it('a completed operation leaves no lock directory on disk', async () => {
    const store = await openStore(await loadProcess())

    await finishesWithoutTheClock(store.write(sessionRecord('session')), 'Writing a session')
    await expect(fs.promises.readdir(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })

    await finishesWithoutTheClock(store.flash('session', 'key', 'value'), 'Flashing a value')
    await expect(fs.promises.readdir(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('a retry frees the lock of every record whose release could neither move the lease aside nor publish it', async () => {
    const store = await openStore(await loadProcess())
    const sessionIds = ['session-a', 'session-b', 'session-c']
    for (const sessionId of sessionIds) await finishesWithoutTheClock(store.write(sessionRecord(sessionId)), `Writing ${sessionId}`)

    for (const sessionId of sessionIds) {
      faults.blockedRenamePrefixes.add(leasePrefix(lockPathFor(sessionId)))
      faults.blockedWritePrefixes.add(lockPathFor(sessionId))
      await finishesWithoutTheClock(store.flash(sessionId, 'key', sessionId), `Flashing ${sessionId} while its release is blocked`)
    }
    for (const sessionId of sessionIds) expect(fs.names(lockPathFor(sessionId))).toHaveLength(1)

    clearFilesystemFaults()
    await advanceUntil(() => sessionIds.every(sessionId => isAbsent(lockPathFor(sessionId))), 'every lock to be removed by its retry', 2 * RELEASE_RETRY_FIRST_MS)
  })

  it('another store reclaims a lease whose release was published as released because it could not be moved aside', async () => {
    const releasingStore = await openStore(await loadProcess())
    const successor = await openStore(await loadProcess())
    await finishesWithoutTheClock(releasingStore.write(sessionRecord('session')), 'Writing a session')
    faults.blockedRenamePrefixes.add(leasePrefix(lockPath))
    await finishesWithoutTheClock(releasingStore.flash('session', 'first', 1), 'Flashing while the lease cannot move aside')
    faults.blockedRenamePrefixes.clear()
    expect(reports).toHaveLength(1)
    expect((reports[0] as Error).message).toContain('the next writer will reclaim it')

    await finishesWithoutTheClock(successor.flash('session', 'second', 2), 'Flashing over a published release')

    expect(await successor.take('session', 'second')).toEqual({ found: true, value: 2 })
    expect(isAbsent(lockPath)).toBe(true)
  })

  it('the releasing store reclaims its own unpublished lease on its next operation', async () => {
    const store = await openStore(await loadProcess())
    await finishesWithoutTheClock(store.write(sessionRecord('session')), 'Writing a session')
    faults.blockedRenamePrefixes.add(leasePrefix(lockPath))
    faults.blockedWritePrefixes.add(lockPath)
    await finishesWithoutTheClock(store.flash('session', 'first', 1), 'Flashing while the release is blocked')

    await finishesWithoutTheClock(store.flash('session', 'second', 2), 'Flashing over its own unpublished lease')

    clearFilesystemFaults()
    await advanceUntil(() => isAbsent(lockPath), 'the lock to be removed once the faults clear', 2 * RELEASE_RETRY_FIRST_MS)
    expect(await store.take('session', 'first')).toEqual({ found: true, value: 1 })
    expect(await store.take('session', 'second')).toEqual({ found: true, value: 2 })
  })

  it('reports that other processes must wait once the release retries stop publishing it', async () => {
    const store = await openStore(await loadProcess())
    await finishesWithoutTheClock(store.write(sessionRecord('session')), 'Writing a session')
    faults.blockedRenamePrefixes.add(leasePrefix(lockPath))
    faults.blockedWritePrefixes.add(lockPath)
    await finishesWithoutTheClock(store.flash('session', 'key', 1), 'Flashing while the release is blocked')

    await advanceUntil(() => reports.length > 0, 'the release retries to give up and report', RELEASE_RETRY_BUDGET_MS)
    expect(reports).toHaveLength(1)
    expect((reports[0] as Error).message).toContain('other processes may wait until this process reclaims the lease or exits')
    expect(fs.names(lockPath)).toHaveLength(1)
    expect((reports[0] as Error).cause).toMatchObject({ code: 'EPERM' })
  })

  it('an I/O error while moving the lease aside rejects the release and the next operation recovers', async () => {
    const store = await openStore(await loadProcess())
    await finishesWithoutTheClock(store.write(sessionRecord('session')), 'Writing a session')
    faults.ioErrorRenamePrefixes.add(leasePrefix(lockPath))
    faults.blockedWritePrefixes.add(lockPath)
    await expect(finishesWithoutTheClock(store.flash('session', 'first', 1), 'Flashing while the lease rename fails')).rejects.toMatchObject({ code: 'EIO' })
    await advanceUntil(() => reports.length > 0, 'the scheduled release retry to report its failure', 2 * RELEASE_RETRY_FIRST_MS)
    clearFilesystemFaults()

    await finishesWithoutTheClock(store.flash('session', 'second', 2), 'Flashing after the faults clear')

    expect(await store.take('session', 'second')).toEqual({ found: true, value: 2 })
    expect(isAbsent(lockPath)).toBe(true)
  })

  it('an I/O error during acquisition leaves no pending lock directory and the next operation recovers', async () => {
    const store = await openStore(await loadProcess())
    await finishesWithoutTheClock(store.write(sessionRecord('session')), 'Writing a session')
    faults.ioErrorOpenPrefixes.add(root)
    await expect(finishesWithoutTheClock(store.flash('session', 'first', 1), 'Flashing while opening the lease fails')).rejects.toMatchObject({ code: 'EIO' })
    expect(fs.names(root).filter(name => name.endsWith('.pending'))).toEqual([])

    clearFilesystemFaults()
    await finishesWithoutTheClock(store.flash('session', 'second', 2), 'Flashing after the faults clear')

    expect(await store.take('session', 'second')).toEqual({ found: true, value: 2 })
  })

  it('lets another store proceed once a scheduled retry publishes the release', async () => {
    const releasingStore = await openStore(await loadProcess())
    const successor = await openStore(await loadProcess())
    await finishesWithoutTheClock(releasingStore.write(sessionRecord('session')), 'Writing a session')
    faults.blockedRenamePrefixes.add(leasePrefix(lockPath))
    faults.blockedWritePrefixes.add(lockPath)
    await finishesWithoutTheClock(releasingStore.flash('session', 'first', 1), 'Flashing while the release is blocked')

    faults.blockedWritePrefixes.clear()
    await advanceUntil(() => publishedReleases.size > 0, 'the retry to publish the released marker', 2 * RELEASE_RETRY_FIRST_MS)
    faults.blockedRenamePrefixes.clear()
    await finishesWithoutTheClock(successor.flash('session', 'second', 2), 'Flashing over the published release')

    expect(await successor.take('session', 'second')).toEqual({ found: true, value: 2 })
    expect(isAbsent(lockPath)).toBe(true)
  })

  it('takes over when a waiter first reads a torn released lease', async () => {
    const holderProcess = await loadProcess()
    await finishesWithoutTheClock((await openStore(holderProcess)).write(sessionRecord('session')), 'Writing a session')
    const holder = await finishesWithoutTheClock(holderProcess.fileSessionDriverInternals.acquireRecordLock(recordPath, mkdir), 'Acquiring the free lock')
    const waiter = await openStore(await loadProcess())
    const waiting = track(waiter.flash('session', 'key', 1))
    await advanceUntil(() => tornLeaseReads.ownerReads > 0, 'the waiter to read the held lease', POLL_MS)
    tornLeaseReads.armed = true
    faults.blockedRenamePrefixes.add(leasePrefix(lockPath))
    await finishesWithoutTheClock(holder(), 'Releasing the held lock')
    faults.blockedRenamePrefixes.clear()

    await advanceUntil(waiting.settled, 'the waiter to take over the released lease', 4 * POLL_MS)
    await waiting.result
    expect(tornLeaseReads.armed).toBe(false)
    expect(await waiter.take('session', 'key')).toEqual({ found: true, value: 1 })
  })

  it('does not reclaim a lease its own process still holds', async () => {
    const session = await loadProcess()
    const store = await openStore(session)
    await finishesWithoutTheClock(store.write(sessionRecord('session')), 'Writing a session')
    const holder = await finishesWithoutTheClock(session.fileSessionDriverInternals.acquireRecordLock(recordPath, mkdir), 'Acquiring the free lock')

    const blocked = track(store.flash('session', 'key', 1))
    await advanceUntil(blocked.settled, 'the flash to give up on the held lock', STALL_MS + 2 * POLL_MS)
    await expect(blocked.result).rejects.toThrow('Timed out acquiring file session lock')
    await finishesWithoutTheClock(holder(), 'Releasing the held lock')
    await finishesWithoutTheClock(store.flash('session', 'key', 1), 'Flashing after the release')

    expect(await store.take('session', 'key')).toEqual({ found: true, value: 1 })
  })

  it('does not mistake a live lease from another instance with the same PID for its own', async () => {
    const store = await openStore(await loadProcess())
    const token = randomUUID()
    await fs.promises.mkdir(lockPath)
    await fs.promises.writeFile(join(lockPath, `owner.${token}.json`), JSON.stringify({ host: hostname(), pid: process.pid, processToken: randomUUID(), token }))

    const blocked = track(store.write(sessionRecord('session')))
    await advanceUntil(blocked.settled, 'the write to give up on the live lease', STALL_MS + 2 * POLL_MS)
    await expect(blocked.result).rejects.toThrow('Timed out acquiring file session lock')
  })
})
