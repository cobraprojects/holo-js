# Queueing Notifications

## Basic Queueing

Notifications can be delayed and processed asynchronously using queues:

```ts
await notify(user, invoicePaid)
  .onQueue('notifications')
  .delay(300) // 5 minutes delay
  .afterCommit()
```

This requires the `@holo-js/queue` package to be installed.

## Queue Configuration

You can configure default queue settings in your notifications configuration:

```ts
// config/notifications.ts
export default defineNotificationsConfig({
  default: 'database',
  queue: {
    connection: 'default',
    queue: 'notifications',
    // Whether to delay dispatch until after database commits
    afterCommit: true
  },
  channels: {
    database: {
      driver: 'database',
      table: 'notifications'
    }
  }
})
```

## Queue Options

### Delayed Delivery

```ts
// Delay all channels by 5 minutes
await notify(user, invoicePaid)
  .delay(5 * 60)

// Delay specific channels
await notify(user, invoicePaid)
  .delayFor('email', 10 * 60) // Email delayed 10 minutes
  .delayFor('broadcast', 0)   // Broadcast immediately

// Delay using a Date object
await notify(user, invoicePaid)
  .delay(new Date(Date.now() + 3600000))
```

### Per-Channel Queue Settings

You can set queue defaults per channel in your notification definition:

```ts
const invoicePaid = defineNotification({
  type: 'invoice-paid',
  via() {
    return ['email', 'database', 'broadcast'] as const
  },
  queue: {
    email: 'notifications-high-priority', // Use different queue for email
    database: 'notifications'             // Use default queue for database
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

## How Queueing Works

1. When `.onQueue()` is called, one queue job is created per recipient and per channel
2. Each queue job contains:
   - The notification definition
   - The recipient information
   - Channel-specific payload data
3. Queue workers process jobs by:
   - Reconstructing the notification
   - Sending it through the appropriate channel
4. If `.afterCommit()` is used, notifications are only queued after database transactions commit
5. Channel failures are isolated - if one channel fails, others continue to process