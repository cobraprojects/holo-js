import {
  CacheInvalidNumericMutationError,
  deserializeCacheValue,
  serializeCacheValue,
  type CacheDriverContract,
  type CacheDriverGetResult,
  type CacheLockContract,
  type CacheDriverPutInput,
} from './contracts'

type MemoryCacheEntry = {
  payload: string
  expiresAt?: number
}

type MemoryCacheLockEntry = {
  owner: symbol
  expiresAt: number
}

type MemoryCacheDriverState = {
  readonly entries: Map<string, MemoryCacheEntry>
  readonly locks: Map<string, MemoryCacheLockEntry>
}

type CreateMemoryCacheDriverOptions = {
  readonly name: string
  readonly maxEntries?: number
  readonly now?: () => number
  readonly sleep?: (milliseconds: number) => Promise<void>
}

function createMemoryCacheDriverState(): MemoryCacheDriverState {
  return {
    entries: new Map<string, MemoryCacheEntry>(),
    locks: new Map<string, MemoryCacheLockEntry>(),
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function createMemoryLock(
  state: MemoryCacheDriverState,
  name: string,
  seconds: number,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
): CacheLockContract {
  const owner = Symbol(name)

  function clearExpiredLock(): void {
    const current = state.locks.get(name)
    if (current && current.expiresAt <= now()) {
      state.locks.delete(name)
    }
  }

  function tryAcquire(): boolean {
    clearExpiredLock()
    const current = state.locks.get(name)
    if (current) {
      return false
    }

    state.locks.set(name, {
      owner,
      expiresAt: now() + (seconds * 1000),
    })
    return true
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
      if (!tryAcquire()) {
        return false
      }

      return withCallback(callback)
    },
    async release(): Promise<boolean> {
      clearExpiredLock()
      const current = state.locks.get(name)
      if (!current || current.owner !== owner) {
        return false
      }

      state.locks.delete(name)
      return true
    },
    async block<TValue>(
      waitSeconds: number,
      callback?: () => TValue | Promise<TValue>,
    ): Promise<boolean | TValue> {
      const deadline = now() + (waitSeconds * 1000)
      while (true) {
        if (tryAcquire()) {
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

function isExpired(entry: MemoryCacheEntry, timestamp: number): boolean {
  return typeof entry.expiresAt === 'number' && entry.expiresAt <= timestamp
}

function pruneExpiredEntry(state: MemoryCacheDriverState, key: string, timestamp: number): MemoryCacheEntry | undefined {
  const entry = state.entries.get(key)
  if (!entry) {
    return undefined
  }

  if (isExpired(entry, timestamp)) {
    state.entries.delete(key)
    return undefined
  }

  return entry
}

function pruneExpiredEntries(state: MemoryCacheDriverState, timestamp: number): void {
  for (const [key, entry] of state.entries.entries()) {
    if (isExpired(entry, timestamp)) {
      state.entries.delete(key)
    }
  }
}

function setEntry(
  state: MemoryCacheDriverState,
  input: CacheDriverPutInput,
): void {
  state.entries.set(input.key, {
    payload: input.payload,
    expiresAt: input.expiresAt,
  })
}

function enforceMaxEntries(
  state: MemoryCacheDriverState,
  maxEntries: number | undefined,
  timestamp: number,
): void {
  if (typeof maxEntries === 'undefined') {
    return
  }

  pruneExpiredEntries(state, timestamp)
  while (state.entries.size > maxEntries) {
    const oldestKey = state.entries.keys().next().value
    /* v8 ignore next 3 -- Map iteration only returns undefined here if the map changes unexpectedly between size and iteration checks. */
    if (typeof oldestKey === 'undefined') {
      break
    }

    state.entries.delete(oldestKey)
  }
}

export function createMemoryCacheDriver(
  options: CreateMemoryCacheDriverOptions,
): CacheDriverContract {
  const state = createMemoryCacheDriverState()
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep

  return {
    name: options.name,
    driver: 'memory',
    async get(key: string): Promise<CacheDriverGetResult> {
      const entry = pruneExpiredEntry(state, key, now())
      if (!entry) return Object.freeze({ hit: false })

      return Object.freeze({
        hit: true,
        payload: entry.payload,
        expiresAt: entry.expiresAt,
      })
    },
    async put(input: CacheDriverPutInput): Promise<boolean> {
      setEntry(state, input)
      enforceMaxEntries(state, options.maxEntries, now())
      return true
    },
    async add(input: CacheDriverPutInput): Promise<boolean> {
      const timestamp = now()
      if (pruneExpiredEntry(state, input.key, timestamp)) return false

      setEntry(state, input)
      enforceMaxEntries(state, options.maxEntries, timestamp)
      return true
    },
    async forget(key: string): Promise<boolean> {
      const existed = typeof pruneExpiredEntry(state, key, now()) !== 'undefined'
      state.entries.delete(key)
      return existed
    },
    async flush(): Promise<void> {
      state.entries.clear()
      state.locks.clear()
    },
    async increment(key: string, amount: number): Promise<number> {
      const entry = pruneExpiredEntry(state, key, now())
      const currentValue = entry
        ? deserializeCacheValue<unknown>(entry.payload)
        : 0

      if (typeof currentValue !== 'number' || !Number.isFinite(currentValue)) {
        throw new CacheInvalidNumericMutationError(`[@holo-js/cache] Cache key "${key}" does not contain a numeric value.`)
      }

      const nextValue = currentValue + amount
      setEntry(state, {
        key,
        payload: serializeCacheValue(nextValue),
        expiresAt: entry?.expiresAt,
      })
      enforceMaxEntries(state, options.maxEntries, now())
      return nextValue
    },
    async decrement(key: string, amount: number): Promise<number> {
      return this.increment(key, -amount)
    },
    lock(name: string, seconds: number): CacheLockContract {
      return createMemoryLock(state, name, seconds, now, sleep)
    },
  }
}
