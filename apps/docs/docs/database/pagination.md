# Pagination

Holo-JS supports three paginator families: length-aware pagination, simple pagination, and cursor
pagination. Choose the paginator based on what the user interface needs to know about the result set.

## Length-aware pagination

```ts
const page = await DB.table('users')
  .orderBy('id')
  .paginate(25)
```

Use length-aware pagination when the UI needs:

- total result count
- total page count
- current page number
- next and previous page metadata

This is the most complete paginator, but it also requires the extra counting work.

## Simple pagination

```ts
const page = await DB.table('users')
  .orderBy('id')
  .simplePaginate(25)
```

Use simple pagination when the UI only needs forward/backward navigation and does not need a total count.

This is a good fit for admin tables or internal tools where exact totals are not important.

## Cursor pagination

```ts
const page = await DB.table('users')
  .orderBy('id')
  .cursorPaginate(25, { cursorName: 'usersCursor' })
```

Cursor pagination is usually the right choice for large datasets, infinite lists, and feeds. It avoids the
cost and instability of large offset jumps.

## Stable ordering rules

Cursor pagination requires stable ordering. Use deterministic columns such as:

- primary keys
- created-at plus primary key
- any ordering that is unique and repeatable

Avoid non-deterministic ordering for cursor-based flows.

## Custom parameter names

Paginator names can be changed when one screen contains multiple paginated resources.

```ts
const users = await User.paginate(15, { pageName: 'usersPage' })

const events = await DB.table('events')
  .orderBy('id')
  .cursorPaginate(20, { cursorName: 'eventsCursor' })
```

## Model pagination

```ts
const page = await User
  .where('active', true)
  .latest('created_at')
  .paginate(15, { pageName: 'usersPage' })
```

Model pagination keeps the result model-aware, so the page items still participate in relation loading,
casts, serialization, and collection helpers.

## Manual paginator helpers

Holo-JS also exposes manual paginator constructors when data comes from a custom query path or a service
that already has sliced results:

- `createPaginator(...)`
- `createSimplePaginator(...)`
- `createCursorPaginator(...)`

Use these when the application already owns the paging logic but still wants a consistent paginator shape at
the response boundary.

## Pagination and chunking are different

Pagination exists for user-facing navigation. Chunking exists for background processing and batch work.

If your goal is:

- render pages in a UI -> paginate
- process many rows safely -> chunk or `chunkById`
- stream results without loading everything -> `lazy()` or `cursor()`

## Practical rule

Use `paginate(...)` by default. Switch to `simplePaginate(...)` when total counts are unnecessary. Use
`cursorPaginate(...)` when the dataset is large or the UI behaves like a feed.

## Related tools

- [Query Builder: Writes, Pagination & Chunking](/database/query-builder/writes-pagination-and-chunking)
- [ORM Getting Started](/orm/)
