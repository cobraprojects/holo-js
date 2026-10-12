# Sending Notifications

## Basic Usage

Notifications are sent using the `notify` function, which returns a fluent API for configuring delivery options.

```ts
import { notify } from '@holo-js/notifications'
import { invoicePaid } from './notifications'

await notify(user, invoicePaid)
```

## Sending to Multiple Users

Use `notifyMany` to fan out a notification to an array of notifiables:

```ts
import { notifyMany } from '@holo-js/notifications'

await notifyMany(users, invoicePaid)
```

## Fluent Configuration Options

The `notify` function returns a fluent builder that allows you to configure various aspects of the notification delivery:

### Queueing

```ts
await notify(user, invoicePaid)
  .onQueue('notifications')
```

### Delayed Delivery

```ts
// Delay all channels by 5 minutes
await notify(user, invoicePaid)
  .delay(300)

// Delay specific channels
await notify(user, invoicePaid)
  .delayFor('email', 300)      // Email delayed 5 minutes
  .delayFor('broadcast', 0)    // No scheduling delay
```

### Transaction Awareness

```ts
await notify(user, invoicePaid)
  .afterCommit()
```

## Anonymous Notifications

Use `notifyUsing()` to send notifications without a notifiable model by providing routes directly:

```ts
import { defineNotification, notifyUsing } from '@holo-js/notifications'

await notifyUsing()
  .channel('email', { email: 'ava@example.com', name: 'Ava' })
  .notify(defineNotification({
    type: 'invoice-paid',
    via: () => ['email'],
    build: {
      email: () => ({ subject: 'Your invoice has been paid' }),
    },
  }))
```

See [On-Demand Notifications](/notifications/on-demand-notifications) for a complete
`defineNotification(...)` example. Anonymous notification builders must not depend on model attributes
that are absent from the supplied routes.
