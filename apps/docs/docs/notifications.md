# Notifications

## Introduction

Holo-JS notifications provide a simple, expressive way to send notifications across various delivery channels including email, database storage, and real-time broadcasting. Notifications are designed to be flexible, allowing you to define how they should be delivered through different channels while maintaining a clean, fluent API.

## Creating Notifications

Notifications are defined using the `defineNotification` function. Each notification consists of a type identifier and channel-specific builders that determine what data is sent through each channel.

```ts
import { defineNotification } from '@holo-js/notifications'

const invoicePaid = defineNotification({
  type: 'invoice-paid',
  via() {
    return ['email', 'database', 'broadcast'] as const
  },
  build: {
    email() {
      return {
        subject: 'Invoice Paid',
        lines: ['Your invoice has been successfully paid.']
      }
    },
    database() {
      return {
        status: 'paid',
        paidAt: new Date().toISOString()
      }
    },
    broadcast() {
      return {
        event: 'invoice.paid',
        data: {
          status: 'paid'
        }
      }
    }
  }
})
```

### Notification Types

Each notification must have a unique `type` string that identifies it. This type is used when storing notifications in the database and can be used for filtering or processing notifications programmatically.

### Defining Delivery Channels

The `via()` method returns an array of channel names that the notification should be sent through. Available built-in channels include:
- `email` - Sends email notifications
- `database` - Stores notifications in a database table
- `broadcast` - Broadcasts notifications via websocket connections

### Building Channel-Specific Data

For each channel specified in `via()`, you must provide a corresponding builder function in the `build` object. These functions return the specific data that should be sent through each channel.

## Sending Notifications

Notifications are sent using the `notify` function, which returns a fluent API for configuring delivery options.

### Basic Usage

```ts
import { notify } from '@holo-js/notifications'
import { invoicePaid } from './notifications'

await notify(user, invoicePaid)
```

### Fluent Configuration Options

The `notify` function returns a fluent builder that allows you to configure various aspects of the notification delivery:

#### Queueing

```ts
await notify(user, invoicePaid)
  .onQueue('notifications')
```

#### Delayed Delivery

```ts
// Delay all channels by 5 minutes
await notify(user, invoicePaid)
  .delay(5 * 60)

// Delay specific channels
await notify(user, invoicePaid)
  .delayFor('email', 10 * 60) // Email delayed 10 minutes
  .delayFor('broadcast', 0)   // Broadcast immediately
```

#### Transaction Awareness

```ts
await notify(user, invoicePaid)
  .afterCommit()
```

## On-Demand Notifications

Sometimes you need to send notifications to recipients that aren't associated with a model, or you want to specify the notification target directly. For these cases, you can use the `notifyUsing` function.

### Anonymous Notification Targets

```ts
import { notifyUsing } from '@holo-js/notifications'

await notifyUsing()
  .channel('email', {
    email: 'user@example.com',
    name: 'User Name'
  })
  .channel('broadcast', {
    channels: ['private-user.123']
  })
  .notify(invoicePaid)
```

### Multiple Channels with On-Demand Targets

You can specify different targets for different channels:

```ts
await notifyUsing()
  .channel('email', {
    email: 'admin@example.com'
  })
  .channel('database', {
    // For database channel, you might want to store it for a specific user
    userId: '123'
  })
  .notify(invoicePaid)
```

## Notification Channels

### Email Channel

For the email channel, your builder function should return an object with email-specific properties:

```ts
build: {
  email() {
    return {
      subject: 'Welcome to our service',
      lines: [
        'Thanks for joining our platform!',
        'We\'re excited to have you on board.'
      ],
      // Optional: Add action buttons
      actionText: 'Get Started',
      actionUrl: 'https://example.com/get-started'
    }
  }
}
```

Available email properties:
- `subject` (required) - The email subject line
- `lines` (required) - Array of text lines for the email body
- `actionText` (optional) - Text for a call-to-action button
- `actionUrl` (optional) - URL for the call-to-action button
- `introLines` (optional) - Introductory lines before the main content
- `outroLines` (optional) - Concluding lines after the main content

### Database Channel

For the database channel, your builder function should return an object that will be serialized and stored in the notifications table:

```ts
build: {
  database() {
    return {
      amount: 100.00,
      transactionId: 'txn_123abc',
      status: 'completed'
    }
  }
}
```

All properties in the database payload will be stored as JSON in the `data` column of the notifications table.

### Broadcast Channel

For the broadcast channel, your builder function should return an object containing the event name and data to broadcast:

```ts
build: {
  broadcast() {
    return {
      event: 'notification.sent',
      data: {
        message: 'You have a new notification',
        timestamp: new Date().toISOString()
      }
    }
  }
}
```

The `event` property determines the websocket event name, and `data` contains the payload that will be sent to subscribers.

## Custom Notification Channels

Holo-JS allows you to create custom notification channels by implementing a simple contract and registering it with the framework.

### Creating a Custom Channel

```ts
// Define your custom channel
const slackChannel = {
  // Send the notification through your custom channel
  send: async (notification, notifiable, payload) => {
    // Your custom sending logic here
    await sendToSlack(notification.type, payload)
  }
}

// Register the channel
import { registerNotificationChannel } from '@holo-js/notifications'

registerNotificationChannel('slack', slackChannel)
```

### Using Custom Channels

Once registered, you can use your custom channel just like built-in channels:

```ts
const welcomeNotification = defineNotification({
  type: 'welcome',
  via() {
    return ['email', 'slack'] as const
  },
  build: {
    email() {
      return {
        subject: 'Welcome!',
        lines: ['Thanks for joining our community.']
      }
    },
    slack() {
      return {
        text: 'New user has joined the community!',
        attachments: [{ color: 'good' }]
      }
    }
  }
})
```

## Notification Events

When notifications are sent, Holo-JS dispatches events that you can listen to for logging, monitoring, or additional processing.

### Listening to Notification Events

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

## Notification Storage

When using the database channel, notifications are automatically stored in a `notifications` table with the following schema:

- `id` - Unique identifier for the notification
- `type` - The notification type string
- `notifiable_type` - The type of the entity receiving the notification (e.g., 'User')
- `notifiable_id` - The ID of the entity receiving the notification
- `data` - JSON payload containing the notification data
- `read_at` - Timestamp when the notification was marked as read (null if unread)
- `created_at` - When the notification was created
- `updated_at` - When the notification was last updated

### Working with Stored Notifications

Holo-JS provides helper functions for working with stored notifications:

```ts
import { 
  listNotifications, 
  listUnreadNotifications, 
  markAsRead, 
  markAsUnread,
  deleteNotifications 
} from '@holo-js/notifications/database'

// Get all notifications for a user
const notifications = await listNotifications({ userId: '123' })

// Get only unread notifications
const unread = await listUnreadNotifications({ userId: '123' })

// Mark notifications as read
await markAsRead(['notif_1', 'notif_2', 'notif_3'])

// Mark notifications as unread
await markAsUnread(['notif_4', 'notif_5'])

// Delete notifications
await deleteNotifications(['notif_6', 'notif_7'])
```

## Testing Notifications

When testing your application, you may want to inspect notifications without actually sending them. Holo-JS provides a fake notification driver for this purpose.

### Using the Fake Notification Driver

First, configure your application to use the fake driver in your test environment:

```ts
// config/notifications.ts
export default defineNotificationsConfig({
  default: 'fake',
  channels: {
    fake: {
      driver: 'fake'
    }
  }
})
```

Then in your tests, you can inspect sent notifications:

```ts
import { fakeNotificationData } from '@holo-js/notifications'

test('sends welcome notification when user registers', async () => {
  // Perform user registration
  await registerUser({ email: 'test@example.com' })
  
  // Get the sent notifications
  const notifications = fakeNotificationData()
  
  // Assert notifications were sent
  expect(notifications).toHaveLength(1)
  expect(notifications[0].type).toBe('welcome')
  expect(notifications[0].to).toContainEqual({
    email: 'test@example.com'
  })
})
```

## Configuration

Notification configuration is stored in `config/notifications.ts`. Here's an example configuration:

```ts
import { defineNotificationsConfig } from '@holo-js/notifications'

export default defineNotificationsConfig({
  // Default notification channel
  default: 'database',
  
  // Queue configuration
  queue: {
    connection: 'default',
    queue: 'notifications',
    // Whether to delay dispatch until after database commits
    afterCommit: true
  },
  
  // Channel configurations
  channels: {
    database: {
      driver: 'database',
      table: 'notifications'
    },
    broadcast: {
      driver: 'broadcast',
      // Broadcasting configuration would go here
    },
    fake: {
      driver: 'fake'
    }
  }
})
```

### Environment Variables

You can override configuration values using environment variables:

```
NOTIFICATIONS_DEFAULT=database
NOTIFICATIONS_QUEUE_CONNECTION=redis
NOTIFICATIONS_QUEUE_QUEUE=notifications
```