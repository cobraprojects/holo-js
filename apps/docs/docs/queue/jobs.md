# Writing Jobs

A job is one unit of background work, such as sending a digest email or generating a report. You define it once with `defineJob()` and dispatch it from anywhere on the server with a typed payload.

## Create a job

```bash
npx holo make:job reports/send-digest
```

This creates `server/jobs/reports/send-digest.ts`. Holo finds every job under `server/jobs`, including subfolders, so you don't register jobs by hand.

```ts [server/jobs/reports/send-digest.ts]
import { defineJob } from '@holo-js/queue'
import User from '../../models/User'

export default defineJob<{
  userId: number
}>({
  queue: 'emails',
  tries: 3,
  backoff: [10, 60, 300],
  timeout: 60,
  async handle(payload) {
    const user = await User.find(payload.userId)
    if (!user) {
      return
    }

    await sendDigestEmail(user.email)
  },
})
```

The type parameter on `defineJob<...>()` is the payload shape. It types `payload` inside `handle()` and the argument of `dispatch()`.

## Job names

A job's name comes from its file path under `server/jobs`:

| File | Job name |
| --- | --- |
| `server/jobs/reports/send-digest.ts` | `reports.send-digest` |
| `server/jobs/cache/prune.ts` | `cache.prune` |

`make:job` converts names to kebab case, so `npx holo make:job reports/SendDigest` also creates `reports/send-digest.ts`.

You only need the name when you dispatch by string, or when you read the failed-jobs list. Every file in `server/jobs` must export a job, so keep helpers in another folder.

Holo rescans the folder during `holo dev` and `holo build`, and when a worker starts. Run `npx holo prepare` to rescan by hand.

## Dispatch a job

Import the job and call `dispatch()` with its payload:

```ts
import SendDigest from '../jobs/reports/send-digest'

await SendDigest.dispatch({ userId: 42 })
```

Chain options before you `await`:

```ts
await SendDigest.dispatch({ userId: 42 })
  .onConnection('redis')
  .onQueue('emails')
  .delay(120)
```

| Method | What it does |
| --- | --- |
| `.onConnection(name)` | Use a different connection from `config/queue.ts`. |
| `.onQueue(name)` | Put the job on a different queue name. |
| `.delay(value)` | Wait before the job can run. Pass seconds, or a `Date`. |
| `.afterCommit()` | Queue the job only after the surrounding database transaction commits. Dispatches right away when no transaction is open. |
| `.onComplete(callback)` | Called with `{ jobId, connection, queue, synchronous }` once the job is queued. |
| `.onFailed(callback)` | Called with the error if the job couldn't be queued. |

::: warning Always await the dispatch
Nothing is sent until you `await` the dispatch (or call `.dispatch()` on it). A dispatch you don't await is never queued.
:::

`.onComplete()` and `.onFailed()` report whether the job was **queued**, not whether it finished on a worker. Use the job's own `onCompleted` and `onFailed` hooks for that. With the `sync` driver, queuing and running happen together, so `.onComplete()` runs after the job finishes.

The awaited dispatch returns the same `{ jobId, connection, queue, synchronous }` object.

### Delays

```ts
await SendDigest.dispatch({ userId: 42 }).delay(60)

await SendDigest.dispatch({ userId: 42 }).delay(new Date('2026-12-01T09:00:00Z'))
```

The `sync` driver ignores delays and runs the job right away.

### Run a job right now

`dispatchSync()` runs the job in the current process, on any connection, and returns whatever `handle()` returns:

```ts [server/jobs/reports/build-summary.ts]
import { defineJob } from '@holo-js/queue'

export default defineJob<{ reportId: string }, { rows: number }>({
  async handle(payload) {
    return { rows: await countRows(payload.reportId) }
  },
})
```

```ts
import BuildSummary from '../jobs/reports/build-summary'

const summary = await BuildSummary.dispatchSync({ reportId: 'daily' })
summary.rows
```

The second type parameter is the return type. When you pass the payload type, pass the return type too, or the result is typed `unknown`.

### Dispatch by name

Use the string form when the job name is only known at runtime:

```ts
import { dispatch, dispatchSync, Queue } from '@holo-js/queue'

await dispatch('reports.send-digest', { userId: 42 })

await dispatchSync('reports.send-digest', { userId: 42 })

await Queue.connection('redis')
  .dispatch('reports.send-digest', { userId: 42 })
  .onQueue('emails')
```

Holo generates types for discovered jobs, so known job names autocomplete and check the payload.

### Dispatch after a database commit

A worker can pick up a job before your transaction commits, and then not find the row it needs. Dispatch from `DB.afterCommit()` inside the [transaction](/database/transactions) instead:

```ts
import { DB } from '@holo-js/db'
import Order from '../models/Order'
import SendOrderReceipt from '../jobs/orders/send-receipt'

await DB.transaction(async () => {
  const order = await Order.create({ total: 4999 })

  DB.afterCommit(async () => {
    await SendOrderReceipt.dispatch({ orderId: order.id })
  })
})
```

The callback runs only if the transaction commits. `DB.afterCommit()` throws when called outside a transaction.

You can also chain `.afterCommit()` onto a dispatch. It queues the job only after the surrounding transaction commits, and dispatches right away when no transaction is open:

```ts
await DB.transaction(async () => {
  const order = await Order.create({ total: 4999 })

  await SendOrderReceipt.dispatch({ orderId: order.id }).afterCommit()
})
```

Set `afterCommit: true` on a connection in `config/queue.ts` to defer every dispatch to it. The default is `false`. If the transaction rolls back, the job is never queued.

## Retries and backoff

By default a job runs once. If it throws, it fails. Set `tries` to let a worker run it again:

```ts
export default defineJob<{ userId: number }>({
  tries: 5,
  backoff: 30,
  async handle(payload) {
    await syncProfile(payload.userId)
  },
})
```

`backoff` is how many seconds to wait before the next attempt:

- a number waits the same time before every retry
- an array sets the wait per retry, so `[10, 60, 300]` waits 10s, then 60s, then 300s for every retry after that
- with no `backoff`, the retry is available right away, unless the worker sets `--backoff`

Retries only happen on a worker. With the `sync` driver, an error in `handle()` is thrown back to the code that dispatched the job.

## Timeouts

`timeout` is the number of seconds a job may run on a worker. When `handle()` runs longer, the worker stops with a `QueueWorkerTimeoutError`, and the job stays reserved. After the connection's `retryAfter`, a worker runs it again. That run counts as an attempt, so the job is retried while `tries` remain and fails once they're used up.

Set `failOnTimeout: true` to fail the job right away on a timeout, without a retry:

```ts
export default defineJob<{ reportId: string }>({
  tries: 3,
  timeout: 120,
  failOnTimeout: true,
  async handle(payload) {
    await buildReport(payload.reportId)
  },
})
```

The worker doesn't stop your handler's code when it times out. Make the work inside `handle()` safe to finish late, or give it its own time limit.

::: warning Keep the timeout below `retryAfter`
A job's `timeout`, and the worker's `--timeout`, must be less than the connection's `retryAfter` (90 seconds by default). Otherwise a job that is still running can be handed to a second worker. Holo rejects the dispatch, or refuses to start the worker, when that happens. See [Drivers](/queue/drivers). Timeouts are also capped at 2147483 seconds, the longest delay Node can schedule.
:::

## The job context

`handle()` receives a second argument with details about the current run:

```ts
export default defineJob<{ invoiceId: string }>({
  tries: 3,
  async handle(payload, context) {
    context.jobId
    context.jobName
    context.connection
    context.queue
    context.attempt
    context.maxAttempts

    if (await isRateLimited()) {
      await context.release(60)
      return
    }

    if (await isInvoiceVoided(payload.invoiceId)) {
      await context.fail(new Error('Invoice was voided.'))
    }
  },
})
```

| Member | Meaning |
| --- | --- |
| `attempt` | The current attempt, starting at `1`. |
| `maxAttempts` | `tries`, or the worker's `--tries` value. |
| `release(seconds?)` | Put the job back on the queue to run again after the delay. Return from `handle()` afterwards. |
| `fail(error)` | Fail the job now, skipping any remaining retries. It throws, so code after it doesn't run. |

`release()` only works on a worker. With the `sync` driver it throws an error.

## Completed and failed hooks

Add `onCompleted` and `onFailed` to react when the job itself finishes:

```ts
export default defineJob<{ reportId: string }, { url: string }>({
  tries: 3,
  async handle(payload) {
    return { url: await renderReport(payload.reportId) }
  },
  async onCompleted(payload, result) {
    await notifyReportReady(payload.reportId, result.url)
  },
  async onFailed(payload, error, context) {
    console.error(`Report ${payload.reportId} failed (job ${context.jobId})`, error)
  },
})
```

`onFailed` runs once, when the job has failed for good, not after each retry. If a hook throws, Holo logs a warning and keeps the job's result.

## Payloads

Payloads are stored as JSON. Use strings, numbers, booleans, `null`, arrays, and plain objects. Holo throws a `TypeError` at dispatch for anything else, including `undefined`, `Date`, `NaN`, class instances, functions, and circular objects.

Pass IDs, not records. Load the record in the job, so the job sees current data:

```ts
await SendDigest.dispatch({ userId: user.id })
```

## Available methods

Everything you can call or set on a job, grouped by task. Each item links to its own entry below.

**Define a job**

- [`defineJob()`](#definejob-definition)

**Job options**

<div class="method-list">

- [`handle()`](#handle-payload-context)
- [`connection`](#connection)
- [`queue`](#queue)
- [`tries`](#tries)
- [`backoff`](#backoff)
- [`timeout`](#timeout)
- [`failOnTimeout`](#failontimeout)
- [`onCompleted()`](#oncompleted-payload-result-context)
- [`onFailed()`](#onfailed-payload-error-context)

</div>

**Dispatch**

<div class="method-list">

- [`Job.dispatch()`](#job-dispatch-payload)
- [`Job.dispatchSync()`](#job-dispatchsync-payload)
- [`dispatch()`](#dispatch-name-payload-options)
- [`dispatchSync()`](#dispatchsync-name-payload-options)
- [`Queue.connection()`](#queue-connection-name)
- [`useQueueConnection()`](#usequeueconnection-name)

</div>

**Pending dispatch chain**

<div class="method-list">

- [`.onConnection()`](#onconnection-name)
- [`.onQueue()`](#onqueue-name)
- [`.delay()`](#delay-value)
- [`.afterCommit()`](#aftercommit)
- [`.onComplete()`](#oncomplete-callback)
- [`.onFailed()`](#onfailed-callback)
- [`.dispatch()`](#dispatch-chain)
- [`.then()`, `.catch()`, `.finally()`](#then-catch-finally)

</div>

**Job context**

<div class="method-list">

- [`context.jobId`](#context-jobid)
- [`context.jobName`](#context-jobname)
- [`context.connection`](#context-connection)
- [`context.queue`](#context-queue)
- [`context.attempt`](#context-attempt)
- [`context.maxAttempts`](#context-maxattempts)
- [`context.release()`](#context-release-delayseconds)
- [`context.fail()`](#context-fail-error)

</div>

**Errors**

- [`QueueReleaseUnsupportedError`](#queuereleaseunsupportederror)
- [`QueueWorkerTimeoutError`](#queueworkertimeouterror)
- [`QueueWorkerUnsupportedDriverError`](#queueworkerunsupporteddrivererror)
- [`QueueFailedStoreError`](#queuefailedstoreerror)

**Registry lookups**

- [`getRegisteredQueueJob()`](#getregisteredqueuejob)
- [`listRegisteredQueueJobs()`](#listregisteredqueuejobs)

### `defineJob(definition)` {#definejob-definition}

Defines a job. Its type parameters are the payload type and the result type. Holo registers the job from its file path under `server/jobs`, so export the value this returns. It has `dispatch()` and `dispatchSync()` methods.

```ts [server/jobs/reports/send-digest.ts]
export default defineJob<{ userId: number }>({
  async handle(payload) {
    await sendDigest(payload.userId)
  },
})
```

### `handle(payload, context)` {#handle-payload-context}

Required. Does the work. It receives the payload and a [job context](#the-job-context), and can be `async`. Its return value is the job's result, which `dispatchSync()` returns and `onCompleted()` receives.

### `connection` {#connection}

Optional `string`. The connection this job dispatches to by default. It must be configured in `config/queue.ts`. A `.onConnection()` call on a dispatch overrides it. When neither is set, Holo uses the default connection.

### `queue` {#queue}

Optional `string`. The queue name this job dispatches to by default. A `.onQueue()` call on a dispatch overrides it. When neither is set, Holo uses the connection's `queue`, then `default`.

### `tries` {#tries}

Optional integer, at least `1`. The total number of attempts on a worker, including the first. Defaults to `1`, so the job runs once. A run interrupted by a worker that stopped also counts as an attempt; see [When a worker stops unexpectedly](/queue/workers#when-a-worker-stops-unexpectedly). Your `--tries` worker flag overrides it.

### `backoff` {#backoff}

Optional. A number of seconds, or an array of non-negative integers. It sets how long to wait before each retry. With an array, the retry uses the entry for its position, and retries past the end use the last entry. With no `backoff`, the worker's `--backoff` value applies, and if there isn't one, the retry is available right away.

```ts
export default defineJob<{ userId: number }>({
  tries: 4,
  backoff: [10, 60],
  async handle(payload) {
    await syncProfile(payload.userId)
  },
})
```

The wait is 10s after the first failed attempt, and 60s after every later failure.

### `timeout` {#timeout}

Optional non-negative integer, in seconds, less than the connection's `retryAfter` and at most `2147483`. A worker stops when `handle()` runs longer than this. The worker's `--timeout` flag overrides it. See [Timeouts](#timeouts).

### `failOnTimeout` {#failontimeout}

Optional boolean, default `false`. When `true`, a run that exceeds `timeout` fails the job right away, with no retry. See [Timeouts](#timeouts).

### `onCompleted(payload, result, context)` {#oncompleted-payload-result-context}

Optional hook. Runs after `handle()` returns successfully, with the payload, the result, and the context. It also runs for `dispatchSync()`. If it throws, Holo logs a warning and the job still counts as done.

### `onFailed(payload, error, context)` {#onfailed-payload-error-context}

Optional hook. Runs once, after the final failed attempt, with the payload, the error, and the context. It doesn't run between retries. If it throws, Holo logs a warning.

### `Job.dispatch(payload)` {#job-dispatch-payload}

Queues the job with a typed payload and returns a pending dispatch. Nothing is sent until you `await` it or call `.dispatch()`.

```ts
await SendDigest.dispatch({ userId: 42 }).onQueue('emails')
```

### `Job.dispatchSync(payload)` {#job-dispatchsync-payload}

Runs the job now, in the current process, and returns a promise of the `handle()` result. It ignores the queue and the worker. See [Run a job right now](#run-a-job-right-now).

### `dispatch(name, payload, options?)` {#dispatch-name-payload-options}

Queues a job by its name. Use it when the name is only known at runtime. `options` is an object with optional `connection`, `queue`, and `delay`, and it has the same effect as the matching chain methods. `Queue.dispatch` is the same function.

```ts
import { dispatch } from '@holo-js/queue'

await dispatch('reports.send-digest', { userId: 42 }, { queue: 'emails', delay: 60 })
```

It returns a pending dispatch. Awaiting it throws if no job with that name is registered.

### `dispatchSync(name, payload, options?)` {#dispatchsync-name-payload-options}

Runs a job by name, in the current process, and returns its result. The sync execution path is always used, so the job runs inline even if its connection is a worker driver. `Queue.dispatchSync` is the same function.

### `Queue.connection(name?)` {#queue-connection-name}

Returns a connection object for dispatching to one connection. Call it without a name to use the default connection. The connection name is checked when you dispatch. The object has:

- `name`: the connection name.
- `dispatch(name, payload, options?)`: queues the job on this connection and returns a pending dispatch.
- `dispatchSync(name, payload)`: runs the job inline.

```ts
import { Queue } from '@holo-js/queue'

await Queue.connection('redis')
  .dispatch('reports.send-digest', { userId: 42 })
  .onQueue('emails')
```

Dispatching to a connection that isn't configured fails.

### `useQueueConnection(name?)` {#usequeueconnection-name}

The same function as `Queue.connection()`, exported on its own.

```ts
import { useQueueConnection } from '@holo-js/queue'

const redis = useQueueConnection('redis')
await redis.dispatch('reports.send-digest', { userId: 42 })
```

### `.onConnection(name)` {#onconnection-name}

Sends this dispatch to another connection. Overrides the job's `connection`.

### `.onQueue(name)` {#onqueue-name}

Puts this dispatch on another queue. Overrides the job's `queue`.

### `.delay(value)` {#delay-value}

Waits before the job can run. Pass seconds as a non-negative number, or a valid `Date` to run at that time. An invalid value throws when you call `.delay()`.

```ts
await SendDigest.dispatch({ userId: 42 }).delay(new Date('2026-12-01T09:00:00Z'))
```

### `.afterCommit()` {#aftercommit}

Holds the job until the surrounding database transaction commits. If there is no open transaction, it dispatches right away. If the transaction rolls back, the job is never queued, `onComplete` doesn't run, and `onFailed` doesn't run either.

```ts
await DB.transaction(async () => {
  const order = await Order.create({ total: 4999 })

  await SendOrderReceipt.dispatch({ orderId: order.id }).afterCommit()
})
```

The awaited result is returned straight away. `onComplete` runs when the job is queued at commit. The connection's driver must accept a caller-supplied job ID. Otherwise `.afterCommit()` throws at dispatch, naming the connection. If queuing fails at commit, `onFailed` runs with the error, and Holo reports the error. See [Dispatch after a database commit](#dispatch-after-a-database-commit) for the connection-wide `afterCommit` setting.

### `.onComplete(callback)` {#oncomplete-callback}

Calls `callback` with `{ jobId, connection, queue, synchronous }` after the job is queued. This means queued, not finished. Errors in the callback are logged as warnings. You can add more than one callback.

### `.onFailed(callback)` {#onfailed-callback}

Calls `callback` with the error when queuing fails. Errors in the callback are logged, and the original error is still thrown to the `await`. You can add more than one callback.

### `.dispatch()` {#dispatch-chain}

Starts the dispatch and returns a promise of `{ jobId, connection, queue, synchronous }`. Calling it again returns the same promise, so the job is queued only once. `await` does the same thing.

### `.then()`, `.catch()`, `.finally()` {#then-catch-finally}

The standard promise methods. The pending dispatch is a promise-like object, so `await`, `.then()`, `.catch()`, and `.finally()` all start the dispatch.

### `context.jobId` {#context-jobid}

The unique ID of this job, as a `string`.

### `context.jobName` {#context-jobname}

The job's name, such as `reports.send-digest`.

### `context.connection` {#context-connection}

The name of the connection the job runs on.

### `context.queue` {#context-queue}

The name of the queue the job runs on.

### `context.attempt` {#context-attempt}

The current attempt number, starting at `1`.

### `context.maxAttempts` {#context-maxattempts}

The total number of attempts allowed for this run. It's `tries`, or the worker's `--tries` value.

### `context.release(delaySeconds?)` {#context-release-delayseconds}

Puts the job back on the queue to run again after the delay. Return from `handle()` afterwards. Throws [`QueueReleaseUnsupportedError`](#queuereleaseunsupportederror) when the job runs inline, for example from `dispatchSync()` or the `sync` driver.

### `context.fail(error)` {#context-fail-error}

Fails the job now, without any remaining retries. It throws the error, so the code after it doesn't run.

### `QueueReleaseUnsupportedError` {#queuereleaseunsupportederror}

Thrown by `context.release()` when the job runs inline, from `dispatchSync()` or the `sync` driver. Catch it with `instanceof`.

### `QueueWorkerTimeoutError` {#queueworkertimeouterror}

Thrown when a run exceeds its `timeout`. The worker stops with it, and it's given to `onFailed()` and the worker's `onJobFailed` hook when the job has `failOnTimeout`. Its message includes the job name and the limit. Check it with `instanceof`.

### `QueueWorkerUnsupportedDriverError` {#queueworkerunsupporteddrivererror}

Thrown by `runQueueWorker()` when the connection uses a driver that workers can't read from, such as `sync`. See [Running workers](/queue/workers#run-workers-from-code).

### `QueueFailedStoreError` {#queuefailedstoreerror}

Thrown by the failed-jobs functions when the failed-jobs store fails. The original error is on `cause`. See [Failed jobs](/queue/failed-jobs#manage-failed-jobs-from-code).

### `getRegisteredQueueJob(name)` {#getregisteredqueuejob}

Returns the registered job with this name, or `undefined`. It's read-only, and it reads the jobs Holo discovered from `server/jobs`.

```ts
import { getRegisteredQueueJob } from '@holo-js/queue'

const job = getRegisteredQueueJob('reports.send-digest')
```

### `listRegisteredQueueJobs()` {#listregisteredqueuejobs}

Returns every registered job, sorted by name. It's read-only, so use it for an admin screen or a debugging command.

## Next steps

- [Running workers](/queue/workers)
- [Failed jobs](/queue/failed-jobs)
- [Queued listeners](/events/queued-listeners): run event listeners on the queue
