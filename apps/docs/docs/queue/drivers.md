# Queue Drivers and Tables

A driver decides where queued jobs wait until a worker runs them. Holo ships three: `sync`, `database`, and `redis`. You can define several connections in `config/queue.ts` and pick one per job.

| Driver | Where jobs wait | Needs a worker | Extra package |
| --- | --- | --- | --- |
| `sync` | Nowhere, jobs run immediately | No | none |
| `database` | A `jobs` table in your database | Yes | `@holo-js/queue-db` |
| `redis` | Redis | Yes | `@holo-js/queue-redis` |

`npx holo install queue --driver <name>` adds the right package. If you switch drivers by editing the config, run the installer again with the new driver to add the missing package. It won't overwrite your existing `config/queue.ts`.

## Sync

```ts [config/queue.ts]
import { defineQueueConfig } from '@holo-js/queue'

export default defineQueueConfig({
  default: 'sync',
  failed: false,
  connections: {
    sync: {
      driver: 'sync',
      queue: 'default',
    },
  },
})
```

`dispatch()` runs the job right away and waits for it to finish. Delays and retries are ignored, and an error in the job is thrown back to the caller. Use it for local development, tests, and work that is fast enough to do inside the request.

| Option | Default | Description |
| --- | --- | --- |
| `queue` | `'default'` | The queue name recorded on jobs. |

## Database

The `database` driver stores jobs in a table on one of your [database connections](/database/connections). It works with SQLite, PostgreSQL, and MySQL 8.0.17 or later, and needs no extra service.

```ts [config/queue.ts]
import { defineQueueConfig } from '@holo-js/queue'
import { env } from '@holo-js/config'

export default defineQueueConfig({
  default: env('QUEUE_CONNECTION', 'database'),
  failed: {
    driver: 'database',
    connection: 'default',
    table: 'failed_jobs',
  },
  connections: {
    database: {
      driver: 'database',
      connection: 'default',
      table: 'jobs',
      queue: 'default',
      retryAfter: 90,
      sleep: 1,
    },
  },
})
```

| Option | Default | Description |
| --- | --- | --- |
| `connection` | `'default'` | Database connection name from `config/database.ts`. |
| `table` | `'jobs'` | Table that holds waiting jobs. |
| `queue` | `'default'` | Default queue name for this connection. |
| `retryAfter` | `90` | Seconds before a job a worker took, but never finished, can be taken by another worker. |
| `sleep` | `1` | Seconds a worker waits before checking an empty queue again. |

### Create the jobs table

```bash
npx holo queue:table
npx holo queue:failed-table
npx holo migrate
```

`queue:table` writes a [migration](/database/migrations) for the `table` of every `database` connection in your config, or for `jobs` if there are none. `queue:failed-table` writes one for the [failed jobs table](/queue/failed-jobs). They are regular migrations in your project, so commit them.

The full setup from scratch:

```bash
npx holo install queue --driver database
npx holo queue:table
npx holo queue:failed-table
npx holo migrate
npx holo queue:work
```

### Run several workers

You can run as many workers as you need against the same jobs table. Each job is taken by one worker only. On MySQL and PostgreSQL, a worker skips jobs another worker is taking and moves on to the next one, so workers don't wait on each other. Keep the indexes the `queue:table` migration creates: without them, a worker on MySQL holds every waiting job while it takes one. On SQLite, workers take jobs one at a time, because SQLite allows one write at a time.

## Redis

The `redis` driver keeps jobs in Redis, using [BullMQ](https://docs.bullmq.io). Workers wait on Redis for new jobs instead of polling a table. Use it when you run Redis already or process many jobs.

```ts [config/queue.ts]
import { defineQueueConfig } from '@holo-js/queue'
import { env } from '@holo-js/config'

export default defineQueueConfig({
  default: env('QUEUE_CONNECTION', 'redis'),
  failed: false,
  connections: {
    redis: {
      driver: 'redis',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
    },
  },
})
```

The Redis server itself is set in `config/redis.ts`, which the installer creates. The queue uses its `default` Redis connection unless you name another one with `connection`:

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
  },
})
```

When `url` is set, it's used instead of `host` and `port`. See [Configuration](/getting-started/configuration) for Redis Cluster and other connection styles.

| Option | Default | Description |
| --- | --- | --- |
| `connection` | the `default` in `config/redis.ts` | Redis connection name from `config/redis.ts`. |
| `queue` | `'default'` | Default queue name for this connection. |
| `retryAfter` | `90` | Seconds a worker holds a job before Redis considers it stalled. |
| `blockFor` | `5` | Seconds a worker waits on Redis for a new job before checking again. |
| `redis` | none | Override Redis settings for this connection only: `url`, `host`, `port`, `username`, `password`, `db`, or `clusters`. |

Redis Cluster only supports database `0`, so setting `db` to anything else with `clusters` is an error.

## Multiple connections

Define as many connections as you need and pick one per job or per dispatch:

```ts [config/queue.ts]
import { defineQueueConfig } from '@holo-js/queue'

export default defineQueueConfig({
  default: 'database',
  failed: false,
  connections: {
    database: {
      driver: 'database',
      queue: 'default',
    },
    redis: {
      driver: 'redis',
      queue: 'default',
    },
  },
})
```

```ts
await SendDigest.dispatch({ userId: 42 }).onConnection('redis')
```

Each connection needs its own worker: `npx holo queue:work --connection redis`.

## Queued image conversions

[Media library](/media/) conversions marked with `.queued()` are generated by a queue job instead of during the upload. See [Image conversions](/media/conversions).

The conversion job runs on the default connection and always uses the `media` queue. With the `sync` driver it runs right away. With `database` or `redis`, make sure a worker listens on `media`:

```bash
npx holo queue:work --queue default,media
```

::: warning
A worker started without `--queue` only listens on the connection's `queue` (usually `default`), so queued conversions would never run.
:::

## Next steps

- [Running workers](/queue/workers)
- [Failed jobs](/queue/failed-jobs)
- [Environment variables](/reference/environment)
