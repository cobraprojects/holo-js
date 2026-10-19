# Observers and Model Events

Models fire events when they are retrieved, created, updated, deleted, and restored. Listen to them with an observer class or with inline handlers to run code at those moments, such as clearing a cache or writing an audit log, and to block a write before it happens.

```bash
npx holo make:observer Post
```

```ts [server/db/observers/PostObserver.ts]
import type Post from '../../models/Post'

type PostRecord = Awaited<ReturnType<typeof Post.findOrFail>>

export class PostObserver {
  async created(post: PostRecord) {
    console.info(`Post ${post.id} created: ${post.title}`)
  }

  async deleted(post: PostRecord) {
    console.info(`Post ${post.id} deleted`)
  }
}

export default PostObserver
```

```ts [server/models/Post.ts]
import { defineModel } from '@holo-js/db'
import { PostObserver } from '../db/observers/PostObserver'

export default defineModel('posts', {
  fillable: ['title', 'slug', 'body'],
  observers: [PostObserver],
})
```

## Available events

| Event | Fires | Can cancel |
| --- | --- | --- |
| `retrieved` | After a model is loaded from the database | |
| `saving` | Before a create or an update | Yes |
| `creating` | Before a new record is inserted | Yes |
| `created` | After a new record is inserted | |
| `updating` | Before an existing record is updated | Yes |
| `updated` | After an existing record is updated | |
| `saved` | After a create or an update | |
| `deleting` | Before a delete, soft delete, or force delete | Yes |
| `trashed` | After a soft delete | |
| `deleted` | After any delete | |
| `forceDeleting` | Before a soft-deletable record is permanently deleted | Yes |
| `forceDeleted` | After a permanent delete | |
| `restoring` | Before a soft-deleted record is restored | Yes |
| `restored` | After a restore | |
| `replicating` | When `replicate()` copies a model | |

Events fire in this order:

- **Create:** `saving`, `creating`, `created`, `saved`
- **Update:** `saving`, `updating`, `updated`, `saved`
- **Delete:** `deleting`, `deleted`
- **Soft delete:** `deleting`, `trashed`, `deleted`
- **Force delete:** `deleting`, `forceDeleting`, `forceDeleted`, `deleted`
- **Restore:** `restoring`, `restored`

Calling `save()` on a model with no changes fires `saving` and then `saved`, and writes nothing. It doesn't touch `updated_at`, and it doesn't fire `updating` or `updated`. If a `saving` handler changes an attribute, the save takes the normal update path and fires `updating`, `updated`, and `saved`.

## Writing observers

An observer is a class or a plain object with a method named after each event you want. It receives the model. Holo creates a new instance of an observer class each time an event fires, so don't keep state on it.

Generate one with the CLI:

```bash
npx holo make:observer Post
```

This creates `server/db/observers/PostObserver.ts` with empty `created`, `updated`, and `deleted` methods. Add any other event names you need.

To create a model and its observer together, already wired up:

```bash
npx holo make:model Post --observer
```

### Typing the model argument

Derive the model type from the model's own `findOrFail()` so attributes autocomplete:

```ts
import type Post from '../../models/Post'

type PostRecord = Awaited<ReturnType<typeof Post.findOrFail>>
```

Use `import type` so the observer doesn't import the model at runtime.

### Registering observers

Add observers to the model's `observers` option. You can list several, and mix classes and objects:

```ts
import { defineModel } from '@holo-js/db'
import { PostObserver } from '../db/observers/PostObserver'
import { SearchIndexObserver } from '../db/observers/SearchIndexObserver'

export default defineModel('posts', {
  observers: [PostObserver, SearchIndexObserver],
})
```

Handlers run one after another, in the order listed. Async handlers are awaited before the next one starts.

## Inline event handlers

For one or two small handlers, use the `events` option instead of an observer. Each event takes a function or an array of functions:

```ts [server/models/Post.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('posts', {
  events: {
    saved: () => console.info('A post was saved'),
    deleting: [() => console.info('A post is being deleted')],
  },
})
```

Inline handlers run before observer methods for the same event.

::: info
The argument passed to inline handlers is typed as `unknown`. When you need the model's attributes, use an observer, where you can type the argument.
:::

## Cancelling a write

Return `false` from a `saving`, `creating`, `updating`, `deleting`, `forceDeleting`, or `restoring` handler to stop the operation. Holo throws a `DatabaseError` with the code `MODEL_EVENT_CANCELLED`, and nothing is written.

```ts [server/db/observers/PostObserver.ts]
import type Post from '../../models/Post'

type PostRecord = Awaited<ReturnType<typeof Post.findOrFail>>

export class PostObserver {
  deleting(post: PostRecord) {
    if (post.status === 'published') {
      return false
    }
  }
}

export default PostObserver
```

```ts
import { DatabaseError } from '@holo-js/db'

try {
  await post.delete()
} catch (error) {
  if (error instanceof DatabaseError && error.code === 'MODEL_EVENT_CANCELLED') {
    // Tell the user published posts can't be deleted
  }
  throw error
}
```

::: warning
Attributes you change inside `saving`, `creating`, or `updating` are written. For example, a `creating` handler can set a slug before the insert. Mutators run before these handlers, so a handler sees the normalized value: a `role` mutator that lowercases the input means a `creating` check for `admin` also rejects `' ADMIN '`. A value your handler changes is run through its mutator after the handler, so each write runs a mutator once.
:::

## Events and transactions

Each model write and its events run inside one database transaction. If a handler throws, including an `after` event like `created` or `deleted`, the write is rolled back.

If the write is already inside a [transaction](/database/transactions), the handlers run inside that transaction.

## Writing without events

Use the `Quietly` methods to save a single model without firing any events:

```ts
await Post.createQuietly({ title: 'Imported post' })
await Post.createManyQuietly([{ title: 'First' }, { title: 'Second' }])

await post.saveQuietly()
await post.deleteQuietly()
await post.restoreQuietly()
await post.forceDeleteQuietly()
```

To mute events for a block of code, wrap it in `withoutEvents()`:

```ts
await Post.withoutEvents(async () => {
  await Post.create({ title: 'Seeded post' })
  await Comment.create({ post_id: 1, body: 'Seeded comment' })
})
```

`withoutEvents()` mutes events for every model, not just the one you call it on, until the callback finishes.

### Bulk queries don't fire events

Updates and deletes run on a query change many rows at once and don't load each model, so no events fire:

```ts
const cutoff = new Date('2024-01-01')

await Post.where('status', 'draft').update({ status: 'archived' })
await Post.where('created_at', '<', cutoff).delete()
```

Load the models and save or delete each one if you need its events to run.

## Next steps

- [Creating and updating models](/orm/writes)
- [Transactions](/database/transactions)
- [Events](/events/)
- [CLI commands](/reference/cli)
