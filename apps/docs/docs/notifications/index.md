# Notifications

Holo-JS notifications are application-facing delivery definitions. They let one notification fan out across
multiple channels while keeping transport details behind runtime contracts.

Use notifications when you want one typed definition to support email, database, broadcast, and custom channels.

## What notifications own

The `@holo-js/notifications` package owns:

- notification definitions through `defineNotification(...)`
- fluent delivery through `notify(...)`, `notifyMany(...)`, and `notifyUsing()`
- built-in `email`, `database`, and `broadcast` channel contracts
- delayed and queued delivery orchestration
- anonymous/on-demand routing
- custom channel registration

Notifications do not own SMTP transports or websocket providers. `email` and `broadcast` are built-in channels,
but the real sender implementations stay outside this package.

## Quick start

```ts
import { defineNotification, notify } from '@holo-js/notifications'

interface InvoiceRecipient {
  readonly id: string
  readonly type: string
  readonly name?: string
  readonly email: string
  readonly invoiceId: string
  readonly invoiceNumber: string
  readonly invoiceTotal: number
}

const invoicePaid = defineNotification({
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

The object passed to `notify(...)` is passed into `via(...)` and every channel builder. Include the route fields and
message variables the notification needs on that object.

## Package boundaries

- `@holo-js/notifications` owns notification contracts, channel contracts, and dispatch orchestration.
- `@holo-js/db` owns the default database storage implementation used by core.
- `@holo-js/queue` owns queue runtime and worker behavior.
- `@holo-js/core` owns optional runtime boot and auth delivery bridging.
- mail transports and websocket transports stay in user code or future dedicated packages.

## Continue

- [Setup And CLI](/notifications/setup-and-cli)
- [Defining Notifications](/notifications/defining-notifications)
- [Sending Notifications](/notifications/sending-notifications)
- [Custom Channels](/notifications/custom-channels)
