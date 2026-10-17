# Notifications

Notifications send one message to a user through several channels at once: an email, a row in their in-app inbox, and a realtime push to their browser. You write the notification once and say which channels it uses; Holo delivers to each one.

Use [mail](/mail/) when you only ever send an email. Use notifications when the same event should reach people in more than one way.

## Quick example

```ts [server/notifications/invoice-paid.ts]
import { defineNotification } from '@holo-js/notifications'

interface InvoiceRecipient {
  readonly id: string
  readonly type: string
  readonly email: string
  readonly name: string
  readonly invoiceNumber: string
}

export default defineNotification({
  type: 'invoice-paid',
  via(recipient: InvoiceRecipient) {
    return ['email', 'database']
  },
  build: {
    email(recipient) {
      return {
        subject: `Invoice ${recipient.invoiceNumber} paid`,
        greeting: `Hi ${recipient.name},`,
        lines: ['Thanks, we received your payment.'],
        action: {
          label: 'View invoice',
          url: `https://app.example.com/invoices/${recipient.invoiceNumber}`,
        },
      }
    },
    database(recipient) {
      return {
        data: {
          invoiceNumber: recipient.invoiceNumber,
          message: `Invoice ${recipient.invoiceNumber} was paid.`,
        },
      }
    },
  },
})
```

```ts [server/lib/billing.ts]
import { notify } from '@holo-js/notifications'
import invoicePaid from '../notifications/invoice-paid'

export async function markInvoicePaid(user: { id: string, email: string, name: string }, invoiceNumber: string) {
  await notify({
    id: user.id,
    type: 'users',
    email: user.email,
    name: user.name,
    invoiceNumber,
  }, invoicePaid)
}
```

The user gets an email with a button, and a row is stored in the `notifications` table for your in-app inbox.

## Install

Add notifications to an existing project, then run the migration it creates:

```bash
npx holo install notifications
npx holo migrate
```

This adds `@holo-js/notifications`, creates `config/notifications.ts`, and adds a `create_notifications` migration for the `notifications` table used by the `database` channel.

```ts [config/notifications.ts]
import { defineNotificationsConfig } from '@holo-js/notifications'

export default defineNotificationsConfig({
  table: 'notifications',
  queue: {
    afterCommit: false,
  },
})
```

| Option | Default | Description |
| --- | --- | --- |
| `table` | `'notifications'` | Table the `database` channel writes to. |
| `queue.connection` | queue default | Connection for queued notifications. |
| `queue.queue` | queue default | Queue name for queued notifications. |
| `queue.afterCommit` | `false` | Wait for the current transaction to commit before queueing. |

The `queue` settings are defaults for notifications that are already queued. They don't queue anything on their own. See [Queueing notifications](/notifications/queueing).

## What each channel needs

| Channel | Needs |
| --- | --- |
| `database` | The `notifications` migration. Works right after install. |
| `email` | [Mail](/mail/) installed (`npx holo install mail`). |
| `broadcast` | [Broadcasting](/broadcasting/) installed (`npx holo install broadcast`). |

Sending through `email` without mail installed fails that channel with `Email notifications require a configured mailer runtime`. See [Channels](/notifications/channels).

## Where notifications live

Put notification files in `server/notifications/`. There's no generator command; create the file and export the result of `defineNotification()`.

## Auth emails

When auth and notifications are both installed, Holo sends email verification and password reset messages as notifications. Publish editable copies of those notifications with:

```bash
npx holo auth:notifications:publish
```

The files land in `server/notifications/auth/`. See [Email verification](/auth/email-verification) and [Password reset](/auth/password-reset).

## Next steps

- [Writing notifications](/notifications/writing)
- [Sending notifications](/notifications/sending)
- [Channels](/notifications/channels)
- [Database notifications](/notifications/database)
- [Queueing notifications](/notifications/queueing)
