import { hashPassword } from '@holo-js/auth'
import { broadcast } from '@holo-js/broadcast'
import { DB, uniqueSlug } from '@holo-js/db'
import { ValidationException } from '@holo-js/forms'

import { blogPostChanged } from '../broadcast/blog-post-changed'
import BlogPostSaved from '../events/blog/post-saved'
import IndexBlogPost from '../jobs/blog/index-post'
import Category from '../models/Category'
import Post from '../models/Post'
import Tag from '../models/Tag'
import User from '../models/User'

const BLOG_QUERY_CACHE_SECONDS = 60
const BLOG_FLEXIBLE_CACHE_SECONDS = [60, 300] as const

function now(): Date {
  return new Date()
}

async function ensureAuthorId(): Promise<number> {
  const existing = await User.orderBy('id').first()
  if (existing) {
    return existing.id
  }

  const password = await hashPassword('secret-secret')
  const user = await User.unguarded(() =>
    User.create({
      name: 'Holo Editor',
      email: 'editor@example.com',
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

export async function getAdminPostFormData() {
  const [categories, tags] = await Promise.all([
    Category.orderBy('name').get(),
    Tag.orderBy('name').get(),
  ])
  return { categories, tags }
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
  await Post.where('category_id', id).update({ category_id: null })
  await Category.delete(id)
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
  await Tag.delete(id)
}

export async function createPost(input: { title: string, excerpt?: string, body: string, status: string, categoryId?: string, tagIds?: string, authorId?: number, image?: Blob }) {
  const post = await DB.transaction(async () => {
    const publishedAt = now()
    const authorId = input.authorId ?? await ensureAuthorId()
    const postStatus = input.status === 'draft' ? 'draft' : 'published'

    const post = await Post.create({
      user_id: authorId,
      category_id: input.categoryId ? Number(input.categoryId) : null,
      title: input.title.trim(),
      slug: await uniqueSlug(Post, input.title),
      excerpt: input.excerpt?.trim() || null,
      body: input.body.trim(),
      status: postStatus,
      published_at: postStatus === 'published' ? publishedAt : null,
    })

    const tagIds = parseTagIds(input.tagIds || '')
    if (tagIds.length > 0) {
      await post.tags().attach(tagIds)
    }

    return post
  })

  if (input.image) {
    const result = await post.addMedia(input.image).toMediaCollection('images')
    if (result.error) {
      throw ValidationException.withMessages({
        image: [result.error.message],
      })
    }
  }

  await broadcast(blogPostChanged('created', post.id, post.title, post.status, post.slug))
  await BlogPostSaved.dispatch({
    action: 'created',
    postId: post.id,
    title: post.title,
    status: post.status,
    slug: post.slug,
  })
  await IndexBlogPost.dispatch({
    action: 'created',
    postId: post.id,
  }).onQueue('default')

  return post
}

export async function updatePost(id: number, input: { title: string, excerpt?: string, body: string, status: string, categoryId?: string, tagIds?: string, image?: Blob }) {
  const post = await DB.transaction(async () => {
    const publishedAt = now()
    const postStatus = input.status === 'draft' ? 'draft' : 'published'
    const post = await Post.findOrFail(id)

    await post.update({
      category_id: input.categoryId ? Number(input.categoryId) : null,
      title: input.title.trim(),
      slug: await uniqueSlug(Post, input.title, { ignore: id }),
      excerpt: input.excerpt?.trim() || null,
      body: input.body.trim(),
      status: postStatus,
      published_at: postStatus === 'published' ? post.published_at ?? publishedAt : null,
    })

    const tagIds = parseTagIds(input.tagIds || '')
    await post.tags().sync(tagIds)

    return post
  })

  if (input.image) {
    const result = await post.addMedia(input.image).toMediaCollection('images')
    if (result.error) {
      throw ValidationException.withMessages({
        image: [result.error.message],
      })
    }
  }

  await broadcast(blogPostChanged('updated', post.id, post.title, post.status, post.slug))
  await BlogPostSaved.dispatch({
    action: 'updated',
    postId: post.id,
    title: post.title,
    status: post.status,
    slug: post.slug,
  })
  await IndexBlogPost.dispatch({
    action: 'updated',
    postId: post.id,
  }).onQueue('default')

  return post
}

export async function deletePost(id: number) {
  const post = await Post.find(id)
  await Post.delete(id)
  if (post) {
    await broadcast(blogPostChanged('deleted', post.id, post.title, post.status, post.slug))
    await BlogPostSaved.dispatch({
      action: 'deleted',
      postId: post.id,
      title: post.title,
      status: post.status,
      slug: post.slug,
    })
    await IndexBlogPost.dispatch({
      action: 'deleted',
      postId: post.id,
    }).onQueue('default')
  }
}
