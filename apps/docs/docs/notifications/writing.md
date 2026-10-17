# Writing Notifications

A notification has three parts: a `type` that names it, a `via()` function that picks the channels, and a `build` object with one function per channel that returns that channel's message.

```ts [server/notifications/comment-posted.ts]
import { defineNotification } from '@holo-js/notifications'

interface CommentRecipient {
  readonly id: string
  readonly type: string
  readonly email: string
  readonly name: string
  readonly postTitle: string
  readonly commentUrl: string
}

export default defineNotification({
  type: 'comment-posted',
  via(recipient: CommentRecipient) {
    return ['email', 'database']
  },
  build: {
    email(recipient) {
      return {
        subject: `New comment on "${recipient.postTitle}"`,
        lines: ['Someone replied to your post.'],
        action: { label: 'Read the comment', url: recipient.commentUrl },
      }
    },
    database(recipient) {
      return {
        data: {
          postTitle: recipient.postTitle,
          url: recipient.commentUrl,
        },
      }
    },
  },
})
```

## The recipient

The first argument to `notify()` is the **recipient** (sometimes called the notifiable). Holo passes the same object to `via()` and to every builder in `build`.

Put everything the notification needs on that object: the fields Holo uses to reach the person (like `email`), plus the values your message uses (like `postTitle`). See [how Holo finds where to deliver](/notifications/sending#where-holo-delivers).

Type the recipient once, on the `via()` parameter. The builders pick up that type automatically, and `notify()` rejects recipients with the wrong shape:

```ts
via(recipient: CommentRecipient) {
  return ['email', 'database']
},
build: {
  email(recipient) {
    return { subject: recipient.postTitle }
  },
},
```

## The type

`type` is a name for the notification, such as `'comment-posted'`. The `database` channel stores it with each row, so you can [filter the inbox](/notifications/database#filter-notifications) by it. Keep it stable once notifications are stored.

## Choose channels

`via()` returns the channel names to deliver through. Every name it returns needs a matching builder in `build`, and TypeScript reports an error if one is missing.

Return different channels depending on the recipient:

```ts
via(recipient: CommentRecipient & { readonly wantsEmail: boolean }) {
  return recipient.wantsEmail ? ['email', 'database'] : ['database']
},
```

`via()` and each builder also receive a context object as their second argument. `context.anonymous` is `true` for [on-demand notifications](/notifications/sending#send-to-an-address-on-demand), and builders also get `context.channel`.

## Build each channel's message

Each builder returns the message for one channel. The built-in channels expect these shapes:

```ts
build: {
  email() {
    return { subject: 'Your export is ready', lines: ['Download it from your dashboard.'] }
  },
  database() {
    return { data: { exportId: 'exp_42' } }
  },
  broadcast() {
    return { event: 'export.ready', data: { exportId: 'exp_42' } }
  },
},
```

See [Channels](/notifications/channels) for every field, and [Custom channels](/notifications/custom-channels) to add your own, such as Slack or SMS.

::: warning
Builders run when you call `notify()`, even for queued notifications. Holo stores the built message, not the builder, so keep builders fast and free of side effects. Database and broadcast `data` must be JSON-serializable.
:::

## Queue and delay by default

A notification can declare that it should always be queued or delayed:

```ts
export default defineNotification({
  type: 'weekly-summary',
  via(recipient: { readonly id: string, readonly type: string, readonly email: string }) {
    return ['email', 'database']
  },
  queue: { queue: 'notifications' },
  delay: { email: 60 },
  build: {
    email() {
      return { subject: 'Your weekly summary' }
    },
    database() {
      return { data: { summary: 'weekly' } }
    },
  },
})
```

See [Queueing notifications](/notifications/queueing) for all forms of `queue` and `delay`.

## Available options

Everything you can set on `defineNotification()`, plus the fields each built-in channel builder returns.

**Definition options**

- [type](#type)
- [via()](#via)
- [build](#build)
- [queue](#queue)
- [delay](#delay)

**Helpers**

- [defineNotification()](#definenotification)
- [isNotificationDefinition()](#isnotificationdefinition)

**Email builder fields**

<div class="method-list">

- [email: subject](#email-subject)
- [email: greeting](#email-greeting)
- [email: lines](#email-lines)
- [email: action](#email-action)
- [email: html](#email-html)
- [email: text](#email-text)
- [email: metadata](#email-metadata)

</div>

**Database builder fields**

- [database: data](#database-data)

**Broadcast builder fields**

- [broadcast: event](#broadcast-event)
- [broadcast: data](#broadcast-data)

**Builder context**

- [context](#context)

### defineNotification()

Checks a notification and returns it, ready to pass to `notify()`. It throws when `via()` or `build` is missing, when `build` has no channels, or when a builder isn't a function.

```ts
export default defineNotification({
  type: 'comment-posted',
  via: () => ['database'],
  build: { database: () => ({ data: {} }) },
})
```

### isNotificationDefinition()

Returns `true` for a value that has `via()` and `build`. Use it to check that a value is a notification before you pass it along.

```ts
import { isNotificationDefinition } from '@holo-js/notifications'

if (isNotificationDefinition(value)) {
  await notify(recipient, value)
}
```

### type

An optional name for the notification, such as `'comment-posted'`. Database rows store it, so you can filter the inbox by it. Keep the name stable once notifications are stored.

```ts
defineNotification({ type: 'comment-posted', via: () => ['database'], build: { database: () => ({ data: {} }) } })
```

### via()

Required. Receives the recipient and returns the channel names to deliver through. Each name needs a matching builder in `build`.

```ts
via(recipient: CommentRecipient) {
  return recipient.wantsEmail ? ['email', 'database'] : ['database']
}
```

### build

Required. An object with one builder per channel. Each builder receives `(recipient, context)` and returns that channel's message. Builders run when you call `notify()`, even for queued notifications.

```ts
build: {
  database: () => ({ data: { exportId: 'exp_42' } }),
}
```

### queue

Queues the delivery of each channel. Pass `true`, an options object with `connection`, `queue`, `delay`, or `afterCommit`, or a function that returns one of those for each recipient and channel. Options passed to the send override these. See [Queueing notifications](/notifications/queueing).

```ts
queue: { queue: 'notifications', afterCommit: true }
```

### delay

Holds deliveries for a number of seconds, or until a `Date`. You can pass one value for every channel, an object with a value per channel such as `{ email: 600 }`, or a function. Delayed deliveries are always queued. A delay passed to the send overrides this one.

```ts
delay: { email: 600 }
```

### email: subject

Required. The subject line, also shown as the heading of the generated email.

```ts
email() {
  return { subject: 'Your export is ready' }
}
```

### email: greeting

An optional first paragraph, such as `Hi Ava,`.

```ts
email(recipient) {
  return { subject: 'Welcome', greeting: `Hi ${recipient.name},` }
}
```

### email: lines

An optional list of paragraphs. Each line is trimmed, and blank lines are dropped.

```ts
email() {
  return { subject: 'Export ready', lines: ['Your file is ready.', 'It expires in 7 days.'] }
}
```

### email: action

An optional button with a `label` and a `url`. Holo also prints the link as plain text under the button, for clients that hide buttons.

```ts
email(recipient) {
  return {
    subject: 'Reset your password',
    action: { label: 'Reset password', url: recipient.resetUrl },
  }
}
```

### email: html

An optional HTML body. When you set it, Holo sends this HTML instead of building one from `greeting`, `lines`, and `action`.

```ts
email() {
  return { subject: 'Receipt', html: '<p>Thanks for your order.</p>' }
}
```

### email: text

An optional plain-text body. If you leave it out, Holo builds one from `greeting`, `lines`, and `action`.

```ts
email() {
  return { subject: 'Receipt', text: 'Thanks for your order.' }
}
```

### email: metadata

An optional JSON object passed to the mail as its `metadata`.

```ts
email(recipient) {
  return { subject: 'Receipt', metadata: { orderId: recipient.orderId } }
}
```

### database: data

Required. A JSON value stored with the notification and returned when you read the inbox.

```ts
database(recipient) {
  return { data: { orderNumber: recipient.orderNumber } }
}
```

### broadcast: event

An optional event name that clients listen for. Defaults to `notifications.message`.

```ts
broadcast() {
  return { event: 'orders.shipped', data: {} }
}
```

### broadcast: data

The payload sent to clients. Clients receive it with the notification's `type`.

```ts
broadcast(recipient) {
  return { event: 'orders.shipped', data: { orderNumber: recipient.orderNumber } }
}
```

### context

The second argument to `via()` and to each builder. `context.anonymous` is `true` for on-demand notifications. Builders also receive `context.channel`, the name of the channel they build for.

```ts
email(recipient, context) {
  return { subject: context.anonymous ? 'Sales alert' : `Hi ${recipient.name}` }
}
```

Custom channels add their own builder names. See [Custom channels](/notifications/custom-channels).

## Next steps

- [Sending notifications](/notifications/sending)
- [Channels](/notifications/channels)
