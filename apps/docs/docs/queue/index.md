# Queues

A queue lets you move slow work out of the request, such as sending email, resizing images, or calling a third-party API. Your route puts a job on the queue and responds right away. A separate worker process runs the job in the background.

## Quick example

Create a job:

```bash
npx holo make:job emails/send-welcome
```

Fill in what the job does:

```ts [server/jobs/emails/send-welcome.ts]
import { defineJob } from '@holo-js/queue'

export default defineJob<{
  userId: number
}>({
  async handle(payload) {
    console.log(`Sending welcome email to user ${payload.userId}`)
  },
})
```

Dispatch it from any server code:

```ts [server/lib/users.ts]
import SendWelcome from '../jobs/emails/send-welcome'

export async function onUserRegistered(userId: number) {
  await SendWelcome.dispatch({ userId })
}
```

With the default `sync` driver, the job runs immediately inside `dispatch()`. No worker is needed. When you switch to the `database` or `redis` driver, the same code puts the job on a queue and a worker runs it.

## Install queue support

New projects created with the queue package already have `config/queue.ts` and a `server/jobs` folder. To add queues to an existing project, run:

```bash
npx holo install queue
```

Pick a driver up front with `--driver`:

```bash
npx holo install queue --driver database
```

The supported values are `sync` (the default), `database`, and `redis`. The installer:

- creates `config/queue.ts` if it doesn't exist
- creates the `server/jobs` folder
- adds `@holo-js/queue` to `package.json`, plus `@holo-js/queue-db` or `@holo-js/queue-redis` when the driver needs it
- adds `QUEUE_CONNECTION` to `.env` and `.env.example`
- for `redis`, creates `config/redis.ts` and adds the `REDIS_*` variables

If `config/queue.ts` already exists, the installer leaves it alone and only adds missing packages.

## Configure the queue

The installer writes a config like this for the `sync` driver:

```ts [config/queue.ts]
import { defineQueueConfig } from '@holo-js/queue'
import { env } from '@holo-js/config'

export default defineQueueConfig({
  default: env('QUEUE_CONNECTION', 'sync'),
  failed: false,
  connections: {
    sync: {
      driver: 'sync',
      queue: 'default',
    },
  },
})
```

| Key | What it does |
| --- | --- |
| `default` | The connection jobs use unless they pick another one. Defaults to the first connection. |
| `connections` | Named connections. Each has a `driver` (`sync`, `database`, or `redis`) and driver options. |
| `failed` | Where jobs that fail on a worker are stored, or `false` to not store them. See [Failed jobs](/queue/failed-jobs). |

## Connections and queue names

A **connection** picks the backend: `sync`, `database`, or `redis`. A **queue name** splits work inside one connection, such as `default`, `emails`, or `media`.

You can run one worker per queue name so slow work doesn't hold up fast work:

```bash
npx holo queue:work --queue emails
npx holo queue:work --queue media
```

A job runs on, in order of priority:

1. the connection or queue you pass when dispatching
2. the `connection` or `queue` set on the job
3. the default connection, and that connection's `queue` (or `default`)

## Go to production

The `sync` driver is fine for development, tests, and small apps. It runs jobs inside the request, so a slow job slows the response, and a failing job fails the request.

For background processing:

1. Switch to the [`database` or `redis` driver](/queue/drivers).
2. Run [`queue:work`](/queue/workers) as a long-running process next to your web server.
3. Turn on the [failed jobs table](/queue/failed-jobs) so you can inspect and retry failures.

::: warning Payloads must be JSON
Job payloads are stored as JSON, so pass IDs and plain values, not model instances, `Date` objects, class instances, or functions. Holo rejects payloads that aren't plain JSON when you dispatch. Load the record again inside the job.
:::

## Next steps

- [Writing jobs](/queue/jobs): retries, backoff, timeouts, and dispatch options
- [Running workers](/queue/workers)
- [Drivers and tables](/queue/drivers)
- [Events](/events/): fan out one action to several reactions
