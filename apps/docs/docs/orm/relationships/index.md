# Relationships

Relationships describe how your models connect: a post belongs to a user, a user has many posts, a post has many tags. You declare them once in `defineModel()`, then load, filter, and write through them with full type inference.

```ts [server/models/Post.ts]
import { belongsTo, belongsToMany, defineModel, hasMany } from '@holo-js/db'

export default defineModel('posts', {
  relations: {
    author: belongsTo('User', { foreignKey: 'user_id' }),
    comments: hasMany('Comment', { foreignKey: 'post_id' }),
    tags: belongsToMany('Tag', {
      pivotTable: 'post_tags',
      foreignPivotKey: 'post_id',
      relatedPivotKey: 'tag_id',
    }),
  },
})
```

```ts [server/lib/posts.ts]
import Post from '../models/Post'

const post = await Post.with('author', 'tags').findOrFail(1)

post.author?.name
post.tags.map(tag => tag.name)
```

`post.author` is typed as the `User` model (or `null`), and `post.tags` as an array of `Tag` models. Relation names passed to `with()` autocomplete, and a typo is a compile error.

## Available methods

Each method is described in the [method reference](#method-reference) at the bottom of this page. Eager loading and relation filters are on the [querying page](/orm/querying#available-methods).

**Define relations:** [belongsTo()](#belongsto), [hasOne()](#hasone), [hasMany()](#hasmany), [belongsToMany()](#belongstomany), [hasOneThrough()](#hasonethrough), [hasManyThrough()](#hasmanythrough), [morphTo()](#morphto), [morphOne()](#morphone), [morphMany()](#morphmany), [morphToMany()](#morphtomany), [morphedByMany()](#morphedbymany), [morphOfMany()](#morphofmany), [latestMorphOne()](#latestmorphone), [oldestMorphOne()](#oldestmorphone), [ofMany()](#ofmany), [latestOfMany()](#latestofmany), [oldestOfMany()](#oldestofmany), [scopeRelation()](#scoperelation)

**Pivot options** (many-to-many relations): [withPivot()](#withpivot), [withTimestamps()](#withtimestamps), [wherePivot()](#wherepivot), [orderByPivot()](#orderbypivot), [as()](#as), [using()](#using)

**Create and save related models:** [create()](#create), [createMany()](#createmany), [save()](#save), [saveMany()](#savemany), [createRelated()](#createrelated), [createManyRelated()](#createmanyrelated), [createRelatedQuietly()](#createrelatedquietly), [createManyRelatedQuietly()](#createmanyrelatedquietly), [saveRelated()](#saverelated), [saveManyRelated()](#savemanyrelated), [saveRelatedQuietly()](#saverelatedquietly), [saveManyRelatedQuietly()](#savemanyrelatedquietly)

**Link belongs-to relations:** [associate()](/orm/writes#associate), [dissociate()](/orm/writes#dissociate)

**Attach many-to-many records:** [attach()](#attach), [detach()](#detach), [sync()](#sync), [syncWithoutDetaching()](#syncwithoutdetaching), [toggle()](#toggle), [updateExistingPivot()](#updateexistingpivot)

**Access a relation:** [relation()](#relation), [resolveRelationUsing()](#resolverelationusing)

**Load and filter:** [load()](/orm/relationships/loading), [loadMissing()](/orm/relationships/loading), [loadMorph()](/orm/relationships/loading#polymorphic-loading), [loadCount()](/orm/relationships/loading), [withCount()](/orm/relationships/loading), [has()](/orm/querying#has), [whereHas()](/orm/querying#wherehas), [whereBelongsTo()](/orm/querying#wherebelongsto), [whereMorphedTo()](/orm/querying#wheremorphedto)

## Relationship types

| Function | Use it when | Page |
| --- | --- | --- |
| `belongsTo` | This table holds the foreign key (`posts.user_id`) | [One to One](/orm/relationships/one-to-one) |
| `hasOne` | The other table holds the key, one row per parent | [One to One](/orm/relationships/one-to-one) |
| `hasMany` | The other table holds the key, many rows per parent | [One to Many](/orm/relationships/one-to-many) |
| `latestOfMany`, `oldestOfMany`, `ofMany` | Pick one row out of a has-many | [One to Many](/orm/relationships/one-to-many#one-of-many) |
| `belongsToMany` | Both sides connect through a pivot table | [Many to Many](/orm/relationships/many-to-many) |
| `hasOneThrough`, `hasManyThrough` | Reach a model through an intermediate model | [Through and Polymorphic](/orm/relationships/through-and-polymorphic) |
| `morphTo`, `morphOne`, `morphMany`, `morphToMany`, `morphedByMany` | One table relates to several model types | [Through and Polymorphic](/orm/relationships/through-and-polymorphic#polymorphic-relationships) |

All of these are exported from `@holo-js/db`.

## Pointing at the related model

You can name the related model in two ways.

**By model name (string).** `belongsTo`, `hasOne`, `hasMany`, and `belongsToMany` accept the model's name, such as `'User'`. This avoids circular imports between model files, and you still get autocomplete because `holo prepare` registers your models' types.

```ts
author: belongsTo('User', { foreignKey: 'user_id' })
```

**By function.** Every relation function accepts `() => Model`. Through and polymorphic relations (`morphMany`, `hasManyThrough`, and friends) and the one-of-many helpers *only* accept this form.

```ts
import User from './User'

author: belongsTo(() => User, 'user_id')
```

The function runs lazily, so two model files can import each other without problems.

### How model names are chosen

The model name comes from the table name: it is singularized and converted to PascalCase.

| Table | Model name |
| --- | --- |
| `users` | `User` |
| `blog_posts` | `BlogPost` |
| `people` | `Person` |

Set `name` in `defineModel()` if you want something else, and use that name in relations:

```ts [server/models/LegacyPerson.ts]
import { defineModel } from '@holo-js/db'

export default defineModel('tbl_legacy_people', {
  name: 'LegacyPerson',
})
```

::: warning Foreign keys are always explicit
Holo does not guess foreign key names. Every `belongsTo`, `hasOne`, `hasMany`, and `belongsToMany` call needs its key columns, either as positional arguments or in an options object. Keys that point at the other model's primary key default to `id`.
:::

## Querying by relationship

Filter parent models by whether a relation exists, or by conditions on the related rows. Relation names autocomplete in every one of these methods.

```ts
const withComments = await Post.has('comments').get()

const withoutComments = await Post.doesntHave('comments').get()

const discussed = await Post
  .whereHas('comments', query => query.where('status', 'approved'))
  .get()

const quiet = await Post
  .whereDoesntHave('comments', query => query.where('status', 'approved'))
  .get()
```

`whereRelation()` is a shortcut for a single condition. The column name autocompletes against the related model's columns:

```ts
const byMohamed = await Post.whereRelation('author', 'name', 'Mohamed').get()

const popular = await Post.whereRelation('comments', 'likes', '>', 10).get()
```

Each method has an `or` variant: `orHas`, `orDoesntHave`, `orWhereHas`, `orWhereDoesntHave`, `orWhereRelation`.

Relation paths can be nested with dots:

```ts
const posts = await Post.has('comments.author').get()
```

### Filtering by a parent model

`whereBelongsTo()` takes a model instance and finds rows that belong to it through a `belongsTo` relation:

```ts
const user = await User.findOrFail(1)

const posts = await Post.whereBelongsTo(user).get()
```

If the model has more than one `belongsTo` pointing at the same model (for example `author` and `editor`), pass the relation name:

```ts
const edited = await Post.whereBelongsTo(user, 'editor').get()
```

## Scoped relationships

`scopeRelation()` wraps a relation with a permanent constraint. Use it for named subsets you load often:

```ts [server/models/User.ts]
import { defineModel, hasMany, scopeRelation } from '@holo-js/db'

export default defineModel('users', {
  relations: {
    posts: hasMany('Post', { foreignKey: 'user_id' }),
    publishedPosts: scopeRelation(
      hasMany('Post', { foreignKey: 'user_id' }),
      query => query.where('status', 'published'),
    ),
  },
})
```

`publishedPosts` works everywhere a relation does: `with()`, `has()`, `withCount()`, and so on.

::: tip Return the query from constraint callbacks
Query builders are immutable: `query.where(...)` returns a new builder. Always return it from your callback (`query => query.where(...)`). A callback with a block body that doesn't return anything applies no constraint.
:::

## Adding relations at runtime

`resolveRelationUsing()` adds a relation to an existing model. This is useful in plugins or packages that can't edit your model file:

```ts
import { hasMany, scopeRelation } from '@holo-js/db'
import Post from '../models/Post'
import User from '../models/User'

User.resolveRelationUsing('drafts', () => scopeRelation(
  hasMany(() => Post, 'user_id'),
  query => query.where('status', 'draft'),
))
```

Relations added this way work at runtime in `with()`, `has()`, and the other relation methods, but they aren't part of the model's TypeScript type. Prefer declaring relations in `defineModel()` when you can.

## Touching parent timestamps

List `belongsTo` (or `morphTo`) relations in `touches` to update the parent's `updated_at` whenever the child is saved:

```ts [server/models/Comment.ts]
import { belongsTo, defineModel } from '@holo-js/db'

export default defineModel('comments', {
  relations: {
    post: belongsTo('Post', { foreignKey: 'post_id' }),
  },
  touches: ['post'],
})
```

Saving a comment now bumps `posts.updated_at`. Holo throws at definition time if a touched name isn't a `belongsTo` or `morphTo` relation.

## Method reference

### belongsTo()

Declares that this table stores the foreign key. Pass the related model and the foreign key column, or an options object with `ownerKey` (default `id`).

```ts
author: belongsTo('User', { foreignKey: 'user_id' })
```

See [one to one](/orm/relationships/one-to-one#belongs-to).

### hasOne()

Declares that the related table stores a key pointing back at this model. Returns at most one related model.

```ts
profile: hasOne('Profile', { foreignKey: 'user_id' })
```

See [one to one](/orm/relationships/one-to-one#has-one).

### hasMany()

Declares that the related table stores a key pointing back at this model. Returns a list of related models.

```ts
comments: hasMany('Comment', { foreignKey: 'post_id' })
```

See [one to many](/orm/relationships/one-to-many#defining-the-relation).

### belongsToMany()

Declares a many-to-many relation through a pivot table. Pass the pivot table and both key columns, or an options object.

```ts
tags: belongsToMany('Tag', {
  pivotTable: 'post_tags',
  foreignPivotKey: 'post_id',
  relatedPivotKey: 'tag_id',
})
```

Chain [pivot options](#withpivot) after it to read or filter pivot columns. See [many to many](/orm/relationships/many-to-many).

### hasOneThrough()

Reaches one related model through an intermediate model. Pass the related model, the through model, the key on the through table, and the key on the related table.

```ts
carOwner: hasOneThrough(() => Owner, () => Car, 'mechanic_id', 'car_id')
```

See [through relationships](/orm/relationships/through-and-polymorphic#has-one-through).

### hasManyThrough()

Reaches many related models through an intermediate model. It takes the same arguments as `hasOneThrough()`.

```ts
posts: hasManyThrough(() => Post, () => User, 'country_id', 'user_id')
```

See [through relationships](/orm/relationships/through-and-polymorphic#has-many-through).

### morphTo()

Declares the inverse side of a polymorphic relation. The table stores a type column and an id column. The defaults are `{name}_type` and `{name}_id`.

```ts
imageable: morphTo('imageable')
```

See [polymorphic relationships](/orm/relationships/through-and-polymorphic#polymorphic-relationships).

### morphOne()

Declares a one-to-one polymorphic relation from the parent side. Pass the related model and the morph name.

```ts
avatar: morphOne(() => Image, 'imageable')
```

### morphMany()

Declares a one-to-many polymorphic relation from the parent side.

```ts
images: morphMany(() => Image, 'imageable')
```

### morphToMany()

Declares a many-to-many polymorphic relation from the model that owns the morph. It takes the related model, the morph name, the pivot table, and the pivot key.

```ts
tags: morphToMany(() => Tag, 'taggable', 'taggables', 'tag_id')
```

See [many to many polymorphic](/orm/relationships/through-and-polymorphic#many-to-many).

### morphedByMany()

The inverse of `morphToMany()`, declared on the related side of the same pivot table.

```ts
posts: morphedByMany(() => Post, 'taggable', 'taggables', 'tag_id')
```

### morphOfMany()

Picks one row from a `morphMany` by the largest or smallest value of a column. The fourth argument is `'max'` (default) or `'min'`.

```ts
largestImage: morphOfMany(() => Image, 'imageable', 'size', 'max')
```

### latestMorphOne()

Picks the most recent row of a `morphMany` by a column, which defaults to `id`.

```ts
latestImage: latestMorphOne(() => Image, 'imageable')
```

### oldestMorphOne()

Picks the earliest row of a `morphMany` by a column, which defaults to `id`.

```ts
firstImage: oldestMorphOne(() => Image, 'imageable')
```

### ofMany()

Picks one row from a `hasMany` by the largest or smallest value of a column. The fourth argument is `'max'` (default) or `'min'`.

```ts
largestOrder: ofMany(() => Order, 'user_id', 'total', 'max')
```

### latestOfMany()

Picks the most recent row of a `hasMany` by a column, which defaults to `id`.

```ts
latestPost: latestOfMany(() => Post, 'user_id', 'id', 'published_at')
```

### oldestOfMany()

Picks the earliest row of a `hasMany` by a column, which defaults to `id`.

```ts
firstPost: oldestOfMany(() => Post, 'user_id')
```

### scopeRelation()

Wraps a relation with a permanent constraint. The constraint callback must return the query.

```ts
publishedPosts: scopeRelation(
  hasMany('Post', { foreignKey: 'user_id' }),
  query => query.where('status', 'published'),
)
```

See [scoped relationships](#scoped-relationships).

### withPivot()

Adds pivot columns to the results. Each model's pivot data appears on `pivot`, or under the name set with `as()`.

```ts
tags: belongsToMany('Tag', { pivotTable: 'post_tags', foreignPivotKey: 'post_id', relatedPivotKey: 'tag_id' })
  .withPivot('role')
```

### withTimestamps()

Adds the pivot's `created_at` and `updated_at` columns to the results, and fills them on writes.

```ts
tags: belongsToMany('Tag', { pivotTable: 'post_tags', foreignPivotKey: 'post_id', relatedPivotKey: 'tag_id' })
  .withTimestamps()
```

### wherePivot()

Filters the relation by a pivot column. With two arguments, the operator is `=`. Call it on the definition, not on a model.

```ts
featuredTags: belongsToMany('Tag', { pivotTable: 'post_tags', foreignPivotKey: 'post_id', relatedPivotKey: 'tag_id' })
  .wherePivot('featured', true)
```

### orderByPivot()

Sorts the related models by a pivot column.

```ts
tags: belongsToMany('Tag', { pivotTable: 'post_tags', foreignPivotKey: 'post_id', relatedPivotKey: 'tag_id' })
  .orderByPivot('position', 'asc')
```

### as()

Renames the pivot property on each related model. The default is `pivot`.

```ts
roles: belongsToMany('Role', { pivotTable: 'role_user', foreignPivotKey: 'user_id', relatedPivotKey: 'role_id' })
  .as('membership')
```

### using()

Turns each pivot row into an instance of a model you define, so [casts](/orm/casts) and model methods apply.

```ts
members: belongsToMany('User', { pivotTable: 'team_members', foreignPivotKey: 'team_id', relatedPivotKey: 'user_id' })
  .using(() => TeamMember)
```

### create()

Creates a related model and links it. On a `hasOne` or `hasMany` relation, the key is set for you. On a `belongsToMany`, the new model is attached.

```ts
const comment = await post.comments().create({ body: 'Nice' })
```

### createMany()

Creates several related models in order. It's available on `hasMany` relations.

```ts
await post.comments().createMany([{ body: 'First' }, { body: 'Second' }])
```

### save()

Saves an existing model and links it to the parent. On a `belongsToMany`, the model is attached.

```ts
await post.comments().save(comment)
```

### saveMany()

Saves several existing models and links them. It's available on `hasMany` relations.

```ts
await post.comments().saveMany([first, second])
```

### createRelated()

Creates a related model by relation name. It's the same as `post.comments().create(...)`.

```ts
await post.createRelated('comments', { body: 'Nice' })
```

### createManyRelated()

Creates several related models by relation name.

```ts
await post.createManyRelated('comments', [{ body: 'First' }, { body: 'Second' }])
```

### createRelatedQuietly()

Like `createRelated()`, but no model events or observers run.

```ts
await post.createRelatedQuietly('comments', { body: 'Imported' })
```

### createManyRelatedQuietly()

Like `createManyRelated()`, but no model events or observers run.

```ts
await post.createManyRelatedQuietly('comments', rows)
```

### saveRelated()

Saves an existing model and links it, by relation name.

```ts
await post.saveRelated('comments', comment)
```

### saveManyRelated()

Saves several existing models and links them, by relation name.

```ts
await post.saveManyRelated('comments', [first, second])
```

### saveRelatedQuietly()

Like `saveRelated()`, but no model events or observers run.

```ts
await post.saveRelatedQuietly('comments', comment)
```

### saveManyRelatedQuietly()

Like `saveManyRelated()`, but no model events or observers run.

```ts
await post.saveManyRelatedQuietly('comments', [first, second])
```

### attach()

Attaches many-to-many records. Pass one id, an array of ids, or an object that maps ids to pivot values. Existing links are not changed.

```ts
await post.tags().attach([1, 2], { featured: true })
await post.attach('tags', { 3: { featured: false } })
```

See [attaching and detaching](/orm/relationships/many-to-many#attaching-and-detaching).

### detach()

Removes many-to-many links. Pass ids to remove some, or no argument to remove all. It returns how many links were removed.

```ts
const removed = await post.tags().detach([1, 2])
```

### sync()

Makes the linked ids match the list you pass. It attaches missing ids, detaches the rest, and updates pivot values for ids that are already linked.

```ts
const { attached, detached, updated } = await post.tags().sync([1, 2, 3])
```

See [syncing](/orm/relationships/many-to-many#syncing).

### syncWithoutDetaching()

Like `sync()`, but it never detaches. It attaches missing ids and updates pivot values for linked ids.

```ts
await post.syncWithoutDetaching('tags', [4])
```

### toggle()

Attaches each id that isn't linked yet, and detaches each id that is.

```ts
const { attached, detached } = await post.tags().toggle([1, 2])
```

See [toggling](/orm/relationships/many-to-many#toggling).

### updateExistingPivot()

Updates the pivot columns of one existing link. It returns the number of rows changed.

```ts
await post.tags().updateExistingPivot(1, { featured: true })
```

See [updating a pivot row](/orm/relationships/many-to-many#updating-a-pivot-row).

### relation()

Returns the relation methods for a named relation, such as `create()` or `attach()`. Use it when the relation name is a variable. Each relation also has a method with its own name, such as `post.tags()`.

```ts
const tags = post.relation('tags')
await tags.attach([1, 2])
```

### resolveRelationUsing()

Adds a relation to a model at runtime. The relation works in `with()` and the other relation methods, but it isn't in the model's TypeScript type.

```ts
User.resolveRelationUsing('drafts', () => hasMany(() => Post, 'user_id'))
```

See [adding relations at runtime](#adding-relations-at-runtime).

## Next steps

- [One to One](/orm/relationships/one-to-one)
- [One to Many](/orm/relationships/one-to-many)
- [Many to Many](/orm/relationships/many-to-many)
- [Eager Loading and Aggregates](/orm/relationships/loading)
- [Defining Models](/orm/)
