# Query Builder: Joins & Subqueries

Holo-JS supports the common join patterns you expect from a fluent builder, but compilation stays
explicit and validated per dialect.

## Basic joins

```ts
const rows = await DB.table('users as u')
  .join('profiles', 'profiles.user_id', '=', 'u.id')
  .leftJoin('teams', 'teams.id', '=', 'u.team_id')
  .get()
```

Supported join families include:

- `join`
- `leftJoin`
- `rightJoin`
- `crossJoin`

Use joins when the result should remain a table-shaped projection. If the application really wants related
entities and lifecycle behavior, model relations are usually the better fit.

## Subquery joins

```ts
const latestPosts = DB.table('posts')
  .select('user_id', 'title')
  .orderBy('created_at', 'desc')

const rows = await DB.table('users')
  .joinSub(latestPosts, 'latest_posts', 'latest_posts.user_id', '=', 'users.id')
  .get()
```

Subquery joins require explicit aliases. The compiler rejects missing aliases instead of guessing.

Use a subquery join when the joined shape needs its own filtered or aggregated query plan first.

## Lateral joins

```ts
const latestPost = DB.table('posts')
  .select('title')
  .whereColumn('posts.user_id', '=', 'users.id')
  .limit(1)

const rows = await DB.table('users')
  .joinLateral(latestPost, 'latest_post')
  .get()
```

Lateral joins only compile on supporting dialects. Unsupported dialects fail closed.

Use lateral joins only when the query genuinely needs row-by-row dependent subqueries.

## Scalar subqueries

```ts
const rows = await DB.table('users')
  .whereSub(
    'score',
    '>',
    DB.table('scores').select('value').whereColumn('scores.user_id', '=', 'users.id').limit(1)
  )
  .get()
```

Use scalar subqueries when one column should be compared against the result of another focused query.

## Set subqueries

```ts
const activeUserIds = DB.table('sessions')
  .select('user_id')
  .where('active', true)

const users = await DB.table('users')
  .whereInSub('id', activeUserIds)
  .get()
```

Use set subqueries when the membership test belongs in SQL and should stay close to the database.

## Unions

```ts
const first = DB.table('users').select('email')
const second = DB.table('admins').select('email')

const emails = await first.unionAll(second).get()
```

## Full text and advanced clauses

```ts
const docs = await DB.table('documents')
  .whereFullText(['title', 'body'], 'compiler')
  .get()
```

The query compiler decides whether a clause is supported. The adapter does not try to emulate missing SQL
syntax.
