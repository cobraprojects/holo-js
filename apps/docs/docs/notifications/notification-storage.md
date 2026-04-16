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
  listNotifications, 
  listUnreadNotifications, 
  markAsRead, 
  markAsUnread,
  deleteNotifications 
} from '@holo-js/notifications/database'

// Get all notifications for a user
const notifications = await listNotifications({ userId: '123' })

// Get only unread notifications
const unread = await listUnreadNotifications({ userId: '123' })

// Mark notifications as read
await markAsRead(['notif_1', 'notif_2', 'notif_3'])

// Mark notifications as unread
await markAsUnread(['notif_4', 'notif_5'])

// Delete notifications
await deleteNotifications(['notif_6', 'notif_7'])
```

## Querying Notifications

You can filter notifications when listing them:

```ts
// Get notifications by type
const invoices = await listNotifications({ 
  userId: '123',
  type: 'invoice-paid'
})

// Get notifications created after a specific date
const recent = await listNotifications({ 
  userId: '123',
  createdAfter: new Date(Date.now() - 86400000) // Last 24 hours
})
```

## Marking as Read/Unread

```ts
// Mark specific notifications as read
await markAsRead(['notif_1', 'notif_2', 'notif_3'])

// Mark all notifications as read for a user
await markAsReadForUser('123')

// Mark specific notifications as unread
await markAsUnread(['notif_4', 'notif_5'])

// Mark all notifications as unread for a user
await markAsUnreadForUser('123')
```