import { randomUUID } from 'node:crypto'
import { mkdir as defaultMkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { SessionRecord, SessionStore } from '../contracts'

const RECORD_LOCK_STALE_MS = 10_000
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

async function readRecordLockOwner(lockPath: string): Promise<RecordLockOwner | undefined> {
  try {
    return parseRecordLockOwner(JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')) as unknown)
  } catch (error) {
    if (error instanceof SyntaxError || isMissingFileError(error)) return undefined
    throw error
  }
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
  const owner = await readRecordLockOwner(lockPath)
  const identityPath = owner ? join(lockPath, 'owner.json') : lockPath
  const identity = await stat(identityPath).catch(() => undefined)
  if (!identity) return undefined
  return Object.freeze({
    device: identity.dev,
    inode: identity.ino,
    modifiedAt: identity.mtimeMs,
    ...(owner ? { owner } : {}),
  })
}

function recordLockIdentityMatches(left: RecordLockIdentity, right: RecordLockIdentity | undefined): boolean {
  return right !== undefined
    && left.device === right.device
    && left.inode === right.inode
    && left.modifiedAt === right.modifiedAt
    && left.owner?.token === right.owner?.token
}

async function restoreReplacedLock(lockPath: string, stalePath: string): Promise<void> {
  const existing = await stat(lockPath).catch(() => undefined)
  if (existing) {
    throw new Error(`[@holo-js/session] File session lock changed during stale recovery for "${lockPath}".`)
  }
  await rename(stalePath, lockPath)
}

async function reclaimStaleLock(lockPath: string, expected: RecordLockIdentity): Promise<boolean> {
  const stalePath = `${lockPath}.${process.pid}.${randomUUID()}.stale`
  try {
    await rename(lockPath, stalePath)
  } catch (error) {
    if (isMissingFileError(error)) return false
    throw error
  }
  const moved = await readRecordLockIdentity(stalePath)
  if (!recordLockIdentityMatches(expected, moved)) {
    await restoreReplacedLock(lockPath, stalePath)
    return false
  }
  await rm(stalePath, { recursive: true, force: true })
  return true
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
  const leasePath = owner ? join(lockPath, 'owner.json') : lockPath
  const stale = await stat(leasePath).then(value => value.mtimeMs <= Date.now() - RECORD_LOCK_STALE_MS).catch(() => false)
  return stale ? identity : undefined
}

async function acquireRecordLock(recordPath: string, makeDirectory: MakeDirectory): Promise<() => Promise<void>> {
  const lockPath = `${recordPath}.lock`
  const deadline = Date.now() + 5_000
  const owner = Object.freeze({
    host: hostname(),
    pid: process.pid,
    processToken: PROCESS_INSTANCE_TOKEN,
    token: randomUUID(),
  })
  while (true) {
    try {
      await makeDirectory(lockPath)
      let ownerHandle
      try {
        ownerHandle = await open(join(lockPath, 'owner.json'), 'wx', 0o600)
        await ownerHandle.writeFile(`${JSON.stringify(owner)}\n`, { encoding: 'utf8' })
        await ownerHandle.sync()
      } catch (error) {
        await ownerHandle?.close()
        await rm(lockPath, { recursive: true, force: true })
        throw error
      }
      const heartbeat = setInterval(() => {
        const now = new Date()
        void ownerHandle.utimes(now, now).catch(() => undefined)
      }, RECORD_LOCK_HEARTBEAT_MS)
      heartbeat.unref()
      return async () => {
        clearInterval(heartbeat)
        await ownerHandle.close()
        const currentOwner = await readRecordLockOwner(lockPath)
        if (currentOwner?.token === owner.token) await rm(lockPath, { recursive: true, force: true })
      }
    } catch (error) {
      const candidate = error as NodeJS.ErrnoException
      if (candidate.code !== 'EEXIST') {
        throw error
      }
      const reclaimable = await reclaimableRecordLock(lockPath)
      if (reclaimable && await reclaimStaleLock(lockPath, reclaimable)) {
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(`[@holo-js/session] Timed out acquiring file session lock for "${recordPath}".`)
      }
      await sleep(5)
    }
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

function createFileSessionStoreWithMakeDirectory(root: string, makeDirectory: MakeDirectory): SessionStore {
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
  deserializeRecord,
  deserializeFlashEntries,
  getFlashPath,
  getRecordPath,
  serializeRecord,
  createStore: createFileSessionStoreWithMakeDirectory,
}
