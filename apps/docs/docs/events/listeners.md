# Listeners

A listener is code that runs when an event is dispatched. One event can have many listeners, and one listener can handle many events.

## Create a listener

```bash
npx holo make:listener user/send-welcome-email --event user.registered
```

This creates `server/listeners/user/send-welcome-email.ts` and imports the event for you. Fill in `handle()`:

```ts [server/listeners/user/send-welcome-email.ts]
import { defineListener } from '@holo-js/events'
import UserRegistered from '../../events/user/registered'

export default defineListener({
  listensTo: [UserRegistered],
  async handle(event) {
    console.log(`Welcome, ${event.payload.email}`)
  },
})
```

The `--event` value must be the name of an event that already exists. Otherwise the command fails with `Unknown event`.

## The event object

`handle(event)` receives an object with three fields:

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | The event name, for example `'user.registered'`. |
| `payload` | your payload type | The data passed to `dispatch()`. |
| `occurredAt` | `number` | When the event was dispatched, in milliseconds since the Unix epoch. |

`event.payload` is typed from the event definition, so you get autocomplete for its fields.

## Referencing events

`listensTo` accepts event definitions, event name strings, or a mix:

```ts [server/listeners/audit/log-registration.ts]
import { defineListener } from '@holo-js/events'

export default defineListener({
  listensTo: ['user.registered'],
  async handle(event) {
    console.log(event.payload.userId)
  },
})
```

String names get typed payloads too, once Holo has generated types for your events (`npx holo dev`, `npx holo build`, or `npx holo prepare`). Importing the definition is still the clearest option.

For a single event, you can also pass the definition without an array: `listensTo: UserRegistered`.

## Listen to several events

Pass several events to `listensTo`, or pass `--event` more than once on the CLI:

```bash
npx holo make:listener audit/user-lifecycle --event user.registered --event user.deleted
```

```ts [server/listeners/audit/user-lifecycle.ts]
import { defineListener } from '@holo-js/events'
import UserRegistered from '../../events/user/registered'
import UserDeleted from '../../events/user/deleted'

export default defineListener({
  listensTo: [UserRegistered, UserDeleted] as const,
  async handle(event) {
    if (event.name === 'user.registered') {
      console.log('Registered', event.payload.email)
      return
    }

    console.log('Deleted', event.payload.userId)
  },
})
```

`event` is a union of the possible events. When each event is defined with a [literal name type](/events/defining-events#literal-name-types-for-multi-event-listeners), such as `defineEvent<{ userId: string }, 'user.deleted'>(...)`, checking `event.name` narrows `event.payload` to the matching shape. The example above relies on this.

`--event` also accepts a comma-separated list: `--event user.registered,user.deleted`.

## Listener names

By default, a listener's ID comes from its file path under `server/listeners`, joined with dots. `server/listeners/user/send-welcome-email.ts` becomes `user.send-welcome-email`.

Set `name` to give it an explicit ID that won't change when you move the file:

```ts [server/listeners/user/send-welcome-email.ts]
import { defineListener } from '@holo-js/events'
import UserRegistered from '../../events/user/registered'

export default defineListener({
  name: 'users.send-welcome-email',
  listensTo: [UserRegistered],
  async handle(event) {
    console.log(event.payload.email)
  },
})
```

The ID matters most for [queued listeners](/events/queued-listeners): the queued job stores it and looks the listener up when the job runs. Listener IDs must be unique.

## Order and errors

For each dispatch, Holo runs the listeners in registration order, one after another. Sync listeners run inline. Queued listeners are sent to the queue at their place in the order, so a queued listener registered between two sync listeners is sent after the first one runs and before the second one runs.

If a listener throws, or a queued listener can't be sent, the dispatch rejects with that error. Listeners after it don't run, including queued listeners that would have been sent. Listeners before it have already run.

Listeners with `afterCommit` are the exception: they run after the surrounding transaction commits, so they run after the immediate listeners. Registration order holds within each group, not across them. See [After-commit events](/events/after-commit).

## Listener options

| Option | Type | Description |
| --- | --- | --- |
| `listensTo` | event, string, or an array of them | Required. The events this listener handles. |
| `handle(event)` | function | Required. Runs for each matching event. Can be async. |
| `name` | `string` | Explicit listener ID. Defaults to the file path. |
| `queue` | `boolean` | Run in a queue worker. See [Queued Listeners](/events/queued-listeners). |
| `connection` | `string` | Queue connection. Requires `queue: true`. |
| `queueName` | `string` | Queue name. Requires `queue: true`. |
| `delay` | `number` or `Date` | Seconds to wait, or a time to run at. Requires `queue: true`. |
| `afterCommit` | `boolean` | Wait for the current database transaction to commit. See [After-Commit Events](/events/after-commit). |

Setting `connection`, `queueName`, or `delay` without `queue: true` throws `Listener queue metadata requires queue: true.`

## Next steps

- [Dispatching Events](/events/dispatching)
- [Queued Listeners](/events/queued-listeners)
- [After-Commit Events](/events/after-commit)
