import Post from '../models/Post'
import User from '../models/User'
import Category from '../models/Category'
import Tag from '../models/Tag'

function now(): Date {
  return new Date()
}

async function ensureAuthorId(): Promise<number> {
  const existing = await User.orderBy('id').first()
  if (existing) {
    return existing.id
  }

  const user = await User.unguarded(() =>
    User.create({
      name: 'Holo Editor',
      email: 'editor@example.com',
      password: 'secret',
      avatar: null,
      email_verified_at: now(),
    }),
  )
  return user.id
}

async function createUniqueSlug(model: typeof Post | typeof Category | typeof Tag, value: string, excludeId?: number): Promise<string> {
  const base = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'entry'

  const fetchExisting = (m: typeof Post | typeof Category | typeof Tag) => {
    if (m === Post) return Post.query().whereLike('slug', `${base}%`).when(excludeId, q => q.where('id', '!=', excludeId)).select('slug').get()
    if (m === Category) return Category.query().whereLike('slug', `${base}%`).when(excludeId, q => q.where('id', '!=', excludeId)).select('slug').get()
    return Tag.query().whereLike('slug', `${base}%`).when(excludeId, q => q.where('id', '!=', excludeId)).select('slug').get()
  }

  const existing = await fetchExisting(model)
  const taken = new Set(existing.map(row => row.slug))

  for (let index = 1; ; index += 1) {
    const slug = index === 1 ? base : `${base}-${index}`
    if (!taken.has(slug)) {
      return slug
    }
  }
}

export function parseTagIds(value: string): number[] {
  return [...new Set(value
    .split(',')
    .map(segment => Number(segment.trim()))
    .filter(segment => Number.isInteger(segment) && segment > 0))]
}

export async function getHomePageData() {
  const [posts, categories, tags] = await Promise.all([
    Post.with('category', 'tags').where('status', 'published').orderBy('published_at', 'desc').get(),
    Category.orderBy('name').get(),
    Tag.orderBy('name').get(),
  ])
  return {
    posts,
    featured: posts[0] ?? null,
    categories,
    tags,
  }
}

export async function getPublishedPosts() {
  return await Post.with('category', 'tags').where('status', 'published').orderBy('published_at', 'desc').get()
}

export async function getPublishedPostBySlug(slug: string) {
  return await Post.with('category', 'tags').where('slug', slug).where('status', 'published').first()
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

export async function getAdminDashboardData() {
  const [postCount, publishedCount, categoryCount, tagCount] = await Promise.all([
    Post.count(),
    Post.where('status', 'published').count(),
    Category.count(),
    Tag.count(),
  ])

  return {
    postCount,
    publishedCount,
    categoryCount,
    tagCount,
  }
}

export async function getAdminPostsData() {
  const [posts, categories, tags] = await Promise.all([
    Post.with('category', 'tags').orderBy('created_at', 'desc').get(),
    Category.orderBy('name').get(),
    Tag.orderBy('name').get(),
  ])
  return { posts, categories, tags }
}

export async function getAdminPostById(id: number) {
  const [post, categories, tags] = await Promise.all([
    Post.with('category', 'tags').where('id', id).first(),
    Category.orderBy('name').get(),
    Tag.orderBy('name').get(),
  ])
  if (!post) return null

  return { post, categories, tags }
}

export async function getAdminCategoriesData() {
  return { categories: await Category.orderBy('name').get() }
}

export async function getAdminCategoryById(id: number) {
  return await Category.where('id', id).first()
}

export async function getAdminTagsData() {
  return { tags: await Tag.orderBy('name').get() }
}

export async function getAdminTagById(id: number) {
  return await Tag.where('id', id).first()
}

export async function createCategory(input: { name: string, description?: string }) {
  const name = input.name.trim()

  await Category.create({
    name,
    slug: await createUniqueSlug(Category, name),
    description: input.description?.trim() || null,
  })
}

export async function updateCategory(id: number, input: { name: string, description?: string }) {
  const name = input.name.trim()

  await Category.update(id, {
    name,
    slug: await createUniqueSlug(Category, name, id),
    description: input.description?.trim() || null,
  })
}

export async function deleteCategory(id: number) {
  await Post.where('category_id', id).update({ category_id: null })
  await Category.delete(id)
}

export async function createTag(input: { name: string }) {
  const name = input.name.trim()

  await Tag.create({
    name,
    slug: await createUniqueSlug(Tag, name),
  })
}

export async function updateTag(id: number, input: { name: string }) {
  const name = input.name.trim()

  await Tag.update(id, {
    name,
    slug: await createUniqueSlug(Tag, name, id),
  })
}

export async function deleteTag(id: number) {
  await Tag.delete(id)
}

export async function createPost(input: { title: string, excerpt?: string, body: string, status: string, categoryId?: string, tagIds?: string }) {
  const publishedAt = now()
  const authorId = await ensureAuthorId()
  const postStatus = input.status === 'draft' ? 'draft' : 'published'

  const post = await Post.create({
    user_id: authorId,
    category_id: input.categoryId ? Number(input.categoryId) : null,
    title: input.title.trim(),
    slug: await createUniqueSlug(Post, input.title),
    excerpt: input.excerpt?.trim() || null,
    body: input.body.trim(),
    status: postStatus,
    published_at: postStatus === 'published' ? publishedAt : null,
  })

  const tagIds = parseTagIds(input.tagIds || '')
  if (tagIds.length > 0) {
    await post.tags().attach(tagIds)
  }
}

export async function updatePost(id: number, input: { title: string, excerpt?: string, body: string, status: string, categoryId?: string, tagIds?: string }) {
  const publishedAt = now()
  const postStatus = input.status === 'draft' ? 'draft' : 'published'

  await Post.update(id, {
    category_id: input.categoryId ? Number(input.categoryId) : null,
    title: input.title.trim(),
    slug: await createUniqueSlug(Post, input.title, id),
    excerpt: input.excerpt?.trim() || null,
    body: input.body.trim(),
    status: postStatus,
    published_at: postStatus === 'published' ? publishedAt : null,
  })

  const tagIds = parseTagIds(input.tagIds || '')
  const post = await Post.find(id)
  if (post) {
    await post.tags().sync(tagIds)
  }
}

export async function deletePost(id: number) {
  await Post.delete(id)
}
