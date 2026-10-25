import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SessionModule from '../src'
import { advanceUntil, useFakeClock } from './support/fake-clock'
import { createMemoryFs, type MemoryFs } from './support/memory-fs'

const memory = vi.hoisted((): { fs?: MemoryFs } => ({}))

vi.mock('node:fs/promises', async () => (await import('./support/memory-fs')).memoryFsModule(() => memory.fs))
vi.mock('node:timers/promises', async () => (await import('./support/fake-clock')).fakeTimersPromises())

const SWEEP_ENTRY_LIMIT = 1_000
const RECORD_COUNT = 1_050

const root = resolve('/memory/session-gc')
let fs: MemoryFs
let session: typeof SessionModule

function record(id: string, expiresAt: Date): SessionModule.SessionRecord {
  const now = new Date()
  return { id, store: 'file', data: { userId: 42 }, createdAt: now, lastActivityAt: now, expiresAt }
}

function recordNames(): string[] {
  return fs.names(root).filter(name => name.endsWith('.json'))
}

async function writeRecords(store: SessionModule.SessionStore, count: number, expiresAt: Date): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await store.write(record(`live-${String(index).padStart(4, '0')}`, expiresAt))
  }
  await advanceUntil(() => fs.names(root).length === count, 'the background lease releases to finish', 1_000)
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
  })

  afterEach(() => {
    vi.useRealTimers()
    memory.fs = undefined
  })

  it('continues bounded sweeps past live records to reach abandoned sessions', async () => {
    const store = session.createFileSessionStore(root)
    await writeRecords(store, RECORD_COUNT, new Date(Date.now() + 60_000))
    await expect(sweepable(store)(new Date())).resolves.toBe(0)

    await writeRecords(store, RECORD_COUNT, new Date(Date.now() - 1_000))

    await expect(sweepable(store)(new Date())).resolves.toBe(RECORD_COUNT - SWEEP_ENTRY_LIMIT)
    await expect(sweepable(store)(new Date())).resolves.toBe(SWEEP_ENTRY_LIMIT)
    await expect(sweepable(store)(new Date())).resolves.toBe(0)
    expect(recordNames()).toEqual([])
  })

  it('reclaims an abandoned session on the next sweep when a release tombstone takes its slot', async () => {
    const store = session.createFileSessionStore(root)
    await writeRecords(store, SWEEP_ENTRY_LIMIT, new Date(Date.now() - 1_000))
    const tombstone = `live-0000.json.lock.${randomUUID()}.released`
    await fs.promises.writeFile(join(root, tombstone), '')

    await expect(sweepable(store)(new Date())).resolves.toBe(SWEEP_ENTRY_LIMIT - 1)
    expect(recordNames()).toEqual(['live-0999.json'])
    await expect(sweepable(store)(new Date())).resolves.toBe(1)
    expect(recordNames()).toEqual([])
  })
})
