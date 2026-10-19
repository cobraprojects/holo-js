# Events and Channels

::: warning Experimental
Realtime and Broadcast are Experimental in 0.4.0. Production reliability work is still pending; review the [production limits](/broadcasting/production#experimental-production-limits) before relying on live updates.
:::

A broadcast event is a named message with a JSON payload, sent to one or more channels. Channels decide who receives it: anyone (public), a signed-in user you approve (private), or a group whose members can see each other (presence).

## Quick example

```bash
npx holo make:broadcast orders/shipment-updated
npx holo make:channel orders.{orderId}
```

```ts [server/broadcast/orders/shipment-updated.ts]
import { defineBroadcast, privateChannel } from '@holo-js/broadcast'

export function shipmentUpdated(orderId: string, status: 'shipped' | 'delayed') {
  return defineBroadcast({
    name: 'orders.shipment-updated',
    channels: [
      privateChannel('orders.{orderId}', { orderId }),
    ],
    payload: {
      orderId,
      status,
    },
  })
}
```

```ts [server/channels/orders-order-id.ts]
import { defineChannel } from '@holo-js/broadcast'

export default defineChannel('orders.{orderId}', {
  type: 'private',
  authorize(user: { id: string, customerOrderIds: string[] }, params) {
    return user.customerOrderIds.includes(params.orderId)
  },
})
```

```ts
import { broadcast } from '@holo-js/broadcast'
import { shipmentUpdated } from '../broadcast/orders/shipment-updated'

await broadcast(shipmentUpdated(order.id, 'shipped'))
```

The customer's browser listens on `orders.<their order id>` and receives the event. Everyone else is refused at `/broadcasting/auth`.

## Generate files

`make:broadcast` creates an event file in `server/broadcast/`. Folders in the name become folders on disk and dots in the event name:

```bash
npx holo make:broadcast orders/shipment-updated
```

This creates `server/broadcast/orders/shipment-updated.ts` with the name `orders.shipment-updated`, a public channel, and an empty payload:

```ts [server/broadcast/orders/shipment-updated.ts]
import { channel, defineBroadcast } from '@holo-js/broadcast'

export default defineBroadcast({
  name: 'orders.shipment-updated',
  channels: [
    channel('orders.shipment-updated'),
  ],
  payload: {},
})
```

`make:channel` takes a channel pattern and creates an authorization file in `server/channels/` that denies everyone until you edit it:

```bash
npx holo make:channel orders.{orderId}
```

```ts [server/channels/orders-order-id.ts]
import { defineChannel } from '@holo-js/broadcast'

export default defineChannel('orders.{orderId}', {
  type: 'private',
  authorize() {
    return false
  },
})
```

Both commands refuse to overwrite an existing event name or channel pattern. Holo discovers every file in these folders, so you don't register them anywhere.

## Define events

`defineBroadcast` takes:

| Option | Description |
| --- | --- |
| `name` | The event name clients listen for, such as `orders.shipment-updated`. Always set it: sending an event without a name throws. |
| `channels` | One or more channels built with `channel()`, `privateChannel()`, or `presenceChannel()`. |
| `payload` | A plain object of JSON values: strings, numbers, booleans, `null`, arrays, and nested objects. Dates, class instances, and functions are rejected. |
| `queue` | `true` to send through the queue, or `{ queued: true, connection, queue, afterCommit }`. See [Queue broadcasts](#queue-broadcasts). |
| `delay` | Milliseconds or a `Date`. Delayed broadcasts always go through the queue. |

Events usually depend on runtime values, so export a function that returns `defineBroadcast(...)`, like the `shipmentUpdated` example above. A default export of a fixed definition also works for events that never change.

### Channel helpers

| Helper | Who can listen |
| --- | --- |
| `channel(pattern, params?)` | Anyone. No authorization. |
| `privateChannel(pattern, params?)` | Users approved by the matching `defineChannel` rule. |
| `presenceChannel(pattern, params?)` | Approved users, who also see each other in the member list. |

Patterns use `{name}` placeholders. Pass a value for every placeholder:

```ts
privateChannel('teams.{teamId}.projects.{projectId}', { teamId: team.id, projectId: project.id })
```

Holo throws if a placeholder is missing, if you pass an unknown one, or if a value contains characters other than letters, numbers, `-`, and `_`. Channel names are dot-separated segments such as `orders.42`.

## Send broadcasts

`broadcast(...)` returns a pending dispatch. Await it to send:

```ts
import { broadcast } from '@holo-js/broadcast'

await broadcast(shipmentUpdated(order.id, 'shipped'))
```

Chain options before awaiting:

| Method | Effect |
| --- | --- |
| `.using('name')` | Send through a different broadcast connection from `config/broadcast.ts`. |
| `.onQueue('name')` | Send through the queue, on this queue. |
| `.onConnection('name')` | Send through the queue, on this queue connection. |
| `.delay(ms \| Date)` | Send through the queue after a delay. |
| `.afterCommit()` | When called inside a database transaction, wait until the transaction commits. Outside a transaction it sends right away. |

```ts
await broadcast(shipmentUpdated(order.id, 'shipped'))
  .onQueue('broadcasts')
  .delay(5000)
```

The awaited result tells you what happened:

```ts
const result = await broadcast(shipmentUpdated(order.id, 'shipped'))

result.connection
result.driver
result.queued
result.publishedChannels
result.messageId
```

`result.provider` holds extra details a driver chooses to return, when it returns any.

### When the broadcast server is down

A broadcast that isn't queued is sent during your request. If the broadcast server can't be reached, `broadcast()` throws:

```
[@holo-js/core] Broadcast publish request could not reach the broadcast worker at http://127.0.0.1:8080.
```

The original network error is kept as the error's `cause`. A server that doesn't answer within 10 seconds throws a timeout error instead.

To keep a failed broadcast from leaving a half-finished save behind, send it as the last step inside the save's transaction. The throw then rolls the save back:

```ts [server/lib/orders.ts]
import { broadcast } from '@holo-js/broadcast'
import { DB } from '@holo-js/db'
import { shipmentUpdated } from '../broadcast/orders/shipment-updated'

await DB.transaction(async () => {
  await order.update({ status: 'shipped' })
  await broadcast(shipmentUpdated(order.id, 'shipped'))
})
```

To let the save succeed even while the broadcast server is down, [queue the broadcast](#queue-broadcasts) instead.

### Queue broadcasts

Sending through the queue keeps slow network calls out of your request. You need [queues](/queue/) installed and a [worker running](/queue/workers).

Make an event always queue by setting `queue` on the definition:

```ts [server/broadcast/orders/shipment-updated.ts]
import { defineBroadcast, privateChannel } from '@holo-js/broadcast'

export function shipmentUpdated(orderId: string, status: 'shipped' | 'delayed') {
  return defineBroadcast({
    name: 'orders.shipment-updated',
    channels: [
      privateChannel('orders.{orderId}', { orderId }),
    ],
    payload: { orderId, status },
    queue: {
      queued: true,
      queue: 'broadcasts',
      afterCommit: true,
    },
  })
}
```

Options you chain on `broadcast(...)` override the definition. In the definition's `queue` option, setting `connection` or `queue` without `queued: true` throws.

### Wait for the transaction

If you broadcast inside a [transaction](/database/transactions), clients could hear about a row that is later rolled back. Use `.afterCommit()` to send only after the commit:

```ts
import { DB } from '@holo-js/db'
import { broadcast } from '@holo-js/broadcast'

await DB.transaction(async () => {
  await order.update({ status: 'shipped' })
  await broadcast(shipmentUpdated(order.id, 'shipped')).afterCommit()
})
```

### Send without an event file

`broadcastRaw` sends an event name, channel list, and payload directly:

```ts
import { broadcastRaw } from '@holo-js/broadcast'

await broadcastRaw({
  event: 'orders.shipment-updated',
  channels: [`private-orders.${order.id}`],
  payload: { orderId: order.id, status: 'shipped' },
})
```

Raw channel names are sent exactly as written. Add the `private-` or `presence-` prefix yourself for private and presence channels. `broadcastRaw` accepts `connection` and supports the same chained options as `broadcast`.

## Authorize private channels

Every private or presence channel needs a `defineChannel` rule in `server/channels/`. When a browser joins the channel, Flux calls `/broadcasting/auth`, and Holo runs the rule whose pattern matches the channel name.

```ts [server/channels/users-user-id.ts]
import { defineChannel } from '@holo-js/broadcast'

export default defineChannel('users.{userId}', {
  type: 'private',
  authorize(user: { id: number }, params) {
    return String(user.id) === params.userId
  },
})
```

`authorize` receives the signed-in user and the placeholder values from the channel name, as strings. Return `true` to allow, `false` to deny. It can be `async`.

`defineChannel` takes these options:

| Option | Required | Description |
| --- | --- | --- |
| `type` | Yes | `'private'` or `'presence'`. Other values throw. |
| `authorize(user, params)` | Yes | Returns the decision. Presence rules return a member object or `false`. |
| `guard` | No | Auth guard name, or a function that returns one. Defaults to the default guard. |
| `whispers` | No | Map of allowed client event names to validation schemas. |

The endpoint answers before your rule runs in these cases:

| Response | When |
| --- | --- |
| `401` | No user is signed in. `authorize` never sees a `null` user. |
| `404` | No `defineChannel` pattern matches the channel name. |
| `403` | `authorize` returned `false`. |

::: warning
Private and presence channels need [authentication](/auth/) installed. Without it, Holo doesn't create the `/broadcasting/auth` endpoint and no browser can join them. Public channels work without auth.
:::

### Refused subscriptions

When a rule refuses a browser, the worker sends a `pusher:subscription_error` event on that channel and keeps the connection open. The browser's other channels keep working.

```json
{ "type": "AuthError", "error": "Unable to authorize the channel subscription.", "status": 403 }
```

If the check itself fails, for example because the database is down, the worker sends the same event with status `500` and passes the error to your [error reporter](/basics/errors#reporting-errors).

A client can also subscribe to a private or presence channel without a signature from `/broadcasting/auth`. Then `holo broadcast:work` runs the rule itself, with the user from the connection's session cookie or `Authorization` header. If nobody is signed in, the worker refuses the subscription, just like the endpoint.

### Use a specific guard

By default, the rule checks the user from the default auth guard in `config/auth.ts`. Set `guard` to use another one:

```ts [server/channels/admin-orders.ts]
import { defineChannel } from '@holo-js/broadcast'

export default defineChannel('admin.orders', {
  type: 'private',
  guard: 'admin',
  authorize(user) {
    return Boolean(user)
  },
})
```

`guard` can also be a function of the channel parameters:

```ts [server/channels/teams-team-id-area.ts]
import { defineChannel } from '@holo-js/broadcast'

export default defineChannel('teams.{teamId}.{area}', {
  type: 'private',
  guard({ params }) {
    return params.area === 'admin' ? 'admin' : 'web'
  },
  authorize(user) {
    return Boolean(user)
  },
})
```

See [Guards and providers](/auth/guards-and-providers) for configuring guards.

## Presence channels

A presence channel is a private channel that also keeps a list of who is connected. Return the member's public details from `authorize` to let them in, or `false` to deny:

```ts [server/channels/chat-room-id.ts]
import { defineChannel } from '@holo-js/broadcast'

export default defineChannel('chat.{roomId}', {
  type: 'presence',
  authorize(user: { id: number, name: string }, params) {
    return {
      id: String(user.id),
      name: user.name,
      roomId: params.roomId,
    }
  },
})
```

Everyone on the channel sees the returned object, so include only what other users may see. On the client, read the list with [`useFluxPresence`](/broadcasting/client#presence-channels).

## Client events (whispers)

Whispers are short messages one browser sends straight to the others on the same channel, without going through your app server. Typing indicators are the classic case.

Allow a whisper by adding it to the channel's `whispers`, with a [validation schema](/basics/validation/) for its payload:

```ts [server/channels/chat-room-id.ts]
import { defineChannel } from '@holo-js/broadcast'
import { field, schema } from '@holo-js/validation'

export default defineChannel('chat.{roomId}', {
  type: 'presence',
  authorize(user: { id: number, name: string }) {
    return { id: String(user.id), name: user.name }
  },
  whispers: {
    typing: schema({
      editing: field.boolean().required(),
    }),
  },
})
```

The worker rejects whispers that aren't listed, whispers on public channels, and payloads that fail the schema. See [Whispers](/broadcasting/client#whispers) for sending and receiving them.

## Helper reference

Every helper exported by `@holo-js/broadcast`, grouped by job. The channel helpers, `broadcast`, and `broadcastRaw` are covered above. The rest are for custom routes and drivers.

**Definitions**

- [defineBroadcast](#definebroadcast): create an event
- [defineChannel](#definechannel): create an authorization rule
- [channel, privateChannel, presenceChannel](#channel-privatechannel-presencechannel): name the channels an event goes to
- [defineBroadcastConfig](#definebroadcastconfig): declare `config/broadcast.ts`

**Sending**

- [broadcast](#broadcast) and [broadcastRaw](#broadcastraw): send an event
- [getBroadcastRuntime](#getbroadcastruntime): get the send functions as an object

**Channel authorization**

- [authorizeBroadcastChannel](#authorizebroadcastchannel): check one user against one channel
- [resolveBroadcastChannelGuard](#resolvebroadcastchannelguard): find the guard for a channel
- [renderBroadcastAuthResponse](#renderbroadcastauthresponse): build the auth response in your own route

**Browser config**

- [renderBroadcastClientConfigResponse](#renderbroadcastclientconfigresponse): describe the connection to Flux

**Drivers and worker**

- [registerBroadcastDriver](#registerbroadcastdriver), [getRegisteredBroadcastDriver](#getregisteredbroadcastdriver), [listRegisteredBroadcastDrivers](#listregisteredbroadcastdrivers): manage drivers

### defineBroadcast

`defineBroadcast(definition)` returns an event definition. It takes the options listed in [Define events](#define-events) and is frozen after creation.

```ts
export const postPublished = defineBroadcast({
  name: 'posts.published',
  channels: [channel('posts')],
  payload: { id: 1 },
})
```

### defineChannel

`defineChannel(pattern, rule)` returns an authorization rule for a private or presence channel. See [Authorize private channels](#authorize-private-channels) for its options.

```ts
export default defineChannel('users.{userId}', {
  type: 'private',
  authorize(user: { id: number }, params) {
    return String(user.id) === params.userId
  },
})
```

### channel, privateChannel, presenceChannel

Each returns a channel target for `channels`. `channel` is public, `privateChannel` is private, and `presenceChannel` is presence. Pass placeholder values as the second argument.

```ts
channels: [
  presenceChannel('chat.{roomId}', { roomId: room.id }),
]
```

### defineBroadcastConfig

`defineBroadcastConfig(config)` declares `config/broadcast.ts`. See [Drivers and config](/broadcasting/drivers) for the options.

```ts [config/broadcast.ts]
export default defineBroadcastConfig({
  default: 'log',
  connections: { log: { driver: 'log' } },
})
```

### broadcast

`broadcast(definition)` returns a pending dispatch. Nothing is sent until you await it. It accepts a `defineBroadcast(...)` result or a plain definition object.

```ts
await broadcast({
  name: 'posts.published',
  channels: [channel('posts')],
  payload: { id: 1 },
})
```

### broadcastRaw

`broadcastRaw(input)` sends an event by name without a definition. Channel names are sent exactly as written. See [Send without an event file](#send-without-an-event-file).

```ts
await broadcastRaw({ event: 'posts.published', channels: ['posts'], payload: { id: 1 } })
```

### getBroadcastRuntime

`getBroadcastRuntime()` returns a frozen object with `broadcast` and `broadcastRaw`, for code that receives the runtime as a value.

```ts
const { broadcast } = getBroadcastRuntime()

await broadcast(postPublished)
```

### authorizeBroadcastChannel

`authorizeBroadcastChannel({ channel, socketId?, user })` runs the matching rule for a channel. It returns `{ ok: true, ... }` with the channel's type, params, and whispers, or `{ ok: false, code }` where `code` is `'not-found'` or `'unauthorized'`. It doesn't throw on denial.

```ts
const result = await authorizeBroadcastChannel({ channel: 'orders.42', user })

if (result.ok) {
  console.log(result.type)
}
```

### resolveBroadcastChannelGuard

`resolveBroadcastChannelGuard({ channel, socketId? })` returns the guard name for the channel's rule, or `undefined` when no rule matches.

```ts
const guard = await resolveBroadcastChannelGuard({ channel: 'admin.orders' })
```

### renderBroadcastAuthResponse

`renderBroadcastAuthResponse(request, options?)` handles a full auth request and returns the JSON `Response`. It returns `200` with a signed `auth` and `channel_data` when `appKey`, `appSecret`, and a socket ID are present. Otherwise it returns `400` for a bad request, `401` with no user, `403` when denied, `404` for an unknown channel, or `405` for a non-POST method.

```ts
const response = await renderBroadcastAuthResponse(request, {
  appKey: env('BROADCAST_APP_KEY'),
  appSecret: env('BROADCAST_APP_SECRET'),
  resolveUser: async request => readSessionUser(request),
})
```

Holo's `/broadcasting/auth` route calls this for you. Write your own route only when you need a different way to find the user.

### renderBroadcastClientConfigResponse

`renderBroadcastClientConfigResponse(config)` returns the same settings as a JSON `Response` with `Cache-Control: no-store`. Holo serves it at `/broadcasting/config`.

### registerBroadcastDriver

`registerBroadcastDriver(name, driver, options?)` adds a driver that connections can use by name. The driver needs a `send(input, context)` method. It throws if the name is taken, unless you pass `{ replace: true }`. Plugins use this to contribute drivers.

```ts
registerBroadcastDriver('webhook', {
  async send(input) {
    return { connection: input.connection, driver: 'webhook', queued: false, publishedChannels: input.channels }
  },
})
```

### getRegisteredBroadcastDriver

`getRegisteredBroadcastDriver(name)` returns the driver registered under that name, or `undefined`.

```ts
const driver = getRegisteredBroadcastDriver('webhook')
```

### listRegisteredBroadcastDrivers

`listRegisteredBroadcastDrivers()` returns every registered driver as `{ name, driver }` objects.

```ts
for (const { name } of listRegisteredBroadcastDrivers()) {
  console.log(name)
}
```

## Next steps

- [Listening on the client](/broadcasting/client)
- [Drivers and config](/broadcasting/drivers)
- [Queues](/queue/)
- [Notifications channels](/notifications/channels): broadcast notifications to a user.
