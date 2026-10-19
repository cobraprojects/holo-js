# Queued Listeners

A queued listener runs in a [queue worker](/queue/workers) instead of during the request that dispatched the event. Use it for slow work, such as sending email or calling an external API, so your response isn't held up.

```ts [server/listeners/user/send-welcome-email.ts]
import { defineListener } from '@holo-js/events'
import UserRegistered from '../../events/user/registered'

export default defineListener({
  listensTo: [UserRegistered],
  queue: true,
  queueName: 'emails',
  async handle(event) {
    console.log(`Send a welcome email to ${event.payload.email}`)
  },
})
```

Dispatching the event works the same as for any listener. Holo sends this listener to the queue as a job, and a worker runs `handle()` later.

## Requirements

Queued listeners need [queue support](/queue/) in your project. If it isn't installed, run:

```bash
npx holo install queue
```

Without `@holo-js/queue` installed, Holo throws `Queued listeners require @holo-js/queue to be installed.` when it loads a queued listener.

With the `sync` queue driver, queued listeners run right away in the same process. That works for local development. With an async driver like `database` or `redis`, you must run a worker:

```bash
npx holo queue:work
```

See [Running Workers](/queue/workers) for production setup and [Drivers and Tables](/queue/drivers) for driver configuration.

## Choose the connection, queue, and delay

Set defaults on the listener:

```ts [server/listeners/billing/sync-invoice.ts]
import { defineListener } from '@holo-js/events'
import InvoicePaid from '../../events/billing/invoice-paid'

export default defineListener({
  listensTo: [InvoicePaid],
  queue: true,
  connection: 'redis',
  queueName: 'billing',
  delay: 30,
  async handle(event) {
    console.log(`Sync invoice ${event.payload.invoiceId}`)
  },
})
```

`delay` is a number of seconds, or a `Date` to run at.

`tries` and `backoff` retry a failing queued listener. `tries` is the total number of attempts, and it defaults to one. `backoff` is the wait before each retry, in seconds, or an array of waits per retry. Like the other queue options, they need `queue: true`.

```ts
defineListener({
  listensTo: [UserRegistered],
  queue: true,
  tries: 3,
  backoff: [10, 60],
  handle(event) {
    return sendWelcomeEmail(event.payload.userId)
  },
})
```

You can override these per dispatch:

```ts [server/lib/billing.ts]
import InvoicePaid from '../events/billing/invoice-paid'

await InvoicePaid.dispatch({ invoiceId: 'inv_1', amountCents: 4200 })
  .onConnection('database')
  .onQueue('priority')
  .delay(new Date(Date.now() + 60_000))
```

Holo picks each value in this order:

1. The dispatch option (`.onConnection()`, `.onQueue()`, `.delay()`).
2. The listener option (`connection`, `queueName`, `delay`).
3. The defaults in `config/queue.ts`.

Dispatch options apply to every queued listener of that dispatch. Sync listeners ignore them.

## Payloads must be JSON

A queued job is stored as JSON, so the event payload must be JSON-serializable whenever at least one queued listener is registered for the event. Holo checks this before running any listener and throws a `TypeError` that names the bad path, such as `Event payload at "payload.user" must be a plain JSON object, array, or primitive for queued listeners.`

Allowed: strings, finite numbers, booleans, `null`, arrays, and plain objects of these.

Not allowed: `undefined`, functions, symbols, `BigInt`, `NaN` or `Infinity`, class instances (including `Date` and model instances), and circular references.

::: tip
Send IDs instead of records. Load the record inside `handle()` so the listener sees current data. If the record is saved in a transaction, use [`afterCommit`](/events/after-commit) so the worker doesn't run before the row exists.
:::

## Retries and failures

A queued listener runs as a regular queue job named `holo.events.invoke-listener`. Everything about queue jobs applies:

- It gets one attempt by default. Raise this with `npx holo queue:work --tries 3`.
- When it fails for good, it shows up in `npx holo queue:failed` and you can retry it with the other [failed job commands](/queue/failed-jobs).

The job stores the listener's ID. If you rename or delete a listener while its jobs are still waiting in the queue, those jobs fail with `Queued listener "<id>" is not registered.` Give long-lived queued listeners an explicit [`name`](/events/listeners#listener-names) so moving the file doesn't change the ID.

## Next steps

- [After-Commit Events](/events/after-commit)
- [Running Workers](/queue/workers)
- [Failed Jobs](/queue/failed-jobs)
- [Choosing a Pattern](/events/choosing-patterns)
