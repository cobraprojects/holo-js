import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
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

const LOCK_OWNER_FILE = 'owner'

function createBucketHash(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

function createBucketNamespace(key: string): string {
  const separatorIndex = key.indexOf('|')
  return separatorIndex >= 0 ? key.slice(0, separatorIndex + 1) : key
}

function createBucketNamespaceHash(key: string): string {
  return createBucketHash(createBucketNamespace(key))
}

function createBucketPrefixHashes(key: string): string[] {
  const prefixHashes: string[] = []

  for (let index = 1; index <= key.length; index += 1) {
    prefixHashes.push(createBucketHash(key.slice(0, index)))
  }

  return prefixHashes
}

function getBucketPath(root: string, key: string): string {
  const hash = createBucketHash(key)
  return join(root, hash.slice(0, 2), hash.slice(2, 4), `${hash}.json`)
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

async function listBucketPaths(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return []
    }

    throw error
  })

  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = join(root, entry.name)
    if (entry.isDirectory()) {
      return await listBucketPaths(entryPath)
    }

    return entry.name.endsWith('.json') ? [entryPath] : []
  }))

  return nested.flat()
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

  return {
    async hit(key, hitOptions) {
      const now = resolveNow()
      const path = getBucketPath(root, key)
      return await withBucketLock(path, {
        retryDelayMs: lockRetryDelayMs,
        timeoutMs: lockTimeoutMs,
      }, async () => {
        const existing = await readBucket(path)

        if (existing && existing.keyHash !== createBucketHash(key)) {
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
              namespaceHash: createBucketNamespaceHash(key),
              keyHash: createBucketHash(key),
              prefixHashes: Object.freeze(createBucketPrefixHashes(key)),
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
      const path = getBucketPath(root, key)
      return await withBucketLock(path, {
        retryDelayMs: lockRetryDelayMs,
        timeoutMs: lockTimeoutMs,
      }, async () => {
        const existing = await readBucket(path)
        if (!existing || existing.keyHash !== createBucketHash(key)) {
          return false
        }

        await deleteBucket(path)
        return true
      })
    },
    async clearByPrefix(prefix) {
      let cleared = 0
      const now = resolveNow()
      const paths = await listBucketPaths(root)

      for (const path of paths) {
        const removed = await withBucketLock(path, {
          retryDelayMs: lockRetryDelayMs,
          timeoutMs: lockTimeoutMs,
        }, async () => {
          const bucket = await readBucket(path)
          if (!bucket) {
            return false
          }

          if (isExpired(bucket, now)) {
            await deleteBucket(path)
            return false
          }

          if (!bucket.prefixHashes.includes(createBucketHash(prefix))) {
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
      const paths = await listBucketPaths(root)
      let cleared = 0

      for (const path of paths) {
        const removed = await withBucketLock(path, {
          retryDelayMs: lockRetryDelayMs,
          timeoutMs: lockTimeoutMs,
        }, async () => {
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
  }
}

export const fileRateLimitDriverInternals = {
  createBucketHash,
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
