# Relationships: Loading & Aggregates

This page covers eager loading, constrained loading, lazy loading rules, and relation aggregates.

## Eager loading

```ts
const users = await User.with('posts', 'profile').get()
```

Use eager loading when the response or workflow already knows it will need the related data.

## Nested eager loading

```ts
const posts = await Post.with('author.profile', 'comments.author').get()
```

Nested paths keep the route or service explicit about the data shape it needs.

## Constrained eager loading

```ts
const users = await User.with({
  posts: query => query.where('published', true).latest('created_at'),
}).get()
```

Use constrained eager loading when the relation should be present, but only under a narrower query shape.

## `withWhereHas`

```ts
const users = await User.withWhereHas('posts', query => {
  query.where('published', true)
}).get()
```

This is useful when the same relation rule should both filter parents and be eager-loaded in the result.

## Lazy loading and strictness

Loaded entities can resolve relations lazily, but strict runtime settings can prevent accidental lazy
loads when you want failures instead of hidden query behavior.

## Collection and entity loaders

Use loaders after retrieval when you already have the models in memory:

- `load(...)` — load one or more relations, supports dot-paths for nested loading
- `loadMissing(...)` — same as `load`, but skips relations already loaded on the entity
- `loadMorph(...)` — load different nested relations per morph target type
- `loadCount(...)`
- `loadExists(...)`
- `loadSum(...)`
- `loadAvg(...)`
- `loadMin(...)`
- `loadMax(...)`

## Morph loading with `loadMorph`

When a polymorphic relation (`morphTo`) can point at different model types, `load()` loads the
same nested relations for every target. `loadMorph` lets you load different nested relations
depending on the actual morph type:

```ts
const images = await Image.with('imageable').get()

await images.loadMorph('imageable', {
  User: ['profile', 'posts'],
  Post: ['comments', 'tags'],
})
```

After this call, images whose `imageable` is a User will have `profile` and `posts` loaded on
that User. Images whose `imageable` is a Post will have `comments` and `tags` loaded instead.

The mapping keys are morph class names (or morph aliases if configured). Each value can be:

- a string: `'posts'` — load a single relation
- an array: `['posts', 'profile']` — load multiple relations
- a constraint map: `{ posts: query => query.where('published', true) }` — load with filtering

`loadMorph` batches queries per morph type, so it avoids the N+1 problem. Without it, you would
need to manually check each entity's morph type and call `load()` individually.

### `loadMorph` vs `load` on polymorphic relations

| Call | What it does |
|---|---|
| `image.load('imageable')` | Loads the morph target (User or Post), no nested relations |
| `image.load('imageable.posts')` | Loads the morph target and `posts` on it, regardless of type |
| `image.loadMorph('imageable', { User: ['posts'], Post: ['comments'] })` | Loads the morph target and type-specific nested relations |

Use `load()` when every morph target needs the same nested data. Use `loadMorph` when different
target types need different nested relations.

## Relation aggregates

Use relation aggregates when the UI needs metadata but not the full related record set:

- `withCount(...)`
- `withExists(...)`
- `withSum(...)`
- `withAvg(...)`
- `withMin(...)`
- `withMax(...)`

## Existence helpers

Use relation existence helpers when parent selection depends on relation presence or relation conditions:

- `has(...)`
- `whereHas(...)`
- `doesntHave(...)`
- `whereRelation(...)`
- the matching `or*` variants

## Choosing the right tool

- eager load when the response already needs the relation payload
- aggregate when the response only needs counts or sums
- use existence helpers when the relation affects which parents qualify
