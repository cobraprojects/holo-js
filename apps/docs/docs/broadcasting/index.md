# Broadcasting

::: warning Experimental
Realtime and Broadcast are Experimental in 0.4.0. Production reliability work is still pending; review the [production limits](/broadcasting/production#experimental-production-limits) before relying on live updates.
:::

Broadcasting pushes server-side events to the browser over WebSockets. Use it to show live activity feeds, update dashboards when data changes, or show who else is viewing a page.

You define a broadcast event on the server, send it with `broadcast(...)`, and listen for it in your components with `useFlux(...)`.

## Quick example

This example sends a `blog.post.changed` event to signed-in admins whenever a post is saved.

Install broadcasting:

```bash
npx holo install broadcast
```

Define the event:

```ts [server/broadcast/blog-post-changed.ts]
import { defineBroadcast, privateChannel } from '@holo-js/broadcast'

export function blogPostChanged(action: 'created' | 'updated' | 'deleted', id: number, title: string) {
  return defineBroadcast({
    name: 'blog.post.changed',
    channels: [
      privateChannel('blog.admin'),
    ],
    payload: {
      action,
      id,
      title,
    },
  })
}
```

Decide who may listen on the private channel:

```ts [server/channels/blog-admin.ts]
import { defineChannel } from '@holo-js/broadcast'

export default defineChannel('blog.admin', {
  type: 'private',
  authorize(user) {
    return Boolean(user)
  },
})
```

Send the event from any server code, for example after you save a post:

```ts [server/lib/posts.ts]
import { broadcast } from '@holo-js/broadcast'
import { blogPostChanged } from '../broadcast/blog-post-changed'

export async function announcePostUpdate(post: { id: number, title: string }) {
  await broadcast(blogPostChanged('updated', post.id, post.title))
}
```

Listen for it in a component:

::: code-group

```tsx [Next.js]
// app/admin/post-activity.tsx
'use client'

import { useState } from 'react'
import { useFlux } from '@holo-js/flux-react'

export function PostActivity() {
  const [latest, setLatest] = useState('Waiting for post activity')

  useFlux('blog.admin', 'blog.post.changed', (payload) => {
    setLatest(`${payload.action}: ${payload.title}`)
  })

  return <p>{latest}</p>
}
```

```vue [Nuxt]
<!-- app/components/PostActivity.vue -->
<script setup lang="ts">
import { ref } from 'vue'
import { useFlux } from '@holo-js/flux-vue'

const latest = ref('Waiting for post activity')

useFlux('blog.admin', 'blog.post.changed', (payload) => {
  latest.value = `${payload.action}: ${payload.title}`
})
</script>

<template>
  <p>{{ latest }}</p>
</template>
```

```svelte [SvelteKit]
<!-- src/lib/PostActivity.svelte -->
<script lang="ts">
  import { useFlux } from '@holo-js/flux-svelte'

  let latest = 'Waiting for post activity'

  useFlux('blog.admin', 'blog.post.changed', (payload) => {
    latest = `${payload.action}: ${payload.title}`
  })
</script>

<p>{latest}</p>
```

:::

Finally, start the WebSocket worker in a second terminal next to your dev server:

```bash
npx holo broadcast:work
```

Save a post and the component updates without a page reload.

::: info
Private channels check the signed-in user, so this example needs [authentication](/auth/). For a channel anyone can listen to, use `channel(...)` on the server and `useFluxPublic(...)` on the client. See [Events and channels](/broadcasting/events-and-channels).
:::

## How it works

Three pieces take part in every broadcast:

1. **Your app server** calls `broadcast(...)`. Holo sends the event to the WebSocket worker over HTTP.
2. **The worker** (`npx holo broadcast:work`) keeps browser connections open and forwards the event to every socket subscribed to the channel.
3. **The browser** connects to the worker through Flux, the Holo client. Flux reads its connection settings from `/broadcasting/config` and asks `/broadcasting/auth` before it joins a private or presence channel.

Holo sets up both endpoints for you. You don't write route files for them.

## What `holo install broadcast` adds

| Added | Purpose |
| --- | --- |
| `config/broadcast.ts` | Connections and worker settings. See [Drivers and config](/broadcasting/drivers). |
| `config/redis.ts` | Created if missing. Only used when you scale the worker across servers. |
| `server/broadcast/` | Your broadcast events. |
| `server/channels/` | Authorization rules for private and presence channels. |
| `BROADCAST_CONNECTION=holo` | Added to `.env`. `.env.example` also gets `BROADCAST_APP_ID`, `BROADCAST_APP_KEY`, and `BROADCAST_APP_SECRET`. |
| `@holo-js/broadcast`, `@holo-js/flux` | Server and client packages. |
| `@holo-js/flux-react`, `@holo-js/flux-vue`, or `@holo-js/flux-svelte` | The client helpers for your framework. |

On Next.js, Holo also writes `app/broadcasting/config/route.ts`, and `app/broadcasting/auth/route.ts` when auth is installed. Nuxt and SvelteKit serve the same URLs without extra files. If you install auth after broadcasting, `holo install auth` adds the auth endpoint then.

## Packages

| Package | Use it for |
| --- | --- |
| `@holo-js/broadcast` | Defining events and channels, sending broadcasts, running the worker. Server only. |
| `@holo-js/flux` | The browser client. Use it directly for whispers or outside a component. |
| `@holo-js/flux-react` | React hooks for Next.js. |
| `@holo-js/flux-vue` | Vue composables for Nuxt. |
| `@holo-js/flux-svelte` | Svelte helpers for SvelteKit. |

## Next steps

- [Events and channels](/broadcasting/events-and-channels): queueing broadcasts, private and presence channels, guards.
- [Listening on the client](/broadcasting/client): all Flux helpers, presence members, whispers, connection status.
- [Drivers and config](/broadcasting/drivers): `config/broadcast.ts` and the available drivers.
- [Scaling in production](/broadcasting/production): running the worker behind a proxy and across servers.
- [Realtime queries](/realtime/): live query results without writing broadcast events by hand.
