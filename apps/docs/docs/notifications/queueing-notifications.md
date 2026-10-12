# Queueing Notifications

## Basic Queueing

Notifications can be delayed and processed asynchronously using queues:

```ts
await notify(user, invoicePaid)
  .onConnection('database')
  .onQueue('notifications')
  .delay(300) // 5 minutes delay
  .afterCommit()
```

This requires the `@holo-js/queue` package to be installed.
If the configured queue connection uses an async driver, production also needs a supervised queue worker.
See [Deployment](/deployment) for host selection and [Queue Workers](/queue/workers) for worker commands.

## Queue Configuration

You can configure default queue settings in your notifications configuration:

```ts
import { defineNotificationsConfig } from '@holo-js/notifications'

export default defineNotificationsConfig({
  table: 'notifications',
  queue: {
    connection: 'database',
    queue: 'notifications',
    afterCommit: true,
  },
})
```

`connection` names a connection in `config/queue.ts`. These settings supply defaults for queued
deliveries; they do not make every notification asynchronous. Queue a notification with its definition's
`queue` option, `.onConnection(...)`, `.onQueue(...)`, or a delay.

Run a worker for the selected connection and queue:

```bash
holo queue:work --connection database --queue notifications
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
  .delayFor('broadcast', 0)   // No scheduling delay

// Delay using a Date object
await notify(user, invoicePaid)
  .delay(new Date(Date.now() + 3600000))
```

A zero delay adds no scheduling wait; the selected queue driver still controls execution. An asynchronous
connection still needs its worker.
Fluent delays override definition delays. If the definition has no separate delay, a delay returned by its
queue resolver is used.

### Notification Queue Defaults

You can set queue defaults for every queued channel in your notification definition:

```ts
interface InvoicePaidNotification {
  readonly invoiceId: string
  readonly invoiceNumber: string
}

const invoicePaid = defineNotification({
  type: 'invoice-paid',
  via() {
    return ['email', 'database', 'broadcast']
  },
  queue: {
    queue: 'notifications',
    afterCommit: true,
  },
  build: {
    email(data: InvoicePaidNotification) {
      return {
        subject: `Invoice #${data.invoiceNumber} paid`,
        lines: ['Your invoice has been successfully paid.'],
      }
    },
    database(data: InvoicePaidNotification) {
      return {
        data: {
          invoiceId: data.invoiceId,
          invoiceNumber: data.invoiceNumber,
        },
      }
    },
    broadcast(data: InvoicePaidNotification) {
      return {
        event: 'invoice.paid',
        data: {
          invoiceId: data.invoiceId,
          invoiceNumber: data.invoiceNumber,
        },
      }
    },
  },
})
```

## How Queueing Works

1. Holo resolves a delivery for each recipient and channel, including the payload, route, queue, and delay.
2. Queued deliveries store JSON snapshots of the resolved payload and route. The worker does not rerun the notification definition or recipient routing methods.
3. Start the normal Holo queue worker to deliver these jobs; application code does not need to register a notification delivery job.
4. With `.afterCommit()`, Holo resolves and sends or queues delivery after the surrounding transaction commits. A rollback cancels it. Outside a transaction, delivery proceeds normally.
5. Channel failures are isolated. Inspect the dispatch result for each channel's success or failure.
