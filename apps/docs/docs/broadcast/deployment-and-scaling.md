# Deployment And Scaling

## Running The Worker

For `driver: 'holo'`, run the worker as a long-running process:

```bash
holo broadcast:work
```

If `holo` is not installed globally:

```bash
npx holo broadcast:work
pnpm dlx holo broadcast:work
yarn dlx holo broadcast:work
bunx holo broadcast:work
```

Run it under your process manager (systemd, PM2, containers, orchestration platform).
Both Bun and Node runtimes are supported for the worker process.

## Running In Production

- App server handles API and `/broadcasting/auth`.
- Websocket worker handles realtime transport and fan-out.
- Worker can run on the same host or a separate host.

Place websocket traffic behind a reverse proxy / load balancer and terminate TLS at the edge.

## Scaling

Redis-backed coordination is required for multi-node self-hosted websocket deployments.
All worker instances must share the same Redis backend for pub/sub and presence synchronization.

### Configure Redis Coordination

1. Define a shared Redis connection in `config/redis.ts`.
2. Configure broadcast scaling to use that shared Redis connection by name.
3. Start multiple `broadcast:work` processes; all must use the same Redis connection.

Example `.env`:

```bash
REDIS_URL=
REDIS_HOST=10.0.0.25
REDIS_PORT=6379
REDIS_PASSWORD=
REDIS_DB=0

BROADCAST_REDIS_CONNECTION=default
```

Example `config/redis.ts`:

```ts
import { defineRedisConfig, env } from '@holo-js/config'

export default defineRedisConfig({
  default: 'default',
  connections: {
    default: {
      url: env('REDIS_URL') || undefined,
      host: env('REDIS_HOST', '127.0.0.1'),
      port: env('REDIS_PORT', 6379),
      password: env('REDIS_PASSWORD'),
      db: env('REDIS_DB', 0),
    },
  },
})
```

Example `config/broadcast.ts`:

```ts
import { defineBroadcastConfig, env } from '@holo-js/config'

export default defineBroadcastConfig({
  default: env('BROADCAST_CONNECTION', 'reverb'),
  connections: {
    reverb: {
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
  },
  worker: {
    scaling: {
      driver: 'redis',
      connection: env('BROADCAST_REDIS_CONNECTION', 'default'),
    },
  },
})
```

Shared Redis connections resolve in this order:

1. `url`
2. `clusters`
3. `host`

So if `REDIS_URL` is present, the worker uses that target. Otherwise it uses cluster settings when defined.
Otherwise it falls back to `host` / `port` or a socket path.

Example process scaling:

```bash
# node A
holo broadcast:work

# node B
holo broadcast:work
```

If each node has a different Redis target, presence and cross-node delivery will break.

## Hosted Providers

`driver: 'pusher'` targets hosted providers.
Pusher-compatible providers should be configured through the pusher driver connection shape.

Pusher-compatible providers typically require:

- app credentials
- host
- port
- scheme / TLS settings

## Notifications Bridge

When both notifications and broadcast packages are installed, notifications on the built-in
`broadcast` channel are forwarded automatically through the broadcast runtime.

This keeps notifications and realtime delivery aligned without extra bridge code in your app.
