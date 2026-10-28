# Query Builder

The query builder lets you write SQL queries in a fluent, chainable way. Use it when you want plain rows back — reports, dashboards, exports, background jobs — instead of [models](/orm/). Every value you pass is sent as a bound parameter, so you never build SQL strings by hand.

```ts [server/lib/posts.ts]
import { DB } from '@holo-js/db'

export async function recentPublishedPosts() {
  return await DB.table('posts')
    .select('id', 'title', 'published_at')
    .where('status', 'published')
    .orderBy('published_at', 'desc')
    .limit(10)
    .get()
}
```

`DB` uses the connections from your `config/database.ts`. See [Database: Getting Started](/database/) for setup.

## Available methods

Every query builder method, grouped by what it does. Each name links to its entry.

**Start and choose a connection**

- [table()](/database/#table) on `DB`, then [from()](#from), [getTableName()](/database/query-builder/selects-and-filters#gettablename), [getConnectionName()](/database/query-builder/selects-and-filters#getconnectionname), [getConnection()](/database/query-builder/selects-and-filters#getconnection)

**Select columns**

- [select()](/database/query-builder/selects-and-filters#select), [addSelect()](/database/query-builder/selects-and-filters#addselect), [distinct()](/database/query-builder/selects-and-filters#distinct)
- [selectCount()](/database/query-builder/selects-and-filters#selectcount), [addSelectCount()](/database/query-builder/selects-and-filters#addselectcount), [selectSum()](/database/query-builder/selects-and-filters#selectsum), [addSelectSum()](/database/query-builder/selects-and-filters#addselectsum), [selectAvg()](/database/query-builder/selects-and-filters#selectavg), [addSelectAvg()](/database/query-builder/selects-and-filters#addselectavg), [selectMin()](/database/query-builder/selects-and-filters#selectmin), [addSelectMin()](/database/query-builder/selects-and-filters#addselectmin), [selectMax()](/database/query-builder/selects-and-filters#selectmax), [addSelectMax()](/database/query-builder/selects-and-filters#addselectmax)
- [selectSub()](/database/query-builder/joins-and-subqueries#selectsub), [addSelectSub()](/database/query-builder/joins-and-subqueries#addselectsub), [unsafeSelect()](/database/query-builder/joins-and-subqueries#unsafeselect), [addUnsafeSelect()](/database/query-builder/joins-and-subqueries#addunsafeselect)

**Filter rows**

- [where()](/database/query-builder/selects-and-filters#where), [orWhere()](/database/query-builder/selects-and-filters#orwhere), [whereNot()](/database/query-builder/selects-and-filters#wherenot), [orWhereNot()](/database/query-builder/selects-and-filters#orwherenot)
- [whereNull()](/database/query-builder/selects-and-filters#wherenull), [orWhereNull()](/database/query-builder/selects-and-filters#orwherenull), [whereNotNull()](/database/query-builder/selects-and-filters#wherenotnull), [orWhereNotNull()](/database/query-builder/selects-and-filters#orwherenotnull), [withoutWhereNull()](/database/query-builder/selects-and-filters#withoutwherenull), [withoutWhereNotNull()](/database/query-builder/selects-and-filters#withoutwherenotnull)
- [whereIn()](/database/query-builder/selects-and-filters#wherein), [whereNotIn()](/database/query-builder/selects-and-filters#wherenotin), [whereBetween()](/database/query-builder/selects-and-filters#wherebetween), [whereNotBetween()](/database/query-builder/selects-and-filters#wherenotbetween)
- [whereLike()](/database/query-builder/selects-and-filters#wherelike), [orWhereLike()](/database/query-builder/selects-and-filters#orwherelike), [whereColumn()](/database/query-builder/selects-and-filters#wherecolumn)
- [whereAny()](/database/query-builder/selects-and-filters#whereany), [whereAll()](/database/query-builder/selects-and-filters#whereall), [whereNone()](/database/query-builder/selects-and-filters#wherenone)
- [whereDate()](/database/query-builder/selects-and-filters#wheredate), [whereMonth()](/database/query-builder/selects-and-filters#wheremonth), [whereDay()](/database/query-builder/selects-and-filters#whereday), [whereYear()](/database/query-builder/selects-and-filters#whereyear), [whereTime()](/database/query-builder/selects-and-filters#wheretime)
- [whereJson()](/database/query-builder/selects-and-filters#wherejson), [orWhereJson()](/database/query-builder/selects-and-filters#orwherejson), [whereJsonContains()](/database/query-builder/selects-and-filters#wherejsoncontains), [orWhereJsonContains()](/database/query-builder/selects-and-filters#orwherejsoncontains), [whereJsonLength()](/database/query-builder/selects-and-filters#wherejsonlength), [orWhereJsonLength()](/database/query-builder/selects-and-filters#orwherejsonlength)
- [whereFullText()](/database/query-builder/selects-and-filters#wherefulltext), [orWhereFullText()](/database/query-builder/selects-and-filters#orwherefulltext), [whereVectorSimilarTo()](/database/query-builder/selects-and-filters#wherevectorsimilarto), [orWhereVectorSimilarTo()](/database/query-builder/selects-and-filters#orwherevectorsimilarto)
- [whereExists()](/database/query-builder/joins-and-subqueries#whereexists), [orWhereExists()](/database/query-builder/joins-and-subqueries#orwhereexists), [whereNotExists()](/database/query-builder/joins-and-subqueries#wherenotexists), [orWhereNotExists()](/database/query-builder/joins-and-subqueries#orwherenotexists)
- [whereSub()](/database/query-builder/joins-and-subqueries#wheresub), [orWhereSub()](/database/query-builder/joins-and-subqueries#orwheresub), [whereInSub()](/database/query-builder/joins-and-subqueries#whereinsub), [whereNotInSub()](/database/query-builder/joins-and-subqueries#wherenotinsub)
- [unsafeWhere()](/database/query-builder/joins-and-subqueries#unsafewhere), [orUnsafeWhere()](/database/query-builder/joins-and-subqueries#orunsafewhere)
- [when()](/database/query-builder/selects-and-filters#when), [unless()](/database/query-builder/selects-and-filters#unless)

**Join and combine queries**

- [join()](/database/query-builder/joins-and-subqueries#join), [leftJoin()](/database/query-builder/joins-and-subqueries#leftjoin), [rightJoin()](/database/query-builder/joins-and-subqueries#rightjoin), [crossJoin()](/database/query-builder/joins-and-subqueries#crossjoin)
- [joinSub()](/database/query-builder/joins-and-subqueries#joinsub), [leftJoinSub()](/database/query-builder/joins-and-subqueries#leftjoinsub), [rightJoinSub()](/database/query-builder/joins-and-subqueries#rightjoinsub)
- [joinLateral()](/database/query-builder/joins-and-subqueries#joinlateral), [leftJoinLateral()](/database/query-builder/joins-and-subqueries#leftjoinlateral)
- [union()](/database/query-builder/joins-and-subqueries#union), [unionAll()](/database/query-builder/joins-and-subqueries#unionall)

**Group, order, and limit**

- [groupBy()](/database/query-builder/selects-and-filters#groupby), [having()](/database/query-builder/selects-and-filters#having), [havingBetween()](/database/query-builder/selects-and-filters#havingbetween)
- [orderBy()](/database/query-builder/selects-and-filters#orderby), [latest()](/database/query-builder/selects-and-filters#latest), [oldest()](/database/query-builder/selects-and-filters#oldest), [inRandomOrder()](/database/query-builder/selects-and-filters#inrandomorder), [reorder()](/database/query-builder/selects-and-filters#reorder), [orderByVectorSimilarity()](/database/query-builder/selects-and-filters#orderbyvectorsimilarity), [unsafeOrderBy()](/database/query-builder/joins-and-subqueries#unsafeorderby)
- [limit()](/database/query-builder/selects-and-filters#limit), [offset()](/database/query-builder/selects-and-filters#offset), [skip()](/database/query-builder/selects-and-filters#skip), [take()](/database/query-builder/selects-and-filters#take), [forPage()](/database/query-builder/selects-and-filters#forpage)
- [lock()](/database/query-builder/selects-and-filters#lock), [lockForUpdate()](/database/query-builder/selects-and-filters#lockforupdate), [sharedLock()](/database/query-builder/selects-and-filters#sharedlock)

**Read rows**

- [get()](#get), [first()](#first), [find()](#find), [sole()](#sole)
- [value()](#value), [valueOrFail()](#valueorfail), [soleValue()](#solevalue), [pluck()](#pluck)
- [exists()](#exists), [doesntExist()](#doesntexist)
- [count()](#count), [sum()](#sum), [avg()](#avg), [min()](#min), [max()](#max)
- [paginate()](/database/pagination#paginate), [simplePaginate()](/database/pagination#simplepaginate), [cursorPaginate()](/database/pagination#cursorpaginate)
- [chunk()](/database/query-builder/chunking#chunk), [chunkById()](/database/query-builder/chunking#chunkbyid), [chunkByIdDesc()](/database/query-builder/chunking#chunkbyiddesc), [lazy()](/database/query-builder/chunking#lazy), [cursor()](/database/query-builder/chunking#cursor)

**Write rows**

- [insert()](/database/query-builder/writes#insert), [insertOrIgnore()](/database/query-builder/writes#insertorignore), [insertGetId()](/database/query-builder/writes#insertgetid), [upsert()](/database/query-builder/writes#upsert)
- [update()](/database/query-builder/writes#update), [updateJson()](/database/query-builder/writes#updatejson), [increment()](/database/query-builder/writes#increment), [decrement()](/database/query-builder/writes#decrement), [delete()](/database/query-builder/writes#delete)

**Debug, cache, and raw SQL**

- [toSQL()](#tosql), [debug()](#debug), [dump()](#dump), [cache()](#cache)
- [unsafeQuery()](/database/query-builder/joins-and-subqueries#unsafequery), [unsafeExecute()](/database/query-builder/joins-and-subqueries#unsafeexecute)

## Start a query

Call `DB.table()` with a table name. Each chained method returns a new query, so you can build a base query and reuse it safely.

```ts
import { DB } from '@holo-js/db'

const posts = DB.table('posts')

const drafts = await posts.where('status', 'draft').get()
const published = await posts.where('status', 'published').get()
```

You can alias the table with `as`:

```ts
const rows = await DB.table('posts as p')
  .select('p.id', 'p.title')
  .get()
```

To run the query on a connection other than the default, pass its name as the second argument. See [Multiple Connections](/database/connections).

```ts
const events = await DB.table('events', 'analytics').get()
```

### from()

`from()` switches the query to a different table while keeping the connection and any clauses you already added.

```ts
const archived = await DB.table('posts').from('archived_posts').get()
```

## Booleans in SQLite

Pass JavaScript booleans directly in filters, inserts, updates, and upserts, including queries started with a string table name:

```ts
import { DB } from '@holo-js/db'

await DB.table('users').where('id', 7).update({ active: true })
const activeUsers = await DB.table('users').where('active', true).get()
```

The SQLite driver binds scalar `true` as `1` and `false` as `0`; you don't need to register a table schema for this conversion. Query-builder rows keep SQLite's numeric values when read back. For boolean model attributes, use a [boolean cast](/orm/casts#built-in-casts). Booleans inside JSON values remain JSON booleans.

## Get all rows

### get()

`get()` runs the query and returns an array of rows.

```ts
const users = await DB.table('users')
  .where('active', true)
  .get()

for (const user of users) {
  console.log(user.email)
}
```

## Get a single row

### first()

`first()` returns the first matching row, or `undefined` when nothing matches.

```ts
const user = await DB.table('users')
  .where('email', 'ava@example.com')
  .first()

if (!user) {
  throw new Error('User not found')
}
```

### find()

`find()` looks up a row by its `id` column. Pass a second argument to search a different column.

```ts
const post = await DB.table('posts').find(42)
const bySlug = await DB.table('posts').find('hello-world', 'slug')
```

### sole()

`sole()` returns the only matching row. It throws if there are zero rows or more than one.

```ts
const invoice = await DB.table('invoices')
  .where('number', 'INV-1001')
  .sole()
```

## Get a single value

### value()

`value()` returns one column from the first matching row, or `undefined`.

```ts
const email = await DB.table('users')
  .where('id', 7)
  .value('email')
```

### valueOrFail()

`valueOrFail()` returns the column value, or throws when no row matches.

```ts
const apiKey = await DB.table('api_keys')
  .where('user_id', 7)
  .valueOrFail('secret')
```

### soleValue()

`soleValue()` returns the column value of the only matching row. It throws when zero rows or more than one row match.

```ts
const plan = await DB.table('subscriptions')
  .where('id', 'sub_123')
  .soleValue('plan')
```

| Method | Returns | When nothing matches |
| --- | --- | --- |
| `value(column)` | the column value | `undefined` |
| `valueOrFail(column)` | the column value | throws |
| `soleValue(column)` | the column value of the only row | throws (also throws if more than one row matches) |

## Get a list of column values

### pluck()

`pluck()` returns one column from every matching row as an array.

```ts
const titles = await DB.table('posts')
  .where('status', 'published')
  .pluck('title')
// ['Hello World', 'Second Post', ...]
```

## Check if rows exist

### exists()

`exists()` returns `true` when at least one row matches.

```ts
const taken = await DB.table('users')
  .where('email', 'ava@example.com')
  .exists()
```

### doesntExist()

`doesntExist()` is the opposite of `exists()`: it returns `true` when no row matches.

```ts
const isFree = await DB.table('users')
  .where('email', 'ava@example.com')
  .doesntExist()
```

## Aggregates

The builder has methods for the common aggregate functions. They respect your `where` clauses.

### count()

`count()` returns the number of matching rows.

```ts
const userCount = await DB.table('users').count()
```

### sum()

`sum()` adds up one numeric column across the matching rows.

```ts
const revenue = await DB.table('orders').where('status', 'paid').sum('total')
```

### avg()

`avg()` returns the average of one column. It returns `null` when no rows match.

```ts
const averageOrder = await DB.table('orders').avg('total')
```

### min()

`min()` returns the lowest value of one column. It returns `null` when no rows match.

```ts
const cheapest = await DB.table('products').min('price')
```

### max()

`max()` returns the highest value of one column. It returns `null` when no rows match.

```ts
const priciest = await DB.table('products').max('price')
```

`count()` and `sum()` return a `number`. `avg()`, `min()`, and `max()` return `number | null`.

To compute aggregates per group, select them as columns instead. See [Grouping](/database/query-builder/selects-and-filters#grouping-and-having).

```ts
const postsPerUser = await DB.table('posts')
  .select('user_id')
  .addSelectCount('post_count')
  .groupBy('user_id')
  .get()
// [{ user_id: 1, post_count: 12 }, ...]
```

## Typed results

When you pass a table **name**, rows are typed as `Record<string, unknown>`. You have two ways to get precise types.

**Pass a table definition.** Holo generates a definition for every table in your migrations into `.holo-js/generated/schema.generated.ts` (Holo regenerates this file; don't edit it). Each table is exported in camelCase (`posts`, `postTags`, `users`). Pass one to `DB.table()` and column names autocomplete everywhere, and results carry the real column types:

```ts [server/lib/posts.ts]
import { DB } from '@holo-js/db'
import { posts } from '../../.holo-js/generated/schema.generated'

const rows = await DB.table(posts)
  .select('id', 'title as heading')
  .where('status', 'published')
  .get()
// rows: { id: number, heading: string }[]
```

With a table definition, `select()`, `where()`, `orderBy()`, `groupBy()`, `pluck()`, and `value()` only accept real column names, and `select('title as heading')` renames the key in the result type.

A table definition also sets how integer columns are read. `id()`, `integer()`, `bigInteger()`, and `foreignId()` columns come back as numbers on every driver, the same values a [model](/orm/) returns, including columns of a definition you pass to `join()`. PostgreSQL sends `bigint` columns as text, so with a table name you get strings such as `"1"` there. A value above `Number.MAX_SAFE_INTEGER` throws a `HydrationError`. Raw SQL selections keep the driver's values.

**Or annotate the row type.** `get()`, `first()`, and `sole()` accept a row type:

```ts
type PostRow = { id: number, title: string }

const rows = await DB.table('posts').select('id', 'title').get<PostRow>()
```

::: tip
For queries that belong to a single domain record — with relationships, casts, and events — use a [model](/orm/) instead. Models are typed automatically.
:::

## Debug a query

### toSQL()

`toSQL()` returns the compiled SQL and bindings without running the query.

```ts
const query = DB.table('users').where('active', true).orderBy('name')

console.log(query.toSQL())
// { sql: 'SELECT * FROM "users" WHERE "active" = ? ORDER BY "name" ASC', bindings: [true], ... }
```

### debug()

`debug()` returns the same output as `toSQL()`, plus the connection name and scheduling details. Sensitive bindings are redacted.

```ts
const details = DB.table('users').where('active', true).debug()
console.log(details.connectionName)
```

### dump()

`dump()` logs the `debug()` output and returns the same query, so you can keep chaining.

```ts
const users = await DB.table('users').where('active', true).dump().get()
```

## Cache query results

### cache()

`cache()` stores the result in the [cache](/cache/). Pass a TTL in seconds, a `Date` to expire at that time, or an options object with `ttl` or `flexible`, plus optional `key`, `driver`, and `invalidate`. See [Query Caching](/cache/query-caching) for keys, drivers, and invalidation.

```ts
const categories = await DB.table('categories')
  .orderBy('name')
  .cache(300)
  .get()
```

## Reading methods reference

| Method | Returns |
| --- | --- |
| `get()` | all rows |
| `first()` | first row or `undefined` |
| `find(value, column = 'id')` | matching row or `undefined` |
| `sole()` | the only row; throws otherwise |
| `value(column)` / `valueOrFail(column)` / `soleValue(column)` | one column value |
| `pluck(column)` | array of one column's values |
| `exists()` / `doesntExist()` | `boolean` |
| `count()` / `sum(column)` | `number` |
| `avg(column)` / `min(column)` / `max(column)` | `number \| null` |
| `paginate()` / `simplePaginate()` / `cursorPaginate()` | a page of rows — see [Pagination](/database/pagination) |
| `chunk()` / `chunkById()` / `lazy()` / `cursor()` | batches or a stream — see [Chunking](/database/query-builder/chunking) |

## Next steps

- [Selects and Filters](/database/query-builder/selects-and-filters)
- [Joins and Subqueries](/database/query-builder/joins-and-subqueries)
- [Inserts, Updates, Deletes](/database/query-builder/writes)
- [Pagination](/database/pagination)
