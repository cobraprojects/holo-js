# Notification Delivery Results

Awaited notification dispatches return per-channel results that applications can use for logging, monitoring, and
analytics.

## Inspecting delivery

```ts
import { notify } from '@holo-js/notifications'

const result = await notify(user, invoicePaid)
const successful = result.channels.filter(channel => channel.success)
const failed = result.channels.filter(channel => !channel.success)

console.log(`Delivered through ${successful.map(entry => entry.channel).join(', ')}`)
for (const delivery of failed) console.error(`Failed through ${delivery.channel}`, delivery.error)
```

## Delivery result structure

### Successful channel result

Successful entries include:

- `channel`: the channel name
- `targetIndex`: the recipient position
- `queued`: whether delivery was queued
- `result`: the channel driver's result

### Failed channel result

Failed entries use `success: false` and expose the thrown value through `error`.

- `channel`: the channel that failed
- `targetIndex`: the recipient position
- `queued`: whether delivery was queued
- `error`: the value thrown by the channel

## Use Cases

### Logging

```ts
import { notify } from '@holo-js/notifications'

const result = await notify(user, invoicePaid)
for (const delivery of result.channels) {
  logger.info('Notification sent', {
    channel: delivery.channel,
    success: delivery.success,
    queued: delivery.queued
  })
}
```

### Monitoring

```ts
const result = await notify(user, invoicePaid)
metrics.increment('notifications.sent', result.channels.filter(entry => entry.success).length)
metrics.increment('notifications.failed', result.channels.filter(entry => !entry.success).length)
```

### Analytics Tracking

```ts
const result = await notify(user, invoicePaid)
for (const delivery of result.channels) {
  analytics.track('notification_sent', {
    channel: delivery.channel,
    success: delivery.success,
    target_index: delivery.targetIndex
  })
}
```
