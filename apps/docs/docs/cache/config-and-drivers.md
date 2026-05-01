# Config And Drivers

## Basic config

```ts
import { defineCacheConfig, env } from '@holo-js/config'

export default defineCacheConfig({
  default: 'file',
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

`prefix` applies to every driver unless a driver overrides it.

## Driver examples

### Memory

Use `memory` for tests, local-only caching, or tiny single-process workloads:

```ts
memory: {
  driver: 'memory',
  maxEntries: 1000,
}
```

Operational caveats:

- per process only
- no persistence across restarts
- no shared state between Node workers, Bun workers, or multiple app instances

### File

Use `file` when you want persistence on one machine without adding Redis:

```ts
file: {
  driver: 'file',
  path: './storage/framework/cache/data',
}
```

Operational caveats:

- shared only by processes that can see the same filesystem path
- not suitable for multi-machine deployments unless the filesystem is actually shared
- higher latency than memory or Redis

### Redis

Use `redis` for shared cache, shared locks, and horizontal scaling:

```ts
// config/redis.ts
import { defineRedisConfig, env } from '@holo-js/config'

export default defineRedisConfig({
  default: 'cache',
  connections: {
    cache: {
      url: env('REDIS_URL') || undefined,
      host: env('REDIS_HOST', '127.0.0.1'),
      port: env('REDIS_PORT', 6379),
      username: env('REDIS_USERNAME'),
      password: env('REDIS_PASSWORD'),
      db: env('REDIS_DB', 0),
    },
  },
})
```

```ts
// config/cache.ts
import { defineCacheConfig, env } from '@holo-js/config'

export default defineCacheConfig({
  default: 'redis',
  prefix: env('CACHE_PREFIX', ''),
  drivers: {
    redis: {
      driver: 'redis',
      connection: 'cache',
    },
  },
})
```

The cache layer only stores the Redis connection name in `config/cache.ts`. The actual Redis target lives in
`config/redis.ts`.

Shared Redis connections resolve in this order:

1. `url`
2. `clusters`
3. `host`

Redis install requirements:

- `@holo-js/cache`
- `@holo-js/cache-redis`
- `config/redis.ts`

### Database

Use `database` when you want a shared cache without Redis and you are comfortable storing cache data in SQL:

```ts
import { defineCacheConfig, env } from '@holo-js/config'

export default defineCacheConfig({
  default: 'database',
  prefix: env('CACHE_PREFIX', ''),
  drivers: {
    database: {
      driver: 'database',
      connection: 'default',
      table: 'cache',
      lockTable: 'cache_locks',
    },
  },
})
```

Database install requirements:

- `@holo-js/cache`
- `@holo-js/cache-db`
- `npx holo cache:table`

The cache driver reuses a named DB connection from `config/database.ts`. It does not duplicate database
credentials inside `config/cache.ts`.

## Prefixes and multiple stores

Per-driver prefixes let you isolate key spaces:

```ts
import { defineCacheConfig, env } from '@holo-js/config'

export default defineCacheConfig({
  default: 'redis',
  prefix: env('CACHE_PREFIX', 'app:'),
  drivers: {
    redis: {
      driver: 'redis',
      connection: 'cache',
      prefix: 'app:cache:',
    },
    memory: {
      driver: 'memory',
      prefix: 'app:test:',
    },
  },
})
```

You can then select a named store with `cache.driver('memory')` or `cache.driver('redis')`.

## Driver summary

| Driver | Persists across restart | Shared across app nodes | Typical use |
| --- | --- | --- | --- |
| `memory` | No | No | tests, local process cache |
| `file` | Yes | Only on the same filesystem | single-machine app cache |
| `redis` | Yes | Yes | production shared cache and locks |
| `database` | Yes | Yes, if app nodes share the same DB | portable SQL-backed cache |
