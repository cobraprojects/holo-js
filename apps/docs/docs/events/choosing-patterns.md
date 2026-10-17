# Choosing a Pattern

Holo gives you several ways to run code in response to something in your app. This page helps you pick between a direct function call, an event with listeners, a queue job, and a notification.

## Quick guide

| You want to... | Use |
| --- | --- |
| Run one action that the caller depends on | A direct function call |
| Announce that something happened and let several parts of the app react | An [event](/events/) with [listeners](/events/listeners) |
| React to an event without slowing down the request | A [queued listener](/events/queued-listeners) |
| Run one specific piece of background work | A [queue job](/queue/jobs) |
| Tell a user something by email, database, or another channel | A [notification](/notifications/) |

## Direct function calls

Call a function directly when the caller needs the result, or when there is only ever one thing to do. Direct calls are the easiest to read and debug. Don't add an event just to call one function.

## Events with sync listeners

Use an event when one action has several independent reactions, and the code that triggers it shouldn't know about each one. For example, `user.registered` might trigger an audit log entry, a welcome email, and an analytics call. You can add a fourth reaction later without touching the registration code.

Sync listeners run during the dispatch, in order. Use them for quick work that should finish before the request responds. A sync listener that throws makes the dispatch throw.

## Queued listeners

Use a queued listener when the reaction is slow, calls an external service, or should survive a crash and be retried. Good fits are welcome emails, analytics fan-out, and updating search indexes.

You keep the event's "one signal, many reactions" structure, and each slow reaction runs in a worker.

## Queue jobs

Use a [queue job](/queue/jobs) when the work itself is the point, not a reaction to something that happened. For example: generating a nightly report, processing an uploaded video, or cleaning up expired records.

Jobs have their own typed payload and their own retry settings. A listener can dispatch a job, which is a good way to reuse the same background work from several places.

## Notifications

Use a [notification](/notifications/) when the goal is to tell a person something, possibly through several channels like email and the database. Notifications handle choosing channels and formatting the message, and they can be [queued](/notifications/queueing) too.

A common setup is to dispatch an event, then send a notification from one of its listeners.

## Next steps

- [Events](/events/)
- [Queued Listeners](/events/queued-listeners)
- [Writing Jobs](/queue/jobs)
- [Notifications](/notifications/)
