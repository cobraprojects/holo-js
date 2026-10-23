# Joins and Subqueries

Combine rows from several tables with joins, nest one query inside another with subqueries, and drop down to raw SQL fragments when the builder has no method for what you need.

```ts [server/lib/posts.ts]
import { DB } from '@holo-js/db'

const posts = await DB.table('posts')
  .join('users', 'users.id', '=', 'posts.user_id')
  .leftJoin('categories', 'categories.id', '=', 'posts.category_id')
  .select('posts.id', 'posts.title', 'users.name as author', 'categories.name as category')
  .where('posts.status', 'published')
  .get()
```

## Joins

Every join takes the table, the left column, an operator, and the right column. Qualify columns with the table name (`users.id`) when both tables have a column with the same name.

### join()

`join()` is an inner join. It keeps only rows that have a match in both tables.

```ts
const rows = await DB.table('posts')
  .join('users', 'users.id', '=', 'posts.user_id')
  .select('posts.title', 'users.name')
  .get()
```

### leftJoin()

`leftJoin()` keeps every row from the first table, even when the joined table has no match.

```ts
const posts = await DB.table('posts')
  .leftJoin('categories', 'categories.id', '=', 'posts.category_id')
  .select('posts.title', 'categories.name as category')
  .get()
```

### rightJoin()

`rightJoin()` keeps every row from the joined table, even when the first table has no match.

```ts
const categories = await DB.table('posts')
  .rightJoin('categories', 'categories.id', '=', 'posts.category_id')
  .select('posts.title', 'categories.name')
  .get()
```

### crossJoin()

`crossJoin()` pairs every row of the first table with every row of the joined table. It takes no condition.

```ts
const sizesAndColors = await DB.table('sizes')
  .crossJoin('colors')
  .get()
```

You can alias joined tables just like the main table:

```ts
const rows = await DB.table('posts as p')
  .join('users as u', 'u.id', '=', 'p.user_id')
  .select('p.title', 'u.name')
  .get()
```

::: tip
If you join to load related records, a [model relationship](/orm/relationships/) is usually simpler. Use joins when you want a flat, row-shaped result.
:::

## Typed joins

When you pass [table definitions](/database/query-builder/#typed-results) instead of names, joins stay fully typed. Qualified column names (`posts.title`, `users.name`) autocomplete in `select()`, `where()`, and `orderBy()`, and the result type follows your selection:

```ts [server/lib/posts.ts]
import { DB } from '@holo-js/db'
import { posts, users } from '../../.holo-js/generated/schema.generated'

const rows = await DB.table(posts)
  .leftJoin(users, 'posts.user_id', '=', 'users.id')
  .select('posts.title', 'users.name as author')
  .get()
// rows: { title: string, author: string | null }[]
```

Holo adds `null` to the types that an outer join can leave empty:

- `leftJoin()` makes the joined table's columns nullable.
- `rightJoin()` makes the earlier tables' columns nullable.

When two tables share a column name, select them with distinct aliases (`'posts.id as postId'`).

Joins to a table name (a string) or to a subquery are not typed by column, so select their columns with plain string names.

## Subquery joins

Join to the result of another query with `joinSub()`, `leftJoinSub()`, or `rightJoinSub()`. Give the subquery an alias; you then refer to its columns through that alias.

### joinSub()

`joinSub()` joins a subquery as an inner join. It takes the subquery, its alias, the left column, an operator, and the right column.

```ts
const postCounts = DB.table('posts')
  .select('user_id')
  .addSelectCount('post_count')
  .groupBy('user_id')

const authors = await DB.table('users')
  .joinSub(postCounts, 'stats', 'stats.user_id', '=', 'users.id')
  .select('users.name', 'stats.post_count')
  .get()
```

### leftJoinSub()

`leftJoinSub()` joins a subquery as a left join, so users without any posts still appear.

```ts
const users = await DB.table('users')
  .leftJoinSub(postCounts, 'stats', 'stats.user_id', '=', 'users.id')
  .select('users.name', 'stats.post_count')
  .get()
```

### rightJoinSub()

`rightJoinSub()` joins a subquery as a right join, keeping every row of the subquery.

```ts
const stats = await DB.table('users')
  .rightJoinSub(postCounts, 'stats', 'stats.user_id', '=', 'users.id')
  .select('users.name', 'stats.post_count')
  .get()
```

## Lateral joins

A lateral join lets the subquery refer to columns of the outer query — for example, "the latest post for each user". Use `joinLateral()` or `leftJoinLateral()`. They work on PostgreSQL and MySQL; SQLite does not support lateral joins.

### joinLateral()

`joinLateral()` joins a lateral subquery as an inner join. Rows without a matching subquery result are dropped.

```ts
const latestPost = DB.table('posts')
  .select('title')
  .whereColumn('posts.user_id', '=', 'users.id')
  .latest()
  .limit(1)

const users = await DB.table('users')
  .joinLateral(latestPost, 'latest_post')
  .select('users.name', 'latest_post.title')
  .get()
```

### leftJoinLateral()

`leftJoinLateral()` joins a lateral subquery as a left join, so users with no posts still appear.

```ts
const users = await DB.table('users')
  .leftJoinLateral(latestPost, 'latest_post')
  .select('users.name', 'latest_post.title')
  .get()
```

## Subquery columns

Use a subquery as a column in the select list.

### selectSub()

`selectSub()` replaces the selection with a single subquery column. The subquery must return one value per row.

```ts
const latestTitle = DB.table('posts')
  .select('title')
  .whereColumn('posts.user_id', '=', 'users.id')
  .latest()
  .limit(1)

const users = await DB.table('users')
  .selectSub(latestTitle, 'latest_title')
  .get()
```

### addSelectSub()

`addSelectSub()` adds a subquery column next to the columns you already selected.

```ts
const users = await DB.table('users')
  .select('id', 'name')
  .addSelectSub(latestTitle, 'latest_title')
  .get()
// [{ id: 1, name: 'Ava', latest_title: 'Hello World' }, { id: 2, name: 'Sam', latest_title: null }]
```

## Where exists

`whereExists()` keeps rows for which the subquery returns at least one row. Link the subquery to the outer table with `whereColumn()`.

```ts
const usersWithPosts = await DB.table('users')
  .whereExists(
    DB.table('posts').whereColumn('posts.user_id', '=', 'users.id'),
  )
  .get()
```

### whereExists()

`whereExists()` keeps rows where the subquery returns at least one row, combined with `AND`.

### orWhereExists()

`orWhereExists()` is the `OR` version of `whereExists()`.

```ts
const users = await DB.table('users')
  .whereNull('deleted_at')
  .orWhereExists(DB.table('posts').whereColumn('posts.user_id', '=', 'users.id'))
  .get()
```

### whereNotExists()

`whereNotExists()` keeps rows where the subquery returns no rows.

```ts
const usersWithoutPosts = await DB.table('users')
  .whereNotExists(
    DB.table('posts').whereColumn('posts.user_id', '=', 'users.id'),
  )
  .get()
```

### orWhereNotExists()

`orWhereNotExists()` is the `OR` version of `whereNotExists()`.

## Where with a subquery

Compare a column to the result of a subquery.

### whereInSub()

`whereInSub()` keeps rows where the column value appears in the subquery's single column.

```ts
const bigSpenders = await DB.table('users')
  .whereInSub('id', DB.table('orders').select('user_id').where('total', '>', 500))
  .get()
```

### whereNotInSub()

`whereNotInSub()` keeps rows where the column value does not appear in the subquery's single column.

```ts
const notBanned = await DB.table('users')
  .whereNotInSub('id', DB.table('bans').select('user_id'))
  .get()
```

### whereSub()

`whereSub()` compares a column to a subquery with an operator. Make the subquery return one row and one column.

```ts
const aboveAverage = await DB.table('products')
  .whereSub('price', '>', DB.table('products').selectAvg('average', 'price'))
  .get()
```

### orWhereSub()

`orWhereSub()` is the `OR` version of `whereSub()`.

## Unions

Combine the rows of two queries. Both queries must select the same columns.

### union()

`union()` appends the rows of another query and removes duplicates.

```ts
const recentNames = await DB.table('customers')
  .select('name')
  .union(DB.table('suppliers').select('name'))
  .get()
```

### unionAll()

`unionAll()` appends the rows of another query and keeps duplicates.

```ts
const allNames = await DB.table('customers')
  .select('name')
  .unionAll(DB.table('suppliers').select('name'))
  .get()
```

## Raw expressions

When the builder has no method for an expression, use the `unsafe...` methods. Write placeholders (`?`) for every value and pass the values in the bindings array — the number of placeholders must match the bindings.

::: warning
Raw SQL is off by default. `unsafeQuery()` and `unsafeExecute()` throw a `SecurityError` unless the connection sets `security: { allowUnsafeRawSql: true }` in `config/database.ts`. `unsafeWhere()` and `orUnsafeWhere()` also need it on `update()` and `delete()`. See [Raw SQL](/database/#raw-sql).
:::

### unsafeSelect()

`unsafeSelect()` replaces the selection with a raw SQL expression.

```ts
const total = await DB.table('orders')
  .unsafeSelect('COUNT(*) AS "total"', [])
  .first()
```

### addUnsafeSelect()

`addUnsafeSelect()` adds a raw SQL expression next to the columns you already selected.

```ts
const users = await DB.table('users')
  .select('id')
  .addUnsafeSelect('upper(name) as display_name', [])
  .get()
```

### unsafeWhere()

`unsafeWhere()` adds a raw SQL condition to the `WHERE` clause, combined with `AND`.

```ts
const users = await DB.table('users')
  .unsafeWhere('lower(email) = ?', [email.toLowerCase()])
  .get()
```

### orUnsafeWhere()

`orUnsafeWhere()` adds a raw SQL condition combined with `OR`.

```ts
const users = await DB.table('users')
  .where('active', true)
  .orUnsafeWhere('lower(email) = ?', [email.toLowerCase()])
  .get()
```

### unsafeOrderBy()

`unsafeOrderBy()` adds a raw SQL expression to the `ORDER BY` clause.

```ts
const users = await DB.table('users')
  .unsafeOrderBy('length(name) desc', [])
  .get()
```

### unsafeQuery()

`unsafeQuery()` runs a complete raw SQL statement that returns rows. It is called on the builder for the same connection and requires `allowUnsafeRawSql`.

```ts
const rows = await DB.table('users').unsafeQuery<{ total: number }>({
  unsafe: true,
  sql: 'SELECT COUNT(*) AS total FROM users WHERE active = ?',
  bindings: [true],
})
```

### unsafeExecute()

`unsafeExecute()` runs a complete raw SQL statement that writes data and returns the execution result. It requires `allowUnsafeRawSql`.

```ts
await DB.table('users').unsafeExecute({
  unsafe: true,
  sql: 'UPDATE users SET active = ? WHERE last_seen_at < ?',
  bindings: [false, cutoff],
})
```

::: danger
Never put user input directly in the SQL string. Always pass it through the bindings array.
:::

To run a raw statement without a table, use `DB.unsafeQuery()` and `DB.unsafeExecute()` — see [Raw SQL](/database/#raw-sql).

## Next steps

- [Selects and Filters](/database/query-builder/selects-and-filters)
- [Inserts, Updates, Deletes](/database/query-builder/writes)
- [Relationships](/orm/relationships/)
