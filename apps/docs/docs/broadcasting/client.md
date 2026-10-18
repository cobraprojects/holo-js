# Listening on the Client

::: warning Experimental
Realtime and Broadcast are Experimental in 0.4.0. Production reliability work is still pending; review the [production limits](/broadcasting/production#experimental-production-limits) before relying on live updates.
:::

Flux is the Holo browser client for broadcasting. Your framework's Flux package gives you hooks that subscribe when a component mounts and leave the channel when it unmounts.

There is no client setup to write. Flux fetches its connection settings from `/broadcasting/config` and authorizes private and presence channels through `/broadcasting/auth`. `holo install broadcast` sets up both.

## Quick example

::: code-group

```tsx [Next.js]
// app/orders/[id]/shipment-status.tsx
'use client'

import { useState } from 'react'
import { useFlux } from '@holo-js/flux-react'

export function ShipmentStatus({ orderId }: { orderId: string }) {
  const [status, setStatus] = useState('pending')

  useFlux(`orders.${orderId}`, 'orders.shipment-updated', (payload) => {
    setStatus(payload.status)
  })

  return <p>Shipment: {status}</p>
}
```

```vue [Nuxt]
<!-- app/components/ShipmentStatus.vue -->
<script setup lang="ts">
import { ref } from 'vue'
import { useFlux } from '@holo-js/flux-vue'

const props = defineProps<{ orderId: string }>()
const status = ref('pending')

useFlux(`orders.${props.orderId}`, 'orders.shipment-updated', (payload) => {
  status.value = payload.status
})
</script>

<template>
  <p>Shipment: {{ status }}</p>
</template>
```

```svelte [SvelteKit]
<!-- src/lib/ShipmentStatus.svelte -->
<script lang="ts">
  import { useFlux } from '@holo-js/flux-svelte'

  export let orderId: string
  let status = 'pending'

  useFlux(`orders.${orderId}`, 'orders.shipment-updated', (payload) => {
    status = payload.status
  })
</script>

<p>Shipment: {status}</p>
```

:::

Subscribe with the real channel name, such as `orders.42`, not the pattern `orders.{orderId}` from your channel definition.

The `payload` type comes from the `payload` of the matching `defineBroadcast` in `server/broadcast/`. Holo regenerates these types when you run `npx holo make:broadcast`, `npx holo prepare`, or the dev server.

## Choose the channel type

`useFlux` subscribes to a **private** channel. Use the explicit helpers when you want a different type:

| Helper | Channel type | Server helper |
| --- | --- | --- |
| `useFlux(channel, events, callback)` | private | `privateChannel()` |
| `useFluxPrivate(channel, events, callback)` | private | `privateChannel()` |
| `useFluxPublic(channel, events, callback)` | public | `channel()` |
| `useFluxPresence(channel, callbacks?)` | presence | `presenceChannel()` |

The client type must match the server. A browser on the public channel `feed` won't receive events sent to `privateChannel('feed')`.

```ts
useFluxPublic('feed.global', 'feed.updated', (payload) => {
  console.log(payload)
})
```

Pass an array to handle several events with one callback:

```ts
useFlux(`orders.${orderId}`, ['orders.shipment-updated', 'orders.cancelled'], (payload) => {
  console.log(payload)
})
```

## Pause and leave

Every event helper returns controls:

| Control | Effect |
| --- | --- |
| `stopListening()` | Stop calling your callback. The channel stays joined. |
| `listen()` | Start calling it again. |
| `leaveChannel()` / `leave()` | Leave the channel. |

```ts
const shipment = useFlux(`orders.${orderId}`, 'orders.shipment-updated', onUpdate)

shipment.stopListening()
shipment.listen()
```

You don't have to call `leaveChannel()` yourself. The helpers leave on unmount in React, on scope dispose in Vue, and on destroy in Svelte.

## Hook options

Every hook accepts an optional `options` object as its last argument:

| Option | Effect |
| --- | --- |
| `client` | Use this Flux client instead of the default `flux` client. Mainly useful in tests. |
| `onUnmount` | Called with a function that leaves the channel. Store it and call it when you're done, instead of waiting for unmount. |

`useFluxConnectionStatus` also accepts `onChange`, and `useFluxPresence` takes `onHere` in its callbacks argument. Both are shown in their sections.

Vue and Svelte call `onUnmount` only when the hook runs outside a component. Inside a component they clean up automatically.

## Presence channels

`useFluxPresence` joins a presence channel and keeps the current member list. Each member is the object your channel's `authorize` returned.

::: code-group

```tsx [Next.js]
// app/chat/[roomId]/who-is-here.tsx
'use client'

import { useFluxPresence } from '@holo-js/flux-react'

type ChatMember = { id: string, name: string }

export function WhoIsHere({ roomId }: { roomId: string }) {
  const { members } = useFluxPresence<ChatMember>(`chat.${roomId}`)

  return (
    <ul>
      {members.map(member => <li key={member.id}>{member.name}</li>)}
    </ul>
  )
}
```

```vue [Nuxt]
<!-- app/components/WhoIsHere.vue -->
<script setup lang="ts">
import { useFluxPresence } from '@holo-js/flux-vue'

type ChatMember = { id: string, name: string }

const props = defineProps<{ roomId: string }>()
const presence = useFluxPresence<ChatMember>(`chat.${props.roomId}`)
</script>

<template>
  <ul>
    <li v-for="member in presence.members" :key="member.id">{{ member.name }}</li>
  </ul>
</template>
```

```svelte [SvelteKit]
<!-- src/lib/WhoIsHere.svelte -->
<script lang="ts">
  import { useFluxPresence } from '@holo-js/flux-svelte'

  type ChatMember = { id: string, name: string }

  export let roomId: string
  const { members } = useFluxPresence<ChatMember>(`chat.${roomId}`)
</script>

<ul>
  {#each $members as member (member.id)}
    <li>{member.name}</li>
  {/each}
</ul>
```

:::

In React and Vue, `members` is a read-only array that re-renders the component when it changes. In Svelte, `members` is a store, so read it with `$members`.

Pass `onHere` to run code whenever the list changes. It receives the full list after every join and leave:

```ts
useFluxPresence<ChatMember>(`chat.${roomId}`, {
  onHere(members) {
    console.log(`${members.length} people in the room`)
  },
})
```

`useFluxPresence` also returns the same `stopListening`, `listen`, and `leaveChannel` controls as the event helpers.

## Notifications

`useFluxNotification` receives [broadcast notifications](/notifications/channels) sent to a private channel:

```ts
useFluxNotification(`users.${userId}`, (notification) => {
  console.log(notification)
})
```

The callback receives `{ type, data }`, where `data` is what your notification's `broadcast()` builder returned. It only fires for notifications that use the default event name. If the builder sets its own `event`, listen for that name with `useFlux` instead.

::: warning
Broadcast notifications send to the channel names returned by the notifiable's `routeNotificationForBroadcast()` exactly as written. To reach `useFluxNotification('users.42', ...)`, return `private-users.42`, and add a `defineChannel('users.{userId}', ...)` rule that lets the user in.
:::

## Connection status

`useFluxConnectionStatus` reports the WebSocket state: `idle`, `connecting`, `connected`, or `disconnected`.

::: code-group

```tsx [Next.js]
// app/components/connection-badge.tsx
'use client'

import { useFluxConnectionStatus } from '@holo-js/flux-react'

export function ConnectionBadge() {
  const status = useFluxConnectionStatus()

  return <span>{status}</span>
}
```

```vue [Nuxt]
<!-- app/components/ConnectionBadge.vue -->
<script setup lang="ts">
import { useFluxConnectionStatus } from '@holo-js/flux-vue'

const status = useFluxConnectionStatus()
</script>

<template>
  <span>{{ status }}</span>
</template>
```

```svelte [SvelteKit]
<!-- src/lib/ConnectionBadge.svelte -->
<script lang="ts">
  import { useFluxConnectionStatus } from '@holo-js/flux-svelte'

  const status = useFluxConnectionStatus()
</script>

<span>{$status}</span>
```

:::

React returns the status string, Vue returns a read-only ref, and Svelte returns a store. Pass `onChange` to react to every change:

```ts
useFluxConnectionStatus({
  onChange(status) {
    console.log('Broadcast connection:', status)
  },
})
```

## Use Flux directly

Import `flux` from `@holo-js/flux` when you're outside a component or need features the hooks don't cover, such as whispers. Direct subscriptions don't leave automatically, so call `leaveChannel()` when you're done.

```ts
import { flux } from '@holo-js/flux'

const feed = flux.channel('feed.global').listen('feed.updated', (payload) => {
  console.log(payload)
})

const order = flux.private(`orders.${orderId}`).listen('orders.shipment-updated', (payload) => {
  console.log(payload)
})

feed.leaveChannel()
order.leaveChannel()
```

| Method | Returns |
| --- | --- |
| `flux.channel(name)` | A public channel subscription. |
| `flux.private(name)` | A private channel subscription. |
| `flux.presence(name)` | A presence channel subscription with `members`, `here()`, `joining()`, and `leaving()`. |
| `flux.connect()` / `flux.disconnect()` | Open or close the WebSocket. |
| `flux.getStatus()` | The current connection status. |
| `flux.onStatusChange(callback)` | Subscribe to status changes. Returns an unsubscribe function. |

A subscription has `listen(event, callback)`, `notification(callback)`, `listenForWhisper(name, callback)`, `whisper(name, payload)`, `stopListening()`, and `leaveChannel()`.

### Presence callbacks

```ts
import { flux } from '@holo-js/flux'

const room = flux
  .presence(`chat.${roomId}`)
  .here((members) => {
    console.log('In the room:', members)
  })
  .joining((member) => {
    console.log('Joined:', member)
  })
  .leaving((member) => {
    console.log('Left:', member)
  })
  .listen()

console.log(room.members)
```

`here` receives the full member list. `joining` and `leaving` receive one member at a time.

### Whispers

Whispers go from one browser to the others on a private or presence channel. The channel must allow the whisper name in its `whispers` option. See [Client events (whispers)](/broadcasting/events-and-channels#client-events-whispers).

```ts
import { flux } from '@holo-js/flux'

const room = flux.presence(`chat.${roomId}`)

room.listenForWhisper('typing', (payload) => {
  console.log('Someone is typing:', payload)
})

await room.whisper('typing', { editing: true })
```

## Reference

All framework packages export the same helpers.

| Helper | Returns |
| --- | --- |
| `useFlux(channel, events, callback, options?)` | Listener controls. Private channel. |
| `useFluxPrivate(channel, events, callback, options?)` | Same as `useFlux`. |
| `useFluxPublic(channel, events, callback, options?)` | Listener controls. Public channel. |
| `useFluxPresence(channel, callbacks?, options?)` | Listener controls plus `members`. |
| `useFluxNotification(channel, callback, options?)` | Listener controls. Private channel. |
| `useFluxModel(channel, events, callback, options?)` | Same as `useFluxPrivate`. |
| `useFluxConnectionStatus(options?)` | Status string (React), read-only ref (Vue), or store (Svelte). |

`options.client` lets you pass a specific Flux client instead of the default one, which is mainly useful in tests.

## Available methods

Every Flux client method, subscription method, presence method, and hook. Hooks come from `@holo-js/flux-react`, `@holo-js/flux-vue`, or `@holo-js/flux-svelte`, and the rest from `@holo-js/flux`.

**Flux client**

- [flux](#flux): the default client object
- [createFluxClient](#createfluxclient): build a client with your own connector
- [getFluxClient](#getfluxclient): read the default client
- [status](#status) and [options](#options): read the client's state and settings
- [connect](#connect), [disconnect](#disconnect), [getStatus](#getstatus), [onStatusChange](#onstatuschange): manage the connection
- [channel](#channel), [private](#private), [presence](#presence): open a subscription

**Subscriptions** (returned by `channel()` and `private()`)

- [listen](#listen): receive events, or resume after stopping
- [notification](#notification): receive broadcast notifications
- [listenForWhisper](#listenforwhisper) and [whisper](#whisper): receive and send client events
- [stopListening](#stoplistening), [leave](#leave), [leaveChannel](#leavechannel): stop or leave
- [name](#name) and [type](#name): read the channel name and kind

**Presence subscriptions** (returned by `presence()`)

- [members](#members): the current member list
- [here](#here), [joining](#joining), [leaving](#leaving): react to membership

**Hooks**

- [useFlux](#useflux), [useFluxPublic](#usefluxpublic), [useFluxPrivate](#usefluxprivate), [useFluxModel](#usefluxmodel): listen to events
- [useFluxPresence](#usefluxpresence): join a presence channel
- [useFluxNotification](#usefluxnotification): receive notifications
- [useFluxConnectionStatus](#usefluxconnectionstatus): read the connection state

Hooks return the same listener controls as subscriptions: `stopListening()`, `listen()`, `leaveChannel()`, and `leave()`. They're documented under [listen](#listen) and [stopListening](#stoplistening).

### flux

The default Flux client. Import it to use Flux outside a component.

```ts
import { flux } from '@holo-js/flux'

flux.channel('feed.global').listen('feed.updated', (payload) => {
  console.log(payload)
})
```

### createFluxClient

`createFluxClient(options?)` builds a new client. Pass `connector` to use your own transport, or `connectorFactory` to build one from the options. Without either, the client's `connect()` throws.

```ts
import { createFluxClient } from '@holo-js/flux'

const client = createFluxClient({ connector: myConnector })
```

Use it in tests, or pass the result to a hook as `client`.

### getFluxClient

`getFluxClient()` returns the default client that `flux` and the hooks use.

```ts
import { getFluxClient } from '@holo-js/flux'

const status = getFluxClient().getStatus()
```

### status

The current connection status: `'idle'`, `'connecting'`, `'connected'`, or `'disconnected'`. It's a read-only property, so it updates each time you read it.

```ts
if (flux.status === 'connected') {
  console.log('Live updates are on')
}
```

### options

The options the client was created with, frozen.

```ts
console.log(flux.options)
```

### connect

`connect()` opens the WebSocket and resolves once the attempt finishes. Subscribing connects automatically, so you rarely need to call it.

```ts
await flux.connect()
```

### disconnect

`disconnect()` closes the WebSocket, drops every channel it had joined, and sets the status to `'disconnected'`.

```ts
await flux.disconnect()
```

### getStatus

`getStatus()` returns the connection status. It's the same value as the `status` property.

```ts
const status = flux.getStatus()
```

### onStatusChange

`onStatusChange(callback)` calls `callback` with the new status each time it changes. It returns a function that stops the callback.

```ts
const stop = flux.onStatusChange((status) => {
  console.log('Broadcast connection:', status)
})

stop()
```

### channel

`channel(name)` subscribes to a public channel and returns a [subscription](#listen).

```ts
const feed = flux.channel('feed.global')
```

### private

`private(name)` subscribes to a private channel. The browser asks `/broadcasting/auth` for permission first.

```ts
const order = flux.private(`orders.${orderId}`)
```

### presence

`presence(name)` subscribes to a presence channel and returns a [presence subscription](#members).

```ts
const room = flux.presence(`chat.${roomId}`)
```

### listen

`listen(event, callback)` calls `callback` when the event arrives. Pass an array of event names to handle several with one callback. Called with no arguments, `listen()` resumes callbacks you stopped with [stopListening](#stoplistening).

```ts
const shipment = flux.private(`orders.${orderId}`)
  .listen(['orders.shipment-updated', 'orders.cancelled'], (payload) => {
    console.log(payload)
  })

shipment.listen()
```

### notification

`notification(callback)` calls `callback` for [broadcast notifications](/notifications/channels) sent to the channel. See [useFluxNotification](#usefluxnotification) for the payload shape.

```ts
flux.private(`users.${userId}`).notification((notification) => {
  console.log(notification)
})
```

### listenForWhisper

`listenForWhisper(name, callback)` calls `callback` when another browser sends a whisper with that name. The channel must allow the whisper in its `whispers` option.

```ts
flux.presence(`chat.${roomId}`).listenForWhisper('typing', (payload) => {
  console.log(payload)
})
```

### whisper

`whisper(name, payload)` sends a whisper to the other browsers on the channel. It resolves once the message is sent.

```ts
await room.whisper('typing', { editing: true })
```

### stopListening

`stopListening()` stops calling your callbacks but keeps the channel joined. Call [listen](#listen) to start again.

```ts
shipment.stopListening()
```

### leave

`leave()` leaves the channel for every subscription of the same kind in this client, not just this one. Use [leaveChannel](#leavechannel) to leave only this subscription.

```ts
order.leave()
```

### leaveChannel

`leaveChannel()` removes this subscription's callbacks. The WebSocket leaves the channel once no other subscription in the client is using it.

```ts
feed.leaveChannel()
```

### name

`name` is the channel name and `type` is `'public'`, `'private'`, or `'presence'`. Both are read-only.

```ts
console.log(order.name, order.type)
```

### members

`members` is the current member list on a presence channel, an array of the objects your channel's `authorize` returned. It updates as people join and leave.

```ts
console.log(room.members.length)
```

### here

`here(callback)` calls `callback` with the full member list right away. Chain it with [joining](#joining) and [leaving](#leaving).

```ts
room.here((members) => {
  console.log('In the room:', members)
})
```

### joining

`joining(callback)` calls `callback` with one member each time someone joins.

```ts
room.joining((member) => {
  console.log('Joined:', member)
})
```

### leaving

`leaving(callback)` calls `callback` with one member each time someone leaves.

```ts
room.leaving((member) => {
  console.log('Left:', member)
})
```

### useFlux

`useFlux(channel, events, callback, options?)` listens on a private channel and returns listener controls. The subscription starts when the component mounts and leaves on unmount. Changing `channel` or `events` re-subscribes.

```ts
useFlux(`orders.${orderId}`, 'orders.shipment-updated', (payload) => {
  console.log(payload)
})
```

### useFluxPublic

`useFluxPublic(channel, events, callback, options?)` works like `useFlux`, on a public channel.

```ts
useFluxPublic('feed.global', 'feed.updated', (payload) => {
  console.log(payload)
})
```

### useFluxPrivate

`useFluxPrivate(channel, events, callback, options?)` is the same as `useFlux`, and makes the private channel explicit.

```ts
useFluxPrivate(`orders.${orderId}`, 'orders.shipment-updated', onUpdate)
```

### useFluxModel

`useFluxModel(channel, events, callback, options?)` is the same as `useFluxPrivate`. Its name signals a model-change channel. The behavior is identical.

```ts
useFluxModel(`posts.${postId}`, 'posts.updated', onPostUpdated)
```

### useFluxPresence

`useFluxPresence(channel, callbacks?, options?)` joins a presence channel and returns listener controls with `members`. `callbacks.onHere` runs with the full member list after every join and leave.

```ts
const presence = useFluxPresence<ChatMember>(`chat.${roomId}`, {
  onHere(members) {
    console.log(members.length)
  },
})

console.log(presence.members)
```

React reads `members` as a getter that re-renders the component. Vue returns it as a read-only array. Svelte returns it as a store.

### useFluxNotification

`useFluxNotification(channel, callback, options?)` receives [broadcast notifications](/notifications/channels) on a private channel. The callback gets `{ type, data }`, where `type` is the notification's type name and `data` is what its `broadcast()` builder returned.

```ts
useFluxNotification(`users.${userId}`, (notification) => {
  console.log(notification)
})
```

### useFluxConnectionStatus

`useFluxConnectionStatus(options?)` returns the connection status. React returns a string, Vue a read-only ref, and Svelte a store. `options.onChange` runs on every change.

```ts
const status = useFluxConnectionStatus({
  onChange(next) {
    console.log(next)
  },
})
```

## Next steps

- [Events and channels](/broadcasting/events-and-channels)
- [Realtime queries](/realtime/): keep query results live without writing events.
- [Scaling in production](/broadcasting/production)
