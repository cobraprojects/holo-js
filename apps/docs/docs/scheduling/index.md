# Task Scheduling

The scheduler runs commands, jobs, and functions on a timetable that lives in your code. You declare every task in one file, and a single system cron entry, or one long-running process, runs whatever is due each minute. It works like Laravel's scheduler.

## Install

```bash
npx holo install schedule
```

The installer adds `@holo-js/schedule` at your project's Holo version, creates a `server/schedule.ts` with no tasks if your app has no schedule file, and installs dependencies.

`withoutOverlapping()` and `onOneServer()` also need [`@holo-js/cache`](/cache/), so run `npx holo install cache` before you use them. Scheduling a job needs [`@holo-js/queue`](/queue/), which `npx holo install queue` adds. The installer reminds you of both when they're missing.

## Define tasks

Declare tasks in `server/schedule.ts`. Holo finds the file on its own.

```ts
import { defineSchedule } from '@holo-js/schedule'
import SendDigest from './jobs/send-digest'

export default defineSchedule((schedule) => {
  schedule.command('privacy:maintain').daily().withoutOverlapping().onOneServer()
  schedule.job(SendDigest, { userId: 1 }).everyFiveMinutes()
  schedule.call(async () => {
    // ...
  }).hourly()
})
```

A task with no frequency runs every minute.

The function you pass to `defineSchedule()` runs when `schedule:run` or `schedule:list` reads the schedule, after your app's configuration has loaded, so it can call `config()`.

### Commands

`schedule.command()` runs a [Holo command](/reference/custom-commands) in its own process, as if you typed `npx holo` followed by the string. Pass arguments and flags in the same string. The string is split into arguments the way a shell splits words, with single quotes, double quotes, and backslash escapes, but no shell runs it, so `$VAR`, `;`, and `|` are passed through as plain text:

```ts
schedule.command('reports:send --format csv').weekly()
schedule.command('backup:run --label="nightly backup"').dailyAt('02:00')
```

A command that exits with a non-zero code counts as failed. Its output is discarded, as Laravel discards a scheduled command's output by default.

### Jobs

`schedule.job()` dispatches a [job](/queue/jobs) with a payload, the same as calling `SendDigest.dispatch(payload)`. The payload is typed from the job, and the job is queued on its own connection and queue.

```ts
schedule.job(SendDigest, { userId: 1 }).everyFiveMinutes()
```

### Functions

`schedule.call()` runs a function inside the scheduler process. It can use models, the cache, and anything else your app's server code uses. A function that throws or returns `false` counts as failed, as in Laravel.

```ts
import Session from './models/session'

schedule.call(async () => {
  await Session.where('expires_at', '<', new Date()).delete()
}).hourly()
```

### Names

`name()` sets the name `schedule:run` and `schedule:list` show for a task:

```ts
schedule.call(pruneSessions).name('prune-sessions').hourly()
```

Names are optional. A command is shown as `holo <command>`, a job by its job name, and a function as `Closure`. A job object Holo didn't discover has no job name, so it's shown as `Job` and needs `name()` before it can use `withoutOverlapping()` or `onOneServer()`.

## Frequencies

| Method | Runs |
| --- | --- |
| `cron('* * * * *')` | On a custom cron expression |
| `everyMinute()` | Every minute |
| `everyTwoMinutes()` | Every two minutes |
| `everyThreeMinutes()` | Every three minutes |
| `everyFourMinutes()` | Every four minutes |
| `everyFiveMinutes()` | Every five minutes |
| `everyTenMinutes()` | Every ten minutes |
| `everyFifteenMinutes()` | Every fifteen minutes |
| `everyThirtyMinutes()` | Every thirty minutes |
| `hourly()` | Every hour, on the hour |
| `hourlyAt(17)` | Every hour at 17 minutes past. Pass an array for several minutes |
| `everyOddHour(minutes)` | Every odd hour |
| `everyTwoHours(minutes)` | Every two hours |
| `everyThreeHours(minutes)` | Every three hours |
| `everyFourHours(minutes)` | Every four hours |
| `everySixHours(minutes)` | Every six hours |
| `daily()` | Every day at midnight |
| `dailyAt('13:00')` | Every day at 13:00. `at('13:00')` is the same |
| `twiceDaily(1, 13)` | Every day at 1:00 and 13:00 |
| `twiceDailyAt(1, 13, 15)` | Every day at 1:15 and 13:15 |
| `weekly()` | Every Sunday at midnight |
| `weeklyOn(1, '8:00')` | Every Monday at 8:00 |
| `monthly()` | On the first day of every month at midnight |
| `monthlyOn(4, '15:00')` | On the 4th of every month at 15:00 |
| `twiceMonthly(1, 16, '13:00')` | On the 1st and 16th of every month at 13:00 |
| `quarterly()` | On the first day of every quarter at midnight |
| `quarterlyOn(4, '14:00')` | On the 4th day of every quarter at 14:00 |
| `yearly()` | On January 1st at midnight |
| `yearlyOn(6, 1, '17:00')` | On June 1st at 17:00 |

Day methods narrow a frequency to certain days of the week. Days are numbered from `0` (Sunday) to `6` (Saturday):

| Method | Limits the task to |
| --- | --- |
| `weekdays()` | Monday to Friday |
| `weekends()` | Saturday and Sunday |
| `mondays()` … `sundays()` | That day |
| `days(0, 3)` | The listed days |

Each method sets its own fields of the cron expression and keeps the rest, as Laravel's do, so you can combine them:

```ts
schedule.command('reports:send').weekdays().hourly()     // 0 * * * 1-5
schedule.command('reports:send').hourly().weekdays()     // 0 * * * 1-5
```

`cron()` accepts the five standard fields with `*`, lists, ranges, steps, and month and day names (`JAN`, `MON`), plus `@hourly`, `@daily`, `@weekly`, `@monthly`, and `@yearly`, which frequency methods can follow. Like Laravel, it also accepts:

| Syntax | Field | Means |
| --- | --- | --- |
| `L` | Day of month | The last day of the month |
| `15W` | Day of month | The weekday nearest the 15th, within the same month |
| `5L` | Day of week | The last Friday of the month |
| `1#2` | Day of week | The second Monday of the month |

Holo reads cron expressions with the same rules as the library Laravel uses, including its quirks:

- A named `SUN` at the end of a day-of-week range doesn't include Sunday: `FRI-SUN` runs on Friday and Saturday. Write `5-0` or `5-7` to include Sunday.
- Names in a range with a step read as `0`: `MON-FRI/2` runs only on Sundays. Use numbers, such as `1-5/2`.
- `LW` and a `W` day past the end of a month, such as `31W` in November, pick a day from the month before or after.

When both the day-of-month and day-of-week fields are restricted, a day that matches either one is due. An invalid expression, time, or timezone throws when `schedule:run` or `schedule:list` reads the schedule.

## Timezones

Tasks run in your app's timezone, `timezone` in `config/app.ts`. Set a different one for a task with `timezone()`:

```ts
schedule.command('reports:send').dailyAt('09:00').timezone('America/New_York')
```

Around a daylight saving change, Holo follows Laravel. When clocks spring forward, a task set for a time that doesn't exist that day runs an hour later, in the first hour after the change. When clocks fall back, a task in the repeated hour runs twice, and a task in the hour after it also runs during the repeated hour. Prefer UTC for tasks where that matters.

## Prevent overlaps

By default a task runs every time it's due, even if its previous run hasn't finished. `withoutOverlapping()` skips a run while the previous one is still going:

```ts
schedule.command('privacy:maintain').everyFiveMinutes().withoutOverlapping()
```

The scheduler holds a [cache lock](/cache/locks) while the task runs and releases it when the task ends, whether it succeeded or failed. The lock expires after 24 hours, in case the process running the task is killed. Pass a different lifetime in minutes:

```ts
schedule.command('privacy:maintain').everyFiveMinutes().withoutOverlapping(10)
```

Each `schedule:run` is a new process, so the lock needs a cache store that processes share: `file`, `redis`, or `database`. The `memory` store locks within one process only, so it can't stop an overlap.

## Run on one server

If more than one server runs the scheduler, every server runs every due task. `onOneServer()` lets only the first server to reach a task run it for that minute:

```ts
schedule.command('privacy:maintain').daily().onOneServer()
```

All servers must share the cache store, so use the `redis` or `database` cache driver. See [Which processes a lock covers](/cache/locks#which-processes-a-lock-covers).

Tasks are told apart by their command and frequency, their job name, or, for a function, its name. A function without a name is identified by its code and frequency, so two servers running the same `server/schedule.ts` agree on it.

## Run the scheduler

### With cron

Add one cron entry on the server that runs `schedule:run` every minute:

```bash
* * * * * cd /path-to-your-app && npx holo schedule:run >> /dev/null 2>&1
```

`schedule:run` checks every task once, runs the ones that are due one after another, and exits. A failing task is printed and sent to your app's [error reporter](/basics/errors#reporting-errors) with capability `schedule` and operation `task`, and the rest still run. `schedule:run` waits for an `async` reporter to finish before it closes the app's connections.

### Without cron

`schedule:work` stays in the foreground and starts `schedule:run` at the start of every minute. Use it locally, or in production under a process manager such as systemd, PM2, or a container that restarts it:

```bash
npx holo schedule:work
```

If a run takes longer than a minute, the next one still starts on time, and they run side by side. A `schedule:run` that fails doesn't stop it, but if `schedule:run` can't be started at all, `schedule:work` stops the runs still going and exits with the error, as Laravel's does. `Ctrl+C`, `SIGINT`, and `SIGTERM` stop it: it passes the signal to any `schedule:run` still running and exits once they have.

`schedule:run` itself handles `SIGINT` and `SIGTERM` the same way: it passes the signal to the command it is running, starts no more tasks, and exits once that command has. A function already running finishes first.

## List tasks

```bash
npx holo schedule:list
```

```text
0 0 * * *    holo privacy:maintain  Next Due: 2026-11-03 00:00:00 UTC
*/5 * * * *  send-digest            Next Due: 2026-11-02 12:05:00 UTC
```

Times are shown in your app's timezone.

## Differences from Laravel

- `schedule.job()` takes the job and its payload, `schedule.job(SendDigest, { userId: 1 })`, where Laravel takes a job instance.
- A function without a `name()` can use `withoutOverlapping()` and `onOneServer()`. Laravel requires a name first.
- `schedule:work` and `schedule:run` pass `SIGINT` and `SIGTERM` on to the processes they started and wait for them to exit.
- Holo doesn't yet have sub-minute frequencies, `between()`, `when()`, `skip()`, `environments()`, `runInBackground()`, output options such as `sendOutputTo()`, or before and after hooks.
