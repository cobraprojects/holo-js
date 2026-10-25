import type { PathLike } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ErrorReporting from '@holo-js/kernel/error-reporting'
import type * as SessionModule from '../src'
import { advanceTo, advanceUntil, finishesWithoutTheClock, settle, useFakeClock } from '../../../tests/support/fake-clock'
import { busyError, createMemoryFs, type MemoryFs } from '../../../tests/support/memory-fs'

const memory = vi.hoisted((): { fs?: MemoryFs } => ({}))

vi.mock('node:fs/promises', async () => (await import('../../../tests/support/memory-fs')).memoryFsModule(() => memory.fs))
vi.mock('node:timers/promises', async () => (await import('../../../tests/support/fake-clock')).fakeTimersPromises())

const STALL_MS = 5_000
const HARD_CAP_MS = 30_000
const POLL_MS = 5
const HANDOVER_MS = 4_000

type Acquisition = {
  readonly label: string
  settled: boolean
  settledAt?: number
  error?: Error
  release?: () => Promise<void>
  released: boolean
}

const root = resolve('/memory/handover')
const recordPath = join(root, 'session.json')
const lockPath = `${recordPath}.lock`
let fs: MemoryFs
let session: typeof SessionModule
let configureReporting: typeof ErrorReporting.errorReportingInternals.configure
let pendingPaths: Map<string, string>
let acquisitions: Acquisition[]
let blockedRenameSources: Set<string>
let blockedRenamePrefixes: Set<string>
let blockedUnlinkPrefixes: Set<string>
let renameAttempts: Map<string, number>
let unlinkGate: { readonly prefix: string, readonly opened: Promise<void>, paused: number } | undefined

function startsWithAny(path: string, prefixes: Set<string>): boolean {
  for (const prefix of prefixes) if (path.startsWith(prefix)) return true
  return false
}

function startAcquisition(label: string): Acquisition {
  const acquisition: Acquisition = { label, settled: false, released: false }
  acquisitions.push(acquisition)
  const makeDirectory = async (path: PathLike): Promise<undefined> => {
    pendingPaths.set(label, String(path))
    await fs.promises.mkdir(String(path))
    return undefined
  }
  session.fileSessionDriverInternals.acquireRecordLock(recordPath, makeDirectory).then(
    release => { Object.assign(acquisition, { settled: true, settledAt: Date.now(), release }) },
    (error: Error) => { Object.assign(acquisition, { settled: true, settledAt: Date.now(), error }) },
  )
  return acquisition
}

async function acquireHolder(label: string): Promise<Acquisition> {
  const holder = startAcquisition(label)
  await settle()
  if (!holder.release) throw new Error(`${label} should acquire the free lock without waiting: ${holder.error?.message ?? 'still pending'}`)
  return holder
}

async function startWaiter(blocked: boolean): Promise<Acquisition> {
  const waiter = startAcquisition('waiter')
  if (blocked) blockedRenameSources.add(pendingPathOf('waiter'))
  await settle()
  if (waiter.settled) throw new Error(`The waiter should be polling, but it settled: ${waiter.error?.message ?? 'acquired'}`)
  return waiter
}

async function releaseAcquisition(acquisition: Acquisition): Promise<void> {
  const release = acquisition.release
  if (!release || acquisition.released) throw new Error(`${acquisition.label} does not hold the lock`)
  acquisition.released = true
  await finishesWithoutTheClock(release(), `Releasing ${acquisition.label}`)
}

function pendingPathOf(label: string): string {
  const pendingPath = pendingPaths.get(label)
  if (!pendingPath) throw new Error(`${label} has not created its pending lease`)
  return pendingPath
}

function renameAttemptsOf(label: string): number {
  return renameAttempts.get(pendingPathOf(label)) ?? 0
}

function pauseUnlinks(prefix: string): () => void {
  let open = (): void => undefined
  unlinkGate = { prefix, opened: new Promise<void>(resolve => { open = resolve }), paused: 0 }
  return () => {
    unlinkGate = undefined
    open()
  }
}

async function handOverUntil(waiter: Acquisition, startedAt: number, lastHandover: number): Promise<Acquisition> {
  let holder = acquisitions.find(acquisition => acquisition.release && !acquisition.released)
  if (!holder) throw new Error('Expected a holder to hand the lock over from')
  for (let cycle = 1; cycle * HANDOVER_MS <= lastHandover; cycle += 1) {
    await advanceTo(startedAt + cycle * HANDOVER_MS)
    expect(waiter.settled).toBe(false)
    await releaseAcquisition(holder)
    holder = await acquireHolder(`holder-${cycle}`)
  }
  return holder
}

describe.each(['posix', 'win32'] as const)('file session lock handover under a fake clock on %s', platform => {
  beforeEach(async () => {
    useFakeClock()
    fs = createMemoryFs({ platform })
    memory.fs = fs
    pendingPaths = new Map()
    acquisitions = []
    blockedRenameSources = new Set()
    blockedRenamePrefixes = new Set()
    blockedUnlinkPrefixes = new Set()
    renameAttempts = new Map()
    unlinkGate = undefined
    fs.addHook(async (operation, path) => {
      if (operation === 'rename') {
        renameAttempts.set(path, (renameAttempts.get(path) ?? 0) + 1)
        if (blockedRenameSources.has(path) || startsWithAny(path, blockedRenamePrefixes)) throw busyError('rename', path)
      }
      if (operation === 'unlink') {
        if (startsWithAny(path, blockedUnlinkPrefixes)) throw busyError('unlink', path)
        const gate = unlinkGate
        if (gate && path.startsWith(gate.prefix)) {
          gate.paused += 1
          await gate.opened
        }
      }
    })
    await fs.promises.mkdir(root, { recursive: true })
    vi.resetModules()
    session = await import('../src')
    configureReporting = (await import('@holo-js/kernel/error-reporting')).errorReportingInternals.configure
    configureReporting({ report: () => undefined })
  })

  afterEach(async () => {
    blockedRenameSources.clear()
    blockedRenamePrefixes.clear()
    blockedUnlinkPrefixes.clear()
    for (const acquisition of acquisitions) {
      if (acquisition.release && !acquisition.released) await releaseAcquisition(acquisition)
    }
    configureReporting(undefined)
    vi.useRealTimers()
    memory.fs = undefined
  })

  it('times out a stuck holder after the stall deadline', async () => {
    const holder = await acquireHolder('holder')
    const startedAt = Date.now()
    const waiter = await startWaiter(false)

    await advanceTo(startedAt + STALL_MS - 1)
    expect(waiter.settled).toBe(false)

    await advanceUntil(() => waiter.settled, 'the waiter to give up', 2 * POLL_MS)
    expect(waiter.error?.message).toContain('Timed out acquiring file session lock')
    expect(waiter.settledAt! - startedAt).toBeGreaterThanOrEqual(STALL_MS)
    expect(waiter.settledAt! - startedAt).toBeLessThanOrEqual(STALL_MS + POLL_MS)
    expect(waiter.error?.cause).toBeUndefined()

    await releaseAcquisition(holder)
  })

  it('reports the filesystem error when every rename fails without contention', async () => {
    const startedAt = Date.now()
    const waiter = await startWaiter(true)

    await advanceUntil(() => waiter.settled, 'the solo acquisition to give up', STALL_MS + 2 * POLL_MS)
    expect(waiter.settledAt! - startedAt).toBeGreaterThanOrEqual(STALL_MS)
    expect(waiter.error?.message).toContain('Timed out acquiring file session lock')
    expect(waiter.error?.cause).toEqual(expect.objectContaining({ code: 'EPERM' }))
    expect(waiter.release).toBeUndefined()
    expect(fs.names(root)).toEqual([])
  })

  it('polls a visibly held lock without retrying the rename', async () => {
    const holder = await acquireHolder('holder')
    const waiter = await startWaiter(false)
    const attemptsWhileHeld = renameAttemptsOf('waiter')

    await advanceTo(Date.now() + 500)
    expect(renameAttemptsOf('waiter')).toBe(attemptsWhileHeld)
    expect(waiter.settled).toBe(false)

    await releaseAcquisition(holder)
    await advanceUntil(() => waiter.settled, 'the waiter to acquire the released lock', 2 * POLL_MS)
    expect(waiter.error).toBeUndefined()
    expect(waiter.release).toBeDefined()
    expect(renameAttemptsOf('waiter')).toBeGreaterThan(attemptsWhileHeld)

    await releaseAcquisition(waiter)
  })

  it('restarts the stall deadline when the lock changes hands', async () => {
    await acquireHolder('holder-0')
    const startedAt = Date.now()
    const waiter = await startWaiter(true)

    const second = await handOverUntil(waiter, startedAt, HANDOVER_MS)
    await advanceTo(startedAt + STALL_MS + 2_000)
    expect(waiter.settled).toBe(false)

    await releaseAcquisition(second)
    blockedRenameSources.clear()
    await advanceUntil(() => waiter.settled, 'the waiter to acquire after the second holder leaves', 2 * POLL_MS)
    expect(waiter.error).toBeUndefined()
    expect(waiter.release).toBeDefined()

    await releaseAcquisition(waiter)
  })

  async function giveUpAtHardCap(): Promise<void> {
    await acquireHolder('holder-0')
    const startedAt = Date.now()
    const waiter = await startWaiter(true)

    await handOverUntil(waiter, startedAt, HARD_CAP_MS - 1)
    await advanceTo(startedAt + HARD_CAP_MS - 1)
    expect(waiter.settled).toBe(false)

    await advanceUntil(() => waiter.settled, 'the waiter to give up at the hard cap', 2 * POLL_MS)
    expect(waiter.error?.message).toContain('Timed out acquiring file session lock')
    expect(waiter.settledAt! - startedAt).toBeGreaterThanOrEqual(HARD_CAP_MS)
    expect(waiter.settledAt! - startedAt).toBeLessThanOrEqual(HARD_CAP_MS + POLL_MS)
  }

  it('gives up at the hard cap while the lock keeps changing hands', giveUpAtHardCap)

  it('gives up at the hard cap while tombstone removals wait on busy unlinks', async () => {
    blockedUnlinkPrefixes.add(lockPath)
    await giveUpAtHardCap()
    expect(fs.names(root).filter(name => name.endsWith('.released')).length).toBeGreaterThan(0)
  })

  it('times out instead of acquiring when a reclaim finishes past the hard cap', async () => {
    await acquireHolder('holder-0')
    const startedAt = Date.now()
    const waiter = await startWaiter(true)
    const last = await handOverUntil(waiter, startedAt, HARD_CAP_MS - 1)

    await advanceTo(startedAt + HARD_CAP_MS - 500)
    blockedRenamePrefixes.add(join(lockPath, 'owner.'))
    const openUnlinks = pauseUnlinks(join(lockPath, 'owner.'))
    await releaseAcquisition(last)
    blockedRenamePrefixes.clear()
    blockedRenameSources.clear()
    await advanceUntil(() => unlinkGate!.paused > 0, 'the waiter to start reclaiming the released lease', 2 * POLL_MS)

    await advanceTo(startedAt + HARD_CAP_MS + 200)
    expect(waiter.settled).toBe(false)
    openUnlinks()
    await settle()

    expect(fs.names(root)).not.toContain('session.json.lock')
    expect(waiter.settled).toBe(true)
    expect(waiter.release).toBeUndefined()
    expect(waiter.error?.message).toContain('Timed out acquiring file session lock')
    expect(waiter.settledAt! - startedAt).toBeGreaterThanOrEqual(HARD_CAP_MS)
  })
})
