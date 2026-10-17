# Testing Notifications

Test notifications by sending them for real against a test database, then checking what each channel produced: the delivery result, the stored inbox rows, and the emails captured by the fake mailer.

```ts [tests/comments.test.ts]
import { afterEach, expect, it } from 'vitest'
import { listFakeSentMails, resetFakeSentMails } from '@holo-js/mail'
import { listNotifications, notify } from '@holo-js/notifications'
import commentPosted from '../server/notifications/comment-posted'

afterEach(() => {
  resetFakeSentMails()
})

it('emails the author and adds an inbox entry', async () => {
  const result = await notify({
    id: 'user-1',
    type: 'users',
    email: 'ava@example.com',
    name: 'Ava',
    postTitle: 'Hello Holo',
    commentUrl: 'https://blog.example.com/posts/hello-holo#comments',
  }, commentPosted)

  expect(result.channels.every(delivery => delivery.success)).toBe(true)

  expect(listFakeSentMails()[0]?.mail.subject).toBe('New comment on "Hello Holo"')

  const inbox = await listNotifications(
    { recipient: { id: 'user-1', type: 'users' } },
    { limit: 10, offset: 0 },
  )
  expect(inbox.records[0]?.data).toEqual({
    postTitle: 'Hello Holo',
    url: 'https://blog.example.com/posts/hello-holo#comments',
  })
})
```

## Set up the test environment

- Use the `fake` mailer so `email` notifications are captured instead of sent: set `MAIL_MAILER=fake` in `.env.test`. See [Testing mail](/mail/testing).
- Run your migrations against a test database so the `database` channel has its table. See [Database tests](/testing/database).
- Use the `sync` queue driver so queued notifications are delivered inside the test.

## Assert the delivery result

The awaited result lists every channel's outcome. Check it when the test cares about which channels ran:

```ts
const result = await notify(recipient, commentPosted)

expect(result.channels).toEqual([
  expect.objectContaining({ channel: 'email', success: true, queued: false }),
  expect.objectContaining({ channel: 'database', success: true, queued: false }),
])
```

See [Notification events](/notifications/events) for every field.

## Test channel choice

When `via()` depends on the recipient, like the [`wantsEmail` example](/notifications/writing#choose-channels), assert the channels that come back:

```ts
const result = await notify({ ...recipient, wantsEmail: false }, commentPostedWithPreferences)

expect(result.channels.map(delivery => delivery.channel)).toEqual(['database'])
```

## Replace a channel in tests

Channels like `broadcast` or a [custom channel](/notifications/custom-channels) talk to outside services. Swap one for a recorder by registering a channel with the same name:

```ts
import { afterEach, beforeEach } from 'vitest'
import {
  type NotificationSendContext,
  registerNotificationChannel,
  resetNotificationChannelRegistry,
} from '@holo-js/notifications'

const broadcasts: NotificationSendContext[] = []

beforeEach(() => {
  broadcasts.length = 0
  registerNotificationChannel('broadcast', {
    send(context) {
      broadcasts.push(context)
    },
  }, { replaceExisting: true })
})

afterEach(() => {
  resetNotificationChannelRegistry()
})
```

Registered channels take priority over built-in ones, so each `broadcast` delivery lands in `broadcasts`, where you can check `payload`, `route`, and `notificationType`.

`resetNotificationChannelRegistry()` removes every registered channel. If your app registers custom channels at startup, register them again after resetting.

## Test on-demand notifications

```ts
import { notifyUsing } from '@holo-js/notifications'

const result = await notifyUsing()
  .channel('email', 'sales@example.com')
  .notify(newOrder)

expect(result.channels[0]?.success).toBe(true)
expect(listFakeSentMails()[0]?.mail.to).toEqual([{ email: 'sales@example.com' }])
```

## Next steps

- [Testing mail](/mail/testing)
- [Faking services](/testing/fakes)
- [Database tests](/testing/database)
