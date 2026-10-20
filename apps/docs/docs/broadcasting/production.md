# Scaling in Production

::: warning Experimental
Realtime and Broadcast are Experimental in 0.4.0. Production reliability work is still pending; review the [production limits](/broadcasting/production#experimental-production-limits) before relying on live updates.
:::

With the `holo` driver, broadcasting depends on a long-running WebSocket worker next to your web app. This page covers running that worker, putting it behind a proxy, and running several copies of it.

## Experimental production limits

Realtime and Broadcast are not production-ready. The deployment settings below do not remove these limits:

- Browsers reconnect with backoff after a socket closes or fails, and then resubscribe. A connection that stops responding without closing is not detected, so heartbeat handling and dead-connection cleanup still need reliability work. Live updates can stop silently until the page reloads.
- Presence membership can become stale after a worker crashes.
- Redis scaling shares broadcast events and presence members, but not Realtime query subscriptions. A mutation refreshes only subscribers on the worker that runs it; writes in other processes do not refresh those queries.

These items are tracked in the separate Realtime production readiness milestone. The Experimental label does not change runtime behavior or indicate that the planned 0.4.0 data-exposure fixes have already shipped.

## Quick checklist

1. Set real `BROADCAST_APP_ID`, `BROADCAST_APP_KEY`, and `BROADCAST_APP_SECRET` values, the same for the web app and the worker.
2. Run `npx holo broadcast:work` as a supervised process.
3. Point `BROADCAST_HOST` and `BROADCAST_PORT` at the worker so the web app can reach it.
4. Put the worker behind a TLS proxy and set `worker.publicHost` and `worker.publicScheme` to the address browsers use.
5. List your site's origin in `worker.allowedOrigins`.
6. Running more than one worker? Turn on [Redis scaling](#run-several-workers).

## Run the worker

```bash
npx holo broadcast:work
```

The worker prints `[broadcast] Worker listening on <host>:<port>` and runs until it receives `SIGINT` or `SIGTERM`, then shuts down cleanly. It runs on Node.js and on Bun.

Run it under a process manager such as systemd, PM2, Docker, or your platform's worker service, so it restarts if it crashes. Don't start it from inside your web server process.

The worker needs the same `config/` and `.env` as your web app. It reads `config/broadcast.ts` and loads your `server/channels/` rules. If [realtime queries](/realtime/) are installed, it also runs your realtime queries and mutations, so it needs database access too.

::: warning
Serverless and edge platforms can host the web app, but they can't keep the worker running. Run the worker on a server, container service, or worker-capable platform, and point the web app at it. See [Deploying Holo apps](/deployment/).
:::

You need the worker only for the `holo` driver. With `pusher`, `log`, or `null`, there is nothing to run.

If you send broadcasts through the queue (`.onQueue(...)`, `.delay(...)`, or `queue: { queued: true }`), you also need a [queue worker](/queue/workers).

## Put the worker behind a proxy

Two different clients talk to the worker:

- **Your web app** publishes events with HTTP `POST` to `options.host:options.port`. This can be a private address.
- **Browsers** open a WebSocket. They need a public address, usually with TLS.

When browsers reach the worker at a different address, set the `worker.public*` options:

```ts [config/broadcast.ts]
import { defineBroadcastConfig } from '@holo-js/broadcast'
import { env } from '@holo-js/config'

export default defineBroadcastConfig({
  default: 'holo',
  worker: {
    publicHost: env('BROADCAST_PUBLIC_HOST', 'ws.example.com'),
    publicPort: 443,
    publicScheme: 'https',
    allowedOrigins: [env('APP_URL', 'https://example.com')],
  },
  connections: {
    holo: {
      driver: 'holo',
      appId: env('BROADCAST_APP_ID'),
      key: env('BROADCAST_APP_KEY'),
      secret: env('BROADCAST_APP_SECRET'),
      options: {
        host: env('BROADCAST_HOST', '10.0.0.12'),
        port: env('BROADCAST_PORT', 8080),
        scheme: 'http',
      },
      clientOptions: {
        authEndpoint: `${env('APP_URL', 'https://example.com')}/broadcasting/auth`,
      },
    },
  },
})
```

Here the web app publishes to `http://10.0.0.12:8080`, and browsers connect to `wss://ws.example.com/app/<key>`. Terminate TLS at the proxy and forward WebSocket upgrades on the `/app/` path to the worker port.

### Allowed origins

The worker checks the `Origin` header on every browser WebSocket and refuses connections from origins not in `worker.allowedOrigins` with `403`. List each site that embeds your app, as exact origins without paths:

```ts
worker: {
  allowedOrigins: ['https://example.com', 'https://admin.example.com'],
}
```

Connections without an `Origin` header, such as server-to-server clients, are allowed. Use `['*']` only if you really mean to accept any site.

### Health checks and stats

| URL | Response |
| --- | --- |
| `GET /health` | `{ "ok": true }`. Always on. Point your load balancer here. |
| `GET /stats` | Node ID, uptime, connection count, subscribed and presence channel counts, and scaling info. Returns `404` unless `worker.statsEnabled` is `true`. |

Change the paths with `worker.healthPath` and `worker.statsPath`.

::: warning
The worker doesn't authenticate `/stats`. If you enable it, block it at your proxy or keep it on a private network.
:::

### Size limits

The worker rejects publish requests larger than `worker.maxRequestBytes` (1 MB by default) with `413`, and closes sockets that send messages larger than `worker.maxMessageBytes` (64 KB by default) with code `1009`. Raise them only if your payloads need it.

### Connection limits

Each WebSocket connection can hold 100 channels and 100 realtime query subscriptions, and can send 200 messages in each one-second window. These limits are fixed in 0.4.0 and can't be changed in configuration.

- A channel subscription beyond the limit gets `pusher:subscription_error` with status `429`. The socket stays open.
- A realtime subscription beyond the limit gets a `holo:realtime:error` event with the message `Too many realtime subscriptions.` and status `429`. The socket stays open.
- A connection that sends more than 200 messages in a one-second window, pings included, is closed with code `1008`.

The worker also closes a connection with code `1008` when more than 4 MB of output is waiting to be sent to it, so a client that stops reading can't make the worker hold unbounded memory.

### Errors

The worker never sends internal error details to clients. It passes the original error to your [error reporter](/basics/errors#reporting-errors) and sends a generic message instead:

| Failure | Client receives |
| --- | --- |
| A channel check throws | `pusher:subscription_error` with status `500`. See [Refused subscriptions](/broadcasting/events-and-channels#refused-subscriptions). |
| A realtime query or mutation throws an unexpected error | `Realtime request failed.` with status `500` |
| A publish request fails | `Broadcast publish failed.` with status `500` |

[`RealtimeError`](/realtime/#realtimeerror), access errors, and validation errors are meant for the caller, so they keep their message.

Each connection gets a random socket ID in the Pusher `123.456` format. If a new connection would reuse an ID already connected to the same worker, the worker closes it with code `4200` and the client reconnects.

## Run several workers

One worker keeps its connections and presence lists in memory. To run several workers, for more connections or for redundancy, they must share state through Redis. Otherwise an event published to one worker never reaches browsers connected to another, and presence lists are wrong.

Install the `ioredis` package in your app, then set `worker.scaling`:

```ts [config/broadcast.ts]
import { defineBroadcastConfig } from '@holo-js/broadcast'
import { env } from '@holo-js/config'

export default defineBroadcastConfig({
  default: 'holo',
  worker: {
    allowedOrigins: [env('APP_URL', 'https://example.com')],
    scaling: {
      driver: 'redis',
      connection: env('BROADCAST_REDIS_CONNECTION', 'default'),
    },
  },
  connections: {
    holo: {
      driver: 'holo',
      appId: env('BROADCAST_APP_ID'),
      key: env('BROADCAST_APP_KEY'),
      secret: env('BROADCAST_APP_SECRET'),
      options: {
        host: env('BROADCAST_HOST', '127.0.0.1'),
        port: env('BROADCAST_PORT', 8080),
      },
    },
  },
})
```

`connection` names a connection in `config/redis.ts`, which `holo install broadcast` created for you:

```ts [config/redis.ts]
import { env } from '@holo-js/config'
import { defineRedisConfig } from '@holo-js/kernel'

export default defineRedisConfig({
  default: env('REDIS_CONNECTION', 'default'),
  connections: {
    default: {
      url: env('REDIS_URL') || undefined,
      host: env('REDIS_HOST', '127.0.0.1'),
      port: env('REDIS_PORT', 6379),
      username: env('REDIS_USERNAME'),
      password: env('REDIS_PASSWORD'),
      db: env('REDIS_DB', 0),
    },
  },
})
```

Start the same command on each server:

```bash
npx holo broadcast:work
```

Every worker must point at the same Redis server and database. Put a load balancer in front of them for browser traffic. Your web app can publish to any one of them.

Without `ioredis` installed, the worker refuses to start with scaling enabled.

Redis shares broadcast events and presence members between workers. It doesn't share [realtime query](/realtime/) subscriptions: a realtime mutation refreshes only the subscribers connected to the worker that ran it.

## Next steps

- [Drivers and config](/broadcasting/drivers): every `worker` option.
- [Deploying Holo apps](/deployment/)
- [Production checklist](/deployment/checklist)
- [Running queue workers](/queue/workers)
