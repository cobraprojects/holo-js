# Collections

Queries that return more than one model give you a collection. A collection is a real JavaScript array of models with a few extra methods for loading relations, re-querying, and serializing the whole set.

```ts
const posts = await Post.where('status', 'published').get()

const titles = posts.map(post => post.title)
const ids = posts.modelKeys()

await posts.load('author')

return posts.toJSON()
```

## Available methods

Every method is listed alphabetically below and described in the [method reference](#method-reference). Standard array methods, such as `map()` and `filter()`, also work.

<div class="method-list">

- [append()](#append)
- [fresh()](#fresh)
- [load()](#load)
- [loadAvg()](#loadavg)
- [loadCount()](#loadcount)
- [loadExists()](#loadexists)
- [loadMax()](#loadmax)
- [loadMin()](#loadmin)
- [loadMissing()](#loadmissing)
- [loadMorph()](#loadmorph)
- [loadSum()](#loadsum)
- [makeHidden()](#makehidden)
- [makeVisible()](#makevisible)
- [modelKeys()](#modelkeys)
- [setHidden()](#sethidden)
- [setVisible()](#setvisible)
- [toJSON()](#tojson)
- [toQuery()](#toquery)
- [withoutAppends()](#withoutappends)

</div>

## Collections are arrays

`get()`, `all()`, `findMany()`, `createMany()`, and the `data` of a paginated result all return collections. Because a collection is an `Array`, every array method works and keeps the model types:

```ts
const posts = await Post.all()

const featured = posts.filter(post => post.is_featured)
const first = posts[0]
const count = posts.length

for (const post of posts) {
  console.log(post.title)
}
```

Methods like `filter()` and `map()` return plain arrays, not collections. Call collection methods before you transform the array.

## Getting primary keys

`modelKeys()` returns the primary key of every model:

```ts
const users = await User.where('active', true).get()

users.modelKeys()
// [1, 4, 9]
```

## Querying the same records again

`toQuery()` builds a model query limited to the records in the collection. Use it to run a bulk update or a fresh query on exactly that set:

```ts
const drafts = await Post.where('status', 'draft').get()

await drafts.toQuery().update({ status: 'archived' })
```

`toQuery()` throws on an empty collection, so check `length` first if the collection might be empty.

The query keeps the model's named scopes, so `drafts.toQuery().published()` type-checks when `Post` defines a `published` scope.

## Reloading from the database

`fresh()` reloads every model and returns a new collection. Records deleted in the meantime are left out:

```ts
const latest = await posts.fresh()
```

## Loading relations

Load relations for every model in one query per relation. This avoids running a query per model:

```ts
const posts = await Post.all()

await posts.load('author', 'comments')

await posts.loadMissing('author')
```

`load()` always queries. `loadMissing()` skips relations that are already loaded. Both return the collection with the loaded relations typed.

For `morphTo` relations, `loadMorph()` loads different nested relations depending on the related model. The keys are the stored morph types:

```ts
await comments.loadMorph('commentable', {
  Post: 'author',
  Video: ['channel', 'tags'],
})
```

## Loading aggregates

Add relation counts and sums to every model without loading the related rows:

```ts
const users = await User.all()

await users.loadCount('posts')
await users.loadExists('posts')
await users.loadSum('orders', 'total')
await users.loadAvg('orders', 'total')
await users.loadMin('orders', 'total')
await users.loadMax('orders', 'total')

users.toJSON()
// [{ id: 1, name: 'Amina', posts_count: 3, posts_exists: true, orders_sum_total: 240, ... }]
```

| Method | Attribute name |
| --- | --- |
| `loadCount('posts')` | `posts_count` |
| `loadExists('posts')` | `posts_exists` |
| `loadSum('orders', 'total')` | `orders_sum_total` |
| `loadAvg('orders', 'total')` | `orders_avg_total` |
| `loadMin('orders', 'total')` | `orders_min_total` |
| `loadMax('orders', 'total')` | `orders_max_total` |

The column argument autocompletes from the related model's columns. To add aggregates while querying, use `withCount()` and friends from [eager loading and aggregates](/orm/relationships/loading).

## Serializing a collection

`toJSON()` serializes each model, respecting its `hidden`, `visible`, and `appended` settings:

```ts
return users.toJSON()
```

Change visibility for every model in the collection at once:

```ts
users.makeHidden('email').toJSON()
users.makeVisible('phone').toJSON()
users.setVisible(['id', 'name']).toJSON()
users.setHidden(['password']).toJSON()
users.append('display_name').toJSON()
users.withoutAppends().toJSON()
```

See [serialization](/orm/serialization) for how each option works.

## Method reference

### append()

Adds computed attributes to the JSON output of every model. Repeated keys are added once.

```ts
users.append('display_name').toJSON()
```

### fresh()

Reloads every model from the database and returns a new collection. Models whose row was deleted are left out.

```ts
const current = await users.fresh()
```

### load()

Eager loads relations on every model in the collection, even ones already loaded. Use `loadMissing()` to skip the loaded ones.

```ts
await posts.load('author', 'tags')
```

### loadAvg()

Adds a `{relation}_avg_{column}` attribute to each model with the average of a related column.

```ts
await authors.loadAvg('books', 'rating')
// authors[0].books_avg_rating
```

### loadCount()

Adds a `{relation}_count` attribute to each model.

```ts
await authors.loadCount('books')
// authors[0].books_count
```

### loadExists()

Adds a `{relation}_exists` boolean to each model. It's `true` when at least one related row exists.

```ts
await authors.loadExists('books')
// authors[0].books_exists
```

### loadMax()

Adds a `{relation}_max_{column}` attribute to each model with the largest related value.

```ts
await authors.loadMax('books', 'pages')
```

### loadMin()

Adds a `{relation}_min_{column}` attribute to each model with the smallest related value.

```ts
await authors.loadMin('books', 'pages')
```

### loadMissing()

Eager loads only the relations that aren't loaded on the models yet.

```ts
await posts.loadMissing('author')
```

### loadMorph()

Loads nested relations for a `morphTo` relation, with a different set per parent type. Keys are model names or morph class values. Each value is a relation name, an array of names, or an object of constraint callbacks.

```ts
await images.loadMorph('imageable', {
  User: ['profile', 'posts'],
  Post: 'comments',
})
```

### loadSum()

Adds a `{relation}_sum_{column}` attribute to each model with the total of a related column.

```ts
await authors.loadSum('books', 'pages')
// authors[0].books_sum_pages
```

### makeHidden()

Hides the given keys on every model in the collection, in addition to their current hidden keys.

```ts
users.makeHidden('email').toJSON()
```

### makeVisible()

Shows the given hidden keys on every model in the collection.

```ts
users.makeVisible('phone').toJSON()
```

### modelKeys()

Returns the primary key of every model, in collection order.

```ts
const ids = users.modelKeys()
// [1, 4, 9]
```

### setHidden()

Replaces the hidden keys on every model with the list you pass.

```ts
users.setHidden(['password']).toJSON()
```

### setVisible()

Shows only the listed keys on every model.

```ts
users.setVisible(['id', 'name']).toJSON()
```

### toJSON()

Returns an array of serialized models, respecting each model's `hidden`, `visible`, and `appended` settings.

```ts
return users.toJSON()
```

### toQuery()

Builds a model query limited to the primary keys in the collection. It throws on an empty collection.

```ts
await drafts.toQuery().update({ status: 'archived' })
```

### withoutAppends()

Removes the appended attributes from every model in the collection.

```ts
users.withoutAppends().toJSON()
```

## Next steps

- [Querying models](/orm/querying)
- [Eager loading and aggregates](/orm/relationships/loading)
- [Serialization](/orm/serialization)
- [Chunking large results](/database/query-builder/chunking)
