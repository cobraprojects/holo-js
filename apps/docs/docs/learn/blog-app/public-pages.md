# Public Blog Pages

This chapter renders the public blog: home page, post index, post detail, category archives, and tag archives.

## What you will build

- a home page with featured and recent posts
- `/posts`
- `/posts/[slug]`
- `/categories/[slug]`
- `/tags/[slug]`

## Files you will create

```txt
app/page.tsx
app/posts/page.tsx
app/posts/[slug]/page.tsx
app/categories/[slug]/page.tsx
app/tags/[slug]/page.tsx
app/auth-nav.tsx
```

The finished example uses:

- `apps/blog-next/app/page.tsx`
- `apps/blog-next/app/posts/page.tsx`
- `apps/blog-next/app/posts/[slug]/page.tsx`
- `apps/blog-next/app/categories/[slug]/page.tsx`
- `apps/blog-next/app/tags/[slug]/page.tsx`

## Home data

Load the public page from one server function.

```ts
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
```

## Post detail

Use the slug as the public identifier and return 404 behavior when a post is missing or still a draft.

```ts
export async function getPublishedPostBySlug(slug: string) {
  const post = await Post.firstWhere('slug', slug)
  if (!post || post.status !== 'published') {
    return undefined
  }

  return await post.load('category', 'tags')
}
```

## Archives

Category and tag archive pages should query the archive object first, then render its posts.

```ts
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
```

## Checkpoint

Users can now browse published posts by page, category, and tag. Draft posts stay hidden.

## Related reference

- [Routing](/routing)
- [ORM Relationships](/orm/relationships)
- [Collections](/orm/collections)
