# Defining Events And Channels

## Defining Events

Define events as factories that receive runtime values.
Do not hardcode dynamic IDs in event files.

```ts
import { defineBroadcast, privateChannel } from '@holo-js/broadcast'

export function orderShipmentUpdated(orderId: string, status: 'shipped' | 'delayed') {
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

## Broadcasting Events

```ts
import { broadcast } from '@holo-js/broadcast'
import { orderShipmentUpdated } from '@/server/broadcast/orders/shipment-updated'

await broadcast(orderShipmentUpdated(order.id, order.status))
  .using('holo')
  .onQueue('broadcast')
  .delay(300)
  .afterCommit()
```

## Broadcast Dispatch Options

Available options on `broadcast(...)`:

- `.using('connection-name')`
- `.onConnection('queue-connection-name')`
- `.onQueue('queue-name')`
- `.delay(ms | Date)`
- `.afterCommit()`

## Raw Broadcasting

Use `broadcastRaw` when you need direct event/channels/payload dispatch without an event factory:

```ts
import { broadcastRaw } from '@holo-js/broadcast'

await broadcastRaw({
  connection: 'holo',
  event: 'orders.shipment-updated',
  channels: [`orders.${orderId}`],
  payload: { orderId, status: 'shipped' },
})
```

## Authorizing Private Channels

Private and presence channels require `/broadcasting/auth`.

Channel authorization files live in `server/channels`:

```ts
import { defineChannel } from '@holo-js/broadcast'

export default defineChannel('orders.{orderId}', {
  type: 'private',
  authorize(user, params) {
    return Boolean(user && typeof user === 'object' && String((user as { id: unknown }).id) === params.orderId)
  },
})
```

`/broadcasting/auth` is the canonical auth endpoint for private and presence subscriptions.

## Authorizing Presence Channels

Presence channel authorization returns `false` to deny or member payload to allow:

```ts
import { defineChannel } from '@holo-js/broadcast'

export default defineChannel('chat.{roomId}', {
  type: 'presence',
  authorize(user, params) {
    if (!user || typeof user !== 'object') {
      return false
    }

    return {
      id: String((user as { id: unknown }).id),
      roomId: params.roomId,
    }
  },
})
```
