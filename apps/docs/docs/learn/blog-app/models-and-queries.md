# Models and Queries

This chapter creates the blog models and the server-side query functions used by public pages and admin screens.

## What you will build

- `Category`, `Tag`, and `Post` models
- model relationships
- public query functions
- admin query functions
- create, update, and delete operations

## Files you will create

```txt
server/models/Category.ts
server/models/Tag.ts
server/models/Post.ts
server/lib/blog.ts
```

The finished example uses:

- `apps/blog-next/server/models/Category.ts`
- `apps/blog-next/server/models/Tag.ts`
- `apps/blog-next/server/models/Post.ts`
- `apps/blog-next/server/lib/blog.ts`

## Category model

```ts
import { defineModel, hasMany } from '@holo-js/db'

export default defineModel('categories', {
  fillable: ['name', 'slug', 'description'],
  relations: {
    posts: hasMany('Post', { foreignKey: 'category_id' }),
  },
})
```

## Tag model

```ts
import { belongsToMany, defineModel } from '@holo-js/db'

export default defineModel('tags', {
  fillable: ['name', 'slug'],
  relations: {
    posts: belongsToMany('Post', {
      pivotTable: 'post_tags',
      foreignPivotKey: 'tag_id',
      relatedPivotKey: 'post_id',
    }),
  },
})
```

## Post model

```ts
import { belongsTo, belongsToMany, defineModel, hasMany } from '@holo-js/db'

const relations = {
  user: belongsTo('User', { foreignKey: 'user_id' }),
  category: belongsTo('Category', { foreignKey: 'category_id' }),
  tags: belongsToMany('Tag', {
    pivotTable: 'post_tags',
    foreignPivotKey: 'post_id',
    relatedPivotKey: 'tag_id',
  }),
  comments: hasMany('Comment', { foreignKey: 'post_id' }),
}

export default defineModel('posts', {
  fillable: ['title', 'slug', 'excerpt', 'body', 'status', 'published_at', 'user_id', 'category_id'],
  relations,
})
```

## Public queries

Put user-facing reads in `server/lib/blog.ts`.

```ts
export async function getPublishedPosts() {
  return await Post
    .with('category', 'tags')
    .where('status', 'published')
    .orderBy('published_at', 'desc')
    .cache(60)
    .get()
}

export async function getPublishedPostBySlug(slug: string) {
  const post = await Post.firstWhere('slug', slug)
  if (!post || post.status !== 'published') {
    return undefined
  }

  return await post.load('category', 'tags')
}
```

## Admin queries

```ts
export async function getAdminPostsData() {
  const [posts, categories, tags] = await Promise.all([
    Post.with('category', 'tags').orderBy('created_at', 'desc').get(),
    Category.orderBy('name').get(),
    Tag.orderBy('name').get(),
  ])
  return { posts, categories, tags }
}
```

## Writes

Create and update posts inside a transaction, then sync tag relations.

```ts
export async function createPost(input: {
  title: string
  excerpt?: string
  body: string
  status: string
  categoryId?: string
  tagIds?: string
  authorId: number
}) {
  return await DB.transaction(async () => {
    const post = await Post.create({
      user_id: input.authorId,
      category_id: input.categoryId ? Number(input.categoryId) : null,
      title: input.title.trim(),
      slug: await uniqueSlug(Post, input.title),
      excerpt: input.excerpt?.trim() || null,
      body: input.body.trim(),
      status: input.status === 'draft' ? 'draft' : 'published',
      published_at: input.status === 'published' ? new Date() : null,
    })

    const tagIds = parseTagIds(input.tagIds || '')
    if (tagIds.length > 0) {
      await post.tags().attach(tagIds)
    }

    return post
  })
}
```

## Checkpoint

The app now has a typed data layer. The next chapter renders the public blog pages from these query functions.

## Related reference

- [ORM Getting Started](/orm/)
- [ORM Relationships](/orm/relationships)
- [Query Builder](/database/query-builder/)
- [Runtime API, Locks, and Query Caching](/cache/runtime-and-query-caching)
