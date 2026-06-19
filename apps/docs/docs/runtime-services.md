# Runtime Services

Holo-JS exposes runtime services through explicit runtime objects and typed config access. The goal is to
keep request-scoped work correct without leaking state across overlapping requests.

## Where runtime services are used

Most application code touches runtime services from server-side code:

- route handlers
- server actions
- background jobs
- setup scripts
- CLI commands

These are not client-side APIs.

At deployment time, these services run inside either the web runtime or a worker runtime. Use
[Deployment](/deployment) to decide whether the application needs separate long-running worker processes.

## Shared app access

In Nuxt, Next.js, and SvelteKit, runtime context is prepared for you by the framework bootstrap.
You do not usually import and pass an app object yourself.

Use these public runtime config APIs directly:

```ts
import { useConfig, config } from '@holo-js/config'
```

Use `useConfig(...)` when you need one config section:

```ts
const services = useConfig('services')
const appName = useConfig('app.name')
```

Use `config(...)` when you need one value:

```ts
const secret = config('services.mailgun.secret')
```

## Database

Use the `DB` facade for direct table queries and transactions.

```ts
import { DB } from '@holo-js/db'

const users = await DB.table('users')
  .where('active', true)
  .orderBy('name')
  .get()
```

## Models

Models are query entry points for domain records.

```ts
const posts = await Post
  .with('author')
  .latest()
  .paginate(20)
```

Use models when the result should carry relations, casts, scopes, lifecycle hooks, or serialization.

## Storage

Use named disks through the `Storage` facade or `useStorage()`.

```ts
await Storage.disk('public').put('avatars/user-1.txt', 'ready')
```

## Queue

Use the queue runtime from server-side code when work should run now or later depending on the selected
driver.

```ts
import { dispatch } from '@holo-js/queue'

await dispatch('reports.send-digest', {
  reportId: 'daily-summary',
})
  .onConnection('redis')
  .onQueue('emails')
```

Use `dispatchSync()` when the code path must execute the job immediately.

## Events

Use events when one code path emits a domain signal and multiple listeners react:

```ts
import { Event } from '@holo-js/events'

await Event.dispatch('user.registered', {
  userId: 'user_1',
  email: 'ava@example.com',
})
```

Use queued listeners when the reaction should execute asynchronously through queue.

## Media

Use media when files belong to a model and you want collections, conversions, and model-driven retrieval
instead of ad hoc file tables.

## Async context rules

Transactions and query scheduling use async context so overlapping requests do not leak connection state
into each other.

Inside a transaction callback, keep using the active DB context or models called from that context. The
runtime keeps them pinned correctly.
