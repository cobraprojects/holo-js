# Cache Drivers

A driver decides where cached values live. Holo ships four: `file`, `memory`, `redis`, and `database`. You configure them as named stores in `config/cache.ts` and pick one as the default.

```ts [config/cache.ts]
import { defineCacheConfig } from '@holo-js/cache'
import { env } from '@holo-js/config'

export default defineCacheConfig({
  default: env('CACHE_DRIVER', 'file'),
  prefix: env('CACHE_PREFIX', ''),
  drivers: {
    file: {
      driver: 'file',
      path: './storage/framework/cache/data',
    },
    memory: {
      driver: 'memory',
      maxEntries: 1000,
    },
  },
})
```

This is the file `npx holo install cache` writes. `--driver redis` also adds a `redis` store, and `--driver database` adds a `database` store. Change the default store by setting `CACHE_DRIVER` in `.env` to one of the stores in the file.

## Choose a driver

| Driver | Survives restarts | Shared between servers | Good for |
| --- | --- | --- | --- |
| `file` | Yes | Only on the same disk | Single-server apps |
| `memory` | No | No | Tests and small per-process caches |
| `redis` | Yes | Yes | Production apps with more than one server |
| `database` | Yes | Yes, when servers share the database | Shared cache without running Redis |

## File

Stores each entry as a file on disk. It needs no extra packages and is the default.

```ts
file: {
  driver: 'file',
  path: './storage/framework/cache/data',
}
```

| Option | Default | Description |
| --- | --- | --- |
| `path` | `./storage/framework/cache/data` | Folder for cache files, relative to where the app runs. |
| `prefix` | top-level `prefix` | Key prefix for this store. |

Only processes that can read the same folder share entries and [locks](/cache/locks). Don't rely on it across servers unless they share a filesystem.

`flush()` deletes every entry and lock the store has written under its folder. Give each app its own `path`.

## Memory

Keeps entries in the memory of the current process. Everything is lost on restart, and each process (and each server) has its own copy.

```ts
memory: {
  driver: 'memory',
  maxEntries: 1000,
}
```

| Option | Default | Description |
| --- | --- | --- |
| `maxEntries` | `10000` | When the store grows past this, expired entries are removed first, then the least recently written entries. A write that refreshes an existing key counts as recent. |
| `prefix` | top-level `prefix` | Key prefix for this store. |

## Redis

Stores entries in Redis, so every server sees the same cache and locks. Install it with:

```bash
npx holo install cache --driver redis
```

This adds `@holo-js/cache-redis` and a `redis` store to `config/cache.ts`, and creates `config/redis.ts` if you don't have one. The cache store points at a named Redis connection; the server address lives in `config/redis.ts`:

```ts [config/redis.ts]
import { env } from '@holo-js/config'
import { defineRedisConfig } from '@holo-js/kernel'

export default defineRedisConfig({
  default: env('REDIS_CONNECTION', 'default'),
  connections: {
    default: {
      url: env('REDIS_URL') || undefined,
      host: env('REDIS_HOST', '127.0.0.1'),
      port: env('REDIS_PORT', 6379),
      username: env('REDIS_USERNAME'),
      password: env('REDIS_PASSWORD'),
      db: env('REDIS_DB', 0),
    },
    cache: {
      url: env('REDIS_URL') || undefined,
      host: env('REDIS_HOST', '127.0.0.1'),
      port: env('REDIS_PORT', 6379),
      username: env('REDIS_USERNAME'),
      password: env('REDIS_PASSWORD'),
      db: env('REDIS_CACHE_DB', 1),
    },
  },
})
```

```ts [config/cache.ts]
redis: {
  driver: 'redis',
  connection: 'cache',
}
```

The scaffold gives the cache its own `cache` connection on Redis database `1`, so queues and sessions on `default` are never touched by a flush. If `config/redis.ts` already exists without a `cache` connection, `npx holo install cache --driver redis` adds the connection above to its `connections` object, along with the `env` import if the file needs it, and adds `REDIS_CACHE_DB=1` to `.env` and `.env.example` unless they already set it. It refuses if another connection already uses that Redis server and database, because a flush would delete that connection's data; set `REDIS_CACHE_DB` to a free database and run it again. If it can't edit the file, for example because `connections` isn't written inline, it stops before it writes anything, says why, and prints the connection to add.

| Option | Default | Description |
| --- | --- | --- |
| `connection` | the `default` connection in `config/redis.ts` | Which Redis connection to use. The scaffold uses `cache`. |
| `prefix` | top-level `prefix` | Key prefix for this store. |

If the connection name isn't in `config/redis.ts`, Holo throws an error listing the connections it found.

::: warning
`cache.flush()` and `npx holo cache:clear` run `FLUSHDB` on the store's Redis database. That deletes every key in the database, whatever its prefix, including queue or session data stored there. Point the cache only at a database that holds nothing else. Redis Cluster has no numbered databases, so `flush()` clears every primary node; give a cluster to the cache alone.
:::

## Database

Stores entries in two tables in your SQL database: one for values and one for locks.

```bash
npx holo install cache --driver database
npx holo cache:table
npx holo migrate
```

The installer adds `@holo-js/cache-db` and a `database` store to `config/cache.ts`:

```ts [config/cache.ts]
database: {
  driver: 'database',
  connection: 'default',
  table: 'cache',
  lockTable: 'cache_locks',
}
```

| Option | Default | Description |
| --- | --- | --- |
| `connection` | the default connection in `config/database.ts` | Which database connection to use. |
| `table` | `cache` | Table for cache entries. |
| `lockTable` | `cache_locks` | Table for locks. |
| `prefix` | top-level `prefix` | Key prefix for this store. |

The store reuses a connection from `config/database.ts`, so you don't repeat credentials here.

`flush()` deletes every row in the entries table and leaves locks alone, so a lock held while the cache is flushed still holds. Expired locks are removed when someone tries to take the same lock again, and by a lottery on about 2% of lock attempts, so the lock table doesn't grow without bound.

`npx holo cache:table` reads `config/cache.ts` and writes one migration in `server/db/migrations` for every `database` store, using its `table` and `lockTable` names.

## Key prefixes

The top-level `prefix` is added to every key in every store. A store's own `prefix` replaces it for that store:

```ts [config/cache.ts]
import { defineCacheConfig } from '@holo-js/cache'
import { env } from '@holo-js/config'

export default defineCacheConfig({
  default: 'redis',
  prefix: env('CACHE_PREFIX', 'blog:'),
  drivers: {
    redis: {
      driver: 'redis',
      prefix: 'blog:cache:',
    },
    memory: {
      driver: 'memory',
    },
  },
})
```

Here the `redis` store uses `blog:cache:` and the `memory` store uses `blog:`. Use prefixes to keep apps or environments apart when they share Redis or a database.

A prefix only changes key names. Give each app its own store, Redis database, or tables, because `flush()` clears the whole store.

## Multiple stores

You can configure several stores, including more than one of the same driver. Use the store name with `cache.driver()`:

```ts
import cache from '@holo-js/cache'

await cache.driver('memory').put('geo.lookup', result, 30)
await cache.driver('redis').remember('feed.home', 60, buildHomeFeed)
```

If you leave out `drivers`, Holo gives you a `file` and a `memory` store. If you leave out `default`, it uses `file` when that store exists, otherwise the first store listed.

## Command line

Clear every entry in the default store, or a named store:

```bash
npx holo cache:clear
npx holo cache:clear --driver redis
```

Remove a single key:

```bash
npx holo cache:forget dashboard.stats
npx holo cache:forget dashboard.stats --driver redis
```

Generate the migration for `database` stores:

```bash
npx holo cache:table
```

`--driver` (short form `-d`) takes a store name from `config/cache.ts`.

## Next steps

- [Using the cache](/cache/usage)
- [Locks](/cache/locks)
- [Migrations](/database/migrations)
- [CLI commands](/reference/cli)
