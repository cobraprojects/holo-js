# Database Notifications

The `database` channel saves each notification as a row, so you can build an in-app inbox with unread counts and "mark as read". Holo gives you helpers to list, mark, and delete a recipient's notifications.

```ts [server/lib/inbox.ts]
import { listNotifications, markNotificationsAsRead } from '@holo-js/notifications'

export async function getInbox(userId: string, page = 1) {
  const recipient = { id: userId, type: 'users' }

  return listNotifications({ recipient }, { limit: 20, offset: (page - 1) * 20 })
}

export async function markRead(userId: string, notificationIds: readonly string[]) {
  return markNotificationsAsRead({ recipient: { id: userId, type: 'users' } }, notificationIds)
}
```

## Set up the table

`npx holo install notifications` creates a `create_notifications` migration. Run it with `npx holo migrate`. The table has these columns:

| Column | Contents |
| --- | --- |
| `id` | Notification ID (a UUID). |
| `type` | The notification's `type`, such as `'invoice-paid'`. |
| `notifiable_type`, `notifiable_id` | The recipient's `type` and `id`. |
| `data` | The JSON returned by the `database` builder. |
| `read_at` | When it was read, or `null`. |
| `created_at`, `updated_at` | Timestamps. |

To use a different table name, change `table` in `config/notifications.ts` and the table name in the migration.

## Store a notification

Return a `database` channel from `via()` and a `data` object from the builder. The recipient needs an `id` and a `type`:

```ts
await notify({ id: user.id, type: 'users', invoiceNumber: 'INV-100' }, invoicePaid)
```

See [Channels](/notifications/channels#database).

## Read the inbox

Every helper takes a **query** as its first argument. The query always includes the `recipient`, and only ever touches that recipient's rows.

```ts
import { listNotifications, unreadNotifications } from '@holo-js/notifications'

const recipient = { id: userId, type: 'users' }

const all = await listNotifications({ recipient }, { limit: 20, offset: 0 })
const unread = await unreadNotifications({ recipient }, { limit: 20, offset: 0 })
```

Both return a page, newest first:

| Field | Contents |
| --- | --- |
| `records` | The notifications on this page. |
| `total` | Matching notifications across all pages (for `unreadNotifications()`, the unread ones). |
| `unread` | Unread notifications matching the query. Use it for a badge count. |
| `limit`, `offset` | The pagination you passed. |

`limit` must be between 1 and 100. `offset` must be between 0 and 1,000,000.

Each record has `id`, `type`, `notifiableType`, `notifiableId`, `data`, `readAt` (a `Date` or `null`), `createdAt`, and `updatedAt`.

## Filter notifications

Narrow the query by notification `type`, by one notification `id`, or by values inside `data`:

```ts
const paidInvoices = await listNotifications({
  recipient,
  type: 'invoice-paid',
  dataMatches: [{ path: ['account', 'id'], value: 'acct_1' }],
}, { limit: 20, offset: 0 })
```

Each `dataMatches` entry compares the value at a path in `data` with a string, number, boolean, or `null`. Path segments may only contain letters, numbers, `_`, and `-`. A query accepts up to 32 matches, each with up to 16 path segments.

## Mark as read or unread

```ts
import {
  markAllNotificationsAsRead,
  markNotificationsAsRead,
  markNotificationsAsUnread,
} from '@holo-js/notifications'

await markNotificationsAsRead({ recipient }, ['3f1c...', '9a2b...'])
await markNotificationsAsUnread({ recipient }, ['3f1c...'])
await markAllNotificationsAsRead({ recipient })
await markAllNotificationsAsRead({ recipient, type: 'comment-posted' })
```

Each returns the number of rows it changed. The ID-based helpers accept up to 100 IDs per call; use `markAllNotificationsAsRead()` with a query to update more.

## Delete notifications

```ts
import { clearNotifications, deleteNotifications } from '@holo-js/notifications'

await deleteNotifications({ recipient }, ['3f1c...'])
await clearNotifications({ recipient, type: 'comment-posted' })
await clearNotifications({ recipient })
```

`deleteNotifications()` removes specific IDs (up to 100). `clearNotifications()` removes everything that matches the query. Both return the number of rows deleted.

::: danger
Always build `recipient` from the signed-in user on the server, never from request input. Accepting a recipient `id` or `type` from the browser would let anyone read or delete another user's notifications. The same goes for `type` and `dataMatches` paths: define them in server code. Notification IDs from the request are safe to pass, because the query still limits changes to the recipient's own rows.
:::

## Available methods

Each helper takes a [query](#query) that limits it to one recipient. The read helpers also take a [pagination](#pagination) object.

**Read**

- [listNotifications()](#listnotifications)
- [unreadNotifications()](#unreadnotifications)

**Mark**

- [markNotificationsAsRead()](#marknotificationsasread)
- [markNotificationsAsUnread()](#marknotificationsasunread)
- [markAllNotificationsAsRead()](#markallnotificationsasread)

**Delete**

- [deleteNotifications()](#deletenotifications)
- [clearNotifications()](#clearnotifications)

**Shapes**

- [query](#query)
- [pagination](#pagination)
- [page](#page)
- [record](#record)

### listNotifications()

Returns one page of the recipient's notifications, newest first. Pass the [query](#query) and a [pagination](#pagination) object.

```ts
const page = await listNotifications({ recipient }, { limit: 20, offset: 0 })
```

### unreadNotifications()

Returns one page of the recipient's unread notifications, newest first. Its `total` counts only unread notifications.

```ts
const unread = await unreadNotifications({ recipient }, { limit: 20, offset: 0 })
const badgeCount = unread.unread
```

### markNotificationsAsRead()

Marks the given notification IDs as read and returns how many changed. Pass up to 100 IDs. Duplicate IDs are ignored, and blank IDs throw.

```ts
await markNotificationsAsRead({ recipient }, ['3f1c...', '9a2b...'])
```

### markNotificationsAsUnread()

Marks the given notification IDs as unread and returns how many changed. It accepts the same IDs as `markNotificationsAsRead()`.

```ts
await markNotificationsAsUnread({ recipient }, ['3f1c...'])
```

### markAllNotificationsAsRead()

Marks every notification that matches the query as read, without a list of IDs. Add `type` or `dataMatches` to narrow it. Returns how many changed.

```ts
await markAllNotificationsAsRead({ recipient, type: 'comment-posted' })
```

### deleteNotifications()

Deletes the given notification IDs and returns how many were removed. Pass up to 100 IDs.

```ts
await deleteNotifications({ recipient }, ['3f1c...'])
```

### clearNotifications()

Deletes every notification that matches the query and returns how many were removed. Call it with only `recipient` to clear the whole inbox.

```ts
await clearNotifications({ recipient, type: 'comment-posted' })
```

### query

The filter for every helper. `recipient` is required and holds the recipient's `id` and `type`. The other fields are optional:

- `id`: one notification ID, 1 to 200 characters.
- `type`: only notifications with this type.
- `dataMatches`: only notifications whose `data` has the given values at the given paths.

```ts
const query = {
  recipient: { id: userId, type: 'users' },
  type: 'invoice-paid',
  dataMatches: [{ path: ['account', 'id'], value: 'acct_1' }],
}
```

Each `dataMatches` entry takes a `path` of 1 to 16 segments and a `value` that's a string, number, boolean, or `null`. Segments may contain letters, numbers, `_`, and `-`. A query accepts up to 32 matches.

### pagination

The `{ limit, offset }` object for the read helpers. `limit` is an integer from 1 to 100. `offset` is an integer from 0 to 1,000,000.

```ts
{ limit: 20, offset: 40 }
```

### page

The result of `listNotifications()` and `unreadNotifications()`. It has `records`, the notifications on this page, plus `limit`, `offset`, `total` (matching notifications across all pages), and `unread`.

```ts
const { records, total, unread } = await listNotifications({ recipient }, { limit: 20, offset: 0 })
```

### record

One stored notification. It has `id`, `type`, `notifiableType`, `notifiableId`, `data`, `readAt` (a `Date` or `null`), `createdAt`, and `updatedAt`.

```ts
const [latest] = page.records
latest?.readAt === null
```

## Next steps

- [Broadcast new notifications in realtime](/notifications/channels#broadcast)
- [Sending notifications](/notifications/sending)
- [Testing notifications](/notifications/testing)
