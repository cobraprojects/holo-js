# Events

Holo-JS events are domain signals. They let one code path announce that something happened while other code
subscribes through listeners.

Use events when you want fan-out orchestration with clear boundaries between producer and side effects.

## What events own

The `@holo-js/events` package owns:

- event definitions (`defineEvent(...)`)
- listener definitions (`defineListener(...)`)
- event dispatch (`Event.dispatch(...)`, `dispatchEvent(...)`)
- listener fan-out (sync and queued listeners)
- dispatch-level and listener-level `afterCommit` behavior

Events do not replace queue jobs. Queued listeners are implemented through queue.

## Events vs jobs

- event: "something happened" signal
- listener: reaction to one or more events
- queue job: executable work unit

Queued listeners become queue jobs internally, but users still author listeners, not event-specific jobs.

## Quick start

```ts
import { defineEvent, defineListener, Event } from '@holo-js/events'

export const UserRegistered = defineEvent<{
  userId: string
  email: string
}>({
  name: 'user.registered',
})

export const SendWelcomeEmail = defineListener({
  listensTo: [UserRegistered],
  queue: true,
  queueName: 'emails',
  afterCommit: true,
  async handle(event) {
    await mailer.sendWelcome(event.payload.email)
  },
})

await Event.dispatch(UserRegistered, {
  userId: 'user_1',
  email: 'ava@example.com',
}).afterCommit()
```

## Package boundaries

- `@holo-js/events` owns event/listener contracts and dispatch orchestration.
- `@holo-js/queue` owns queue runtime and worker behavior.
- `@holo-js/db` owns transaction lifecycle and commit hooks.
- `@holo-js/core` owns runtime boot registration for discovered events and listeners.
- CLI owns scaffolding commands.

## Continue

- [Defining Events](/events/defining-events)
- [Defining Listeners](/events/defining-listeners)
- [Dispatching Events](/events/dispatching-events)
- [Queued Listeners](/events/queued-listeners)
- [Transactions And After Commit](/events/transactions-after-commit)
- [API Reference](/events/api-reference)
