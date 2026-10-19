# 3. Models and Queries

In this chapter you turn the tables into models, connect them with relationships, add sample data, and write the queries the public pages will use.

## What you'll build

- `Category`, `Tag`, and `Post` models with relationships
- a `posts` relationship on the existing `User` model
- a seeder that adds an author, two categories, three tags, and two posts
- a `blog.ts` file with the blog's read queries

## Step 1: Fill in the Category model

`make:model` already created `server/models/Category.ts`. Replace its contents:

```ts [server/models/Category.ts]
import { defineModel, hasMany } from '@holo-js/db'

export default defineModel('categories', {
  fillable: ['name', 'slug', 'description'],
  relations: {
    posts: hasMany('Post', { foreignKey: 'category_id' }),
  },
})
```

- `defineModel('categories', ...)` ties the model to the `categories` table. Holo reads the columns from your migrations, so `category.name` and `category.slug` are typed without extra work.
- `fillable` lists the columns you can set with `create()` and `update()`. Passing any other column throws an error, which protects you from users setting fields they shouldn't.
- `hasMany('Post', ...)` says a category has many posts, linked by `posts.category_id`.

## Step 2: Fill in the Tag model

```ts [server/models/Tag.ts]
import { belongsToMany, defineModel } from '@holo-js/db'

export default defineModel('tags', {
  fillable: ['name', 'slug'],
  relations: {
    posts: belongsToMany('Post', {
      pivotTable: 'post_tags',
      foreignPivotKey: 'tag_id',
      relatedPivotKey: 'post_id',
    }).withPivot('is_primary').withTimestamps(),
  },
})
```

`belongsToMany` is a many-to-many relationship through the `post_tags` table. `withPivot('is_primary')` loads the extra column, and `withTimestamps()` fills `created_at` and `updated_at` on the link rows.

## Step 3: Fill in the Post model

```ts [server/models/Post.ts]
import { belongsTo, belongsToMany, defineModel } from '@holo-js/db'

export default defineModel('posts', {
  fillable: ['title', 'slug', 'excerpt', 'body', 'status', 'published_at', 'user_id', 'category_id'],
  relations: {
    user: belongsTo('User', { foreignKey: 'user_id' }),
    category: belongsTo('Category', { foreignKey: 'category_id' }),
    tags: belongsToMany('Tag', {
      pivotTable: 'post_tags',
      foreignPivotKey: 'post_id',
      relatedPivotKey: 'tag_id',
    }).withPivot('is_primary').withTimestamps(),
  },
})
```

A post belongs to one author and one category, and has many tags.

## Step 4: Add posts to the User model

Open the `User` model the creator made and add a `posts` relationship:

```ts [server/models/User.ts]
import { defineModel, hasMany } from '@holo-js/db'

export default defineModel('users', {
  fillable: ['name', 'email', 'password', 'avatar'],
  hidden: ['password'],
  relations: {
    posts: hasMany('Post', { foreignKey: 'user_id' }),
  },
})
```

`hidden: ['password']` keeps the password hash out of JSON output, so it never reaches the browser.

## Step 5: Add sample data with a seeder

Create a seeder:

```bash
npx holo make:seeder BlogSeeder
```

Replace the generated file:

```ts [server/db/seeders/BlogSeeder.ts]
import { hashPassword } from '@holo-js/auth'
import { defineSeeder } from '@holo-js/db'

import Category from '../../models/Category'
import Post from '../../models/Post'
import Tag from '../../models/Tag'
import User from '../../models/User'

export default defineSeeder({
  name: 'BlogSeeder',
  async run() {
    const timestamp = new Date('2026-04-26T09:00:00.000Z')
    const password = await hashPassword('secret-secret')

    const author = await User.unguarded(() =>
      User.create({
        name: 'Holo Editor',
        email: 'editor@example.com',
        password,
        avatar: null,
        email_verified_at: timestamp,
      }),
    )

    const engineering = await Category.create({
      name: 'Engineering',
      slug: 'engineering',
      description: 'Architecture notes, patterns, and release updates.',
    })

    const product = await Category.create({
      name: 'Product',
      slug: 'product',
      description: 'Roadmaps, launches, and product writing.',
    })

    const frameworkTag = await Tag.create({ name: 'framework', slug: 'framework' })
    const releaseTag = await Tag.create({ name: 'release', slug: 'release' })
    const guideTag = await Tag.create({ name: 'guide', slug: 'guide' })

    const launchPost = await Post.create({
      user_id: author.id,
      category_id: engineering.id,
      title: 'Shipping a Real Holo Blog',
      slug: 'shipping-a-real-holo-blog',
      status: 'published',
      excerpt: 'A walkthrough of building a blog on top of Holo.',
      body: 'This post was created by the blog seeder.',
      published_at: timestamp,
    })

    await launchPost.tags().sync({
      [frameworkTag.id]: { is_primary: true },
      [guideTag.id]: { is_primary: false },
    })

    const roadmapPost = await Post.create({
      user_id: author.id,
      category_id: product.id,
      title: 'Designing the Blog Roadmap',
      slug: 'designing-the-blog-roadmap',
      status: 'published',
      excerpt: 'How we plan what to build next.',
      body: 'Start with the shared requirements, then build one slice at a time.',
      published_at: new Date('2026-04-24T14:30:00.000Z'),
    })

    await roadmapPost.tags().sync({
      [frameworkTag.id]: { is_primary: true },
      [releaseTag.id]: { is_primary: false },
    })
  },
})
```

Some notes:

- `hashPassword()` hashes the password the same way sign-in checks it. You'll sign in as `editor@example.com` / `secret-secret` in [chapter 7](/tutorial/auth).
- `User.unguarded()` lets the seeder set `email_verified_at`, which isn't in the `fillable` list.
- `post.tags().sync({...})` sets the post's tags and the `is_primary` value for each link.

Run it:

```bash
npx holo seed
```

## Step 6: Write the read queries

Put the blog's queries in one file. Pages will call these functions instead of building queries themselves.

Start with the imports. Only the paths differ per framework:

::: code-group

```ts [Next.js]
// server/lib/blog.ts
import Category from '../models/Category'
import Post from '../models/Post'
import Tag from '../models/Tag'
```

```ts [Nuxt]
// server/lib/blog.ts
import Category from '../models/Category'
import Post from '../models/Post'
import Tag from '../models/Tag'
```

```ts [SvelteKit]
// src/lib/server/blog.ts
import Category from '../../../server/models/Category'
import Post from '../../../server/models/Post'
import Tag from '../../../server/models/Tag'
```

:::

In SvelteKit, the `src/lib/server/` folder keeps this file out of browser code, and you can import it as `$lib/server/blog`.

Then add the queries below the imports. This part is the same in every framework:

```ts
const BLOG_QUERY_CACHE_SECONDS = 60
const BLOG_FLEXIBLE_CACHE_SECONDS = [60, 300] as const

export async function getPublishedPosts() {
  return await Post
    .with('category', 'tags')
    .where('status', 'published')
    .orderBy('published_at', 'desc')
    .cache(BLOG_QUERY_CACHE_SECONDS)
    .get()
}

export async function getNavigationCategories() {
  return await Category
    .orderBy('name')
    .cache({ flexible: BLOG_FLEXIBLE_CACHE_SECONDS })
    .get()
}

export async function getHomePageData() {
  const [posts, categories, tags] = await Promise.all([
    getPublishedPosts(),
    getNavigationCategories(),
    Tag.orderBy('name').get(),
  ])

  return {
    posts,
    featured: posts[0] ?? null,
    categories,
    tags,
  }
}

export async function getPublishedPostBySlug(slug: string) {
  const post = await Post.firstWhere('slug', slug)
  if (!post || post.status !== 'published') {
    return undefined
  }

  return await post.load('category', 'tags')
}

export async function getCategoryArchive(slug: string) {
  const category = await Category.where('slug', slug).first()
  if (!category) return null

  const posts = await Post
    .with('category', 'tags')
    .where('category_id', category.id)
    .where('status', 'published')
    .orderBy('published_at', 'desc')
    .get()

  return { category, posts }
}

export async function getTagArchive(slug: string) {
  const tag = await Tag.where('slug', slug).first()
  if (!tag) return null

  const posts = await Post
    .with('category', 'tags')
    .whereRelation('tags', 'id', tag.id)
    .where('status', 'published')
    .orderBy('published_at', 'desc')
    .get()

  return { tag, posts }
}
```

What each piece does:

- **`with('category', 'tags')`** loads the relationships in the same call, so each post already has `post.category` and `post.tags`. This avoids one extra query per post.
- **`where()` and `orderBy()`** autocomplete column names from your migration. A typo like `'stauts'` is a type error.
- **`cache(60)`** keeps the result for 60 seconds using the `cache` package. Holo clears the cached result when the `posts` table changes, so new posts still show up right away.
- **`cache({ flexible: [60, 300] })`** serves a cached value for 60 seconds, then keeps serving it for up to 300 seconds while it refreshes in the background.
- **`firstWhere()` and `load()`** find one post, then load its relationships.
- **`whereRelation('tags', 'id', tag.id)`** finds posts that have a matching tag.

The post detail query returns `undefined` for drafts. The public site never shows a post until it's published.

## Step 7: Check it works

The seeder already ran, so the database has sample data. To reset and reseed at any time, run:

```bash
npx holo migrate:fresh --seed
```

::: warning
`migrate:fresh` drops every table, including users. Run `npx holo seed` on its own only once: running it twice fails, because the category and post slugs must be unique.
:::

Your editor should also show typed results. In `blog.ts`, hover over `post` inside `getPublishedPostBySlug()`. You should see the post columns (`title`, `slug`, `status`, ...) and, after `load()`, the `category` and `tags` relationships.

You'll see the data on real pages in the next chapter.

## Next steps

Next, show these posts in [Public Pages](/tutorial/public-pages).

To learn more:

- [ORM overview](/orm/)
- [Querying models](/orm/querying)
- [Relationships](/orm/relationships/)
- [Eager loading](/orm/relationships/loading)
- [Seeding](/database/seeding)
- [Query caching](/cache/query-caching)
