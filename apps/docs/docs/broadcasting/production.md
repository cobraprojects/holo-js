# Scaling in Production

::: warning Experimental
Realtime and Broadcast are Experimental in 0.4.0. Production reliability work is still pending; review the [production limits](/broadcasting/production#experimental-production-limits) before relying on live updates.
:::

With the `holo` driver, broadcasting depends on a long-running WebSocket worker next to your web app. This page covers running that worker, putting it behind a proxy, and running several copies of it.

## Experimental production limits

Realtime and Broadcast are not production-ready. The deployment settings below do not remove these limits:

- Browsers reconnect with backoff after a socket closes or fails, and then resubscribe. A browser whose network drops without the socket closing reconnects only when the operating system reports the close, so live updates can pause until then.
- A worker that stops refreshing its Redis lease for 30 seconds, because it is stalled or can't reach Redis, loses its presence members from other workers' rosters. When it recovers, it adds its live members back, and the other workers' rosters show them again. See [Run several workers](#run-several-workers).
- Without Redis scaling, a write made in another process, such as your web app or a queue worker, does not refresh Realtime queries on this worker. With Redis scaling, it does. See [Run several workers](#run-several-workers).
- Realtime queries that use `.cache()` on the cache-database store can stall on re-entrant invalidation. Tracked in [#234](https://github.com/cobraprojects/holo-js/issues/234).
- Remote writes reach only Broadcast workers. Your web app and queue processes don't receive them, so a per-process memory cache there keeps entries for another process's writes until their TTL ends. A shared value store alone doesn't fix this, because no shared dependency index ships with Holo. Evict on write with `cache.forget()`, or keep TTLs short. See [Automatic invalidation](/cache/query-caching#automatic-invalidation).
- Remote refreshes run at most once every 100 ms per subscription. Under sustained writes from other processes, a live query can lag by up to 100 ms. The last state is always delivered. Writes in the same process refresh immediately.
- Inside a Broadcast worker, a cache store with a custom dependency index that doesn't implement `listDependencies()` keeps cached query results after a remote write until their TTL ends. The worker logs one warning.

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

### Dead connections

On Node.js and Bun, the worker sends a WebSocket ping to each connection every 30 seconds. A connection that doesn't answer a ping, and sends nothing else before the next one, is closed. Browsers answer pings automatically. A client that doesn't answer them is disconnected within 60 seconds, well inside the 120-second activity timeout the worker advertises in `pusher:connection_established`.

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

Redis shares broadcast events, presence members, and [realtime query](/realtime/) invalidations between workers. When a write commits in any process, including your web app, a queue worker, or another worker, every worker refreshes the realtime queries that read the changed rows.

Each committed query-builder or model write that changes a table is published to Redis once per registered publisher, whether or not a realtime query is subscribed. Each Broadcast worker running with Redis scaling is one publisher when realtime is installed, and so is the app runtime's sender when Redis scaling is configured. A process that runs two scaling workers therefore sends two copies of every write, even when both workers use the same Redis connection. Every copy carries the same write ID. Each receiving worker applies a write once, so it drops any copy whose write ID it has already applied. Raw SQL statements don't publish. The copies are sent after the write commits, in the background, so a slow Redis doesn't delay the write or the refresh of queries in the process that wrote. If Redis rejects a copy, the failure is reported through [exceptions.report](/basics/errors#reporting-errors). Realtime queries on other workers then keep their last result until a later write refreshes them.

Each worker keeps a Redis lease that it refreshes every 10 seconds. When a worker stops refreshing for 30 seconds, because it crashed or lost Redis, the other workers remove its presence members and send `pusher_internal:member_removed` to their subscribers. A member that is also connected to a live worker stays listed. A crashed worker's members can stay listed for up to about 40 seconds. A worker that recovers from a lapsed lease publishes its live members again, so the other workers send `pusher_internal:member_added` for each member they had removed.

Each worker also checks its own presence entries on every lease refresh. If Redis rejects the delete for a disconnected socket's member, the worker removes it on the next refresh, within about 10 seconds, and the other workers receive one `member_removed`. A member with a live socket is never removed this way.

Redis is part of the trust boundary. Workers accept presence, event, and invalidation messages from the scaling channel without verifying a signature, so anyone who can publish to that channel can add or remove presence members or trigger realtime refreshes. Run Redis on a private network reachable only by your web app and workers, and require authentication with `username` and `password` in `config/redis.ts`.

### Invalidation traffic

Each write that changes a table adds one small message per registered publisher. A message names the connection and the tables that changed, not the rows, and carries the write ID. Size Redis and the network between your processes with these rules in mind:

- The message count per write equals the number of publishers in the sending process. Two scaling workers in one process, or a worker plus the app runtime's sender, double the traffic for every write. Run one scaling worker per process where you can.
- Every receiving worker applies each write once, but it still receives every copy. Each extra publisher adds inbound messages on every worker that subscribes to the channel.
- Each process remembers up to 10,000 write IDs for 60 seconds. If more than 10,000 writes commit within 60 seconds, the oldest IDs are forgotten early. A copy that arrives after its ID is forgotten is applied again. That costs one extra refresh of the affected queries and never leaves a write unapplied.

## Next steps

- [Drivers and config](/broadcasting/drivers): every `worker` option.
- [Deploying Holo apps](/deployment/)
- [Production checklist](/deployment/checklist)
- [Running queue workers](/queue/workers)
