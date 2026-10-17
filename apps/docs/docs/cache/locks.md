# Locks

A cache lock makes sure only one caller runs a piece of work at a time, even across processes and servers. Use it for rebuilding a report, running an import, or refreshing data from a third-party API.

```ts [server/jobs/rebuild-report.ts]
import cache from '@holo-js/cache'

const ran = await cache.lock('reports:daily', 30).get(async () => {
  await rebuildDailyReport()
  return true
})

if (ran === false) {
  // Another process is already rebuilding the report.
}
```

## Create a lock

```ts
const lock = cache.lock(name, seconds)
```

- `name`: callers that use the same name compete for the same lock.
- `seconds`: how long the lock lives. If your process crashes before releasing it, the lock frees itself after this time.

`cache.lock()` doesn't acquire anything yet. It returns a lock with three methods: `get()`, `block()`, and `release()`.

## Try once with `get()`

`get()` makes one attempt. If someone else holds the lock, it returns `false` right away.

When you pass a callback, Holo runs it while holding the lock, releases the lock afterwards (even if the callback throws), and returns the callback's result:

```ts
const result = await cache.lock('dashboard:refresh', 20).get(async () => {
  await refreshDashboardCache()
  return 'refreshed'
})
// 'refreshed', or false if the lock was taken
```

Use `get()` for background work where skipping a duplicate run is fine.

## Wait with `block()`

`block(waitSeconds, callback)` keeps retrying until it gets the lock or `waitSeconds` runs out. It returns the callback's result, or `false` if it gave up.

```ts
const imported = await cache.lock('imports:users', 60).block(5, async () => {
  await runUserImport()
  return true
})
```

Here the lock lives for up to 60 seconds, and this caller waits up to 5 seconds to get it.

Use `block()` in user-facing flows where it's worth waiting briefly for another request to finish.

## Acquire and release by hand

Without a callback, `get()` and `block()` return `true` when they acquire the lock. You're then responsible for calling `release()`:

```ts
import cache from '@holo-js/cache'

const lock = cache.lock('exports:nightly', 120)

if (await lock.get()) {
  try {
    await runNightlyExport()
  } finally {
    await lock.release()
  }
}
```

`release()` only frees a lock that this lock object acquired. It returns `false` if the lock has already expired or belongs to someone else.

## Example: prevent double purchases

A lock reduces concurrent work, but your database should still enforce the rule. Combine both:

```ts [server/lib/purchase.ts]
import cache from '@holo-js/cache'
import { DB } from '@holo-js/db'

export async function purchase(productId: number, userId: number, quantity: number) {
  const result = await cache.lock(`purchase:product:${productId}`, 10).block(3, async () => {
    return DB.transaction(async (tx) => {
      const updated = await tx.table('products')
        .where('id', productId)
        .where('stock', '>=', quantity)
        .decrement('stock', quantity)

      if ((updated.affectedRows ?? 0) === 0) {
        throw new Error('Out of stock')
      }

      await tx.table('orders').insert({
        product_id: productId,
        user_id: userId,
        quantity,
      })

      return true
    })
  })

  if (result === false) {
    throw new Error('Another purchase is in progress. Try again.')
  }
}
```

The conditional `where('stock', '>=', quantity)` prevents overselling even if the lock expires early.

::: warning
Pick a lock time longer than the work takes. If the lock expires while your callback is still running, a second caller can get in.
:::

## Which processes a lock covers

A lock only coordinates callers that share the same store:

| Store | Coordinates |
| --- | --- |
| `memory` | Callers in the same process only. |
| `file` | Processes that share the same cache folder. |
| `redis` | Every server connected to the same Redis. |
| `database` | Every server connected to the same cache tables. |

Use `redis` or `database` when you run more than one server. Pick the store with `cache.driver('redis').lock(...)`.

## Available methods

Everything a lock exposes, grouped by task. Each item links to its own entry below.

**Create**

- [`cache.lock()`](#cache-lock-name-seconds)
- [`lock.name`](#lock-name)

**Acquire**

- [`lock.get()`](#get)
- [`lock.block()`](#block)

**Release**

- [`lock.release()`](#release)

### `cache.lock(name, seconds)` {#cache-lock-name-seconds}

Creates a lock object for `name`. It doesn't acquire anything. `seconds` is how long the lock lives, and it must be a finite number greater than `0`. Otherwise it throws a [`CacheInvalidTtlError`](/cache/usage#cacheinvalidttlerror). To use another store, call it on [`cache.driver()`](/cache/usage#driver).

### `lock.name` {#lock-name}

The lock's full name, including the store's prefix. Read-only.

### `lock.get(callback?)` {#get}

Makes one attempt to take the lock. Resolves to:

- the callback's result, if you pass a callback. Holo releases the lock afterwards, even if the callback throws.
- `true`, if you don't pass a callback. You then need to call `release()`.
- `false`, if someone else holds the lock.

```ts
const result = await cache.lock('dashboard:refresh', 20).get(async () => {
  await refreshDashboardCache()
  return 'refreshed'
})
```

### `lock.block(waitSeconds, callback?)` {#block}

Retries until it takes the lock or `waitSeconds` runs out. `waitSeconds` must be a finite number of zero or more. It resolves to the same values as [`get()`](#get), and `false` when it gives up. With `0`, it makes one attempt, like `get()`.

```ts
const imported = await cache.lock('imports:users', 60).block(5, async () => {
  await runUserImport()
  return true
})
```

### `lock.release()` {#release}

Frees a lock that this lock object holds. Resolves to `true` if it released the lock. It resolves to `false` if the lock already expired or belongs to someone else.

## Next steps

- [Using the cache](/cache/usage)
- [Cache drivers](/cache/drivers)
- [Database transactions](/database/transactions)
