# Dispatching Events

Dispatching an event runs its listeners. Call `dispatch()` on the event definition and `await` the result.

```ts [server/lib/users.ts]
import UserRegistered from '../events/user/registered'

await UserRegistered.dispatch({
  userId: 'user_1',
  email: 'ava@example.com',
})
```

TypeScript checks the payload against the event's type.

::: warning
Nothing runs until you `await` the dispatch (or call `.then()` or `.dispatch()` on it). Calling `UserRegistered.dispatch(payload)` without awaiting it does not run any listeners.
:::

## Other ways to dispatch

All three forms do the same thing and accept the same chained options.

### `dispatchEvent()`

A standalone function, handy when you have a name string or want to avoid confusion with queue job `dispatch()`:

```ts [server/lib/users.ts]
import { dispatchEvent } from '@holo-js/events'
import UserRegistered from '../events/user/registered'

await dispatchEvent(UserRegistered, {
  userId: 'user_1',
  email: 'ava@example.com',
})
```

### `Event.dispatch()`

The same function on the `Event` object:

```ts [server/lib/users.ts]
import { Event } from '@holo-js/events'
import UserRegistered from '../events/user/registered'

await Event.dispatch(UserRegistered, {
  userId: 'user_1',
  email: 'ava@example.com',
})
```

### Dispatch by name

Both `dispatchEvent()` and `Event.dispatch()` also accept the event name as a string:

```ts [server/lib/users.ts]
import { dispatchEvent } from '@holo-js/events'

await dispatchEvent('user.registered', {
  userId: 'user_1',
  email: 'ava@example.com',
})
```

Once Holo has generated types for your events, the payload for a known name is type-checked too. Dispatching a name that isn't registered throws `Event "<name>" is not registered.`

## Chained options

`dispatch()` returns a pending dispatch you can configure before awaiting:

```ts [server/lib/users.ts]
import UserRegistered from '../events/user/registered'

await UserRegistered.dispatch({
  userId: 'user_1',
  email: 'ava@example.com',
})
  .afterCommit()
  .onConnection('redis')
  .onQueue('emails')
  .delay(30)
```

| Method | Effect |
| --- | --- |
| `.afterCommit()` | Wait until the current database transaction commits before running any listener. See [After-Commit Events](/events/after-commit). |
| `.onConnection(name)` | Send queued listeners to this queue connection. |
| `.onQueue(name)` | Send queued listeners to this queue. |
| `.delay(value)` | Delay queued listeners. Pass seconds as a `number` or a `Date`. |
| `.dispatch()` | Run the dispatch and return a promise. Same as awaiting. |

`.onConnection()`, `.onQueue()`, and `.delay()` only affect [queued listeners](/events/queued-listeners). Sync listeners always run immediately. These values override the listener's own `connection`, `queueName`, and `delay`.

## What happens during a dispatch

1. Holo finds every listener registered for the event.
2. If any of those listeners is queued, it checks that the payload is JSON-serializable.
3. Listeners run one at a time, in registration order. Sync listeners run inline, and queued listeners are sent to the queue as jobs at their place in that order.

If a listener throws, or a queued listener can't be sent, the dispatch rejects with that error and listeners after it don't run. Dispatching an event with no listeners is fine; it does nothing.

A pending dispatch runs only once. Awaiting the same value twice returns the same result.

## The dispatch result

The awaited value tells you what happened:

```ts [server/lib/users.ts]
import UserRegistered from '../events/user/registered'

const result = await UserRegistered.dispatch({
  userId: 'user_1',
  email: 'ava@example.com',
})

console.log(result.syncListeners, result.queuedListeners)
```

| Field | Type | Description |
| --- | --- | --- |
| `eventName` | `string` | The dispatched event's name. |
| `occurredAt` | `number` | Dispatch time in milliseconds since the Unix epoch. |
| `deferred` | `boolean` | `true` if some or all listeners are waiting for a transaction to commit. |
| `syncListeners` | `number` | How many sync listeners ran or will run. |
| `queuedListeners` | `number` | How many queued listeners were or will be sent to the queue. |

## Next steps

- [Queued Listeners](/events/queued-listeners)
- [After-Commit Events](/events/after-commit)
- [API Reference](/events/api-reference)
