# Query Caching

Add `.cache()` to a query to store its results. Holo clears the cached results automatically when you write to the same table through Holo, so you rarely have to invalidate anything by hand.

```ts [server/lib/users.ts]
import { DB } from '@holo-js/db'

const activeUsers = await DB.table('users')
  .where('status', 'active')
  .cache(300)
  .get()
```

The first call runs the query and caches the rows for 300 seconds. Later calls with the same query and bindings read from the cache. After an insert, update, or delete on `users`, the next call hits the database again.

Query caching needs `@holo-js/cache`. See [Cache](/cache/) to install it.

## Cache model queries

Models support the same method:

```ts
import User from '../models/User'

const user = await User.where('id', 1).cache(60).first()
const recent = await User.query().orderBy('created_at', 'desc').cache(60).paginate(20)
```

`.cache()` works with the usual ways of reading results, including `get()`, `first()`, `find()`, `value()`, `pluck()`, `count()`, `exists()`, `sum()`, `paginate()`, `simplePaginate()`, and `cursorPaginate()`.

## Options

Pass a number of seconds (or a `Date`) for a simple TTL, or an object for more control:

```ts
const posts = await DB.table('posts')
  .where('published', true)
  .cache({
    ttl: 300,
    key: 'posts.published',
    driver: 'redis',
  })
  .get()
```

You must set either `ttl` or `flexible`. Each option is listed under [Available methods](#available-methods).

## Stale-while-revalidate

`flexible` works like [`cache.flexible()`](/cache/usage#serve-stale-data-while-refreshing). Results are fresh for the first window, then served stale while one caller re-runs the query in the background:

```ts
const leaderboard = await DB.table('scores')
  .orderBy('points', 'desc')
  .limit(10)
  .cache({ flexible: [30, 300] })
  .get()
```

## Custom keys

Set `key` when you want to clear an entry yourself, for example from a webhook:

```ts
import cache from '@holo-js/cache'

await cache.forget('posts.published')
```

Use a different `key` for each distinct query. Two queries with the same key share one cache entry.

## Automatic invalidation

For most queries, Holo records which table a cached result depends on. When you insert, update, upsert, increment, or delete rows in that table through Holo's query builder or models, it clears the matching entries. Inside a [transaction](/database/transactions), it waits until the transaction commits.

Automatic tracking is skipped for queries that use:

- joins or unions
- raw selects, raw `orderBy`, or raw `where` clauses
- subquery selects or subquery `where` clauses
- `whereExists`
- most `having` clauses

For those queries, choose one of these:

- list the tables to watch with `invalidate`
- set a `key` and call `cache.forget()` after writes
- don't cache that query

```ts
const feed = await DB.table('posts')
  .join('users', 'users.id', '=', 'posts.user_id')
  .select('posts.title', 'users.name')
  .cache({ ttl: 300, invalidate: ['posts', 'users'] })
  .get()
```

A plain table name in `invalidate` uses the query's connection. To watch a table on another connection, write `db:<connection>:<table>`, for example `'db:analytics:events'`.

::: warning
Holo only sees writes made through Holo. Changes from raw SQL clients, other apps, or database triggers don't clear the cache.

The list of which entries depend on which tables lives in each server process's memory. If you run several servers or workers against a shared Redis or database cache, a write on one server doesn't clear entries another server cached. Those entries stay until their TTL ends. Keep TTLs short in that setup, or clear keys yourself.
:::

Remote writes reach only [Broadcast workers](/broadcasting/production#run-several-workers). With Broadcast Redis scaling on, a write in another process clears the cached results for the tables it changed inside each worker, and refreshes the Realtime queries that read those tables. Your web app and queue processes don't receive these invalidations, so their memory cache entries for another process's writes live until their TTL ends. For cross-process consistency, use a shared cache store, Redis or database. A cache store that supplies its own dependency index must implement `listDependencies()` for worker invalidation to work. Without it, the worker logs one warning and keeps the entries until their TTL ends.

## When results are not cached

- Queries with `lockForUpdate()` or `sharedLock()` always hit the database.
- A `Date` TTL that is already in the past skips the cache.

Many identical requests that arrive while the cache is empty share one database query instead of each running their own.

## Available methods

Everything you can call or set for query caching, grouped by task. Each item links to its own entry below.

**Cache a query**

- [`.cache(ttl)`](#cache-ttl)
- [`.cache(config)`](#cache-config)

**Options for `.cache(config)`**

- [`ttl`](#ttl)
- [`flexible`](#flexible-option)
- [`key`](#key)
- [`driver`](#driver-option)
- [`invalidate`](#invalidate)

**Listen for invalidation**

- [`onDatabaseDependencyInvalidated()`](#ondatabasedependencyinvalidated)

### `.cache(ttl)` {#cache-ttl}

Caches the results for `ttl` seconds, or until a `Date`. It's shorthand for `.cache({ ttl })`. A `Date` that is already in the past skips the cache and runs the query. Available on table and model queries.

```ts
const user = await User.where('id', 1).cache(60).first()
```

### `.cache(config)` {#cache-config}

Caches the results with options. Pass an object with `ttl` or `flexible`, plus any of the options below. It throws a configuration error if you pass neither `ttl` nor `flexible`, or both.

```ts
const posts = await DB.table('posts')
  .where('published', true)
  .cache({ ttl: 300, key: 'posts.published', driver: 'redis' })
  .get()
```

### `ttl` {#ttl}

Seconds to keep the results, or a `Date` to keep them until. Use this or `flexible`, not both.

### `flexible` {#flexible-option}

A `[fresh, stale]` pair or a `{ fresh, stale }` object, in seconds. Results are fresh for the first window, then served stale while one caller re-runs the query. See [Stale-while-revalidate](#stale-while-revalidate).

### `key` {#key}

Your own cache key. Without it, Holo builds one from the SQL, the bindings, and the connection. Use a different `key` for each distinct query. Two queries with the same key share one entry.

### `driver` {#driver-option}

Name of a store from `config/cache.ts`. Defaults to the default store.

### `invalidate` {#invalidate}

Tables whose writes clear this entry. A plain table name uses the query's connection. Write `db:<connection>:<table>` to watch a table on another connection. A non-empty list replaces automatic tracking for this query. See [Automatic invalidation](#automatic-invalidation).

### `onDatabaseDependencyInvalidated(listener)` {#ondatabasedependencyinvalidated}

Calls `listener` each time a write clears query-cache entries. The listener receives `{ connectionName, dependencies }`, where `dependencies` lists the tables or `db:` dependencies that changed. Inside a transaction, it runs after the commit. It returns a function that removes the listener. Errors thrown by the listener are logged, not rethrown.

```ts
import { onDatabaseDependencyInvalidated } from '@holo-js/db'

const stopListening = onDatabaseDependencyInvalidated(({ connectionName, dependencies }) => {
  console.log(connectionName, dependencies)
})
```

## Next steps

- [Using the cache](/cache/usage)
- [Query builder basics](/database/query-builder/)
- [Querying models](/orm/querying)
