# Queueing Notifications

Queue notifications so the request that triggers them responds right away. A background worker then sends the email, writes the inbox row, or broadcasts the event.

```ts
import { notify } from '@holo-js/notifications'
import commentPosted from '../notifications/comment-posted'

await notify(recipient, commentPosted).onQueue('notifications')
```

## Before you start

Queued notifications run through [Holo queues](/queue/):

```bash
npx holo install queue
```

Without `@holo-js/queue`, queueing or delaying a notification throws `Queued or delayed notifications require @holo-js/queue to be installed`.

With the `sync` queue driver, queued notifications still run immediately in the same process. With an async driver, run a worker for the connection and queue you use:

```bash
npx holo queue:work --connection redis --queue notifications
```

Holo registers the notification delivery job for you. See [Running workers](/queue/workers).

## Queue one send

Any of these queue the notification:

```ts
await notify(recipient, commentPosted).onQueue('notifications')
await notify(recipient, commentPosted).onConnection('redis')
await notify(recipient, commentPosted).delay(300)
```

Holo queues one job per recipient per channel, so a slow email doesn't hold up the inbox row.

## Delay some channels

`.delay()` delays every channel. `.delayFor()` delays just one, and wins over `.delay()` for that channel:

```ts
await notify(recipient, trialEnding)
  .delayFor('email', 60 * 60)

await notify(recipient, trialEnding)
  .delay(new Date('2026-12-01T09:00:00Z'))
```

Delays are in seconds or a `Date`. A delayed channel is always queued, while channels without a delay are sent right away.

## Queue a notification every time

Set `queue` in the definition:

```ts
export default defineNotification({
  type: 'weekly-summary',
  via(recipient: { readonly id: string, readonly type: string, readonly email: string }) {
    return ['email', 'database']
  },
  queue: { connection: 'redis', queue: 'notifications', afterCommit: true },
  build: {
    email() {
      return { subject: 'Your weekly summary' }
    },
    database() {
      return { data: { summary: 'weekly' } }
    },
  },
})
```

`queue` accepts:

- `true`: queue on the default connection and queue.
- An object with `connection`, `queue`, `delay`, `afterCommit`, `tries`, and `backoff`.
- A function `(recipient, channel, context) => boolean | options`, to decide per channel:

```ts
queue(recipient, channel) {
  return channel === 'email' ? { queue: 'mail' } : false
},
```

`delay` in the definition accepts seconds, a `Date`, a per-channel object such as `{ email: 300 }`, or a function `(recipient, channel, context) => seconds | Date | undefined`.

## Defaults in config

`queue` in `config/notifications.ts` fills in the connection, queue, and `afterCommit` for notifications that are already queued. It doesn't queue anything by itself:

```ts [config/notifications.ts]
import { defineNotificationsConfig } from '@holo-js/notifications'

export default defineNotificationsConfig({
  queue: {
    connection: 'redis',
    queue: 'notifications',
    afterCommit: true,
  },
})
```

## Which setting wins

For each channel:

- **Delay:** `.delayFor()`, then `.delay()`, then the definition's `delay`, then `delay` inside the definition's `queue`.
- **Connection and queue:** `.onConnection()` / `.onQueue()`, then the definition's `queue`, then `config/notifications.ts`.
- **After commit:** `.afterCommit()`, then the definition's `queue`, then `config/notifications.ts` (for queued channels only).

## Wait for a transaction

`.afterCommit()` holds the whole notification until the current [transaction](/database/transactions) commits. If the transaction rolls back, nothing is sent or queued. Outside a transaction, it sends right away.

```ts
await DB.transaction(async () => {
  const comment = await createComment(input)

  await notify(recipientFor(comment), commentPosted).afterCommit()
})
```

While waiting, the result has `deferred: true` and each channel is marked `deferred`.

## What the worker receives

Holo runs `via()` and the builders when you call `notify()`, then stores the built message, the route, and a JSON copy of the recipient in the job. The worker sends what was stored; it doesn't call your notification again. Changes to a notification file only affect jobs queued after the deploy.

::: warning
Because the recipient is stored as JSON, methods like `routeNotificationFor()` and values like `Date` objects don't survive into the job. Routes are resolved before queueing, so delivery still works, but a custom channel that reads `notifiable` inside `send()` sees plain data.
:::

For a queued channel, a successful result means the job was queued, not that the message arrived. Failed jobs appear in [Failed jobs](/queue/failed-jobs).

## Next steps

- [Running workers](/queue/workers)
- [Notification events](/notifications/events)
- [Sending notifications](/notifications/sending)
