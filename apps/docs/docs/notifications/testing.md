# Testing Notifications

When testing your application, you may want to inspect notifications without actually sending them. Holo-JS provides a fake notification driver for this purpose.

## Using the Fake Notification Driver

First, configure your application to use the fake driver in your test environment:

```ts
// config/notifications.ts
export default defineNotificationsConfig({
  default: 'fake',
  channels: {
    fake: {
      driver: 'fake'
    }
  }
})
```

## Inspecting Sent Notifications

Then in your tests, you can inspect sent notifications:

```ts
import { fakeNotificationData } from '@holo-js/notifications'

test('sends welcome notification when user registers', async () => {
  // Perform user registration
  await registerUser({ email: 'test@example.com' })
  
  // Get the sent notifications
  const notifications = fakeNotificationData()
  
  // Assert notifications were sent
  expect(notifications).toHaveLength(1)
  expect(notifications[0].type).toBe('welcome')
  expect(notifications[0].to).toContainEqual({
    email: 'test@example.com'
  })
})
```

## Fake Notification Data Structure

The `fakeNotificationData()` function returns an array of sent notification objects with the following structure:

```ts
{
  type: string,
  via: string[], // Array of channels the notification was sent through
  to: Array<{ 
    email: string, 
    name?: string 
  }>, // For email channel targets
  userId?: string, // For database channel targets
  channels: string[], // For broadcast channel targets
  // ... channel-specific data based on via() return value
}
```

## Testing with Different Drivers

You can also test with other drivers by changing your test configuration:

```ts
// For logging notifications during test
export default defineNotificationsConfig({
  default: 'log'
})

// For storing notifications in database during test
export default defineNotificationsConfig({
  default: 'database'
})
```

## Asserting Notification Content

You can make detailed assertions about notification content:

```ts
import { fakeNotificationData } from '@holo-js/notifications'

test('notification contains correct data', async () => {
  // Trigger notification
  await processInvoicePayment({ invoiceId: 'INV-123', amount: 100 })
  
  // Get sent notifications
  const notifications = fakeNotificationData()
  
  // Assert email notification content
  const emailNotification = notifications.find(n => 
    n.type === 'invoice-paid' && 
    n.via.includes('email')
  )
  
  expect(emailNotification).toBeDefined()
  expect(emailNotification.to).toContainEqual({
    email: 'customer@example.com'
  })
  
  // Assert database notification content
  const databaseNotification = notifications.find(n => 
    n.type === 'invoice-paid' && 
    n.via.includes('database')
  )
  
  expect(databaseNotification).toBeDefined()
  expect(databaseNotification.userId).toBe('user-123')
})
```

## Testing On-Demand Notifications

```ts
import { notifyUsing, fakeNotificationData } from '@holo-js/notifications'

test('sends on-demand notification', async () => {
  // Send on-demand notification
  await notifyUsing()
    .channel('email', {
      email: 'admin@example.com',
      name: 'Admin User'
    })
    .notify(invoicePaid)
  
  // Get sent notifications
  const notifications = fakeNotificationData()
  
  // Assert notification was sent to correct target
  expect(notifications).toHaveLength(1)
  expect(notifications[0].to).toContainEqual({
    email: 'admin@example.com',
    name: 'Admin User'
  })
})
```