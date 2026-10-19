# Using the Cache

This page covers every method on the cache: reading, writing, computing on a miss, counters, and picking a store.

```ts [server/lib/reports.ts]
import cache from '@holo-js/cache'

await cache.put('reports.daily', { total: 42 }, 300)

const report = await cache.get('reports.daily')
```

## Expiration (TTL)

Methods that write with an expiry take a `ttl` argument. It can be:

- a whole number of seconds greater than `0`, such as `300`
- a `Date` for an exact expiry time

```ts
await cache.put('banner.text', 'Summer sale', 600)
await cache.put('banner.text', 'Summer sale', new Date('2026-12-31T23:59:59Z'))
```

Passing `0`, a negative number, or a fraction throws a `CacheInvalidTtlError`. To store a value with no expiry, use `forever()` or `rememberForever()`.

## Read values

`get()` returns the stored value, or `null` when the key is missing or expired:

```ts
const report = await cache.get('reports.daily')
```

Pass a fallback to use instead of `null`. It can be a value or a function. The fallback is **not** stored.

```ts
const report = await cache.get('reports.daily', { total: 0 })
const weekly = await cache.get('reports.weekly', () => buildEmptyReport())
```

Check whether a key exists without reading it:

```ts
if (await cache.has('reports.daily')) {
  // ...
}

if (await cache.missing('reports.daily')) {
  // ...
}
```

## Write values

`put()` stores a value and overwrites anything already there:

```ts
await cache.put('users.online', 128, 60)
```

`add()` stores a value only if the key doesn't exist yet. It returns `true` when it wrote and `false` when the key was already set:

```ts
const firstVisit = await cache.add(`welcome-shown:${userId}`, true, 86400)
```

`forever()` stores a value with no expiry. It stays until you remove it:

```ts
await cache.forever('app.locales', ['en', 'ar'])
```

## Compute on a miss

`remember()` returns the cached value if there is one. Otherwise it runs your callback, stores the result for `ttl`, and returns it:

```ts
import cache from '@holo-js/cache'
import { DB } from '@holo-js/db'

const stats = await cache.remember('dashboard.stats', 300, async () => ({
  users: await DB.table('users').count(),
  posts: await DB.table('posts').count(),
}))
```

`rememberForever()` does the same with no expiry:

```ts
const countries = await cache.rememberForever('countries', () => fetchCountryList())
```

The return type comes from your callback, so `stats` above is `{ users: number; posts: number }`.

## Serve stale data while refreshing

`flexible()` lets you keep serving an old value while a fresh one is computed in the background. Pass two windows in seconds: how long the value is fresh, and how long it may be served stale.

```ts
const feed = await cache.flexible('feed.home', [60, 300], () => buildHomeFeed())
```

With `[60, 300]`:

- **0–60 seconds:** the cached value is returned.
- **60–300 seconds:** the cached value is returned right away, and one caller refreshes it in the background.
- **After 300 seconds, or no value yet:** the caller waits while the value is computed.

Holo uses a [lock](/cache/locks) so only one process recomputes the value at a time. You can also write the windows as an object:

```ts
await cache.flexible('feed.home', { fresh: 60, stale: 300 }, buildHomeFeed)
```

`flexible()` is a good fit for slow, read-heavy pages where a few minutes of stale data is fine.

## Remove values

`forget()` removes one key and returns `true` if it existed:

```ts
await cache.forget('dashboard.stats')
```

`flush()` removes every entry in the store:

```ts
await cache.flush()
```


## Counters

`increment()` and `decrement()` change a number in place and return the new value. The amount defaults to `1`.

```ts
await cache.increment('posts.views')
await cache.increment('posts.views', 10)
await cache.decrement('stock.reserved', 2)
```

A missing key starts at `0`. If the key holds something that isn't a number, Holo throws a `CacheInvalidNumericMutationError`.

To give a counter an expiry, create it with `add()` first. Incrementing keeps the existing expiry:

```ts
await cache.add(`logins:${userId}`, 0, 3600)
const attempts = await cache.increment(`logins:${userId}`)
```

## Use a specific store

Calls go to the `default` store from `config/cache.ts`. Use `driver()` with a store name to target another one. The returned object has all the same methods:

```ts
await cache.driver('redis').put('sessions.active', 42, 60)
await cache.driver('memory').remember('geo.lookup', 30, lookupGeo)
```

The name is the key under `drivers` in your config, not the driver type.

## Typed keys

A plain string key has no type link between calls. A `put()` in one file doesn't tell a `get()` in another file what shape to expect:

```ts
await cache.put('dashboard.stats', { users: 10, posts: 42 }, 300)

const stats = await cache.get('dashboard.stats')
// stats is unknown
```

When you share a key across files, define it once with `defineCacheKey()`:

```ts [server/cache-keys.ts]
import { defineCacheKey } from '@holo-js/cache'

export const dashboardStats = defineCacheKey<{
  users: number
  posts: number
}>('dashboard.stats')
```

Every method accepts the typed key in place of a string, and reads return the right type:

```ts
import cache from '@holo-js/cache'
import { dashboardStats } from '../cache-keys'

await cache.put(dashboardStats, { users: 10, posts: 42 }, 300)

const stats = await cache.get(dashboardStats)
// stats is { users: number; posts: number } | null
```

## What you can store

Values are stored as JSON. You can cache:

- strings, finite numbers, booleans, and `null`
- arrays and plain objects made of those values
- `Date` objects, which come back as `Date` instances

Class instances, `Map`, `Set`, functions, `undefined` properties, `NaN`, and `Infinity` throw a `CacheSerializationError`. Convert model instances to plain objects (for example with `toJSON()`) before caching them, or use [query caching](/cache/query-caching).

::: tip
Objects and arrays you read from the cache are frozen. Copy them before changing them: `const draft = { ...cachedPost }`.
:::

## Available methods

Everything the cache exposes to app code, grouped by task. Each item links to its own entry below.

**Read**

- [`get()`](#get)
- [`has()`](#has)
- [`missing()`](#missing)

**Write**

- [`put()`](#put)
- [`add()`](#add)
- [`forever()`](#forever)

**Compute on a miss**

- [`remember()`](#remember)
- [`rememberForever()`](#rememberforever)
- [`flexible()`](#flexible)

**Remove**

- [`forget()`](#forget)
- [`flush()`](#flush)

**Counters**

- [`increment()`](#increment)
- [`decrement()`](#decrement)

**Stores and locks**

- [`driver()`](#driver)
- [`lock()`](#lock)
- [`defineCacheConfig()`](#definecacheconfig)

**Typed keys and utilities**

<div class="method-list">

- [`defineCacheKey()`](#definecachekey)
- [`isCacheKey()`](#iscachekey)
- [`resolveCacheKey()`](#resolvecachekey)
- [`normalizeCacheTtl()`](#normalizecachettl)
- [`serializeCacheValue()`](#serializecachevalue)
- [`deserializeCacheValue()`](#deserializecachevalue)

</div>

**Query caching**

- [`.cache()` on a query](#query-cache)

**Errors**

- [`CacheError`](#cacheerror) and the error classes listed under [Errors](#errors)

## Methods

### `get(key, fallback?)` {#get}

Returns the stored value, or `null` when the key is missing or expired. With a `fallback`, returns that instead: a value, or a function that returns one. The fallback is not stored.

```ts
const report = await cache.get('reports.daily', { total: 0 })
const weekly = await cache.get('reports.weekly', () => buildEmptyReport())
```

### `has(key)` {#has}

Returns `true` if the key exists. It doesn't read the value.

```ts
if (await cache.has('reports.daily')) {
  // ...
}
```

### `missing(key)` {#missing}

The opposite of `has()`. Returns `true` if the key doesn't exist.

### `put(key, value, ttl)` {#put}

Stores a value with an expiry, overwriting anything already there. `ttl` is a number of seconds or a `Date`. Resolves to `true` when the value is stored.

```ts
await cache.put('users.online', 128, 60)
```

### `add(key, value, ttl)` {#add}

Stores a value only if the key is missing. Returns `true` when it wrote, and `false` when the key already held a value.

```ts
const firstVisit = await cache.add(`welcome-shown:${userId}`, true, 86400)
```

### `forever(key, value)` {#forever}

Stores a value with no expiry. It stays until you [`forget()`](#forget) it or the store is flushed.

```ts
await cache.forever('app.locales', ['en', 'ar'])
```

### `remember(key, ttl, callback)` {#remember}

Returns the cached value if there is one. Otherwise it runs `callback`, stores the result for `ttl`, and returns it. The return type comes from the callback.

```ts
import cache from '@holo-js/cache'
import { DB } from '@holo-js/db'

const stats = await cache.remember('dashboard.stats', 300, async () => ({
  users: await DB.table('users').count(),
  posts: await DB.table('posts').count(),
}))
```

`stats` is `{ users: number; posts: number }`.

### `rememberForever(key, callback)` {#rememberforever}

The same as [`remember()`](#remember), with no expiry.

```ts
const countries = await cache.rememberForever('countries', () => fetchCountryList())
```

### `flexible(key, [fresh, stale], callback)` {#flexible}

Serves a stale value while a fresh one is computed. Pass two windows in seconds: how long the value is fresh, and how long it may be served stale.

```ts
const feed = await cache.flexible('feed.home', [60, 300], () => buildHomeFeed())
```

With `[60, 300]`:

- **0–60 seconds:** the cached value is returned.
- **60–300 seconds:** the cached value is returned right away, and one caller refreshes it in the background.
- **After 300 seconds, or no value yet:** the caller waits while the value is computed.

Holo uses a [lock](/cache/locks) so only one process recomputes the value at a time. You can also write the windows as an object, `{ fresh: 60, stale: 300 }`. `flexible()` suits slow, read-heavy pages where a few minutes of stale data is fine.

### `forget(key)` {#forget}

Removes one key. Returns `true` if it existed.

```ts
await cache.forget('dashboard.stats')
```

### `flush()` {#flush}

Removes every entry in the store. It resolves to nothing.

```ts
await cache.flush()
```

::: warning
`flush()` clears the whole store, not just your keys. Redis deletes its whole database, `database` empties its cache table, and `file` empties its folder. Give each app its own store, Redis database, or tables. See [Cache drivers](/cache/drivers#key-prefixes).
:::

### `increment(key, amount?)` {#increment}

Adds `amount` to a number and returns the new value. The amount defaults to `1`. A missing key starts at `0`. If the key holds something that isn't a number, it throws a [`CacheInvalidNumericMutationError`](#cacheinvalidnumericmutationerror).

```ts
await cache.increment('posts.views')
await cache.increment('posts.views', 10)
```

To give a counter an expiry, create it with `add()` first. Incrementing keeps the existing expiry:

```ts
await cache.add(`logins:${userId}`, 0, 3600)
const attempts = await cache.increment(`logins:${userId}`)
```

### `decrement(key, amount?)` {#decrement}

Subtracts `amount` from a number and returns the new value. It's `increment()` with a negative amount, and it has the same missing-key and error behavior.

```ts
await cache.decrement('stock.reserved', 2)
```

### `driver(name)` {#driver}

Returns the same methods for a named store from `config/cache.ts`. Calls without `driver()` use the `default` store. The name is the key under `drivers` in your config, not the driver type.

```ts
await cache.driver('redis').put('sessions.active', 42, 60)
await cache.driver('memory').remember('geo.lookup', 30, lookupGeo)
```

### `lock(name, seconds)` {#lock}

Creates a lock that only one caller can hold at a time. It doesn't acquire the lock by itself. See [Locks](/cache/locks).

```ts
const ran = await cache.lock('reports:daily', 30).get(() => rebuildDailyReport())
```

### `defineCacheConfig(config)` {#definecacheconfig}

Config helper for `config/cache.ts`. Use it as the file's default export. It returns the config typed and frozen. The stores and their options are in [Cache drivers](/cache/drivers).

```ts [config/cache.ts]
import { defineCacheConfig } from '@holo-js/cache'

export default defineCacheConfig({
  default: 'memory',
  drivers: {
    memory: { driver: 'memory' },
  },
})
```

## Utilities

These help you share typed keys, check TTLs, or work with raw cache payloads. Most apps need only `defineCacheKey()`.

### `defineCacheKey(key)` {#definecachekey}

Creates a typed key. The type parameter is the value's type, and every method accepts the key in place of a string. See [Typed keys](#typed-keys).

```ts [server/cache-keys.ts]
import { defineCacheKey } from '@holo-js/cache'

export const dashboardStats = defineCacheKey<{ users: number, posts: number }>('dashboard.stats')
```

It trims the key and throws a [`CacheConfigError`](#cacheconfigerror) if the key is empty.

### `isCacheKey(value)` {#iscachekey}

Returns `true` if `value` is a key made by `defineCacheKey()`. Use it to tell typed keys from strings.

### `resolveCacheKey(key)` {#resolvecachekey}

Returns the key as a trimmed string. It accepts a string or a typed key, and throws a [`CacheConfigError`](#cacheconfigerror) if the result is empty.

### `normalizeCacheTtl(ttl, options?)` {#normalizecachettl}

Turns a TTL into `{ seconds, expiresAt, isExpired }`. `expiresAt` is a timestamp in milliseconds. Pass `options.now` (a `number` or `Date`) to measure from a time other than now. An invalid TTL throws a [`CacheInvalidTtlError`](#cacheinvalidttlerror).

```ts
import { normalizeCacheTtl } from '@holo-js/cache'

const { seconds } = normalizeCacheTtl(300)
```

### `serializeCacheValue(value)` {#serializecachevalue}

Returns the JSON string the cache stores for a value. It applies the rules in [What you can store](#what-you-can-store), and throws a [`CacheSerializationError`](#cacheserializationerror) for values that can't be stored.

### `deserializeCacheValue(payload)` {#deserializecachevalue}

Reads a JSON string made by `serializeCacheValue()` back into a value, including `Date`s. It throws a [`CacheSerializationError`](#cacheserializationerror) if the string isn't valid.

### `.cache()` on a query {#query-cache}

Not a cache method, but the query builder's way to cache results. See [Query caching](/cache/query-caching).

## Errors

All cache errors extend `CacheError` and have a `code` property. Import them from `@holo-js/cache`, and check them with `instanceof`.

### `CacheError` {#cacheerror}

The base class. Catch it to handle any cache error. Each subclass below has its own `code`.

### `CacheConfigError` {#cacheconfigerror}

Thrown when a key is empty or the cache config is invalid.

### `CacheInvalidTtlError` {#cacheinvalidttlerror}

Thrown when a TTL is invalid: `0`, a negative number, a fraction, or an invalid `Date`. It's also thrown for invalid `flexible()` windows and invalid lock times.

### `CacheSerializationError` {#cacheserializationerror}

Thrown when a value can't be stored as JSON, or a stored entry is corrupt.

### `CacheInvalidNumericMutationError` {#cacheinvalidnumericmutationerror}

Thrown by `increment()` or `decrement()` when the key holds a value that isn't a number.

### `CacheLockAcquisitionError` {#cachelockacquisitionerror}

Thrown by `increment()` or `decrement()` on the `file` store when the store's short internal lock can't be acquired. The lock isn't the one from `cache.lock()`, so your own lock calls never throw this.

### `CacheDriverResolutionError` {#cachedriverresolutionerror}

Thrown when the store name isn't configured, the driver type isn't supported, or the Redis or database connection for the store is missing.

### `CacheOptionalPackageError` {#cacheoptionalpackageerror}

Thrown when a store needs a package that isn't installed, such as the one for the Redis or database store.

### `CacheRuntimeNotConfiguredError` {#cacheruntimenotconfigurederror}

Thrown when the cache is used before the app boots, for example in a standalone script.

## Next steps

- [Locks](/cache/locks)
- [Query caching](/cache/query-caching)
- [Cache drivers](/cache/drivers)
