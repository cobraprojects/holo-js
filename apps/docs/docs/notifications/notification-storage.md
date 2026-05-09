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

// Get all notifications for a user
const notifications = await listNotifications({ id: 'user-1', type: 'users' })

// Get only unread notifications
const unread = await unreadNotifications({ id: 'user-1', type: 'users' })

// Mark notifications as read
await markNotificationsAsRead(['notif_1', 'notif_2', 'notif_3'])

// Mark notifications as unread
await markNotificationsAsUnread(['notif_4', 'notif_5'])

// Delete notifications
await deleteNotifications(['notif_6', 'notif_7'])
```

## Marking as Read/Unread

```ts
// Mark specific notifications as read
await markNotificationsAsRead(['notif_1', 'notif_2', 'notif_3'])

// Mark specific notifications as unread
await markNotificationsAsUnread(['notif_4', 'notif_5'])
```
