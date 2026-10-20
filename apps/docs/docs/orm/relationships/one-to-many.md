# One to Many

A one-to-many relationship links one parent to any number of children: a post has many comments, and each comment belongs to one post. Use `hasMany` on the parent and `belongsTo` on the child.

```ts [server/models/Post.ts]
import { defineModel, hasMany } from '@holo-js/db'

export default defineModel('posts', {
  relations: {
    comments: hasMany('Comment', { foreignKey: 'post_id' }),
  },
})
```

```ts [server/models/Comment.ts]
import { belongsTo, defineModel } from '@holo-js/db'

export default defineModel('comments', {
  relations: {
    post: belongsTo('Post', { foreignKey: 'post_id' }),
  },
})
```

```ts [server/lib/posts.ts]
import Post from '../models/Post'

const post = await Post.with('comments').findOrFail(1)

for (const comment of post.comments) {
  console.log(comment.body)
}
```

After `with('comments')`, `post.comments` is typed as an array of `Comment` models. It is an empty array when the post has no comments.

## Defining the relation

`hasMany(related, foreignKey, localKey?)` takes the related model, the key column on the *child* table, and the column on the parent it matches (default `id`):

```ts
comments: hasMany('Comment', { foreignKey: 'post_id' })

comments: hasMany('Comment', 'post_id')

comments: hasMany('Comment', { foreignKey: 'post_slug', localKey: 'slug' })
```

## The inverse: belongs to

The child side uses `belongsTo`. Load it the same way:

```ts
import Comment from '../models/Comment'

const comment = await Comment.with('post').findOrFail(10)

comment.post?.title
```

See [One to One](/orm/relationships/one-to-one#belongs-to) for `belongsTo` options and `associate()`.

## Constraining the children

Pass a callback to `with()` to filter or sort the loaded children:

```ts
const post = await Post
  .with('comments', query => query.where('status', 'approved').latest())
  .findOrFail(1)
```

For a subset you use often, define it once with [`scopeRelation()`](/orm/relationships/#scoped-relationships).

## Creating children

Call the relation as a method to get write helpers that fill in the foreign key for you:

```ts
const post = await Post.findOrFail(1)

const comment = await post.comments().create({ body: 'Great write-up!' })

const comments = await post.comments().createMany([
  { body: 'First!' },
  { body: 'Thanks for sharing.' },
])
```

To attach models you built yourself, use `save()` and `saveMany()`:

```ts
import Comment from '../models/Comment'

await post.comments().save(Comment.make({ body: 'Saved through the relation.' }))

await post.comments().saveMany([
  Comment.make({ body: 'One' }),
  Comment.make({ body: 'Two' }),
])
```

The parent must already exist in the database; Holo throws otherwise.

### Without model events

The entity methods `createRelatedQuietly`, `createManyRelatedQuietly`, `saveRelatedQuietly`, and `saveManyRelatedQuietly` do the same work without firing [model events](/orm/observers):

```ts
await post.createRelatedQuietly('comments', { body: 'Imported comment' })
```

## One of many

Sometimes you want a single child out of many: a user's latest post, or their highest order. These helpers define a to-one relation over a has-many table. They take the related model as a function.

```ts [server/models/User.ts]
import { defineModel, latestOfMany, oldestOfMany, ofMany } from '@holo-js/db'
import Order from './Order'
import Post from './Post'

export default defineModel('users', {
  relations: {
    latestPost: latestOfMany(() => Post, 'user_id'),
    firstPost: oldestOfMany(() => Post, 'user_id'),
    largestOrder: ofMany(() => Order, 'user_id', 'total', 'max'),
  },
})
```

```ts
const user = await User.with('latestPost', 'largestOrder').findOrFail(1)

user.latestPost?.title
user.largestOrder?.total
```

Each loads as a single model or `null`. The database picks the row, so a relation whose column is `NULL` for every related row loads `null`.

| Helper | Signature | Picks |
| --- | --- | --- |
| `latestOfMany` | `(related, foreignKey, localKey = 'id', column = 'id')` | Row with the highest `column` |
| `oldestOfMany` | `(related, foreignKey, localKey = 'id', column = 'id')` | Row with the lowest `column` |
| `ofMany` | `(related, foreignKey, aggregateColumn, aggregate = 'max', localKey = 'id')` | Row with the `'max'` or `'min'` of `aggregateColumn` |

To pick the latest by a column other than `id`, pass it as the fourth argument:

```ts
latestPublished: latestOfMany(() => Post, 'user_id', 'id', 'published_at')
```

One-of-many relations work with `has()`, `whereHas()`, `withCount()`, and the other relation methods.

## Next steps

- [Many to Many](/orm/relationships/many-to-many)
- [Eager Loading and Aggregates](/orm/relationships/loading)
- [Collections](/orm/collections)
