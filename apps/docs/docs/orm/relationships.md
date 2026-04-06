# ORM: Relationships

Relationships are where the ORM starts carrying real domain structure instead of just returning rows.
They are named, eager-loadable, queryable by existence, and writable through entity helpers.

## Introduction

Keep the schema responsible for columns and keys, then use the model to describe the domain graph:

```ts
const User = defineModel('users', {
  relations: {
    profile: hasOne(Profile, { foreignKey: 'user_id' }),
    posts: hasMany(Post, { foreignKey: 'user_id' }),
    roles: belongsToMany(Role, {
      pivotTable: 'role_user',
      foreignPivotKey: 'user_id',
      relatedPivotKey: 'role_id',
    }),
  },
})
```

When the foreign key lives on the current model, use `belongsTo`. When the foreign key lives on the other
model, use `hasOne` or `hasMany`. When neither side can own the association directly, use a pivot table
and `belongsToMany`.

## Defining Relationships

### One to One / Has One

- [One to One](/orm/relationships/one-to-one)

### One to Many / Has Many

- [One to Many](/orm/relationships/one-to-many)

### One to Many (Inverse) / Belongs To

The inverse side of one-to-one and one-to-many relationships lives on `belongsTo`.

### Has One Through / Has Many Through

- [Through & Polymorphic](/orm/relationships/through-and-polymorphic)

## Scoped Relationships

Relations can be wrapped with reusable constraints so eager loading and existence queries share the same
shape.

Use scoped relationships when one relation almost always needs the same filter or ordering rule and you do
not want that rule copied into every route.

## Many to Many Relationships

- [Many to Many](/orm/relationships/many-to-many)

### Retrieving Intermediate Table Columns

Pivot updates and pivot attributes are managed through relation helpers such as `attach(...)`,
`updateExistingPivot(...)`, and `sync(...)`.

Use pivot attributes when the association itself carries state, such as expiration, labeling, or approval
metadata.

### Filtering Queries via Intermediate Table Columns

Pivot-specific filtering is currently expressed through relation workflows and pivot mutation APIs instead
of a separate pivot-filter chapter.

### Ordering Queries via Intermediate Table Columns

Ordering is currently described through the relation query builder surface rather than a dedicated pivot
ordering chapter.

### Defining Custom Intermediate Table Models

Custom pivot-model semantics are intentionally conservative. Unsupported pivot-model features fail closed
instead of being guessed.

## Polymorphic Relationships

- [Through & Polymorphic](/orm/relationships/through-and-polymorphic)

## Querying Relations

```ts
const users = await User
  .has('posts')
  .whereHas('posts', query => query.where('published', true))
  .whereDoesntHave('profile')
  .get()
```

There are matching `or*` helpers, plus `whereRelation(...)`, `whereMorphRelation(...)`, and
`withWhereHas(...)` for the common "filter and eager load the same relation" workflow.

Use relation queries when the business rule is about parent-child existence or parent-child conditions, not
just one flat joined result.

## Aggregating Related Models

- [Loading & Aggregates](/orm/relationships/loading-and-aggregates)

## Eager Loading

Start by loading the graph you know the request needs:

```ts
const users = await User
  .with('profile', 'roles')
  .withCount('posts')
  .withExists('profile')
  .get()
```

When the graph depends on runtime decisions, load it later:

```ts
const user = await User.findOrFail(1)

await user.load('profile', 'roles')
await user.loadCount('posts')
```

When a polymorphic relation points at different model types and each type needs different
nested relations, use `loadMorph`:

```ts
await user.loadMorph('activity.subject', {
  Post: query => query.with('author'),
  Comment: query => query.with('post'),
})
```

See [Morph loading](/orm/relationships/through-and-polymorphic#morph-loading) for details on
when to use `loadMorph` vs `load` on polymorphic relations.

Use `loadMissing(...)` when you only want to fill gaps and leave already-loaded relations alone.

Use eager loading when the response already knows it needs the relation graph. That keeps query behavior
explicit and avoids accidental lazy loading later.

## Inserting and Updating Related Models

Relations are a first-class persistence surface:

```ts
const user = await User.findOrFail(1)

await user.posts().createRelated({
  title: 'Shipping Notes',
  slug: 'shipping-notes',
})

await user.roles().sync([1, 2, 3])
```

The exact write helper depends on the relation family:

- `associate(...)` / `dissociate(...)` for `belongsTo`
- `saveRelated(...)`, `createRelated(...)`, and `createManyRelated(...)` for one-to-one and one-to-many
- `attach(...)`, `detach(...)`, `sync(...)`, `toggle(...)`, and `updateExistingPivot(...)` for pivot relations

Use relation-aware writes when the current model instance is already the natural starting point for the
workflow.

## Touching Parent Timestamps

Use `touches` on parent-facing relations when saving a child should update the parent timestamp.

This is useful when parent freshness depends on child changes, such as `Post` updates refreshing `User`
activity timestamps.

## Inverse Relation Rules

Inverse resolution is explicit when a model can reach the same target more than once:

```ts
const Invoice = defineModel('invoices', {
  relations: {
    billingAddress: belongsTo(Address, { foreignKey: 'billing_address_id' }),
    shippingAddress: belongsTo(Address, { foreignKey: 'shipping_address_id' }),
  },
})
```

In that shape, helpers like `whereBelongsTo(...)` should be given the relation name so the ORM chooses
the correct foreign-key path.

## Continue Reading

- [One to One](/orm/relationships/one-to-one)
- [One to Many](/orm/relationships/one-to-many)
- [Many to Many](/orm/relationships/many-to-many)
- [Through & Polymorphic](/orm/relationships/through-and-polymorphic)
- [Loading & Aggregates](/orm/relationships/loading-and-aggregates)
