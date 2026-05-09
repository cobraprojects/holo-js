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

interface InvoiceRecipient {
  readonly id: string
  readonly name?: string
  readonly email: string
}

export const invoicePaid = (invoice: {
  readonly id: string
  readonly number: string
  readonly total: number
}) => defineNotification({
  type: 'invoice-paid',

  via(user: InvoiceRecipient) {
    return ['email', 'database', 'broadcast']
  },

  build: {
    email(user: InvoiceRecipient) {
      return {
        subject: `Invoice #${invoice.number} paid`,
        greeting: user.name ? `Hello ${user.name},` : undefined,
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

    database(user: InvoiceRecipient) {
      return {
        data: {
          userId: user.id,
          invoiceId: invoice.id,
          invoiceNumber: invoice.number,
          total: invoice.total,
          message: `Invoice #${invoice.number} has been paid.`,
        },
      }
    },

    broadcast(user: InvoiceRecipient) {
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

## Passing Variables

Notifications usually need two kinds of data:

- the event data, such as an invoice, order, token, or URL
- the recipient data passed to `notify(...)`

Use a small factory function when the notification needs event data. The factory captures those variables, and the
notifiable passed to `notify(...)` becomes the first argument for `via(...)` and each channel builder.

```ts
import { defineNotification, notify } from '@holo-js/notifications'

interface InvoiceRecipient {
  readonly id: string
  readonly name?: string
  readonly email?: string
}

const invoicePaid = (invoice: {
  readonly id: string
  readonly number: string
  readonly total: number
}) => defineNotification({
  type: 'invoice-paid',
  via(user: InvoiceRecipient) {
    return user.email ? ['email', 'database'] : ['database']
  },
  build: {
    email(user: InvoiceRecipient) {
      return {
        subject: `Invoice #${invoice.number} paid`,
        greeting: user.name ? `Hello ${user.name},` : undefined,
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
    database(user: InvoiceRecipient) {
      return {
        data: {
          userId: user.id,
          invoiceId: invoice.id,
          invoiceNumber: invoice.number,
          total: invoice.total,
        },
      }
    },
  },
})

await notify({
  id: 'user-1',
  name: 'Ava',
  email: 'ava@example.com',
}, invoicePaid({
  id: 'inv-100',
  number: 'INV-100',
  total: 250,
}))
```

In this example, `invoice` is available because the notification factory closes over it. The `user` argument is the
notifiable object passed to `notify(...)`.

## Built-in channel payloads

The built-in channels expect these payload families:

- `email` builds a `NotificationMailMessage`
- `database` builds a `NotificationDatabaseMessage`
- `broadcast` builds a `NotificationBroadcastMessage`

The simplest valid payloads are:

```ts
defineNotification({
  via() {
    return ['email', 'database', 'broadcast']
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
    return ['email', 'database']
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
