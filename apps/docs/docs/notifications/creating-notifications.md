# Creating Notifications

## Basic Notification Structure

Each notification consists of a type identifier and channel-specific builders that determine what data is sent through each channel.

```ts
import { defineNotification } from '@holo-js/notifications'

interface InvoicePaidNotification {
  readonly id: string
  readonly type: string
  readonly email: string
  readonly name?: string
  readonly invoiceId: string
  readonly invoiceNumber: string
  readonly paidAt: string
}

const invoicePaid = defineNotification({
  type: 'invoice-paid',
  via() {
    return ['email', 'database', 'broadcast']
  },
  build: {
    email(data: InvoicePaidNotification) {
      return {
        subject: `Invoice #${data.invoiceNumber} paid`,
        greeting: data.name ? `Hello ${data.name},` : undefined,
        lines: ['Your invoice has been successfully paid.'],
      }
    },
    database(data: InvoicePaidNotification) {
      return {
        data: {
          invoiceId: data.invoiceId,
          invoiceNumber: data.invoiceNumber,
          paidAt: data.paidAt,
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

## Passing Data To A Notification

The value passed to `notify(...)` is the same value received by `via(...)` and every channel builder. Put the route
fields and message variables the notification needs on that object.

```ts
import { defineNotification, notify } from '@holo-js/notifications'

interface InvoicePaidNotification {
  readonly id: string
  readonly type: string
  readonly email: string
  readonly name?: string
  readonly invoiceId: string
  readonly invoiceNumber: string
}

const invoicePaid = defineNotification({
  type: 'invoice-paid',
  via() {
    return ['email']
  },
  build: {
    email(data: InvoicePaidNotification) {
      return {
        subject: `Invoice #${data.invoiceNumber} paid`,
        greeting: data.name ? `Hello ${data.name},` : undefined,
        action: {
          label: 'View invoice',
          url: `https://app.test/invoices/${data.invoiceId}`,
        },
      }
    },
  },
})

const notificationInput = {
  id: 'user-1',
  type: 'users',
  name: 'Ava',
  email: 'ava@example.com',
  invoiceId: 'inv-100',
  invoiceNumber: 'INV-100',
}

await notify(notificationInput, invoicePaid)
```

## Notification Types

Each notification must have a unique `type` string that identifies it. This type is used when storing notifications in the database and can be used for filtering or processing notifications programmatically.

## Defining Delivery Channels

The `via()` method returns an array of channel names that the notification should be sent through. Available built-in channels include:
- `email` - Sends email notifications
- `database` - Stores notifications in a database table
- `broadcast` - Broadcasts notifications via websocket connections

## Building Channel-Specific Data

For each channel specified in `via()`, you must provide a corresponding builder function in the `build` object. These functions return the specific data that should be sent through each channel.
