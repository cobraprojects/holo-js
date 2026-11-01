# Cache

The cache stores computed values so you don't recompute them on every request. Use it for expensive queries, third-party API responses, counters, and locks that stop two processes from doing the same work at once.

## Quick example

```ts [server/lib/dashboard.ts]
import cache from '@holo-js/cache'
import { DB } from '@holo-js/db'

export async function getDashboardStats() {
  return cache.remember('dashboard.stats', 300, async () => ({
    users: await DB.table('users').count(),
    posts: await DB.table('posts').count(),
  }))
}
```

The first call runs the callback and stores the result for 300 seconds. Every call after that returns the stored value until it expires.

## Install

Add cache support to an existing project:

```bash
npx holo install cache
```

This installs `@holo-js/cache`, writes `config/cache.ts`, and adds `CACHE_DRIVER` and `CACHE_PREFIX` to `.env` and `.env.example`.

The default store is `file`, which keeps entries on disk under `storage/framework/cache/data`. Pick a different store with `--driver`:

```bash
npx holo install cache --driver redis
npx holo install cache --driver database
```

| `--driver` | Extra package | Extra setup |
| --- | --- | --- |
| `file` (default) | none | none |
| `redis` | `@holo-js/cache-redis` | writes `config/redis.ts` if it is missing |
| `database` | `@holo-js/cache-db` | run `npx holo cache:table` and `npx holo migrate` |

### Switch drivers

If `config/cache.ts` already exists, the installer doesn't edit it. To switch an installed cache to another driver:

1. Add that driver's store to `config/cache.ts`. See [Cache drivers](/cache/drivers) for each store's config.
2. Run `npx holo install cache --driver <driver>` to add its package and setup. Without the store, the command stops with an error and writes nothing.
3. Set `CACHE_DRIVER` in `.env` to the new store's name. The installer keeps the value you already have, so the cache keeps using the old store until you change it.

See [Cache drivers](/cache/drivers) for what each store is good at.

## Use the cache anywhere on the server

Import the default export from `@holo-js/cache` in any server code: routes, models, [jobs](/queue/jobs), and [listeners](/events/listeners). Holo configures it from `config/cache.ts` when the app boots, so there is no setup call.

```ts
import cache from '@holo-js/cache'

await cache.put('settings.theme', 'dark', 3600)
const theme = await cache.get('settings.theme')
```

::: warning
The cache is server-only. Don't import `@holo-js/cache` from client components or browser code.
:::

## Cache database queries

Query builders and models have a `.cache()` method, so you often don't need to call the cache directly:

```ts
import { DB } from '@holo-js/db'

const activeUsers = await DB.table('users')
  .where('status', 'active')
  .cache(300)
  .get()
```

Holo clears these entries automatically when you write to the `users` table. See [Query caching](/cache/query-caching).

## Next steps

- [Using the cache](/cache/usage): every read and write method
- [Locks](/cache/locks): run work once across processes
- [Query caching](/cache/query-caching): cache query results with automatic invalidation
- [Drivers](/cache/drivers): configure file, memory, Redis, and database stores
