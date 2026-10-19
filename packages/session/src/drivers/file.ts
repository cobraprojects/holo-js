import { randomUUID } from 'node:crypto'
import { constants as fsConstants, type Dir } from 'node:fs'
import { mkdir as defaultMkdir, lstat, open, opendir, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { SessionRecord, SessionStore } from '../contracts'

const RECORD_LOCK_STALE_MS = 10_000
const SWEEP_ENTRY_LIMIT = 1_000
const RECORD_LOCK_HEARTBEAT_MS = 3_000
const PROCESS_INSTANCE_TOKEN = randomUUID()
type MakeDirectory = typeof defaultMkdir

type RecordLockOwner = {
  readonly host: string
  readonly pid: number
  readonly processToken?: string
  readonly token: string
}

type RecordLockIdentity = {
  readonly device: number
  readonly inode: number
  readonly modifiedAt: number
  readonly owner?: RecordLockOwner
  readonly fileName?: string
}

function serializeRecord(record: SessionRecord): string {
  return JSON.stringify({
    ...record,
    createdAt: record.createdAt.toISOString(),
    lastActivityAt: record.lastActivityAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  })
}

function deserializeRecord(raw: string): SessionRecord {
  const parsed = JSON.parse(raw) as Omit<SessionRecord, 'createdAt' | 'lastActivityAt' | 'expiresAt'> & {
    createdAt: string
    lastActivityAt: string
    expiresAt: string
  }
  return Object.freeze({
    ...parsed,
    createdAt: new Date(parsed.createdAt),
    lastActivityAt: new Date(parsed.lastActivityAt),
    expiresAt: new Date(parsed.expiresAt),
  })
}

function getRecordPath(root: string, sessionId: string): string {
  return join(root, `${encodeURIComponent(sessionId)}.json`)
}

function getFlashPath(recordPath: string): string {
  return `${recordPath}.flash`
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function parseRecordLockOwner(value: unknown): RecordLockOwner | undefined {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !('host' in value)
    || typeof value.host !== 'string'
    || !value.host
    || !('pid' in value)
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) < 1
    || !('token' in value)
    || typeof value.token !== 'string'
    || !value.token
  ) {
    return undefined
  }
  const processToken = 'processToken' in value && typeof value.processToken === 'string' && value.processToken
    ? value.processToken
    : undefined
  return Object.freeze({
    host: value.host,
    pid: value.pid as number,
    ...(processToken ? { processToken } : {}),
    token: value.token,
  })
}

function recordLockOwnerFileName(owner: RecordLockOwner): string {
  return `owner.${encodeURIComponent(owner.token)}.json`
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, delayMs))
}

async function readRecordLockIdentity(lockPath: string): Promise<RecordLockIdentity | undefined> {
  let fileName: string | undefined
  try {
    fileName = (await readdir(lockPath)).find(name => name.startsWith('owner.') && name.endsWith('.json'))
  } catch (error) {
    if (isMissingFileError(error)) return undefined
    throw error
  }
  const identityPath = fileName ? join(lockPath, fileName) : lockPath
  let owner: RecordLockOwner | undefined
  if (fileName) {
    try {
      owner = parseRecordLockOwner(JSON.parse(await readFile(identityPath, 'utf8')) as unknown)
      if (owner && recordLockOwnerFileName(owner) !== fileName) owner = undefined
    } catch (error) {
      if (!(error instanceof SyntaxError) && !isMissingFileError(error)) throw error
    }
  }
  const identity = await stat(identityPath).catch(() => undefined)
  if (!identity) return undefined
  return Object.freeze({ device: identity.dev, inode: identity.ino, modifiedAt: identity.mtimeMs, ...(owner ? { owner } : {}), ...(fileName ? { fileName } : {}) })
}

function recordLockIdentityMatches(left: RecordLockIdentity, right: RecordLockIdentity | undefined): boolean {
  return right !== undefined
    && left.device === right.device
    && left.inode === right.inode
    && left.fileName === right.fileName
    && left.modifiedAt === right.modifiedAt
    && left.owner?.token === right.owner?.token
}

async function removeRecordLock(lockPath: string, fileName?: string): Promise<boolean> {
  if (fileName) {
    try { await unlink(join(lockPath, fileName)) } catch (error) { if (!isMissingFileError(error)) throw error }
  }
  try {
    await rmdir(lockPath)
    return true
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST') return false
    throw error
  }
}

async function reclaimStaleLock(lockPath: string, expected: RecordLockIdentity): Promise<boolean> {
  if (!recordLockIdentityMatches(expected, await readRecordLockIdentity(lockPath))) return false
  return removeRecordLock(lockPath, expected.fileName)
}

async function reclaimableRecordLock(lockPath: string): Promise<RecordLockIdentity | undefined> {
  const identity = await readRecordLockIdentity(lockPath)
  if (!identity) return undefined
  const owner = identity.owner
  if (owner?.host === hostname()) {
    if (owner.pid === process.pid) {
      if (owner.processToken === PROCESS_INSTANCE_TOKEN) return undefined
    } else {
      return processIsRunning(owner.pid) ? undefined : identity
    }
  }
  const leasePath = identity.fileName ? join(lockPath, identity.fileName) : lockPath
  const stale = await stat(leasePath).then(value => value.mtimeMs <= Date.now() - RECORD_LOCK_STALE_MS).catch(() => false)
  return stale ? identity : undefined
}

async function acquireRecordLock(recordPath: string, makeDirectory: MakeDirectory): Promise<() => Promise<void>> {
  const release = await acquireRecordLockBefore(recordPath, makeDirectory, Date.now() + 5_000)
  if (!release) throw new Error(`[@holo-js/session] Timed out acquiring file session lock for "${recordPath}".`)
  return release
}

async function acquireRecordLockBefore(
  recordPath: string,
  makeDirectory: MakeDirectory,
  deadline: number | undefined,
): Promise<(() => Promise<void>) | undefined> {
  const lockPath = `${recordPath}.lock`
  const owner = Object.freeze({ host: hostname(), pid: process.pid, processToken: PROCESS_INSTANCE_TOKEN, token: randomUUID() })
  const pendingPath = `${lockPath}.${owner.token}.pending`
  await makeDirectory(pendingPath)
  let ownerHandle
  let acquired = false
  try {
    ownerHandle = await open(join(pendingPath, recordLockOwnerFileName(owner)), 'wx', 0o600)
    await ownerHandle.writeFile(`${JSON.stringify(owner)}\n`, { encoding: 'utf8' })
    await ownerHandle.sync()
    while (!acquired) {
      try {
        await rename(pendingPath, lockPath)
        acquired = true
      } catch (error) {
        const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
        const reclaimable = await reclaimableRecordLock(lockPath)
        if (reclaimable && await reclaimStaleLock(lockPath, reclaimable)) continue
        if (deadline === undefined) {
          await ownerHandle.close()
          await rm(pendingPath, { recursive: true, force: true })
          return undefined
        }
        if (Date.now() >= deadline) throw new Error(`[@holo-js/session] Timed out acquiring file session lock for "${recordPath}".`)
        await sleep(5)
      }
    }
    const handle = ownerHandle
    const heartbeat = setInterval(() => {
      const now = new Date()
      void handle.utimes(now, now).catch(() => undefined)
    }, RECORD_LOCK_HEARTBEAT_MS)
    heartbeat.unref()
    return async () => {
      clearInterval(heartbeat)
      await handle.close()
      await removeRecordLock(lockPath, recordLockOwnerFileName(owner))
    }
  } catch (error) {
    await ownerHandle?.close()
    if (acquired) await removeRecordLock(lockPath, recordLockOwnerFileName(owner))
    else await rm(pendingPath, { recursive: true, force: true })
    throw error
  }
}

async function writePathAtomically(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

function deserializeFlashEntries(raw: string): Map<string, unknown> {
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) throw new Error('[@holo-js/session] File session flash data is malformed.')
  const entries = new Map<string, unknown>()
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') {
      throw new Error('[@holo-js/session] File session flash data is malformed.')
    }
    entries.set(entry[0], entry[1])
  }
  return entries
}

async function readFlashEntries(recordPath: string): Promise<Map<string, unknown>> {
  try {
    return deserializeFlashEntries(await readFile(getFlashPath(recordPath), 'utf8'))
  } catch (error) {
    if (isMissingFileError(error)) return new Map()
    throw error
  }
}

async function readActiveRecord(recordPath: string): Promise<SessionRecord | null> {
  try {
    const record = deserializeRecord(await readFile(recordPath, 'utf8'))
    return record.expiresAt.getTime() > Date.now() ? record : null
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
}

async function writeRecordAtomically(
  root: string,
  record: SessionRecord,
  makeDirectory: MakeDirectory,
): Promise<void> {
  await makeDirectory(root, { recursive: true, mode: 0o700 })
  const recordPath = getRecordPath(root, record.id)
  const release = await acquireRecordLock(recordPath, makeDirectory)
  try {
    await writePathAtomically(recordPath, serializeRecord(record))
  } finally {
    await release()
  }
}

async function acquireRecordLocks(
  recordPaths: readonly string[],
  makeDirectory: MakeDirectory,
): Promise<() => Promise<void>> {
  const releases: Array<() => Promise<void>> = []
  try {
    for (const recordPath of [...new Set(recordPaths)].sort()) {
      releases.push(await acquireRecordLock(recordPath, makeDirectory))
    }
  } catch (error) {
    for (const release of releases.reverse()) await release()
    throw error
  }
  return async () => {
    for (const release of releases.reverse()) await release()
  }
}

async function readRecordWithoutFollowingLinks(recordPath: string): Promise<SessionRecord | null> {
  const handle = await open(recordPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  try {
    return deserializeRecord(await handle.readFile({ encoding: 'utf8' }))
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

function createExpiredSessionSweeper(root: string, makeDirectory: MakeDirectory): (now: Date) => Promise<number> {
  let directory: Dir | undefined
  let sweeping = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  async function closeDirectory(): Promise<void> {
    const current = directory
    directory = undefined
    await current?.close()
  }

  return async (now) => {
    if (sweeping) return 0
    sweeping = true
    clearTimeout(idleTimer)
    try {
      directory ??= await opendir(root)
      let removed = 0
      for (let inspected = 0; inspected < SWEEP_ENTRY_LIMIT; inspected += 1) {
        const entry = await directory.read()
        if (!entry) {
          await closeDirectory()
          break
        }
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const recordPath = join(root, entry.name)
        try {
          if (!(await lstat(recordPath)).isFile()) continue
          const candidate = await readRecordWithoutFollowingLinks(recordPath)
          if (!candidate || candidate.expiresAt.getTime() > now.getTime()) continue

          const release = await acquireRecordLockBefore(recordPath, makeDirectory, undefined)
          if (!release) continue
          try {
            const current = await readRecordWithoutFollowingLinks(recordPath)
            if (current && current.expiresAt.getTime() <= now.getTime()) {
              await Promise.all([rm(recordPath, { force: true }), rm(getFlashPath(recordPath), { force: true })])
              removed += 1
            }
          } finally {
            await release()
          }
        } catch (error) {
          if (!isMissingFileError(error) && (error as NodeJS.ErrnoException).code !== 'ELOOP') throw error
        }
      }
      return removed
    } catch (error) {
      await closeDirectory()
      if (isMissingFileError(error)) return 0
      throw error
    } finally {
      sweeping = false
      if (directory) {
        idleTimer = setTimeout(() => { void closeDirectory().catch(() => undefined) }, 60_000)
        idleTimer.unref()
      }
    }
  }
}

function createFileSessionStoreWithMakeDirectory(root: string, makeDirectory: MakeDirectory): SessionStore {
  const sweepExpired = createExpiredSessionSweeper(root, makeDirectory)
  return {
    async read(sessionId) {
      try {
        return deserializeRecord(await readFile(getRecordPath(root, sessionId), 'utf8'))
      } catch (error) {
        if (isMissingFileError(error)) return null
        throw error
      }
    },
    async write(record) {
      await writeRecordAtomically(root, record, makeDirectory)
    },
    async delete(sessionId) {
      await makeDirectory(root, { recursive: true, mode: 0o700 })
      const recordPath = getRecordPath(root, sessionId)
      const release = await acquireRecordLock(recordPath, makeDirectory)
      try {
        await Promise.all([rm(recordPath, { force: true }), rm(getFlashPath(recordPath), { force: true })])
      } finally {
        await release()
      }
    },
    async rotate(previousSessionId, record) {
      if (previousSessionId === record.id) {
        await writeRecordAtomically(root, record, makeDirectory)
        return
      }
      await makeDirectory(root, { recursive: true, mode: 0o700 })
      const previousRecordPath = getRecordPath(root, previousSessionId)
      const nextRecordPath = getRecordPath(root, record.id)
      const release = await acquireRecordLocks([previousRecordPath, nextRecordPath], makeDirectory)
      try {
        if (!(await readActiveRecord(previousRecordPath))) {
          await Promise.all([
            rm(previousRecordPath, { force: true }),
            rm(getFlashPath(previousRecordPath), { force: true }),
          ])
          throw new Error(`[@holo-js/session] Session "${previousSessionId}" was not found.`)
        }
        if (await readActiveRecord(nextRecordPath)) {
          throw new Error(`[@holo-js/session] Session "${record.id}" already exists.`)
        }
        const flashEntries = await readFlashEntries(previousRecordPath)
        await writePathAtomically(nextRecordPath, serializeRecord(record))
        if (flashEntries.size > 0) {
          await writePathAtomically(getFlashPath(nextRecordPath), JSON.stringify([...flashEntries]))
        } else {
          await rm(getFlashPath(nextRecordPath), { force: true })
        }
        await Promise.all([
          rm(previousRecordPath, { force: true }),
          rm(getFlashPath(previousRecordPath), { force: true }),
        ])
      } finally {
        await release()
      }
    },
    async flash(sessionId, key, value) {
      await makeDirectory(root, { recursive: true, mode: 0o700 })
      const recordPath = getRecordPath(root, sessionId)
      const release = await acquireRecordLock(recordPath, makeDirectory)
      try {
        if (!(await readActiveRecord(recordPath))) {
          await Promise.all([rm(recordPath, { force: true }), rm(getFlashPath(recordPath), { force: true })])
          throw new Error(`[@holo-js/session] Session "${sessionId}" was not found.`)
        }
        const entries = await readFlashEntries(recordPath)
        entries.set(key, value)
        await writePathAtomically(getFlashPath(recordPath), JSON.stringify([...entries]))
      } finally {
        await release()
      }
    },
    async setDataIfAbsent(sessionId, key, value) {
      await makeDirectory(root, { recursive: true, mode: 0o700 })
      const recordPath = getRecordPath(root, sessionId)
      const release = await acquireRecordLock(recordPath, makeDirectory)
      try {
        const record = await readActiveRecord(recordPath)
        if (!record) {
          await Promise.all([rm(recordPath, { force: true }), rm(getFlashPath(recordPath), { force: true })])
          return { found: false }
        }
        const existing = record.data[key]
        if (Object.hasOwn(record.data, key) && (key !== '_token' || (typeof existing === 'string' && existing))) {
          return { found: true, value: existing }
        }
        await writePathAtomically(recordPath, serializeRecord({ ...record, data: { ...record.data, [key]: value } }))
        return { found: true, value }
      } finally {
        await release()
      }
    },
    sweepExpired,
    async take(sessionId, key) {
      await makeDirectory(root, { recursive: true, mode: 0o700 })
      const recordPath = getRecordPath(root, sessionId)
      const release = await acquireRecordLock(recordPath, makeDirectory)
      try {
        if (!(await readActiveRecord(recordPath))) {
          await Promise.all([rm(recordPath, { force: true }), rm(getFlashPath(recordPath), { force: true })])
          return { found: false }
        }
        const entries = await readFlashEntries(recordPath)
        if (!entries.has(key)) return { found: false }
        const value = entries.get(key)
        entries.delete(key)
        if (entries.size === 0) {
          await rm(getFlashPath(recordPath), { force: true })
        } else {
          await writePathAtomically(getFlashPath(recordPath), JSON.stringify([...entries]))
        }
        return { found: true, value }
      } finally {
        await release()
      }
    },
  }
}

export function createFileSessionStore(root: string): SessionStore {
  return createFileSessionStoreWithMakeDirectory(root, defaultMkdir)
}

export const fileSessionDriverInternals = {
  acquireRecordLock,
  deserializeRecord,
  deserializeFlashEntries,
  getFlashPath,
  getRecordPath,
  serializeRecord,
  createStore: createFileSessionStoreWithMakeDirectory,
}
