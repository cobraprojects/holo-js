# Failed Jobs

When a job fails for good on a worker, Holo can save it to a `failed_jobs` table. You can then see what went wrong, fix the cause, and run the job again.

## Set up the failed jobs table

Point `failed` in `config/queue.ts` at a database connection:

```ts [config/queue.ts]
import { defineQueueConfig } from '@holo-js/queue'

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
    },
  },
})
```

Then create the table:

```bash
npx holo queue:failed-table
npx holo migrate
```

`queue:failed-table` writes a normal [migration](/database/migrations) for the table named in `failed.table`.

The failed jobs table needs the `@holo-js/queue-db` package. `npx holo install queue --driver database` adds it and turns on the failed jobs table for you. The `sync` and `redis` installers write `failed: false`, so change that and install `@holo-js/queue-db` when you want to keep failures.

| Key | Default | Description |
| --- | --- | --- |
| `driver` | `'database'` | The only supported store. |
| `connection` | `'default'` | Database connection from `config/database.ts`. |
| `table` | `'failed_jobs'` | Table name. |

Set `failed: false` to not store failed jobs. If you leave `failed` out of the config entirely, Holo uses the defaults above.

## When a job counts as failed

A job is saved to the table when, on a worker:

- it throws on its last attempt (see `tries` in [Writing jobs](/queue/jobs#retries-and-backoff))
- it calls `context.fail(error)`
- it runs longer than its `timeout` and has `failOnTimeout` set; otherwise a timed-out run is retried like an interrupted one
- a worker stopped while running it and it has no tries left (see [When a worker stops unexpectedly](/queue/workers#when-a-worker-stops-unexpectedly))
- its job name isn't registered in the app that runs the worker

Jobs on the `sync` driver are never saved. Their errors are thrown back to the code that dispatched them.

## List failed jobs

```bash
npx holo queue:failed
```

Each line shows the failed job's ID, the job name, its connection and queue, and when it failed as a Unix timestamp in milliseconds. The newest failures come first:

```text
3f2a9c4e-8b1d-4f6a-9e2b-7c5d1a0e4b39 reports.send-digest connection=redis queue=emails failedAt=1792224000000
```

The table also stores the payload and the error's stack trace in the `exception` column.

## Retry failed jobs

Retry one job by its ID:

```bash
npx holo queue:retry 3f2a9c4e-8b1d-4f6a-9e2b-7c5d1a0e4b39
```

Or retry everything:

```bash
npx holo queue:retry all
```

Retrying puts the job back on its original connection and queue with the same payload. It starts again from attempt 1, with no delay, and its row is removed from the failed jobs table. A worker must be running to pick it up.

## Delete failed jobs

Remove one record without retrying it:

```bash
npx holo queue:forget 3f2a9c4e-8b1d-4f6a-9e2b-7c5d1a0e4b39
```

Remove every record:

```bash
npx holo queue:flush
```

::: warning
`queue:flush` permanently deletes every failed job record. Those jobs can't be retried afterwards.
:::

## Manage failed jobs from code

The same actions are available as functions, for example to build an admin page:

```ts
import {
  flushFailedQueueJobs,
  forgetFailedQueueJob,
  listFailedQueueJobs,
  retryFailedQueueJobs,
} from '@holo-js/queue'

const failed = await listFailedQueueJobs()
for (const record of failed) {
  console.log(record.id, record.job.name, record.job.payload, record.exception)
}

const retried = await retryFailedQueueJobs('all')
const removed = await forgetFailedQueueJob('3f2a9c4e-8b1d-4f6a-9e2b-7c5d1a0e4b39')
const flushed = await flushFailedQueueJobs()
```

| Function | Returns |
| --- | --- |
| `listFailedQueueJobs()` | Records with `id`, `jobId`, `job` (name, connection, queue, payload), `exception`, and `failedAt`. |
| `retryFailedQueueJobs(idOrAll)` | How many jobs were retried. |
| `forgetFailedQueueJob(id)` | `true` if a record was deleted. |
| `flushFailedQueueJobs()` | How many records were deleted. |

When `failed` is `false`, these return an empty list, `0`, or `false`.

## Next steps

- [Running workers](/queue/workers)
- [Drivers and tables](/queue/drivers)
