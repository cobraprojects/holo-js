# Scopes

Scopes give a reusable query a name. A local scope is a method you call on the model, like `Post.published()`. A global scope is a filter Holo adds to every query for the model.

```ts [server/models/Post.ts]
import { defineModel, type GeneratedSchemaTable, type ModelQueryBuilder } from '@holo-js/db'

type PostQuery = ModelQueryBuilder<GeneratedSchemaTable<'posts'>>

export default defineModel('posts', {
  scopes: {
    published: (query: PostQuery) => query.where('status', 'published'),
  },
})
```

```ts
const posts = await Post.published().latest().get()
```

## Local scopes

A scope is a function that receives a query and returns it with extra conditions. Each key in `scopes` becomes a method on the model.

Type the `query` parameter with `ModelQueryBuilder` and your table's generated type. This gives you column autocomplete inside the scope and a typed method on the model:

```ts [server/models/Post.ts]
import { defineModel, type GeneratedSchemaTable, type ModelQueryBuilder } from '@holo-js/db'

type PostQuery = ModelQueryBuilder<GeneratedSchemaTable<'posts'>>

export default defineModel('posts', {
  scopes: {
    published: (query: PostQuery) => query
      .where('status', 'published')
      .whereNotNull('published_at'),
    popular: (query: PostQuery) => query.where('views', '>', 1000),
  },
})
```

A scope call returns a normal model query, so you can keep chaining:

```ts
const posts = await Post.published()
  .where('category_id', categoryId)
  .orderBy('published_at', 'desc')
  .paginate(15)
```

Scopes are also methods on every query builder for the model, so they chain after other query methods, in either order:

```ts
const posts = await Post.query()
  .where('category_id', categoryId)
  .published()
  .get()

const popular = await Post.published().popular().get()
```

Inside relation callbacks, such as `whereHas('posts', query => query.published())` or `with('posts', query => query.published())`, the query is typed against the related model, so that model's scopes are available there too.

A scope name can't match a query builder method, such as `where` or `count`, or one of the builder's internal properties. Defining the model throws for such a name. See [Scope names](/getting-started/upgrading#scope-names-must-not-match-builder-methods).

### Scopes with parameters

Add parameters after `query`. They become the method's parameters, with the same types:

```ts [server/models/Post.ts]
import { defineModel, type GeneratedSchemaTable, type ModelQueryBuilder } from '@holo-js/db'

type PostQuery = ModelQueryBuilder<GeneratedSchemaTable<'posts'>>

export default defineModel('posts', {
  scopes: {
    byAuthor: (query: PostQuery, userId: number) => query.where('user_id', userId),
    publishedSince: (query: PostQuery, since: Date) => query
      .where('status', 'published')
      .where('published_at', '>=', since),
  },
})
```

```ts
await Post.byAuthor(user.id).get()
await Post.publishedSince(new Date('2026-01-01')).count()

Post.byAuthor('ada')
//            ^ TypeScript error: string is not assignable to number
```

### Scopes on models with relationships

When the model also defines `relations`, pull them into a constant and pass their type as the second type argument. Otherwise TypeScript can't match the scope to the model and the scope method won't be callable.

```ts [server/models/Post.ts]
import { belongsTo, defineModel, type GeneratedSchemaTable, type ModelQueryBuilder } from '@holo-js/db'

const relations = {
  author: belongsTo('User', { foreignKey: 'user_id' }),
}

type PostQuery = ModelQueryBuilder<GeneratedSchemaTable<'posts'>, typeof relations>

export default defineModel('posts', {
  relations,
  scopes: {
    published: (query: PostQuery) => query.where('status', 'published'),
  },
})
```

Now relationship methods work after the scope too:

```ts
const posts = await Post.published().with('author').get()
```

### Reusing scope logic

A scope's `query` parameter has the builder's methods, not the model's other scopes. Inside `recent` below, `query.published()` is a type error, even though it works at runtime. TypeScript doesn't know the sibling scopes while it types the object that defines them.

To share a constraint between scopes, move it into a plain function typed against the builder. Each scope calls that function:

```ts [server/models/Post.ts]
import { defineModel, type GeneratedSchemaTable, type ModelQueryBuilder } from '@holo-js/db'

type PostQuery = ModelQueryBuilder<GeneratedSchemaTable<'posts'>>

const whereLive = (query: PostQuery) => query
  .where('status', 'published')
  .whereNotNull('published_at')

export default defineModel('posts', {
  scopes: {
    published: (query: PostQuery) => whereLive(query),
    recent: (query: PostQuery) => whereLive(query).orderBy('published_at', 'desc'),
  },
})
```

## Global scopes

A global scope runs on every query for the model: `get()`, `first()`, `count()`, `paginate()`, and query-level `update()` and `delete()`. Use it for rules that should never be forgotten, like hiding unpublished content or filtering by tenant.

```ts [server/models/Post.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('posts', {
  globalScopes: {
    published: query => query.where('status', 'published'),
  },
})
```

```ts
await Post.all()
// only published posts
```

You don't need to annotate `query` in global scopes. Holo types it from the table.

Holo combines the caller's conditions, each global scope, and the soft-delete filter with `AND` between separate groups. An `orWhere()` in a caller query cannot bypass a tenant scope or include deleted rows. An `OR` inside one global scope cannot bypass another global scope.

The same grouping applies to eager-load constraints, `whereHas()` constraints, and writes. Instance `update()` and `delete()` retain the target row's primary-key condition even when a global scope contains `OR`.

Other scope settings, such as ordering and eager loading, remain part of the query.

### Skip global scopes

```ts
await Post.withoutGlobalScope('published').get()
await Post.withoutGlobalScopes(['published', 'tenant']).get()
await Post.withoutGlobalScopes().get()
```

`Post.newQueryWithoutScopes()` starts a query with no global scopes at all.

::: warning
`withoutGlobalScope()` and `withoutGlobalScopes()` start a fresh query. Any filters you added before them are dropped. Call them first:

```ts
await Post.withoutGlobalScope('published').where('user_id', userId).get()
```
:::

### Soft deletes

The hidden-trashed-rows behavior of [soft deletes](/orm/#soft-deletes) works like a built-in global scope. Control it with `withTrashed()` and `onlyTrashed()` instead. See [querying soft-deleted models](/orm/querying#soft-deleted-models).

## Next steps

- [Querying models](/orm/querying)
- [Eager loading and aggregates](/orm/relationships/loading)
- [Query builder filters](/database/query-builder/selects-and-filters)
