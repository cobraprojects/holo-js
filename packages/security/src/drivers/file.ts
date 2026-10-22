import { createHash, randomUUID } from 'node:crypto'
import { mkdir, opendir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import type { Dir, Dirent } from 'node:fs'
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
  openHandles: number
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

type FileRateLimitWalkStep =
  | { readonly kind: 'unit' }
  | { readonly kind: 'bucket', readonly path: string }

type FileRateLimitShardListing = {
  readonly names: readonly string[]
}

const UNIT_STEP: FileRateLimitWalkStep = { kind: 'unit' }

function* chargeUnits(count: number): Generator<FileRateLimitWalkStep> {
  for (let index = 0; index < count; index += 1) {
    yield UNIT_STEP
  }
}

async function readShardEntries(
  directory: string,
  onUnreadable?: (directory: string, error: unknown) => void,
): Promise<Dirent[] | undefined> {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }

    if (!onUnreadable) {
      throw error
    }

    onUnreadable(directory, error)
    return undefined
  }
}

async function* readShardListing(
  directory: string,
  onHeld: (count: number) => void,
  onUnreadable?: (directory: string, error: unknown) => void,
): AsyncGenerator<FileRateLimitWalkStep, FileRateLimitShardListing | undefined> {
  yield UNIT_STEP
  const entries = await readShardEntries(directory, onUnreadable)
  onHeld(entries?.length ?? 0)
  yield* chargeUnits(entries?.length ?? 0)
  yield UNIT_STEP

  if (!entries) {
    return undefined
  }

  return {
    names: entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort(),
  }
}

async function openShard(
  directory: string,
  counter: { openHandles: number },
  onUnreadable?: (directory: string, error: unknown) => void,
): Promise<Dir | undefined> {
  try {
    const handle = await opendir(directory)
    counter.openHandles += 1
    return handle
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }

    if (!onUnreadable) {
      throw error
    }

    onUnreadable(directory, error)
    return undefined
  }
}

async function readShardEntry(
  handle: Dir,
  directory: string,
  onUnreadable?: (directory: string, error: unknown) => void,
): Promise<Dirent | null> {
  try {
    return await handle.read()
  } catch (error) {
    if (!onUnreadable) {
      throw error
    }

    onUnreadable(directory, error)
    return null
  }
}

async function* walkBucketTree(
  bucketsRoot: string,
  counter: { openHandles: number },
  onHeld: (count: number) => void,
  onUnreadable?: (directory: string, error: unknown) => void,
): AsyncGenerator<FileRateLimitWalkStep> {
  const tops = yield* readShardListing(bucketsRoot, onHeld, onUnreadable)

  for (const top of tops?.names ?? []) {
    const topPath = join(bucketsRoot, top)
    const middles = yield* readShardListing(topPath, onHeld, onUnreadable)

    for (const middle of middles?.names ?? []) {
      const leaf = join(topPath, middle)
      yield UNIT_STEP
      const handle = await openShard(leaf, counter, onUnreadable)
      if (!handle) {
        continue
      }

      try {
        for (let entry = await readShardEntry(handle, leaf, onUnreadable); entry !== null; entry = await readShardEntry(handle, leaf, onUnreadable)) {
          yield entry.isFile() && entry.name.endsWith('.json')
            ? { kind: 'bucket', path: join(leaf, entry.name) }
            : UNIT_STEP
        }
      } finally {
        counter.openHandles -= 1
        await handle.close().catch(() => undefined)
      }
      yield UNIT_STEP
    }
  }
}

async function* bucketFilePaths(bucketsRoot: string): AsyncGenerator<string> {
  for await (const step of walkBucketTree(bucketsRoot, { openHandles: 0 }, () => undefined)) {
    if (step.kind === 'bucket') {
      yield step.path
    }
  }
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
    openHandles: 0,
  }
  const recordHeldNames = (count: number): void => {
    stats.peakHeldNames = Math.max(stats.peakHeldNames, count)
  }
  let cycleStartedAt: number | undefined
  let cursor: AsyncGenerator<FileRateLimitWalkStep> | undefined
  let inFlight: Promise<void> | undefined
  let closed = false

  const reportSweepError = (error: unknown): void => {
    reportError(error, { capability: 'security', operation: 'rate-limit expired-bucket sweep' })
  }
  const reportedUnreadable = new Set<string>()
  const reportUnreadable = (directory: string, error: unknown): void => {
    if (reportedUnreadable.has(directory)) {
      return
    }

    reportedUnreadable.add(directory)
    reportSweepError(error)
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

  const closeCursor = async (): Promise<void> => {
    const current = cursor
    cursor = undefined
    await current?.return(undefined)
  }

  const runSweep = async (now: Date): Promise<void> => {
    let units = 0
    let finished = false

    try {
      cursor ??= walkBucketTree(bucketsRoot, stats, recordHeldNames, reportUnreadable)

      while (units < SWEEP_BATCH_SIZE && !closed) {
        const next = await cursor.next()
        if (next.done) {
          finished = true
          break
        }

        units += 1
        if (next.value.kind === 'bucket') {
          await sweepBucket(next.value.path, now)
        }
      }
    } catch (error) {
      reportSweepError(error)
      finished = true
    } finally {
      stats.maxEntriesPerRun = Math.max(stats.maxEntriesPerRun, units)
      if (finished || closed) {
        await closeCursor()
      }
    }
  }

  const startSweepIfDue = (now: Date): void => {
    if (closed || inFlight !== undefined) {
      return
    }

    if (cursor === undefined) {
      if (cycleStartedAt !== undefined && now.getTime() - cycleStartedAt < PRUNE_INTERVAL_MS) {
        return
      }

      cycleStartedAt = now.getTime()
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

      for await (const path of bucketFilePaths(bucketsRoot)) {
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

      for await (const path of bucketFilePaths(bucketsRoot)) {
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
      await inFlight
      await closeCursor()
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

function sweepOpenHandles(store: SecurityRateLimitStore): number {
  return sweepStats.get(store)?.openHandles ?? 0
}

export const fileRateLimitDriverInternals = {
  getBucketLockPath,
  sweepInFlight,
  sweepMaxEntriesPerRun,
  sweepOpenHandles,
  sweepPeakHeldNames,
  sweepRunsStarted,
  withBucketLock,
}
