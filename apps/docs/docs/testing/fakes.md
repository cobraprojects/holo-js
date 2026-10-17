# Faking Services

In tests you don't want to send real email, call notification providers, or wait for a queue worker. Holo has test-friendly drivers for these services and records what your code did, so you can check it.

This page assumes the Vitest setup from [Testing Your App](/testing/).

## Mail

Use the `fake` mailer. It records every message instead of sending it:

```ini [.env.test]
MAIL_MAILER=fake
```

This works with the `config/mail.ts` that `holo install mail` creates, which reads `MAIL_MAILER` and already defines a `fake` mailer.

Read the recorded messages with `listFakeSentMails()` and clear them with `resetFakeSentMails()`:

```ts [tests/welcome-mail.test.ts]
import { beforeEach, expect, it } from 'vitest'
import { listFakeSentMails, resetFakeSentMails } from '@holo-js/mail'
import { registerUser } from '../server/lib/users'

beforeEach(() => {
  resetFakeSentMails()
})

it('sends a welcome email on sign-up', async () => {
  await registerUser({ name: 'Ada', email: 'ada@example.com', password: 'secret-password' })

  const sent = listFakeSentMails()

  expect(sent).toHaveLength(1)
  expect(sent[0]?.mail.to).toContainEqual(expect.objectContaining({ email: 'ada@example.com' }))
  expect(sent[0]?.mail.subject).toBe('Welcome, Ada')
})
```

Each record has:

| Field | Description |
| --- | --- |
| `mail` | The final message: `to`, `cc`, `bcc`, `from`, `replyTo`, `subject`, `html`, `text`, `attachments`, `headers`, `tags`. |
| `messageId` | The ID the fake driver gave the message. |
| `createdAt` | When it was recorded. |

Queued mail is recorded too, as long as the queue runs jobs right away (`QUEUE_CONNECTION=sync`, see [Queues](#queues)).

See [Testing Mail](/mail/testing) for more.

## Notifications

Email notifications go through the mail package, so with `MAIL_MAILER=fake` they show up in `listFakeSentMails()`.

You can also check the result `notify()` returns. It lists every channel it tried and whether it succeeded:

```ts [tests/invoice-notification.test.ts]
import { expect, it } from 'vitest'
import { notify } from '@holo-js/notifications'
import InvoicePaid from '../server/notifications/invoice-paid'
import User from '../server/models/User'

it('notifies the customer', async () => {
  const user = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'secret-password' })

  const result = await notify(user, InvoicePaid)

  expect(result.channels).toContainEqual(expect.objectContaining({
    channel: 'email',
    success: true,
  }))
})
```

Each entry in `result.channels` has `channel`, `targetIndex`, `queued`, `success`, and, when something failed, `error`.

### Replace a channel

To capture what a channel receives, register an in-memory channel. Pass `replaceExisting: true` to replace a channel that's already registered:

```ts [tests/setup-notifications.ts]
import { registerNotificationChannel } from '@holo-js/notifications'

export const smsMessages: unknown[] = []

registerNotificationChannel('sms', {
  async send(context) {
    smsMessages.push(context.payload)
  },
}, { replaceExisting: true })
```

`context` also includes the `notifiable` and its `route`. See [Testing Notifications](/notifications/testing) and [Custom Channels](/notifications/custom-channels).

## Events

Dispatching an event returns how many listeners ran:

```ts [tests/post-saved.test.ts]
import { expect, it } from 'vitest'
import BlogPostSaved from '../server/events/blog/post-saved'

it('runs the post-saved listeners', async () => {
  const result = await BlogPostSaved.dispatch({
    action: 'created',
    postId: 1,
    title: 'Hello',
    status: 'published',
    slug: 'hello',
  })

  expect(result.syncListeners).toBeGreaterThan(0)
})
```

### Spy on an event

To see the payload your code dispatched, register a temporary listener and remove it after the test:

```ts [tests/publish-post.test.ts]
import { afterEach, expect, it } from 'vitest'
import { defineListener, registerListener, unregisterListener } from '@holo-js/events'
import BlogPostSaved from '../server/events/blog/post-saved'
import { createPost } from '../server/lib/blog'

const received: unknown[] = []

afterEach(() => {
  unregisterListener('test.post-saved-spy')
  received.length = 0
})

it('dispatches post-saved when a post is created', async () => {
  registerListener(defineListener({
    listensTo: [BlogPostSaved],
    handle(event) {
      received.push(event.payload)
    },
  }), { id: 'test.post-saved-spy' })

  await createPost({ title: 'Hello', body: 'First post', status: 'published' })

  expect(received).toContainEqual(expect.objectContaining({ action: 'created', title: 'Hello' }))
})
```

See [Events](/events/) and [Listeners](/events/listeners).

## Queues

Set the queue to `sync` in tests. Jobs then run immediately, inside the same test, so you check their effects right after dispatching:

```ini [.env.test]
QUEUE_CONNECTION=sync
```

```ts [tests/index-post.test.ts]
import { expect, it } from 'vitest'
import IndexBlogPost from '../server/jobs/blog/index-post'
import PostFactory from '../server/db/factories/PostFactory'

it('indexes a post', async () => {
  const post = await PostFactory.createOne()

  const result = await IndexBlogPost.dispatchSync({ action: 'created', postId: post.id })

  expect(result.indexed).toBe(true)
})
```

`dispatchSync()` runs the job right away and returns what `handle()` returned, whatever the queue connection.

To test that a job was **queued** rather than run, use the `database` queue driver for that test suite and look at the `jobs` table:

```ts
import { DB } from '@holo-js/db'

const queued = await DB.table('jobs').where('job', 'blog.index-post').count()
```

See [Writing Jobs](/queue/jobs).

## Broadcasting

Use the `null` connection to drop broadcasts, or `log` to write them to the log:

```ini [.env.test]
BROADCAST_CONNECTION=null
```

Both connections exist in the `config/broadcast.ts` that `holo install broadcast` creates. See [Broadcast Drivers and Config](/broadcasting/drivers).

## Storage

Point your disks at a throwaway folder so tests don't write into `storage/app`. Holo checks `STORAGE_DISKS_<DISK>_ROOT` in the process environment for every disk, so set it in your Vitest config:

```ts [vitest.config.ts]
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    env: {
      APP_ENV: 'test',
      STORAGE_DISKS_LOCAL_ROOT: './storage/testing/app',
      STORAGE_DISKS_PUBLIC_ROOT: './storage/testing/public',
    },
  },
})
```

Delete that folder in your global setup to start each run clean. See [Environment Variables](/reference/environment#override-any-disk-from-the-environment).

## Next steps

- [Database Tests](/testing/database)
- [Testing Mail](/mail/testing)
- [Testing Notifications](/notifications/testing)
