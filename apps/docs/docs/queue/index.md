# Queue

Holo-JS ships queue support as a first-class server subsystem. New projects already scaffold
`config/queue.ts`, create `server/jobs`, and default to the `sync` driver so dispatch works on day one.

## Existing projects

Install queue support into an existing Holo-JS app with:

```bash
bunx holo install queue
```

Pick a starting driver during install when needed:

```bash
bunx holo install queue --driver redis
bunx holo install queue --driver database
```

## What queue owns

The queue subsystem gives you:

- a typed `config/queue.ts`
- auto-discovered jobs under `server/jobs`
- dispatch helpers
- long-lived worker commands for async drivers
- failed-job management
- first-party media integration for queued conversions

Queue does not own event contracts. Event contracts and listener orchestration are documented under
[Events](/events/). Queued listeners use queue internally.

## Queue config

New apps start with `sync`:

```ts
import { defineQueueConfig } from '@holo-js/config'

export default defineQueueConfig({
  default: 'sync',
  failed: {
    driver: 'database',
    connection: 'default',
    table: 'failed_jobs',
  },
  connections: {
    sync: {
      driver: 'sync',
      queue: 'default',
    },
  },
})
```

`sync` runs the job inline. It is the simplest default and needs no worker process.

## End-to-end driver examples

### Sync

Use `sync` when you want immediate execution in local development, tests, or low-volume app flows.

```ts
import { dispatch } from '@holo-js/queue'

await dispatch('reports.send-digest', {
  reportId: 'daily-summary',
})
```

No worker process is required.

### Redis

Use `redis` for normal asynchronous work:

```ts
import { defineQueueConfig, env } from '@holo-js/config'

export default defineQueueConfig({
  default: 'redis',
  failed: {
    driver: 'database',
    connection: 'default',
    table: 'failed_jobs',
  },
  connections: {
    redis: {
      driver: 'redis',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
      redis: {
        host: env('REDIS_HOST', '127.0.0.1'),
        port: env('REDIS_PORT', 6379),
        username: env('REDIS_USERNAME'),
        password: env('REDIS_PASSWORD'),
        db: env('REDIS_DB', 0),
      },
    },
  },
})
```

Run a worker:

```bash
bunx holo queue:work --connection redis
```

### Database

Use `database` when you want queue portability and are comfortable polling from your app database:

```ts
import { defineQueueConfig } from '@holo-js/config'

export default defineQueueConfig({
  default: 'database',
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

Generate the required tables and migrate:

```bash
bunx holo queue:table
bunx holo queue:failed-table
bunx holo migrate
```

Then run a worker:

```bash
bunx holo queue:work --connection database
```

## Queue names and connections

- A connection selects the backend driver configuration such as `sync`, `redis`, or `database`.
- A queue name lets you partition work inside that connection, such as `default`, `emails`, or `media`.
- Jobs can set defaults, and dispatch can override them per call.

## Dispatch overview

Use `dispatch()` for normal queued execution:

```ts
import { dispatch } from '@holo-js/queue'

await dispatch('reports.send-digest', {
  reportId: 'daily-summary',
})
  .onConnection('redis')
  .onQueue('emails')
  .delay(60)
  .onComplete((result) => {
    console.log(result.jobId)
  })
  .onFailed((error) => {
    console.error(error)
  })
```

If dispatch must wait for a successful database commit, compose that explicitly with `DB.afterCommit()` from `@holo-js/db`.

Use `dispatchSync()` when the current code path must execute the job immediately:

```ts
import { dispatchSync } from '@holo-js/queue'

await dispatchSync('reports.send-digest', {
  reportId: 'daily-summary',
})
```

## Server-only rules

Queue jobs are backend code. Keep them in server-owned files and pass only JSON-serializable payloads:

- IDs
- strings
- numbers
- booleans
- arrays
- plain objects

Do not queue model instances, functions, streams, or browser-only objects.

## Continue

- [Jobs](/queue/jobs)
- [Workers](/queue/workers)
- [Failed Jobs](/queue/failed-jobs)
- [Database Tables](/queue/database)
- [Media Integration](/queue/media)
- [Events](/events/)
- [Queued Listeners](/events/queued-listeners)
