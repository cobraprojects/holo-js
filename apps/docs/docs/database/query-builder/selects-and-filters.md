# Query Builder: Selects & Filters

This page covers the fluent read path: selecting columns, filtering rows, grouping conditions, ordering,
and safe debugging.

Most application queries live here. If a team understands this page well, they can write the majority of
their read-side database code without reaching for raw SQL.

## Selecting columns

```ts
const rows = await DB.table('users')
  .select('id', 'name', 'email')
  .get()
```

When the query is metadata-backed, the builder validates selected columns against the known schema.

If you want every column, you can omit `select(...)` and call `get()` directly. Use explicit projection
once the result is feeding an API or a view model.

## Adding to an existing select

```ts
const rows = await DB.table('users')
  .select('id', 'name')
  .addSelect('email')
  .get()
```

This is useful when a base query is shared and a later branch needs more columns.

## Distinct results

```ts
const locales = await DB.table('users')
  .distinct()
  .pluck('locale')
```

Use `distinct()` when duplicates are part of the join or projection shape and the application only needs
the unique values.

## Basic `where` clauses

```ts
const rows = await DB.table('users')
  .where('active', true)
  .where('email', 'like', '%@example.com')
  .get()
```

The builder supports a broad operator surface while keeping operator validation strict.
Malformed operators are rejected rather than interpolated.

That fail-closed behavior is one of the main reasons to prefer the fluent API over ad hoc SQL strings.

## Grouped conditions

```ts
const rows = await DB.table('users')
  .where(query => {
    query.where('active', true).orWhere('email_verified', true)
  })
  .where('banned', false)
  .get()
```

Use grouped closures when operator precedence matters. This keeps `orWhere(...)` branches readable instead
of forcing one long chain with unclear grouping.

## Column and set comparisons

```ts
const rows = await DB.table('posts')
  .whereColumn('published_at', '>=', 'created_at')
  .whereIn('status', ['draft', 'published'])
  .whereBetween('score', [70, 100])
  .get()
```

These helpers cover the common cases that would otherwise push teams toward raw fragments too early.

## JSON predicates

```ts
const docs = await DB.table('documents')
  .whereJson('metadata->locale', 'en')
  .whereJsonContains('metadata->tags', 'featured')
  .whereJsonLength('metadata->tags', '>', 2)
  .get()
```

JSON path handling is compiler-aware and dialect-aware. You write one logical path and the active dialect
decides how to lower it.

Use JSON predicates when the stored document shape belongs in one column but the application still needs
structured filtering on parts of that document.

## Date helpers

```ts
const rows = await DB.table('orders')
  .whereDate('created_at', '2026-03-27')
  .whereYear('created_at', 2026)
  .whereMonth('created_at', 3)
  .get()
```

## Exists and subquery filters

```ts
const rows = await DB.table('users')
  .whereExists(
    DB.table('posts')
      .select('id')
      .whereColumn('posts.user_id', '=', 'users.id')
  )
  .get()
```

Use `whereExists(...)` when the question is relational existence rather than a full join result.

That keeps the query closer to the business question: does a related row exist, not what every related row
contains.

## Vector Search

Use vector similarity search when a table stores embeddings and the application needs nearest-neighbor or
semantic retrieval:

```ts
const docs = await DB.table('documents')
  .whereVectorSimilarTo('embedding', embedding, 0.4)
  .limit(10)
  .get()
```

Requirements:

- `embedding` must be declared as a vector column
- the probe vector must match the declared dimensions
- the active dialect must be Postgres

Failure behavior is intentionally strict:

- non-vector columns are rejected
- malformed vectors are rejected
- unsupported dialects throw at compile time instead of silently degrading

Use this when relevance depends on geometric similarity rather than exact equality, ranges, or full-text
matching.

## Ordering

```ts
const rows = await DB.table('users')
  .latest('created_at')
  .orderBy('name')
  .get()
```

Useful helpers include:

- `latest(...)`
- `oldest(...)`
- `inRandomOrder()`
- `reorder(...)`

Use a stable `orderBy(...)` whenever pagination or chunking is involved. Cursor pagination in particular
depends on deterministic ordering.

## Scalar retrieval

```ts
const email = await DB.table('users').where('id', 1).value('email')
const total = await DB.table('users').where('active', true).count()
const exists = await DB.table('users').where('email', 'ops@example.com').exists()
```

These helpers keep common single-value or count queries compact and readable.

Use them when the application expects one value and does not need the rest of the row.

## Safe debugging

```ts
const debug = DB.table('users')
  .where('email', 'ops@example.com')
  .debug()
```

`debug()` returns compiled statement metadata. Normal query logging still follows runtime policy and may
redact SQL text.

`dump()` is also available when you want to log the builder and continue the chain.
