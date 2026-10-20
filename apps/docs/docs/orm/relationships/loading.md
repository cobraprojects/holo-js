# Eager Loading and Aggregates

Eager loading fetches related models up front, in one extra query per relation, instead of one query per parent. Aggregates such as `withCount()` add a number (a count, sum, average, and so on) without loading the related rows at all.

```ts [server/lib/posts.ts]
import Post from '../models/Post'

const posts = await Post.with('author', 'tags').latest().get()

for (const post of posts) {
  console.log(post.title, post.author?.name, post.tags.length)
}
```

This runs three queries in total, whether you have 10 posts or 10,000. Each post's `author` is typed as `User | null` and `tags` as `Tag[]`.

## Why eager load

Without `with()`, reading a relation inside a loop runs a query for every item. This is the "N+1" problem: 1 query for the posts, plus N queries for their authors. `with()` collects every key first and loads the related rows with a `WHERE ... IN (...)` query. The keys go in chunks of at most 256, so a relation loaded for thousands of parents runs one query per chunk. A constraint that calls `limit()` or `offset()` is the exception: it runs as one query, so the limit or offset applies to all parents together, as in Laravel.

## Eager loading

Pass one or more relation names to `with()`. Names autocomplete, and an unknown name is a type error:

```ts
const users = await User.with('posts', 'profile').get()
```

The result type includes each loaded relation:

| Relation kind | Loaded type |
| --- | --- |
| `hasMany`, `belongsToMany`, `morphMany`, `hasManyThrough`, ... | `Related[]` |
| `belongsTo`, `hasOne`, `morphOne`, `hasOneThrough`, one-of-many | `Related \| null` |

Loaded relations also appear in `toJSON()` and the `*Json()` query methods, with the same types:

```ts
const json = await Post.with('author').firstJson()

json?.author?.name
```

## Nested eager loading

Use dots to load relations of relations. Every segment is checked against the model it belongs to:

```ts
const posts = await Post.with('author.profile', 'comments.author').get()

posts[0]?.comments[0]?.author?.name
```

## Constraining eager loads

Pass a callback to filter, sort, or limit the related rows. Either give a name and a callback, or an object of callbacks:

```ts
const authors = await User
  .with('posts', query => query.where('status', 'published').latest())
  .get()

const members = await User.with({
  posts: query => query.where('status', 'published'),
  comments: query => query.where('status', 'approved').latest(),
}).get()
```

::: warning Return the query
Query builders are immutable, so the callback must return the builder: `query => query.where(...)`. A block body like `query => { query.where(...) }` returns nothing, and the constraint is silently skipped.
:::

Column names inside the callback are not autocompleted. For a single typed condition when filtering parents, use [`whereRelation()`](/orm/relationships/#querying-by-relationship).

### Filter and load in one step

`withWhereHas()` keeps only the parents that have matching related rows, and loads just those rows:

```ts
const users = await User
  .withWhereHas('posts', query => query.where('status', 'published'))
  .get()
```

## Loading after the fact

When you already have a model, call `load()`. It returns the same model, typed with the new relation:

```ts
const post = await Post.findOrFail(1)

const loaded = await post.load('author', 'tags')

loaded.author?.name
loaded.tags.map(tag => tag.name)
```

`loadMissing()` only loads relations that aren't loaded yet, which is handy in shared helpers:

```ts
await post.loadMissing('author')
```

Both work on a [collection](/orm/collections) of models too, and still use one query per relation for the whole collection:

```ts
const posts = await Post.latest().limit(20).get()

await posts.load('author')
```

## Always loading a relation

Set `with` in the model definition to eager load a relation on every query:

```ts [server/models/User.ts]
import { defineModel, hasOne } from '@holo-js/db'

export default defineModel('users', {
  with: ['profile'],
  relations: {
    profile: hasOne('Profile', { foreignKey: 'user_id' }),
  },
})
```

Skip the default for one query with `newQueryWithoutRelationships()`:

```ts
const user = await User.newQueryWithoutRelationships().findOrFail(1)
```

## Lazy loading

Awaiting a relation property you didn't load fetches it on demand. That's convenient in scripts, but in a loop it brings back the N+1 problem.

### Preventing lazy loading

Turn on `preventLazyLoading` to make on-demand loads throw instead, so you catch missing `with()` calls during development:

```ts [server/models/Post.ts]
import { belongsTo, defineModel } from '@holo-js/db'

export default defineModel('posts', {
  preventLazyLoading: true,
  relations: {
    author: belongsTo('User', { foreignKey: 'user_id' }),
  },
})
```

You can also toggle it at runtime with `Post.preventLazyLoading()` or `Post.preventLazyLoading(false)`.

### Automatic eager loading

With `automaticEagerLoading: true` (or `Post.automaticallyEagerLoadRelationships()`), a lazy load on one model in a result set loads that relation for every model in the same set at once. This turns accidental N+1 queries into a single query. When it's on, `preventLazyLoading` doesn't throw.

## Polymorphic loading

A [`morphTo`](/orm/relationships/through-and-polymorphic#polymorphic-relationships) can point at different models, and each may need different nested relations. `loadMorph()` maps each parent type to the relations to load on it:

```ts
const images = await Image.with('imageable').get()

await images.loadMorph('imageable', {
  User: ['profile', 'posts'],
  Post: 'comments',
})
```

Keys are model names (or morph class values). Each value is a relation name, an array of names, or an object of constraint callbacks:

```ts
await images.loadMorph('imageable', {
  Post: { comments: query => query.where('status', 'approved') },
})
```

Use plain `load('imageable.comments')` when every parent type has the same relation.

## Counting related models

`withCount()` adds a `{relation}_count` attribute to each result without loading the rows:

```ts
const posts = await Post.withCount('comments', 'tags').get()
```

Each post now carries `comments_count` and `tags_count`, which appear in `toJSON()` and in API responses.

Count only some rows with an object of callbacks:

```ts
const posts = await Post.withCount({
  comments: query => query.where('status', 'approved'),
}).get()
```

`withExists()` adds a `{relation}_exists` boolean instead:

```ts
const users = await User.withExists('posts').get()
```

## Sum, average, min, and max

`withSum()`, `withAvg()`, `withMin()`, and `withMax()` take a relation and a column on the related model. The column autocompletes:

```ts
const users = await User
  .withSum('orders', 'total')
  .withMax('orders', 'total')
  .get()
```

The attribute is named `{relation}_{function}_{column}`, here `orders_sum_total` and `orders_max_total`. The column must hold numbers. Sums of no rows are `0`; averages, minimums, and maximums of no rows are `null`.

Pass a constraint object as the first argument to aggregate a subset:

```ts
const users = await User
  .withSum({ orders: query => query.where('status', 'paid') }, 'total')
  .get()
```

::: info Aggregate attributes and types
Aggregate attributes are added at runtime and are not part of the model's inferred type. They are included when the model is serialized with `toJSON()` or the `*Json()` query methods.
:::

### Aggregates on loaded models

The same aggregates are available after the fact, on a model or a collection:

```ts
const user = await User.findOrFail(1)

await user.loadCount('posts')
await user.loadExists('comments')
await user.loadSum('orders', 'total')
await user.loadAvg('orders', 'total')
await user.loadMin('orders', 'total')
await user.loadMax('orders', 'total')
```

## Reference

| Method | Available on | Purpose |
| --- | --- | --- |
| `with(...names)` / `with(name, callback)` / `with({ ... })` | queries, models (static) | Eager load relations |
| `withWhereHas(name, callback?)` | queries | Filter parents and load matching rows |
| `load(...names)`, `loadMissing(...names)` | models, collections | Load after retrieval |
| `loadMorph(name, mapping)` | models, collections | Per-type nested loads for `morphTo` |
| `withCount`, `withExists` | queries | Count or check related rows |
| `withSum`, `withAvg`, `withMin`, `withMax` | queries | Aggregate a related column |
| `loadCount`, `loadExists`, `loadSum`, `loadAvg`, `loadMin`, `loadMax` | models, collections | Aggregates after retrieval |
| `newQueryWithoutRelationships()` | models (static) | Skip the model's default `with` |

## Next steps

- [Querying Models](/orm/querying)
- [Serialization](/orm/serialization)
- [Collections](/orm/collections)
- [Pagination](/database/pagination)
