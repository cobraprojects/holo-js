import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  CacheInvalidNumericMutationError,
  CacheInvalidTtlError,
  CacheLockAcquisitionError,
  deserializeCacheValue,
  serializeCacheValue,
  type CacheDriverContract,
  type CacheDriverGetResult,
  type CacheDriverPutInput,
  type CacheLockContract,
} from './contracts'

type FileCacheEntryEnvelope = {
  key: string
  payload: string
  expiresAt?: number
}

type FileCacheLockEnvelope = {
  name: string
  owner: string
  expiresAt: number
}

type CreateFileCacheDriverOptions = {
  readonly name: string
  readonly path: string
  readonly prefix?: string
  readonly now?: () => number
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly ownerFactory?: () => string
  readonly numericMutationLockSeconds?: number
  readonly numericMutationWaitSeconds?: number
}

type FileReadResult<TValue> =
  | {
      state: 'missing'
      filePath: string
    }
  | {
      state: 'hit'
      filePath: string
      value: TValue
    }

type FileLockReadResult =
  | {
      state: 'missing'
      filePath: string
    }
  | {
      state: 'hit'
      filePath: string
      markerFilePath: string
      value: FileCacheLockEnvelope
    }

const MALFORMED_FILE = Symbol('MALFORMED_FILE')

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds)
  })
}

function validateLockSeconds(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CacheInvalidTtlError('[@holo-js/cache] Cache lock seconds must be a finite number greater than 0.')
  }
}

function validateLockWaitSeconds(waitSeconds: number): void {
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
    throw new CacheInvalidTtlError('[@holo-js/cache] Cache lock wait seconds must be a finite number greater than or equal to 0.')
  }
}

function hashCacheKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

function resolveDriverRoot(path: string): string {
  return resolve(path)
}

function resolveEntryFilePath(rootPath: string, key: string): string {
  const hash = hashCacheKey(key)
  return join(rootPath, 'entries', hash.slice(0, 2), `${hash}.json`)
}

function resolveLockFilePath(rootPath: string, name: string): string {
  const hash = hashCacheKey(name)
  return join(rootPath, 'locks', hash.slice(0, 2), `${hash}.lock`)
}

function resolveLockMarkerFilePath(lockPath: string, owner: string): string {
  return join(lockPath, `${hashCacheKey(owner)}.json`)
}

function isPositiveTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isFileCacheEntryEnvelope(value: unknown): value is FileCacheEntryEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const entry = value as Partial<FileCacheEntryEnvelope>
  return typeof entry.key === 'string'
    && typeof entry.payload === 'string'
    && (typeof entry.expiresAt === 'undefined' || isPositiveTimestamp(entry.expiresAt))
}

function isFileCacheLockEnvelope(value: unknown): value is FileCacheLockEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const lock = value as Partial<FileCacheLockEnvelope>
  return typeof lock.name === 'string'
    && typeof lock.owner === 'string'
    && isPositiveTimestamp(lock.expiresAt)
}

async function ensureParentDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
}

async function removeFileIfPresent(filePath: string): Promise<void> {
  await rm(filePath, { force: true })
}

async function removeEmptyDirectoryIfPresent(path: string): Promise<void> {
  try {
    await rmdir(path)
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && (error.code === 'ENOENT' || error.code === 'ENOTEMPTY' || error.code === 'ENOTDIR')
    ) {
      return
    }

    throw error
  }
}

async function readFileIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (
      error instanceof Error
      && 'code' in error
      && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return undefined
    }

    throw error
  }
}

async function writeFileAtomically(filePath: string, contents: string): Promise<void> {
  await ensureParentDirectory(filePath)
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`

  await writeFile(temporaryPath, contents, 'utf8')

  /* v8 ignore start -- This catch requires an OS-level rename failure after a successful temp write in the same directory. */
  try {
    await rename(temporaryPath, filePath)
  } catch (error) {
    await removeFileIfPresent(temporaryPath)
    throw error
  }
  /* v8 ignore stop */
}

async function writeFileExclusively(filePath: string, contents: string): Promise<boolean> {
  await ensureParentDirectory(filePath)

  /* v8 ignore start -- Unexpected open/write failures are delegated to the underlying filesystem error. */
  try {
    const handle = await open(filePath, 'wx')
    try {
      await handle.writeFile(contents, 'utf8')
    } finally {
      await handle.close()
    }

    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      return false
    }

    throw error
  }
  /* v8 ignore stop */
}

async function readJsonFile(filePath: string): Promise<unknown | typeof MALFORMED_FILE | undefined> {
  const contents = await readFileIfPresent(filePath)
  if (typeof contents === 'undefined') return undefined

  try {
    return JSON.parse(contents) as unknown
  } catch {
    return MALFORMED_FILE
  }
}

async function listFiles(rootPath: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(rootPath, { withFileTypes: true })
    const nested = await Promise.all(entries.map(async (entry) => {
      const entryPath = join(rootPath, entry.name)
      if (entry.isDirectory()) return listFiles(entryPath)

      return [entryPath]
    }))

    return nested.flat()
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

async function removeInvalidFileAndReadMissing<TValue>(
  filePath: string,
  decoded: unknown | typeof MALFORMED_FILE | undefined,
): Promise<FileReadResult<TValue>> {
  if (typeof decoded !== 'undefined') {
    await removeFileIfPresent(filePath)
  }

  return {
    state: 'missing',
    filePath,
  }
}

async function removeScopedCacheFiles<TValue extends FileCacheEntryEnvelope | FileCacheLockEnvelope>(
  rootPath: string,
  prefix: string,
  isEnvelope: (value: unknown) => value is TValue,
  resolveName: (value: TValue) => string,
): Promise<void> {
  async function removeScopedFile(filePath: string): Promise<void> {
    await removeFileIfPresent(filePath)
    await removeEmptyDirectoryIfPresent(dirname(filePath))
  }

  if (!prefix) {
    await rm(rootPath, { recursive: true, force: true })
    await mkdir(rootPath, { recursive: true })
    return
  }

  for (const filePath of await listFiles(rootPath)) {
    const decoded = await readJsonFile(filePath)
    if (!decoded || decoded === MALFORMED_FILE || !isEnvelope(decoded)) {
      await removeScopedFile(filePath)
      continue
    }

    if (resolveName(decoded).startsWith(prefix)) {
      await removeScopedFile(filePath)
    }
  }
}

async function readEntry(
  rootPath: string,
  key: string,
  now: number,
): Promise<FileReadResult<FileCacheEntryEnvelope>> {
  const filePath = resolveEntryFilePath(rootPath, key)
  const decoded = await readJsonFile(filePath)
  if (decoded === MALFORMED_FILE || !isFileCacheEntryEnvelope(decoded) || decoded.key !== key) {
    return removeInvalidFileAndReadMissing(filePath, decoded)
  }

  if (typeof decoded.expiresAt === 'number' && decoded.expiresAt <= now) {
    return removeInvalidFileAndReadMissing(filePath, decoded)
  }

  return {
    state: 'hit',
    filePath,
    value: decoded,
  }
}

async function readLock(
  rootPath: string,
  name: string,
  now: number,
): Promise<FileLockReadResult> {
  const filePath = resolveLockFilePath(rootPath, name)
  let markerFilePaths: readonly string[]

  try {
    const entries = await readdir(filePath, { withFileTypes: true })
    markerFilePaths = entries
      .filter(entry => entry.isFile())
      .map(entry => join(filePath, entry.name))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {
        state: 'missing',
        filePath,
      }
    }

    if (!(error instanceof Error && 'code' in error && error.code === 'ENOTDIR')) {
      throw error
    }

    const decoded = await readJsonFile(filePath)
    if (decoded === MALFORMED_FILE || !isFileCacheLockEnvelope(decoded) || decoded.name !== name) {
      if (typeof decoded !== 'undefined') {
        await removeFileIfPresent(filePath)
      }

      return {
        state: 'missing',
        filePath,
      }
    }

    if (decoded.expiresAt <= now) {
      await removeFileIfPresent(filePath)
      return {
        state: 'missing',
        filePath,
      }
    }

    return {
      state: 'hit',
      filePath,
      markerFilePath: filePath,
      value: decoded,
    }
  }

  if (markerFilePaths.length === 0) {
    return {
      state: 'hit',
      filePath,
      markerFilePath: resolveLockMarkerFilePath(filePath, ''),
      value: {
        name,
        owner: '',
        expiresAt: now + 1,
      },
    }
  }

  for (const markerFilePath of markerFilePaths) {
    const decoded = await readJsonFile(markerFilePath)
    if (decoded === MALFORMED_FILE || !isFileCacheLockEnvelope(decoded) || decoded.name !== name) {
      await removeFileIfPresent(markerFilePath)
      continue
    }

    if (decoded.expiresAt <= now) {
      await removeFileIfPresent(markerFilePath)
      continue
    }

    return {
      state: 'hit',
      filePath,
      markerFilePath,
      value: decoded,
    }
  }

  await removeEmptyDirectoryIfPresent(filePath)

  return {
    state: 'missing',
    filePath,
  }
}

function createEntryEnvelope(input: CacheDriverPutInput): FileCacheEntryEnvelope {
  return {
    key: input.key,
    payload: input.payload,
    expiresAt: input.expiresAt,
  }
}

function createFileLock(
  rootPath: string,
  name: string,
  seconds: number,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
  ownerFactory: () => string,
): CacheLockContract {
  validateLockSeconds(seconds)

  const owner = ownerFactory()

  async function writeLockDirectory(filePath: string, envelope: string): Promise<boolean> {
    await ensureParentDirectory(filePath)

    try {
      await mkdir(filePath)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        return false
      }

      throw error
    }

    try {
      await writeFile(resolveLockMarkerFilePath(filePath, owner), envelope, 'utf8')
    } catch (error) {
      await removeFileIfPresent(resolveLockMarkerFilePath(filePath, owner))
      await removeEmptyDirectoryIfPresent(filePath)
      throw error
    }

    return true
  }

  async function tryAcquire(): Promise<boolean> {
    const filePath = resolveLockFilePath(rootPath, name)
    const envelope = JSON.stringify({
      name,
      owner,
      expiresAt: now() + (seconds * 1000),
    } satisfies FileCacheLockEnvelope)

    if (await writeLockDirectory(filePath, envelope)) {
      return true
    }

    const currentLock = await readLock(rootPath, name, now())
    if (currentLock.state === 'missing') {
      return writeLockDirectory(filePath, envelope)
    }

    return false
  }

  async function withCallback<TValue>(
    callback: (() => TValue | Promise<TValue>) | undefined,
  ): Promise<boolean | TValue> {
    if (!callback) {
      return true
    }

    try {
      return await callback()
    } finally {
      await lock.release()
    }
  }

  const lock: CacheLockContract = {
    name,
    async get<TValue>(callback?: () => TValue | Promise<TValue>): Promise<boolean | TValue> {
      if (!(await tryAcquire())) {
        return false
      }

      return withCallback(callback)
    },
    async release(): Promise<boolean> {
      const currentLock = await readLock(rootPath, name, now())
      if (currentLock.state === 'missing' || currentLock.value.owner !== owner) {
        return false
      }

      await removeFileIfPresent(currentLock.markerFilePath)
      await removeEmptyDirectoryIfPresent(currentLock.filePath)
      return true
    },
    async block<TValue>(waitSeconds: number, callback?: () => TValue | Promise<TValue>): Promise<boolean | TValue> {
      validateLockWaitSeconds(waitSeconds)

      const deadline = now() + (waitSeconds * 1000)
      while (true) {
        if (await tryAcquire()) {
          return withCallback(callback)
        }

        if (now() >= deadline) {
          return false
        }

        await sleep(10)
      }
    },
  }

  return lock
}

export function createFileCacheDriver(options: CreateFileCacheDriverOptions): CacheDriverContract {
  const rootPath = resolveDriverRoot(options.path)
  const prefix = options.prefix ?? ''
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const ownerFactory = options.ownerFactory ?? randomUUID
  const numericMutationLockSeconds = options.numericMutationLockSeconds ?? 5
  const numericMutationWaitSeconds = options.numericMutationWaitSeconds ?? 2

  async function writeEntry(input: CacheDriverPutInput): Promise<boolean> {
    const filePath = resolveEntryFilePath(rootPath, input.key)
    await writeFileAtomically(filePath, JSON.stringify(createEntryEnvelope(input)))
    return true
  }

  async function mutateNumericValue(key: string, amount: number): Promise<number> {
    const result = await createFileLock(
      rootPath,
      `__numeric__:${key}`,
      numericMutationLockSeconds,
      now,
      sleep,
      ownerFactory,
    ).block(numericMutationWaitSeconds, async () => {
      const entry = await readEntry(rootPath, key, now())
      const currentValue = entry.state === 'hit'
        ? deserializeCacheValue<unknown>(entry.value.payload)
        : 0

      if (typeof currentValue !== 'number' || !Number.isFinite(currentValue)) {
        throw new CacheInvalidNumericMutationError(`[@holo-js/cache] Cache key "${key}" does not contain a numeric value.`)
      }

      const nextValue = currentValue + amount
      await writeEntry({
        key,
        payload: serializeCacheValue(nextValue),
        expiresAt: entry.state === 'hit' ? entry.value.expiresAt : undefined,
      })
      return nextValue
    })

    if (result === false) {
      throw new CacheLockAcquisitionError(`[@holo-js/cache] Could not acquire file cache mutation lock for "${key}".`)
    }

    /* v8 ignore next 3 -- block() is only invoked with a callback here, so a bare boolean true is not a reachable runtime result. */
    if (result === true) {
      throw new CacheLockAcquisitionError(`[@holo-js/cache] File cache mutation lock for "${key}" returned no numeric result.`)
    }

    return result
  }

  return {
    name: options.name,
    driver: 'file',
    async get(key: string): Promise<CacheDriverGetResult> {
      const entry = await readEntry(rootPath, key, now())
      if (entry.state === 'missing') {
        return Object.freeze({ hit: false })
      }

      return Object.freeze({
        hit: true,
        payload: entry.value.payload,
        expiresAt: entry.value.expiresAt,
      })
    },
    async put(input: CacheDriverPutInput): Promise<boolean> {
      return writeEntry(input)
    },
    async add(input: CacheDriverPutInput): Promise<boolean> {
      const nowValue = now()
      const filePath = resolveEntryFilePath(rootPath, input.key)
      const existing = await readEntry(rootPath, input.key, nowValue)
      if (existing.state === 'hit') {
        return false
      }

      /* v8 ignore start -- Hitting this retry path deterministically requires a narrow filesystem race between existence checks and exclusive file creation. */
      if (await writeFileExclusively(filePath, JSON.stringify(createEntryEnvelope(input)))) {
        return true
      }

      const afterCollision = await readEntry(rootPath, input.key, nowValue)
      if (afterCollision.state === 'hit') {
        return false
      }

      return writeFileExclusively(filePath, JSON.stringify(createEntryEnvelope(input)))
      /* v8 ignore stop */
    },
    async forget(key: string): Promise<boolean> {
      const filePath = resolveEntryFilePath(rootPath, key)
      const contents = await readFileIfPresent(filePath)
      if (typeof contents === 'undefined') {
        return false
      }

      await removeFileIfPresent(filePath)
      return true
    },
    async flush(): Promise<void> {
      await removeScopedCacheFiles(
        join(rootPath, 'entries'),
        prefix,
        isFileCacheEntryEnvelope,
        entry => entry.key,
      )
      await removeScopedCacheFiles(
        join(rootPath, 'locks'),
        prefix,
        isFileCacheLockEnvelope,
        lock => lock.name,
      )
    },
    async increment(key: string, amount: number): Promise<number> {
      return mutateNumericValue(key, amount)
    },
    async decrement(key: string, amount: number): Promise<number> {
      return mutateNumericValue(key, -amount)
    },
    lock(name: string, seconds: number): CacheLockContract {
      return createFileLock(rootPath, name, seconds, now, sleep, ownerFactory)
    },
  }
}

export const fileDriverInternals = {
  hashCacheKey,
  isFileCacheEntryEnvelope,
  isFileCacheLockEnvelope,
  resolveDriverRoot,
  resolveEntryFilePath,
  resolveLockFilePath,
}
