import { mkdir, mkdtemp, type rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const staleRemoval = vi.hoisted(() => ({
  enabled: false,
  replacementAcquisitionPending: false,
  removedReplacement: false,
  replacementAcquired: false,
  removals: 0,
  lockPath: undefined as string | undefined,
}))

const staleReplacement = vi.hoisted(() => ({
  enabled: false,
  firstReclaimWaiting: false,
  lockPath: undefined as string | undefined,
  replacementAcquired: false,
  secondReclaimWaiting: false,
  staleMoved: false,
}))

const activeOwner = vi.hoisted(() => ({
  enabled: false,
  flashWrites: 0,
  firstWriteStarted: false,
  secondWriteStarted: false,
  releaseFirst: false,
  releaseSecond: false,
}))

vi.mock('node:fs/promises', async importOriginal => {
  const filesystem = await importOriginal<Record<string, unknown> & { rename: typeof rename, rm: typeof rm, writeFile: typeof writeFile }>()
  return {
    ...filesystem,
    async rename(oldPath: Parameters<typeof filesystem.rename>[0], newPath: Parameters<typeof filesystem.rename>[1]) {
      if (
        staleReplacement.enabled
        && String(oldPath) === staleReplacement.lockPath
        && String(newPath).endsWith('.stale')
      ) {
        if (!staleReplacement.firstReclaimWaiting) {
          staleReplacement.firstReclaimWaiting = true
          while (!staleReplacement.secondReclaimWaiting) await new Promise(resolve => setTimeout(resolve, 0))
          await filesystem.rename(oldPath, newPath)
          staleReplacement.staleMoved = true
          return
        }

        staleReplacement.secondReclaimWaiting = true
        while (!staleReplacement.staleMoved || !staleReplacement.replacementAcquired) {
          await new Promise(resolve => setTimeout(resolve, 0))
        }
      }
      return filesystem.rename(oldPath, newPath)
    },
    async rm(path: Parameters<typeof filesystem.rm>[0], options?: Parameters<typeof filesystem.rm>[1]) {
      if (staleRemoval.enabled && String(path) === staleRemoval.lockPath) {
        staleRemoval.removals += 1
        if (staleRemoval.removals === 2) {
          while (!staleRemoval.replacementAcquired) await new Promise(resolve => setTimeout(resolve, 0))
          if (staleRemoval.replacementAcquisitionPending) staleRemoval.removedReplacement = true
        }
      }
      return filesystem.rm(path, options)
    },
    async writeFile(path: Parameters<typeof filesystem.writeFile>[0], data: Parameters<typeof filesystem.writeFile>[1], options?: Parameters<typeof filesystem.writeFile>[2]) {
      if (activeOwner.enabled && String(path).includes('.json.flash.') && String(path).endsWith('.tmp')) {
        activeOwner.flashWrites += 1
        if (activeOwner.flashWrites === 1) {
          activeOwner.firstWriteStarted = true
          while (!activeOwner.releaseFirst) await new Promise(resolve => setTimeout(resolve, 0))
        } else if (activeOwner.flashWrites === 2) {
          activeOwner.secondWriteStarted = true
          while (!activeOwner.releaseSecond) await new Promise(resolve => setTimeout(resolve, 0))
        }
      }
      return filesystem.writeFile(path, data, options)
    },
  }
})

import { createFileSessionStore, fileSessionDriverInternals, type SessionRecord } from '../src'

const temporaryDirectories: string[] = []

afterEach(async () => {
  staleRemoval.enabled = false
  staleRemoval.replacementAcquisitionPending = false
  staleRemoval.removedReplacement = false
  staleRemoval.replacementAcquired = false
  staleRemoval.removals = 0
  staleRemoval.lockPath = undefined
  staleReplacement.enabled = false
  staleReplacement.firstReclaimWaiting = false
  staleReplacement.lockPath = undefined
  staleReplacement.replacementAcquired = false
  staleReplacement.secondReclaimWaiting = false
  staleReplacement.staleMoved = false
  activeOwner.enabled = false
  activeOwner.flashWrites = 0
  activeOwner.firstWriteStarted = false
  activeOwner.secondWriteStarted = false
  activeOwner.releaseFirst = false
  activeOwner.releaseSecond = false
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

describe('file session locking', () => {
  it('does not reclaim a lock held by a live owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-active-owner-'))
    temporaryDirectories.push(root)
    const store = createFileSessionStore(root)
    const now = new Date()
    const record: SessionRecord = Object.freeze({
      createdAt: now,
      data: Object.freeze({}),
      expiresAt: new Date(now.getTime() + 60_000),
      id: 'session',
      lastActivityAt: now,
      store: 'file',
    })
    await store.write(record)
    const flash = store.flash
    if (!flash) throw new Error('File session stores must support flash values.')
    const lockPath = `${fileSessionDriverInternals.getRecordPath(root, record.id)}.lock`
    activeOwner.enabled = true

    const first = flash(record.id, 'first', true)
    while (!activeOwner.firstWriteStarted) await new Promise(resolve => setTimeout(resolve, 0))
    const staleTime = new Date(Date.now() - 20_000)
    await utimes(join(lockPath, 'owner.json'), staleTime, staleTime)
    const second = flash(record.id, 'second', true)
    await new Promise(resolve => setTimeout(resolve, 20))
    const liveOwnerWasReclaimed = activeOwner.secondWriteStarted

    activeOwner.releaseFirst = true
    await first
    while (!activeOwner.secondWriteStarted) await new Promise(resolve => setTimeout(resolve, 0))
    activeOwner.releaseSecond = true
    await second

    expect(liveOwnerWasReclaimed).toBe(false)
  })

  it('reclaims a lock held by a terminated local process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-terminated-owner-'))
    temporaryDirectories.push(root)
    const store = createFileSessionStore(root)
    const now = new Date()
    const record: SessionRecord = Object.freeze({
      createdAt: now,
      data: Object.freeze({}),
      expiresAt: new Date(now.getTime() + 60_000),
      id: 'session',
      lastActivityAt: now,
      store: 'file',
    })
    await store.write(record)
    const flash = store.flash
    const take = store.take
    if (!flash || !take) throw new Error('File session stores must support flash values.')
    const lockPath = `${fileSessionDriverInternals.getRecordPath(root, record.id)}.lock`
    await mkdir(lockPath)
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      host: hostname(),
      pid: 999_999,
      token: 'terminated-owner',
    }))

    await flash(record.id, 'message', 'ready')

    await expect(take(record.id, 'message')).resolves.toEqual({ found: true, value: 'ready' })
  })

  it('reclaims a stale local lock after its owner PID is reused', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-reused-owner-'))
    temporaryDirectories.push(root)
    const store = createFileSessionStore(root)
    const now = new Date()
    const record: SessionRecord = Object.freeze({
      createdAt: now,
      data: Object.freeze({}),
      expiresAt: new Date(now.getTime() + 60_000),
      id: 'session',
      lastActivityAt: now,
      store: 'file',
    })
    await store.write(record)
    const flash = store.flash
    if (!flash) throw new Error('File session stores must support flash values.')
    const lockPath = `${fileSessionDriverInternals.getRecordPath(root, record.id)}.lock`
    const ownerPath = join(lockPath, 'owner.json')
    await mkdir(lockPath)
    await writeFile(ownerPath, JSON.stringify({
      host: hostname(),
      pid: process.pid,
      token: 'reused-owner',
    }))
    const staleTime = new Date(Date.now() - 20_000)
    await utimes(ownerPath, staleTime, staleTime)

    await expect(flash(record.id, 'message', 'ready')).resolves.toBeUndefined()
  }, 7_000)

  it('reclaims a stale lock created on a previous host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-previous-host-'))
    temporaryDirectories.push(root)
    const store = createFileSessionStore(root)
    const now = new Date()
    const record: SessionRecord = Object.freeze({
      createdAt: now,
      data: Object.freeze({}),
      expiresAt: new Date(now.getTime() + 60_000),
      id: 'session',
      lastActivityAt: now,
      store: 'file',
    })
    await store.write(record)
    const flash = store.flash
    if (!flash) throw new Error('File session stores must support flash values.')
    const lockPath = `${fileSessionDriverInternals.getRecordPath(root, record.id)}.lock`
    const ownerPath = join(lockPath, 'owner.json')
    await mkdir(lockPath)
    await writeFile(ownerPath, JSON.stringify({
      host: `${hostname()}-previous`,
      pid: 1,
      token: 'previous-host-owner',
    }))
    const staleTime = new Date(Date.now() - 20_000)
    await utimes(lockPath, staleTime, staleTime)
    await utimes(ownerPath, staleTime, staleTime)

    await expect(flash(record.id, 'message', 'ready')).resolves.toBeUndefined()
  }, 7_000)

  it('does not let a stale contender remove a replacement lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-stale-lock-'))
    temporaryDirectories.push(root)
    const setupStore = createFileSessionStore(root)
    const now = new Date()
    const record: SessionRecord = Object.freeze({
      createdAt: now,
      data: Object.freeze({}),
      expiresAt: new Date(now.getTime() + 60_000),
      id: 'session',
      lastActivityAt: now,
      store: 'file',
    })
    await setupStore.write(record)
    const lockPath = `${fileSessionDriverInternals.getRecordPath(root, record.id)}.lock`
    staleRemoval.lockPath = lockPath
    await mkdir(lockPath)
    const staleTime = new Date(Date.now() - 20_000)
    await utimes(lockPath, staleTime, staleTime)
    const store = fileSessionDriverInternals.createStore(root, (async (path, options) => {
      const result = await mkdir(path, options)
      if (!options && staleRemoval.enabled && !staleRemoval.replacementAcquired) {
        staleRemoval.replacementAcquired = true
        staleRemoval.replacementAcquisitionPending = true
        for (let attempt = 0; attempt < 20 && !staleRemoval.removedReplacement; attempt += 1) {
          await new Promise(resolve => setTimeout(resolve, 1))
        }
        staleRemoval.replacementAcquisitionPending = false
      }
      return result
    }) as typeof mkdir)
    staleRemoval.enabled = true
    const flash = store.flash
    if (!flash) throw new Error('File session stores must support flash values.')

    await Promise.all([
      flash(record.id, 'first', true),
      flash(record.id, 'second', true),
    ])

    expect(staleRemoval.removedReplacement).toBe(false)
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not let a delayed stale contender enter beside a replacement owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-stale-replacement-'))
    temporaryDirectories.push(root)
    const setupStore = createFileSessionStore(root)
    const now = new Date()
    const record: SessionRecord = Object.freeze({
      createdAt: now,
      data: Object.freeze({}),
      expiresAt: new Date(now.getTime() + 60_000),
      id: 'session',
      lastActivityAt: now,
      store: 'file',
    })
    await setupStore.write(record)
    const lockPath = `${fileSessionDriverInternals.getRecordPath(root, record.id)}.lock`
    await mkdir(lockPath)
    const staleTime = new Date(Date.now() - 20_000)
    await utimes(lockPath, staleTime, staleTime)
    staleReplacement.lockPath = lockPath
    staleReplacement.enabled = true
    activeOwner.enabled = true
    const store = fileSessionDriverInternals.createStore(root, (async (path, options) => {
      const result = await mkdir(path, options)
      if (String(path) === lockPath && staleReplacement.staleMoved) {
        staleReplacement.replacementAcquired = true
      }
      return result
    }) as typeof mkdir)
    const flash = store.flash
    if (!flash) throw new Error('File session stores must support flash values.')

    const first = flash(record.id, 'first', true)
    const second = flash(record.id, 'second', true)
    while (!activeOwner.firstWriteStarted) await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 20))
    const replacementWasEnteredConcurrently = activeOwner.secondWriteStarted

    activeOwner.releaseFirst = true
    while (!activeOwner.secondWriteStarted) await new Promise(resolve => setTimeout(resolve, 0))
    activeOwner.releaseSecond = true
    await Promise.all([first, second])

    expect(replacementWasEnteredConcurrently).toBe(false)
  })
})
