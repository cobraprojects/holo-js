import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { reportError } from '@holo-js/kernel/error-reporting'
import type { SecurityRateLimitHitResult, SecurityRateLimitStore } from '../contracts'

type StoredFileRateLimitBucket = {
  namespace?: string
  namespaceHash?: string
  keyHash: string
  prefixHashes: string[]
  attempts: number
  expiresAt: string
}

type FileRateLimitBucket = {
  namespaceHash: string
  keyHash: string
  prefixHashes: readonly string[]
  attempts: number
  expiresAt: Date
}

type FileBucketLock = {
  readonly ownerId: string
  readonly path: string
}

export interface FileRateLimitStoreOptions {
  readonly now?: () => Date
  readonly lockRetryDelayMs?: number
  readonly lockTimeoutMs?: number
}

type FileRateLimitSweepStats = {
  inFlight: boolean
  runsStarted: number
  peakHeldNames: number
  maxEntriesPerRun: number
}

type FileRateLimitKeyHashes = {
  readonly namespaceHash: string
  readonly prefixHashes: readonly string[]
}

const LOCK_OWNER_FILE = 'owner'
const BUCKETS_DIRECTORY = 'buckets'
const PRUNE_INTERVAL_MS = 60_000
const sweepStats = new WeakMap<SecurityRateLimitStore, FileRateLimitSweepStats>()
const SWEEP_BATCH_SIZE = 1_000

function createBucketHash(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

function hashBucketKey(key: string, keyHash: string): FileRateLimitKeyHashes {
  const hash = createHash('sha256')
  const prefixHashes: string[] = []
  let namespaceHash: string | undefined
  let prefixLength = 0

  for (const character of key) {
    hash.update(character)
    prefixLength += character.length
    const prefixHash = prefixLength === key.length ? keyHash : hash.copy().digest('hex')
    prefixHashes.push(prefixHash)

    if (namespaceHash === undefined && character === '|') {
      namespaceHash = prefixHash
    }
  }

  return Object.freeze({
    namespaceHash: namespaceHash ?? keyHash,
    prefixHashes: Object.freeze(prefixHashes),
  })
}

function getBucketPathForKeyHash(root: string, keyHash: string): string {
  return join(root, BUCKETS_DIRECTORY, keyHash.slice(0, 2), keyHash.slice(2, 4), `${keyHash}.json`)
}

function getBucketPath(root: string, key: string): string {
  return getBucketPathForKeyHash(root, createBucketHash(key))
}

function serializeBucket(bucket: FileRateLimitBucket): string {
  return JSON.stringify({
    namespaceHash: bucket.namespaceHash,
    keyHash: bucket.keyHash,
    prefixHashes: [...bucket.prefixHashes],
    attempts: bucket.attempts,
    expiresAt: bucket.expiresAt.toISOString(),
  } satisfies StoredFileRateLimitBucket)
}

function deserializeBucket(raw: string): FileRateLimitBucket {
  const parsed = JSON.parse(raw) as Partial<StoredFileRateLimitBucket>
  const namespaceHash = typeof parsed.namespaceHash === 'string' && parsed.namespaceHash.length > 0
    ? parsed.namespaceHash
    : typeof parsed.namespace === 'string' && parsed.namespace.length > 0
      ? createBucketHash(parsed.namespace)
      : undefined
  const keyHash = typeof parsed.keyHash === 'string' && parsed.keyHash.length > 0
    ? parsed.keyHash
    : undefined
  const prefixHashes = Array.isArray(parsed.prefixHashes) && parsed.prefixHashes.every(
    value => typeof value === 'string' && value.length > 0,
  )
    ? parsed.prefixHashes
    : undefined
  const { attempts, expiresAt: expiresAtValue } = parsed

  if (typeof namespaceHash !== 'string' || namespaceHash.length === 0) {
    throw new TypeError('[@holo-js/security] File rate-limit buckets must contain a non-empty string namespace hash.')
  }

  if (typeof keyHash !== 'string' || keyHash.length === 0) {
    throw new TypeError('[@holo-js/security] File rate-limit buckets must contain a non-empty string key hash.')
  }

  if (!Array.isArray(prefixHashes) || prefixHashes.length === 0) {
    throw new TypeError('[@holo-js/security] File rate-limit buckets must contain non-empty prefix hashes.')
  }

  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError('[@holo-js/security] File rate-limit buckets must contain an integer attempts count greater than 0.')
  }
  const normalizedAttempts = attempts

  if (typeof expiresAtValue !== 'string') {
    throw new TypeError('[@holo-js/security] File rate-limit buckets must contain an ISO expiry timestamp.')
  }

  const expiresAt = new Date(expiresAtValue)
  if (Number.isNaN(expiresAt.getTime())) {
    throw new TypeError('[@holo-js/security] File rate-limit buckets must contain a valid expiry timestamp.')
  }

  return Object.freeze({
    namespaceHash,
    keyHash,
    prefixHashes: Object.freeze([...prefixHashes]),
    attempts: normalizedAttempts,
    expiresAt,
  })
}

async function readBucket(path: string): Promise<FileRateLimitBucket | null> {
  const raw = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return undefined
    }

    throw error
  })

  return raw ? deserializeBucket(raw) : null
}

function isExpired(bucket: FileRateLimitBucket, now: Date): boolean {
  return bucket.expiresAt.getTime() <= now.getTime()
}

async function writeBucket(path: string, bucket: FileRateLimitBucket): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`

  await writeFile(tempPath, serializeBucket(bucket), 'utf8')
  await rename(tempPath, path)
}

async function deleteBucket(path: string): Promise<void> {
  await rm(path, { force: true })
}

function getBucketLockPath(path: string): string {
  return `${path}.lock`
}

function getBucketLockCleanupPath(lockPath: string): string {
  return `${lockPath}.cleanup`
}

function getBucketLockOwnerPath(lockPath: string): string {
  return join(lockPath, LOCK_OWNER_FILE)
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs)
  })
}

function startLockHeartbeat(lockPath: string, timeoutMs: number): ReturnType<typeof setInterval> {
  const heartbeat = setInterval(() => {
    const now = new Date()
    /* v8 ignore next -- defensive handler for lock paths removed between heartbeat ticks. */
    void utimes(lockPath, now, now).catch(() => {})
  }, Math.max(1, Math.floor(timeoutMs / 2)))

  heartbeat.unref?.()
  return heartbeat
}

async function tryCreateBucketLock(lockPath: string): Promise<FileBucketLock> {
  const ownerId = `${process.pid}:${randomUUID()}`
  await mkdir(lockPath)

  try {
    await writeFile(getBucketLockOwnerPath(lockPath), ownerId, 'utf8')
  } catch (error) {
    /* v8 ignore start -- defensive cleanup for a filesystem race after mkdir succeeds. */
    await rm(lockPath, { recursive: true, force: true })
    throw error
    /* v8 ignore stop */
  }

  return { ownerId, path: lockPath }
}

async function removeOwnedBucketLock(lock: FileBucketLock): Promise<void> {
  const ownerId = await readFile(getBucketLockOwnerPath(lock.path), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return undefined
    }

    throw error
  })

  if (ownerId === lock.ownerId) {
    await rm(lock.path, { recursive: true, force: true })
  }
}

async function isBucketLockStale(lockPath: string, timeoutMs: number): Promise<boolean> {
  return await stat(lockPath)
    .then(stats => stats.mtimeMs <= (Date.now() - timeoutMs))
    .catch(() => false)
}

async function reclaimStaleBucketLock(lockPath: string, timeoutMs: number): Promise<boolean> {
  const cleanupPath = getBucketLockCleanupPath(lockPath)
  let cleanupLock: FileBucketLock

  try {
    cleanupLock = await tryCreateBucketLock(cleanupPath)
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException
    if (candidate.code === 'EEXIST') {
      return false
    }

    throw error
  }

  try {
    if (await isBucketLockStale(lockPath, timeoutMs)) {
      await rm(lockPath, { recursive: true, force: true })
      return true
    }

    return false
  } finally {
    await removeOwnedBucketLock(cleanupLock)
  }
}

async function acquireBucketLock(
  lockPath: string,
  options: { readonly retryDelayMs: number, readonly timeoutMs: number },
): Promise<FileBucketLock> {
  const deadline = Date.now() + options.timeoutMs

  while (true) {
    try {
      return await tryCreateBucketLock(lockPath)
    } catch (error) {
      const candidate = error as NodeJS.ErrnoException
      if (candidate.code !== 'EEXIST') {
        throw error
      }

      if (
        await isBucketLockStale(lockPath, options.timeoutMs)
        && await reclaimStaleBucketLock(lockPath, options.timeoutMs)
      ) {
        continue
      }

      if (Date.now() >= deadline) {
        throw new Error(`[@holo-js/security] Timed out waiting for file rate-limit lock "${lockPath}".`)
      }

      await sleep(options.retryDelayMs)
    }
  }
}

async function withBucketLockIfFree<TValue>(
  path: string,
  options: { readonly timeoutMs: number },
  operation: () => Promise<TValue>,
): Promise<TValue | undefined> {
  const lockPath = getBucketLockPath(path)
  await mkdir(dirname(lockPath), { recursive: true })

  let lock: FileBucketLock
  try {
    lock = await tryCreateBucketLock(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }

    if (!await isBucketLockStale(lockPath, options.timeoutMs) || !await reclaimStaleBucketLock(lockPath, options.timeoutMs)) {
      return undefined
    }

    try {
      lock = await tryCreateBucketLock(lockPath)
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === 'EEXIST') {
        return undefined
      }

      throw retryError
    }
  }

  const heartbeat = startLockHeartbeat(lockPath, options.timeoutMs)

  try {
    return await operation()
  } finally {
    clearInterval(heartbeat)
    await removeOwnedBucketLock(lock)
  }
}

async function withBucketLock<TValue>(
  path: string,
  options: { readonly retryDelayMs: number, readonly timeoutMs: number },
  operation: () => Promise<TValue>,
): Promise<TValue> {
  const lockPath = getBucketLockPath(path)
  await mkdir(dirname(lockPath), { recursive: true })

  const acquiredLock = await acquireBucketLock(lockPath, options)

  const heartbeat = startLockHeartbeat(lockPath, options.timeoutMs)

  try {
    return await operation()
  } finally {
    clearInterval(heartbeat)
    await removeOwnedBucketLock(acquiredLock)
  }
}

async function readSortedEntries(
  directory: string,
  keep: (entry: Dirent) => boolean,
  onHeld: (count: number) => void,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return []
    }

    throw error
  })
  const names = entries.filter(keep).map(entry => entry.name).sort()
  onHeld(names.length)
  return names
}

async function* bucketPathsAfter(
  bucketsRoot: string,
  after: string | undefined,
  onHeld: (count: number) => void,
): AsyncGenerator<string> {
  const [afterTop, afterMiddle] = after?.split('/') ?? []
  const isDirectory = (entry: Dirent) => entry.isDirectory()
  const isBucketFile = (entry: Dirent) => entry.isFile() && entry.name.endsWith('.json')

  for (const top of await readSortedEntries(bucketsRoot, isDirectory, onHeld)) {
    if (afterTop !== undefined && top < afterTop) {
      continue
    }

    const topPath = join(bucketsRoot, top)
    for (const middle of await readSortedEntries(topPath, isDirectory, onHeld)) {
      if (afterTop !== undefined && top === afterTop && afterMiddle !== undefined && middle < afterMiddle) {
        continue
      }

      const middlePath = join(topPath, middle)
      for (const name of await readSortedEntries(middlePath, isBucketFile, onHeld)) {
        const relativePath = `${top}/${middle}/${name}`
        if (after !== undefined && relativePath <= after) {
          continue
        }

        yield relativePath
      }
    }
  }
}

async function listBucketPaths(bucketsRoot: string): Promise<string[]> {
  const paths: string[] = []
  for await (const relativePath of bucketPathsAfter(bucketsRoot, undefined, () => undefined)) {
    paths.push(join(bucketsRoot, relativePath))
  }

  return paths
}

function createSnapshot(
  key: string,
  bucket: FileRateLimitBucket,
  maxAttempts: number,
): SecurityRateLimitHitResult['snapshot'] {
  const expiresAt = new Date(bucket.expiresAt.getTime())

  return Object.freeze({
    limiter: '',
    key,
    attempts: bucket.attempts,
    maxAttempts,
    remainingAttempts: Math.max(0, maxAttempts - bucket.attempts),
    expiresAt,
  })
}

export function createFileRateLimitStore(root: string, options: FileRateLimitStoreOptions = {}): SecurityRateLimitStore {
  const resolveNow = options.now ?? (() => new Date())
  const lockRetryDelayMs = options.lockRetryDelayMs ?? 5
  const lockTimeoutMs = options.lockTimeoutMs ?? 2000
  const lockOptions = {
    retryDelayMs: lockRetryDelayMs,
    timeoutMs: lockTimeoutMs,
  }
  const bucketsRoot = join(root, BUCKETS_DIRECTORY)
  const stats: FileRateLimitSweepStats = {
    inFlight: false,
    runsStarted: 0,
    peakHeldNames: 0,
    maxEntriesPerRun: 0,
  }
  const recordHeldNames = (count: number): void => {
    stats.peakHeldNames = Math.max(stats.peakHeldNames, count)
  }
  let cycleActive = false
  let cycleStartedAt: number | undefined
  let cursor: string | undefined
  let inFlight: Promise<void> | undefined
  let closed = false

  const reportSweepError = (error: unknown): void => {
    reportError(error, { capability: 'security', operation: 'rate-limit expired-bucket sweep' })
  }

  const sweepBucket = async (path: string, now: Date): Promise<void> => {
    try {
      const candidate = await readBucket(path)
      if (!candidate || !isExpired(candidate, now)) {
        return
      }

      await withBucketLockIfFree(path, { timeoutMs: lockTimeoutMs }, async () => {
        const bucket = await readBucket(path)
        if (bucket && isExpired(bucket, now)) {
          await deleteBucket(path)
        }
      })
    } catch (error) {
      reportSweepError(error)
    }
  }

  const runSweep = async (now: Date): Promise<void> => {
    let handled = 0
    let finished = false
    const entries = bucketPathsAfter(bucketsRoot, cursor, recordHeldNames)

    try {
      for await (const relativePath of entries) {
        if (closed || handled === SWEEP_BATCH_SIZE) {
          break
        }

        await sweepBucket(join(bucketsRoot, relativePath), now)
        cursor = relativePath
        handled += 1
      }

      finished = closed || handled < SWEEP_BATCH_SIZE
    } catch (error) {
      reportSweepError(error)
      finished = true
    } finally {
      stats.maxEntriesPerRun = Math.max(stats.maxEntriesPerRun, handled)
      if (finished) {
        cycleActive = false
        cursor = undefined
      }
    }
  }

  const startSweepIfDue = (now: Date): void => {
    if (closed || inFlight !== undefined) {
      return
    }

    if (!cycleActive) {
      if (cycleStartedAt !== undefined && now.getTime() - cycleStartedAt < PRUNE_INTERVAL_MS) {
        return
      }

      cycleStartedAt = now.getTime()
      cycleActive = true
      cursor = undefined
    }

    stats.runsStarted += 1
    stats.inFlight = true
    inFlight = runSweep(now).finally(() => {
      inFlight = undefined
      stats.inFlight = false
    })
  }

  const store: SecurityRateLimitStore = {
    async hit(key, hitOptions) {
      const sweepNow = resolveNow()
      const keyHash = createBucketHash(key)
      const path = getBucketPathForKeyHash(root, keyHash)

      startSweepIfDue(sweepNow)

      return await withBucketLock(path, lockOptions, async () => {
        const existing = await readBucket(path)
        const now = resolveNow()

        if (existing && existing.keyHash !== keyHash) {
          throw new Error(`[@holo-js/security] File rate-limit bucket hash collision detected for stored bucket ${existing.keyHash}.`)
        }

        if (existing && isExpired(existing, now)) {
          await deleteBucket(path)
        }

        const bucket = existing && !isExpired(existing, now)
          ? {
              ...existing,
              attempts: existing.attempts + 1,
            }
          : {
              ...hashBucketKey(key, keyHash),
              keyHash,
              attempts: 1,
              expiresAt: new Date(now.getTime() + hitOptions.decaySeconds * 1000),
            }

        await writeBucket(path, bucket)

        return Object.freeze({
          limited: bucket.attempts > hitOptions.maxAttempts,
          snapshot: createSnapshot(key, bucket, hitOptions.maxAttempts),
          retryAfterSeconds: Math.max(0, Math.ceil((bucket.expiresAt.getTime() - now.getTime()) / 1000)),
        })
      })
    },
    async clear(key) {
      const keyHash = createBucketHash(key)
      const path = getBucketPathForKeyHash(root, keyHash)
      return await withBucketLock(path, lockOptions, async () => {
        const existing = await readBucket(path)
        if (!existing || existing.keyHash !== keyHash) {
          return false
        }

        await deleteBucket(path)
        return true
      })
    },
    async clearByPrefix(prefix) {
      let cleared = 0
      const now = resolveNow()
      const prefixHash = createBucketHash(prefix)

      for await (const relativePath of bucketPathsAfter(bucketsRoot, undefined, () => undefined)) {
        const path = join(bucketsRoot, relativePath)
        const removed = await withBucketLock(path, lockOptions, async () => {
          const bucket = await readBucket(path)
          if (!bucket) {
            return false
          }

          if (isExpired(bucket, now)) {
            await deleteBucket(path)
            return false
          }

          if (!bucket.prefixHashes.includes(prefixHash)) {
            return false
          }

          await deleteBucket(path)
          return true
        })

        if (removed) {
          cleared += 1
        }
      }

      return cleared
    },
    async clearAll() {
      let cleared = 0

      for await (const relativePath of bucketPathsAfter(bucketsRoot, undefined, () => undefined)) {
        const path = join(bucketsRoot, relativePath)
        const removed = await withBucketLock(path, lockOptions, async () => {
          const bucket = await readBucket(path)
          if (!bucket) {
            return false
          }

          await deleteBucket(path)
          return true
        })

        if (removed) {
          cleared += 1
        }
      }

      return cleared
    },
    async close() {
      closed = true
      cycleActive = false
      cursor = undefined
      await inFlight
    },
  }

  sweepStats.set(store, stats)
  return store
}

function sweepInFlight(store: SecurityRateLimitStore): boolean {
  return sweepStats.get(store)?.inFlight ?? false
}

function sweepRunsStarted(store: SecurityRateLimitStore): number {
  return sweepStats.get(store)?.runsStarted ?? 0
}

function sweepPeakHeldNames(store: SecurityRateLimitStore): number {
  return sweepStats.get(store)?.peakHeldNames ?? 0
}

function sweepMaxEntriesPerRun(store: SecurityRateLimitStore): number {
  return sweepStats.get(store)?.maxEntriesPerRun ?? 0
}

export const fileRateLimitDriverInternals = {
  createBucketHash,
  sweepInFlight,
  sweepMaxEntriesPerRun,
  sweepPeakHeldNames,
  sweepRunsStarted,
  createSnapshot,
  deleteBucket,
  deserializeBucket,
  getBucketPath,
  isExpired,
  listBucketPaths,
  readBucket,
  serializeBucket,
  sleep,
  getBucketLockPath,
  acquireBucketLock,
  reclaimStaleBucketLock,
  removeOwnedBucketLock,
  withBucketLock,
  writeBucket,
}
