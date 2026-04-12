# Sending Notifications

Use `notify(...)` for model-backed or object-backed notifiables, `notifyMany(...)` for collections, and
`notifyUsing()` for anonymous/on-demand delivery.

## Send to one notifiable

```ts
import { notify } from '@holo-js/notifications'

await notify(user, invoicePaid(invoice))
```

## Send to many notifiables

```ts
import { notifyMany } from '@holo-js/notifications'

await notifyMany(users, invoicePaid(invoice))
```

## Delayed and queued delivery

Notification dispatches are lazy and fluent. Awaiting the chain triggers delivery.

```ts
await notify(user, invoicePaid(invoice))
  .onConnection('redis')
  .onQueue('notifications')
  .delay(30)
  .delayFor('email', 300)
  .afterCommit()
```

Queueing fans out one queued job per target and per channel.

## Anonymous and on-demand delivery

Use `notifyUsing()` when there is no model-backed notifiable:

```ts
import { notifyUsing } from '@holo-js/notifications'

await notifyUsing()
  .channel('email', { email: 'barrett@example.com', name: 'Barrett Blair' })
  .channel('broadcast', { channels: ['private-users.barrett'] })
  .notify(invoicePaid(invoice))
```

Built-in anonymous route shapes are:

- `email`: `'user@example.com'` or `{ email, name? }`
- `database`: `{ id, type }`
- `broadcast`: `'channel'`, `['channel']`, or `{ channels: [...] }`

## Results

Dispatch returns a per-channel result summary:

```ts
const result = await notify(user, invoicePaid(invoice))

result.totalTargets
result.channels
```

Channel failures do not stop other channels from running. The result object reports partial success per channel.
