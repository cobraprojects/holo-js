# 4. Public Pages

In this chapter you show the blog to visitors. Every page calls one function from `blog.ts`, so the pages stay small.

## What you'll build

| URL | Shows |
| --- | --- |
| `/` | a featured post, the latest posts, categories, and tags |
| `/posts` | all published posts |
| `/posts/[slug]` | one post, or a 404 for drafts and missing posts |
| `/categories/[slug]` | published posts in a category |
| `/tags/[slug]` | published posts with a tag |

The examples leave out styling so the Holo parts are easy to see.

## Step 1: Load the data on the server

Each framework loads server data differently:

- **Next.js** server components can call `blog.ts` directly, so there's nothing to add in this step.
- **Nuxt** pages fetch from small API endpoints in `server/api/`.
- **SvelteKit** pages get their data from a `+page.server.ts` file next to each page.

::: code-group

```ts [Next.js]
// Nothing to add. Your pages in the next steps call server/lib/blog.ts directly.
```

```ts [Nuxt]
// server/api/blog/home.get.ts
import { getHomePageData } from '../../lib/blog'

export default defineEventHandler(async () => await getHomePageData())

// server/api/blog/posts/index.get.ts
import { getPublishedPosts } from '../../../lib/blog'

export default defineEventHandler(async () => await getPublishedPosts())

// server/api/blog/posts/[slug].get.ts
import { getPublishedPostBySlug } from '../../../lib/blog'

export default defineEventHandler(async (event) => {
  const post = await getPublishedPostBySlug(String(getRouterParam(event, 'slug') || ''))
  if (!post) {
    return null
  }

  return post.toJSON()
})

// server/api/blog/categories/[slug].get.ts
import { getCategoryArchive } from '../../../lib/blog'

export default defineEventHandler(async (event) => await getCategoryArchive(String(event.context.params?.slug || '')))

// server/api/blog/tags/[slug].get.ts
import { getTagArchive } from '../../../lib/blog'

export default defineEventHandler(async (event) => await getTagArchive(String(event.context.params?.slug || '')))
```

```ts [SvelteKit]
// src/routes/+page.server.ts
import { getHomePageData } from '$lib/server/blog'

export async function load() {
  return await getHomePageData()
}

// src/routes/posts/+page.server.ts
import { getPublishedPosts } from '$lib/server/blog'

export async function load() {
  return { posts: await getPublishedPosts() }
}

// src/routes/posts/[slug]/+page.server.ts
import { error } from '@sveltejs/kit'

import { getPublishedPostBySlug } from '$lib/server/blog'
import type { PageServerLoad } from './$types'

export const load = (async ({ params }) => {
  const post = await getPublishedPostBySlug(params.slug)
  if (!post) {
    throw error(404, 'Post not found')
  }

  return { post: post.toJSON() }
}) satisfies PageServerLoad

// src/routes/categories/[slug]/+page.server.ts
import { error } from '@sveltejs/kit'

import { getCategoryArchive } from '$lib/server/blog'
import type { PageServerLoad } from './$types'

export const load = (async ({ params }) => {
  const archive = await getCategoryArchive(params.slug)
  if (!archive) {
    throw error(404, 'Category not found')
  }

  return archive
}) satisfies PageServerLoad

// src/routes/tags/[slug]/+page.server.ts
import { error } from '@sveltejs/kit'

import { getTagArchive } from '$lib/server/blog'
import type { PageServerLoad } from './$types'

export const load = (async ({ params }) => {
  const archive = await getTagArchive(params.slug)
  if (!archive) {
    throw error(404, 'Tag not found')
  }

  return archive
}) satisfies PageServerLoad
```

:::

The Nuxt and SvelteKit tabs show several files. Each file starts with a comment that holds its path.

`post.toJSON()` turns a model into plain data, including its loaded relationships. You can return models and collections directly too, as the home and archive loaders do.

## Step 2: Build the home page

::: code-group

```tsx [Next.js]
// app/page.tsx
import Link from 'next/link'

import { getHomePageData } from '@/server/lib/blog'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const { featured, posts, categories, tags } = await getHomePageData()

  return (
    <div>
      {featured ? (
        <section>
          <span>Featured story</span>
          <h2><Link href={`/posts/${featured.slug}`}>{featured.title}</Link></h2>
          <p>{featured.excerpt}</p>
        </section>
      ) : null}

      <section>
        <h2>Latest posts</h2>
        <Link href="/posts">Browse all</Link>
        {posts.map(post => (
          <article key={post.id}>
            <h3><Link href={`/posts/${post.slug}`}>{post.title}</Link></h3>
            <p>{post.excerpt}</p>
            {post.category ? <Link href={`/categories/${post.category.slug}`}>{post.category.name}</Link> : null}
            {post.tags.map(tag => <Link key={tag.id} href={`/tags/${tag.slug}`}>#{tag.name}</Link>)}
          </article>
        ))}
      </section>

      <section>
        <h3>Categories</h3>
        <ul>
          {categories.map(category => <li key={category.id}><Link href={`/categories/${category.slug}`}>{category.name}</Link></li>)}
        </ul>
        <h3>Tags</h3>
        {tags.map(tag => <Link key={tag.id} href={`/tags/${tag.slug}`}>#{tag.name}</Link>)}
      </section>
    </div>
  )
}
```

```vue [Nuxt]
<!-- app/pages/index.vue -->
<script setup lang="ts">
const { data } = await useFetch('/api/blog/home', {
  pick: ['featured', 'posts', 'categories', 'tags'],
})
</script>

<template>
  <section>
    <article v-if="data?.featured">
      <span>Featured story</span>
      <h2><NuxtLink :to="`/posts/${data.featured.slug}`">{{ data.featured.title }}</NuxtLink></h2>
      <p>{{ data.featured.excerpt }}</p>
    </article>

    <h2>Latest posts</h2>
    <NuxtLink to="/posts">Browse all</NuxtLink>
    <article v-for="post in data?.posts || []" :key="post.id">
      <h3><NuxtLink :to="`/posts/${post.slug}`">{{ post.title }}</NuxtLink></h3>
      <p>{{ post.excerpt }}</p>
      <NuxtLink v-if="post.category" :to="`/categories/${post.category.slug}`">{{ post.category.name }}</NuxtLink>
      <NuxtLink v-for="tag in post.tags" :key="tag.id" :to="`/tags/${tag.slug}`">#{{ tag.name }}</NuxtLink>
    </article>

    <h3>Categories</h3>
    <ul>
      <li v-for="category in data?.categories || []" :key="category.id">
        <NuxtLink :to="`/categories/${category.slug}`">{{ category.name }}</NuxtLink>
      </li>
    </ul>
    <h3>Tags</h3>
    <NuxtLink v-for="tag in data?.tags || []" :key="tag.id" :to="`/tags/${tag.slug}`">#{{ tag.name }}</NuxtLink>
  </section>
</template>
```

```svelte [SvelteKit]
<!-- src/routes/+page.svelte -->
<script lang="ts">
  import { type PageData } from './$types'

  export let data: PageData
</script>

<section>
  {#if data.featured}
    <article>
      <span>Featured story</span>
      <h2><a href={`/posts/${data.featured.slug}`}>{data.featured.title}</a></h2>
      <p>{data.featured.excerpt}</p>
    </article>
  {/if}

  <h2>Latest posts</h2>
  <a href="/posts">Browse all</a>
  {#each data.posts as post}
    <article>
      <h3><a href={`/posts/${post.slug}`}>{post.title}</a></h3>
      <p>{post.excerpt}</p>
      {#if post.category}
        <a href={`/categories/${post.category.slug}`}>{post.category.name}</a>
      {/if}
      {#each post.tags as tag}
        <a href={`/tags/${tag.slug}`}>#{tag.name}</a>
      {/each}
    </article>
  {/each}

  <h3>Categories</h3>
  <ul>
    {#each data.categories as category}
      <li><a href={`/categories/${category.slug}`}>{category.name}</a></li>
    {/each}
  </ul>
  <h3>Tags</h3>
  {#each data.tags as tag}
    <a href={`/tags/${tag.slug}`}>#{tag.name}</a>
  {/each}
</section>
```

:::

`post.category` and `post.tags` are typed because the query used `with('category', 'tags')`. If you remove that call, your editor flags them.

In Next.js, `dynamic = 'force-dynamic'` renders the page on every request, so it always shows the latest posts.

## Step 3: Build the post list

::: code-group

```tsx [Next.js]
// app/posts/page.tsx
import Link from 'next/link'

import { getPublishedPosts } from '@/server/lib/blog'

export const dynamic = 'force-dynamic'

export default async function PostsPage() {
  const posts = await getPublishedPosts()

  return (
    <section>
      <h1>Posts</h1>
      {posts.map(post => (
        <article key={post.id}>
          <h2><Link href={`/posts/${post.slug}`}>{post.title}</Link></h2>
          <p>{post.excerpt}</p>
        </article>
      ))}
    </section>
  )
}
```

```vue [Nuxt]
<!-- app/pages/posts/index.vue -->
<script setup lang="ts">
const { data } = await useFetch('/api/blog/posts')
</script>

<template>
  <section>
    <h1>Posts</h1>
    <article v-for="post in data || []" :key="post.id">
      <h2><NuxtLink :to="`/posts/${post.slug}`">{{ post.title }}</NuxtLink></h2>
      <p>{{ post.excerpt }}</p>
    </article>
  </section>
</template>
```

```svelte [SvelteKit]
<!-- src/routes/posts/+page.svelte -->
<script lang="ts">
  import { type PageData } from './$types'

  export let data: PageData
</script>

<section>
  <h1>Posts</h1>
  {#each data.posts as post}
    <article>
      <h2><a href={`/posts/${post.slug}`}>{post.title}</a></h2>
      <p>{post.excerpt}</p>
    </article>
  {/each}
</section>
```

:::

## Step 4: Build the post page

The post page looks a post up by its slug. If the post is missing or still a draft, it returns your framework's normal 404.

::: code-group

```tsx [Next.js]
// app/posts/[slug]/page.tsx
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { getPublishedPostBySlug } from '@/server/lib/blog'

export const dynamic = 'force-dynamic'

export default async function PostDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const post = await getPublishedPostBySlug(slug)

  if (!post) {
    notFound()
  }

  return (
    <article>
      <Link href="/posts">Back to posts</Link>
      <h1>{post.title}</h1>
      <p>{post.excerpt}</p>
      {post.category ? <Link href={`/categories/${post.category.slug}`}>{post.category.name}</Link> : null}
      {post.tags.map(tag => (
        <span key={tag.id}>
          <Link href={`/tags/${tag.slug}`}>#{tag.name}</Link>
          {tag.pivot.is_primary ? <small>Primary topic</small> : null}
        </span>
      ))}
      <div>{post.body}</div>
    </article>
  )
}
```

```vue [Nuxt]
<!-- app/pages/posts/[slug].vue -->
<script setup lang="ts">
const route = useRoute()
const { data } = await useFetch(`/api/blog/posts/${route.params.slug}`)

if (!data.value) {
  throw createError({ statusCode: 404, statusMessage: 'Post not found' })
}
</script>

<template>
  <article>
    <NuxtLink to="/posts">Back to posts</NuxtLink>
    <h1>{{ data?.title }}</h1>
    <p>{{ data?.excerpt }}</p>
    <div v-for="tag in data?.tags" :key="tag.id">
      <NuxtLink :to="`/tags/${tag.slug}`">#{{ tag.name }}</NuxtLink>
      <small v-if="tag.pivot.is_primary">Primary topic</small>
    </div>
    <div>{{ data?.body }}</div>
  </article>
</template>
```

```svelte [SvelteKit]
<!-- src/routes/posts/[slug]/+page.svelte -->
<script lang="ts">
  import { type PageData } from './$types'

  export let data: PageData
</script>

<article>
  <a href="/posts">Back to posts</a>
  <h1>{data.post.title}</h1>
  <p>{data.post.excerpt}</p>
  {#each data.post.tags as tag (tag.id)}
    <div>
      <a href={`/tags/${tag.slug}`}>#{tag.name}</a>
      {#if tag.pivot.is_primary}<small>Primary topic</small>{/if}
    </div>
  {/each}
  <div>{data.post.body}</div>
</article>
```

:::

`tag.pivot` holds the columns from the `post_tags` row. `is_primary` is there because the relationship uses `withPivot('is_primary')`.

## Step 5: Build the category and tag archives

The category page:

::: code-group

```tsx [Next.js]
// app/categories/[slug]/page.tsx
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { getCategoryArchive } from '@/server/lib/blog'

export const dynamic = 'force-dynamic'

export default async function CategoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const archive = await getCategoryArchive(slug)

  if (!archive) {
    notFound()
  }

  return (
    <section>
      <h1>{archive.category.name}</h1>
      <p>{archive.category.description}</p>
      {archive.posts.map(post => (
        <article key={post.id}>
          <h2><Link href={`/posts/${post.slug}`}>{post.title}</Link></h2>
          <p>{post.excerpt}</p>
        </article>
      ))}
    </section>
  )
}
```

```vue [Nuxt]
<!-- app/pages/categories/[slug].vue -->
<script setup lang="ts">
const route = useRoute()
const { data } = await useFetch(`/api/blog/categories/${encodeURIComponent(String(route.params.slug))}`, {
  pick: ['category', 'posts'],
})

if (!data.value) {
  throw createError({ statusCode: 404, statusMessage: 'Category not found' })
}
</script>

<template>
  <section>
    <h1>{{ data?.category.name }}</h1>
    <p>{{ data?.category.description }}</p>
    <article v-for="post in data?.posts || []" :key="post.id">
      <h2><NuxtLink :to="`/posts/${post.slug}`">{{ post.title }}</NuxtLink></h2>
      <p>{{ post.excerpt }}</p>
    </article>
  </section>
</template>
```

```svelte [SvelteKit]
<!-- src/routes/categories/[slug]/+page.svelte -->
<script lang="ts">
  import { type PageData } from './$types'

  export let data: PageData
</script>

<section>
  <h1>{data.category.name}</h1>
  <p>{data.category.description}</p>
  {#each data.posts as post}
    <article>
      <h2><a href={`/posts/${post.slug}`}>{post.title}</a></h2>
      <p>{post.excerpt}</p>
    </article>
  {/each}
</section>
```

:::

The tag page is the same shape. It uses `getTagArchive()` and shows `#{tag.name}` as the heading:

::: code-group

```tsx [Next.js]
// app/tags/[slug]/page.tsx
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { getTagArchive } from '@/server/lib/blog'

export const dynamic = 'force-dynamic'

export default async function TagPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const archive = await getTagArchive(slug)

  if (!archive) {
    notFound()
  }

  return (
    <section>
      <h1>#{archive.tag.name}</h1>
      {archive.posts.map(post => (
        <article key={post.id}>
          <h2><Link href={`/posts/${post.slug}`}>{post.title}</Link></h2>
          <p>{post.excerpt}</p>
        </article>
      ))}
    </section>
  )
}
```

```vue [Nuxt]
<!-- app/pages/tags/[slug].vue -->
<script setup lang="ts">
const route = useRoute()
const { data } = await useFetch(`/api/blog/tags/${route.params.slug}`, {
  pick: ['tag', 'posts'],
})

if (!data.value) {
  throw createError({ statusCode: 404, statusMessage: 'Tag not found' })
}
</script>

<template>
  <section>
    <h1>#{{ data?.tag.name }}</h1>
    <article v-for="post in data?.posts || []" :key="post.id">
      <h2><NuxtLink :to="`/posts/${post.slug}`">{{ post.title }}</NuxtLink></h2>
      <p>{{ post.excerpt }}</p>
    </article>
  </section>
</template>
```

```svelte [SvelteKit]
<!-- src/routes/tags/[slug]/+page.svelte -->
<script lang="ts">
  import { type PageData } from './$types'

  export let data: PageData
</script>

<section>
  <h1>#{data.tag.name}</h1>
  {#each data.posts as post}
    <article>
      <h2><a href={`/posts/${post.slug}`}>{post.title}</a></h2>
      <p>{post.excerpt}</p>
    </article>
  {/each}
</section>
```

:::

## Step 6: Check it works

With the dev server running, open each page:

1. `/` shows "Shipping a Real Holo Blog" as the featured story, followed by both seeded posts.
2. `/posts` lists both posts.
3. `/posts/shipping-a-real-holo-blog` shows the post, with `#framework` marked as the primary topic.
4. `/categories/engineering` shows one post. `/tags/framework` shows two.
5. `/posts/does-not-exist` shows your framework's 404 page.

## Next steps

Next, build the admin area in [Admin CRUD](/tutorial/admin-crud).

To learn more:

- [Routing and Requests](/basics/routing)
- [Eager loading](/orm/relationships/loading)
- [Many-to-many relationships](/orm/relationships/many-to-many)
- [Serialization](/orm/serialization)
- Your framework guide: [Next.js](/getting-started/frameworks/next), [Nuxt](/getting-started/frameworks/nuxt), [SvelteKit](/getting-started/frameworks/sveltekit)
