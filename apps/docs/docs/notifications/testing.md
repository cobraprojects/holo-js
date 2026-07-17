# Testing Notifications

Notification dispatches return a structured result for every target and channel. Tests can assert these results and
replace external channels with an in-memory registered channel.

## Registering a test channel

```ts
import { registerNotificationChannel } from '@holo-js/notifications'

const deliveries: unknown[] = []

registerNotificationChannel('test', {
  async send(context) {
    deliveries.push(context)
    return { delivered: true }
  }
})
```

## Inspecting Sent Notifications

Then in your tests, you can inspect sent notifications:

```ts
import { notify } from '@holo-js/notifications'

test('sends welcome notification when user registers', async () => {
  // Perform user registration
  await registerUser({ email: 'test@example.com' })
  
  const result = await notify(user, welcomeNotification)

  expect(result.channels).toContainEqual(expect.objectContaining({
    channel: 'test',
    success: true,
    queued: false
  }))
})
```

## Dispatch result structure

Every awaited notification dispatch returns:

```ts
type NotificationDispatchResult = {
  totalTargets: number
  channels: Array<{
    channel: string
    targetIndex: number
    queued: boolean
    success: boolean
    deferred?: boolean
    result?: unknown
    error?: unknown
  }>
  deferred?: boolean
}
```

## Asserting Notification Content

You can make detailed assertions about notification content:

```ts
import { notify } from '@holo-js/notifications'

test('notification contains correct data', async () => {
  const result = await notify(customer, invoicePaid)

  expect(result.channels).toEqual(expect.arrayContaining([
    expect.objectContaining({ channel: 'email', success: true }),
    expect.objectContaining({ channel: 'database', success: true })
  ]))
})
```

## Testing On-Demand Notifications

```ts
import { notifyUsing } from '@holo-js/notifications'

test('sends on-demand notification', async () => {
  // Send on-demand notification
  const result = await notifyUsing()
    .channel('email', {
      email: 'admin@example.com',
      name: 'Admin User'
    })
    .notify(invoicePaid)
  
  expect(result.channels).toContainEqual(expect.objectContaining({
    channel: 'email',
    success: true
  }))
})
```
