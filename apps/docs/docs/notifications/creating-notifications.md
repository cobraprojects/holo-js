# Creating Notifications

## Basic Notification Structure

Each notification consists of a type identifier and channel-specific builders that determine what data is sent through each channel.

```ts
import { defineNotification } from '@holo-js/notifications'

const invoicePaid = defineNotification({
  type: 'invoice-paid',
  via() {
    return ['email', 'database', 'broadcast']
  },
  build: {
    email() {
      return {
        subject: 'Invoice Paid',
        lines: ['Your invoice has been successfully paid.']
      }
    },
    database() {
      return {
        status: 'paid',
        paidAt: new Date().toISOString()
      }
    },
    broadcast() {
      return {
        event: 'invoice.paid',
        data: {
          status: 'paid'
        }
      }
    }
  }
})
```

## Passing Data To A Notification

If the message needs variables, create the notification from a function and pass the variables into that function.
The recipient passed to `notify(...)` is available as the first argument in `via(...)` and in every channel builder.

```ts
import { defineNotification, notify } from '@holo-js/notifications'

const invoicePaid = (invoice: {
  readonly id: string
  readonly number: string
}) => defineNotification({
  type: 'invoice-paid',
  via() {
    return ['email']
  },
  build: {
    email(user: { readonly name?: string }) {
      return {
        subject: `Invoice #${invoice.number} paid`,
        greeting: user.name ? `Hello ${user.name},` : undefined,
        action: {
          label: 'View invoice',
          url: `https://app.test/invoices/${invoice.id}`,
        },
      }
    },
  },
})

await notify({
  name: 'Ava',
  email: 'ava@example.com',
}, invoicePaid({
  id: 'inv-100',
  number: 'INV-100',
}))
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
