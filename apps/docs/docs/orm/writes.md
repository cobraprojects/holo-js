# Creating and Updating Models

Models create, update, and delete rows for you. They fill in timestamps and generated IDs, enforce your `fillable` rules, and fire [model events](/orm/observers).

```ts [server/lib/posts.ts]
import Post from '../models/Post'

const post = await Post.create({
  title: 'Hello Holo',
  body: 'My first post.',
  user_id: 1,
})

post.title = 'Hello, Holo'
await post.save()
```

The payload is typed from your table. `create()` requires every column that has no default, and rejects columns that don't exist.

## Available methods

Each method is described in the [method reference](#method-reference) at the bottom of this page. Relation writes such as `attach()` and `createRelated()` are on the [relationship pages](/orm/relationships/).

**Create:** [create()](#create), [createMany()](#createmany), [createQuietly()](#createquietly), [createManyQuietly()](#createmanyquietly), [make()](#make), [firstOrCreate()](#firstorcreate), [createOrFirst()](#createorfirst), [firstOrNew()](#firstornew), [updateOrCreate()](#updateorcreate), [upsert()](#upsert)

**Update:** [update()](#update), [updateJson()](#updatejson), [increment()](#increment), [decrement()](#decrement), [incrementEach()](#incrementeach), [decrementEach()](#decrementeach), [fill()](#fill), [forceFill()](#forcefill), [set()](#set), [save()](#save), [push()](#push), [saveQuietly()](#savequietly), [saveMany()](#savemany)

**Delete and restore:** [delete()](#delete), [deleteQuietly()](#deletequietly), [destroy()](#destroy), [prune()](#prune), [truncate()](#truncate), [forceDelete()](#forcedelete), [forceDeleteQuietly()](#forcedeletequietly), [restore()](#restore), [restoreQuietly()](#restorequietly)

**Copy and slugs:** [replicate()](#replicate), [uniqueSlug()](#uniqueslug)

**Change tracking:** [isDirty()](#isdirty), [isClean()](#isclean), [getDirty()](#getdirty), [getChanges()](#getchanges), [wasChanged()](#waschanged), [syncOriginal()](#syncoriginal), [syncChanges()](#syncchanges)

**Events and guards:** [withoutEvents()](#withoutevents), [unguarded()](#unguarded)

**Relation writes:** [associate()](#associate), [dissociate()](#dissociate)

## Create records

`create()` inserts a row and returns the saved model, including its new ID and timestamps:

```ts
const post = await Post.create({ title: 'Hello', body: '...', user_id: 1 })
post.id
post.created_at
```

Insert several at once with `createMany()`. It returns a [collection](/orm/collections):

```ts
const posts = await Post.createMany([
  { title: 'First', body: '...', user_id: 1 },
  { title: 'Second', body: '...', user_id: 1 },
])
```

### Build first, save later

`make()` builds an unsaved instance. Set more values, then call `save()`:

```ts
const post = Post.make({ title: 'Draft', user_id: 1 })
post.body = await renderBody()
await post.save()

post.exists()
// true
```

## Update records

Change attributes on a loaded model and call `save()`. Holo only writes the columns that changed, and skips the query entirely when nothing did.

```ts
const post = await Post.findOrFail(1)
post.status = 'published'
post.published_at = new Date()
await post.save()
```

`update()` fills and saves in one step:

```ts
await post.update({ status: 'published' })
```

Update by primary key without loading the model yourself:

```ts
const post = await Post.update(1, { status: 'archived' })
```

`fill()` sets several attributes without saving. `set()` and `get()` work on one attribute at a time, the same as property access:

```ts
post.fill({ title: 'New title', excerpt: 'Short summary' })
post.set('status', 'review')
await post.save()
```

### Update many rows

Call `update()` on a query to change every matching row with one statement:

```ts
await Post.where('status', 'draft')
  .where('created_at', '<', cutoff)
  .update({ status: 'archived' })
```

On a model with timestamps, the query methods `update()`, `updateJson()`, `increment()`, and `decrement()` set `updated_at` to the current time unless you pass your own value, as Laravel does. Each call still runs a single SQL statement and doesn't fire model events. Use `chunkById()` and save each model when you need the events.

### Increment and decrement

```ts
await Post.where('id', post.id).increment('views')
await Post.where('id', post.id).increment('views', 10)
await Product.where('id', productId).decrement('stock', 1, { restocked: false })
```

The optional third argument updates other columns in the same statement. Calling `Post.increment('views')` directly on the model updates every row.

Change several columns at once with `incrementEach()` and `decrementEach()`:

```ts
await User.where('id', user.id).incrementEach({ votes: 5, balance: 100 })
```

### Update JSON columns

Use `updateJson()` with a `->` path to change one key inside a JSON column:

```ts
await User.where('id', user.id).updateJson('settings->theme', 'dark')
```

## Insert or update

`firstOrCreate()` returns the first match, or creates a record from both arguments:

```ts
const tag = await Tag.firstOrCreate(
  { slug: 'typescript' },
  { name: 'TypeScript' },
)
```

If two requests race and the table has a unique index on the matched columns, `firstOrCreate()` catches the duplicate-key error and returns the row the other request created.

`createOrFirst()` tries the insert first. When a unique index rejects it, it returns the existing row instead. Use it when the row usually doesn't exist yet. It needs a unique index on the matched columns. Inside a transaction, the insert runs in a savepoint, so a rejected insert doesn't abort the transaction:

```ts
const tag = await Tag.createOrFirst(
  { slug: 'typescript' },
  { name: 'TypeScript' },
)
```

`firstOrNew()` does the same as `firstOrCreate()` but returns an unsaved instance when nothing matches:

```ts
const tag = await Tag.firstOrNew({ slug: 'typescript' }, { name: 'TypeScript' })
if (!tag.exists()) {
  await tag.save()
}
```

`updateOrCreate()` updates the first match with the second argument, or creates a new record:

```ts
const subscription = await Subscription.updateOrCreate(
  { user_id: user.id },
  { plan: 'pro', renews_at: renewal },
)
```

`Model.upsert(match, values)` is another name for `updateOrCreate()`.

### Bulk upserts

To insert or update many rows with one statement, call `upsert()` on a query. Pass the rows, the unique columns that identify a match, and the columns to update on conflict:

```ts
await Product.query().upsert(
  [
    { sku: 'TSHIRT-S', name: 'T-Shirt S', price: 1999 },
    { sku: 'TSHIRT-M', name: 'T-Shirt M', price: 1999 },
  ],
  ['sku'],
  ['name', 'price'],
)
```

On a model with timestamps, new rows get `created_at` and `updated_at`. When you list columns to update on conflict, `updated_at` is added to them, so a conflicting row's `updated_at` changes. With no update columns, a conflicting row is left as it is.

## Track changes

Before you save, `isDirty()` tells you whether anything changed. After you save, `wasChanged()` tells you what the last save wrote. A save that creates a record reports no changes, as in Laravel, and after any save the model is clean: an attribute that a `saved` handler changes is not written and isn't reported as a change.

Changes made in place count too. Pushing onto a JSON array, editing a nested JSON value, or moving a `Date` is detected and saved. Computed values such as `withCount()` results are never written.

```ts
const post = await Post.findOrFail(1)
post.title = 'Renamed'

post.isDirty()
// true
post.isDirty('title')
// true
post.isDirty('body')
// false
post.getDirty()
// { title: 'Renamed' }

await post.save()

post.isClean()
// true
post.wasChanged('title')
// true
post.getChanges()
// { title: 'Renamed' }
```

These are useful inside [observers](/orm/observers) to react only to meaningful changes.

## Delete records

```ts
const post = await Post.findOrFail(1)
await post.delete()
```

Delete by key:

```ts
await Post.delete(1)

const deleted = await Post.destroy([2, 3, 4])
// 3
```

`delete(id)` throws a not-found error when the key doesn't exist. `destroy()` skips missing keys and returns how many it deleted. Both load each model first, so events fire.

Delete every matching row with one statement:

```ts
await Session.where('expires_at', '<', new Date()).delete()
```

Remove every row in the table with `truncate()`. It runs one statement, skips model events, and ignores `where` clauses. See [truncate()](/database/query-builder/writes#truncate) for how each database handles it.

```ts
await ImportRow.truncate()
```

## Soft delete and restore

When a model has [soft deletes](/orm/#soft-deletes) enabled, `delete()` sets `deleted_at` instead of removing the row. This applies to instance, key, and query deletes. On a model with timestamps, the soft delete and the restore also set `updated_at` to the same time. `restore()` on a model also saves its unsaved changes, as Laravel does. `forceDelete()` removes the row and doesn't write `updated_at`. Instance writes follow the model's global scopes: a row that a scope hides is not changed, and the call does nothing for it.

```ts
await post.delete()
post.trashed()
// true
```

Bring it back with `restore()`:

```ts
await post.restore()

await Post.restore(1)

const restoredCount = await Post.onlyTrashed().where('user_id', userId).restore()
```

Remove the row for good with `forceDelete()`:

```ts
await post.forceDelete()

await Post.forceDelete(1)

await Post.onlyTrashed().where('deleted_at', '<', cutoff).forceDelete()
```

## Copy a record

`replicate()` returns an unsaved copy without the primary key, generated unique IDs, or timestamps:

```ts
const copy = post.replicate()
copy.title = `${post.title} (copy)`
copy.slug = await uniqueSlug(Post, copy.title)
await copy.save()
```

Leave out more columns by passing them, or set `replicationExcludes` on the model to always skip them:

```ts
const copy = post.replicate(['slug', 'views'])
```

## Unique slugs

`uniqueSlug()` turns text into a URL slug that isn't already used in the table:

```ts
import { uniqueSlug } from '@holo-js/db'
import Post from '../models/Post'

const slug = await uniqueSlug(Post, 'Hello World')
// 'hello-world', or 'hello-world-2' if taken
```

| Option | Default | Description |
| --- | --- | --- |
| `column` | `'slug'` | Column to check |
| `ignore` | | Primary key to skip, for example the record you're editing |
| `separator` | `'-'` | Word separator |
| `fallback` | `'entry'` | Slug used when the text has no letters or digits |

```ts
const slug = await uniqueSlug(Post, input.title, { ignore: post.id })
```

Concurrent calls in the same process never return the same slug. Keep a unique index on the column to protect against other processes.

## Save a model with its relationships

`push()` saves the model plus every loaded relationship that holds model instances. Parents (`belongsTo`) are saved first, then the model, then children.

```ts
const post = await Post.with('author').findOrFail(1)
post.title = 'Updated'
post.author!.name = 'Ada Lovelace'
await post.push()
```

`Post.saveMany([first, second])` saves several instances in order.

See the [relationship pages](/orm/relationships/) for creating related records, such as `post.comments().create(...)` and `post.tags().attach(...)`.

## Write without events

Each write has a `Quietly` version that skips [model events and observers](/orm/observers):

```ts
await Post.createQuietly({ title: 'Imported', body: '...', user_id: 1 })
await Post.createManyQuietly(rows)
await post.saveQuietly()
await post.deleteQuietly()
await post.restoreQuietly()
await post.forceDeleteQuietly()
```

To silence events for every model inside a block, use `withoutEvents()`. It covers everything that runs inside the callback, including awaited calls, and nothing outside it:

```ts
await Post.withoutEvents(async () => {
  await importLegacyPosts()
})
```

## Write guarded columns

Mass assignment rules from `fillable` and `guarded` apply whenever you assign attributes. Assigning a blocked column throws a `SecurityError`, including through property assignment or `Object.assign()`. Other properties you assign onto a model, such as `attributes` or `original`, are never saved:

```ts
await User.create({ name: 'Ada', is_admin: true })
// SecurityError: Column "is_admin" is not writable on model "User".
```

When trusted server code must set a protected column on one model, use `forceFill()`:

```ts
const user = User.make({ name: 'Ada', email: 'ada@example.com' })
await user.forceFill({ is_admin: true }).save()
```

To turn the rules off for a whole block of writes, wrap them in `unguarded()`:

```ts
const admin = await User.unguarded(() => User.create({
  name: 'Ada',
  email: 'ada@example.com',
  is_admin: true,
}))
```

Inside the callback, mass assignment rules are off for every model, not only `User`. Code running outside the callback, including other requests, is unaffected. Factories and seeders already run this way, so they don't need the wrapper.

::: danger
Never pass request input straight into `unguarded()`. Validate it and pick the exact fields first.
:::

## Method reference

### create()

Inserts one row and returns the saved model. Model events fire, and generated IDs and timestamps are filled in.

```ts
const post = await Post.create({ title: 'Hello', body: '...', user_id: 1 })
```

### createMany()

Inserts each row in order and returns a [collection](/orm/collections) of the saved models.

```ts
const tags = await Tag.createMany([{ name: 'News' }, { name: 'Release' }])
```

### createQuietly()

Like `create()`, but no model events or observers run.

```ts
await Post.createQuietly({ title: 'Imported', body: '...', user_id: 1 })
```

### createManyQuietly()

Like `createMany()`, but no model events or observers run.

```ts
await Post.createManyQuietly(rows)
```

### make()

Builds an unsaved model with the model's `pendingAttributes` applied. Mass assignment rules apply, and mutators and casts run when `save()` writes the values, not when `make()` runs. Call `save()` to insert it. To turn a row you already loaded into a saved model, use [`hydrate()`](/orm/querying#hydrate).

```ts
const post = Post.make({ title: 'Draft', user_id: 1 })
await post.save()
```

### firstOrCreate()

Returns the first row that matches the first argument. If none matches, creates a row from both arguments. If a unique index rejects a concurrent insert, it returns the row the other request created.

```ts
const tag = await Tag.firstOrCreate({ slug: 'typescript' }, { name: 'TypeScript' })
```

### createOrFirst()

Creates a row from both arguments. If a unique index rejects the insert, returns the existing row that matches the first argument instead.

```ts
const tag = await Tag.createOrFirst({ slug: 'typescript' }, { name: 'TypeScript' })
```

### firstOrNew()

Returns the first matching row, or an unsaved model built from both arguments. Nothing is written until you call `save()`.

```ts
const tag = await Tag.firstOrNew({ slug: 'typescript' }, { name: 'TypeScript' })
```

### updateOrCreate()

Updates the first row that matches the first argument with the second argument, or creates a new row when nothing matches.

```ts
await Subscription.updateOrCreate({ user_id: user.id }, { plan: 'pro' })
```

### upsert()

On a model, this is an alias of `updateOrCreate()`. On a query, it's a bulk insert-or-update that takes the rows, the unique columns, and the columns to update on conflict. See [bulk upserts](#bulk-upserts).

```ts
await Subscription.upsert({ user_id: user.id }, { plan: 'pro' })

await Product.query().upsert(rows, ['sku'], ['name', 'price'])
```

### update()

On the model, `update(id, values)` loads the row, fills it, and saves it. It throws when the key doesn't exist. On an instance, `update(values)` fills and saves. On a query, `update(values)` runs one SQL statement and skips model events. See [update records](#update-records).

```ts
await Post.update(1, { status: 'archived' })
await post.update({ status: 'published' })
await Post.where('status', 'draft').update({ status: 'archived' })
```

### updateJson()

On a query, updates one key inside a JSON column using a `->` path. See [update JSON columns](#update-json-columns).

```ts
await User.where('id', user.id).updateJson('settings->theme', 'dark')
```

### increment()

Adds to a numeric column. On a query, it runs one SQL statement. The optional third argument updates other columns in the same statement.

```ts
await Post.where('id', post.id).increment('views', 10)
```

### decrement()

Subtracts from a numeric column. It takes the same arguments as `increment()`.

```ts
await Product.where('id', productId).decrement('stock', 1)
```

### incrementEach()

Adds to several numeric columns in one statement. The optional second argument updates other columns, and the model's `updated_at` is set like `increment()`.

```ts
await User.where('id', user.id).incrementEach({ votes: 5, balance: 100 })
```

### decrementEach()

Subtracts from several numeric columns in one statement. It takes the same arguments as `incrementEach()`.

```ts
await Product.where('id', productId).decrementEach({ stock: 2, reserved: 2 })
```

### fill()

Assigns several attributes on an instance without saving. It throws a `SecurityError` for any column that [mass assignment](/orm/#mass-assignment) rules block.

```ts
post.fill({ title: 'New title', excerpt: 'Short summary' })
await post.save()
```

### forceFill()

Assigns attributes without checking mass assignment rules, so the next save writes them even when they're guarded. Use it only for trusted values. See [write guarded columns](#write-guarded-columns).

```ts
post.forceFill({ views: 0 })
await post.save()
```

### set()

Assigns one attribute on an instance. It's the same as assigning the property directly, and it throws a `SecurityError` for a guarded column.

```ts
post.set('status', 'review')
```

### save()

Saves an instance. A new instance is inserted. A loaded instance updates only its changed columns, and does nothing when nothing changed. Events fire for inserts and updates, not for an empty save.

A loaded instance always updates the row it was loaded from. Changing its primary key changes that row's key; it never writes to another row.

```ts
post.title = 'Renamed'
await post.save()
```

### push()

Saves the instance, its `belongsTo` parents, and any loaded child relations that hold model instances. Parents save first, then the instance, then children. See [save with relationships](#save-a-model-with-its-relationships).

```ts
await post.push()
```

### saveQuietly()

Like `save()`, but no model events or observers run.

```ts
await post.saveQuietly()
```

### saveMany()

On the model, saves each instance in order and returns a collection of the saved models.

```ts
await Post.saveMany([first, second])
```

### delete()

On an instance, deletes the row, or soft deletes it when the model has soft deletes. On the model, `delete(id)` loads the row first and throws when the key doesn't exist. On a query, `delete()` runs one statement and skips model events. See [delete records](#delete-records).

```ts
await post.delete()
await Post.delete(1)
await Session.where('expires_at', '<', new Date()).delete()
```

### deleteQuietly()

Like an instance `delete()`, but no model events or observers run.

```ts
await post.deleteQuietly()
```

### destroy()

Deletes the rows with the given keys and returns how many were deleted. Missing keys are skipped without an error.

```ts
const deleted = await Post.destroy([2, 3, 4])
```

### prune()

Deletes the rows that the model's `prunable` option selects, and returns how many were removed. It throws when the model has no `prunable` option. See [pruning old records](/orm/#pruning-old-records).

```ts
await Post.prune()
```

### truncate()

Deletes every row in the model's table with one statement and resets the auto-increment counter. Model events don't fire.

```ts
await ImportRow.truncate()
```

### forceDelete()

Permanently deletes a row, including soft-deleted ones. On the model, `forceDelete(id)` throws when the key doesn't exist. On an instance, it fires the force-delete events. On a query, it permanently deletes every matching row, trashed or not, and returns how many it removed.

```ts
await post.forceDelete()
await Post.forceDelete(1)
```

### forceDeleteQuietly()

Like an instance `forceDelete()`, but no model events or observers run.

```ts
await post.forceDeleteQuietly()
```

### restore()

Brings back a soft-deleted row. On the model, `restore(id)` throws when the key doesn't exist. On an instance, it fires the restore events. On a query, it restores the rows the query matches, so chain it with `onlyTrashed()`. It returns how many it restored.

```ts
await post.restore()
await Post.restore(1)
```

### restoreQuietly()

Like an instance `restore()`, but no model events or observers run.

```ts
await post.restoreQuietly()
```

### replicate()

Returns an unsaved copy without the primary key, generated unique IDs, timestamps, or the deleted-at column. Pass column names to skip more. Columns in `replicationExcludes` are always skipped.

```ts
const copy = post.replicate(['views'])
await copy.save()
```

### uniqueSlug()

Returns a slug for the text that isn't used by another row in the table. See [unique slugs](#unique-slugs) for options.

```ts
const slug = await uniqueSlug(Post, 'Hello World')
```

### isDirty()

Returns `true` when any attribute, or the attribute you name, differs from the saved value.

```ts
post.isDirty('title')
```

### isClean()

Returns `true` when no attribute differs from the saved value. It's the reverse of `isDirty()`.

```ts
if (post.isClean()) {
  // nothing to save
}
```

### getDirty()

Returns an object with only the attributes that differ from the saved values.

```ts
post.getDirty()
// { title: 'Renamed' }
```

### getChanges()

Returns the attributes the last save wrote.

```ts
await post.save()
post.getChanges()
```

### wasChanged()

Returns `true` when the last save wrote any attribute, or the attribute you name.

```ts
post.wasChanged('title')
```

### syncOriginal()

Treats the current attributes as the saved values, so they are no longer dirty.

```ts
post.syncOriginal()
```

### syncChanges()

Records the current unsaved changes as the last changes, so `getChanges()` and `wasChanged()` report them.

```ts
post.syncChanges()
```

### withoutEvents()

Runs a callback with model events and observers turned off for every model. Writes inside the callback, including awaited ones, skip events. See [write without events](#write-without-events).

```ts
await Post.withoutEvents(() => importLegacyPosts())
```

### unguarded()

Runs a callback with mass assignment rules turned off. Use it only for trusted server code. See [write guarded columns](#write-guarded-columns).

```ts
await User.unguarded(() => User.create({ name: 'Ada', is_admin: true }))
```

### associate()

On an instance, sets the foreign key of a `belongsTo` or `morphTo` relation from a saved related model. Pass `null` to clear it. Call `save()` afterward to store the change.

```ts
post.associate('author', user)
await post.save()
```

### dissociate()

Clears the foreign key of a `belongsTo` or `morphTo` relation. Call `save()` afterward to store the change.

```ts
post.dissociate('author')
await post.save()
```

## Next steps

- [Observers and model events](/orm/observers)
- [Casts and mutators](/orm/casts)
- [Transactions](/database/transactions)
- [Relationships](/orm/relationships/)
