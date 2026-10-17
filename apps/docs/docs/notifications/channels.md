# Notification Channels

A channel is one way of reaching someone. Holo ships three: `email`, `database`, and `broadcast`. Each builder in a notification's `build` object returns the message for one channel.

```ts
build: {
  email() {
    return { subject: 'Your export is ready', lines: ['Download it from your dashboard.'] }
  },
  database() {
    return { data: { exportId: 'exp_42', message: 'Your export is ready.' } }
  },
  broadcast() {
    return { event: 'export.ready', data: { exportId: 'exp_42' } }
  },
},
```

## Email

The `email` channel sends an email through [mail](/mail/), so `@holo-js/mail` must be installed. It uses your default mailer and the sender from `config/mail.ts`, and goes to the recipient's `email` (and `name`).

```ts
email(recipient) {
  return {
    subject: 'Reset your password',
    greeting: `Hi ${recipient.name},`,
    lines: [
      'Click the button below to choose a new password.',
      'This link expires in 60 minutes.',
    ],
    action: {
      label: 'Reset password',
      url: recipient.resetUrl,
    },
  }
},
```

| Field | Type | Description |
| --- | --- | --- |
| `subject` | `string` | Required. The subject, also shown as the heading. |
| `greeting` | `string` | First paragraph, such as `Hi Ava,`. |
| `lines` | `string[]` | One paragraph per line. |
| `action` | `{ label, url }` | A button, plus a plain link underneath for clients that hide buttons. |
| `html` | `string` | Your own HTML body. Replaces the generated layout. |
| `text` | `string` | Your own plain-text body. |
| `metadata` | JSON object | Passed to the mail as `metadata`. |

Holo builds a simple HTML email from `subject`, `greeting`, `lines`, and `action`, escaping all of them. It also builds a plain-text version unless you pass `text`.

The email channel supports only these fields. If you need attachments, `cc`, or a custom sender, send a [mail](/mail/sending) directly instead.

::: tip
Email notifications are real mail sends, so they follow your mail config: they show up in the [preview driver](/mail/previewing#save-every-sent-email) during development and in [`listFakeSentMails()`](/mail/testing) in tests.
:::

## Database

The `database` channel stores a row in the `notifications` table so you can show an in-app inbox. It needs the migration created by `npx holo install notifications`.

```ts
database(recipient) {
  return {
    data: {
      orderNumber: recipient.orderNumber,
      message: `Order ${recipient.orderNumber} has shipped.`,
    },
  }
},
```

| Field | Type | Description |
| --- | --- | --- |
| `data` | JSON value | Required. Stored in the `data` column and returned when you read the inbox. |

The row is tied to the recipient's `id` and `type`. Read it back, mark it as read, and delete it with the helpers in [Database notifications](/notifications/database).

## Broadcast

The `broadcast` channel pushes the notification to the browser in realtime through [broadcasting](/broadcasting/). It needs `@holo-js/broadcast` installed and configured.

```ts
broadcast(recipient) {
  return {
    event: 'orders.shipped',
    data: { orderNumber: recipient.orderNumber },
  }
},
```

| Field | Type | Description |
| --- | --- | --- |
| `event` | `string` | Event name clients listen for. Defaults to `'notifications.message'`. |
| `data` | JSON value | Required. The payload. |

Clients receive a payload of `{ type, data }`, where `type` is the notification's `type`.

The broadcast channel names come from the recipient. Add a `broadcastChannels` property or method, or a `routeNotificationForBroadcast()` method:

```ts
await notify({
  id: user.id,
  type: 'users',
  broadcastChannels: [`private-users.${user.id}`],
  orderNumber: 'A-1001',
}, orderShipped)
```

See [Events and channels](/broadcasting/events-and-channels) for authorizing private channels and [Listening on the client](/broadcasting/client) for receiving the event.

## Custom channels

Need Slack, SMS, or a webhook? Register your own channel and use its name in `via()` like a built-in one. See [Custom channels](/notifications/custom-channels).

## Next steps

- [Database notifications](/notifications/database)
- [Custom channels](/notifications/custom-channels)
- [Sending notifications](/notifications/sending)
