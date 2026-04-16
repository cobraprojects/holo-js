# On-Demand Notifications

Sometimes you need to send notifications to recipients that aren't associated with a model, or you want to specify the notification target directly. For these cases, you can use the `notifyUsing` function.

## Anonymous Notification Targets

```ts
import { notifyUsing } from '@holo-js/notifications'

await notifyUsing()
  .channel('email', {
    email: 'user@example.com',
    name: 'User Name'
  })
  .channel('broadcast', {
    channels: ['private-user.123']
  })
  .notify(invoicePaid)
```

## Multiple Channels with On-Demand Targets

You can specify different targets for different channels:

```ts
await notifyUsing()
  .channel('email', {
    email: 'admin@example.com'
  })
  .channel('database', {
    // For database channel, you might want to store it for a specific user
    userId: '123'
  })
  .notify(invoicePaid)
```