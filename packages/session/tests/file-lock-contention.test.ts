import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SessionModule from '../src'
import { advanceTo, advanceUntil, finishesWithoutTheClock, useFakeClock } from '../../../tests/support/fake-clock'
import { createMemoryFs, type MemoryFs } from '../../../tests/support/memory-fs'

const memory = vi.hoisted((): { fs?: MemoryFs } => ({}))

vi.mock('node:fs/promises', async () => (await import('../../../tests/support/memory-fs')).memoryFsModule(() => memory.fs))
vi.mock('node:timers/promises', async () => (await import('../../../tests/support/fake-clock')).fakeTimersPromises())

type AtomicStore = Omit<SessionModule.SessionStore, 'flash' | 'take'> & Required<Pick<SessionModule.SessionStore, 'flash' | 'take'>>
type ForeignOwner = { readonly host: string, readonly pid: number, readonly token: string, readonly processToken?: string, readonly released?: boolean }

const STALL_MS = 5_000
const POLL_MS = 5
const STALE_LEASE_AGE_MS = 20_000
const WRITERS_PER_PROCESS = 2
const PROCESSES = 4
const FLASHES_PER_WRITER = 5

const root = resolve('/memory/contention')
let fs: MemoryFs
let foreignProcesses: Map<number, boolean>
let nextForeignPid: number

async function startProcess(): Promise<typeof SessionModule> {
  vi.resetModules()
  const session = await import('../src')
  const { errorReportingInternals } = await import('@holo-js/kernel/error-reporting')
  errorReportingInternals.configure({ report: () => undefined })
  return session
}

function openStore(session: typeof SessionModule): AtomicStore {
  const store = session.createFileSessionStore(root)
  const { flash, take } = store
  if (!flash || !take) throw new Error('File sessions must support atomic flash and take')
  return { ...store, flash, take }
}

async function createSession(store: AtomicStore): Promise<{ readonly record: SessionModule.SessionRecord, readonly lockPath: string }> {
  const now = new Date()
  const record: SessionModule.SessionRecord = { id: randomUUID(), store: 'file', data: { userId: 42 }, createdAt: now, lastActivityAt: now, expiresAt: new Date(now.getTime() + 600_000) }
  await finishesWithoutTheClock(store.write(record), 'Writing an uncontended session')
  return { record, lockPath: `${join(root, `${record.id}.json`)}.lock` }
}

function foreignProcess(): number {
  const pid = nextForeignPid
  nextForeignPid += 1
  foreignProcesses.set(pid, true)
  return pid
}

function ownerFile(lockPath: string, owner: ForeignOwner): string {
  return join(lockPath, `owner.${owner.token}.json`)
}

async function writeForeignLease(lockPath: string, owner: ForeignOwner): Promise<void> {
  await fs.promises.mkdir(lockPath)
  await fs.promises.writeFile(ownerFile(lockPath, owner), JSON.stringify(owner))
  const aged = new Date(Date.now() - STALE_LEASE_AGE_MS)
  await fs.promises.utimes(ownerFile(lockPath, owner), aged, aged)
  await fs.promises.utimes(lockPath, aged, aged)
}

async function releaseForeignLease(lockPath: string, owner: ForeignOwner): Promise<void> {
  await fs.promises.rename(ownerFile(lockPath, owner), `${lockPath}.${owner.token}.released`)
  await fs.promises.rmdir(lockPath)
}

function track<T>(operation: Promise<T>): { readonly settled: () => boolean, readonly result: Promise<T> } {
  let settled = false
  const result = operation.finally(() => { settled = true })
  result.catch(() => undefined)
  return { settled: () => settled, result }
}

describe.each(['posix', 'win32'] as const)('file session lock contention on a %s filesystem', platform => {
  beforeEach(async () => {
    useFakeClock()
    fs = createMemoryFs({ platform })
    memory.fs = fs
    foreignProcesses = new Map()
    nextForeignPid = 4_000_001
    const kill = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      const alive = foreignProcesses.get(pid)
      if (alive === undefined || signal !== 0) return kill(pid, signal)
      if (!alive) throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: 'ESRCH' })
      return true
    })
    await fs.promises.mkdir(root, { recursive: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    memory.fs = undefined
  })

  it('keeps a live owner\'s lease even when its timestamps are old, and acquires once the owner releases', async () => {
    const store = openStore(await startProcess())
    const { record, lockPath } = await createSession(store)
    const owner = { host: hostname(), pid: foreignProcess(), token: randomUUID() }
    await writeForeignLease(lockPath, owner)
    const startedAt = Date.now()
    const flash = track(store.flash(record.id, 'notice', 'Saved'))

    await advanceTo(startedAt + STALL_MS - 4 * POLL_MS)
    expect(flash.settled()).toBe(false)
    expect(fs.names(lockPath)).toHaveLength(1)

    await releaseForeignLease(lockPath, owner)
    await advanceUntil(flash.settled, 'the flash to acquire the released lock', 2 * POLL_MS)
    await flash.result
    expect(await store.take(record.id, 'notice')).toEqual({ found: true, value: 'Saved' })
    expect(await store.read(record.id)).toEqual(record)
  })

  it('reclaims a lease once its owner process has exited', async () => {
    const store = openStore(await startProcess())
    const { record, lockPath } = await createSession(store)
    const owner = foreignProcess()
    await writeForeignLease(lockPath, { host: hostname(), pid: owner, token: randomUUID() })
    const flash = track(store.flash(record.id, 'notice', 'Saved'))

    await advanceTo(Date.now() + STALL_MS / 2)
    expect(flash.settled()).toBe(false)

    foreignProcesses.set(owner, false)
    await advanceUntil(flash.settled, 'the flash to reclaim the dead owner\'s lease', 2 * POLL_MS)
    await flash.result
    expect(await store.take(record.id, 'notice')).toEqual({ found: true, value: 'Saved' })
    expect(await store.read(record.id)).toEqual(record)
  })

  it('reclaims a lease its live owner released without being able to remove it', async () => {
    const store = openStore(await startProcess())
    const { record, lockPath } = await createSession(store)
    await writeForeignLease(lockPath, { host: hostname(), pid: foreignProcess(), token: randomUUID(), released: true })

    await finishesWithoutTheClock(store.flash(record.id, 'notice', 'Saved'), 'Flashing over a released lease')
    expect(await store.take(record.id, 'notice')).toEqual({ found: true, value: 'Saved' })
    expect(await store.read(record.id)).toEqual(record)
  })

  it('takes over a lease its live owner publishes as released while another writer is already waiting', async () => {
    const store = openStore(await startProcess())
    const { record, lockPath } = await createSession(store)
    const owner = { host: hostname(), pid: foreignProcess(), token: randomUUID() }
    await writeForeignLease(lockPath, owner)
    const flash = track(store.flash(record.id, 'notice', 'Saved'))

    await advanceTo(Date.now() + 200)
    expect(flash.settled()).toBe(false)

    await fs.promises.writeFile(ownerFile(lockPath, owner), JSON.stringify({ ...owner, released: true }), { flag: 'r+' })
    await advanceUntil(flash.settled, 'the waiting flash to take over the released lease', 2 * POLL_MS)
    await flash.result
    expect(await store.take(record.id, 'notice')).toEqual({ found: true, value: 'Saved' })
    expect(await store.read(record.id)).toEqual(record)
  })

  it('times out on a live lock and writes successfully after release', async () => {
    const store = openStore(await startProcess())
    const { record, lockPath } = await createSession(store)
    const owner = { host: hostname(), pid: foreignProcess(), token: randomUUID() }
    await writeForeignLease(lockPath, owner)
    const startedAt = Date.now()
    const blocked = track(store.flash(record.id, 'notice', 'Blocked'))

    await advanceUntil(blocked.settled, 'the blocked flash to time out', STALL_MS + 2 * POLL_MS)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(STALL_MS)
    await expect(blocked.result).rejects.toThrow('Timed out acquiring file session lock')

    await releaseForeignLease(lockPath, owner)
    await finishesWithoutTheClock(store.flash(record.id, 'notice', 'Saved'), 'Flashing after the owner released')
    expect(await store.take(record.id, 'notice')).toEqual({ found: true, value: 'Saved' })
    expect(await store.read(record.id)).toEqual(record)
  })

  it.each(['reused-pid', 'previous-host'])('reclaims stale persisted leases from %s', async scenario => {
    const store = openStore(await startProcess())
    const { record, lockPath } = await createSession(store)
    await writeForeignLease(lockPath, { host: scenario === 'previous-host' ? 'previous-host' : hostname(), pid: process.pid, token: randomUUID(), processToken: 'previous-process-instance' })

    await finishesWithoutTheClock(store.flash(record.id, 'notice', 'Saved'), 'Flashing over a stale lease')
    expect(await store.take(record.id, 'notice')).toEqual({ found: true, value: 'Saved' })
    expect(await store.read(record.id)).toEqual(record)
  })

  it.each([false, true])('preserves every concurrent writer across processes while replacing an orphaned lease=%s', async orphaned => {
    const processes = []
    for (let index = 0; index < PROCESSES; index += 1) processes.push(await startProcess())
    const stores = processes.flatMap(session => Array.from({ length: WRITERS_PER_PROCESS }, () => openStore(session)))
    const { record, lockPath } = await createSession(stores[0]!)
    await finishesWithoutTheClock(stores[0]!.flash(record.id, 'existing', 'preserved'), 'Flashing an uncontended value')
    if (orphaned) {
      const owner = foreignProcess()
      await writeForeignLease(lockPath, { host: hostname(), pid: owner, token: randomUUID() })
      foreignProcesses.set(owner, false)
    }

    const writers = stores.map((store, writer) => track((async () => {
      for (let index = 0; index < FLASHES_PER_WRITER; index += 1) {
        await store.flash(record.id, `writer${writer}.${index}`, { writer, index })
      }
    })()))
    await advanceUntil(() => writers.every(writer => writer.settled()), 'every writer to finish', STALL_MS)
    await Promise.all(writers.map(writer => writer.result))

    const store = stores[0]!
    expect(await store.read(record.id)).toEqual(record)
    expect(await store.take(record.id, 'existing')).toEqual({ found: true, value: 'preserved' })
    for (let writer = 0; writer < stores.length; writer += 1) {
      for (let index = 0; index < FLASHES_PER_WRITER; index += 1) {
        const key = `writer${writer}.${index}`
        expect(await store.take(record.id, key)).toEqual({ found: true, value: { writer, index } })
        expect(await store.take(record.id, key)).toEqual({ found: false })
      }
    }
  })
})
