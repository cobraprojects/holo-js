# Runtime API, Locks, and Query Caching

## Basic runtime API

```ts
import cache, { defineCacheKey } from '@holo-js/cache'

const reportKey = defineCacheKey<{ total: number }>('reports.daily')

await cache.put(reportKey, { total: 42 }, 300)

const report = await cache.get(reportKey)
const fallbackReport = await cache.get('reports.weekly', () => ({ total: 0 }))

await cache.forever('flags:beta', true)
await cache.add('counters:pageviews', 1, 60)
await cache.increment('counters:pageviews')
await cache.decrement('counters:pageviews')
await cache.forget('flags:beta')
```

Raw string keys work, but `defineCacheKey(...)` preserves value inference across `get`, `put`, `remember`, and
`flexible`.

`cache.add(key, value, ttl)` only writes when the key does not already exist, so it does not overwrite existing
values. `cache.put(key, value, ttl)` always writes and overwrites the key. Use `cache.add` for idempotent first-write
scenarios, and use `cache.put` when you need to update or refresh a cached value.

Returned cache payloads are immutable snapshots. Arrays and plain objects from `get(...)`, `remember(...)`,
`rememberForever(...)`, and `flexible(...)` are recursively frozen so callers cannot mutate shared cached state after
deserialization.

## Read-through caching

Use `remember(...)` when you want to compute once and cache the result:

```ts
const stats = await cache.remember('dashboard.stats', 300, async () => {
  return {
    users: await DB.table('users').count(),
    posts: await DB.table('posts').count(),
  }
})
```

Use `rememberForever(...)` for values that only change when you invalidate them manually:

```ts
const supportedLocales = await cache.rememberForever('app.locales', async () => {
  return ['en', 'ar']
})
```

## Stale-while-revalidate

Use `flexible(...)` for fresh/stale windows:

```ts
const feed = await cache.flexible('feed.home', [60, 300], async () => {
  return await buildHomeFeed()
})
```

`[60, 300]` means:

- the value is fresh for 60 seconds
- the stale value may still be served up to 300 seconds
- one caller refreshes in the background while other callers keep using the stale value

You can also use the object form:

```ts
await cache.flexible('feed.home', {
  fresh: 60,
  stale: 300,
}, buildHomeFeed)
```

## Locks

Use cache locks when one caller should perform a piece of work at a time: rebuilding a report, importing a file,
refreshing a third-party API snapshot, or serializing a purchase flow before the database write.

Create a lock with:

```ts
const lock = cache.lock(name, seconds)
```

Arguments:

- `name`: the lock key. Callers that use the same name compete for the same lock.
- `seconds`: the lock TTL. If the process crashes or never releases the lock, it expires after this many seconds.

`cache.lock(...)` does not acquire anything by itself. It returns a lock handle with three methods:

- `get(callback?)`: try once right now. Returns `false` immediately if another caller already holds the lock.
- `block(waitSeconds, callback?)`: keep retrying until the lock is acquired or the wait timeout expires.
- `release()`: release a lock you already acquired.

Use `get(...)` when you want "run only if nobody else is doing this already":

```ts
const lock = cache.lock('reports:daily', 30)

const acquired = await lock.get(async () => {
  await rebuildDailyReport()
  return true
})
```

Here `30` is the lock TTL in seconds. If another worker already holds `reports:daily`, `acquired` is `false`
immediately.

Use `block(...)` when you want "wait a little before giving up":

```ts
const imported = await cache.lock('imports:users', 60).block(5, async () => {
  await runUserImport()
  return true
})
```

Here:

- `'imports:users'` is the shared lock name
- `60` means the lock itself lives for up to 60 seconds
- `5` means this caller will wait for up to 5 seconds trying to acquire it

If the lock becomes free within those 5 seconds, the callback runs and its return value is returned. If not,
`block(...)` returns `false`.

### `get(...)` vs `block(...)`

- `get(...)`: one immediate attempt, no waiting
- `block(...)`: retry for up to `waitSeconds`

Use `get(...)` for background refresh work where duplicate work is harmless to skip. Use `block(...)` for user-facing
flows where it is worth waiting briefly for the first operation to finish.

### Example: skip duplicate refresh work

```ts
const refreshed = await cache.lock('dashboard:refresh', 20).get(async () => {
  await refreshDashboardCache()
  return true
})

if (refreshed === false) {
  // Another worker is already doing the refresh.
}
```

### Example: wait for a purchase lock

```ts
const result = await cache.lock(`purchase:product:${productId}`, 10).block(3, async () => {
  return DB.transaction(async (tx) => {
    const updated = await tx
      .table('products')
      .where('id', productId)
      .where('quantity', '>=', requestedQty)
      .decrement('quantity', requestedQty)

    if ((updated.affectedRows ?? 0) === 0) {
      throw new Error('Out of stock')
    }

    await tx.table('orders').insert({
      product_id: productId,
      user_id: userId,
      quantity: requestedQty,
    })

    return true
  })
})

if (result === false) {
  throw new Error('Purchase is already in progress, try again')
}
```

This pattern matters:

- the cache lock reduces concurrent work across processes or nodes
- the database transaction is still the source of truth
- the conditional decrement prevents overselling even if a lock expires or another worker retries later

### Manual acquire and release

You can acquire first and release later if you do not want the callback form:

```ts
const lock = cache.lock('exports:nightly', 120)

if (await lock.get()) {
  try {
    await runNightlyExport()
  } finally {
    await lock.release()
  }
}
```

Choose a TTL that is longer than the expected critical section. If `seconds` is too short, the lock may expire while
the first operation is still running, allowing another caller to enter.

Driver behavior:

- `memory` locks only coordinate callers in the same process
- `file` locks coordinate callers on the same filesystem
- `redis` locks coordinate across app nodes that share Redis
- `database` locks coordinate across app nodes that share the same cache tables

## Query result caching

`@holo-js/db` query builders support `.cache(...)`:

```ts
const users = await DB.table('users')
  .where('status', 'active')
  .cache(300)
  .get()
```

You can also use the object form:

```ts
const users = await DB.table('users')
  .cache({
    ttl: 300,
    key: 'users.active',
    driver: 'redis',
  })
  .get()
```

Flexible query caching uses the same stale-while-revalidate semantics:

```ts
const users = await DB.table('users')
  .cache({
    flexible: [60, 300],
  })
  .get()
```

Model queries support the same API:

```ts
const users = await User.query().cache(300).get()
```

## Cache invalidation

### Manual invalidation

Use explicit cache keys when you want direct control:

```ts
await cache.forget('users.active')
await cache.driver('redis').forget('users.active')
```

For query caching, you can also attach explicit dependency tags:

```ts
const users = await DB.table('users')
  .cache({
    ttl: 300,
    invalidate: ['users', 'db:main:posts'],
  })
  .get()
```

Plain table names such as `'users'` normalize to `db:<connection>:<table>`.

### Automatic invalidation

When a cached select query stays within the supported query shapes, Holo-JS automatically registers a table
dependency and invalidates that cache entry after writes commit against the same table.

Supported automatic invalidation covers straightforward single-table select queries without:

- joins
- unions
- having clauses
- raw selections
- subquery selections
- raw `orderBy`
- raw predicates
- `exists` predicates
- subquery predicates

### Unsupported automatic invalidation cases

If a query uses one of the unsupported shapes above, automatic invalidation is skipped on purpose. In those
cases, choose one of these patterns:

- provide a stable explicit `key` and manually `cache.forget(...)` it after writes
- provide explicit `invalidate` dependencies
- avoid query caching for that specific query shape

## Practical guidance

- Use `memory` only when per-process isolation is acceptable.
- Use `file` for single-machine persistence without Redis.
- Use `redis` for most shared production caches.
- Use `database` when you want portability and already accept DB-backed coordination.
