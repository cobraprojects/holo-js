# Sending Notifications

Send a notification to one recipient with `notify()`, to many with `notifyMany()`, or to an address that isn't a user in your app with `notifyUsing()`.

```ts
import { notify } from '@holo-js/notifications'
import commentPosted from '../notifications/comment-posted'

await notify({
  id: post.authorId,
  type: 'users',
  email: author.email,
  name: author.name,
  postTitle: post.title,
  commentUrl: `https://blog.example.com/posts/${post.slug}#comments`,
}, commentPosted)
```

The notification is delivered when you `await` it. You can also call `.dispatch()`, which returns a promise.

## Where Holo delivers

Each built-in channel reads its destination from the recipient object:

| Channel | Reads | Example |
| --- | --- | --- |
| `email` | `email`, and `name` if present | `{ email: 'ava@example.com', name: 'Ava' }` |
| `database` | `id` and `type` | `{ id: 'user-1', type: 'users' }` |
| `broadcast` | `routeNotificationForBroadcast()`, else `broadcastChannels` (a method or a property) | `{ broadcastChannels: ['private-users.1'] }` |
| custom | `routeNotificationFor(channel)` | See [Custom channels](/notifications/custom-channels). |

For `database`, `type` groups notifications by kind of recipient, such as `'users'` or `'teams'`. If `type` is missing and the recipient is a class instance, Holo uses the class name. A plain object without `type` fails.

A channel fails when its field is missing, for example sending `email` to a recipient without an `email` address.

## Send to many recipients

`notifyMany()` takes an array (or any iterable) and delivers to each recipient:

```ts
import { notifyMany } from '@holo-js/notifications'
import maintenanceScheduled from '../notifications/maintenance-scheduled'

await notifyMany(admins.map(admin => ({
  id: admin.id,
  type: 'users',
  email: admin.email,
  startsAt: '2026-11-01 02:00 UTC',
})), maintenanceScheduled)
```

## Send to an address on demand

Use `notifyUsing()` when the person isn't a recipient object in your app, such as a sales inbox or a guest checkout email. Add one route per channel with `.channel()`, then call `.notify()`:

```ts
import { defineNotification, notifyUsing } from '@holo-js/notifications'

const order = { number: 'A-1001', total: '$42.00' }

const newOrder = defineNotification({
  type: 'new-order',
  via() {
    return ['email', 'broadcast']
  },
  build: {
    email() {
      return { subject: `New order ${order.number}`, lines: [`Total: ${order.total}`] }
    },
    broadcast() {
      return { event: 'orders.created', data: { number: order.number } }
    },
  },
})

await notifyUsing()
  .channel('email', { email: 'sales@example.com', name: 'Sales' })
  .channel('broadcast', ['private-sales'])
  .notify(newOrder)
```

Route formats:

| Channel | Route |
| --- | --- |
| `email` | `'sales@example.com'` or `{ email, name? }` |
| `database` | `{ id, type }` |
| `broadcast` | `'private-sales'`, `['private-sales', 'private-ops']`, or `{ channels: [...] }` |

On-demand builders don't receive a recipient object, so take the message data from the surrounding code as shown above. TypeScript rejects a notification whose builders expect a recipient. Every channel returned by `via()` needs a route, or it fails with `Anonymous notifications must define a route for channel "..."`.

::: warning
Choose routes in server code. Don't pass email addresses, broadcast channel names, or database `id`/`type` values straight from a request, or users could send notifications to other people.
:::

## Delay, queue, and transactions

Chain these before awaiting:

```ts
await notify(recipient, commentPosted)
  .onConnection('redis')
  .onQueue('notifications')
  .delay(300)
  .delayFor('email', 600)
  .afterCommit()
```

| Method | Effect |
| --- | --- |
| `.onConnection(name)` | Queue on this connection from `config/queue.ts`. |
| `.onQueue(name)` | Queue on this queue name. |
| `.delay(value)` | Queue every channel and wait this many seconds, or until a `Date`. |
| `.delayFor(channel, value)` | Delay one channel. Wins over `.delay()` for that channel. |
| `.afterCommit()` | Wait for the current [transaction](/database/transactions) to commit. If it rolls back, nothing is sent. |
| `.deduplicate(key)` | Store at most one database notification per key. See below. |

See [Queueing notifications](/notifications/queueing) for the details.

## Avoid duplicate inbox entries

When the same code might run twice, for example a retried job or webhook, pass a stable key to `.deduplicate()`. The second call with the same key, recipient, and type doesn't create a second row:

```ts
await notify(recipient, invoicePaid).deduplicate(`invoice-paid:${invoice.id}`)
```

Keys are 1 to 200 printable ASCII characters. Deduplication only works when every channel is `database`; with any other channel it throws.

## Check the result

The awaited value lists the outcome for each recipient and channel:

```ts
const result = await notify(recipient, commentPosted)

for (const delivery of result.channels) {
  if (!delivery.success) {
    console.error(`Notification failed on ${delivery.channel}`, delivery.error)
  }
}
```

A failing channel doesn't stop the others and doesn't make `notify()` throw. Only setup mistakes throw, such as `via()` returning a channel that isn't registered. Check `result.channels` if you need to react to failures. See [Notification events](/notifications/events) for the full result shape.

## Available methods

Start with `notify()`, `notifyMany()`, or `notifyUsing()`. Chain any of the methods below before you `await` the result.

**Sending**

- [notify()](#notify)
- [notifyMany()](#notifymany)
- [notifyUsing()](#notifyusing)
- [notifications (default export)](#notifications-default-export)

**On-demand targets**

- [channel()](#channel)
- [on-demand notify()](#on-demand-notify)

**Pending dispatch**

<div class="method-list">

- [onConnection()](#onconnection)
- [onQueue()](#onqueue)
- [delay()](#delay)
- [delayFor()](#delayfor)
- [afterCommit()](#aftercommit)
- [deduplicate()](#deduplicate)
- [dispatch()](#dispatch)
- [then(), catch(), and finally()](#then-catch-and-finally)

</div>

**Results**

- [Delivery result](/notifications/events#the-delivery-result)

### notify()

Sends a notification to one recipient. Returns a pending dispatch, so `await` it to send and get the [delivery result](/notifications/events#the-delivery-result).

```ts
const result = await notify(recipient, commentPosted)
```

### notifyMany()

Sends the same notification to each recipient in an array or any iterable. The result has one entry per recipient and channel. Each entry's `targetIndex` is the recipient's position in the list.

```ts
await notifyMany(admins, maintenanceScheduled)
```

### notifyUsing()

Starts an on-demand send to addresses that aren't recipients in your app. Add a route for each channel with `.channel()`, then call `.notify()` with the notification.

```ts
await notifyUsing().channel('email', 'sales@example.com').notify(newOrder)
```

### channel()

Sets the route for one channel and returns the builder, so you can chain more channels. Calling it again for the same channel replaces the earlier route. Route formats are listed under [Send to an address on demand](#send-to-an-address-on-demand).

```ts
notifyUsing()
  .channel('email', { email: 'sales@example.com', name: 'Sales' })
  .channel('broadcast', ['private-sales'])
```

### on-demand notify()

Sends a notification to the routes you set with `.channel()`. Every channel the notification's `via()` returns needs a route, or the send fails for that channel.

```ts
await notifyUsing().channel('broadcast', 'private-sales').notify(newOrder)
```

### notifications (default export)

The package's default export groups `notify`, `notifyMany`, `notifyUsing`, and the database helpers in one object.

```ts
import notifications from '@holo-js/notifications'

await notifications.notify(recipient, commentPosted)
```

### onConnection()

Queues the delivery on the named connection from `config/queue.ts`. Calling it always queues the notification.

```ts
await notify(recipient, commentPosted).onConnection('redis')
```

### onQueue()

Queues the delivery on the named queue. Calling it always queues the notification.

```ts
await notify(recipient, commentPosted).onQueue('notifications')
```

### delay()

Queues every channel and holds it for a number of seconds, or until a `Date`. A `delayFor()` value for a channel overrides this for that channel.

```ts
await notify(recipient, commentPosted).delay(300)
```

### delayFor()

Queues one channel and holds it for a number of seconds, or until a `Date`. This value wins over `delay()` for that channel only.

```ts
await notify(recipient, commentPosted).delayFor('email', 600)
```

### afterCommit()

Waits for the current database transaction to commit before sending. If the transaction rolls back, nothing is sent. Outside a transaction, the notification sends right away.

```ts
await DB.transaction(async () => {
  await notify(recipient, orderPlaced).afterCommit()
})
```

### deduplicate()

Stores at most one database notification for a key. A second call with the same key, recipient, and notification type doesn't add a row. Keys are 1 to 200 printable ASCII characters. Every channel must be `database`, or the send fails.

```ts
await notify(recipient, invoicePaid).deduplicate(`invoice-paid:${invoice.id}`)
```

### dispatch()

Sends the notification and returns a promise for the result. It does the same thing as `await`.

```ts
const result = await notify(recipient, commentPosted).dispatch()
```

### then(), catch(), and finally()

A pending dispatch is promise-like. `await` it, or call these methods directly. Sending starts on the first call, and later calls reuse the same result, so the notification is never sent twice.

```ts
await notify(recipient, commentPosted)
  .catch(error => console.error('Notification failed', error))
```

## Next steps

- [Channels](/notifications/channels)
- [Queueing notifications](/notifications/queueing)
- [Notification events](/notifications/events)
