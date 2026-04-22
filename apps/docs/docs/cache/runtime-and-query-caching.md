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

All first-party drivers expose the same lock API:

```ts
const lock = cache.lock('reports:daily', 30)

const acquired = await lock.get(async () => {
  await rebuildDailyReport()
  return true
})
```

Wait for a lock instead of failing immediately:

```ts
await cache.lock('imports:users', 60).block(5, async () => {
  await runUserImport()
  return true
})
```

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

## Query invalidation

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
