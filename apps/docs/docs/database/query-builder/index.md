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

- `lockForUpdate()`
- `sharedLock()`
- `lock('update' | 'share')`

These compile only on supporting dialects and fail closed elsewhere.

Use locking only inside transaction-scoped workflows where row contention is an actual concern.

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
