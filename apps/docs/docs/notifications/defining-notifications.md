# Defining Notifications

Define notifications with `defineNotification(...)` from `@holo-js/notifications`.

Each notification controls:

- which channels it should use through `via(...)`
- how each channel payload is built through `build`
- whether delivery should queue
- whether delivery should delay

## Basic definition

```ts
import { defineNotification } from '@holo-js/notifications'

export const invoicePaid = (invoice: {
  id: string
  number: string
  total: number
}) => defineNotification({
  type: 'invoice-paid',

  via() {
    return ['email', 'database', 'broadcast'] as const
  },

  build: {
    email(user: { name?: string }) {
      return {
        subject: `Invoice #${invoice.number} paid`,
        greeting: `Hello ${user.name ?? 'there'},`,
        lines: [
          `Invoice #${invoice.number} has been paid.`,
          `Total: ${invoice.total}.`,
        ],
        action: {
          label: 'View invoice',
          url: `https://app.test/invoices/${invoice.id}`,
        },
      }
    },

    database() {
      return {
        data: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.number,
          total: invoice.total,
          message: `Invoice #${invoice.number} has been paid.`,
        },
      }
    },

    broadcast(user: { id: string }) {
      return {
        event: 'notifications.invoice-paid',
        data: {
          invoiceId: invoice.id,
          invoiceNumber: invoice.number,
          total: invoice.total,
          userId: user.id,
        },
      }
    },
  },
})
```

## Built-in channel payloads

The built-in channels expect these payload families:

- `email` builds a `NotificationMailMessage`
- `database` builds a `NotificationDatabaseMessage`
- `broadcast` builds a `NotificationBroadcastMessage`

The simplest valid payloads are:

```ts
defineNotification({
  via() {
    return ['email', 'database', 'broadcast'] as const
  },
  build: {
    email() {
      return {
        subject: 'Subject',
      }
    },
    database() {
      return {
        data: {
          message: 'Stored in notifications table',
        },
      }
    },
    broadcast() {
      return {
        data: {
          message: 'Broadcast to subscribed clients',
        },
      }
    },
  },
})
```

## Notification-defined queueing and delay

Notifications can declare queueing and delay defaults directly:

```ts
defineNotification({
  via() {
    return ['email', 'database'] as const
  },
  queue: {
    connection: 'redis',
    queue: 'notifications',
    afterCommit: true,
  },
  delay: {
    email: 300,
    database: 10,
  },
  build: {
    email() {
      return { subject: 'Queued notification' }
    },
    database() {
      return { data: { queued: true } }
    },
  },
})
```

Fluent send-time overrides still win over notification defaults.
