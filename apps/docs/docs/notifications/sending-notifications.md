# Sending Notifications

## Basic Usage

Notifications are sent using the `notify` function, which returns a fluent API for configuring delivery options.

```ts
import { notify } from '@holo-js/notifications'
import { invoicePaid } from './notifications'

await notify(user, invoicePaid)
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
  .delay(5 * 60)

// Delay specific channels
await notify(user, invoicePaid)
  .delayFor('email', 10 * 60) // Email delayed 10 minutes
  .delayFor('broadcast', 0)   // Broadcast immediately
```

### Transaction Awareness

```ts
await notify(user, invoicePaid)
  .afterCommit()
```
