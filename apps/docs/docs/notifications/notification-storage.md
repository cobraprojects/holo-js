# Notification Storage

When using the database channel, notifications are automatically stored in a `notifications` table with the following schema:

- `id` - Unique identifier for the notification
- `type` - The notification type string
- `notifiable_type` - The type of the entity receiving the notification (e.g., 'User')
- `notifiable_id` - The ID of the entity receiving the notification
- `data` - JSON payload containing the notification data
- `read_at` - Timestamp when the notification was marked as read (null if unread)
- `created_at` - When the notification was created
- `updated_at` - When the notification was last updated

## Working with Stored Notifications

Holo-JS provides helper functions for working with stored notifications:

```ts
import {
  deleteNotifications,
  listNotifications,
  markNotificationsAsRead,
  markNotificationsAsUnread,
  unreadNotifications,
} from '@holo-js/notifications'

const recipient = { id: 'user-1', type: 'users' }

const notifications = await listNotifications(
  { recipient },
  { limit: 20, offset: 0 },
)

const unread = await unreadNotifications(
  { recipient },
  { limit: 20, offset: 0 },
)

await markNotificationsAsRead({ recipient }, ['notif_1', 'notif_2', 'notif_3'])
await markNotificationsAsUnread({ recipient }, ['notif_4', 'notif_5'])
await deleteNotifications({ recipient }, ['notif_6', 'notif_7'])
```

The first argument selects the recipient's notifications. The second argument controls pagination. Both list helpers
return `records`, `total`, and `unread`.

Add `type` or `dataMatches` only when the page needs narrower results:

```ts
const paidInvoices = await listNotifications(
  {
    recipient,
    type: 'invoice-paid',
    dataMatches: [{ path: ['accountId'], value: 'account-1' }],
  },
  { limit: 20, offset: 0 },
)
```

Data-match paths must be defined by trusted server code. Never accept paths, recipient types, notification types, or
scope values directly from a browser request.

## Marking as Read/Unread

```ts
await markNotificationsAsRead(
  { recipient },
  ['notif_1', 'notif_2', 'notif_3'],
)

await markNotificationsAsUnread(
  { recipient },
  ['notif_4', 'notif_5'],
)
```
