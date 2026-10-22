import { randomUUID } from 'node:crypto'
import { constants as fsConstants, type Dir } from 'node:fs'
import { mkdir as defaultMkdir, lstat, open, opendir, readFile, readdir, rename, rm, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { reportError } from '@holo-js/kernel/error-reporting'
import type { SessionRecord, SessionStore } from '../contracts'

const RECORD_LOCK_STALE_MS = 10_000
const RECORD_LOCK_ACQUIRE_STALL_MS = 5_000
const RECORD_LOCK_ACQUIRE_MAX_MS = 30_000
const SWEEP_ENTRY_LIMIT = 1_000
const RECORD_LOCK_HEARTBEAT_MS = 3_000
const PROCESS_INSTANCE_TOKEN = randomUUID()
const heldRecordLockTokens = new Set<string>()
type MakeDirectory = typeof defaultMkdir

type RecordLockOwner = {
  readonly host: string
  readonly pid: number
  readonly processToken?: string
  readonly released?: boolean
  readonly token: string
}

type RecordLockIdentity = {
  readonly device: number
  readonly inode: number
  readonly modifiedAt: number
  readonly size: number
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

function lockPresentError(lockPath: string): Error {
  return Object.assign(new Error(`[@holo-js/session] File session lock "${lockPath}" is present.`), { code: 'EEXIST' })
}

const BUSY_FILE_ERROR_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const BUSY_FILE_RETRY_MS = 1_000
const RECORD_LOCK_RELEASE_RETRY_MS = 1_000
const pendingRecordLockReleaseRetries = new Set<Promise<void>>()

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
}

function isMissingFileError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

function isBusyFileError(error: unknown): boolean {
  return BUSY_FILE_ERROR_CODES.has(errorCode(error) ?? '')
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
  const released = 'released' in value && value.released === true
  return Object.freeze({
    host: value.host,
    pid: value.pid as number,
    ...(processToken ? { processToken } : {}),
    ...(released ? { released } : {}),
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

async function readRecordLockIdentity(lockPath: string, previous?: RecordLockIdentity): Promise<RecordLockIdentity | undefined> {
  let fileName: string | undefined
  try {
    fileName = (await readdir(lockPath)).find(name => name.startsWith('owner.') && name.endsWith('.json'))
  } catch (error) {
    if (isMissingFileError(error) || isBusyFileError(error)) return undefined
    throw error
  }
  const identityPath = fileName ? join(lockPath, fileName) : lockPath
  const identity = await stat(identityPath).catch(() => undefined)
  if (!identity) return undefined
  let owner: RecordLockOwner | undefined
  if (fileName && previous?.owner && previous.fileName === fileName && previous.device === identity.dev && previous.inode === identity.ino && previous.size === identity.size) {
    owner = previous.owner
  } else if (fileName) {
    try {
      owner = parseRecordLockOwner(JSON.parse(await readFile(identityPath, 'utf8')) as unknown)
      if (owner && recordLockOwnerFileName(owner) !== fileName) owner = undefined
    } catch (error) {
      if (isBusyFileError(error)) return undefined
      if (!(error instanceof SyntaxError) && !isMissingFileError(error)) throw error
    }
  }
  return Object.freeze({ device: identity.dev, inode: identity.ino, modifiedAt: identity.mtimeMs, size: identity.size, ...(owner ? { owner } : {}), ...(fileName ? { fileName } : {}) })
}

function recordLockIdentityMatches(left: RecordLockIdentity, right: RecordLockIdentity | undefined): boolean {
  return right !== undefined
    && left.device === right.device
    && left.inode === right.inode
    && left.fileName === right.fileName
    && left.modifiedAt === right.modifiedAt
    && left.owner?.token === right.owner?.token
}

async function removeRecordLock(lockPath: string, fileName?: string, settleMs = 0): Promise<boolean> {
  const deadline = Date.now() + settleMs
  if (fileName) {
    for (;;) {
      try {
        await unlink(join(lockPath, fileName))
        break
      } catch (error) {
        if (isMissingFileError(error)) break
        if (!isBusyFileError(error)) throw error
        if (Date.now() >= deadline) return false
        await sleep(5)
      }
    }
  }
  for (;;) {
    try {
      await rmdir(lockPath)
      return true
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT') return true
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && !isBusyFileError(error)) throw error
      if (Date.now() >= deadline) return false
      await sleep(5)
    }
  }
}

async function reclaimStaleLock(lockPath: string, expected: RecordLockIdentity): Promise<boolean> {
  if (!recordLockIdentityMatches(expected, await readRecordLockIdentity(lockPath))) return false
  return await removeRecordLock(lockPath, expected.fileName)
}

async function reclaimableRecordLock(lockPath: string, identity: RecordLockIdentity | undefined): Promise<RecordLockIdentity | undefined> {
  if (!identity) return undefined
  if (!identity.fileName) return identity
  const owner = identity.owner
  if (owner?.released) return identity
  if (owner?.host === hostname() && owner.pid === process.pid && owner.processToken === PROCESS_INSTANCE_TOKEN) {
    return heldRecordLockTokens.has(owner.token) ? undefined : identity
  }
  if (owner?.host === hostname() && owner.pid !== process.pid) {
    return processIsRunning(owner.pid) ? undefined : identity
  }
  const leasePath = identity.fileName ? join(lockPath, identity.fileName) : lockPath
  const stale = await stat(leasePath).then(value => value.mtimeMs <= Date.now() - RECORD_LOCK_STALE_MS).catch(() => false)
  return stale ? identity : undefined
}

async function markRecordLockReleased(lockPath: string, owner: RecordLockOwner): Promise<boolean> {
  const leasePath = join(lockPath, recordLockOwnerFileName(owner))
  const contents = `${JSON.stringify({ ...owner, released: true })}\n`
  const deadline = Date.now() + BUSY_FILE_RETRY_MS
  for (;;) {
    try {
      await writeFile(leasePath, contents, { encoding: 'utf8', flag: 'r+' })
      return true
    } catch (error) {
      if (isMissingFileError(error)) return true
      if (!isBusyFileError(error) || Date.now() >= deadline) return false
      await sleep(5)
    }
  }
}

const RECORD_LOCK_TOMBSTONE_SUFFIX = '.released'
const TOMBSTONE_RETRY_FIRST_MS = 50
const TOMBSTONE_RETRY_MAX_MS = 1_000
const TOMBSTONE_RETRY_BUDGET_MS = 5_000
const TOMBSTONE_QUEUE_LIMIT = 256
const pendingTombstoneRemovals: string[] = []
let tombstoneDrain: Promise<void> | undefined

function recordLockTombstonePath(lockPath: string, owner: RecordLockOwner): string {
  return `${lockPath}.${owner.token}${RECORD_LOCK_TOMBSTONE_SUFFIX}`
}

async function removeTombstone(tombstonePath: string): Promise<void> {
  const deadline = Date.now() + TOMBSTONE_RETRY_BUDGET_MS
  let delayMs = TOMBSTONE_RETRY_FIRST_MS
  for (;;) {
    try {
      await unlink(tombstonePath)
      return
    } catch (error) {
      if (isMissingFileError(error)) return
      if (!isBusyFileError(error)) throw error
      if (Date.now() + delayMs > deadline) return
      await delay(delayMs, undefined, { ref: false })
      delayMs = Math.min(delayMs * 2, TOMBSTONE_RETRY_MAX_MS)
    }
  }
}

async function drainTombstoneRemovals(): Promise<void> {
  let tombstonePath = pendingTombstoneRemovals.shift()
  while (tombstonePath !== undefined) {
    await removeTombstone(tombstonePath).catch(error => reportError(error, { capability: 'session', operation: 'file.releaseLock' }))
    tombstonePath = pendingTombstoneRemovals.shift()
  }
  tombstoneDrain = undefined
}

function scheduleTombstoneRemoval(tombstonePath: string): void {
  if (pendingTombstoneRemovals.length >= TOMBSTONE_QUEUE_LIMIT) return
  pendingTombstoneRemovals.push(tombstonePath)
  tombstoneDrain ??= drainTombstoneRemovals()
}

async function removeLeftoverTombstone(tombstonePath: string): Promise<void> {
  try {
    await unlink(tombstonePath)
  } catch (error) {
    if (!isMissingFileError(error) && !isBusyFileError(error)) throw error
  }
}

async function retireRecordLease(lockPath: string, owner: RecordLockOwner): Promise<'retired' | 'absent' | 'busy'> {
  const tombstonePath = recordLockTombstonePath(lockPath, owner)
  try {
    await rename(join(lockPath, recordLockOwnerFileName(owner)), tombstonePath)
  } catch (error) {
    if (isMissingFileError(error)) return 'absent'
    if (isBusyFileError(error)) return 'busy'
    throw error
  }
  scheduleTombstoneRemoval(tombstonePath)
  await removeRecordLock(lockPath)
  return 'retired'
}

async function retryRecordLockRelease(recordPath: string, lockPath: string, owner: RecordLockOwner): Promise<void> {
  if ((await retireRecordLease(lockPath, owner)) !== 'busy') return
  if (await markRecordLockReleased(lockPath, owner)) return
  reportError(
    new Error(`[@holo-js/session] Could not release file session lock for "${recordPath}" on the scheduled retry; other processes can reclaim it only after this process reclaims it or exits.`),
    { capability: 'session', operation: 'file.releaseLock' },
  )
}

function scheduleRecordLockReleaseRetry(recordPath: string, lockPath: string, owner: RecordLockOwner): void {
  const retry: Promise<void> = new Promise<void>(resolve => {
    const timer = setTimeout(() => resolve(retryRecordLockRelease(recordPath, lockPath, owner)), RECORD_LOCK_RELEASE_RETRY_MS)
    timer.unref()
  })
    .catch(error => reportError(error, { capability: 'session', operation: 'file.releaseLock' }))
    .finally(() => { pendingRecordLockReleaseRetries.delete(retry) })
  pendingRecordLockReleaseRetries.add(retry)
}

async function releaseRecordLock(recordPath: string, lockPath: string, owner: RecordLockOwner): Promise<void> {
  try {
    let retirementFailure: { readonly error: unknown } | undefined
    try {
      if ((await retireRecordLease(lockPath, owner)) !== 'busy') return
    } catch (error) {
      retirementFailure = { error }
    }
    const published = await markRecordLockReleased(lockPath, owner)
    if (!published) scheduleRecordLockReleaseRetry(recordPath, lockPath, owner)
    if (retirementFailure) throw retirementFailure.error
    reportError(
      new Error(published
        ? `[@holo-js/session] Could not remove file session lock for "${recordPath}"; the next writer will reclaim it.`
        : `[@holo-js/session] Could not remove file session lock for "${recordPath}" or publish its release; other processes may wait until this process reclaims the lease or exits, and a retry is scheduled.`),
      { capability: 'session', operation: 'file.releaseLock' },
    )
  } finally {
    heldRecordLockTokens.delete(owner.token)
  }
}

function acquireTimeoutError(recordPath: string, cause: unknown): Error {
  return new Error(`[@holo-js/session] Timed out acquiring file session lock for "${recordPath}".`, cause === undefined ? undefined : { cause })
}

async function acquireRecordLock(recordPath: string, makeDirectory: MakeDirectory): Promise<() => Promise<void>> {
  const started = Date.now()
  const release = await acquireRecordLockBefore(recordPath, makeDirectory, {
    deadline: started + RECORD_LOCK_ACQUIRE_STALL_MS,
    hardDeadline: started + RECORD_LOCK_ACQUIRE_MAX_MS,
  })
  if (!release) throw acquireTimeoutError(recordPath, undefined)
  return release
}

async function hasRecordLock(lockPath: string): Promise<boolean> {
  return await lstat(lockPath).then(() => true, () => false)
}

async function acquireRecordLockBefore(
  recordPath: string,
  makeDirectory: MakeDirectory,
  wait: { readonly deadline: number, readonly hardDeadline: number } | undefined,
): Promise<(() => Promise<void>) | undefined> {
  let deadline = wait?.deadline ?? 0
  let observedOwner: string | undefined
  const lockPath = `${recordPath}.lock`
  const owner = Object.freeze({ host: hostname(), pid: process.pid, processToken: PROCESS_INSTANCE_TOKEN, token: randomUUID() })
  const pendingPath = `${lockPath}.${owner.token}.pending`
  const ownerFileName = recordLockOwnerFileName(owner)
  let acquired = false
  heldRecordLockTokens.add(owner.token)
  try {
    await makeDirectory(pendingPath)
    const ownerHandle = await open(join(pendingPath, ownerFileName), 'wx', 0o600)
    try {
      await ownerHandle.writeFile(`${JSON.stringify(owner)}\n`, { encoding: 'utf8' })
      await ownerHandle.sync()
    } finally {
      await ownerHandle.close()
    }
    let uncontendedFailure: unknown
    let observedLease: RecordLockIdentity | undefined
    while (!acquired) {
      if (wait && Date.now() >= Math.min(deadline, wait.hardDeadline)) {
        throw acquireTimeoutError(recordPath, uncontendedFailure)
      }
      try {
        if (await hasRecordLock(lockPath)) throw lockPresentError(lockPath)
        await rename(pendingPath, lockPath)
        acquired = true
      } catch (error) {
        const code = errorCode(error)
        const busy = isBusyFileError(error)
        const lockedByOther = code === 'EEXIST' || code === 'ENOTEMPTY'
        const identity = lockedByOther || busy ? await readRecordLockIdentity(lockPath, observedLease) : undefined
        const contended = lockedByOther || identity !== undefined
        if (!contended && !busy) throw error
        uncontendedFailure = contended ? undefined : error
        if (contended) {
          observedLease = identity
          if (wait && identity?.owner && identity.owner.token !== observedOwner) {
            observedOwner = identity.owner.token
            deadline = Math.min(Date.now() + RECORD_LOCK_ACQUIRE_STALL_MS, wait.hardDeadline)
          }
          const reclaimable = await reclaimableRecordLock(lockPath, identity)
          if (reclaimable && await reclaimStaleLock(lockPath, reclaimable)) continue
        }
        if (wait === undefined) {
          heldRecordLockTokens.delete(owner.token)
          await rm(pendingPath, { recursive: true, force: true })
          return undefined
        }
        await sleep(5)
      }
    }
    const ownerPath = join(lockPath, ownerFileName)
    const heartbeat = setInterval(() => {
      const now = new Date()
      void utimes(ownerPath, now, now).catch(() => undefined)
    }, RECORD_LOCK_HEARTBEAT_MS)
    heartbeat.unref()
    return async () => {
      clearInterval(heartbeat)
      await releaseRecordLock(recordPath, lockPath, owner)
    }
  } catch (error) {
    if (acquired) await releaseRecordLock(recordPath, lockPath, owner)
    else {
      heldRecordLockTokens.delete(owner.token)
      await rm(pendingPath, { recursive: true, force: true })
    }
    throw error
  }
}

async function renameReplacing(source: string, target: string): Promise<void> {
  const deadline = Date.now() + BUSY_FILE_RETRY_MS
  for (;;) {
    try {
      await rename(source, target)
      return
    } catch (error) {
      if (!isBusyFileError(error) || Date.now() >= deadline) throw error
      await sleep(5)
    }
  }
}

async function readFileSettled(path: string): Promise<string> {
  const deadline = Date.now() + BUSY_FILE_RETRY_MS
  for (;;) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if (!isBusyFileError(error) || Date.now() >= deadline) throw error
      await sleep(5)
    }
  }
}

async function writePathAtomically(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 })
    await renameReplacing(temporaryPath, path)
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
    return deserializeFlashEntries(await readFileSettled(getFlashPath(recordPath)))
  } catch (error) {
    if (isMissingFileError(error)) return new Map()
    throw error
  }
}

async function readActiveRecord(recordPath: string): Promise<SessionRecord | null> {
  try {
    const record = deserializeRecord(await readFileSettled(recordPath))
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
        if (!entry.isFile()) continue
        if (entry.name.endsWith(RECORD_LOCK_TOMBSTONE_SUFFIX)) {
          await removeLeftoverTombstone(join(root, entry.name))
          continue
        }
        if (!entry.name.endsWith('.json')) continue
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
        idleTimer = setTimeout(() => {
          void closeDirectory().catch(error => reportError(error, { capability: 'session', operation: 'file.closeDirectory' }))
        }, 60_000)
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
        return deserializeRecord(await readFileSettled(getRecordPath(root, sessionId)))
      } catch (error) {
        if (isMissingFileError(error)) return null
        throw error
      }
    },
    async write(record) {
      await writeRecordAtomically(root, record, makeDirectory)
    },
    async writeIfAbsent(record) {
      await makeDirectory(root, { recursive: true, mode: 0o700 })
      const recordPath = getRecordPath(root, record.id)
      const release = await acquireRecordLock(recordPath, makeDirectory)
      try {
        if (await readActiveRecord(recordPath)) return false
        await writePathAtomically(recordPath, serializeRecord(record))
        await rm(getFlashPath(recordPath), { force: true })
        return true
      } finally {
        await release()
      }
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
  heldRecordLockTokens,
  pendingRecordLockReleaseRetries,
  pendingTombstoneRemovals,
  tombstoneQueueLimit: TOMBSTONE_QUEUE_LIMIT,
  acquireRecordLock,
  deserializeRecord,
  deserializeFlashEntries,
  getFlashPath,
  getRecordPath,
  serializeRecord,
  createStore: createFileSessionStoreWithMakeDirectory,
}
