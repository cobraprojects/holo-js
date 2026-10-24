# Realtime Queries

::: warning Experimental
Realtime and Broadcast are Experimental in 0.4.0. Production reliability work is still pending; review the [production limits](/broadcasting/production#experimental-production-limits) before relying on live updates.
:::

Realtime queries are server functions whose results stay up to date in the browser. You write a query that reads from the database, call it from a component, and when a realtime mutation changes the rows it read, the component re-renders with fresh data. You don't define channels or events.

## Quick example

Define a query and a mutation in `server/realtime/`:

```ts [server/realtime/posts.ts]
import { mutation, query } from '@holo-js/realtime'
import { field, schema } from '@holo-js/validation'
import Post from '../models/Post'

export const latestPosts = query({
  name: 'posts.latest',
  access: 'public',
  handler: async () => {
    return {
      posts: await Post.orderBy('created_at', 'desc').limit(10).get(),
    }
  },
})

export const renamePost = mutation({
  name: 'posts.rename',
  args: schema({
    id: field.number().integer(),
    title: field.string().required().min(3),
  }),
  access: 'authenticated',
  handler: async ({ args }) => {
    const post = await Post.findOrFail(args.id)
    await post.update({ title: args.title })

    return { id: post.id, title: post.title }
  },
})
```

Call them from a component:

::: code-group

```tsx [Next.js]
// app/posts/latest-posts.tsx
'use client'

import { latestPosts, renamePost } from '@/server/realtime/posts'

export function LatestPosts() {
  const { posts } = latestPosts()

  return (
    <ul>
      {posts.map(post => (
        <li key={post.id}>
          {post.title}
          <button onClick={() => void renamePost({ id: post.id, title: `${post.title}!` })}>
            Rename
          </button>
        </li>
      ))}
    </ul>
  )
}
```

```vue [Nuxt]
<!-- app/components/LatestPosts.vue -->
<script setup lang="ts">
import { computed } from 'vue'
import { latestPosts, renamePost } from '../../server/realtime/posts'

const data = latestPosts()
const posts = computed(() => data.posts ?? [])
</script>

<template>
  <ul>
    <li v-for="post in posts" :key="post.id">
      {{ post.title }}
      <button @click="renamePost({ id: post.id, title: `${post.title}!` })">Rename</button>
    </li>
  </ul>
</template>
```

```svelte [SvelteKit]
<!-- src/lib/LatestPosts.svelte -->
<script lang="ts">
  import { latestPosts, renamePost } from '../../server/realtime/posts'

  const data = latestPosts()
</script>

<ul>
  {#each data.posts ?? [] as post (post.id)}
    <li>
      {post.title}
      <button on:click={() => renamePost({ id: post.id, title: `${post.title}!` })}>Rename</button>
    </li>
  {/each}
</ul>
```

:::

Start the broadcast worker next to your dev server:

```bash
npx holo broadcast:work
```

Click **Rename** and every open page showing the list updates.

With several app servers or queue workers, turn on [Redis scaling](/broadcasting/production#run-several-workers) for the broadcast worker. A rename saved by any of them refreshes the open pages that read the post, on every worker.

## Install

```bash
npx holo install realtime
```

This creates `server/realtime/`, adds `@holo-js/realtime` together with the [broadcasting](/broadcasting/) packages it uses, and sets up your framework. You don't install `@holo-js/broadcast` or Flux separately. When the server refuses a channel that a browser subscribes to, Flux passes the refusal to the channel's error callback. See [Subscription errors](/broadcasting/client#subscription-errors).

Live updates travel through the broadcast WebSocket worker, which needs a `holo` connection in `config/broadcast.ts`. If your app doesn't have that file yet, also run:

```bash
npx holo install broadcast
```

::: info
Without a running worker, queries and mutations still work: they run over HTTP. The page just won't update by itself after a change.
:::

## Define queries

A query reads data and returns something JSON-serializable. Models are serialized for you, so returning `Post` records gives the browser plain objects.

```ts [server/realtime/posts.ts]
import { query } from '@holo-js/realtime'
import { field, schema } from '@holo-js/validation'

export const listPosts = query({
  name: 'posts.list',
  args: schema({
    limit: field.number().integer().min(1).max(50),
  }),
  access: 'public',
  handler: async ({ args, db }) => {
    return await db
      .table('posts')
      .orderBy('created_at', 'desc')
      .limit(args.limit)
      .get()
  },
})
```

| Option | Description |
| --- | --- |
| `name` | The definition's name. The browser and server use it to find the same definition, so set it explicitly and keep it unique. See [name option](#name-option). |
| `args` | Optional [validation schema](/basics/validation/). Incoming arguments are validated before the handler runs, and `args` is typed from it. |
| `access` | Who may call it. Required. See [Access rules](#access-rules). |
| `handler` | Runs on the server and returns the result. |

The handler receives:

| Property | Description |
| --- | --- |
| `args` | The validated arguments. |
| `auth` | The signed-in user's `{ user, guard, provider }`, or `null` for anonymous callers on public definitions. |
| `db` | Database access: `db.table(name)`, `db.model(...)`, and `db.connection`. |
| `name` | The definition's name. |

You can also import your [models](/orm/) and use them directly, as in the quick example. Both are tracked the same way.

Holo strips handlers out of the browser bundle, so database code and secrets in them never reach the client.

Export each definition directly, as `export const posts = query({...})` or `export default query({...})`, with a `name` that is a string literal or a `const` in the same file set to one. Any other exported definition fails the build with the file and export named, so no server code reaches the browser.

## Call queries from components

Call the query like a function, inside a component:

```ts
const posts = listPosts({ limit: 10 })
```

The result has the handler's return type. If the handler returns `Promise<Post[]>`, `posts` is the serialized post array. The framework keeps it updated:

| Framework | Behavior |
| --- | --- |
| Next.js | Works in client components. The component suspends until the first result arrives, so wrap it in `<Suspense>` if you want a fallback. Server-rendered results are passed to the browser without a second fetch. |
| Nuxt | Returns a reactive value. It starts as an empty object and fills in when the first result arrives. |
| SvelteKit | Returns a reactive value. It starts empty and fills in when the first result arrives. |

On Nuxt and SvelteKit, guard for the empty first render, for example `data.posts ?? []`.

Within one browser client, calls with the same name and arguments share one client subscription. Each server subscription is authorized and executed independently, even when another caller subscribes to the same query and arguments.

## Define mutations

Mutations write data. They take the same options as queries:

```ts [server/realtime/posts.ts]
import { mutation } from '@holo-js/realtime'
import { field, schema } from '@holo-js/validation'

export const createPost = mutation({
  name: 'posts.create',
  args: schema({
    title: field.string().required().max(120),
    content: field.string().required(),
  }),
  access: 'authenticated',
  handler: async ({ args, auth, db }) => {
    await db.table('posts').insert({
      title: args.title,
      content: args.content,
      author_id: auth.user.id,
    })

    return { created: true }
  },
})
```

Calling a mutation returns a promise of the handler's result:

```ts
const result = await createPost({
  title: 'First post',
  content: 'Hello Holo',
})
```

`result` is typed as `{ created: boolean }`. Mutations go over the WebSocket when it's connected and fall back to HTTP otherwise.

## How queries stay fresh

When a realtime query runs, Holo records which tables and rows it read. When a mutation later writes through Holo's [query builder](/database/query-builder/) or models (inserts, updates, deletes, and relation changes such as attaching tags), Holo finds the affected queries and sends them new results.

- **Only committed writes count.** Writes inside a [transaction](/database/transactions) refresh queries after the commit. If the transaction rolls back or the mutation throws first, nothing is sent.
- **Most results are patched, not re-run.** For lists, single records, relations loaded with `with(...)`, aggregates like `count()` and `sum(...)`, and paginated results, Holo usually updates the result in place. When it can't do that safely, it re-runs your handler and sends the new result.
- **Relations serialize like a fresh query.** When a related model sets `hidden`, `visible`, `casts`, `accessors`, or `appended`, Holo re-runs the handler for that relation instead of patching it, so the result matches what the model returns on its own. The same holds for a root model with those rules, and for a handler that changes visibility or appends attributes on the records it loads.
- **Bursts are batched.** Several quick writes produce one refresh with the final data.
- **A write doesn't wait for refreshes.** Awaiting a write no longer waits for live-query refreshes already in progress; subscribers receive the update when the refresh completes.

::: warning
Live refreshes come from writes that run inside the broadcast worker, which is where realtime mutations called from the browser execute. Writes made in another process, such as a regular API route, a form action, or a queue job, don't refresh open realtime queries. Make those changes through a realtime mutation, or [broadcast an event](/broadcasting/) for them.
:::

### Pagination

Return `paginate(...)` or `cursorPaginate(...)` from a query and the browser gets the same paginator shape, kept up to date. Page-number pagination can shift when rows are inserted before the current page. For feeds and long lists, prefer cursor pagination, which keeps the window anchored:

```ts [server/realtime/feed.ts]
import { query } from '@holo-js/realtime'

export const feed = query({
  name: 'posts.feed',
  access: 'public',
  handler: async ({ db }) => {
    return await db
      .table('posts')
      .orderBy('created_at', 'desc')
      .cursorPaginate(20)
  },
})
```

See [Pagination](/database/pagination) for the paginator API.

## When the connection drops

Live queries recover after a worker restart or a network interruption. When the WebSocket closes, the browser waits and opens it again, with a wait that starts at about half a second and grows to 30 seconds. After it reconnects, Holo sends each open live query again and delivers its current result, so the page shows rows that changed while the connection was down.

- **A mutation in flight is not sent again.** If the socket closes before a mutation's result arrives, the promise rejects with a connection error. The server may already have run the mutation, so catch the error and retry only when the mutation is safe to repeat.
- **A mutation made while disconnected goes over HTTP.** Holo doesn't queue it for the socket.
- **Reconnecting stops when nothing is listening.** When the last live query is unsubscribed or its store is disconnected, the browser stops trying to reconnect.

A connection that stops answering without closing isn't detected, so live updates can stop until the page reloads. See [production limits](/broadcasting/production#experimental-production-limits).

## Access rules

Every definition sets `access`.

### Public

Anyone may call it. If [auth](/auth/) is installed and someone is signed in, `auth` holds their details. Otherwise it's `null`:

```ts
export const publicFeed = query({
  name: 'posts.public-feed',
  access: 'public',
  handler: async ({ auth, db }) => {
    const viewerId = auth?.user.id ?? null

    return await db.table('posts').where('viewer_id', viewerId).get()
  },
})
```

Public definitions work in apps without auth installed.

### Authenticated

Only signed-in users may call it, and `auth` is never `null` in the handler:

```ts
export const myDrafts = query({
  name: 'posts.my-drafts',
  access: 'authenticated',
  handler: async ({ auth, db }) => {
    return await db.table('posts').where('author_id', auth.user.id).get()
  },
})
```

Authenticated definitions need `@holo-js/auth`. Without it, calling one throws `RealtimeAuthUnavailableError`. Anonymous callers get `RealtimeUnauthorizedError`.

### Specific guards

Pass an object to choose the [guard](/auth/guards-and-providers):

```ts
export const moderationQueue = query({
  name: 'admin.moderation-queue',
  access: {
    require: 'authenticated',
    guard: 'admin',
  },
  handler: async ({ db }) => {
    return await db.table('moderation_items').get()
  },
})
```

Use `guards` to accept several. Holo tries them in order and uses the first one with a signed-in user. Don't set both `guard` and `guards`.

```ts
access: {
  require: 'authenticated',
  guards: ['admin', 'support'],
},
```

### Custom checks

Add `authorize` for checks that depend on the arguments. Return `false` to refuse with `RealtimeForbiddenError`:

```ts [server/realtime/teams.ts]
import { query } from '@holo-js/realtime'
import { field, schema } from '@holo-js/validation'

export const teamPosts = query({
  name: 'teams.posts',
  args: schema({
    teamId: field.number().integer(),
  }),
  access: {
    require: 'authenticated',
    authorize: async ({ args, auth, db }) => {
      if (!auth) {
        return false
      }

      const membership = await db
        .table('team_members')
        .where('team_id', args.teamId)
        .where('user_id', auth.user.id)
        .first()

      return Boolean(membership)
    },
  },
  handler: async ({ args, db }) => {
    return await db.table('posts').where('team_id', args.teamId).get()
  },
})
```

`authorize` receives `args`, `auth` (possibly `null`), and `db`. You can also call [authorization](/authorization/) helpers such as `authorize('update', post)` inside a handler.

## Types

Definitions carry their argument and result types:

```ts
import { type RealtimeArgsFor, type RealtimeResultFor } from '@holo-js/realtime'
import { listPosts } from './posts'

type ListPostsArgs = RealtimeArgsFor<typeof listPosts>
type ListPostsResult = RealtimeResultFor<typeof listPosts>
```

For `listPosts`, `ListPostsArgs` is `{ limit: number }` and `ListPostsResult` is the serialized handler result.

## Test realtime definitions

Run a definition directly with `executeRealtimeQuery` or `executeRealtimeMutation` from `@holo-js/realtime/server`. They validate arguments, check access, and return `{ name, data, dependencies }`:

```ts [tests/realtime/posts.test.ts]
import { describe, expect, it } from 'vitest'
import { executeRealtimeQuery } from '@holo-js/realtime/server'
import { listPosts } from '../../server/realtime/posts'

describe('listPosts', () => {
  it('returns at most the requested number of posts', async () => {
    const result = await executeRealtimeQuery(listPosts, { limit: 10 })

    expect(result.data.length).toBeLessThanOrEqual(10)
  })
})
```

See [Database tests](/testing/database) for setting up a test database.

## Available methods

Every helper exported for app code, grouped by what you use it for.

**Define**: [query()](#query), [mutation()](#mutation), [defineRealtimeQuery()](#definerealtimequery), [defineRealtimeMutation()](#definerealtimemutation), [isRealtimeDefinition()](#isrealtimedefinition), [Default export](#default-export), [name option](#name-option), [args option](#args-option), [access option](#access-option), [handler option](#handler-option), [guard option](#guard-option), [guards option](#guards-option), [authorize option](#authorize-option)

**Handler context**: [handler.args](#handler-args), [handler.auth](#handler-auth), [handler.db](#handler-db), [handler.db.table()](#handler-db-table), [handler.db.model()](#handler-db-model), [handler.db.connection](#handler-db-connection), [handler.name](#handler-name)

**Call from the browser**: [useRealtimeQuery()](#userealtimequery), [useRealtimeMutation()](#userealtimemutation), [hydrateRealtimeQuery()](#hydraterealtimequery), [getRealtimeQueryStore()](#getrealtimequerystore), [store.key](#store-key), [store.snapshot](#store-snapshot), [store.load()](#store-load), [store.connect()](#store-connect), [store.subscribe()](#store-subscribe)

**Run on the server**: [createRealtimeClient()](#createrealtimeclient), [client.query()](#client-query), [client.mutate()](#client-mutate), [client.subscribe()](#client-subscribe), [executeRealtimeQuery()](#executerealtimequery), [executeRealtimeMutation()](#executerealtimemutation), [subscribeRealtimeQuery()](#subscriberealtimequery), [subscription.id](#subscription-id), [subscription.name](#subscription-name), [subscription.current](#subscription-current), [subscription.unsubscribe()](#subscription-unsubscribe), [onData](#ondata), [onError](#onerror)

**Errors** (from `@holo-js/realtime/server`): [RealtimeError](#realtimeerror), [RealtimeUnauthorizedError](#realtimeunauthorizederror), [RealtimeForbiddenError](#realtimeforbiddenerror), [RealtimeAuthUnavailableError](#realtimeauthunavailableerror)

**Types**: [RealtimeArgsFor](#realtimeargsfor), [RealtimeResultFor](#realtimeresultfor), [RealtimeExecutionResult](#realtimeexecutionresult), [RealtimeSubscriptionSnapshot](#realtimesubscriptionsnapshot), [RealtimeSubscription](#realtimesubscription), [RealtimeSubscribeOptions](#realtimesubscribeoptions), [RealtimeAccess](#realtimeaccess), [RealtimeQueryDefinition](#realtimequerydefinition), [RealtimeMutationDefinition](#realtimemutationdefinition)

### query()

Creates a read-only realtime definition. Calling the returned function on the server runs the handler and returns its data. In a browser component it returns the live result.

```ts [server/realtime/posts.ts]
export const listPosts = query({
  name: 'posts.list',
  access: 'public',
  handler: async ({ db }) => await db.table('posts').get(),
})
```

Each definition also exposes `kind` (`'query'` or `'mutation'`), `name`, `args`, `access`, `handler`, and `$types`.

### mutation()

Creates a write realtime definition. Calling it returns a promise of the handler's result. Writes made through the query builder or models refresh open queries.

```ts [server/realtime/posts.ts]
export const renamePost = mutation({
  name: 'posts.rename',
  args: schema({ id: field.number().integer(), title: field.string().required() }),
  access: 'authenticated',
  handler: async ({ args, db }) => {
    await db.table('posts').where('id', args.id).update({ title: args.title })
    return { id: args.id }
  },
})
```

### defineRealtimeQuery()

The long name for `query()`. The two are the same function.

```ts [server/realtime/posts.ts]
export const listPosts = defineRealtimeQuery({
  name: 'posts.list',
  access: 'public',
  handler: async ({ db }) => await db.table('posts').get(),
})
```

### defineRealtimeMutation()

The long name for `mutation()`. The two are the same function.

```ts [server/realtime/posts.ts]
export const deletePost = defineRealtimeMutation({
  name: 'posts.delete',
  args: schema({ id: field.number().integer() }),
  access: 'authenticated',
  handler: async ({ args, db }) => {
    await db.table('posts').where('id', args.id).delete()
    return { deleted: true }
  },
})
```

### isRealtimeDefinition()

Returns `true` when a value was created by `query()` or `mutation()`. Use it to check an import before registering it.

```ts
import { isRealtimeDefinition } from '@holo-js/realtime'

if (isRealtimeDefinition(listPosts)) {
  console.log(listPosts.name)
}
```

### Default export

The package's default export bundles `query`, `mutation`, `defineRealtimeQuery`, `defineRealtimeMutation`, `isRealtimeDefinition`, and `createRealtimeClient`.

```ts
import realtime from '@holo-js/realtime'

export const listPosts = realtime.query({
  name: 'posts.list',
  access: 'public',
  handler: async ({ db }) => await db.table('posts').get(),
})
```

### name option

The definition's name. The browser sends this name to the server, and the server finds the definition by it, so set it explicitly and keep it unique.

```ts
query({ name: 'posts.list', access: 'public', handler: () => [] })
```

### args option

A [validation schema](/basics/validation/) for the arguments. Holo validates incoming arguments before the handler runs. Without it, `handler.args` is an empty object.

```ts
query({
  name: 'posts.list',
  args: schema({ limit: field.number().integer().min(1).max(50) }),
  access: 'public',
  handler: async ({ args, db }) => await db.table('posts').limit(args.limit).get(),
})
```

### access option

Who may call the definition. Required. Pass `'public'`, `'authenticated'`, or an object with `require` and optional `guard`, `guards`, and `authorize`.

```ts
access: { require: 'authenticated', guard: 'admin' }
```

### handler option

The function that runs on the server. It receives the handler context and returns the result. Holo removes handlers from the browser bundle.

```ts
export const myPosts = query({
  name: 'posts.mine',
  access: 'authenticated',
  handler: async ({ auth, db }) => await db.table('posts').where('author_id', auth.user.id).get(),
})
```

### guard option

Names one [auth guard](/auth/guards-and-providers) to check when the definition uses `access: { require: ... }`. Don't combine it with `guards`.

```ts
access: { require: 'authenticated', guard: 'admin' }
```

### guards option

A non-empty list of guards. Holo tries them in order and uses the first one with a signed-in user. Setting both `guard` and `guards` throws a `RealtimeError` when the definition is called.

```ts
access: { require: 'authenticated', guards: ['admin', 'support'] }
```

### authorize option

A check that runs after the access requirement, with the arguments. Return `false` to refuse the call with `RealtimeForbiddenError`.

```ts
access: {
  require: 'authenticated',
  authorize: async ({ args, auth, db }) => {
    if (!auth) {
      return false
    }

    const membership = await db
      .table('team_members')
      .where('team_id', args.teamId)
      .where('user_id', auth.user.id)
      .first()

    return Boolean(membership)
  },
},
```

### handler.args

The validated arguments from the [`args` option](#args-option). An empty object when the definition has no `args`.

```ts
handler: async ({ args, db }) => await db.table('posts').limit(args.limit).get()
```

### handler.auth

The signed-in user as `{ user, guard, provider }`. It's `null` for anonymous callers on `'public'` definitions and never `null` on `'authenticated'` ones.

```ts
handler: async ({ auth }) => ({ viewerId: auth?.user.id ?? null })
```

### handler.db

The database context: `connection`, `table()`, and `model()`.

```ts
handler: async ({ db }) => await db.table('posts').get()
```

### handler.db.table()

Starts a query on a table, by name or by table definition. It returns the same query builder you use elsewhere in Holo.

```ts
handler: async ({ db }) => await db.table('posts').where('published', true).get()
```

### handler.db.model()

Returns a model repository for a model definition. Use it when you want model behavior instead of raw table queries.

```ts
handler: async ({ db }) => db.model(Post)
```

### handler.db.connection

The underlying database connection. Use it only when you need something `table()` and `model()` don't provide.

```ts
handler: async ({ db }) => db.connection
```

### handler.name

The name of the definition that is running.

```ts
handler: async ({ name }) => ({ definition: name })
```

### useRealtimeQuery()

Returns the current data for a query, or `undefined` before the first result arrives. In Next.js, Nuxt, and SvelteKit the framework adapter makes the value reactive. Most apps call the definition directly instead. Import it from `@holo-js/realtime/client` for shared helpers.

```ts
import { useRealtimeQuery } from '@holo-js/realtime/client'
import { listPosts } from '../../server/realtime/posts'

const posts = useRealtimeQuery(listPosts, { limit: 10 })
```

### useRealtimeMutation()

Sends a mutation and returns a promise of its result. It uses the live WebSocket when connected and HTTP otherwise. Errors are reported through the framework's error handler and the promise still rejects, so catch them. If the socket closes before the result arrives, the promise rejects. See [When the connection drops](#when-the-connection-drops).

```ts
import { useRealtimeMutation } from '@holo-js/realtime/client'
import { renamePost } from '../../server/realtime/posts'

const result = await useRealtimeMutation(renamePost, { id: 1, title: 'New title' })
```

### hydrateRealtimeQuery()

Stores a snapshot for a query so the first render has data without a request. Use it to pass a server-rendered result into the browser. The snapshot has the same shape `executeRealtimeQuery()` returns, plus `version: 1`.

```ts
import { hydrateRealtimeQuery } from '@holo-js/realtime/client'
import { listPosts } from '../../server/realtime/posts'

hydrateRealtimeQuery(listPosts, { limit: 10 }, {
  name: 'posts.list',
  data: initialPosts,
  dependencies: [],
  version: 1,
})
```

### getRealtimeQueryStore()

Returns the shared store for a query and its arguments. Calls with the same name and arguments get the same store. Use the store to read, load, and follow a query without the framework hook.

```ts
import { getRealtimeQueryStore } from '@holo-js/realtime/client'
import { listPosts } from '../../server/realtime/posts'

const store = getRealtimeQueryStore(listPosts, { limit: 10 })
```

### store.key

A string that identifies the query and its arguments. The same name and arguments always produce the same key.

```ts
console.log(store.key) // "posts.list:{\"limit\":10}"
```

### store.snapshot

The latest snapshot, or `undefined` before one arrives. It has `name`, `data`, `dependencies`, and `version`.

```ts
console.log(store.snapshot?.data)
```

### store.load()

Fetches the query over HTTP once and resolves with the snapshot. Concurrent calls share one request.

```ts
const snapshot = await store.load()
```

### store.connect()

Starts the live subscription and loads the query if it hasn't loaded yet. Calling it again while connected does nothing.

```ts
store.connect()
```

### store.subscribe()

Calls a listener each time the snapshot changes. Returns a function that removes the listener. When the last listener is removed, the store disconnects.

```ts
const unsubscribe = store.subscribe(() => {
  console.log(store.snapshot?.data)
})

unsubscribe()
```

### createRealtimeClient()

Creates a server-side client with `query()`, `mutate()`, and `subscribe()`. Use it in jobs, scripts, or server code that needs to run realtime definitions without a component.

```ts
import { createRealtimeClient } from '@holo-js/realtime'
import { listPosts } from '../realtime/posts'

const realtimeClient = createRealtimeClient()
const { data } = await realtimeClient.query(listPosts, { limit: 10 })
```

### client.query()

Runs a query and resolves with `{ name, data, dependencies }`. It validates arguments and checks access, like `executeRealtimeQuery()`.

```ts
const { data } = await realtimeClient.query(listPosts, { limit: 10 })
```

### client.mutate()

Runs a mutation and resolves with `{ name, data, dependencies }`.

```ts
const { data } = await realtimeClient.mutate(renamePost, { id: 1, title: 'New title' })
```

### client.subscribe()

Starts a live subscription and resolves with a [`RealtimeSubscription`](#realtimesubscription).

```ts
const subscription = await realtimeClient.subscribe(listPosts, { limit: 10 }, {
  onData: snapshot => console.log(snapshot.data),
})
```

### executeRealtimeQuery()

Runs a query once from `@holo-js/realtime/server`. It validates the arguments, checks access, and runs the handler. It doesn't keep the result up to date. It's the function to call in tests.

```ts
import { executeRealtimeQuery } from '@holo-js/realtime/server'

const result = await executeRealtimeQuery(listPosts, { limit: 10 })
console.log(result.data)
```

### executeRealtimeMutation()

Runs a mutation once from `@holo-js/realtime/server` and resolves with `{ name, data, dependencies }`. `dependencies` is always empty for mutations.

```ts
import { executeRealtimeMutation } from '@holo-js/realtime/server'

const result = await executeRealtimeMutation(renamePost, { id: 1, title: 'New title' })
console.log(result.data)
```

### subscribeRealtimeQuery()

Subscribes to a query from `@holo-js/realtime/server` and keeps it updated after writes. It calls `onData` with the first result and again after each change. Use `unsubscribe()` to stop. Each call authorizes the caller and owns its result and refresh state. Results are never reused from another server subscription.

```ts
import { subscribeRealtimeQuery } from '@holo-js/realtime/server'

const subscription = await subscribeRealtimeQuery(listPosts, { limit: 10 }, {
  onData: snapshot => console.log(snapshot.data),
  onError: error => console.error(error),
})
```

### subscription.id

A string that identifies the subscription, in the form `subscription.<number>`.

```ts
console.log(subscription.id)
```

### subscription.name

The name of the query the subscription follows.

```ts
console.log(subscription.name) // "posts.list"
```

### subscription.current

The latest snapshot: `{ name, data, dependencies, version }`.

```ts
console.log(subscription.current.data)
```

### subscription.unsubscribe()

Stops the subscription. `onData` isn't called after this.

```ts
subscription.unsubscribe()
```

### onData

A callback in the subscribe options. It receives each snapshot, starting with the first. If it throws on the first call, the subscription is removed and the error is rethrown.

```ts
onData: snapshot => console.log(snapshot.version, snapshot.data)
```

### onError

A callback in the subscribe options. It runs when Holo can't refresh the query after a write. Errors thrown inside it are logged, not rethrown.

```ts
onError: error => console.error('Refresh failed', error)
```

### RealtimeError

The base error class. Throw it from a handler to return a message to the caller with HTTP status 400.

```ts
import { RealtimeError } from '@holo-js/realtime/server'

handler: async ({ args, db }) => {
  const post = await db.table('posts').where('id', args.id).first()
  if (!post) {
    throw new RealtimeError('Post not found.')
  }

  return post
}
```

### RealtimeUnauthorizedError

Thrown when an `'authenticated'` definition is called without a signed-in user. Its HTTP status is 401. Its default message is `Realtime access denied.`

```ts
import { RealtimeUnauthorizedError } from '@holo-js/realtime/server'

throw new RealtimeUnauthorizedError()
```

### RealtimeForbiddenError

Thrown when an `authorize` check returns `false`. Its HTTP status is 403. Its default message is `Realtime access forbidden.`

```ts
import { RealtimeForbiddenError } from '@holo-js/realtime/server'

throw new RealtimeForbiddenError('You cannot edit this team.')
```

### RealtimeAuthUnavailableError

Thrown when an `'authenticated'` definition runs but `@holo-js/auth` isn't installed or configured. Its HTTP status is 500.

```ts
import { RealtimeAuthUnavailableError } from '@holo-js/realtime/server'

throw new RealtimeAuthUnavailableError()
```

### RealtimeArgsFor

The argument type of a definition. Use it to type helpers that take args.

```ts
import { type RealtimeArgsFor } from '@holo-js/realtime'
import { listPosts } from './posts'

type ListPostsArgs = RealtimeArgsFor<typeof listPosts>
```

### RealtimeResultFor

The result type of a definition. See [Types](#types).

```ts
import { type RealtimeResultFor } from '@holo-js/realtime'
import { listPosts } from './posts'

type ListPostsResult = RealtimeResultFor<typeof listPosts>
```

### RealtimeExecutionResult

The shape returned by `executeRealtimeQuery()`, `executeRealtimeMutation()`, `client.query()`, and `client.mutate()`: `{ name, data, dependencies }`.

```ts
import { type RealtimeExecutionResult } from '@holo-js/realtime'

function logResult(result: RealtimeExecutionResult<{ id: number }>) {
  console.log(result.name, result.data.id)
}
```

### RealtimeSubscriptionSnapshot

A `RealtimeExecutionResult` plus a `version` number that increases with each change. It's what `onData` receives.

```ts
import { type RealtimeSubscriptionSnapshot } from '@holo-js/realtime'
```

### RealtimeSubscription

The object returned by `subscribeRealtimeQuery()`. It has `id`, `name`, `current`, and `unsubscribe()`.

```ts
import { type RealtimeSubscription } from '@holo-js/realtime'
```

### RealtimeSubscribeOptions

The options object for subscriptions: `onData` and `onError`.

```ts
import { type RealtimeSubscribeOptions } from '@holo-js/realtime'
```

### RealtimeAccess

The type of the `access` option: `'public'`, `'authenticated'`, or an access object.

```ts
import { type RealtimeAccess } from '@holo-js/realtime'
```

### RealtimeQueryDefinition

The type of a value returned by `query()`. Use it to type a definition you pass to a helper.

```ts
import { type RealtimeQueryDefinition } from '@holo-js/realtime'

function refresh(definition: RealtimeQueryDefinition) {
  console.log(definition.name)
}
```

### RealtimeMutationDefinition

The type of a value returned by `mutation()`.

```ts
import { type RealtimeMutationDefinition } from '@holo-js/realtime'
```

## Next steps

- [Broadcasting](/broadcasting/): send your own events to channels.
- [Scaling in production](/broadcasting/production): run the worker that delivers live updates.
- [Validation](/basics/validation/): build `args` schemas.
- [Authentication](/auth/)
