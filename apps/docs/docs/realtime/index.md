# Realtime Queries And Mutations

`@holo-js/realtime` lets you define server-side queries and mutations with Convex-style authoring:

- queries read data
- mutations write data
- query results stay fresh when matching Holo database writes commit
- arguments, auth state, and return values are inferred from the definition

Core user APIs:

- `query(...)`
- `mutation(...)`

## Setup

Add realtime when creating the app:

```bash
holo new my-app --package realtime
```

Or install it in an existing app:

```bash
holo install realtime
```

Realtime installs its transport dependencies automatically. Users should not install `@holo-js/broadcast`,
`@holo-js/flux`, or framework Flux adapters separately for realtime.

Framework-specific realtime setup is only generated when realtime is installed, so base framework adapters do not pull
realtime into apps that do not use it.

## Define a query

Queries are server definitions. They validate input, read from the Holo database context, and return serializable data.

```ts
// server/realtime/posts.ts
import { query } from '@holo-js/realtime'
import { field, schema } from '@holo-js/validation'

export const listPosts = query({
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

`args.limit` is inferred as `number`, and callers must pass the same validated shape.

When `name` is omitted, Holo gives the definition a default runtime name such as `realtime.query.1`. Add a custom name
when logs or tooling should use an application-owned label:

```ts
export const listPosts = query({
  name: 'posts.list',
  access: 'public',
  handler: async ({ db }) => {
    return await db.table('posts').get()
  },
})
```

## Define a mutation

Mutations use the same argument, access, and inference model as queries. Use them for writes.

```ts
// server/realtime/posts.ts
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

Call the mutation from the app code that handles the user action:

```ts
const result = await createPost({
  title: 'First post',
  content: 'Hello Holo',
})
```

`result` is inferred as `{ created: boolean }` from the mutation handler.

With `access: 'authenticated'`, `auth` is non-null in the handler. With `access: 'public'`, `auth` is
`RealtimeAuthState | null`.

## Use a realtime query

Import the query definition and call it. Holo's framework adapters keep the returned value updated.

```ts
import { listPosts } from '~/server/realtime/posts'

const posts = listPosts({ limit: 10 })
```

The same call shape works in Next, Nuxt, and SvelteKit. Holo creates the framework runtime during scaffolding, so app
code does not create a realtime client, subscribe to a query, or choose a channel name. Browser calls run over the
broadcast websocket transport.

`posts` has the same inferred type as the normal handler return value. If the handler returns
`Promise<Post[]>`, the app receives `Post[]`.

## How queries stay fresh

Users do not define channel names or dependency strings for normal Holo database reads.

When a realtime query runs, Holo records the database dependencies that query read. If the query reads
`db.table('posts')`, writes such as `db.table('posts').insert(...)`, `db.table('posts').update(...)`, model creates,
model updates, and model deletes can refresh consumers of that query after the database write commits.

The important rule is: write through Holo's database or model APIs when you want realtime consumers to update.

Realtime refreshes are transaction-aware. Writes inside `DB.transaction(...)`, `db.connection.transaction(...)`, or
model APIs that open their own transaction do not notify subscribers until the transaction commits. If the transaction
rolls back or the mutation throws before commit, no realtime refresh is sent for the reverted writes.

Relation queries work the same way. A query that returns `Post.query().with('tags')` records the post table, the pivot
table, and the tag table reads performed by eager loading. Attaching a tag through a Holo mutation refreshes consumers
of that query after the write commits.

Pagination also uses the same query result type as the normal Holo paginator. If the realtime query returns
`paginate(...)`, the next snapshot contains the refreshed `data` and `meta` for that page. Cursor pagination is the
better fit for feeds where inserts can move records between pages.

Aggregates are regular query results. If a realtime query returns `count()`, `sum(...)`, `avg(...)`, or relation
aggregate data, Holo reruns the query after matching writes and sends the recalculated result.

## Access rules

Public access allows anonymous callers. If `@holo-js/auth` is installed and configured, public handlers still receive
the current auth state when one exists.

```ts
export const publicFeed = query({
  access: 'public',
  handler: async ({ auth, db }) => {
    const userId = auth?.user.id ?? null

    return await db.table('posts').where('viewer_id', userId).get()
  },
})
```

Authenticated access requires a current user from `@holo-js/auth`:

```ts
export const myDrafts = query({
  access: 'authenticated',
  handler: async ({ auth, db }) => {
    return await db.table('posts').where('author_id', auth.user.id).get()
  },
})
```

Named guards use the same guard names configured in auth. This works with local auth, social auth, Clerk, WorkOS, and
apps with multiple guards because realtime asks the auth runtime for the configured guard.

```ts
export const adminQueue = query({
  access: {
    require: 'authenticated',
    guard: 'admin',
  },
  handler: async ({ db }) => {
    return await db.table('moderation_items').get()
  },
})
```

Use `guards` when multiple guards are acceptable. Holo checks them in order and uses the first authenticated user.

```ts
export const staffQueue = query({
  access: {
    require: 'authenticated',
    guards: ['admin', 'support'],
  },
  handler: async ({ auth, db }) => {
    return await db.table('tickets').where('assigned_to', auth.user.id).get()
  },
})
```

Use `authorize` for request-specific checks. In authenticated access, `auth` is non-null inside `authorize`.

```ts
export const teamPosts = query({
  args: schema({
    teamId: field.number().integer(),
  }),
  access: {
    require: 'authenticated',
    authorize: async ({ args, auth, db }) => {
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

## No auth layer

Apps that do not install auth can still use public realtime queries and mutations:

```ts
export const publicStats = query({
  access: 'public',
  handler: async ({ db }) => {
    return await db.table('stats').first()
  },
})
```

Authenticated realtime definitions require `@holo-js/auth`. If auth is absent, authenticated execution fails with a
realtime auth-unavailable error.

## Type inference

Definitions carry their input and output types with them.

```ts
import { type RealtimeArgsFor, type RealtimeResultFor } from '@holo-js/realtime'
import { listPosts } from './posts'

type ListPostsArgs = RealtimeArgsFor<typeof listPosts>
type ListPostsResult = RealtimeResultFor<typeof listPosts>
```

For the earlier `listPosts` query:

- `ListPostsArgs` is `{ limit: number }`
- `ListPostsResult` is the resolved return type of the handler

## Testing

Behavior tests should execute definitions and assert user-visible outcomes. Do not test internal dependency strings
unless the behavior itself is dependency normalization.

```ts
import { describe, expect, it } from 'vitest'
import { executeRealtimeQuery } from '@holo-js/realtime'
import { listPosts } from '../server/realtime/posts'

describe('listPosts', () => {
  it('returns posts for the requested limit', async () => {
    const result = await executeRealtimeQuery(listPosts, { limit: 10 })

    expect(result.data).toHaveLength(10)
  })
})
```

For live refresh behavior, assert that a real Holo DB write produces a new query result for the consumer.
