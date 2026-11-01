# Inserts, Updates, Deletes

The query builder writes rows directly, without model events or casts. Use it for bulk changes, counters, and imports. When you want [model events](/orm/observers), timestamps, and mass-assignment protection, use [model writes](/orm/writes) instead.

```ts [server/lib/posts.ts]
import { DB } from '@holo-js/db'

const id = await DB.table('posts').insertGetId({
  title: 'Hello World',
  slug: 'hello-world',
  status: 'draft',
  user_id: 1,
})

await DB.table('posts')
  .where('id', id)
  .update({ status: 'published', published_at: new Date() })
```

## Write results

`insert()`, `insertOrIgnore()`, `upsert()`, `update()`, `increment()`, `decrement()`, and `delete()` all return the same shape:

```ts
type WriteResult = {
  affectedRows?: number
  lastInsertId?: number | string
}
```

```ts
const result = await DB.table('posts').where('status', 'spam').delete()
console.log(`Removed ${result.affectedRows ?? 0} posts`)
```

## Insert rows

### insert()

`insert()` adds one row or an array of rows. Pass one object or an array of objects:

```ts
await DB.table('tags').insert({ name: 'Laravel', slug: 'laravel' })

await DB.table('tags').insert([
  { name: 'Nuxt', slug: 'nuxt' },
  { name: 'SvelteKit', slug: 'sveltekit' },
])
```

### insertGetId()

`insertGetId()` inserts one row and returns its auto-incrementing ID:

```ts
const userId = await DB.table('users').insertGetId({
  name: 'Ava',
  email: 'ava@example.com',
})
```

### insertOrIgnore()

`insertOrIgnore()` skips rows that would violate a unique constraint instead of throwing:

```ts
const result = await DB.table('subscribers').insertOrIgnore([
  { email: 'ava@example.com' },
  { email: 'sam@example.com' },
])
// result.affectedRows is the number of rows actually inserted
```

### insertUsing()

`insertUsing(columns, query)` inserts the rows that another query selects, in one statement. The query's selected columns fill `columns` in order.

```ts
await DB.table('archived_orders').insertUsing(
  ['id', 'total'],
  DB.table('orders').select('id', 'total').where('created_at', '<', cutoff),
)
```

### insertOrIgnoreUsing()

`insertOrIgnoreUsing(columns, query)` works like `insertUsing()`, but skips rows that would violate a unique constraint.

```ts
await DB.table('archived_orders').insertOrIgnoreUsing(
  ['id', 'total'],
  DB.table('orders').select('id', 'total'),
)
```

## Insert or update (upsert)

### upsert()

`upsert()` inserts rows, and updates them when a row with the same unique key already exists.

```ts
await DB.table('products').upsert(
  [
    { sku: 'TSHIRT-M', name: 'T-shirt (M)', price: 20 },
    { sku: 'TSHIRT-L', name: 'T-shirt (L)', price: 22 },
  ],
  ['sku'],
  ['name', 'price'],
)
```

| Argument | Meaning |
| --- | --- |
| `values` | one row or an array of rows; every row must have the same columns |
| `uniqueBy` | the columns that identify an existing row — they need a unique index or primary key |
| `updateColumns` | the columns to overwrite on an existing row; leave empty to keep existing rows unchanged |

## Update or insert

### updateOrInsert()

`updateOrInsert(attributes, values = {})` updates the rows that match `attributes`. When none match, it inserts one row with `attributes` and `values` merged. It returns a `boolean`.

```ts
await DB.table('users').updateOrInsert(
  { email: 'ava@example.com' },
  { name: 'Ava', votes: 1 },
)
```

Pass a function to choose the values based on whether a matching row exists:

```ts
await DB.table('users').updateOrInsert(
  { email: 'ava@example.com' },
  exists => exists ? { name: 'Ava' } : { name: 'Ava', votes: 1 },
)
```

## Update rows

### update()

`update()` changes every row that matches the query:

```ts
await DB.table('users')
  .where('last_login_at', '<', new Date('2025-01-01'))
  .update({ status: 'inactive' })
```

::: warning
An `update()` or `delete()` without a `where` clause affects every row in the table.
:::

### Update JSON fields

Use `->` in the key to set one value inside a JSON column, leaving the rest of the document alone:

```ts
await DB.table('users')
  .where('id', 1)
  .update({ 'settings->profile->region': 'eu' })
```

### updateJson()

`updateJson(path, value)` sets one JSON path. It is a shortcut for `update({ [path]: value })`:

```ts
await DB.table('users').where('id', 1).updateJson('settings->theme', 'dark')
```

You can't set the whole column and a nested path of the same column in one `update()` call.

## Increment and decrement

### increment()

`increment(column, amount = 1, extra = {})` adds to a numeric column. The amount defaults to `1`.

```ts
await DB.table('posts').where('id', 42).increment('views')
```

Pass a third argument to update other columns at the same time:

```ts
await DB.table('posts')
  .where('id', 42)
  .increment('views', 1, { last_viewed_at: new Date() })
```

### decrement()

`decrement(column, amount = 1, extra = {})` subtracts from a numeric column. It takes the same arguments as `increment()`.

```ts
await DB.table('products').where('id', 7).decrement('stock', 3)
```

### incrementEach()

`incrementEach(columns, extra = {})` adds to several numeric columns in one `UPDATE`. Pass each column with its amount.

```ts
await DB.table('users')
  .where('id', 7)
  .incrementEach({ votes: 5, balance: 100 }, { last_voted_at: new Date() })
```

### decrementEach()

`decrementEach(columns, extra = {})` subtracts from several numeric columns at once.

```ts
await DB.table('products').where('id', 7).decrementEach({ stock: 2, reserved: 2 })
```

The columns must be numeric, or the call throws.

The database computes the new value (`stock = stock + ?`) in the `UPDATE` itself, so combining it with a `where` guards against races without locking:

```ts
const result = await DB.table('products')
  .where('id', productId)
  .where('stock', '>=', quantity)
  .decrement('stock', quantity)

if ((result.affectedRows ?? 0) === 0) {
  throw new Error('Out of stock')
}
```

## Delete rows

### delete()

`delete()` removes every row that matches the query.

```ts
await DB.table('sessions')
  .where('expires_at', '<', new Date())
  .delete()
```

### truncate()

`truncate()` removes every row in the table and resets its auto-increment counter. It ignores `where` clauses.

```ts
await DB.table('import_staging').truncate()
```

On PostgreSQL it runs `TRUNCATE ... RESTART IDENTITY` and on MySQL `TRUNCATE TABLE`. On SQLite it runs `DELETE FROM` and then resets the table's `AUTOINCREMENT` counter when SQLite keeps one. On every database, `truncate()` rejects a table that another table references with a foreign key, even when the referencing table is empty. Use `delete()` for those tables instead.

## Locking rows

Inside a [transaction](/database/transactions), lock the rows you read so that other transactions wait until yours finishes.

```ts
await DB.transaction(async (tx) => {
  const account = await tx.table('accounts')
    .where('id', accountId)
    .lockForUpdate()
    .first()

  if (!account || Number(account.balance) < amount) {
    throw new Error('Insufficient funds')
  }

  await tx.table('accounts').where('id', accountId).decrement('balance', amount)
})
```

| Method | PostgreSQL | MySQL |
| --- | --- | --- |
| `lockForUpdate()` | `FOR UPDATE` | `FOR UPDATE` |
| `sharedLock()` | `FOR SHARE` | `LOCK IN SHARE MODE` |
| `lock('update' \| 'share')` | either of the above | either of the above |

SQLite has no row locks: these methods are accepted but add nothing to the query. On SQLite, use `DB.writeTransaction()` for read-then-write work.

## Write methods reference

| Method | Description |
| --- | --- |
| `insert(values)` | insert one row or many |
| `insertGetId(values)` | insert one row and return its ID |
| `insertOrIgnore(values)` | insert, skipping rows that hit a unique constraint |
| `insertUsing(columns, query)` | insert the rows another query selects |
| `insertOrIgnoreUsing(columns, query)` | insert selected rows, skipping unique conflicts |
| `updateOrInsert(attributes, values = {})` | update matching rows, or insert one |
| `upsert(values, uniqueBy, updateColumns = [])` | insert or update on conflict |
| `update(values)` | update matching rows; supports `column->path` keys |
| `updateJson(path, value)` | set one path inside a JSON column |
| `increment(column, amount = 1, extra = {})` | add to a numeric column |
| `decrement(column, amount = 1, extra = {})` | subtract from a numeric column |
| `incrementEach(columns, extra = {})` | add to several numeric columns |
| `decrementEach(columns, extra = {})` | subtract from several numeric columns |
| `delete()` | delete matching rows |
| `truncate()` | delete every row and reset the auto-increment counter |
| `lockForUpdate()` / `sharedLock()` / `lock(mode)` | lock selected rows in a transaction |

## Next steps

- [Transactions](/database/transactions)
- [Creating and Updating Models](/orm/writes)
- [Chunking Large Results](/database/query-builder/chunking)
