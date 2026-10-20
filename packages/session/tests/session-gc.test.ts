import { mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configureSessionRuntime,
  createFileSessionStore,
  createSession,
  normalizeSessionConfig,
  sessionRuntimeInternals,
  touchSession,
  type SessionRecord,
  type SessionStore,
} from '../src'
import { fileSessionDriverInternals } from '../src/drivers/file'

const roots: string[] = []

afterEach(async () => {
  configureSessionRuntime(undefined)
  sessionRuntimeInternals.setSessionLotteryRandom(undefined)
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-session-gc-'))
  roots.push(root)
  return root
}

function record(id: string, expiresAt: Date, data: Record<string, unknown> = { userId: 42 }): SessionRecord {
  const now = new Date()
  return { id, store: 'file', data, createdAt: now, lastActivityAt: now, expiresAt }
}

async function waitForTombstonesToDrain(root: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && (await readdir(root)).some(name => name.endsWith('.released'))) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function sweepable(store: SessionStore): (now: Date) => Promise<number> {
  if (!store.sweepExpired) throw new Error('File session stores must sweep expired records.')
  return store.sweepExpired.bind(store)
}

describe('file session garbage collection', () => {
  it('continues bounded sweeps past live records to reach abandoned sessions', async () => {
    const root = await createRoot()
    const store = createFileSessionStore(root)
    for (let batch = 0; batch < 21; batch += 1) {
      await Promise.all(Array.from({ length: 50 }, (_, index) => {
        const live = record(`live-${batch * 50 + index}`, new Date(Date.now() + 60_000))
        return store.write(live)
      }))
    }
    await waitForTombstonesToDrain(root)
    await expect(sweepable(store)(new Date())).resolves.toBe(0)
    for (let batch = 0; batch < 21; batch += 1) {
      await Promise.all(Array.from({ length: 50 }, (_, index) => {
        return store.write(record(`live-${batch * 50 + index}`, new Date(Date.now() - 1_000)))
      }))
    }

    await waitForTombstonesToDrain(root)
    await expect(sweepable(store)(new Date())).resolves.toBe(50)
    await expect(sweepable(store)(new Date())).resolves.toBe(1_000)
    await expect(sweepable(store)(new Date())).resolves.toBe(0)
  }, 30_000)

  it('removes abandoned expired records and keeps live ones', async () => {
    const root = await createRoot()
    const store = createFileSessionStore(root)
    const expired = record(randomUUID(), new Date(Date.now() - 1_000))
    const live = record(randomUUID(), new Date(Date.now() + 60_000))
    await store.write(expired)
    await store.write(live)

    await expect(sweepable(store)(new Date())).resolves.toBe(1)

    await expect(store.read(expired.id)).resolves.toBeNull()
    await expect(store.read(live.id)).resolves.toMatchObject({ id: live.id })
  })

  it('keeps an expired record whose lock is held and removes it after the lock is released', async () => {
    const root = await createRoot()
    const store = createFileSessionStore(root)
    const expired = record(randomUUID(), new Date(Date.now() - 1_000))
    await store.write(expired)
    const releaseLock = await fileSessionDriverInternals.acquireRecordLock(
      fileSessionDriverInternals.getRecordPath(root, expired.id),
      (await import('node:fs/promises')).mkdir,
    )

    await expect(sweepable(store)(new Date())).resolves.toBe(0)
    await expect(store.read(expired.id)).resolves.toMatchObject({ id: expired.id })

    await releaseLock()
    await expect(sweepable(store)(new Date())).resolves.toBe(1)
    await expect(store.read(expired.id)).resolves.toBeNull()
  })

  it('never follows a symbolic link into a file outside the session directory', async () => {
    const root = await createRoot()
    const outside = await createRoot()
    const target = join(outside, 'victim.json')
    await writeFile(target, JSON.stringify({ keep: true }))
    await symlink(target, join(root, `${encodeURIComponent(randomUUID())}.json`))
    const store = createFileSessionStore(root)

    await sweepable(store)(new Date())

    await expect(import('node:fs/promises').then(fs => fs.readFile(target, 'utf8'))).resolves.toBe(JSON.stringify({ keep: true }))
  })

  it('runs the sweep on a request that writes a session when the lottery hits', async () => {
    const root = await createRoot()
    const store = createFileSessionStore(root)
    const expired = record(randomUUID(), new Date(Date.now() - 1_000))
    await store.write(expired)
    configureSessionRuntime({
      config: normalizeSessionConfig({ driver: 'file', stores: { file: { driver: 'file', path: root } } }),
      stores: { file: store },
    })

    sessionRuntimeInternals.setSessionLotteryRandom(() => 0)
    await createSession({ data: { userId: 7 } })

    await expect(store.read(expired.id)).resolves.toBeNull()
  })

  it('skips the sweep when the lottery misses', async () => {
    const root = await createRoot()
    const store = createFileSessionStore(root)
    const expired = record(randomUUID(), new Date(Date.now() - 1_000))
    await store.write(expired)
    configureSessionRuntime({
      config: normalizeSessionConfig({ driver: 'file', stores: { file: { driver: 'file', path: root } } }),
      stores: { file: store },
    })

    sessionRuntimeInternals.setSessionLotteryRandom(() => 0.99)
    await createSession({ data: { userId: 7 } })

    await expect(store.read(expired.id)).resolves.toMatchObject({ id: expired.id })
  })

  it('runs the lottery when an existing session is touched', async () => {
    const root = await createRoot()
    const store = createFileSessionStore(root)
    const expired = record(randomUUID(), new Date(Date.now() - 1_000))
    const live = record(randomUUID(), new Date(Date.now() + 60_000))
    await store.write(expired)
    await store.write(live)
    configureSessionRuntime({
      config: normalizeSessionConfig({ driver: 'file', stores: { file: { driver: 'file', path: root } } }),
      stores: { file: store },
    })
    sessionRuntimeInternals.setSessionLotteryRandom(() => 0)

    await touchSession(live.id)

    await expect(store.read(expired.id)).resolves.toBeNull()
    await expect(store.read(live.id)).resolves.toMatchObject({ id: live.id })
  })

  it('removes release tombstones that a background unlink gave up on', async () => {
    const root = await createRoot()
    const store = createFileSessionStore(root)
    await writeFile(join(root, `${encodeURIComponent(randomUUID())}.json.lock.${randomUUID()}.released`), '')

    await sweepable(store)(new Date())

    await expect(readdir(root)).resolves.not.toContainEqual(expect.stringMatching(/\.released$/))
  })
})
