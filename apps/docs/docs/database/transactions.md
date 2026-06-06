# Transactions

Transactions use explicit runtime context and connection pinning so overlapping async work remains safe.

That design matters in JavaScript runtimes where async work can interleave more easily than many backend
developers expect. The framework pins transaction work to the active connection or session and keeps that
context attached to repositories and entities created inside the transaction.

## Basic transaction

```ts
await DB.transaction(async (tx) => {
  await tx.table('users').insert({ name: 'Ava' })
  await tx.table('profiles').insert({ user_id: 1 })
})
```

Transaction-scoped work is pinned to one leased connection or session for correctness.

Use a transaction when several writes must succeed or fail together.

## Returning values from a transaction

```ts
const user = await DB.transaction(async (tx) => {
  const [id] = await tx.table('users').insertGetId({
    name: 'Ava',
    email: 'ava@example.com',
  })

  return User.findOrFail(id)
})
```

Return values from the transaction callback when the calling workflow needs the created record or some
derived result. The transaction itself remains the boundary, not a side channel.

## Write transactions

Use `DB.writeTransaction(...)` for read-then-write workflows where the operation is expected to modify data:

```ts
await DB.writeTransaction(async (tx) => {
  const product = await tx.table('products')
    .where('id', productId)
    .first<{ id: number, quantity: number }>()

  if (!product || product.quantity < requestedQty) {
    throw new Error('Out of stock')
  }

  await tx.table('products')
    .where('id', productId)
    .update({ quantity: product.quantity - requestedQty })
})
```

On SQLite, `writeTransaction(...)` starts the transaction in write mode so competing write workflows coordinate
earlier. On other drivers, it behaves like a normal transaction.

The same connection argument shape is available when you need a named connection:

```ts
await DB.writeTransaction(async (tx) => {
  await tx.table('jobs').where('status', 'pending').update({ status: 'running' })
}, 'primary')
```

## SQLite transaction modes

SQLite transactions can receive an explicit mode:

```ts
await DB.transaction(async (tx) => {
  await tx.table('accounts')
    .where('id', accountId)
    .update({ balance: newBalance })
}, { mode: 'immediate' })
```

For a named connection, pass the mode after the connection name:

```ts
await DB.transaction(async (tx) => {
  await tx.table('accounts')
    .where('id', accountId)
    .update({ balance: newBalance })
}, 'sqlite', { mode: 'immediate' })
```

Available SQLite modes:

- `deferred`: the default SQLite transaction behavior
- `immediate`: reserve the writer when the transaction starts
- `exclusive`: use an exclusive transaction when the workflow intentionally needs that stronger boundary

Use `writeTransaction(...)` when you simply want the recommended write workflow. Use `transaction(..., { mode })`
when the SQLite mode itself is part of the application decision.

Pass `mode` only to the outermost SQLite transaction. Nested workflows should keep using the active transaction
boundary.

## Model usage inside a transaction

```ts
await DB.transaction(async () => {
  const user = await User.create({ name: 'Ava', email: 'ava@example.com' })
  await user.profile().createRelated({ locale: 'en' })
})
```

Model repositories and entities created inside the transaction bind to the active transaction context.

That means follow-up relation writes, scopes, and repository calls keep using the same pinned transaction
instead of silently escaping to a root connection.

This is one of the main reasons to use the model layer inside transactions: the runtime keeps the context
bound for you.

## Nested workflows

```ts
await DB.transaction(async () => {
  const user = await User.create({ name: 'Ava', email: 'ava@example.com' })

  await user.posts().createManyRelated([
    { title: 'First post' },
    { title: 'Second post' },
  ])
})
```

This is the normal application pattern. A transaction wraps one business operation, and the nested model
work stays inside it.

## Savepoints and nested work

Drivers expose savepoint hooks where supported. The runtime reuses the active transaction rather than
silently opening unrelated root transactions.

If a driver supports savepoints, nested workflows can participate without losing isolation. If it does
not, the runtime still keeps the work inside the active transaction boundary instead of pretending nested
transactions are independent.

## Scheduler behavior

Non-transactional work can be scheduled concurrently. Transaction-scoped work is serialized so pinned
transaction queries do not overlap unsafely.

## Abort and timeout control

Transactions accept the same operation options as other runtime calls:

- `signal` for cancellation
- `timeoutMs` for bounded execution windows

Use those when a request should not be allowed to wait indefinitely on the database.

## Cancellation and timeout

Database operations can receive `signal` and `timeoutMs` options. Aborts and timeouts are enforced by the
runtime layer around query, execute, and transaction lifecycle calls.

```ts
const controller = new AbortController()

await DB.transaction(
  async (tx) => {
    await tx.table('users').where('active', true).update({ active: false })
  },
  { signal: controller.signal, timeoutMs: 5000 }
)
```

## Practical rules

- keep a transaction scoped to one business workflow
- avoid long-running external I/O inside the transaction callback
- return a value from the callback instead of mutating outer state when possible
- use `writeTransaction(...)` for SQLite read-then-write workflows that should reserve the writer immediately
- use model and relation helpers freely inside the transaction; they stay bound to the active context
- do not wrap unrelated route work in one large transaction just because it is convenient
