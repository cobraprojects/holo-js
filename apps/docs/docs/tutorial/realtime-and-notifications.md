# 10. Realtime and Notifications

In this chapter the admin area starts reacting to changes as they happen. When anyone creates, edits, or deletes a post, every open admin dashboard updates without a reload. You'll also run follow-up work in a background job, and see where the auth emails come from.

## What you'll build

- a `blog.post.changed` broadcast on a private `blog.admin` channel
- a live "latest activity" line on the admin dashboard
- a `blog.post.saved` event, a listener, and a queued job that runs after each change
- a realtime admin post list you can rename posts from, which updates in every open tab
- a look at the email notifications Holo uses for sign-up and password reset

## Step 1: Define the broadcast and its channel

A broadcast is a message sent from the server to browsers over a websocket. A channel decides who may listen.

```ts [server/broadcast/blog-post-changed.ts]
import { defineBroadcast, privateChannel } from '@holo-js/broadcast'

export function blogPostChanged(action: 'created' | 'updated' | 'deleted', id: number, title: string, status: string, slug: string) {
  return defineBroadcast({
    name: 'blog.post.changed',
    channels: [
      privateChannel('blog.admin'),
    ],
    payload: {
      action,
      id,
      title,
      status,
      slug,
    },
  })
}
```

```ts [server/channels/blog-admin.ts]
import { defineChannel } from '@holo-js/broadcast'

export default defineChannel('blog.admin', {
  type: 'private',
  authorize(user) {
    return Boolean(user)
  },
})
```

- **`privateChannel('blog.admin')`** sends the message only to listeners who passed the channel's `authorize` check.
- **`authorize(user)`** runs when a browser asks to join. Here, any signed-in user may join; guests may not.

## Step 2: Define the event, listener, and job

An event says "something happened". Listeners react to it. Here the listener queues a job, which is where you'd put slow follow-up work such as updating a search index.

```ts [server/events/blog/post-saved.ts]
import { defineEvent } from '@holo-js/events'

export const BlogPostSaved = defineEvent<{
  action: 'created' | 'updated' | 'deleted'
  postId: number
  title: string
  status: string
  slug: string
}>({
  name: 'blog.post.saved',
})

export default BlogPostSaved
```

```ts [server/jobs/blog/index-post.ts]
import { defineJob } from '@holo-js/queue'

import Post from '../../models/Post'

export const IndexBlogPost = defineJob<{
  action: 'created' | 'updated' | 'deleted'
  postId: number
}>({
  queue: 'default',
  async handle(payload) {
    const post = await Post.find(payload.postId)

    return {
      action: payload.action,
      postId: payload.postId,
      indexed: post !== undefined,
      title: post?.title ?? null,
    }
  },
})

export default IndexBlogPost
```

```ts [server/listeners/blog/index-saved-post.ts]
import { defineListener } from '@holo-js/events'

import BlogPostSaved from '../../events/blog/post-saved'
import IndexBlogPost from '../../jobs/blog/index-post'

export default defineListener({
  listensTo: [BlogPostSaved],
  async handle(event) {
    await IndexBlogPost.dispatch({
      action: event.payload.action,
      postId: event.payload.postId,
    })
  },
})
```

Holo discovers events, listeners, and jobs from these folders, the same way it finds models and policies.

## Step 3: Send them after every post change

In `blog.ts`, import the broadcast helpers and the event:

::: code-group

```ts [Next.js]
// server/lib/blog.ts
import { broadcast } from '@holo-js/broadcast'

import { blogPostChanged } from '../broadcast/blog-post-changed'
import BlogPostSaved from '../events/blog/post-saved'
```

```ts [Nuxt]
// server/lib/blog.ts
import { broadcast } from '@holo-js/broadcast'

import { blogPostChanged } from '../broadcast/blog-post-changed'
import BlogPostSaved from '../events/blog/post-saved'
```

```ts [SvelteKit]
// src/lib/server/blog.ts
import { broadcast } from '@holo-js/broadcast'

import { blogPostChanged } from '../../../server/broadcast/blog-post-changed'
import BlogPostSaved from '../../../server/events/blog/post-saved'
```

:::

In `createPost()` and `updatePost()`, broadcast the change as the last step inside the transaction, then dispatch the event after it. Use `'updated'` in `updatePost()`:

```ts
  const post = await DB.transaction(async () => {
    // ...the same create and tag code as before...

    await broadcast(blogPostChanged('created', post.id, post.title, post.status, post.slug))
    return post
  })

  // ...the same image upload code as before...

  await BlogPostSaved.dispatch({
    action: 'created',
    postId: post.id,
    title: post.title,
    status: post.status,
    slug: post.slug,
  })

  return post
```

Update `deletePost()` so it keeps the deleted post's details for the message:

```ts
export async function deletePost(id: number) {
  const post = await DB.transaction(async () => {
    const post = await Post.find(id)
    if (post) {
      await post.tags().detach()
    }

    await Post.delete(id)
    if (post) {
      await broadcast(blogPostChanged('deleted', post.id, post.title, post.status, post.slug))
    }

    return post
  })

  if (post) {
    await BlogPostSaved.dispatch({
      action: 'deleted',
      postId: post.id,
      title: post.title,
      status: post.status,
      slug: post.slug,
    })
  }
}
```

Each broadcast is the last step inside its transaction. If the broadcast server isn't running, `broadcast()` throws an error saying it could not reach the broadcast worker, the transaction rolls back, and the user sees that error instead of a half-saved post. The event is dispatched after the transaction commits, so its listeners only ever see saved posts.

Your project uses the `sync` queue driver, so `IndexBlogPost` runs right away, inside the same request. To run jobs in the background instead, switch to the `database` or `redis` driver and start a worker with `npx holo queue:work`. See [Queue drivers](/queue/drivers).

## Step 4: Show live activity on the dashboard

Subscribe to the channel in the browser with `useFlux(channel, event, callback)`:

::: code-group

```tsx [Next.js]
// app/admin/broadcast-feed.tsx
'use client'

import { useState } from 'react'
import { useFlux } from '@holo-js/flux-react'

export function BroadcastFeed() {
  const [latestPostChange, setLatestPostChange] = useState('Waiting for post activity')

  useFlux('blog.admin', 'blog.post.changed', (payload) => {
    setLatestPostChange(`${payload.action}: ${payload.title}`)
  })

  return (
    <article>
      <strong>Live post activity</strong>
      <div>{latestPostChange}</div>
    </article>
  )
}

// app/admin/page.tsx — render it on the dashboard:
// import { BroadcastFeed } from './broadcast-feed'
// ...
// <BroadcastFeed />
```

```vue [Nuxt]
<!-- app/pages/admin/index.vue -->
<script setup lang="ts">
import { useFlux } from '@holo-js/flux-vue'

const { data } = await useFetch('/api/admin/dashboard', {
  pick: ['postCount', 'publishedCount', 'categoryCount', 'tagCount'],
})
const latestPostChange = ref('Waiting for post activity')

useFlux('blog.admin', 'blog.post.changed', (payload) => {
  latestPostChange.value = `${payload.action}: ${payload.title}`
})
</script>

<template>
  <section>
    <h1>Admin</h1>
    <!-- ...the counts and links from chapter 5... -->
    <article>
      <strong>Live post activity</strong>
      <div>{{ latestPostChange }}</div>
    </article>
  </section>
</template>
```

```svelte [SvelteKit]
<!-- src/routes/admin/+page.svelte -->
<script lang="ts">
  import { useFlux } from '@holo-js/flux-svelte'
  import { type PageData } from './$types'

  export let data: PageData
  let latestPostChange = 'Waiting for post activity'

  useFlux('blog.admin', 'blog.post.changed', (payload) => {
    latestPostChange = `${payload.action}: ${payload.title}`
  })
</script>

<section>
  <h1>Admin</h1>
  <!-- ...the counts and links from chapter 5... -->
  <article>
    <strong>Live post activity</strong>
    <div>{latestPostChange}</div>
  </article>
</section>
```

:::

`payload` is the object you passed as `payload` in `defineBroadcast()`. The browser signs in to the private channel through the `/broadcasting/auth` route that the project creator added.

## Step 5: Start the broadcast server

Broadcasts travel through a separate websocket server. Start it in a second terminal and leave it running next to `npm run dev`:

```bash
npx holo broadcast:work
```

If it isn't running, your writes still succeed. Browsers just don't receive the live messages.

## Step 6: Add a realtime post list

Broadcasts send a message you handle yourself. Realtime queries go one step further: the browser gets the query result, and Holo re-sends it whenever a write changes the data.

```ts [server/realtime/posts.ts]
import { authorize } from '@holo-js/authorization'
import { uniqueSlug } from '@holo-js/db'
import { mutation, query } from '@holo-js/realtime'
import { field, schema } from '@holo-js/validation'

import Category from '../models/Category'
import Post from '../models/Post'
import Tag from '../models/Tag'

export const adminPosts = query({
  name: 'blog.admin.posts',
  access: 'authenticated',
  handler: async () => {
    await authorize('viewAny', Post)

    return {
      posts: await Post.with('category', 'tags').orderBy('created_at', 'desc').get(),
      categories: await Category.orderBy('name').get(),
      tags: await Tag.orderBy('name').get(),
    }
  },
})

export const renameAdminPost = mutation({
  name: 'blog.admin.posts.rename',
  args: schema({
    id: field.number().integer(),
    title: field.string().required('Title is required.').min(3),
  }),
  access: 'authenticated',
  handler: async ({ args }) => {
    const title = args.title.trim()
    const post = await Post.findOrFail(args.id)
    await authorize('update', post)
    await post.update({
      title,
      slug: await uniqueSlug(Post, title, { ignore: args.id }),
    })

    return { id: post.id, title }
  },
})
```

- **`query()`** defines a read. **`mutation()`** defines a write, with its arguments checked by a schema.
- **`access: 'authenticated'`** refuses guests before the handler runs. The policy checks from chapter 8 still apply inside.

Call them from a page as if they were local functions:

::: code-group

```tsx [Next.js]
// app/admin/posts/realtime/realtime-posts-demo.tsx
'use client'

import { useState, useTransition } from 'react'
import { adminPosts, renameAdminPost } from '@/server/realtime/posts'

export default function RealtimePostsDemo() {
  const data = adminPosts()
  const [selectedPostId, setSelectedPostId] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [isPending, startTransition] = useTransition()

  function savePost() {
    if (!selectedPostId) {
      return
    }

    startTransition(() => {
      void renameAdminPost({ id: selectedPostId, title })
    })
  }

  return (
    <section>
      <h1>Realtime posts</h1>
      <form onSubmit={(event) => { event.preventDefault(); savePost() }}>
        <input aria-label="Post title" value={title} onChange={event => setTitle(event.target.value)} />
        <button type="submit" disabled={!selectedPostId || isPending}>Save title</button>
      </form>
      {data.posts.map(post => (
        <article key={post.id}>
          <h2>{post.title}</h2>
          <button type="button" onClick={() => { setSelectedPostId(post.id); setTitle(post.title) }}>Edit title</button>
        </article>
      ))}
    </section>
  )
}

// app/admin/posts/realtime/page.tsx
import RealtimePostsDemo from './realtime-posts-demo'

export default function RealtimePostsPage() {
  return <RealtimePostsDemo />
}
```

```vue [Nuxt]
<!-- app/pages/admin/posts/realtime.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue'
import { adminPosts, renameAdminPost } from '../../../../server/realtime/posts'

const data = adminPosts()
const selectedPostId = ref<number | null>(null)
const title = ref('')
const saving = ref(false)
const posts = computed(() => data.posts ?? [])

async function savePost() {
  if (!selectedPostId.value) {
    return
  }

  saving.value = true
  try {
    await renameAdminPost({ id: selectedPostId.value, title: title.value })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section>
    <h1>Realtime posts</h1>
    <form @submit.prevent="savePost">
      <input v-model="title" aria-label="Post title">
      <button type="submit" :disabled="!selectedPostId || saving">Save title</button>
    </form>
    <article v-for="post in posts" :key="post.id">
      <h2>{{ post.title }}</h2>
      <button type="button" @click="selectedPostId = post.id; title = post.title">Edit title</button>
    </article>
  </section>
</template>
```

```svelte [SvelteKit]
<!-- src/routes/admin/posts/realtime/+page.svelte -->
<script>
  import { adminPosts, renameAdminPost } from '../../../../../server/realtime/posts'

  const data = adminPosts()
  let selectedPostId = null
  let title = ''
  let saving = false

  async function savePost() {
    if (!selectedPostId) {
      return
    }

    saving = true
    try {
      await renameAdminPost({ id: selectedPostId, title })
    } finally {
      saving = false
    }
  }
</script>

<section>
  <h1>Realtime posts</h1>
  <form on:submit|preventDefault={savePost}>
    <input bind:value={title} aria-label="Post title">
    <button type="submit" disabled={!selectedPostId || saving}>Save title</button>
  </form>
  {#each data.posts || [] as post (post.id)}
    <article>
      <h2>{post.title}</h2>
      <button type="button" on:click={() => { selectedPostId = post.id; title = post.title }}>Edit title</button>
    </article>
  {/each}
</section>
```

:::

The import looks like it pulls server code into the browser, but it doesn't. Holo replaces it with a small client that calls the server and subscribes to updates. The handler code, and the database, stay on the server.

## Step 7: Find the auth email notifications

Because you selected `auth` and `notifications`, the project creator added two notifications:

- `server/notifications/auth/email-verification.ts` — the "verify your email address" message
- `server/notifications/auth/password-reset.ts` — the "reset your password" message

Each one uses `defineNotification()` and describes the email:

```ts [server/notifications/auth/email-verification.ts]
import { defineNotification } from '@holo-js/notifications'

interface EmailVerificationNotification {
  readonly email: string
  readonly name?: string
  readonly url: string
  readonly expiresAt: Date
}

export default defineNotification({
  type: 'auth.email-verification',
  via() {
    return ['email']
  },
  build: {
    email(data: EmailVerificationNotification) {
      return {
        subject: 'Verify your email address',
        greeting: data.name ? `Hello ${data.name},` : undefined,
        lines: [
          'Confirm your account to finish signing in.',
          `This verification link expires at ${data.expiresAt.toUTCString()}.`,
        ],
        action: {
          label: 'Verify email address',
          url: data.url,
        },
      }
    },
  },
})
```

Edit the subject, lines, or button label to change the email. Holo's auth flows use these notifications for email verification (see `emailVerification.required` in chapter 7) and password reset.

In development the mailer is `preview`, so no real email leaves your machine. Each message is saved as a JSON file in `.holo-js/runtime/mail-preview/`. Set `MAIL_MAILER=smtp` and the `MAIL_HOST`/`MAIL_PORT` values in `.env` to send through a local mail catcher or a real server.

## Step 8: Check it works

1. Make sure `npm run dev` and `npx holo broadcast:work` are both running.
2. Sign in as the editor and open `/admin` in two browser tabs.
3. In the first tab, create a post called "Live Update Test". The second tab's dashboard shows "created: Live Update Test" without a reload.
4. Edit and then delete that post. The second tab shows `updated: ...` and then `deleted: ...`.
5. Open `/admin/posts/realtime` in both tabs. Click "Edit title" on a post in one tab, change the title, and save. The new title appears in both tabs.
6. Sign out in one tab and open `/admin/posts/realtime` again. You're sent to `/login`.

## Next steps

Next, test and ship the blog in [Testing and Deployment](/tutorial/testing-and-deployment).

To learn more:

- [Broadcasting](/broadcasting/)
- [Events and channels](/broadcasting/events-and-channels)
- [Listening on the client](/broadcasting/client)
- [Realtime queries](/realtime/)
- [Events](/events/) and [listeners](/events/listeners)
- [Queues](/queue/) and [jobs](/queue/jobs)
- [Notifications](/notifications/) and [writing notifications](/notifications/writing)
- [Previewing mail](/mail/previewing)
