# Pagination

Pagination splits a query's results into pages. Holo has three paginators — pick one based on what your UI needs to show. They work the same on the [query builder](/database/query-builder/) and on [models](/orm/querying).

```ts [server/lib/posts.ts]
import Post from '../models/Post'

const page = await Post
  .where('status', 'published')
  .latest('published_at')
  .paginate(15, 2)

page.data         // the 15 posts on page 2
page.meta.total   // total number of published posts
page.meta.lastPage
```

## Choosing a paginator

| Method | Gives you | Cost | Best for |
| --- | --- | --- | --- |
| `paginate(perPage, page)` | total count, last page, page numbers | one extra `COUNT` query | numbered page links |
| `simplePaginate(perPage, page)` | "is there a next page?" | no count query | Previous / Next buttons |
| `cursorPaginate(perPage, cursor)` | opaque next / previous tokens | no count, no `OFFSET` | infinite scroll, feeds, large tables |

All three default to 15 rows per page. Any `limit()` or `offset()` already on the query is replaced by the paginator's own.

## Paginate in a route

Read the page number from the query string and return the paginator as JSON. It serializes to `{ data, meta }`.

::: code-group

```ts [Next.js]
// app/api/posts/route.ts
import Post from '@/server/models/Post'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1

  const posts = await Post
    .where('status', 'published')
    .latest('published_at')
    .paginate(15, Math.max(1, page))

  return Response.json(posts)
}
```

```ts [Nuxt]
// server/api/posts.get.ts
import Post from '../models/Post'

export default defineEventHandler(async (event) => {
  const page = Number.parseInt(String(getQuery(event).page ?? '1'), 10) || 1

  return await Post
    .where('status', 'published')
    .latest('published_at')
    .paginate(15, Math.max(1, page))
})
```

```ts [SvelteKit]
// src/routes/api/posts/+server.ts

import type { RequestHandler } from './$types'
import Post from '../../../../server/models/Post'

export const GET: RequestHandler = async ({ url }) => {
  const page = Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1

  const posts = await Post
    .where('status', 'published')
    .latest('published_at')
    .paginate(15, Math.max(1, page))

  return Response.json(posts)
}
```

:::

::: warning
`perPage` and `page` must be positive integers. Passing `0`, a negative number, or `NaN` throws an error, so always parse and clamp values that come from the request.
:::

## Length-aware pagination

`paginate()` runs a `COUNT` query so it can tell you the total number of rows and pages.

```ts
import { DB } from '@holo-js/db'

const page = await DB.table('orders')
  .where('status', 'paid')
  .orderBy('id')
  .paginate(25, 3)
```

The JSON looks like this:

```json
{
  "data": [{ "id": 51, "total": 120 }, "..."],
  "meta": {
    "total": 240,
    "perPage": 25,
    "pageName": "page",
    "currentPage": 3,
    "lastPage": 10,
    "from": 51,
    "to": 75,
    "hasMorePages": true
  }
}
```

`from` and `to` are the positions of the first and last rows on the page, or `null` when the page is empty.

## Simple pagination

`simplePaginate()` skips the count query. It fetches one extra row to find out whether there is a next page.

```ts
const page = await DB.table('audit_logs')
  .latest()
  .simplePaginate(50, 1)
```

```json
{
  "data": ["..."],
  "meta": {
    "perPage": 50,
    "pageName": "page",
    "currentPage": 1,
    "from": 1,
    "to": 50,
    "hasMorePages": true
  }
}
```

## Cursor pagination

`cursorPaginate()` uses the values of the last row you saw to fetch the next page (`WHERE id > ?`) instead of `OFFSET`. It stays fast on large tables and doesn't skip or repeat rows when new rows are inserted.

Pass `null` (or nothing) for the first page, then pass back the cursor you received:

```ts
const first = await DB.table('posts').orderBy('id').cursorPaginate(20)

const second = await DB.table('posts').orderBy('id').cursorPaginate(20, first.nextCursor)
```

The result has no `meta` key:

```json
{
  "data": ["..."],
  "perPage": 20,
  "cursorName": "cursor",
  "nextCursor": "eyJ2YWx1ZXMiOlsyMF19",
  "prevCursor": null
}
```

`nextCursor` is `null` on the last page, and `prevCursor` is `null` on the first. Pass `prevCursor` to go back a page.

In a route, read the cursor from the query string:

```ts
const cursor = url.searchParams.get('cursor')

const feed = await Post.where('status', 'published').latest().cursorPaginate(20, cursor)
```

### Ordering rules

Cursor pagination needs a stable sort order:

- Order by real columns. `inRandomOrder()` and `unsafeOrderBy()` aren't allowed.
- If you don't call `orderBy()`, Holo orders by the primary key.
- Holo adds the primary key as a tie-breaker, so sorting by a non-unique column such as `created_at` is safe.
- Use the same ordering for every page. A cursor created by a different ordering is rejected.

A malformed or tampered cursor also throws, so you don't need to validate it yourself.

## Paginating models

On a model query, `data` is a [collection](/orm/collections) of model instances, so you can keep working with them before you return the page:

```ts
const page = await Post.with('user').latest().paginate(10, 1)

for (const post of page.data) {
  console.log(post.get('title'))
}
```

When the page goes straight to the client, use the `...Json` variants. They return plain serialized objects — with [hidden attributes](/orm/serialization) removed and loaded relations included:

```ts
const page = await Post.with('user').latest().paginateJson(10, 1)
// { data: [{ id: 1, title: '...', user: { ... } }], meta: { ... } }
```

| Method | Returns |
| --- | --- |
| `paginateJson(perPage, page, options?)` | `{ data, meta }` |
| `simplePaginateJson(perPage, page, options?)` | `{ data, meta }` |
| `cursorPaginateJson(perPage, cursor, options?)` | `{ data, perPage, cursorName, nextCursor, prevCursor }` |

## Several paginators on one page

The `pageName` and `cursorName` options label which query-string parameter a paginator belongs to. The name is included in the result so your UI can build the right links.

```ts
const posts = await Post.latest().paginate(10, postsPage, { pageName: 'postsPage' })

const comments = await DB.table('comments')
  .orderBy('id')
  .cursorPaginate(20, commentsCursor, { cursorName: 'commentsCursor' })
```

Holo doesn't read the request for you — you still pass the page number or cursor yourself.

## Paginator reference

Each paginator returns its rows in `data`, its position in `meta` (length-aware and simple paginators), or cursor fields at the top level (cursor paginator). The methods below are available on the result.

### paginate()

Returns a page with a total count. Arguments: `perPage` (default `15`), `page` (default `1`), and `options` with `pageName` (default `'page'`).

```ts
const page = await DB.table('posts').orderBy('id').paginate(15, 2, { pageName: 'p' })
```

### simplePaginate()

Returns a page without a count query. Takes the same arguments as `paginate()`.

```ts
const page = await DB.table('posts').orderBy('id').simplePaginate(15, 2)
```

### cursorPaginate()

Returns a page from a cursor. Arguments: `perPage` (default `15`), `cursor` (default `null`), and `options` with `cursorName` (default `'cursor'`).

```ts
const page = await DB.table('posts').orderBy('id').cursorPaginate(15, null, { cursorName: 'after' })
```

### Meta fields

`paginate()` returns these `meta` fields:

| Field | Meaning |
| --- | --- |
| `total` | Number of rows that match the query |
| `perPage` | Rows per page |
| `pageName` | Query-string name of the page parameter |
| `currentPage` | The page you requested |
| `lastPage` | Last page number (at least `1`) |
| `from` / `to` | Positions of the first and last rows on the page, or `null` |
| `hasMorePages` | `true` when a later page exists |

`simplePaginate()` returns the same fields except `total` and `lastPage`.

### items()

Returns the rows on this page. It returns the same array as `data`.

```ts
const posts = page.items()
```

### firstItem()

Returns the position of the first row on the page, or `null` when the page is empty. It returns the same value as `meta.from`.

```ts
console.log(`Showing from ${page.firstItem()}`)
```

### lastItem()

Returns the position of the last row on the page, or `null` when the page is empty. It returns the same value as `meta.to`.

```ts
console.log(`Showing to ${page.lastItem()}`)
```

### hasPages()

Returns `true` when more than one page exists. On a simple paginator, it returns `true` when the current page is past the first or a next page exists.

```ts
const showPageLinks = page.hasPages()
```

### hasMorePages()

Returns `true` when a next page exists. On a cursor paginator, it checks whether `nextCursor` is set.

```ts
const hasNext = feed.hasMorePages()
```

### getPageName()

Returns the query-string name of the page parameter. Available on `paginate()` and `simplePaginate()` results.

```ts
const param = page.getPageName() // 'page'
```

### getCursorName()

Returns the query-string name of the cursor parameter. Available on `cursorPaginate()` results.

```ts
const param = feed.getCursorName() // 'cursor'
```

### nextCursorToken()

Returns the cursor for the next page, or `null` on the last page. Available on `cursorPaginate()` results.

```ts
const next = feed.nextCursorToken()
```

### previousCursorToken()

Returns the cursor for the previous page, or `null` on the first page. Available on `cursorPaginate()` results.

```ts
const previous = feed.previousCursorToken()
```

### toJSON()

Returns the serialized page: `{ data, meta }` for length-aware and simple paginators, or `{ data, perPage, cursorName, nextCursor, prevCursor }` for cursor paginators. Returning the paginator from a route uses this method.

```ts
return Response.json(page.toJSON())
```

## Next steps

- [Chunking Large Results](/database/query-builder/chunking) — for background jobs instead of UI pages
- [Querying Models](/orm/querying)
- [Serialization](/orm/serialization)
- [Routing and Requests](/basics/routing)
