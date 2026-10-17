# Custom Channels

Add your own delivery channel, such as Slack, SMS, or a webhook, and use it in notifications exactly like `email` or `database`.

```ts [server/notifications/channels/slack.ts]
import { type NotificationChannel, registerNotificationChannel } from '@holo-js/notifications'

export interface SlackRoute {
  readonly webhookUrl: string
}

export interface SlackMessage {
  readonly text: string
}

declare module '@holo-js/notifications' {
  interface HoloNotificationChannelRegistry {
    readonly slack: NotificationChannel<SlackRoute, SlackMessage, void>
  }
}

const slackChannel: NotificationChannel<SlackRoute, SlackMessage, void> = {
  validateRoute(route) {
    if (!route.webhookUrl.startsWith('https://hooks.slack.com/')) {
      throw new Error('Slack routes must be Slack webhook URLs.')
    }

    return route
  },
  async send({ route, payload }) {
    if (!route) {
      throw new Error('Slack notifications need a webhook URL.')
    }

    const response = await fetch(route.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: payload.text }),
    })

    if (!response.ok) {
      throw new Error(`Slack returned ${response.status}.`)
    }
  },
}

registerNotificationChannel('slack', slackChannel)
```

## Define the channel

A channel is an object with:

- `send(context)`: required. Delivers the message. Throw to mark the delivery as failed.
- `validateRoute(route)`: optional. Checks the destination before sending and returns it. Throw to reject it.

`send()` receives a context with:

| Field | Description |
| --- | --- |
| `payload` | The message returned by the notification's builder for this channel. |
| `route` | Where to deliver, from the recipient or `notifyUsing()`. Can be `undefined`. |
| `notifiable` | The recipient object. |
| `notificationType` | The notification's `type`. |
| `channel` | The channel name. |
| `anonymous` | `true` for `notifyUsing()` sends. |
| `targetIndex` | The recipient's position when using `notifyMany()`. |

Whatever `send()` returns is reported as `result` in the [delivery result](/notifications/events).

## Add type safety

The `declare module` block above registers the channel's route and message types. With it:

- `via()` can return `'slack'`, and `build.slack()` must return a `SlackMessage`.
- `notifyUsing().channel('slack', ...)` only accepts a `SlackRoute`.

The three type arguments of `NotificationChannel` are the route, the message, and the value `send()` returns.

## Register the channel

Call `registerNotificationChannel(name, channel)` once, before you send. Registering the same name twice throws; pass `{ replaceExisting: true }` as the third argument to replace a channel.

::: warning
Queued notifications are delivered by a [queue worker](/queue/workers), which is a separate process. The channel must be registered there too, or delivery fails with `Notification channel "slack" is not registered`. To make a channel load everywhere automatically, ship it in a [plugin](/advanced/plugins) with `contributes: { notifications: { channels: { slack: { runtime: './dist/slack.mjs' } } } }`, where the module's default export has `send()` (and optionally `validateRoute()`).
:::

## Use it in a notification

```ts [server/notifications/deployment-finished.ts]
import { defineNotification } from '@holo-js/notifications'

interface Team {
  readonly id: string
  readonly name: string
  readonly slackWebhookUrl: string
  routeNotificationFor(channel: string): unknown
}

export default defineNotification({
  type: 'deployment-finished',
  via(team: Team) {
    return ['slack']
  },
  build: {
    slack(team) {
      return { text: `Deployment finished for ${team.name}.` }
    },
  },
})
```

## Route to a recipient

For `notify()`, Holo asks the recipient where to deliver by calling its `routeNotificationFor(channel)` method:

```ts
import { notify } from '@holo-js/notifications'
import deploymentFinished from '../notifications/deployment-finished'

await notify({
  id: team.id,
  name: team.name,
  slackWebhookUrl: team.slackWebhookUrl,
  routeNotificationFor(channel: string) {
    return channel === 'slack' ? { webhookUrl: team.slackWebhookUrl } : undefined
  },
}, deploymentFinished)
```

For [on-demand sends](/notifications/sending#send-to-an-address-on-demand), pass the route directly. The notification's builders must not depend on a recipient:

```ts
await notifyUsing()
  .channel('slack', { webhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXX' })
  .notify(alertNotification)
```

## Replace a built-in channel

A registered channel takes priority over a built-in one with the same name. For example, register `'email'` to send notification emails through your own provider instead of [mail](/mail/). The recipient's `email` field is no longer read automatically in that case; return the address from `routeNotificationFor('email')` or use `notifyUsing()`.

## Registry helpers

Four helpers manage the channels you registered. Built-in channels aren't in this list.

### registerNotificationChannel()

Adds a channel under a name. The name must be non-empty, and the channel must have a `send()` method. Registering a name that's already taken throws, unless you pass `{ replaceExisting: true }`. Use that option to replace a built-in channel.

```ts
registerNotificationChannel('sms', smsChannel, { replaceExisting: true })
```

### getRegisteredNotificationChannel()

Returns `{ name, channel }` for a registered channel, or `undefined` if none has that name.

```ts
const sms = getRegisteredNotificationChannel('sms')
```

### listRegisteredNotificationChannels()

Returns every channel you registered in this process.

```ts
const names = listRegisteredNotificationChannels().map(entry => entry.name)
```

### resetNotificationChannelRegistry()

Removes every registered channel, including replacements for built-in channels. Use it in tests, then register the channels again if your app needs them. See [Testing notifications](/notifications/testing#replace-a-channel-in-tests).

## Next steps

- [Channels](/notifications/channels)
- [Testing notifications](/notifications/testing)
- [Writing plugins](/advanced/plugins)
