import { hashPassword } from '@holo-js/auth'
import { DB, uniqueSlug } from '@holo-js/db'

import Category from '../../../server/models/Category'
import Post from '../../../server/models/Post'
import Tag from '../../../server/models/Tag'
import User from '../../../server/models/User'

const BLOG_QUERY_CACHE_SECONDS = 60
const BLOG_FLEXIBLE_CACHE_SECONDS = [60, 300] as const

function now(): Date {
  return new Date()
}

export async function ensureAuthorId(): Promise<number> {
  const existing = await User.orderBy('id').first()
  if (existing) {
    return existing.id
  }

  const password = await hashPassword('secret-secret')
  const user = await User.unguarded(() =>
    User.firstOrCreate({ email: 'editor@example.com' }, {
      name: 'Holo Editor',
      password,
      avatar: null,
      email_verified_at: now(),
    }),
  )
  return user.id
}

export function parseTagIds(value: string): number[] {
  return [...new Set(value
    .split(',')
    .map(segment => Number(segment.trim()))
    .filter(segment => Number.isInteger(segment) && segment > 0))]
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

export async function getNavigationCategories() {
  return await Category
    .orderBy('name')
    .cache({ flexible: BLOG_FLEXIBLE_CACHE_SECONDS })
    .get()
}

export async function getPublishedPosts() {
  return await Post
    .with('category', 'tags')
    .where('status', 'published')
    .orderBy('published_at', 'desc')
    .cache(BLOG_QUERY_CACHE_SECONDS)
    .get()
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
    Post.firstWhere('id', id),
    Category.orderBy('name').get(),
    Tag.orderBy('name').get(),
  ])
  if (!post) return null

  return { post: await post.load('category', 'tags'), categories, tags }
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
    slug: await uniqueSlug(Category, name),
    description: input.description?.trim() || null,
  })
}

export async function updateCategory(id: number, input: { name: string, description?: string }) {
  const name = input.name.trim()
  const category = await Category.findOrFail(id)

  await category.update({
    name,
    slug: await uniqueSlug(Category, name, { ignore: id }),
    description: input.description?.trim() || null,
  })
}

export async function deleteCategory(id: number) {
  await DB.transaction(async () => {
    await Post.where('category_id', id).update({ category_id: null })
    await Category.delete(id)
  })
}

export async function createTag(input: { name: string }) {
  const name = input.name.trim()

  await Tag.create({
    name,
    slug: await uniqueSlug(Tag, name),
  })
}

export async function updateTag(id: number, input: { name: string }) {
  const name = input.name.trim()
  const tag = await Tag.findOrFail(id)

  await tag.update({
    name,
    slug: await uniqueSlug(Tag, name, { ignore: id }),
  })
}

export async function deleteTag(id: number) {
  await DB.transaction(async () => {
    const tag = await Tag.find(id)
    if (tag) {
      await tag.posts().detach()
    }

    await Tag.delete(id)
  })
}

export async function deletePost(id: number) {
  await DB.transaction(async () => {
    const post = await Post.find(id)
    if (post) {
      await post.tags().detach()
    }

    await Post.delete(id)
  })
}
