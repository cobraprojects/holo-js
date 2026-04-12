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

const invoicePaid = (invoice: { id: string, number: string, total: number }) => defineNotification({
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
