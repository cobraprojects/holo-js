# Notification Events

When notifications are sent, Holo-JS dispatches events that you can listen to for logging, monitoring, or additional processing.

## Listening to Notification Events

```ts
import { onNotificationSent, onNotificationFailed } from '@holo-js/notifications'

// Listen for successful notifications
onNotificationSent(({ notification, notifiable, channels }) => {
  console.log(`Sent ${notification.type} to ${notifiable.id} via ${channels.join(', ')}`)
})

// Listen for failed notifications
onNotificationFailed(({ notification, notifiable, channel, error }) => {
  console.error(`Failed to send ${notification.type} to ${notifiable.id} via ${channel}:`, error)
})
```

## Event Data Structure

### Notification Sent Event

The `onNotificationSent` callback receives an object with:

- `notification`: The notification definition that was sent
- `notifiable`: The entity that received the notification
- `channels`: Array of channel names that the notification was sent through

### Notification Failed Event

The `onNotificationFailed` callback receives an object with:

- `notification`: The notification definition that failed to send
- `notifiable`: The entity that was supposed to receive the notification
- `channel`: The specific channel that failed
- `error`: The error object that caused the failure

## Use Cases

### Logging

```ts
import { onNotificationSent } from '@holo-js/notifications'

onNotificationSent(({ notification, notifiable, channels }) => {
  logger.info('Notification sent', {
    type: notification.type,
    notifiableId: notifiable.id,
    channels: channels.join(', ')
  })
})
```

### Monitoring

```ts
import { onNotificationSent, onNotificationFailed } from '@holo-js/notifications'

let sentCount = 0
let failedCount = 0

onNotificationSent(() => sentCount++)
onNotificationFailed(() => failedCount++)

// Report metrics periodically
setInterval(() => {
  console.log(`Notifications: ${sentCount} sent, ${failedCount} failed`)
}, 60000)
```

### Analytics Tracking

```ts
import { onNotificationSent } from '@holo-js/notifications'

onNotificationSent(({ notification, notifiable }) => {
  // Track notification delivery in analytics
  analytics.track('notification_sent', {
    notification_type: notification.type,
    notifiable_type: notifiable.constructor.name,
    notifiable_id: notifiable.id
  })
})
```