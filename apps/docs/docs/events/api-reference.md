# Events API Reference

Everything on this page is imported from `@holo-js/events`.

## Available methods

Every function, method, and option you can use in app code, grouped by task. Each item links to its own entry below.

**Define**

- [`defineEvent()`](#defineevent)
- [`defineListener()`](#definelistener)
- [`definition.dispatch()`](#definition-dispatch)

**Listener options**

<div class="method-list">

- [`listensTo`](#listensto)
- [`handle()`](#handle)
- [`name`](#listener-name)
- [`queue`](#queue)
- [`connection`](#connection)
- [`queueName`](#queuename)
- [`delay`](#delay)
- [`afterCommit`](#aftercommit)

</div>

**Dispatch**

- [`dispatchEvent()`](#dispatchevent)
- [`Event.dispatch()`](#event-dispatch)

**Pending dispatch**

<div class="method-list">

- [`.afterCommit()`](#pending-aftercommit)
- [`.onConnection()`](#pending-onconnection)
- [`.onQueue()`](#pending-onqueue)
- [`.delay()`](#pending-delay)
- [`.dispatch()`](#pending-dispatch-method)
- [`.then()`, `.catch()`, `.finally()`](#pending-then-catch-finally)

</div>

**Registry lookups**

- [`getRegisteredEvent()`](#getregisteredevent)
- [`listRegisteredEvents()`](#listregisteredevents)
- [`getRegisteredListener()`](#getregisteredlistener)
- [`listRegisteredListeners()`](#listregisteredlisteners)
- [`listRegisteredListenersForEvent()`](#listregisteredlistenersforevent)

**Results and types**

- [`EventDispatchResult`](#eventdispatchresult)
- [`EventEnvelope`](#eventenvelope)
- [Useful types](#useful-types)

**Errors and CLI**

- [Common errors](#common-errors)
- [CLI commands](#cli-commands)

## Define

### `defineEvent()` {#defineevent}

```ts
defineEvent<TPayload, TName extends string | undefined = string | undefined>(
  event: { name?: TName },
): DefinedEventDefinition<TPayload, TName>
```

Defines an event. `TPayload` is the payload type. `TName` is optional; pass the event name as a literal to get `event.name` narrowing in multi-event listeners.

```ts [server/events/user/registered.ts]
import { defineEvent } from '@holo-js/events'

export default defineEvent<{ userId: string, email: string }, 'user.registered'>({
  name: 'user.registered',
})
```

The only option is `name`, a `string`. It's recommended. If you leave it out, Holo derives the name from the file path under `server/events`.

### `defineListener()` {#definelistener}

```ts
defineListener(listener: ListenerDefinitionInput): ListenerDefinition
```

Defines a listener for one or more events. The options are listed under [Listener options](#listener-options).

```ts [server/listeners/user/send-welcome-email.ts]
import { defineListener } from '@holo-js/events'
import UserRegistered from '../../events/user/registered'

export default defineListener({
  listensTo: [UserRegistered],
  queue: true,
  queueName: 'emails',
  afterCommit: true,
  async handle(event) {
    console.log(event.payload.email)
  },
})
```

### `definition.dispatch()` {#definition-dispatch}

Every event from `defineEvent()` has a `dispatch(payload)` method. It returns a [pending dispatch](#pending-dispatch) and requires the event to have an explicit `name`.

```ts [server/lib/users.ts]
import UserRegistered from '../events/user/registered'

await UserRegistered.dispatch({ userId: 'user_1', email: 'ava@example.com' })
```

## Listener options

Pass these to `defineListener()`. Options marked "requires `queue: true`" throw an error on a sync listener.

### `listensTo` {#listensto}

Required. The event, or array of events, this listener handles. Each item is an event definition or an event name string. It must have at least one entry.

### `handle()` {#handle}

Required. `handle(event)` runs for each matching event. It receives an [`EventEnvelope`](#eventenvelope) and can be `async`.

### `name` {#listener-name}

Optional `string`. The listener's ID. [`getRegisteredListener()`](#getregisteredlistener) looks it up by this value. If you leave it out, Holo derives an ID from the file path under `server/listeners`, joined with dots.

### `queue` {#queue}

Optional `boolean`. When `true`, the listener runs in a queue worker instead of inline during the dispatch. The payload must be JSON-safe. See [Queued listeners](/events/queued-listeners).

### `connection` {#connection}

Optional `string`. The queue connection for this listener. Requires `queue: true`. A `.onConnection()` call on a dispatch overrides it.

### `queueName` {#queuename}

Optional `string`. The queue name for this listener. Requires `queue: true`. A `.onQueue()` call on a dispatch overrides it.

### `delay` {#delay}

Optional. Seconds to wait before the queued listener runs, as a number of zero or more, or a `Date` to run at. Requires `queue: true`. A `.delay()` call on a dispatch overrides it.

### `afterCommit` {#aftercommit}

Optional `boolean`. When `true`, the listener runs after the current database transaction commits. See [After-commit events](/events/after-commit).

## Dispatch

### `dispatchEvent()` {#dispatchevent}

```ts
dispatchEvent(event: EventDefinition | string, payload): EventPendingDispatch
```

Dispatches an event by definition or by name. With a registered name, the payload is typed from Holo's generated event types.

```ts [server/lib/users.ts]
import { dispatchEvent } from '@holo-js/events'

await dispatchEvent('user.registered', { userId: 'user_1', email: 'ava@example.com' })
```

### `Event.dispatch()` {#event-dispatch}

`Event` is an object with one method, `dispatch()`. It is the same function as `dispatchEvent()`.

```ts [server/lib/users.ts]
import { Event } from '@holo-js/events'
import UserRegistered from '../events/user/registered'

await Event.dispatch(UserRegistered, { userId: 'user_1', email: 'ava@example.com' })
```

## Pending dispatch

Every dispatch form returns an `EventPendingDispatch`. Nothing runs until you `await` it or call `.dispatch()`, `.then()`, `.catch()`, or `.finally()`. It runs at most once. Chain methods return a new pending dispatch, so they can be combined in any order.

### `.afterCommit()` {#pending-aftercommit}

Defers every listener for this dispatch, sync and queued, until the current transaction commits. See [After-commit events](/events/after-commit).

### `.onConnection(name)` {#pending-onconnection}

Sends the queued listeners of this dispatch to another queue connection. It overrides each listener's `connection`. Sync listeners are not affected.

### `.onQueue(name)` {#pending-onqueue}

Sends the queued listeners of this dispatch to another queue name. It overrides each listener's `queueName`.

### `.delay(value)` {#pending-delay}

Delays the queued listeners of this dispatch, in seconds or until a `Date`. It overrides each listener's `delay`. An invalid value throws when you call `.delay()`.

### `.dispatch()` {#pending-dispatch-method}

Runs the dispatch and returns a promise of [`EventDispatchResult`](#eventdispatchresult).

### `.then()`, `.catch()`, `.finally()` {#pending-then-catch-finally}

The standard promise methods. `await` and these methods all start the dispatch.

## Registry lookups

These read the events and listeners that Holo discovered. They are read-only.

### `getRegisteredEvent()` {#getregisteredevent}

```ts
getRegisteredEvent(name: string): RegisteredEvent | undefined
```

Returns the registered event with this name, or `undefined`.

### `listRegisteredEvents()` {#listregisteredevents}

```ts
listRegisteredEvents(): readonly RegisteredEvent[]
```

Returns every registered event, sorted by name.

### `getRegisteredListener()` {#getregisteredlistener}

```ts
getRegisteredListener(id: string): RegisteredListener | undefined
```

Returns the registered listener with this ID, or `undefined`.

### `listRegisteredListeners()` {#listregisteredlisteners}

```ts
listRegisteredListeners(): readonly RegisteredListener[]
```

Returns every registered listener, sorted by ID.

### `listRegisteredListenersForEvent()` {#listregisteredlistenersforevent}

```ts
listRegisteredListenersForEvent(eventName: string): readonly RegisteredListener[]
```

Returns the listeners for one event, in the order they were registered. A dispatch runs them in this order.

## Results and types

### `EventDispatchResult` {#eventdispatchresult}

The value a dispatch resolves to.

| Field | Type | Description |
| --- | --- | --- |
| `eventName` | `string` | The dispatched event name. |
| `occurredAt` | `number` | Dispatch time in milliseconds since the Unix epoch. |
| `deferred` | `boolean` | `true` if any listener is waiting for a commit. |
| `syncListeners` | `number` | Number of sync listeners for this dispatch. |
| `queuedListeners` | `number` | Number of queued listeners for this dispatch. |

### `EventEnvelope` {#eventenvelope}

The object passed to a listener's `handle()`.

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` (or the literal name) | The event name. |
| `payload` | `TPayload` | The dispatched payload. |
| `occurredAt` | `number` | Dispatch time in milliseconds since the Unix epoch. |

### Useful types {#useful-types}

| Type | Description |
| --- | --- |
| `EventPayloadFor<'user.registered'>` | The payload type of a registered event, by name. |
| `ListenerHandledEvent<typeof UserRegistered>` | The `event` argument type for a listener of that event. |
| `EventDelayValue` | `number \| Date`. |

```ts [server/lib/users.ts]
import { type EventPayloadFor } from '@holo-js/events'

type RegisteredPayload = EventPayloadFor<'user.registered'>
```

## Common errors {#common-errors}

| Message | Cause |
| --- | --- |
| `Event "<name>" is not registered.` | The event file isn't in `server/events`, or discovery hasn't run since you added it. |
| `Dispatching an event definition requires an explicit event name.` | The event has no `name`. Add one. |
| `Listener queue metadata requires queue: true.` | `connection`, `queueName`, or `delay` set on a sync listener. |
| `Listeners must listen to at least one event.` | `listensTo` is an empty array. |
| `Event payload at "<path>" must be JSON-serializable for queued listeners.` | A queued listener exists and the payload contains a non-JSON value. |
| `Queued listeners require @holo-js/queue to be installed.` | A listener has `queue: true` but queue support isn't installed. |

## CLI commands {#cli-commands}

| Command | Description |
| --- | --- |
| `npx holo install events` | Add events to an existing project. |
| `npx holo make:event <name>` | Create an event in `server/events`. `user/registered` creates `user.registered`. |
| `npx holo make:listener <name> --event <event-name>` | Create a listener. Repeat `--event`, or separate names with commas, to listen to several events. |
| `npx holo prepare` | Refresh discovered events, listeners, and generated types. |

## Related

- [Defining Events](/events/defining-events)
- [Listeners](/events/listeners)
- [Dispatching Events](/events/dispatching)
- [CLI Commands](/reference/cli)
