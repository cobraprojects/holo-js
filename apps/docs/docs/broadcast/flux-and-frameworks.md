# Flux And Framework Helpers

No manual client bootstrap is required.

## Client Installation

- React: `@holo-js/flux-react`
- Vue: `@holo-js/flux-vue`
- Svelte: `@holo-js/flux-svelte`
- Direct client: `@holo-js/flux`

## Receiving Events

`useFlux(...)` subscribes to private channels by default:

```ts
const controls = useFlux(`orders.${orderId}`, ['OrderShipmentStatusUpdated', 'OrderShipped'], payload => {
  console.log(payload)
})
```

Single event:

```ts
useFlux(`orders.${orderId}`, 'OrderShipmentStatusUpdated', payload => {
  console.log(payload)
})
```

## Helper Reference

- `useFlux(...)`
- `useFluxPublic(...)`
- `useFluxPrivate(...)`
- `useFluxPresence(...)`
- `useFluxNotification(...)`
- `useFluxConnectionStatus(...)`

## Public And Private Channels

Use the explicit helper when you want to force channel type:

```ts
useFluxPublic('feed.global', 'FeedUpdated', payload => {
  console.log(payload)
})

useFluxPrivate(`orders.${orderId}`, 'OrderShipmentStatusUpdated', payload => {
  console.log(payload)
})
```

## Presence Channels

```ts
const presence = useFluxPresence(`chat.${roomId}`, {
  onHere(members) {
    console.log(members)
  },
})

console.log(presence.members)
```

## Client Events (Whispers)

Use the direct client API for whisper send/listen:

```ts
import flux from '@holo-js/flux'

const room = flux.presence(`chat.${roomId}`)
room.listenForWhisper('typing', payload => {
  console.log(payload)
})
await room.whisper('typing', { userId })
```

## Notifications

```ts
useFluxNotification(`App.Models.User.${userId}`, notification => {
  console.log(notification)
})
```

## Connection Status

```ts
const status = useFluxConnectionStatus({
  onChange(next) {
    console.log(next)
  },
})
```

Status values:

- `idle`
- `connecting`
- `connected`
- `disconnected`

## Subscription Controls

Event helpers return:

- `stopListening()`
- `listen()`
- `leaveChannel()`
- `leave()`

Helpers leave channels automatically on unmount.

## Direct Flux API

```ts
import flux from '@holo-js/flux'

flux.private(`orders.${orderId}`).listen('OrderShipmentStatusUpdated', payload => {
  console.log(payload)
})

flux.channel('feed.global').listen('FeedUpdated', payload => {
  console.log(payload)
})

flux.private(`App.Models.User.${userId}`).notification(notification => {
  console.log(notification)
})
```

## Channel Name Format

Channel definitions use placeholders (for example `orders.{orderId}`).
Runtime subscriptions must use resolved channel names (for example ``orders.${orderId}``).
