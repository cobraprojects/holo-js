# Events

Events let one part of your app announce that something happened, such as "a user registered", while other parts react to it. The code that dispatches the event doesn't need to know who is listening.

Use events when one action should trigger several independent side effects: send a welcome email, record analytics, refresh a search index.

## Quick example

Define an event:

```ts [server/events/user/registered.ts]
import { defineEvent } from '@holo-js/events'

export default defineEvent<{
  userId: string
  email: string
}>({
  name: 'user.registered',
})
```

Add a listener that reacts to it:

```ts [server/listeners/user/send-welcome-email.ts]
import { defineListener } from '@holo-js/events'
import UserRegistered from '../../events/user/registered'

export default defineListener({
  listensTo: [UserRegistered],
  async handle(event) {
    console.log(`Send a welcome email to ${event.payload.email}`)
  },
})
```

Dispatch the event from your app code:

```ts [server/lib/users.ts]
import UserRegistered from '../events/user/registered'

export async function registerUser(userId: string, email: string) {
  await UserRegistered.dispatch({ userId, email })
}
```

Every listener for `user.registered` runs when you `await` the dispatch. The payload is fully typed: passing a payload without `email` is a TypeScript error.

## Install events

New Holo projects can include events when you create them. To add events to an existing project, run:

```bash
npx holo install events
```

This adds the `@holo-js/events` package and creates the `server/events` and `server/listeners` folders.

In an interactive terminal, the installer also asks whether to enable queued listeners. Choosing **Enable queued listeners** installs [queue](/queue/) support with the `sync` driver, creating `config/queue.ts` and `server/jobs`. You can skip this and run `npx holo install queue` later.

## Where events and listeners live

Holo finds events and listeners automatically. Put them anywhere inside these folders, including subfolders:

| Folder | Contains |
| --- | --- |
| `server/events` | Event definitions (`defineEvent`) |
| `server/listeners` | Listener definitions (`defineListener`) |

```text
server/
  events/
    user/registered.ts
    billing/invoice-paid.ts
  listeners/
    user/send-welcome-email.ts
    billing/sync-invoice-state.ts
```

Each file exports one event or one listener, either as the default export or as a named export.

## Generate files with the CLI

Create an event file:

```bash
npx holo make:event user/registered
```

This writes `server/events/user/registered.ts` with the name `user.registered`.

Create a listener for that event:

```bash
npx holo make:listener user/send-welcome-email --event user.registered
```

The listener file imports the event for you. See [Listeners](/events/listeners) for listeners that handle several events.

## Discovery and generated types

When you run `npx holo dev` or `npx holo build`, Holo scans the event and listener folders and writes a registry plus TypeScript types under `.holo-js/generated`. Holo regenerates this folder; don't edit it.

The `make:event` and `make:listener` commands refresh discovery for you. If you add files by hand and want the types updated without starting the dev server, run:

```bash
npx holo prepare
```

## Events, listeners, and jobs

- An **event** is a signal that something happened. It carries a payload.
- A **listener** is code that runs when one or more events are dispatched.
- A **queued listener** is a listener that runs in a [queue worker](/queue/workers) instead of during the request.

If you just need to run one piece of background work, write a [queue job](/queue/jobs) instead. See [Choosing a Pattern](/events/choosing-patterns).

## Next steps

- [Defining Events](/events/defining-events)
- [Listeners](/events/listeners)
- [Dispatching Events](/events/dispatching)
- [Queued Listeners](/events/queued-listeners)
- [After-Commit Events](/events/after-commit)
