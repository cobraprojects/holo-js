# Config And Drivers

## Configuration

Broadcasting configuration lives in `config/broadcast.ts`:

```ts
import { defineBroadcastConfig, env } from '@holo-js/config'

export default defineBroadcastConfig({
  default: env('BROADCAST_CONNECTION', 'holo'),
  connections: {
    holo: {
      driver: 'holo',
      key: env('BROADCAST_APP_KEY'),
      secret: env('BROADCAST_APP_SECRET'),
      appId: env('BROADCAST_APP_ID'),
      options: {
        host: env('BROADCAST_HOST', '127.0.0.1'),
        port: env('BROADCAST_PORT', 8080),
        scheme: env<'http' | 'https'>('BROADCAST_SCHEME', 'http'),
        useTLS: env('BROADCAST_SCHEME', 'http') === 'https',
      },
    },
    pusher: {
      driver: 'pusher',
      key: env('PUSHER_APP_KEY'),
      secret: env('PUSHER_APP_SECRET'),
      appId: env('PUSHER_APP_ID'),
      options: {
        host: env('PUSHER_HOST'),
        port: env('PUSHER_PORT', 443),
        scheme: env<'http' | 'https'>('PUSHER_SCHEME', 'https'),
        useTLS: env('PUSHER_SCHEME', 'https') === 'https',
      },
    },
    log: {
      driver: 'log',
    },
    null: {
      driver: 'null',
    },
  },
})
```

## Supported Drivers

- `driver: 'holo'` for self-hosted websocket transport.
- `driver: 'pusher'` for Pusher-compatible hosted providers.
- `driver: 'log'` for logging-only delivery.
- `driver: 'null'` for disabled delivery.

## Default Connection

Set the default connection in `default`.

## Per-Dispatch Connection Override

Override at dispatch time:

```ts
await broadcast(event).using('holo')
```

Raw dispatch override:

```ts
await broadcastRaw({
  connection: 'holo',
  event: 'orders.shipment-updated',
  channels: ['orders.1'],
  payload: { id: 1 },
})
```

## Multiple Connection Profiles

You can define multiple named connections for different apps/tenants/regions:

```ts
connections: {
  holo: { driver: 'holo', appId: 'main', key: '...', secret: '...', options: { host: 'ws-main.internal', port: 8080, scheme: 'http', useTLS: false } },
  holoAdmin: { driver: 'holo', appId: 'admin', key: '...', secret: '...', options: { host: 'ws-admin.internal', port: 8081, scheme: 'http', useTLS: false } },
}
```
