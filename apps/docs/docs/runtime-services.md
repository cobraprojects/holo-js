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

## Shared app access

Across Nuxt, Next.js, and SvelteKit, the canonical Holo-JS server helper is `holo.getApp()`.

The framework route wrapper stays native, but the Holo-JS access pattern is shared:

```ts
const app = await holo.getApp()
```

Then use the returned runtime state:

```ts
const app = await holo.getApp()

return {
  name: app.config.app.name,
  env: app.config.app.env,
  models: app.registry?.models.length ?? 0,
}
```

Use `useConfig(...)` or `config(...)` when you only need configuration values. Use `holo.getApp()` when
you need the full backend runtime surface: config, generated registry metadata, and the initialized
runtime.

## Config access

Use file-level access when you want a whole config section:

```ts
const services = useConfig('services')
```

Use dot-path access when you want one value:

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
