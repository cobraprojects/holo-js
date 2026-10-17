# Selects and Filters

This page covers choosing columns, filtering rows with `where` clauses, sorting, grouping, locking, and limiting results. Most of these methods also work on [model queries](/orm/querying).

```ts [server/lib/posts.ts]
import { DB } from '@holo-js/db'

const posts = await DB.table('posts')
  .select('id', 'title', 'published_at')
  .where('status', 'published')
  .whereNotNull('published_at')
  .whereIn('category_id', [1, 4, 7])
  .orderBy('published_at', 'desc')
  .limit(20)
  .get()
```

## Selecting columns

By default a query selects every column. Use `select()` to pick columns, and `as` to rename them.

### select()

Replace the selected columns with the ones you pass. Use `as` in a column name to rename it in the result.

```ts
const users = await DB.table('users')
  .select('id', 'name', 'email as contact')
  .get()
// [{ id: 1, name: 'Ava', contact: 'ava@example.com' }, ...]
```

When the query uses a [table definition](/database/query-builder/#typed-results), `select()` autocompletes column names and the result type follows your selection, including aliases.

### addSelect()

Add columns to the selection you already have, without replacing it.

```ts
const base = DB.table('users').select('id', 'name')
const withEmail = await base.addSelect('email').get()
```

### distinct()

Remove duplicate rows from the result.

```ts
const statuses = await DB.table('orders').distinct().select('status').pluck('status')
```

### Selecting aggregates

Select an aggregate as a named column. Each method has an `add...` variant that keeps the columns you already selected.

```ts
const totals = await DB.table('orders')
  .select('customer_id')
  .addSelectCount('order_count')
  .addSelectSum('total_spent', 'total')
  .groupBy('customer_id')
  .get()
// [{ customer_id: 1, order_count: 3, total_spent: 240 }, ...]
```

| Select | Add to selection | Arguments |
| --- | --- | --- |
| `selectCount(alias = 'count', column = '*')` | `addSelectCount(...)` | alias, optional column |
| `selectSum(alias, column)` | `addSelectSum(...)` | alias, column |
| `selectAvg(alias, column)` | `addSelectAvg(...)` | alias, column |
| `selectMin(alias, column)` | `addSelectMin(...)` | alias, column |
| `selectMax(alias, column)` | `addSelectMax(...)` | alias, column |

### selectCount()

Select `COUNT` of rows as a named column. The alias defaults to `count`, and the column defaults to `*`.

```ts
const total = await DB.table('posts')
  .selectCount('post_count')
  .get()
// [{ post_count: 42 }]
```

### addSelectCount()

Add a `COUNT` column to the existing selection.

```ts
const rows = await DB.table('posts')
  .select('user_id')
  .addSelectCount('post_count')
  .groupBy('user_id')
  .get()
```

### selectSum()

Replace the selection with the `SUM` of a column, under the alias you give.

```ts
const revenue = await DB.table('orders')
  .selectSum('revenue', 'total')
  .get()
```

### addSelectSum()

Add the `SUM` of a column to the existing selection.

```ts
const rows = await DB.table('orders')
  .select('customer_id')
  .addSelectSum('total_spent', 'total')
  .groupBy('customer_id')
  .get()
```

### selectAvg()

Replace the selection with the `AVG` of a column, under the alias you give.

```ts
const average = await DB.table('reviews')
  .selectAvg('average_rating', 'rating')
  .get()
```

### addSelectAvg()

Add the `AVG` of a column to the existing selection.

```ts
const rows = await DB.table('products')
  .select('category_id')
  .addSelectAvg('avg_price', 'price')
  .groupBy('category_id')
  .get()
```

### selectMin()

Replace the selection with the `MIN` of a column, under the alias you give.

```ts
const cheapest = await DB.table('products')
  .selectMin('lowest_price', 'price')
  .get()
```

### addSelectMin()

Add the `MIN` of a column to the existing selection.

```ts
const rows = await DB.table('products')
  .select('category_id')
  .addSelectMin('lowest_price', 'price')
  .groupBy('category_id')
  .get()
```

### selectMax()

Replace the selection with the `MAX` of a column, under the alias you give.

```ts
const priciest = await DB.table('products')
  .selectMax('highest_price', 'price')
  .get()
```

### addSelectMax()

Add the `MAX` of a column to the existing selection.

```ts
const rows = await DB.table('products')
  .select('category_id')
  .addSelectMax('highest_price', 'price')
  .groupBy('category_id')
  .get()
```

For subquery columns and raw expressions, see [Joins and Subqueries](/database/query-builder/joins-and-subqueries).

## Basic where clauses

Pass a column, an operator, and a value. If you leave out the operator, Holo uses `=`.

### where()

Add a condition joined with `AND`. It has three forms: a column with an operator and a value, a column with a value only (which uses `=`), or a callback that wraps conditions in parentheses.

```ts
const admins = await DB.table('users').where('role', 'admin').get()
const adults = await DB.table('users').where('age', '>=', 18).get()
const gmail = await DB.table('users').where('email', 'like', '%@gmail.com').get()
```

A column that contains `->` is treated as a [JSON path](#json-columns), so `where('settings->profile->region', 'eu')` works the same as `whereJson()`.

Supported operators: `=`, `!=`, `>`, `>=`, `<`, `<=`, `like`, `in`, `not in`, `between`, `not between`.

### orWhere()

Add a condition joined with `OR`. It accepts the same forms as `where()`.

```ts
const staff = await DB.table('users')
  .where('role', 'admin')
  .orWhere('role', 'editor')
  .get()
```

::: warning
`where('deleted_at', null)` compiles to `= NULL`, which never matches in SQL. Use `whereNull()` and `whereNotNull()` to check for `NULL`.
:::

### Grouping conditions

Pass a callback to wrap conditions in parentheses:

```ts
// WHERE status = 'published' AND (featured = true OR views > 1000)
const highlights = await DB.table('posts')
  .where('status', 'published')
  .where(query => query
    .where('featured', true)
    .orWhere('views', '>', 1000))
  .get()
```

### whereNot()

Add a `NOT (...)` group built from a callback. Conditions inside the callback are combined with `AND` unless you use `orWhere()`.

```ts
// WHERE NOT (status = 'archived' OR status = 'spam')
const visible = await DB.table('posts')
  .whereNot(query => query
    .where('status', 'archived')
    .orWhere('status', 'spam'))
  .get()
```

### orWhereNot()

Add a `NOT (...)` group joined with `OR`.

```ts
const results = await DB.table('posts')
  .where('featured', true)
  .orWhereNot(query => query.where('status', 'draft'))
  .get()
```

## Null checks

### whereNull()

Keep rows where the column is `NULL`.

```ts
const unverified = await DB.table('users').whereNull('email_verified_at').get()
```

### orWhereNull()

Add an `OR` condition that the column is `NULL`.

```ts
const pending = await DB.table('orders')
  .whereNull('shipped_at')
  .orWhereNull('cancelled_at')
  .get()
```

### whereNotNull()

Keep rows where the column is not `NULL`.

```ts
const verified = await DB.table('users').whereNotNull('email_verified_at').get()
```

### orWhereNotNull()

Add an `OR` condition that the column is not `NULL`.

```ts
const touched = await DB.table('posts')
  .whereNull('published_at')
  .orWhereNotNull('updated_at')
  .get()
```

### withoutWhereNull()

Remove a `whereNull()` check for the column that is already on the query. Use it to undo a null check added earlier, for example by a [scope](/orm/scopes).

```ts
const activeOnly = DB.table('users').whereNull('deleted_at')
const everyUser = await activeOnly.withoutWhereNull('deleted_at').get()
```

### withoutWhereNotNull()

Remove a `whereNotNull()` check for the column that is already on the query.

```ts
const anyPost = await DB.table('posts')
  .whereNotNull('published_at')
  .withoutWhereNotNull('published_at')
  .get()
```

## Lists and ranges

### whereIn()

Keep rows where the column matches any value in the list.

```ts
const picked = await DB.table('posts').whereIn('id', [1, 2, 3]).get()
```

### whereNotIn()

Keep rows where the column matches none of the values in the list.

```ts
const others = await DB.table('posts').whereNotIn('status', ['draft', 'archived']).get()
```

### whereBetween()

Keep rows where the column falls between two values, inclusive.

```ts
const midRange = await DB.table('products').whereBetween('price', [10, 50]).get()
```

### whereNotBetween()

Keep rows where the column falls outside the two values.

```ts
const outliers = await DB.table('products').whereNotBetween('price', [10, 50]).get()
```

## Pattern matching

### whereLike()

Keep rows where the column matches a `LIKE` pattern. It is a shortcut for `where(column, 'like', pattern)`.

```ts
const results = await DB.table('posts')
  .whereLike('title', '%holo%')
  .get()
```

### orWhereLike()

Add an `OR` condition that the column matches a `LIKE` pattern.

```ts
const results = await DB.table('posts')
  .whereLike('title', '%holo%')
  .orWhereLike('excerpt', '%holo%')
  .get()
```

## Comparing two columns

### whereColumn()

Compare one column to another column instead of to a value. The operator cannot be `in`, `not in`, `between`, or `not between`.

```ts
const overBudget = await DB.table('projects')
  .whereColumn('spent', '>', 'budget')
  .get()
```

## Matching several columns at once

Apply the same condition to a list of columns:

```ts
// WHERE (title LIKE ? OR excerpt LIKE ? OR body LIKE ?)
const matches = await DB.table('posts')
  .whereAny(['title', 'excerpt', 'body'], 'like', '%holo%')
  .get()
```

### whereAny()

Keep rows where the condition is true for at least one of the columns.

```ts
const matches = await DB.table('posts')
  .whereAny(['title', 'excerpt'], 'like', '%holo%')
  .get()
```

### whereAll()

Keep rows where the condition is true for every column.

```ts
const matching = await DB.table('products')
  .whereAll(['name', 'sku'], 'like', 'A%')
  .get()
```

### whereNone()

Keep rows where the condition is true for none of the columns.

```ts
const clean = await DB.table('posts')
  .whereNone(['title', 'body'], 'like', '%spam%')
  .get()
```

## Dates and times

Compare only part of a date or timestamp column:

```ts
const today = await DB.table('orders').whereDate('created_at', '2026-10-17').get()
const thisYear = await DB.table('orders').whereYear('created_at', 2026).get()
const december = await DB.table('orders').whereMonth('created_at', 12).get()
const firstOfMonth = await DB.table('orders').whereDay('created_at', 1).get()
const afterHours = await DB.table('orders').whereTime('created_at', '>', '18:00:00').get()
```

Each method accepts an optional operator, like `where()`.

### whereDate()

Compare the date part of a column. Pass a value alone to use `=`, or an operator and a value.

```ts
const orders = await DB.table('orders').whereDate('created_at', '>=', '2026-10-01').get()
```

### whereMonth()

Compare the month number (1 to 12) of a column.

```ts
const decemberOrders = await DB.table('orders').whereMonth('created_at', 12).get()
```

### whereDay()

Compare the day of the month (1 to 31) of a column.

```ts
const firstDayOrders = await DB.table('orders').whereDay('created_at', 1).get()
```

### whereYear()

Compare the year of a column.

```ts
const yearOrders = await DB.table('orders').whereYear('created_at', 2026).get()
```

### whereTime()

Compare the time part of a column.

```ts
const eveningOrders = await DB.table('orders').whereTime('created_at', '>', '18:00:00').get()
```

## JSON columns

Reach into a JSON column with `->` between keys. This works in `where()` and the dedicated JSON methods.

```ts
const euUsers = await DB.table('users')
  .where('settings->profile->region', 'eu')
  .get()
```

| Method | Use it to… |
| --- | --- |
| `whereJson(path, operator?, value)` / `orWhereJson(...)` | compare a scalar value (string, number, boolean, `null`) at a path |
| `whereJsonContains(path, value)` / `orWhereJsonContains(...)` | check that a JSON array or object contains a value |
| `whereJsonLength(path, operator?, value)` / `orWhereJsonLength(...)` | compare the length of a JSON array |

### whereJson()

Compare a scalar value stored at a JSON path. It throws if you pass an array or object as the value; use `whereJsonContains()` for those.

```ts
const dark = await DB.table('users')
  .whereJson('settings->theme', 'dark')
  .get()
```

### orWhereJson()

Add an `OR` JSON path comparison.

```ts
const flagged = await DB.table('users')
  .whereJson('settings->theme', 'dark')
  .orWhereJson('settings->beta', true)
  .get()
```

### whereJsonContains()

Keep rows where the JSON array or object at the path contains the value.

```ts
const betaTesters = await DB.table('users')
  .whereJsonContains('settings->tags', 'beta')
  .get()
```

### orWhereJsonContains()

Add an `OR` condition that the JSON array or object contains the value.

```ts
const reviewers = await DB.table('users')
  .whereJsonContains('settings->tags', 'beta')
  .orWhereJsonContains('settings->tags', 'reviewer')
  .get()
```

### whereJsonLength()

Compare the number of items in a JSON array at the path. Pass an operator and a value, or just a value to use `=`.

```ts
const multiTagged = await DB.table('users')
  .whereJsonLength('settings->tags', '>=', 2)
  .get()
```

### orWhereJsonLength()

Add an `OR` condition on the length of a JSON array.

```ts
const busy = await DB.table('users')
  .whereJsonLength('settings->tags', '>=', 5)
  .orWhereJsonLength('settings->tags', 0)
  .get()
```

Use the portable `->` syntax only. Database-specific operators such as `->>` or `@>` are rejected. To compare arrays or objects, use `whereJsonContains()` — `whereJson()` only accepts scalar values.

## Full-text search

`whereFullText()` searches one or more columns with a full-text index. It works on PostgreSQL and MySQL.

### whereFullText()

Match a search string against one or more columns. Pass an array to search several columns at once.

```ts
const results = await DB.table('posts')
  .whereFullText(['title', 'body'], 'database migrations')
  .get()
```

Pass `{ mode: 'boolean' }` to use the database's boolean search syntax — `IN BOOLEAN MODE` on MySQL, `to_tsquery()` on PostgreSQL. The default mode is natural-language search.

```ts
const results = await DB.table('posts')
  .whereFullText('body', '+holo -beta', { mode: 'boolean' })
  .get()
```

### orWhereFullText()

Add an `OR` full-text match. It accepts the same columns, search string, and options as `whereFullText()`.

```ts
const results = await DB.table('posts')
  .whereFullText('title', 'holo')
  .orWhereFullText('body', 'holo')
  .get()
```

To create the index, see [Migrations](/database/migrations).

## Vector similarity

On PostgreSQL with a vector column, filter and sort by similarity to an embedding:

```ts
const similar = await DB.table('documents')
  .whereVectorSimilarTo('embedding', queryEmbedding, 0.8)
  .orderByVectorSimilarity('embedding', queryEmbedding)
  .limit(10)
  .get()
```

### whereVectorSimilarTo()

Keep rows whose vector is at least `minSimilarity` similar to the given vector. The third argument defaults to `0`, and the vector length must match the column's dimensions.

```ts
const related = await DB.table('documents')
  .whereVectorSimilarTo('embedding', queryEmbedding, 0.8)
  .get()
```

### orWhereVectorSimilarTo()

Add an `OR` vector similarity condition with the same arguments.

```ts
const related = await DB.table('documents')
  .whereVectorSimilarTo('embedding', queryEmbedding, 0.9)
  .orWhereVectorSimilarTo('summary_embedding', queryEmbedding, 0.9)
  .get()
```

## Conditional clauses

`when()` applies a callback only when the first argument is truthy. The callback receives the value, which is handy for optional filters from a request:

```ts
async function searchPosts(filters: { status?: string, authorId?: number }) {
  return await DB.table('posts')
    .when(filters.status, (query, status) => query.where('status', status))
    .when(filters.authorId, (query, authorId) => query.where('user_id', authorId))
    .get()
}
```

### when()

Run a callback when the value is truthy. An optional third callback runs when the value is falsy.

```ts
const posts = await DB.table('posts')
  .when(sortByTitle, query => query.orderBy('title'), query => query.latest())
  .get()
```

### unless()

Run a callback when the value is falsy. An optional third callback runs when the value is truthy.

```ts
const posts = await DB.table('posts')
  .unless(showDrafts, query => query.where('status', 'published'))
  .get()
```

## Ordering

```ts
const users = await DB.table('users')
  .orderBy('last_name')
  .orderBy('created_at', 'desc')
  .get()
```

### orderBy()

Sort by a column. Direction defaults to `'asc'`. Chain calls to sort by more than one column.

```ts
const users = await DB.table('users')
  .orderBy('last_name')
  .orderBy('created_at', 'desc')
  .get()
```

### latest()

Sort newest first by a column. The column defaults to `created_at`.

```ts
const recentPosts = await DB.table('posts').latest().limit(5).get()
```

### oldest()

Sort oldest first by a column. The column defaults to `created_at`.

```ts
const firstPosts = await DB.table('posts').oldest('published_at').limit(5).get()
```

### inRandomOrder()

Replace the sort with a random order.

```ts
const featured = await DB.table('posts').where('status', 'published').inRandomOrder().limit(3).get()
```

### reorder()

Clear the existing sorts. If you pass a column, sort by it. This is useful when you reuse a base query that already has a sort.

```ts
const base = DB.table('posts').latest()
const alphabetical = await base.reorder('title').get()
```

### orderByVectorSimilarity()

Sort rows by their distance to a vector. Use it on PostgreSQL with a vector column, usually together with `whereVectorSimilarTo()`.

```ts
const nearest = await DB.table('documents')
  .orderByVectorSimilarity('embedding', queryEmbedding)
  .limit(10)
  .get()
```

## Grouping and having

`groupBy()` groups rows, and `having()` filters the groups. `having()` accepts an aggregate alias you selected or an aggregate expression.

### groupBy()

Group rows by one or more columns. Pass several columns to group by each combination.

```ts
const postsPerUser = await DB.table('posts')
  .select('user_id')
  .addSelectCount('post_count')
  .groupBy('user_id')
  .get()
```

### having()

Filter groups by an aggregate. The operator defaults to `=` when you pass only a value.

```ts
const prolificAuthors = await DB.table('posts')
  .select('user_id')
  .addSelectCount('post_count')
  .groupBy('user_id')
  .having('post_count', '>', 10)
  .get()
```

### havingBetween()

Filter groups where an aggregate falls between two values, inclusive.

```ts
const steadyAuthors = await DB.table('posts')
  .select('user_id')
  .groupBy('user_id')
  .havingBetween('count(*)', [5, 20])
  .get()
```

## Locking rows

Use a lock inside a [transaction](/database/transactions#locking-rows) when you need to read a row and then update it without another request changing it first. On SQLite the lock clause is not emitted.

### lock()

Add a row lock. Pass `'update'` for an exclusive lock or `'share'` for a shared lock.

```ts
const order = await DB.table('orders')
  .where('id', 42)
  .lock('update')
  .first()
```

### lockForUpdate()

Add an exclusive lock. Other transactions cannot lock or update the matching rows until the current transaction ends.

```ts
const order = await DB.table('orders').where('id', 42).lockForUpdate().first()
```

### sharedLock()

Add a shared lock, so other transactions can read the rows but cannot update them until the transaction ends.

```ts
const order = await DB.table('orders').where('id', 42).sharedLock().first()
```

## Limit and offset

```ts
const page = await DB.table('posts')
  .orderBy('id')
  .offset(20)
  .limit(10)
  .get()
```

### limit()

Return at most the given number of rows. Call it with no value to remove the limit.

```ts
const topTen = await DB.table('posts').orderBy('views', 'desc').limit(10).get()
```

### offset()

Skip the given number of rows before returning results. Call it with no value to remove the offset.

```ts
const afterTwenty = await DB.table('posts').orderBy('id').offset(20).get()
```

### skip()

Alias for `offset()`.

```ts
const afterTwenty = await DB.table('posts').orderBy('id').skip(20).take(10).get()
```

### take()

Alias for `limit()`.

```ts
const topTen = await DB.table('posts').orderBy('views', 'desc').take(10).get()
```

### forPage()

Set the limit and offset for a page number. Pages start at `1`, and `perPage` defaults to `15`.

```ts
const thirdPage = await DB.table('posts').orderBy('id').forPage(3, 10).get()
```

It throws if the page or per-page value is not a positive integer.

For user-facing pages with totals and links, use [Pagination](/database/pagination) instead.

## Inspect the query target

These methods tell you which table and connection a query uses. They do not change the query.

### getTableName()

Return the table name the query was started with.

```ts
const tableName = DB.table('posts').where('status', 'published').getTableName()
// 'posts'
```

### getConnectionName()

Return the name of the connection the query runs on.

```ts
const connectionName = DB.table('events', 'analytics').getConnectionName()
// 'analytics'
```

### getConnection()

Return the database connection the query runs on.

```ts
const connection = DB.table('posts').getConnection()
```

## Filter methods reference

| Method | Notes |
| --- | --- |
| `where` / `orWhere` | column, operator, value — or a callback for a group |
| `whereNot` / `orWhereNot` | callback; negates the group |
| `whereNull` / `orWhereNull` / `whereNotNull` / `orWhereNotNull` | `NULL` checks |
| `whereIn` / `whereNotIn` | array of values |
| `whereBetween` / `whereNotBetween` | `[min, max]` |
| `whereLike` / `orWhereLike` | `LIKE` pattern |
| `whereColumn` | compare two columns |
| `whereAny` / `whereAll` / `whereNone` | same condition across columns |
| `whereDate` / `whereYear` / `whereMonth` / `whereDay` / `whereTime` | date parts |
| `whereJson` / `whereJsonContains` / `whereJsonLength` (and `orWhere...`) | JSON paths with `->` |
| `whereFullText` / `orWhereFullText` | PostgreSQL and MySQL |
| `whereVectorSimilarTo` / `orWhereVectorSimilarTo` | PostgreSQL vector columns |
| `whereExists` / `whereSub` / `whereInSub` and variants | subqueries — see [Joins and Subqueries](/database/query-builder/joins-and-subqueries) |
| `unsafeWhere` / `orUnsafeWhere` | raw SQL with bindings — see [Raw expressions](/database/query-builder/joins-and-subqueries#raw-expressions) |
| `withoutWhereNull(column)` / `withoutWhereNotNull(column)` | remove a `NULL` check added earlier, for example by a [scope](/orm/scopes) |
| `when` / `unless` | conditional clauses |

## Next steps

- [Joins and Subqueries](/database/query-builder/joins-and-subqueries)
- [Inserts, Updates, Deletes](/database/query-builder/writes)
- [Pagination](/database/pagination)
- [Querying Models](/orm/querying)
