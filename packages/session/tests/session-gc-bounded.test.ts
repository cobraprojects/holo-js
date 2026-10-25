import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SessionModule from '../src'
import type * as FileDriverModule from '../src/drivers/file'
import { advanceTo, advanceUntil, useFakeClock } from '../../../tests/support/fake-clock'
import { createMemoryFs, type MemoryFs } from '../../../tests/support/memory-fs'

const memory = vi.hoisted((): { fs?: MemoryFs } => ({}))

vi.mock('node:fs/promises', async () => (await import('../../../tests/support/memory-fs')).memoryFsModule(() => memory.fs))
vi.mock('node:timers/promises', async () => (await import('../../../tests/support/fake-clock')).fakeTimersPromises())

const DEFAULT_SWEEP_ENTRY_LIMIT = 1_000
const SWEEP_ENTRY_LIMIT = 10
const RECORD_COUNT = 15
const RELEASE_SETTLE_MS = 1_000
const IDLE_GAP_MS = 60_000

const root = resolve('/memory/session-gc')
let fs: MemoryFs
let session: typeof SessionModule
let fileDriver: typeof FileDriverModule

function record(id: string, expiresAt: Date): SessionModule.SessionRecord {
  const now = new Date()
  return { id, store: 'file', data: { userId: 42 }, createdAt: now, lastActivityAt: now, expiresAt }
}

function recordId(index: number): string {
  return `session-${String(index).padStart(4, '0')}`
}

function recordNames(): string[] {
  return fs.names(root).filter(name => name.endsWith('.json'))
}

function createStore(): SessionModule.SessionStore {
  return fileDriver.createFileSessionStoreWithSweepEntryLimit(root, SWEEP_ENTRY_LIMIT)
}

async function writeRecords(store: SessionModule.SessionStore, count: number, expiresAt: Date): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await store.write(record(recordId(index), expiresAt))
  }
  await awaitTombstonesDrained()
}

async function awaitTombstonesDrained(): Promise<void> {
  await advanceUntil(() => !fs.names(root).some(name => name.endsWith('.released')), 'the release tombstones to be unlinked', RELEASE_SETTLE_MS)
}

function trackDirectoryHandles(): { reads: number, open: number } {
  const handles = { reads: 0, open: 0 }
  const opendir = fs.promises.opendir
  fs.promises.opendir = async (path: string) => {
    const directory = await opendir(path)
    handles.open += 1
    return {
      read: async () => {
        handles.reads += 1
        return await directory.read()
      },
      close: async () => {
        handles.open -= 1
        await directory.close()
      },
    }
  }
  return handles
}

function sweepable(store: SessionModule.SessionStore): (now: Date) => Promise<number> {
  if (!store.sweepExpired) throw new Error('File session stores must sweep expired records.')
  return store.sweepExpired.bind(store)
}

describe('bounded file session garbage collection', () => {
  beforeEach(async () => {
    useFakeClock()
    fs = createMemoryFs({ platform: 'posix' })
    memory.fs = fs
    await fs.promises.mkdir(root, { recursive: true })
    vi.resetModules()
    session = await import('../src')
    fileDriver = await import('../src/drivers/file')
  })

  afterEach(() => {
    vi.useRealTimers()
    memory.fs = undefined
  })

  it('inspects a thousand directory entries per sweep by default', async () => {
    const store = session.createFileSessionStore(root)
    const sweep = sweepable(store)
    const { getRecordPath, serializeRecord } = session.fileSessionDriverInternals
    const expiresAt = new Date(Date.now() - 1_000)
    for (let index = 0; index <= DEFAULT_SWEEP_ENTRY_LIMIT; index += 1) {
      const id = recordId(index)
      await fs.promises.writeFile(getRecordPath(root, id), serializeRecord(record(id, expiresAt)))
    }

    await expect(sweep(new Date())).resolves.toBe(DEFAULT_SWEEP_ENTRY_LIMIT)
    await expect(sweep(new Date())).resolves.toBe(1)
    expect(recordNames()).toEqual([])
  })

  it('continues bounded sweeps past live records to reach abandoned sessions', async () => {
    const store = createStore()
    const sweep = sweepable(store)
    await writeRecords(store, RECORD_COUNT, new Date(Date.now() + 60_000))
    await expect(sweep(new Date())).resolves.toBe(0)

    await writeRecords(store, RECORD_COUNT, new Date(Date.now() - 1_000))

    await expect(sweep(new Date())).resolves.toBe(RECORD_COUNT - SWEEP_ENTRY_LIMIT)
    await expect(sweep(new Date())).resolves.toBe(SWEEP_ENTRY_LIMIT)
    await expect(sweep(new Date())).resolves.toBe(0)
    expect(recordNames()).toEqual([])
  })

  it('reclaims an abandoned session on the next sweep when a release tombstone takes its slot', async () => {
    const store = createStore()
    const sweep = sweepable(store)
    await writeRecords(store, SWEEP_ENTRY_LIMIT, new Date(Date.now() - 1_000))
    const tombstone = `session-0000.json.lock.${randomUUID()}.released`
    await fs.promises.writeFile(join(root, tombstone), '')

    await expect(sweep(new Date())).resolves.toBe(SWEEP_ENTRY_LIMIT - 1)
    expect(recordNames()).toEqual([`${recordId(SWEEP_ENTRY_LIMIT - 1)}.json`])
    expect(fs.names(root)).not.toContain(tombstone)
    await expect(sweep(new Date())).resolves.toBe(1)
    expect(recordNames()).toEqual([])
  })

  it('resumes the sweep where it stopped after a minute idle', async () => {
    const store = createStore()
    const sweep = sweepable(store)
    await writeRecords(store, SWEEP_ENTRY_LIMIT, new Date(Date.now() + 10 * IDLE_GAP_MS))
    await store.write(record('stale', new Date(Date.now() - 1_000)))
    await awaitTombstonesDrained()

    await expect(sweep(new Date())).resolves.toBe(0)
    await advanceTo(Date.now() + IDLE_GAP_MS)

    await expect(sweep(new Date())).resolves.toBe(1)
    expect(recordNames()).not.toContain('stale.json')
  })

  it('resumes after a minute idle without skipping past the sessions it removed', async () => {
    const store = createStore()
    const sweep = sweepable(store)
    await writeRecords(store, SWEEP_ENTRY_LIMIT, new Date(Date.now() - 1_000))
    await store.write(record('stale', new Date(Date.now() - 1_000)))
    await awaitTombstonesDrained()

    await expect(sweep(new Date())).resolves.toBe(SWEEP_ENTRY_LIMIT)
    await advanceTo(Date.now() + IDLE_GAP_MS)

    await expect(sweep(new Date())).resolves.toBe(1)
    expect(recordNames()).toEqual([])
  })

  it('reads at most the entry budget per sweep however far the pass has gone', async () => {
    const store = createStore()
    const sweep = sweepable(store)
    const passLength = 5
    await writeRecords(store, passLength * SWEEP_ENTRY_LIMIT, new Date(Date.now() + 10 * passLength * IDLE_GAP_MS))
    await store.write(record('stale', new Date(Date.now() - 1_000)))
    await awaitTombstonesDrained()
    const handles = trackDirectoryHandles()

    const removed: number[] = []
    for (let sweeps = 0; sweeps <= passLength; sweeps += 1) {
      handles.reads = 0
      removed.push(await sweep(new Date()))
      expect(handles.reads).toBeLessThanOrEqual(SWEEP_ENTRY_LIMIT)
      await advanceTo(Date.now() + IDLE_GAP_MS)
    }

    expect(removed).toEqual([0, 0, 0, 0, 0, 1])
    expect(handles.open).toBe(0)
  })

  it('closes the open sweep handle when the session runtime is reset or rebound', async () => {
    const store = createStore()
    const sweep = sweepable(store)
    await writeRecords(store, SWEEP_ENTRY_LIMIT + 1, new Date(Date.now() + IDLE_GAP_MS))
    const handles = trackDirectoryHandles()
    const bindings = {
      config: session.normalizeSessionConfig({ driver: 'file', stores: { file: { driver: 'file', path: root } } }),
      stores: { file: store },
    }

    session.configureSessionRuntime(bindings)
    await sweep(new Date())
    expect(handles.open).toBe(1)
    session.resetSessionRuntime()
    await advanceUntil(() => handles.open === 0, 'the sweep handle to close on reset', RELEASE_SETTLE_MS)

    session.configureSessionRuntime(bindings)
    await sweep(new Date())
    expect(handles.open).toBe(1)
    session.configureSessionRuntime(undefined)
    await advanceUntil(() => handles.open === 0, 'the sweep handle to close on rebind', RELEASE_SETTLE_MS)
  })

  it('closes the sweep handle after a sweep that was running when the runtime was reset', async () => {
    const store = createStore()
    const sweep = sweepable(store)
    await writeRecords(store, SWEEP_ENTRY_LIMIT + 1, new Date(Date.now() + IDLE_GAP_MS))
    const handles = trackDirectoryHandles()
    session.configureSessionRuntime({
      config: session.normalizeSessionConfig({ driver: 'file', stores: { file: { driver: 'file', path: root } } }),
      stores: { file: store },
    })

    const running = sweep(new Date())
    session.resetSessionRuntime()
    await expect(running).resolves.toBe(0)

    expect(handles.open).toBe(0)
  })
})
