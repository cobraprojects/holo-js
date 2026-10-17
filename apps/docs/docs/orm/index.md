# Defining Models

A model is a typed object for one database table. You use it to query rows, create and update records, and load relationships, with autocomplete for every column name.

```ts [server/models/Post.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('posts', {
  fillable: ['title', 'slug', 'body', 'status', 'user_id'],
})
```

```ts
import Post from '../models/Post'

const post = await Post.findOrFail(1)
post.title
//   ^? string

const drafts = await Post.where('status', 'draft').latest().get()
```

## Create a model

Generate a model with the CLI:

```bash
npx holo make:model Post
```

This writes `server/models/Post.ts` for the `posts` table. Add companion files with flags:

```bash
npx holo make:model Post --migration --factory --seeder --observer
```

| Flag | Short | Creates |
| --- | --- | --- |
| `--migration` | `-m` | A `create_posts_table` migration |
| `--factory` | `-f` | A `PostFactory` factory |
| `--seeder` | `-s` | A `PostSeeder` seeder |
| `--observer` | `-o` | A `PostObserver` observer, already wired into the model |
| `--table <name>` | | Uses a custom table name instead of the inferred one |

Nested names create nested folders: `npx holo make:model billing/Invoice` writes `server/models/billing/Invoice.ts`.

When you run `make:model` without flags in a terminal, Holo asks which companion files you want.

::: warning
The generated model starts with `fillable: []`, which blocks every column from `create()` and `update()`. List the columns you want to write before you use it. See [mass assignment](#mass-assignment).
:::

## Where the types come from

You don't declare columns in the model. Holo reads them from your [migrations](/database/migrations):

1. You write a migration that creates or changes the `posts` table.
2. You run `npx holo migrate`.
3. Holo regenerates `.holo-js/generated/schema.generated.ts` with every table's columns. Don't edit this file.
4. `defineModel('posts')` picks up those column types.

After a migration, every model method knows your columns:

```ts
await Post.where('status', 'published').get()
await Post.orderBy('published_at', 'desc').first()
await Post.pluck('title')
//    ^? Promise<string[]>

await Post.where('titel', 'Hello')
//               ^ TypeScript error: 'titel' is not a column of posts
```

Records are typed too. A `text().nullable()` column reads as `string | null`, a `timestamp()` as `Date`, and `create()` requires every column that has no default.

::: tip
If autocomplete shows stale columns, run `npx holo migrate` again. A model whose table isn't in the generated schema throws `Model "posts" is not present in the generated schema registry` at runtime.
:::

## Conventions

### Model names

Holo infers the model name from the table name by singularizing it and converting it to PascalCase:

| Table | Model name |
| --- | --- |
| `users` | `User` |
| `blog_posts` | `BlogPost` |
| `people` | `Person` |

The name appears in error messages and is how string relation targets like `belongsTo('User', ...)` find the model. Override it with `name`:

```ts [server/models/Person.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('people', {
  name: 'Member',
})
```

### Primary keys

Holo uses the column your migration marked as the primary key, usually `table.id()`. Set `primaryKey` only when you want a different column:

```ts
export default defineModel('countries', {
  primaryKey: 'code',
})
```

### Timestamps

If the table has `created_at` and `updated_at` columns, Holo fills them on create and refreshes `updated_at` on every save. Add both columns in a migration with `table.timestamps()`.

Turn this off, or rename the columns:

```ts
export default defineModel('audit_logs', {
  timestamps: false,
})

export default defineModel('articles', {
  createdAtColumn: 'published_on',
  updatedAtColumn: 'edited_on',
})
```

### Connections

Models use the default connection. Point a model at another named connection with `connectionName`:

```ts
export default defineModel('events', {
  connectionName: 'analytics',
})
```

See [multiple connections](/database/connections) for configuring named connections.

## Mass assignment

`create()`, `update()`, `make()`, and `save()` only write columns you allow. Writing any other column throws a `SecurityError`, so unexpected request fields never reach the database.

List allowed columns with `fillable`:

```ts
export default defineModel('users', {
  fillable: ['name', 'email', 'password'],
})
```

Or block specific columns with `guarded`, and allow the rest:

```ts
export default defineModel('users', {
  guarded: ['is_admin'],
})
```

| Setting | What can be written |
| --- | --- |
| No `fillable` or `guarded` | Every column |
| `fillable: ['name', 'email']` | Only `name` and `email` |
| `fillable: []` | Nothing |
| `fillable: ['*']` | Every column except `guarded` ones |
| `guarded: ['is_admin']` | Every column except `is_admin` |
| `guarded: ['*']` | Nothing |

Timestamp and generated ID columns are always written by Holo, even when they aren't fillable. To write a protected column from trusted code, see [writing guarded columns](/orm/writes#write-guarded-columns).

## Soft deletes

Soft-deleted rows stay in the table with a `deleted_at` timestamp and are hidden from normal queries. Add the column in a migration with `table.softDeletes()`, then enable it on the model:

```ts [server/models/Post.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('posts', {
  softDeletes: true,
})
```

Use `deletedAtColumn` if the column has a different name. If the column is missing, the model throws a `SchemaError` the first time you use it.

See [querying soft-deleted models](/orm/querying#soft-deleted-models) and [deleting and restoring](/orm/writes#soft-delete-and-restore).

## UUID, ULID, and Snowflake keys

Give the model a unique ID trait and Holo generates the key when you create a record. If you pass a key yourself, Holo keeps it.

```ts [server/models/Order.ts]
import { defineModel, HasUuids } from '@holo-js/db'

export default defineModel('orders', {
  traits: [HasUuids()],
})
```

```ts
const order = await Order.create({ total: 4999 })
order.id
// '01920c4e-7b1a-7c3e-9f00-2d5a1b7c9e10'
```

| Trait | Generates | Migration column |
| --- | --- | --- |
| `HasUuids()` | UUID v7 | `table.uuid('id').primaryKey()` |
| `HasUlids()` | ULID | `table.ulid('id').primaryKey()` |
| `HasSnowflakes()` | Snowflake ID string | `table.snowflake('id').primaryKey()` |
| `HasUniqueIds()` | Your own generator | Any string column |

Generate IDs for a column other than the primary key with `columns`. The column must be the primary key or unique:

```ts
import { defineModel, HasUlids } from '@holo-js/db'

export default defineModel('invoices', {
  traits: [HasUlids({ columns: ['public_id'] })],
})
```

Use `HasUniqueIds` with `newUniqueId` for a custom format:

```ts
import { randomUUID } from 'node:crypto'
import { defineModel, HasUniqueIds } from '@holo-js/db'

export default defineModel('tickets', {
  traits: [HasUniqueIds({ columns: ['reference'] })],
  newUniqueId: () => `TCK-${randomUUID().slice(0, 8)}`,
})
```

A model can use only one unique ID trait.

## Default attribute values

`pendingAttributes` sets starting values for new records. Values you pass to `create()` or `make()` win.

```ts
export default defineModel('posts', {
  fillable: ['title', 'body', 'status'],
  pendingAttributes: {
    status: 'draft',
  },
})
```

```ts
const post = await Post.create({ title: 'Hello', body: '...' })
post.status
// 'draft'
```

## Touching parent timestamps

`touches` updates the parent's `updated_at` whenever this model is created, saved, deleted, or restored. It's useful when a list sorts by "last activity".

```ts [server/models/Comment.ts]
import { belongsTo, defineModel } from '@holo-js/db'

export default defineModel('comments', {
  relations: {
    post: belongsTo('Post', { foreignKey: 'post_id' }),
  },
  touches: ['post'],
})
```

Only `belongsTo` and `morphTo` relations can be touched.

## Pruning old records

Define `prunable` to describe which rows are safe to delete, then run `npx holo prune`:

```ts [server/models/LoginAttempt.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('login_attempts', {
  prunable: query => query.where('created_at', '<', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
})
```

```bash
npx holo prune
npx holo prune LoginAttempt
```

Without arguments, `holo prune` prunes every model that defines `prunable`. You can also call `await LoginAttempt.prune()`, which returns the number of deleted rows.

By default Holo loads and deletes each row so [model events](/orm/observers) fire, and permanently deletes soft-deleted models. Set `massPrunable: true` to delete with a single query instead. That's faster, but skips events.

## Strict mode

Three options make the model throw instead of silently doing extra or wrong work. They're most useful in development and tests.

```ts
export default defineModel('posts', {
  preventLazyLoading: true,
  preventAccessingMissingAttributes: true,
})
```

- `preventLazyLoading` throws when you access a relationship you didn't [eager load](/orm/relationships/loading).
- `preventAccessingMissingAttributes` throws when you read a column that wasn't selected, instead of returning `undefined`.
- `automaticEagerLoading` loads a relationship for the whole result set the first time you access it on one record.

You can also toggle them at runtime: `Post.preventLazyLoading()`, `Post.preventAccessingMissingAttributes()`, `Post.automaticallyEagerLoadRelationships()`. Each takes an optional boolean.

## Model options reference

| Option | Type | Description |
| --- | --- | --- |
| `name` | `string` | Model name. Defaults to the singular PascalCase table name. |
| `primaryKey` | column | Primary key column. Defaults to the migration's primary key. |
| `connectionName` | `string` | Named database connection. |
| `fillable` | column[] | Columns allowed in mass assignment. `'*'` allows all. |
| `guarded` | column[] | Columns blocked from mass assignment. `'*'` blocks all. |
| `timestamps` | `boolean` | Fill `created_at` and `updated_at` when those columns exist. Default `true`. |
| `createdAtColumn` | column | Custom created-at column. |
| `updatedAtColumn` | column | Custom updated-at column. |
| `softDeletes` | `boolean` | Enable soft deletes. Default `false`. |
| `deletedAtColumn` | column | Custom deleted-at column. Default `deleted_at`. |
| `pendingAttributes` | object | Default values for new records. |
| `traits` | array | Unique ID trait: `HasUuids()`, `HasUlids()`, `HasSnowflakes()`, `HasUniqueIds()`. |
| `uniqueIds` | column[] | Columns that get generated IDs. Overrides the trait's `columns`. |
| `newUniqueId` | `() => string` | Custom ID generator. |
| `scopes` | object | [Local scopes](/orm/scopes). |
| `globalScopes` | object | [Global scopes](/orm/scopes#global-scopes). |
| `relations` | object | [Relationships](/orm/relationships/). |
| `with` | `string[]` | Relationships to always eager load. |
| `touches` | `string[]` | Parent relations whose `updated_at` to refresh. |
| `casts` | object | [Attribute casts](/orm/casts). |
| `accessors` | object | [Accessors](/orm/casts). |
| `mutators` | object | [Mutators](/orm/casts). |
| `hidden` | `string[]` | Attributes left out of JSON. See [serialization](/orm/serialization). |
| `visible` | `string[]` | Only these attributes appear in JSON. |
| `appended` | `string[]` | Accessors added to JSON. |
| `serializeDate` | `(date: Date) => unknown` | How dates are written to JSON. |
| `collection` | function | Custom [collection](/orm/collections) factory. |
| `events` | object | Inline [model events](/orm/observers). |
| `observers` | array | [Observers](/orm/observers). |
| `prunable` | `(query) => query` | Rows that `prune()` deletes. |
| `massPrunable` | `boolean` | Prune with one query, without events. |
| `replicationExcludes` | `string[]` | Columns that `replicate()` never copies. |
| `morphClass` | `string` | Type value stored in [polymorphic](/orm/relationships/through-and-polymorphic) columns. Defaults to the model name. |
| `preventLazyLoading` | `boolean` | Throw on lazy relationship access. |
| `preventAccessingMissingAttributes` | `boolean` | Throw when reading unselected columns. |
| `automaticEagerLoading` | `boolean` | Load a relationship for the whole result set on first access. |

## Next steps

- [Querying models](/orm/querying)
- [Creating and updating](/orm/writes)
- [Scopes](/orm/scopes)
- [Relationships](/orm/relationships/)
