---
name: holo-testing-deployment
description: Test, configure, operate, and deploy Holo-JS applications, including drivers, workers, migrations, caches, queues, realtime, and CLI workflows.
metadata:
  type: focused
  source: https://docs.holo-js.com/testing
---

# Testing and deployment

Read [testing](https://docs.holo-js.com/testing), [configuration](https://docs.holo-js.com/getting-started/configuration), [database commands](https://docs.holo-js.com/reference/cli), [queue workers](https://docs.holo-js.com/queue/workers), [task scheduling](https://docs.holo-js.com/scheduling/), [broadcast deployment](https://docs.holo-js.com/broadcasting/production), and [deployment](https://docs.holo-js.com/deployment).

## Testing

- Test behavior through public Holo and adapter APIs.
- Use real local integrations at boundaries when deterministic; fake external transports such as mail, notifications, broadcast, and cloud storage.
- Assert concrete inferred types for schemas, models, scopes, relations, and adapter results.
- Cover validation failure, authorization denial, transaction rollback, retries, and cleanup when they are part of the feature.
- Do not assert source text or mock the subject under test.

## Deployment order

1. Validate typed configuration and required secrets without printing them.
2. Build the selected framework application and server runtime.
3. Apply migrations according to the documented release strategy.
4. Restart web, queue, scheduler, and realtime processes with compatible code and configuration.
5. Verify health, worker throughput, failed jobs, storage access, and broadcast connectivity.

## Scheduled tasks

- Declare recurring work in `server/schedule.ts` with `defineSchedule()` from `@holo-js/schedule`; do not add one system cron entry per task.
- Use `schedule.command('name args')` for Holo commands, `schedule.job(Job, payload)` for queued jobs, and `schedule.call(fn)` for functions, with Laravel frequency methods such as `daily()`, `dailyAt('02:00')`, `everyFiveMinutes()`, and `timezone()`.
- Run the scheduler with a single `* * * * * npx holo schedule:run` cron entry, or keep `holo schedule:work` running under a process manager. Check tasks with `holo schedule:list`.
- `withoutOverlapping()` and `onOneServer()` use cache locks, so configure a store every scheduler process shares (`file` on one machine, `redis` or `database` across servers), never `memory`.
- Scheduled command output is discarded; have commands report failures through their exit code and Holo error reporting.

## Operational boundaries

- Choose explicit production drivers for database, cache, queue, session, storage, mail, and broadcast.
- Keep workers and realtime servers observable and independently scalable.
- Treat migrations, queue payload changes, event payload changes, and cache key changes as rollout contracts.
- Use the Holo CLI commands documented for the installed release rather than ad hoc scripts.

## Completion check

- Tests prove user-visible behavior and important failure paths.
- Production services, drivers, secrets, migrations, workers, and health checks are accounted for.
- The release can roll forward safely without mixed-version contract failures.
