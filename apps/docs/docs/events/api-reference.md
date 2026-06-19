# API Reference

## `defineEvent(...)`

Define an event contract.

```ts
import { defineEvent } from '@holo-js/events'

export default defineEvent<{ userId: string }>({
  name: 'user.registered',
})
```

Key points:

- `name` is optional in code, but recommended
- discovered app events can fall back to path-derived names
- payload type is inferred from the generic
- `dispatch(payload)` dispatches the event with the same payload type

## `defineListener(...)`

Define a listener for one or many events.

```ts
import { defineListener } from '@holo-js/events'
import UserRegistered from '../events/user/registered'

export default defineListener({
  listensTo: [UserRegistered],
  queue: true,
  queueName: 'emails',
  afterCommit: true,
  async handle(event) {
    await mailer.sendWelcome(event.payload.email)
  },
})
```

Options:

- `name`
- `listensTo`
- `queue`
- `connection`
- `queueName`
- `delay`
- `afterCommit`
- `handle(event)`

## Event definition dispatch

Primary dispatch API:

```ts
import UserRegistered from '../events/user/registered'

await UserRegistered.dispatch({
  userId: 'user_1',
  email: 'ava@example.com',
})
```

Event definition dispatch returns a pending dispatch builder.

## `Event`

Facade API:

```ts
import { Event } from '@holo-js/events'
import UserRegistered from '../events/user/registered'

await Event.dispatch(UserRegistered, {
  userId: 'user_1',
  email: 'ava@example.com',
})
```

`Event.dispatch(...)` returns a pending dispatch builder.

## `dispatchEvent(...)`

Helper API with the same semantics:

```ts
import { dispatchEvent } from '@holo-js/events'
import UserRegistered from '../events/user/registered'

await dispatchEvent(UserRegistered, {
  userId: 'user_1',
  email: 'ava@example.com',
})
```

This helper avoids naming conflicts with queue `dispatch(...)`.

## Pending dispatch fluent methods

Available on event definition dispatch, `Event.dispatch(...)`, and `dispatchEvent(...)`:

- `.afterCommit()`
- `.onConnection(name)`
- `.onQueue(name)`
- `.delay(number | Date)`

`await` the pending value directly. No extra execute call is needed.

## Dispatch result

Resolved value includes:

- `eventName`
- `occurredAt`
- `deferred`
- `syncListeners`
- `queuedListeners`

## Continue

- [Dispatching Events](/events/dispatching-events)
- [Queued Listeners](/events/queued-listeners)
