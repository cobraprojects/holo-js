import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileSessionDriverInternals } from '../src'
import type { WindowsFsState } from './support/windows-fs'

const windowsFs = vi.hoisted((): WindowsFsState => ({ blockedRenameSources: new Set(), blockedUnlinkPrefixes: new Set(), blockedWritePrefixes: new Set(), renameAttempts: new Map() }))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>()
  const { windowsFsOverrides } = await import('./support/windows-fs')
  return { ...actual, ...windowsFsOverrides(actual, windowsFs) }
})

const STALL_MS = 5_000
const HARD_CAP_MS = 30_000
const STEP_MS = 50

type Acquisition = {
  readonly label: string
  readonly ready: Promise<void>
  settled: boolean
  settledAt?: number
  error?: Error
  release?: () => Promise<void>
  released: boolean
}

let root: string
let recordPath: string
let lockPath: string
let pendingPaths: Map<string, string>
let acquisitions: Acquisition[]
let sleepListeners: Array<() => void>

function labelledMakeDirectory(label: string) {
  return (async (path: string) => {
    pendingPaths.set(label, path)
    return await mkdir(path)
  }) as typeof mkdir
}

function startAcquisition(label: string): Acquisition {
  let markSettled = (): void => undefined
  const ready = new Promise<void>(resolve => { markSettled = resolve })
  const acquisition: Acquisition = { label, ready, settled: false, released: false }
  acquisitions.push(acquisition)
  fileSessionDriverInternals.acquireRecordLock(recordPath, labelledMakeDirectory(label)).then(
    release => {
      Object.assign(acquisition, { settled: true, settledAt: Date.now(), release })
      markSettled()
    },
    (error: Error) => {
      Object.assign(acquisition, { settled: true, settledAt: Date.now(), error })
      markSettled()
    },
  )
  return acquisition
}

function nextSleep(): Promise<void> {
  return new Promise(resolve => sleepListeners.push(resolve))
}

async function releaseAcquisition(acquisition: Acquisition): Promise<void> {
  const release = acquisition.release
  if (!release || acquisition.released) throw new Error(`${acquisition.label} does not hold the lock`)
  acquisition.released = true
  await release()
}

function blockRenames(label: string): void {
  const pendingPath = pendingPaths.get(label)
  if (!pendingPath) throw new Error(`${label} has not created its pending lease`)
  windowsFs.blockedRenameSources.add(pendingPath)
}

function unblockRenames(label: string): void {
  const pendingPath = pendingPaths.get(label)
  if (pendingPath) windowsFs.blockedRenameSources.delete(pendingPath)
}

function renameAttempts(label: string): number {
  const pendingPath = pendingPaths.get(label)
  return pendingPath ? (windowsFs.renameAttempts.get(pendingPath) ?? 0) : 0
}

function liveHolders(): number {
  return acquisitions.filter(acquisition => acquisition.release && !acquisition.released).length
}

async function tick(waiter: Acquisition, ms: number): Promise<void> {
  const sleeping = nextSleep()
  await vi.advanceTimersByTimeAsync(ms)
  await Promise.race([sleeping, waiter.ready])
  if (!waiter.settled && vi.getTimerCount() !== liveHolders() + 1) {
    throw new Error(`expected ${liveHolders() + 1} pending timers, found ${vi.getTimerCount()}`)
  }
}

async function advanceTo(waiter: Acquisition, time: number): Promise<void> {
  while (Date.now() < time) await tick(waiter, Math.min(STEP_MS, time - Date.now()))
}

async function advanceUntilSettled(operation: Promise<void>): Promise<void> {
  let done = false
  const finished = operation.finally(() => { done = true })
  while (!done) {
    const sleeping = nextSleep()
    await vi.advanceTimersByTimeAsync(STEP_MS)
    await Promise.race([sleeping, finished])
  }
  await finished
}

describe('file session lock handover under a fake clock', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'holo-file-lock-handover-'))
    recordPath = join(root, 'session.json')
    lockPath = `${recordPath}.lock`
    pendingPaths = new Map()
    acquisitions = []
    sleepListeners = []
    windowsFs.blockedRenameSources.clear()
    windowsFs.renameAttempts.clear()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const scheduleTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      for (const listener of sleepListeners.splice(0)) listener()
      return scheduleTimeout(...args)
    }) as typeof setTimeout
  })

  afterEach(async () => {
    for (const acquisition of acquisitions) {
      if (acquisition.release && !acquisition.released) await releaseAcquisition(acquisition)
    }
    vi.useRealTimers()
    await rm(root, { force: true, recursive: true })
  })

  it('times out a stuck holder after the stall deadline', async () => {
    const holder = startAcquisition('holder')
    await holder.ready
    const asleep = nextSleep()
    const waiter = startAcquisition('waiter')
    await asleep
    const startedAt = Date.now()

    await advanceTo(waiter, startedAt + STALL_MS - STEP_MS)
    expect(waiter.settled).toBe(false)

    await advanceTo(waiter, startedAt + STALL_MS + STEP_MS)
    expect(waiter.settled).toBe(true)
    expect(waiter.error?.message).toContain('Timed out acquiring file session lock')
    expect(waiter.settledAt! - startedAt).toBeGreaterThanOrEqual(STALL_MS)
    expect(waiter.settledAt! - startedAt).toBeLessThan(STALL_MS + 2 * STEP_MS)

    await releaseAcquisition(holder)
  })

  it('restarts the stall deadline when the lock changes hands', async () => {
    const first = startAcquisition('first')
    await first.ready
    const asleep = nextSleep()
    const waiter = startAcquisition('waiter')
    blockRenames('waiter')
    await asleep
    const startedAt = Date.now()

    await advanceTo(waiter, startedAt + 4_000)
    expect(waiter.settled).toBe(false)

    await releaseAcquisition(first)
    const second = startAcquisition('second')
    await second.ready
    const attemptsAtHandover = renameAttempts('waiter')
    await tick(waiter, STEP_MS)
    expect(renameAttempts('waiter')).toBeGreaterThan(attemptsAtHandover)

    await advanceTo(waiter, startedAt + 7_000)
    expect(waiter.settled).toBe(false)

    await releaseAcquisition(second)
    unblockRenames('waiter')
    await tick(waiter, STEP_MS)
    expect(waiter.settled).toBe(true)
    expect(waiter.error).toBeUndefined()
    expect(waiter.release).toBeDefined()

    await releaseAcquisition(waiter)
  })

  it('gives up at the hard cap while the lock keeps changing hands', async () => {
    let holder = startAcquisition('holder-0')
    await holder.ready
    const asleep = nextSleep()
    const waiter = startAcquisition('waiter')
    blockRenames('waiter')
    await asleep
    const startedAt = Date.now()

    for (let cycle = 1; cycle * 4_000 < HARD_CAP_MS; cycle += 1) {
      await advanceTo(waiter, startedAt + cycle * 4_000)
      expect(waiter.settled).toBe(false)
      await releaseAcquisition(holder)
      holder = startAcquisition(`holder-${cycle}`)
      await holder.ready
    }

    await advanceTo(waiter, startedAt + HARD_CAP_MS + STEP_MS)
    expect(waiter.settled).toBe(true)
    expect(waiter.error?.message).toContain('Timed out acquiring file session lock')
    expect(waiter.settledAt! - startedAt).toBeGreaterThanOrEqual(HARD_CAP_MS)
    expect(waiter.settledAt! - startedAt).toBeLessThan(HARD_CAP_MS + 2 * STEP_MS)
  })

  it('times out instead of acquiring when a reclaim finishes past the hard cap', async () => {
    let holder = startAcquisition('holder-0')
    await holder.ready
    const asleep = nextSleep()
    const waiter = startAcquisition('waiter')
    blockRenames('waiter')
    await asleep
    const startedAt = Date.now()

    for (let cycle = 1; cycle <= 7; cycle += 1) {
      await advanceTo(waiter, startedAt + cycle * 4_000)
      expect(waiter.settled).toBe(false)
      await releaseAcquisition(holder)
      holder = startAcquisition(`holder-${cycle}`)
      await holder.ready
    }

    await advanceTo(waiter, startedAt + 28_500)
    windowsFs.blockedUnlinkPrefixes.add(join(lockPath, 'owner.'))
    await advanceUntilSettled(releaseAcquisition(holder))

    await advanceTo(waiter, startedAt + HARD_CAP_MS + 200)
    windowsFs.blockedUnlinkPrefixes.clear()
    unblockRenames('waiter')
    await tick(waiter, STEP_MS)

    expect(waiter.settled).toBe(true)
    expect(waiter.release).toBeUndefined()
    expect(waiter.error?.message).toContain('Timed out acquiring file session lock')
    expect(waiter.settledAt! - startedAt).toBeGreaterThanOrEqual(HARD_CAP_MS)
  })
})
