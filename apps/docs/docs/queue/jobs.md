# Queue Jobs

Holo-JS discovers jobs from `server/jobs` and all nested subdirectories under it.

## Create a job

Generate a new job file:

```bash
bunx holo make:job reports/send-digest
```

That creates:

```text
server/jobs/reports/send-digest.ts
```

## Define a job

Use `defineJob(...)` from `@holo-js/queue`:

```ts
import { defineJob } from '@holo-js/queue'

export default defineJob({
  queue: 'emails',
  connection: 'redis',
  tries: 3,
  backoff: [5, 30, 120],
  timeout: 60,
  async handle(payload: { userId: string }, context) {
    void context
    await sendDigestEmail(payload.userId)
  },
  async onCompleted(payload, result, context) {
    void payload
    void result
    void context
  },
  async onFailed(payload, error, context) {
    void payload
    void error
    void context
  },
})
```

`defineJob(...)` supports:

- `connection`
- `queue`
- `tries`
- `backoff`
- `timeout`
- `handle(payload, context)`
- `onCompleted(payload, result, context)`
- `onFailed(payload, error, context)`

## Job names

Discovered jobs are identified by their file path under `server/jobs`.

Examples:

- `server/jobs/reports/send-digest.ts` becomes `reports.send-digest`
- `server/jobs/cache/prune.ts` becomes `cache.prune`

`defineJob(...)` does not need a `name` field for discovered app jobs.

## Dispatching jobs

Dispatch from any server-side code:

```ts
import { dispatch, dispatchSync, Queue } from '@holo-js/queue'

await dispatch('reports.send-digest', {
  userId: 'user_1',
})

await dispatch('reports.send-digest', {
  userId: 'user_1',
})
  .onConnection('redis')
  .onQueue('emails')
  .delay(120)
  .onComplete((result) => {
    console.log(result.jobId)
  })
  .onFailed((error) => {
    console.error(error)
  })

await dispatchSync('reports.send-digest', {
  userId: 'user_1',
})

await Queue.connection('redis')
  .dispatch('reports.send-digest', { userId: 'user_1' })
  .onQueue('emails')
```

When dispatch must wait for a successful database commit, call `DB.afterCommit(() => dispatch(...).dispatch())` in your application layer instead of relying on queue-managed transaction deferral.

Connection and queue defaults are separate from job identity:

- omit job `connection`: Holo-JS uses the configured default queue connection
- omit job `queue`: Holo-JS uses that connection’s configured queue, then falls back to `default`
- omit worker `--connection`: `queue:work` and `queue:listen` use the configured default queue connection
- omit worker `--queue`: the worker listens on that connection’s configured queue

Dispatch hooks are for enqueue success or failure, not for the queued job's eventual completion on async drivers.

## Job context

The `handle()` callback receives a job context:

```ts
import { defineJob } from '@holo-js/queue'

export default defineJob({
  async handle(payload: { userId: string }, context) {
    context.jobId
    context.jobName
    context.connection
    context.queue
    context.attempt
    context.maxAttempts

    if (shouldRetryLater(payload.userId)) {
      await context.release(30)
      return
    }

    if (shouldFailFast(payload.userId)) {
      await context.fail(new Error('Digest generation failed.'))
      return
    }
  },
})
```

The same context shape is passed to `onCompleted(...)` and `onFailed(...)`.

## Retry and timeout defaults

Job definitions can declare:

- `tries`
- `backoff`
- `timeout`
- default `connection`
- default `queue`

Worker flags can still override tries and timeout at runtime.

## Payload rules

Queued payloads must stay JSON-serializable. Good payloads are usually:

- record IDs
- file paths
- conversion names
- booleans and options

Avoid:

- model instances
- class instances
- file handles
- buffers you could reload later by ID or path

## Jobs vs event listeners

Use queue jobs when the job contract itself is the main unit of work.

Use events and listeners when one domain signal should fan out to multiple reactions. Queued listeners run
through queue internally while keeping event-first contracts.

## Discovery workflow

Holo-JS refreshes the generated job registry during:

- `bun run dev`
- `bun run build`
- `bunx holo prepare`

Run `bunx holo prepare` directly when you only want to rebuild discovery output.

## Continue

- [Queue Getting Started](/queue/)
- [Workers](/queue/workers)
- [Events](/events/)
- [Queued Listeners](/events/queued-listeners)
