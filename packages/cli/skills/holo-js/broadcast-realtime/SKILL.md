---
name: holo-broadcast-realtime
description: Implement Holo-JS broadcast events, channel authorization, realtime servers, WebSockets, Flux synchronization, and framework client subscriptions.
metadata:
  type: focused
  source: https://docs.holo-js.com/broadcast/
---

# Broadcasting and realtime

Use [broadcast event and channel definitions](https://docs.holo-js.com/broadcast/defining-events-and-channels), [drivers](https://docs.holo-js.com/broadcast/config-and-drivers), [Flux and framework clients](https://docs.holo-js.com/broadcast/flux-and-frameworks), [deployment and scaling](https://docs.holo-js.com/broadcast/deployment-and-scaling), and [realtime](https://docs.holo-js.com/realtime/).

## Architecture

- `@holo-js/events` handles application-process event dispatch.
- `@holo-js/broadcast` turns selected events into authorized client-facing messages.
- `@holo-js/realtime` serves and transports the realtime protocol.
- `@holo-js/flux` and its React, Vue, or Svelte binding update client state.

```ts
export function postUpdated(postId: string) {
  return defineBroadcast({
    name: 'posts.updated',
    channels: [privateChannel('posts.{postId}', { postId })],
    payload: { postId },
  })
}
```

## Boundaries

- Authorize private or presence channel subscriptions on the server.
- Broadcast the smallest stable payload; clients can refetch canonical state.
- Do not expose secrets, hidden attributes, or authorization-only fields.
- Unsubscribe when components or requests end, and make reconnect behavior idempotent.
- For multiple realtime instances, use the documented shared driver and deployment topology.

## Completion check

- Channel names, authorization, event serialization, and client subscription agree.
- Reconnect, duplicate delivery, stale state, and cleanup behavior are tested.
- Deployment configuration supports the intended number of processes and hosts.
