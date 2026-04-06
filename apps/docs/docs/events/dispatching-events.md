# Dispatching Events

Use the `Event` facade or `dispatchEvent(...)` helper.

## Primary API: `Event.dispatch(...)`

```ts
import { Event } from '@holo-js/events'
import UserRegistered from '../events/user/registered'

await Event.dispatch(UserRegistered, {
  userId: 'user_1',
  email: 'ava@example.com',
})
```

## Helper API: `dispatchEvent(...)`

```ts
import { dispatchEvent } from '@holo-js/events'
import UserRegistered from '../events/user/registered'

await dispatchEvent(UserRegistered, {
  userId: 'user_1',
  email: 'ava@example.com',
})
```

`dispatchEvent(...)` is the conflict-free helper name. `@holo-js/events` does not use top-level
`dispatch(...)` as the primary API.

## Fluent controls

Dispatch returns a pending builder:

```ts
await Event.dispatch(UserRegistered, {
  userId: 'user_1',
  email: 'ava@example.com',
})
  .afterCommit()
  .onConnection('redis')
  .onQueue('emails')
  .delay(30)
```

Available methods:

- `.afterCommit()`
- `.onConnection(name)`
- `.onQueue(name)`
- `.delay(value)` where value is seconds (`number`) or a `Date`

`await` the pending value directly. No extra execute call is needed.

## Dispatch result

Resolved value includes:

- `eventName`
- `occurredAt`
- `deferred`
- `syncListeners`
- `queuedListeners`

## Dispatch behavior

- sync listeners run inline in registration order
- queued listeners are enqueued and do not block listener completion on async queue drivers
- if a sync listener throws, dispatch rejects and queued fan-out is not performed for that dispatch

## Continue

- [Queued Listeners](/events/queued-listeners)
- [Transactions And After Commit](/events/transactions-after-commit)
