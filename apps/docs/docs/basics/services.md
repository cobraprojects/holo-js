# Using Holo Services

Holo services are the database, models, storage, queues, events, mail, cache, and config. You use them by importing them in server-side code: routes, server actions, jobs, listeners, and CLI commands. There's no container to resolve and no app object to pass around.

## Quick example

```ts [app/api/dashboard/route.ts]
import cache from '@holo-js/cache'
import { useConfig } from '@holo-js/config'
import { DB } from '@holo-js/db'
import Post from '@/server/models/Post'

export async function GET() {
  const recentPosts = await Post.latest().limit(5).get()

  const totals = await cache.remember('dashboard.totals', 60, async () => ({
    posts: await DB.table('posts').count(),
    users: await DB.table('users').count(),
  }))

  return Response.json({
    app: useConfig('app.name'),
    recentPosts,
    totals,
  })
}
```

Your framework's Holo integration loads your config and connects each service before your code runs. In a worker or CLI command, Holo does the same when the process starts.

::: warning
Holo services run on the server only. Don't import models, `DB`, or storage from client components or browser code.
:::

## Where to import each service

| Service | Import | Guide |
|---|---|---|
| Config | `import { config, useConfig } from '@holo-js/config'` | [Configuration](/getting-started/configuration) |
| Database | `import { DB } from '@holo-js/db'` | [Database](/database/) |
| Models | `import Post from '<root>/server/models/Post'` | [ORM](/orm/) |
| Storage | `import { Storage } from '@holo-js/storage/runtime'` | [File storage](/storage/) |
| Media | Methods on media models, such as `post.addMedia(file)` | [Media library](/media/) |
| Queue | Job definitions, or `import { dispatch } from '@holo-js/queue'` | [Queues](/queue/) |
| Events | Event definitions, or `import { Event } from '@holo-js/events'` | [Events](/events/) |
| Mail | `import { sendMail } from '@holo-js/mail'` | [Mail](/mail/) |
| Notifications | `import { notify } from '@holo-js/notifications'` | [Notifications](/notifications/) |
| Cache | `import cache from '@holo-js/cache'` | [Cache](/cache/) |
| Broadcasting | `import { broadcast } from '@holo-js/broadcast'` | [Broadcasting](/broadcasting/) |
| Current user | `import auth, { user } from '@holo-js/auth'` | [Authentication](/auth/) |
| Sessions | `import session from '@holo-js/session'` | [Sessions](/basics/session) |

## Read config

Use `useConfig()` to read a whole config file or one value with a dot path. `config()` does the same thing for a single value:

```ts
import { config, useConfig } from '@holo-js/config'

const app = useConfig('app')
const appName = useConfig('app.name')
const mailgunSecret = config('services.mailgun.secret')
```

Both are typed from your `config/*.ts` files, so paths autocomplete and values have the right type.

## Query the database

Use [models](/orm/) when you work with records, and the [`DB` facade](/database/query-builder/) for direct table queries:

```ts
import { DB } from '@holo-js/db'
import Post from '../models/Post'

const posts = await Post.with('author').latest().paginate(20)

const activeUsers = await DB.table('users')
  .where('active', true)
  .orderBy('name')
  .get()
```

## Store files

`Storage` writes to the default disk. Use `Storage.disk()` for a named disk from `config/storage.ts`:

```ts
import { Storage } from '@holo-js/storage/runtime'

await Storage.disk('public').put('avatars/user-1.png', avatarBytes)
const report = await Storage.get('reports/daily.txt')
```

Use the [media library](/media/) instead when a file belongs to a model:

```ts
await post.addMedia(image).toMediaCollection('images')
const thumbnailUrl = await post.getFirstMediaUrl('images', 'thumb')
```

## Run work later

Dispatch a [job](/queue/jobs) to run it on a queue worker:

```ts
import IndexBlogPost from '../jobs/blog/index-post'

await IndexBlogPost.dispatch({ action: 'created', postId: post.id })

await IndexBlogPost.dispatch({ action: 'updated', postId: post.id })
  .onQueue('search')
  .delay(30)
```

Use `dispatchSync()` when the job must run right now, in the current process.

Dispatch an [event](/events/) when one action should trigger several reactions. Each listener decides whether it runs immediately or on the queue:

```ts
import BlogPostSaved from '../events/blog/post-saved'

await BlogPostSaved.dispatch({
  action: 'created',
  postId: post.id,
  title: post.title,
  status: post.status,
  slug: post.slug,
})
```

## Use services in jobs and listeners

Jobs and listeners can use every service. The queue worker loads your project before it runs the first job:

```ts [server/jobs/blog/index-post.ts]
import { defineJob } from '@holo-js/queue'
import Post from '../../models/Post'

export default defineJob<{ postId: number }>({
  async handle(payload) {
    const post = await Post.find(payload.postId)

    return { indexed: post !== undefined }
  },
})
```

A job has no request, so there's no current user, session, or cookies. Pass the IDs you need in the payload and load the records inside the job. Payloads must be plain JSON values.

## Use services in custom commands

In a [custom command](/reference/custom-commands), wrap code that uses Holo services in `context.withRuntime()`. It loads your project, keeps it open while your callback runs, and shuts it down afterwards:

```ts [server/commands/posts/reindex.ts]
import { defineCommand } from '@holo-js/cli'
import Post from '../../models/Post'

export default defineCommand({
  description: 'Reindex all published posts.',
  async run(context) {
    const count = await context.withRuntime(async () => {
      const posts = await Post.where('status', 'published').get()
      return posts.length
    })

    console.log(`Reindexed ${count} posts.`)
  },
})
```

```bash
npx holo posts:reindex
```

## Async context rules

Holo tracks some state per async call chain rather than globally. That keeps overlapping requests from seeing each other's data. In practice:

**Transactions follow your code.** Inside a `DB.transaction()` callback, every model and `DB` query uses that transaction, including queries in functions you call from the callback. You don't need to pass the transaction around:

```ts
import { DB } from '@holo-js/db'
import Order from '../models/Order'
import Product from '../models/Product'

await DB.transaction(async () => {
  const order = await Order.create({ user_id: userId, total: 4999 })
  await reserveStock(productId, 1)
  return order
})

async function reserveStock(productId: number, quantity: number) {
  const product = await Product.findOrFail(productId)
  await product.update({ stock: product.stock - quantity })
}
```

**Await everything inside the callback.** The transaction commits when the callback's promise settles. A query you start but don't await can run after the commit, outside the transaction.

**Run side effects after commit.** To send mail or dispatch jobs only once the data is saved, run them after `DB.transaction()` returns, or register them with `DB.afterCommit()`. Events can do this for you; see [after-commit events](/events/after-commit).

**The current user belongs to the request.** `user()`, sessions, and CSRF checks read the current request. They work in route handlers, server actions, `load` functions, and form actions. They don't work in jobs, commands, or code that runs after the response is sent.

## Available functions

**Config**

- [config()](#config)
- [useConfig()](#useconfig)

**Data and files**

- [DB](#db)
- [Storage](#storage)

**Background work**

- [defineJob()](#definejob)
- [dispatch()](#dispatch)
- [dispatchSync()](#dispatchsync)
- [defineCommand()](#definecommand)

**Events and messages**

- [Event](#event)
- [dispatchEvent()](#dispatchevent)
- [sendMail()](#sendmail)
- [notify()](#notify)
- [broadcast()](#broadcast)

**Caching, auth, and sessions**

- [cache](#cache)
- [user()](#user)
- [session](#session)

### config() {#config}

Returns one config value by dot path. Defined in `@holo-js/config`. See [Read config](#read-config).

### useConfig() {#useconfig}

Returns a whole config file or one value by dot path. Defined in `@holo-js/config`. See [Read config](#read-config).

### DB {#db}

The database facade for table queries, imported from `@holo-js/db`. See [query builder](/database/query-builder/).

```ts
const count = await DB.table('posts').count()
```

### Storage {#storage}

Stores and reads files, imported from `@holo-js/storage/runtime`. See [file storage](/storage/).

### defineJob() {#definejob}

Defines a background job, imported from `@holo-js/queue`. See [queues](/queue/).

### dispatch() {#dispatch}

Queues a job for a worker to run later, imported from `@holo-js/queue`. See [Run work later](#run-work-later).

### dispatchSync() {#dispatchsync}

Runs a job now and returns its result instead of queueing it, imported from `@holo-js/queue`. See [queues](/queue/).

### defineCommand() {#definecommand}

Defines a custom `holo` command, imported from `@holo-js/cli`. See [custom commands](/reference/custom-commands).

### Event {#event}

The event facade, imported from `@holo-js/events`. See [events](/events/).

### dispatchEvent() {#dispatchevent}

Announces an event to its listeners, imported from `@holo-js/events`. See [events](/events/).

### sendMail() {#sendmail}

Sends an email, imported from `@holo-js/mail`. See [mail](/mail/).

### notify() {#notify}

Sends a notification to a notifiable, such as a user, imported from `@holo-js/notifications`. See [notifications](/notifications/).

### broadcast() {#broadcast}

Sends a real-time message to a channel, imported from `@holo-js/broadcast`. See [broadcasting](/broadcasting/).

### cache {#cache}

The cache facade, the default export of `@holo-js/cache`. See [cache](/cache/).

### user() {#user}

Returns the signed-in user, or `null` when nobody is signed in, imported from `@holo-js/auth`. See [authentication](/auth/).

### session {#session}

The session facade, the default export of `@holo-js/session`. See [sessions](/basics/session).

## Next steps

- [Routing and requests](/basics/routing)
- [Transactions](/database/transactions)
- [Writing jobs](/queue/jobs)
- [Custom commands](/reference/custom-commands)
- [How Holo works](/advanced/architecture)
