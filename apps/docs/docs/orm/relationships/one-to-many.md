# Relationships: One to Many

One-to-many is the right fit when one parent owns many children, and each child points back to one parent.

## `hasMany`

Use `hasMany` on the parent-facing side.

```ts
const User = defineModel('users', {
  relations: {
    posts: hasMany(Post, {
      foreignKey: 'user_id',
    }),
  },
})
```

### Load children

```ts
const users = await User.with('posts').get()
```

### Filter parents by child conditions

```ts
const users = await User.whereHas('posts', query => {
  query.where('published', true)
}).get()
```

### Save many related models

```ts
await user.posts().createManyRelated([
  { title: 'First post' },
  { title: 'Second post' },
])
```

### Relation queries

```ts
const posts = await user.posts()
  .latest('created_at')
  .get()
```

### Count and aggregate children

```ts
const users = await User.withCount('posts').withSum('posts', 'views').get()
```

## `belongsTo`

Use `belongsTo` on the child-facing side when the child table stores the foreign key.

```ts
const Post = defineModel('posts', {
  relations: {
    author: belongsTo(User, {
      foreignKey: 'user_id',
    }),
  },
})
```

### Access the parent

```ts
const post = await Post.findOrFail(1)
const author = await post.author
```

### Constrain by the parent

```ts
const posts = await Post.whereBelongsTo(user, 'author').get()
```

## Common patterns

- use `hasMany` when the parent owns a collection of children
- use `belongsTo` on the child that stores the foreign key
- reach for `withCount(...)` when you need metadata instead of the full relation payload
