# Relationships: Through & Polymorphic

This page covers through relations and the polymorphic family.

## When to use through relations

Use through relations when a model reaches another model through an intermediate model.

Examples:

- a mechanic reaches owners through cars
- a country reaches posts through users

## Through relations

```ts
const Mechanic = defineModel('mechanics', {
  relations: {
    carOwner: hasOneThrough(Owner, Car, {
      firstKey: 'mechanic_id',
      secondKey: 'car_id',
    }),
    serviceRecords: hasManyThrough(ServiceRecord, Car, {
      firstKey: 'mechanic_id',
      secondKey: 'car_id',
    }),
  },
})
```

Use `hasOneThrough` when the far side is singular. Use `hasManyThrough` when it is plural.

## When to use polymorphic relations

Use polymorphic relations when several model types share one relation target shape.

Examples:

- posts and videos both receive comments
- posts and products both receive SEO entries
- activities point at different subject types

## `morphOne` and `morphMany`

```ts
const Post = defineModel('posts', {
  relations: {
    seo: morphOne(() => SeoEntry, 'owner', 'owner_type', 'owner_id'),
    comments: morphMany(() => Comment, 'commentable', 'commentable_type', 'commentable_id'),
  },
})
```

The polymorphic columns live on the related table. Use the migration helpers that match the ID type of
the owning model:

```ts
await schema.createTable('comments', table => {
  table.id()
  table.morphs('commentable')
  table.text('body')
})

await schema.createTable('images', table => {
  table.id()
  table.uuidMorphs('imageable')
  table.string('path')
})

await schema.createTable('sessions', table => {
  table.id()
  table.ulidMorphs('sessionable')
})

await schema.createTable('audit_entries', table => {
  table.id()
  table.snowflakeMorphs('actor')
})
```

Use:

- `morphs(...)` for bigint IDs
- `uuidMorphs(...)` for UUID owners
- `ulidMorphs(...)` for ULID owners
- `snowflakeMorphs(...)` for Snowflake owners

The owner model and the polymorphic columns must agree on the ID type. If the owner uses
`HasUuids()`, pair it with `uuidMorphs(...)`. If the owner uses `HasUlids()` or `HasSnowflakes()`,
pair it with `ulidMorphs(...)` or `snowflakeMorphs(...)`.

## `morphTo`

```ts
const Activity = defineModel('activities', {
  relations: {
    subject: morphTo('subject', 'subject_type', 'subject_id'),
  },
})
```

Use `morphTo` on the inverse side when the current model stores the type/id pair.

## Polymorphic many-to-many

```ts
const Post = defineModel('posts', {
  relations: {
    tags: morphToMany(() => Tag, 'taggable', 'taggables', 'tag_id'),
  },
})
```

Use `morphToMany` on the parent-facing side of a polymorphic pivot table. Use `morphedByMany` on the
inverse side when the current model is the shared target.

## Morph loading

Polymorphic relations (`morphTo`) can point at different model types. When you need to load
nested relations on the morph target, you have two options:

### Using `load` with dot-paths

If every morph target needs the same nested relations, use dot-path syntax:

```ts
// Loads 'imageable' and then 'posts' on every target, regardless of type
const images = await Image.with('imageable.posts').get()
```

This works but loads `posts` on every target — even if some targets (like a Video) don't have
a `posts` relation, which would throw at runtime.

### Using `loadMorph` for type-specific loading

When different morph targets need different nested relations, use `loadMorph`:

```ts
const activities = await Activity.with('subject').get()

for (const activity of activities) {
  await activity.loadMorph('subject', {
    Post: query => query.with('author', 'tags'),
    Video: query => query.with('channel'),
    Comment: ['post', 'author'],
  })
}
```

Or on a collection:

```ts
await activities.loadMorph('subject', {
  Post: ['author', 'tags'],
  Video: ['channel'],
})
```

`loadMorph` groups entities by their actual morph type and batch-loads the type-specific
nested relations per group. This avoids N+1 queries and ensures each target type only loads
relations that exist on its model.

## Morph aliases

Use morph aliases where you want stable external identifiers rather than raw model names.
