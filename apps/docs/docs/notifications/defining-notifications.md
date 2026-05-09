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
  readonly type: string
  readonly name?: string
  readonly email: string
  readonly broadcastChannels?: readonly string[]
  readonly invoiceId: string
  readonly invoiceNumber: string
  readonly invoiceTotal: number
}

export const invoicePaid = defineNotification({
  type: 'invoice-paid',

  via() {
    return ['email', 'database', 'broadcast']
  },

  build: {
    email(data: InvoiceRecipient) {
      return {
        subject: `Invoice #${data.invoiceNumber} paid`,
        greeting: data.name ? `Hello ${data.name},` : undefined,
        lines: [
          `Invoice #${data.invoiceNumber} has been paid.`,
          `Total: ${data.invoiceTotal}.`,
        ],
        action: {
          label: 'View invoice',
          url: `https://app.test/invoices/${data.invoiceId}`,
        },
      }
    },

    database(data: InvoiceRecipient) {
      return {
        data: {
          userId: data.id,
          invoiceId: data.invoiceId,
          invoiceNumber: data.invoiceNumber,
          total: data.invoiceTotal,
          message: `Invoice #${data.invoiceNumber} has been paid.`,
        },
      }
    },

    broadcast(data: InvoiceRecipient) {
      return {
        event: 'notifications.invoice-paid',
        data: {
          invoiceId: data.invoiceId,
          invoiceNumber: data.invoiceNumber,
          total: data.invoiceTotal,
          userId: data.id,
        },
      }
    },
  },
})
```

## Passing Variables

The value passed to `notify(...)` is the same value passed to `via(...)` and to each channel builder. Include the
channel route fields and the message variables on that data object.

```ts
import { defineNotification, notify } from '@holo-js/notifications'

interface InvoiceRecipient {
  readonly id: string
  readonly type: string
  readonly name?: string
  readonly email?: string
  readonly invoiceId: string
  readonly invoiceNumber: string
  readonly invoiceTotal: number
}

const invoicePaid = defineNotification({
  type: 'invoice-paid',
  via(data: InvoiceRecipient) {
    return data.email ? ['email', 'database'] : ['database']
  },
  build: {
    email(data: InvoiceRecipient) {
      return {
        subject: `Invoice #${data.invoiceNumber} paid`,
        greeting: data.name ? `Hello ${data.name},` : undefined,
        lines: [
          `Invoice #${data.invoiceNumber} has been paid.`,
          `Total: ${data.invoiceTotal}.`,
        ],
        action: {
          label: 'View invoice',
          url: `https://app.test/invoices/${data.invoiceId}`,
        },
      }
    },
    database(data: InvoiceRecipient) {
      return {
        data: {
          userId: data.id,
          invoiceId: data.invoiceId,
          invoiceNumber: data.invoiceNumber,
          total: data.invoiceTotal,
        },
      }
    },
  },
})

await notify({
  id: 'user-1',
  type: 'users',
  name: 'Ava',
  email: 'ava@example.com',
  invoiceId: 'inv-100',
  invoiceNumber: 'INV-100',
  invoiceTotal: 250,
}, invoicePaid)
```

In this example, the same object supplies the email route, the database notifiable route, and the invoice variables
used by the message builders.

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
