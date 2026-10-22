# Delivery Results

Every notification send returns a delivery result that tells you, per recipient and channel, whether it succeeded, failed, or was queued. Use it to log failures, record metrics, or trigger your own follow-up [events](/events/).

```ts
import { notify } from '@holo-js/notifications'
import invoicePaid from '../notifications/invoice-paid'

const result = await notify(recipient, invoicePaid)

const failed = result.channels.filter(delivery => !delivery.success)

for (const delivery of failed) {
  console.error(`invoice-paid failed on ${delivery.channel}`, delivery.error)
}
```

::: info
Holo doesn't dispatch built-in "notification sent" or "notification failed" events. The delivery result is the hook: inspect it where you call `notify()`, and dispatch an app event from there if other code needs to react.
:::

## The delivery result

```ts
type NotificationDispatchResult = {
  totalTargets: number
  deferred?: boolean
  channels: Array<{
    channel: string
    targetIndex: number
    success: boolean
    queued: boolean
    deferred?: boolean
    result?: unknown
    error?: unknown
  }>
}
```

| Field | Meaning |
| --- | --- |
| `totalTargets` | How many recipients were notified. `1` for `notify()` and `notifyUsing()`. |
| `deferred` | `true` when the whole send is waiting for a transaction to commit. |
| `channels` | One entry per recipient per channel, in order. |
| `channels[].channel` | The channel name. |
| `channels[].targetIndex` | The recipient's position in the `notifyMany()` list. |
| `channels[].success` | Whether this delivery succeeded (or was queued). |
| `channels[].queued` | `true` if it went to the queue. Success then means "queued", not "delivered". |
| `channels[].deferred` | `true` if it's waiting for a transaction to commit. |
| `channels[].result` | The value a [custom channel](/notifications/custom-channels)'s `send()` returned. Built-in channels return nothing. |
| `channels[].error` | What the channel threw, when `success` is `false`. |

A failing channel doesn't stop the others, and `notify()` doesn't throw for it. If you need a failure to surface as an error, check the result and throw yourself.

A send that waits for a transaction to commit has no result to check once the commit happens. Holo reports each channel that fails after commit through [`exceptions.report`](/basics/errors#reporting-errors), with capability `notifications` and operation `channel.afterCommit`. The transaction has already committed, so a failed channel doesn't make the transaction call throw. If an earlier after-commit callback in the same transaction throws, such as a queued dispatch that can't be queued, the callbacks after it don't run, including this one.

## Find who a failure belongs to

With `notifyMany()`, use `targetIndex` to map a result back to the recipient:

```ts
import { notifyMany } from '@holo-js/notifications'

const result = await notifyMany(members, releaseAnnounced)

for (const delivery of result.channels) {
  if (!delivery.success) {
    const member = members[delivery.targetIndex]
    console.error(`Could not notify ${member?.email} via ${delivery.channel}`)
  }
}
```

## Dispatch your own event

To let other parts of the app react, for example to alert on-call when emails keep failing, dispatch an [event](/events/defining-events) from the result:

```ts [server/events/notifications/delivery-failed.ts]
import { defineEvent } from '@holo-js/events'

export default defineEvent<{
  notification: string
  channel: string
}>({
  name: 'notifications.delivery-failed',
})
```

```ts
import NotificationDeliveryFailed from '../events/notifications/delivery-failed'

const result = await notify(recipient, invoicePaid)

for (const delivery of result.channels) {
  if (!delivery.success) {
    await NotificationDeliveryFailed.dispatch({
      notification: 'invoice-paid',
      channel: delivery.channel,
    })
  }
}
```

## Queued deliveries

For queued channels, the result only covers putting the job on the queue. Failures that happen later in the worker are handled by the queue: they're retried and recorded as [failed jobs](/queue/failed-jobs).

## Next steps

- [Sending notifications](/notifications/sending)
- [Queueing notifications](/notifications/queueing)
- [Testing notifications](/notifications/testing)
