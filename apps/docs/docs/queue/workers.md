# Running Workers

A worker is a long-running process that takes jobs off the queue and runs them. You need one for the `database` and `redis` drivers. The `sync` driver runs jobs inside the request, so it needs no worker.

## Start a worker

```bash
npx holo queue:work
```

The worker connects to the default connection from `config/queue.ts`, listens on that connection's queue, and runs until you stop it. Pick a different connection or queue names with flags:

```bash
npx holo queue:work --connection redis --queue emails,media
```

When it stops, the worker prints a summary:

```text
[queue] Stopped (empty). processed=12 released=1 failed=0
```

Failed jobs are also printed to stderr as they happen.

`queue:work` refuses to run against a `sync` connection, because there is nothing to pick up.

## Choose which queues to process

Pass `--queue` once with a comma-separated list, or repeat it:

```bash
npx holo queue:work --queue high,default
npx holo queue:work -q high -q default
```

With the `database` driver, the worker checks queues in the order you list them, so `high` is drained before `default`. The `redis` driver takes turns between the listed queues.

To keep slow work from blocking fast work, run a separate worker per queue:

```bash
npx holo queue:work --queue emails
npx holo queue:work --queue media
```

## Worker options

| Flag | Description |
| --- | --- |
| `--connection <name>`, `-c` | Connection to process. Defaults to `default` in `config/queue.ts`. |
| `--queue <names>`, `-q` | Queue names to process. Defaults to the connection's `queue`. |
| `--once` | Process one job, or check once if the queue is empty, then exit. |
| `--stop-when-empty` | Exit as soon as the queue is empty. |
| `--sleep N` | Seconds to wait before checking an empty queue again. Defaults to the connection's `sleep`, or `1`. |
| `--tries N` | Override every job's `tries`. |
| `--timeout N` | Override every job's `timeout`, in seconds. |
| `--max-jobs N` | Exit after handling N jobs, counting successes, retries, and failures. |
| `--max-time N` | Exit after running for N seconds. Checked between jobs. |

`--stop-when-empty` suits scheduled batch runs, such as a cron job that drains the queue and exits. `--max-jobs` and `--max-time` let your process manager restart workers regularly, which keeps memory use in check.

## Develop with queue:listen

`queue:listen` runs a worker and restarts it whenever you change your code:

```bash
npx holo queue:listen --queue default
```

It watches `config/`, `.env` files, your models, jobs, events, and listeners, and other source files. On a change it rescans your project and starts a fresh worker. It accepts the same flags as `queue:work`, except `--once` and `--stop-when-empty`.

Use `queue:listen` while developing and `queue:work` in production.

## Stop and restart workers

Press `Ctrl+C`, or send `SIGTERM` or `SIGINT`. The worker finishes the job it's running, then exits.

After you deploy new code, tell running workers to restart:

```bash
npx holo queue:restart
```

Each worker finishes its current job and then exits, so your process manager can start it again on the new code. Workers that start after the signal aren't affected.

::: warning Restart is per machine
`queue:restart` writes a signal file to `.holo-js/runtime/queue-restart.signal` in the project folder. Only workers running from that same folder see it. If workers run on other servers or in other containers, restart them through your deploy tooling instead.
:::

## Run workers in production

Run each worker under a process manager such as systemd, PM2, Docker, or your platform's worker service. It should:

- start the worker on boot
- restart it whenever it exits, including after a clean exit from `queue:restart`, `--max-jobs`, or `--max-time`
- stop it with `SIGTERM`, so the current job can finish

A minimal systemd unit:

```ini [/etc/systemd/system/holo-worker.service]
[Unit]
Description=Holo queue worker
After=network.target

[Service]
WorkingDirectory=/var/www/my-app
ExecStart=/usr/bin/npx holo queue:work --connection redis --max-time 3600
Restart=always
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
```

Run more copies of the service to process more jobs in parallel. See [Deploying Holo apps](/deployment/) for choosing a host that supports long-running processes.

## When a worker stops unexpectedly

If a worker crashes, is killed, or loses its connection while running a job, the job isn't lost. After at least the connection's `retryAfter` seconds, another worker picks it up and runs it again. You don't need to do anything.

The interrupted run counts as one of the job's `tries`. When a picked-up job has already used all of its tries, the worker doesn't run it again. It fails the job with the error `Queue job "<name>" has been attempted too many times.`, calls the job's `onFailed` hook, and saves it to the [failed jobs table](/queue/failed-jobs).

With the `redis` driver, a worker keeps renewing its hold on the job it's running, so a job that runs longer than `retryAfter` isn't handed to a second worker. The `database` driver doesn't renew, so keep each job's `timeout` shorter than `retryAfter`.

If a worker picks up a job whose name isn't registered, for example after you rename or delete a job file, it fails that job, saves it to the failed jobs table, and keeps processing the rest of the queue.

## Run workers from code

`runQueueWorker()` runs the same loop as `queue:work`, inside your own script. Use it for a custom worker process or a test.

```ts [scripts/work-emails.ts]
import { runQueueWorker } from '@holo-js/queue'

const result = await runQueueWorker({
  connection: 'redis',
  queueNames: ['emails'],
  stopWhenEmpty: true,
  onJobFailed(event) {
    console.error(event.jobName, event.error.message)
  },
})

console.log(result.processed, result.failed)
```

It returns a promise of `{ processed, released, failed, stoppedBecause }`. `stoppedBecause` is one of `'once'`, `'empty'`, `'max-jobs'`, `'max-time'`, or `'signal'`.

It accepts these options:

| Option | Description |
| --- | --- |
| `connection` | Connection to read from. Defaults to the default connection. |
| `queueNames` | Queue names to read, in order. Defaults to the connection's `queue`. |
| `once` | Process one job, or check once if the queue is empty, then return. |
| `stopWhenEmpty` | Return as soon as the queue is empty. |
| `sleep` | Seconds to wait between checks of an empty queue. Defaults to the connection's `sleep`, or `1`. |
| `tries` | Overrides every job's `tries`. |
| `timeout` | Overrides every job's `timeout`, in seconds. |
| `maxJobs` | Positive integer. Return after this many jobs are processed, released, or failed. |
| `maxTime` | Positive integer, in seconds. Return once the worker has run this long. Checked between jobs. |
| `workerId` | ID sent with each reservation. Defaults to a random UUID. |
| `shouldStop()` | Called before each reservation. Return `true` to stop with `stoppedBecause: 'signal'`. |
| `sleepFn(milliseconds)` | Replaces the wait used between checks of an empty queue. |
| `onJobProcessed(event)` | Called after a job succeeds. |
| `onJobReleased(event)` | Called after a job is released. The event also has `delaySeconds`, and `error` when the handler threw. |
| `onJobFailed(event)` | Called after a job fails for good. The event has `error`. |
| `onIdle()` | Called each time a reservation finds nothing. |

If `onJobProcessed`, `onJobReleased`, or `onJobFailed` throws, Holo logs a warning and the worker keeps going. The worker throws [`QueueWorkerUnsupportedDriverError`](/queue/jobs#queueworkerunsupporteddrivererror) when the connection uses the `sync` driver.

## Clear pending jobs

Delete jobs that are waiting to run:

```bash
npx holo queue:clear
npx holo queue:clear --connection redis --queue emails
```

`queue:clear` accepts `--connection` (`-c`) and `--queue` (`-q`) like `queue:work`. It deletes waiting jobs only. Jobs a worker is currently running are left alone, and [failed jobs](/queue/failed-jobs) are not touched.

## Clear and shut down from code

`clearQueueConnection(connectionName?, { queueNames? })` deletes waiting jobs, like `queue:clear`, and resolves to the number of jobs deleted. Omit the connection name to use the default connection.

```ts
import { clearQueueConnection } from '@holo-js/queue'

const deleted = await clearQueueConnection('redis', { queueNames: ['emails'] })
```

`shutdownQueueRuntime()` closes the driver connections your process opened, such as Redis clients, and clears the queue state. Call it before your script or process exits.

## Next steps

- [Failed jobs](/queue/failed-jobs)
- [Drivers and tables](/queue/drivers)
- [Production checklist](/deployment/checklist)
