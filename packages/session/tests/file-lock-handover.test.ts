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
  settled: boolean
  settledAt?: number
  error?: Error
  release?: () => Promise<void>
  released: boolean
}

let root: string
let recordPath: string
let pendingPaths: Map<string, string>
let acquisitions: Acquisition[]

function labelledMakeDirectory(label: string) {
  return (async (path: string) => {
    pendingPaths.set(label, path)
    return await mkdir(path)
  }) as typeof mkdir
}

function startAcquisition(label: string): Acquisition {
  const acquisition: Acquisition = { label, settled: false, released: false }
  acquisitions.push(acquisition)
  fileSessionDriverInternals.acquireRecordLock(recordPath, labelledMakeDirectory(label)).then(
    release => Object.assign(acquisition, { settled: true, settledAt: Date.now(), release }),
    (error: Error) => Object.assign(acquisition, { settled: true, settledAt: Date.now(), error }),
  )
  return acquisition
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

function unsettled(): number {
  return acquisitions.filter(acquisition => !acquisition.settled).length
}

async function untilTrue(condition: () => boolean): Promise<void> {
  for (let turn = 0; !condition(); turn += 1) {
    if (turn > 100_000) throw new Error('Condition never held')
    await new Promise(resolve => setImmediate(resolve))
  }
}

async function untilWaitersSleep(): Promise<void> {
  await untilTrue(() => vi.getTimerCount() === liveHolders() + unsettled())
}

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await untilWaitersSleep()
}

async function advanceTo(time: number): Promise<void> {
  while (Date.now() < time) await tick(Math.min(STEP_MS, time - Date.now()))
}

async function untilAcquired(acquisition: Acquisition): Promise<void> {
  for (let tickCount = 0; !acquisition.settled; tickCount += 1) {
    if (tickCount > 200) throw new Error(`${acquisition.label} never acquired the lock`)
    await tick(STEP_MS)
  }
}

async function untilWaiterAttemptsAfter(label: string, attempts: number): Promise<void> {
  for (let tickCount = 0; renameAttempts(label) === attempts; tickCount += 1) {
    if (tickCount > 200) throw new Error(`${label} never retried its rename`)
    await tick(STEP_MS)
  }
}

describe('file session lock handover under a fake clock', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'holo-file-lock-handover-'))
    recordPath = join(root, 'session.json')
    pendingPaths = new Map()
    acquisitions = []
    windowsFs.blockedRenameSources.clear()
    windowsFs.renameAttempts.clear()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
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
    await untilTrue(() => holder.settled)
    const waiter = startAcquisition('waiter')
    await untilWaitersSleep()
    const startedAt = Date.now()

    await advanceTo(startedAt + STALL_MS - STEP_MS)
    expect(waiter.settled).toBe(false)

    await advanceTo(startedAt + STALL_MS + STEP_MS)
    expect(waiter.settled).toBe(true)
    expect(waiter.error?.message).toContain('Timed out acquiring file session lock')
    expect(waiter.settledAt! - startedAt).toBeGreaterThanOrEqual(STALL_MS)
    expect(waiter.settledAt! - startedAt).toBeLessThan(STALL_MS + 2 * STEP_MS)

    await releaseAcquisition(holder)
  })

  it('restarts the stall deadline when the lock changes hands', async () => {
    const first = startAcquisition('first')
    await untilTrue(() => first.settled)
    const waiter = startAcquisition('waiter')
    blockRenames('waiter')
    await untilWaitersSleep()
    const startedAt = Date.now()

    await advanceTo(startedAt + 4_000)
    expect(waiter.settled).toBe(false)

    await releaseAcquisition(first)
    const second = startAcquisition('second')
    await untilAcquired(second)
    await untilWaiterAttemptsAfter('waiter', renameAttempts('waiter'))

    await advanceTo(startedAt + 7_000)
    expect(waiter.settled).toBe(false)

    await releaseAcquisition(second)
    unblockRenames('waiter')
    for (let tickCount = 0; !waiter.settled && tickCount < 200; tickCount += 1) await tick(STEP_MS)
    expect(waiter.settled).toBe(true)
    expect(waiter.error).toBeUndefined()
    expect(waiter.release).toBeDefined()

    await releaseAcquisition(waiter)
  })

  it('gives up at the hard cap while the lock keeps changing hands', async () => {
    let holder = startAcquisition('holder-0')
    await untilTrue(() => holder.settled)
    const waiter = startAcquisition('waiter')
    blockRenames('waiter')
    await untilWaitersSleep()
    const startedAt = Date.now()

    for (let cycle = 1; cycle * 4_000 < HARD_CAP_MS; cycle += 1) {
      await advanceTo(startedAt + cycle * 4_000)
      expect(waiter.settled).toBe(false)
      await releaseAcquisition(holder)
      holder = startAcquisition(`holder-${cycle}`)
      await untilAcquired(holder)
    }

    await advanceTo(startedAt + HARD_CAP_MS + STEP_MS)
    expect(waiter.settled).toBe(true)
    expect(waiter.error?.message).toContain('Timed out acquiring file session lock')
    expect(waiter.settledAt! - startedAt).toBeGreaterThanOrEqual(HARD_CAP_MS)
    expect(waiter.settledAt! - startedAt).toBeLessThan(HARD_CAP_MS + 2 * STEP_MS)
  })
})
