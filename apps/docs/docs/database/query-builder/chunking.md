# Chunking Large Results

When a query can return thousands of rows, process them in batches instead of loading everything at once. Chunking is for background work — exports, imports, backfills, and cleanup jobs. For pages a user clicks through, use [Pagination](/database/pagination).

```ts [server/jobs/backfillSlugs.ts]
import { DB } from '@holo-js/db'

await DB.table('posts')
  .whereNull('slug')
  .chunkById(500, async (posts) => {
    for (const post of posts) {
      await DB.table('posts')
        .where('id', post.id)
        .update({ slug: `post-${post.id}` })
    }
  })
```

## Process rows in chunks

### chunk()

`chunk(size, callback)` calls your callback with each batch of rows and the batch number (starting at `1`). It waits for an async callback to finish before fetching the next batch.

```ts
await DB.table('orders')
  .where('status', 'paid')
  .orderBy('created_at')
  .chunk(1000, async (orders, batch) => {
    console.log(`Exporting batch ${batch}`)
    await writeToCsv(orders)
  })
```

`chunk()` keeps your `orderBy()` and adds the primary key as a tie-breaker, so every row is visited once.

### Stop early

Return `false` from the callback to stop processing:

```ts
await DB.table('users').chunk(200, async (users) => {
  await sendNewsletter(users)

  if (await newsletterQuotaReached()) {
    return false
  }
})
```

## Chunk by ID

### chunkById()

`chunkById(size, callback, column = 'id')` orders by the `id` column and walks forward through it. Use it when your callback updates or deletes the rows it receives — each batch starts after the last ID it saw, so changes to earlier rows don't make it skip or repeat rows.

```ts
await DB.table('sessions')
  .where('expires_at', '<', new Date())
  .chunkById(500, async (sessions) => {
    await DB.table('sessions')
      .whereIn('id', sessions.map(session => session.id))
      .delete()
  })
```

### chunkByIdDesc()

`chunkByIdDesc(size, callback, column = 'id')` works like `chunkById()`, but walks from the highest value down.

Pass a column name as the third argument to walk a different column:

```ts
await DB.table('events').chunkById(1000, handleEvents, 'event_id')
await DB.table('events').chunkByIdDesc(1000, handleEvents)
```

## Visit rows one at a time

### each()

`each(callback, count = 1000)` fetches rows in batches of `count` and calls your callback once per row. The callback receives the row and its index within the current batch. Return `false` to stop.

```ts
await DB.table('users').orderBy('id').each(async (user) => {
  await sendDigest(user)
})
```

### eachById()

`eachById(callback, count = 1000, column = 'id')` works like `each()`, but batches by ID like `chunkById()`. Use it when your callback updates the rows it visits.

```ts
await DB.table('subscriptions').where('active', false).eachById(async (subscription) => {
  await DB.table('subscriptions').where('id', subscription.id).delete()
})
```

## Stream rows one at a time

### lazy()

`lazy(size = 1000)` returns an async iterator. It still fetches rows in batches behind the scenes (1,000 by default), but you handle one row at a time with `for await`:

```ts
for await (const user of DB.table('users').where('active', true).lazy()) {
  await syncToCrm(user)
}
```

Pass a batch size to change how many rows are fetched per query:

```ts
for await (const log of DB.table('audit_logs').lazy(5000)) {
  archive.push(log)
}
```

### lazyById()

`lazyById(size = 1000, column = 'id')` streams rows like `lazy()`, but fetches each batch after the last ID it saw, like `chunkById()`. Use it when you update rows while you stream them.

```ts
for await (const user of DB.table('users').where('verified', false).lazyById()) {
  await DB.table('users').where('id', user.id).update({ reminded_at: new Date() })
}
```

### lazyByIdDesc()

`lazyByIdDesc(size = 1000, column = 'id')` works like `lazyById()`, but walks from the highest value down.

```ts
for await (const event of DB.table('events').lazyByIdDesc(500)) {
  timeline.push(event)
}
```

### cursor()

`cursor()` is the same as `lazy()` with the default batch size.

```ts
for await (const order of DB.table('orders').cursor()) {
  await reconcile(order)
}
```

## How batches are fetched

For a plain query on a table with a primary key, each batch is a separate query that continues after the last row of the previous batch. Memory use stays flat no matter how big the table is.

::: warning
Queries with joins, `distinct()`, `groupBy()`, unions, or aggregate and raw selections can't be split this way. For those, Holo runs the query once and hands you the results in batches of your chosen size, so the whole result is held in memory. Keep such queries narrow, or chunk over the main table and look up the extra data per batch.
:::

## Chunking models

[Models](/orm/querying) have the same methods. Each batch is an array of model instances.

```ts
import Post from '../models/Post'

await Post.where('status', 'draft').chunkById(200, async (posts) => {
  for (const post of posts) {
    post.set('status', 'archived')
    await post.save()
  }
})

for await (const post of Post.lazy()) {
  console.log(post.get('title'))
}
```

## Methods reference

| Method | Description |
| --- | --- |
| `chunk(size, callback)` | batches in your `orderBy()` order, with the primary key as a tie-breaker |
| `chunkById(size, callback, column = 'id')` | batches ordered by `column`, ascending |
| `chunkByIdDesc(size, callback, column = 'id')` | batches ordered by `column`, descending |
| `each(callback, count = 1000)` | one callback per row, in batches |
| `eachById(callback, count = 1000, column = 'id')` | one callback per row, batched by `column` |
| `lazy(size = 1000)` | async iterator over single rows |
| `lazyById(size = 1000, column = 'id')` | async iterator, batched by `column`, ascending |
| `lazyByIdDesc(size = 1000, column = 'id')` | async iterator, batched by `column`, descending |
| `cursor()` | same as `lazy()` |

The `chunk` callbacks receive `(rows, batchNumber)`, and the `each` callbacks receive `(row, index)`. Return `false` from either to stop.

## Next steps

- [Pagination](/database/pagination)
- [Writing Jobs](/queue/jobs)
- [Inserts, Updates, Deletes](/database/query-builder/writes)
