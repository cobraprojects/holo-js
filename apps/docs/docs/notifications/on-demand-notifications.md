# On-Demand Notifications

Use `notifyUsing()` when the recipient is not a model. Supply each channel's route explicitly and use
`defineNotification(...)` to describe the message.

## Anonymous Notification Targets

Anonymous targets contain routes rather than the attributes of a user or invoice. Capture message data
in the notification definition instead of expecting it in a builder's recipient argument:

```ts
import { defineNotification, notifyUsing } from '@holo-js/notifications'

const invoice = { id: 'inv-100', number: 'INV-100' }
const invoicePaid = defineNotification({
  type: 'invoice-paid',
  via: () => ['email', 'database'],
  build: {
    email: () => ({ subject: `Invoice #${invoice.number} paid` }),
    database: () => ({ data: { invoiceId: invoice.id, invoiceNumber: invoice.number } }),
  },
})

await notifyUsing()
  .channel('email', { email: 'ava@example.com', name: 'Ava' })
  .channel('database', { id: 'user-1', type: 'users' })
  .notify(invoicePaid)
```

The channels returned by `via()` must have corresponding routes on the anonymous target. Choose channel
names and database recipient identities in trusted server code.

## Broadcast Targets

Supply the broadcast channels explicitly:

```ts
const invoiceBroadcast = defineNotification({
  type: 'invoice-paid',
  via: () => ['broadcast'],
  build: {
    broadcast: () => ({ data: { invoiceId: invoice.id } }),
  },
})

await notifyUsing()
  .channel('broadcast', { channels: ['private-user.123'] })
  .notify(invoiceBroadcast)
```

Anonymous dispatches support the same queue and delay options as `notify(...)`. Queued delivery stores the
resolved message and routes, so the worker does not need the closure used to build this message.
