# Custom Channels

Custom channels use the same notification pipeline as built-in channels. Register the channel once, then return its
name from `via(...)` and provide a matching payload builder under `build`.

## Register a custom channel

```ts
import {
  type NotificationChannel,
  registerNotificationChannel,
} from '@holo-js/notifications'

declare module '@holo-js/notifications' {
  interface HoloNotificationChannelRegistry {
    readonly slack: NotificationChannel<
      { readonly webhook: string },
      { readonly text: string },
      void
    >
  }
}

registerNotificationChannel('slack', {
  validateRoute(route) {
    if (!route.webhook.startsWith('https://')) {
      throw new Error('Slack webhooks must use https.')
    }

    return route
  },
  async send({ route, payload }) {
    await fetch(route.webhook, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        text: payload.text,
      }),
    })
  },
})
```

## Use the channel in a notification

```ts
import { defineNotification, notifyUsing } from '@holo-js/notifications'

const deploymentFinished = defineNotification({
  type: 'deployment-finished',
  via() {
    return ['slack'] as const
  },
  build: {
    slack() {
      return {
        text: 'Deployment finished successfully.',
      }
    },
  },
})

await notifyUsing()
  .channel('slack', { webhook: 'https://hooks.slack.test/services/123' })
  .notify(deploymentFinished)
```

## Type flow

Custom channel typing should flow through:

- `notifyUsing().channel(...)`
- `defineNotification({ build: { ... } })`
- dispatch result channel names

That keeps route and payload validation local to the channel while preserving inference for application code.
