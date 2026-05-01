# ORM: Getting Started

Holo-JS models are the application-facing record layer. They are directly queryable, relation-aware, and
typed from the generated schema metadata refreshed by `npx holo migrate`.

## Introduction

Use the ORM when the query belongs to a domain record and should bring behavior with it: relations,
casts, scopes, lifecycle hooks, serialization rules, or factory support.

## Defining Models

Put model files under `server/models`. This is server-side application code.

```text
server/models/User.ts
```

The fastest way to start is:

```bash
npx holo make:model User
npx holo make:model courses/Course --migration --observer --factory --seeder
```

Use `make:model` when you want the model scaffold and optional companion files created together. Nested
model folders are supported.

```ts
import '../db/schema.generated'
import { defineModel } from '@holo-js/db'

const User = defineModel('users', {
  timestamps: true,
  softDeletes: true,
  fillable: ['name', 'email', 'settings', 'active'],
  casts: {
    settings: 'json',
    active: 'boolean',
  },
})
```

In practice, the file split should look like this:

```text
server/models/User.ts
server/api/users/index.get.ts
```

The flow is:

1. migrations define or change the table
2. `npx holo migrate` refreshes `server/db/schema.generated.ts`
3. model files define behavior
4. API routes or server services call the model

For writes, mass assignment, and trusted write paths, see [ORM Writes](/orm/writes).

## Model Conventions

### Table Names

The table name is the first argument to `defineModel(...)`.

### Primary Keys

Primary key truth comes from migrations and the generated schema artifact. The model reads it from the
generated table metadata instead of redefining it.

### UUID and ULID Keys

Unique ID strategies are supported through model configuration and the schema type system:

- UUID
- ULID
- Snowflake
- auto-increment integer IDs

Use the matching migration column type, then apply the matching trait when the model should generate new
identifiers automatically:

```ts
import { HasSnowflakes, HasUlids, HasUuids, defineModel } from '@holo-js/db'

export const ApiUser = defineModel('api_users', {
  traits: [HasUuids()],
})

export const Session = defineModel('sessions', {
  traits: [HasUlids()],
})

export const AuditActor = defineModel('audit_actors', {
  primaryKey: 'snowflake_id',
  traits: [HasSnowflakes()],
})
```

Use the matching foreign-key helper in related migrations:

```ts
export const ApiToken = defineModel('api_tokens', {
  timestamps: true,
  softDeletes: true,
})
```

With that setup, the application and the database both use `created_at`, `updated_at`, and `deleted_at`.

If you need non-standard lifecycle columns, set `createdAtColumn`, `updatedAtColumn`, or
`deletedAtColumn` on the model and point them at the exact declared keys.

### Database Connections

Models can target named connections with `connectionName`.

### Default Attribute Values

Use `pendingAttributes` when new model instances should start with a stable baseline before they are
persisted.

## Configuring ORM Strictness

Runtime strictness controls include:

- `preventLazyLoading(...)`
- `preventAccessingMissingAttributes(...)`
- automatic eager loading controls

Use these when the application should fail fast instead of hiding accidental data access patterns. They are
most useful in larger codebases where silent lazy loads or partially loaded entities become difficult to
spot in code review.

## Retrieving Models

### Common Entry Points

```ts
const user = await User.findOrFail(1)
const latest = await User.latest().first()
const page = await User.where('active', true).paginate(15)
```

Other common entry points include:

- `find(...)`
- `findOrFail(...)`
- `first(...)`
- `firstOrFail(...)`
- `firstOrCreate(...)`
- `firstOrNew(...)`
- `create(...)`
- `destroy(...)`
- `newQuery()` and `newModelQuery()`

These entry points are usually called from:

- `server/api/**` route handlers
- server services
- background jobs
- seeders and factories

They are not meant for direct browser-side usage.

### Collections

Queries returning many rows produce model-aware collections with relation loading, visibility shaping, and
query continuation helpers.

Use collections when the result set still needs ORM behavior after retrieval. If you only need raw mapping
or reduction, convert at the edge of the application.

### Chunking Results

- `chunk(...)`
- `chunkById(...)`

Use chunking for background processing and large maintenance jobs, not for user-facing pagination.

### Chunking Using Lazy Iteration

- `lazy()`
- `cursor()`

Use lazy iteration when the workflow should stream rows instead of loading the entire result set at once.

## Retrieving Single Models / Aggregates

- `sole(...)`
- `valueOrFail(...)`
- aggregate helpers through the builder surface

Use these helpers when the application expects exactly one answer or one scalar value and should fail
clearly when that expectation is wrong.

### Not Found Exceptions

Methods ending in `OrFail` throw a `ModelNotFoundException` when no matching record exists:

- `findOrFail(id)` — find by primary key or throw
- `firstOrFail()` — take the first result or throw
- `sole()` — expect exactly one result, throw if zero or more than one
- `valueOrFail(column)` — retrieve a single column value or throw

```ts
import { ModelNotFoundException } from '@holo-js/db'

try {
  const user = await User.findOrFail(42)
} catch (error) {
  if (error instanceof ModelNotFoundException) {
    console.log(error.message)    // "User not found."
    console.log(error.model)      // "User"
    console.log(error.statusCode) // 404
  }
}
```

`ModelNotFoundException` extends `DatabaseError` and carries:

| Property     | Type     | Description                                    |
| ------------ | -------- | ---------------------------------------------- |
| `message`    | `string` | Human-readable message, e.g. `"User not found."` |
| `model`      | `string` | The model name that was queried                 |
| `statusCode` | `number` | Always `404`                                    |
| `code`       | `string` | Always `"MODEL_NOT_FOUND"`                      |

Because it is a regular thrown exception, it breaks execution immediately and rolls back any active
`DB.transaction`:

```ts
await DB.transaction(async () => {
  await AuditLog.create({ action: 'attempt' })

  // This throws ModelNotFoundException — the entire transaction rolls back,
  // including the AuditLog row above.
  const user = await User.where('email', 'ghost@example.com').firstOrFail()
})
```

The `statusCode: 404` property is a convention that framework error handlers can use to produce the
correct HTTP response. How that mapping happens depends on the framework:

- **Nuxt / Nitro**: H3 reads `statusCode` from any thrown error automatically, so API routes return a
  `404` JSON response without extra handling.
- **Next.js / SvelteKit**: Catch the error in your route handler or error boundary and use
  `error.statusCode` to set the HTTP status.

## Vector Search

Use vector search when the model stores embeddings and the application needs nearest-neighbor style
retrieval.

### Define the vector column

```ts
await schema.createTable('documents', (table) => {
  table.id()
  table.vector('embedding', { dimensions: 1536 })
  table.timestamps()
})
```

### Query by similarity

```ts
const matches = await Document
  .whereVectorSimilarTo('embedding', embedding, 0.4)
  .limit(10)
  .get()
```

How it works:

- `embedding` is the vector column
- the second argument is the probe vector
- the optional third argument is the minimum similarity threshold
- lower-level SQL is compiler-generated for the active Postgres dialect

Important constraints:

- vector similarity search is Postgres-only right now
- the probe vector length must match the declared dimensions
- using `whereVectorSimilarTo(...)` on a non-vector column fails closed
- using it on SQLite or MySQL fails closed at compile time

## Inserting and Updating Models

If you want the full write guide, use [ORM Writes](/orm/writes). That page covers `create(...)`,
`make(...)`, `save()`, `update(...)`, `fillable`, `guarded`, `unguarded(...)`, and `forceFill(...)`.

- `create(...)`
- `save()`
- `saveMany(...)`
- `update(...)`
- `upsert(...)`

Example server-side workflow:

```ts
import { User } from '../models/User'

export async function createUser(input: { name: string, email: string }) {
  return await User.create({
    name: input.name,
    email: input.email,
  })
}
```

This is the normal pattern: server handlers and services call models, models call the repository layer,
and the framework handles the configured request lifecycle.

## Mass Assignment

Use `fillable` and `guarded` to control write surfaces explicitly.

Use mass assignment when route input maps directly to a known subset of model fields. Keep the allowed
fields narrow so unexpected request input cannot widen the write surface.

## Examining Attribute Changes

Entity instances expose dirty-tracking helpers such as:

- `isDirty()`
- `wasChanged()`
- `getChanges()`

Use these when the application needs to react only to meaningful changes, especially in event hooks,
observers, or audit logging.

## Deleting Models

Delete a loaded model instance when the record is already in hand:

```ts
const user = await User.findOrFail(1)

await user.delete()
```

Delete by primary key when you already know the identifier:

```ts
await User.destroy(1)
await User.destroy([2, 3, 4])
```

Delete through a model query when several rows should be removed by one condition:

```ts
await User.where('active', false).delete()
```

Use the instance form when model lifecycle behavior matters for that one entity. Use the query form when
the deletion is set-based.

## Soft Deleting

Soft deletes let the application mark a record as deleted without immediately removing the row from the
database.

### Enable soft deletes

Add the deleted-at column in the model definition:

```ts
export const User = defineModel('users', {
  softDeletes: true,
})
```

Use soft deletes when records should disappear from normal application queries but still remain available
for recovery, audit review, or delayed cleanup.

### Deleting soft-deletable models

```ts
const user = await User.findOrFail(1)

await user.delete()
```

When soft deletes are enabled, `delete()` updates the deleted-at column instead of physically removing the
row.

### Querying soft deleted models

Normal queries exclude trashed rows. Opt into them explicitly when the workflow needs them:

```ts
const allUsers = await User.withTrashed().get()
const trashedUsers = await User.onlyTrashed().get()
const activeUsers = await User.withoutTrashed().get()
```

Use `withTrashed()` for admin or audit screens. Use `onlyTrashed()` for restore flows. Use
`withoutTrashed()` when you want the intent to stay explicit in the query.

### Restoring soft deleted models

```ts
const user = await User.onlyTrashed().findOrFail(1)

await user.restore()
```

Restore when the application wants the row to become visible to normal queries again.

### Permanently deleting models

Use `forceDelete()` when the row should actually be removed:

```ts
const user = await User.withTrashed().findOrFail(1)

await user.forceDelete()
```

Set-based permanent deletion is also available through model queries:

```ts
await User.onlyTrashed().where('active', false).forceDelete()
```

Use force delete for cleanup workflows, data retention enforcement, or destructive admin actions where the
row should no longer exist at all.

## Query Scopes

### Local scopes

Use local scopes when one query pattern belongs to a model and is reused across routes or services.

```ts
export const User = defineModel('users', {
  scopes: {
    active: query => query.where('active', true),
    staff: query => query.whereIn('role', ['admin', 'editor']),
  },
})
```

Then call them from the model query:

```ts
const staffUsers = await User.active().staff().get()
```

### Global scopes

Use global scopes for stable application-wide rules such as visibility, publication state, or tenancy
constraints.

```ts
export const Post = defineModel('posts', {
  globalScopes: {
    published: query => query.where('published', true),
  },
})
```

### Removing global scopes

Remove a global scope when one query needs to bypass the default rule explicitly:

```ts
const allPosts = await Post.withoutGlobalScope('published').get()
const allScoped = await Post.withoutGlobalScopes().get()
```

### Pending attributes

Use `pendingAttributes` when newly created model instances should start with stable defaults before
persistence:

```ts
export const User = defineModel('users', {
  pendingAttributes: {
    active: true,
    locale: 'en',
  },
})
```

This is useful when new model instances should already look valid before a form or service fills the rest
of the fields.

## Comparing Models

Entity comparison helpers such as `is(...)` and `isNot(...)` compare key, table, and connection
identity.

Use them when object identity matters more than a loose property comparison, especially when the same row
may be loaded through different queries or connections.

## Events

Common lifecycle families include:

- retrieved
- creating / created
- updating / updated
- deleting / deleted
- restoring / restored
- trashed
- forceDeleting / forceDeleted
- replicating

Use model events when a small persistence-side effect belongs directly to one model. If the lifecycle
logic becomes large, move it into an observer.

### Inline event callbacks

```ts
export const User = defineModel('users', {
  events: {
    created: async user => {
      // emit audit event
    },
  },
})
```

Use inline events when the lifecycle behavior is small and tightly coupled to the model.

## Observers

Models support `observers` in `defineModel(...)`. Observer classes or objects can implement lifecycle
methods such as `created`, `updated`, `deleted`, `restored`, and `replicating`.

Put observer classes in a server-side file, usually under `server/db/observers`.

```text
server/db/observers/UserObserver.ts
```

Use `npx holo make:observer UserObserver` to scaffold the observer file. If you are creating a new model and
want the observer wired automatically, use `npx holo make:model User --observer`.

```ts
class UserObserver {
  created(user: Entity<ReturnType<typeof User>['definition']['table']>) {
    // emit audit event
  }

  updated(user: Entity<ReturnType<typeof User>['definition']['table']>) {
    // refresh derived state
  }
}

const User = defineModel('users', {
  observers: [UserObserver],
})
```

Use observers when the persistence lifecycle logic is large enough that inline model events would make the
model definition noisy.

You do not call the observer manually. The model lifecycle calls it automatically when one of its methods
matches the current event.

### Muting events

Use quiet operations when the write should skip lifecycle noise:

```ts
await User.createQuietly({
  name: 'Demo User',
  email: 'demo@example.com',
})

await user.saveQuietly()
await user.deleteQuietly()
```

That is useful for bootstrap data, admin repair workflows, or controlled maintenance scripts.

## Pruning Models

Pruning is for records that should be removed automatically once they become old or irrelevant.

```ts
export const Session = defineModel('sessions', {
  prunable: query => query.where('expires_at', '<', new Date().toISOString()),
})
```

Call pruning from an explicit operational workflow:

```ts
const deletedCount = await Session.prune()
```

Or run it through the CLI:

```bash
npx holo prune
npx holo prune Session
```

`npx holo prune` with no arguments prunes every registered model that defines `prunable`. If you explicitly
name a model that does not define `prunable`, the command fails instead of silently skipping it.

Use pruning when the cleanup rule belongs to the model itself and should stay repeatable.

Mass pruning is also supported when you want set-based deletion without per-row lifecycle dispatch.

## Replicating Models

Replication creates a new unsaved copy of an existing model instance.

```ts
const post = await Post.findOrFail(1)
const duplicate = post.replicate()

duplicate.slug = 'copied-post'
await duplicate.save()
```

Use replication when most of the source attributes should be carried over, but the new row still needs its
own identity and any workflow-specific adjustments.

## Read Next

- [Relationships](/orm/relationships)
- [Collections](/orm/collections)
- [Mutators / Casts](/orm/mutators-casts)
- [Serialization](/orm/serialization)
- [Factories](/orm/factories)
