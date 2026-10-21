# Transactions

A transaction groups several writes so they all succeed or all fail together. Wrap the work in `DB.transaction()`. If the callback throws, every change inside it is rolled back.

## Quick example

```ts [server/lib/orders.ts]
import { DB } from '@holo-js/db'
import Order from '../models/Order'
import Product from '../models/Product'

export async function placeOrder(userId: number, productId: number) {
  return DB.transaction(async () => {
    const product = await Product.findOrFail(productId)

    if (product.stock < 1) {
      throw new Error('Out of stock')
    }

    await Product.where('id', productId).decrement('stock')

    return Order.create({ user_id: userId, product_id: productId })
  })
}
```

The callback's return value becomes the return value of `DB.transaction()`. The transaction commits when the callback resolves and rolls back when it throws.

## Models join the transaction automatically

Models, relationships, and `DB.table()` calls inside the callback use the open transaction. You don't pass anything around.

```ts
import { DB } from '@holo-js/db'
import Post from '../models/Post'

const post = await DB.transaction(async () => {
  const post = await Post.create({ title: 'Hello', body: 'First post', user_id: authorId })
  await post.tags().attach([1, 2])
  return post
})
```

This works across `await` calls and helper functions, because Holo tracks the active transaction for the whole async call chain.

## Using the transaction object

The callback also receives the transaction connection. Use it for table queries when you want to be explicit:

```ts
import { DB } from '@holo-js/db'

await DB.transaction(async (tx) => {
  const id = await tx.table('users').insertGetId({ name: 'Ava', email: 'ava@example.com' })
  await tx.table('profiles').insert({ user_id: id, locale: 'en' })
})
```

`tx.table(...)` and `DB.table(...)` behave the same inside the callback.

## Nested transactions

Calling `DB.transaction()` inside another transaction creates a savepoint. If the inner callback throws, only its changes are undone. The outer transaction keeps going.

```ts
import { DB } from '@holo-js/db'

await DB.transaction(async (tx) => {
  await tx.table('tenants').insert({ name: 'Acme' })

  try {
    await DB.transaction(async (nested) => {
      await nested.table('tenant_settings').insert({ tenant_name: 'Acme', theme: 'dark' })
      throw new Error('Settings failed')
    })
  } catch {
    // tenant row is kept, settings row is undone
  }
})
```

If the outer transaction fails, everything is rolled back, including inner savepoints that succeeded. SQLite, PostgreSQL, and MySQL all support savepoints.

A `transaction()` call on a connection object works the same way. If a service received the connection as a dependency and calls `transaction()` on it while a transaction is open, the call becomes a savepoint, so it can't commit the outer work early.

Savepoints on one transaction run one at a time. If you start two with `Promise.all()`, the second waits until the first finishes.

## Run code after commit

Use `DB.afterCommit()` for side effects that should only happen once the data is saved, like sending email or dispatching a job.

```ts
import { DB } from '@holo-js/db'
import User from '../models/User'
import { sendWelcomeEmail } from './mail'

await DB.transaction(async () => {
  const user = await User.create({ name: 'Ava', email: 'ava@example.com' })

  DB.afterCommit(() => sendWelcomeEmail(user.email))
})
```

If the transaction rolls back, the callback never runs. Use `DB.afterRollback()` to clean up after a failure:

```ts
DB.afterRollback(() => deleteUploadedFile(uploadedPath))
```

How the callbacks run:

- `afterCommit` callbacks run in the order you registered them, after the outermost transaction commits.
- Callbacks registered inside a nested transaction wait for the outer commit. If the nested transaction fails, its `afterCommit` callbacks are dropped and its `afterRollback` callbacks run right away.
- `afterRollback` callbacks run in reverse order.
- `afterCommit` callbacks run outside the transaction, so queries inside them see the committed data.
- When a nested transaction rolls back, its `afterRollback` callbacks run inside the transaction that contains it, which is still open. Queries inside them join that transaction.
- On transaction objects, the same methods exist as `tx.afterCommit()` and `tx.afterRollback()`.

::: warning
Calling `DB.afterCommit()` or `DB.afterRollback()` outside a transaction throws a `TransactionError`.

If an `afterCommit` callback throws, the data stays committed, `DB.transaction()` rejects with that same error, and the remaining `afterCommit` callbacks are skipped. Handle errors inside the callback if the caller shouldn't see them.

A failed commit is different. If the database rejects the commit, the callbacks registered with `afterRollback()` don't run, because the outcome is unknown and the data may already be saved.

The same applies when the rollback itself fails. The `afterRollback()` callbacks don't run, and `DB.transaction()` rejects with the rollback error.
:::

## Write transactions on SQLite

SQLite allows one writer at a time. For read-then-write work, use `DB.writeTransaction()`. On SQLite it reserves the writer as soon as the transaction starts, so two requests can't read the same row and then both try to write.

```ts
import { DB } from '@holo-js/db'

await DB.writeTransaction(async (tx) => {
  const stock = await tx.table('products').where('id', productId).value('stock')

  if (typeof stock !== 'number' || stock < quantity) {
    throw new Error('Out of stock')
  }

  await tx.table('products').where('id', productId).update({ stock: stock - quantity })
})
```

On PostgreSQL and MySQL, `writeTransaction()` behaves like `transaction()`, so it is safe to use in code that runs on any driver.

### SQLite transaction modes

To choose the SQLite lock mode yourself, pass `mode`:

```ts
await DB.transaction(async (tx) => {
  await tx.table('accounts').where('id', accountId).update({ balance })
}, { mode: 'immediate' })
```

| Mode | Behavior |
| --- | --- |
| `deferred` | SQLite's default. The write lock is taken at the first write |
| `immediate` | Takes the write lock when the transaction starts. This is what `writeTransaction()` uses |
| `exclusive` | Takes an exclusive lock when the transaction starts |

`mode` only works on SQLite connections and only on the outermost transaction. Anywhere else it throws.

## Locking rows

On PostgreSQL and MySQL, lock the rows you read so another transaction can't change them until you commit:

```ts
import { DB } from '@holo-js/db'

await DB.transaction(async (tx) => {
  const account = await tx.table('accounts').where('id', accountId).lockForUpdate().first()

  await tx.table('accounts').where('id', accountId).update({
    balance: Number(account?.balance) - amount,
  })
})
```

Use `sharedLock()` to stop other transactions from writing the rows while still letting them read. Locks only apply inside a transaction. On SQLite they are ignored; use `writeTransaction()` instead.

## Transactions on a named connection

Pass the connection name after the callback, and options after that:

```ts
await DB.transaction(async (tx) => {
  await tx.table('page_views').insert({ path: '/pricing' })
}, 'analytics')

await DB.transaction(async (tx) => {
  await tx.table('jobs').where('status', 'pending').update({ status: 'running' })
}, 'main', { mode: 'immediate' })
```

`DB.afterCommit(callback, 'analytics')` registers a callback on that connection's transaction. See [multiple connections](/database/connections).

## Timeouts and cancellation

Pass `timeoutMs` or an `AbortSignal` to limit how long a transaction may take to start:

```ts
const controller = new AbortController()

await DB.transaction(async (tx) => {
  await tx.table('users').where('active', false).delete()
}, { timeoutMs: 5000, signal: controller.signal })
```

`timeoutMs` must be a positive integer. A timeout or abort before the transaction starts throws a `TransactionError`.

These options don't cut off the callback. To limit a single raw query inside it, pass `timeoutMs` to `unsafeQuery()` as shown in [Timeouts and cancellation](/database/#timeouts-and-cancellation).

::: warning
Commit and rollback are never interrupted by `timeoutMs` or `signal`. Once the callback finishes, Holo waits for the database to answer. Interrupting a commit leaves its outcome unknown, so a timeout there could report a rollback for data the database already saved.
:::

## Retry deadlocks

Pass `attempts` to run the transaction again when the database reports a deadlock, a lock wait timeout, or, on SQLite, a busy database. Holo rolls back the failed attempt before it starts the next one. The default is one attempt.

```ts
await DB.transaction(async (tx) => {
  await tx.table('accounts').where('id', fromId).decrement('balance', amount)
  await tx.table('accounts').where('id', toId).increment('balance', amount)
}, { attempts: 3 })
```

The callback runs again from the start, so keep side effects out of it and use `afterCommit()` for them. Only the outermost transaction retries. When a deadlock happens inside a savepoint, the outer transaction is the one that retries. Other errors are never retried.

## Concurrent transactions

On PostgreSQL and MySQL, independent transactions run in parallel, each on its own pooled connection. On SQLite, transactions on the same connection run one at a time. Either way, queries inside one transaction never mix with another.

::: tip
Keep transactions short. Don't call external APIs or wait on user input inside the callback. Move that work into `DB.afterCommit()`.
:::

## Method reference

### transaction()

Runs `callback` in a transaction. Nested calls create savepoints. The callback receives the transaction connection.

```ts
await DB.transaction(async (tx) => {
  await tx.table('users').insert({ name: 'Ava' })
}, 'main', { timeoutMs: 5000 })
```

### writeTransaction()

Same arguments as `transaction()`. On SQLite it defaults `mode` to `'immediate'` for the outermost transaction. On other drivers it behaves like `transaction()`. An explicit `mode` option overrides the default.

```ts
await DB.writeTransaction(async (tx) => {
  await tx.table('products').where('id', productId).decrement('stock')
}, { mode: 'exclusive' })
```

### afterCommit()

Registers a callback that runs after the outermost transaction commits, in the order you registered them. Callbacks run outside the transaction. Call it on `DB` or on a transaction connection such as `tx`.

```ts
DB.afterCommit(() => sendWelcomeEmail(user.email))
```

### afterRollback()

Registers a callback that runs when the transaction rolls back. When several are registered, they run in reverse order.

```ts
DB.afterRollback(() => deleteUploadedFile(uploadedPath))
```

## Transaction options

Every transaction method accepts an options object as its last argument.

| Option | Type | What it does |
| --- | --- | --- |
| `mode` | `'deferred' \| 'immediate' \| 'exclusive'` | SQLite lock mode. Other drivers throw a `CapabilityError` |
| `attempts` | positive integer | Runs the transaction again after a deadlock, lock wait timeout, or busy SQLite database. Default `1` |
| `timeoutMs` | positive integer | Throws a `TransactionError` when starting the transaction takes longer |
| `signal` | `AbortSignal` | Throws a `TransactionError` when aborted before the transaction starts |

Pass the connection name before the options when you use a named connection, as shown in [Transactions on a named connection](#transactions-on-a-named-connection).

## Next steps

- [Inserts, updates, and deletes](/database/query-builder/writes)
- [Creating and updating models](/orm/writes)
- [Multiple connections](/database/connections)
- [After-commit events](/events/after-commit)
