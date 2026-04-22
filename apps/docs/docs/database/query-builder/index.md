# Query Builder

The query builder is Holo-JS's direct SQL-shaped database API. It is designed for precise table queries,
reporting flows, operational jobs, and endpoints that need rows rather than entities.

## Introduction

Use the query builder when:

- you need direct table access
- you want a projection instead of model entities
- the query spans tables that do not belong to one model
- you need joins, subqueries, aggregates, pagination, or locking without model behavior

If the query belongs to a domain record and should carry relations, casts, scopes, or serialization, use
the ORM instead.

## Running Database Queries

```ts
const users = await DB.table('users')
  .select('id', 'name', 'email')
  .where('active', true)
  .orderBy('name')
  .get()
```

Metadata-backed queries validate identifiers before execution, so invalid columns fail early instead of
turning into broken SQL at the driver boundary.

Use the query builder when the result should stay row-shaped. If the request needs model behavior after the
query, use the ORM instead.

### Chunking Results

```ts
await DB.table('users')
  .orderBy('id')
  .chunk(500, async (rows) => {
    // process batch
  })
```

Use `chunkById(...)` when stable primary-key paging is the safer fit for the workload.

This is mainly for background jobs, exports, and maintenance scripts, not normal user-facing pagination.

### Streaming Results Lazily

```ts
for await (const user of DB.table('users').orderBy('id').lazy()) {
  // handle one row at a time
}
```

`cursor()` and `lazy()` are the right tools when a result set is large enough that loading it eagerly
would be wasteful.

### Aggregates

```ts
const total = await DB.table('users').count()
const average = await DB.table('orders').avg('total')
const maxScore = await DB.table('posts').max('score')
```

Use aggregate helpers when the application needs metadata, not the row payload itself.

## Select Statements

The builder supports:

- `select(...)`
- `addSelect(...)`
- `selectSub(...)`
- `addSelectSub(...)`
- `distinct()`
- `pluck(...)`
- `value(...)`

## Raw Expressions

Unsafe SQL is supported, but it stays visibly separate from the safe query surface:

```ts
await DB.executeUnsafe(DB.raw('VACUUM'))
```

Use raw SQL deliberately and sparingly. Most application queries should remain on the safe fluent path.

If a query can be expressed with the normal builder, keep it there so validation, metadata checks, and
policy enforcement stay active.

## Joins

The builder supports:

- `join(...)`
- `leftJoin(...)`
- `rightJoin(...)`
- `crossJoin(...)`
- `joinSub(...)`
- `leftJoinSub(...)`
- `rightJoinSub(...)`
- `joinLateral(...)`
- `leftJoinLateral(...)`

See [Joins & Subqueries](/database/query-builder/joins-and-subqueries) for worked examples.

## Unions

The builder supports:

- `union(...)`
- `unionAll(...)`

## Basic Where Clauses

The fluent surface covers:

- `where(...)`
- `orWhere(...)`
- `whereNot(...)`
- `orWhereNot(...)`
- grouped `where(query => ...)`
- `whereNull(...)`
- `whereNotNull(...)`
- `whereIn(...)`
- `whereNotIn(...)`
- `whereBetween(...)`
- `whereNotBetween(...)`
- `whereColumn(...)`
- `whereLike(...)`
- `orWhereLike(...)`

### JSON Where Clauses

- `whereJson(...)`
- `orWhereJson(...)`
- `whereJsonContains(...)`
- `orWhereJsonContains(...)`
- `whereJsonLength(...)`
- `orWhereJsonLength(...)`

### Additional Where Clauses

- `whereDate(...)`
- `whereMonth(...)`
- `whereDay(...)`
- `whereYear(...)`
- `whereTime(...)`
- `whereAny(...)`
- `whereAll(...)`
- `whereNone(...)`
- `when(...)`
- `unless(...)`

Use these helpers to keep condition-heavy query code readable without falling back to raw fragments or
string-built SQL.

## Advanced Where Clauses

### Where Exists Clauses

- `whereExists(...)`
- `orWhereExists(...)`
- `whereNotExists(...)`
- `orWhereNotExists(...)`

### Subquery Where Clauses

- `whereSub(...)`
- `orWhereSub(...)`
- `whereInSub(...)`
- `whereNotInSub(...)`

### Full Text Where Clauses

- `whereFullText(...)`
- `orWhereFullText(...)`

## Ordering, Grouping, Limit, and Offset

The builder supports:

- `orderBy(...)`
- `latest(...)`
- `oldest(...)`
- `reorder(...)`
- `groupBy(...)`
- `having(...)`
- `havingBetween(...)`
- `limit(...)`
- `offset(...)`
- `inRandomOrder()`

Whenever pagination or chunking is involved, use deterministic ordering.

## Conditional Clauses

Use `when(...)` and `unless(...)` to apply query branches without breaking chain readability.

## Insert Statements

- `insert(...)`
- `insertGetId(...)`
- `insertOrIgnore(...)`

## Update Statements

- `update(...)`
- nested JSON update paths such as `'settings->profile->region'`
- `increment(...)`
- `decrement(...)`

## Upserts

- `upsert(...)`

## Delete Statements

- `delete(...)`

## Pessimistic Locking

Use pessimistic locking when the workflow must coordinate concurrent transactions around the same rows.
Typical examples are inventory reservation, balance transfers, queue claiming, and "read then write"
flows where another transaction must not change the selected rows in the middle of the operation.

Available methods:

- `lockForUpdate()`: exclusive row lock for rows you intend to update
- `sharedLock()`: shared read lock for rows that should stay stable while you inspect them
- `lock('update' | 'share')`: explicit form when you want to choose the mode dynamically

Dialect support:

- PostgreSQL: `lockForUpdate()` compiles to `FOR UPDATE`, `sharedLock()` compiles to `FOR SHARE`
- MySQL: `lockForUpdate()` compiles to `FOR UPDATE`, `sharedLock()` compiles to `LOCK IN SHARE MODE`
- SQLite: the methods are accepted, but the lock clause degrades to a plain `SELECT` because SQLite does not expose
  the same row-lock syntax as PostgreSQL or MySQL

That means SQLite will not apply a pessimistic row lock for these methods. The query still runs, but the lock
intent is ignored at the SQL level.

Use locks inside `DB.transaction(...)`. Outside a transaction they do not provide a durable concurrency boundary
for application workflows.

### `lockForUpdate()`

Use `lockForUpdate()` when the current transaction plans to modify the selected rows:

```ts
await DB.transaction(async (tx) => {
  const product = await tx.table('products')
    .where('id', productId)
    .lockForUpdate()
    .first<{ id: number, quantity: number }>()

  if (!product || product.quantity < requestedQty) {
    throw new Error('Out of stock')
  }

  await tx.table('products')
    .where('id', productId)
    .update({ quantity: product.quantity - requestedQty })
})
```

The important behavior is that another transaction trying to lock or update the same row will wait until the
current transaction commits or rolls back.

On SQLite, `lockForUpdate()` does not emit a row-lock clause and does not lock the selected rows. Keep the workflow inside a transaction, and prefer
an atomic conditional write when that expresses the business rule directly.

### `sharedLock()`

Use `sharedLock()` when multiple transactions may read the same rows concurrently, but writers should wait until
those readers finish:

```ts
await DB.transaction(async (tx) => {
  const account = await tx.table('accounts')
    .where('id', accountId)
    .sharedLock()
    .first<{ id: number, status: string }>()

  if (!account || account.status !== 'active') {
    throw new Error('Account is not active')
  }

  // perform follow-up reads that rely on the row staying stable for this transaction
})
```

Use this more sparingly than `lockForUpdate()`. If the workflow will definitely write the row, prefer
`lockForUpdate()`.

On SQLite, `sharedLock()` also degrades to a normal `SELECT` and does not block concurrent writers.

### Practical rules

- Keep the lock scope small: select the fewest rows you actually need.
- Keep the transaction short: do not perform network calls or slow external I/O while holding row locks.
- Prefer deterministic predicates such as primary keys when locking.
- Use a normal transaction with a conditional write when that solves the problem without a read-first lock step.
- Reach for cache locks only when you need cross-process coordination above the database layer; row locks are the
  stronger source of truth for database-backed state.

### When not to use pessimistic locking

Do not add row locks just because a workflow writes data. Many operations are better expressed as one atomic write:

```ts
const result = await DB.table('products')
  .where('id', productId)
  .where('quantity', '>=', requestedQty)
  .decrement('quantity', requestedQty)

if ((result.affectedRows ?? 0) === 0) {
  throw new Error('Out of stock')
}
```

That pattern is often simpler and scales better than a read-lock-write sequence. Use pessimistic locking when the
business rule genuinely requires a stable read set inside the transaction, not by default.

## Debugging

- `toSQL()`
- `debug()`
- `dump()`

`debug()` returns compiled statement metadata. Runtime logs still follow connection policy and may redact
SQL text.

## Continue

- [Selects & Filters](/database/query-builder/selects-and-filters)
- [Joins & Subqueries](/database/query-builder/joins-and-subqueries)
- [Writes, Pagination & Chunking](/database/query-builder/writes-pagination-and-chunking)
- [Pagination](/database/pagination)
