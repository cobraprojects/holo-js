import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { authRuntimeInternals, hashPassword, verifyPassword } from '@holo-js/auth'
import { initializeHoloAdapterProject } from '@holo-js/core'
import { DB } from '@holo-js/db'

import Category from '../server/models/Category.ts'
import Admin from '../server/models/Admin.ts'
import Post from '../server/models/Post.ts'
import Tag from '../server/models/Tag.ts'
import User from '../server/models/User.ts'
import { actions as updatePostPageActions } from '../src/routes/admin/posts/[id]/edit/+page.server.ts'
import { actions as createPostPageActions } from '../src/routes/admin/posts/new/+page.server.ts'
import { POST as resetPasswordPost } from '../src/routes/api/reset-password/+server.ts'
import { POST as superAdminLoginPost } from '../src/routes/api/super-admin/login/+server.ts'
import {
  createCategory,
  createTag,
  deleteCategory,
  deletePost,
  deleteTag,
  getAdminCategoriesData,
  getAdminDashboardData,
  getAdminPostsData,
  getAdminTagsData,
  getCategoryArchive,
  getHomePageData,
  getPublishedPostBySlug,
  getTagArchive,
  parseTagIds,
  updateCategory,
  updateTag,
} from '../src/lib/server/blog.ts'

const project = await initializeHoloAdapterProject(process.cwd())

function createActionRequest(fields) {
  const formData = new FormData()
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === 'undefined') {
      continue
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        formData.append(name, String(item))
      }
      continue
    }

    formData.set(name, String(value))
  }

  return new Request('http://localhost/admin/posts', {
    method: 'POST',
    body: formData,
  })
}

function createApiRequest(path, fields) {
  const formData = new FormData()
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === 'undefined') {
      continue
    }

    formData.set(name, String(value))
  }

  return new Request(`http://localhost${path}`, {
    method: 'POST',
    body: formData,
  })
}

function assertInvalidPostStatusFailure(result) {
  assert.equal(result.status, 400)
  assert.deepEqual(result.data?.errors?.status, ['Select a valid post status.'])
}

async function expectRedirect(action) {
  try {
    await action()
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'status' in error
      && Number(error.status) >= 300
      && Number(error.status) < 400
    ) {
      return
    }

    throw error
  }
}

async function createPost(fields) {
  await expectRedirect(() => createPostPageActions.create({
    request: createActionRequest(fields),
  }))
}

async function updatePost(id, fields) {
  await expectRedirect(() => updatePostPageActions.update({
    params: { id: String(id) },
    request: createActionRequest(fields),
  }))
}

async function readJsonResponse(response) {
  return {
    status: response.status,
    body: await response.json(),
  }
}

function assertFieldFailure(result, fields) {
  assert.equal(result.body.ok, false)
  assert.equal(result.body.valid, false)
  for (const field of fields) {
    assert.ok(
      Array.isArray(result.body.errors?.[field]),
      `Expected ${field} validation errors.`,
    )
  }
}

async function assertResetPasswordApiRoute() {
  const invalidSubmission = await readJsonResponse(await resetPasswordPost({
    request: createApiRequest('/api/reset-password', {}),
  }))
  assert.equal(invalidSubmission.status, 422)
  assertFieldFailure(invalidSubmission, ['token', 'password', 'passwordConfirmation'])

  const invalidToken = await readJsonResponse(await resetPasswordPost({
    request: createApiRequest('/api/reset-password', {
      token: 'bad-token',
      password: 'secret-secret-2',
      passwordConfirmation: 'secret-secret-2',
    }),
  }))
  assert.equal(invalidToken.status, 422)
  assertFieldFailure(invalidToken, ['token'])

  const email = `reset-route-${Date.now()}@app.test`
  const password = 'secret-secret'
  const nextPassword = 'secret-secret-2'
  const passwordHash = await hashPassword(password)
  const user = await User.unguarded(() => User.create({
    name: 'Reset Route User',
    email,
    password: passwordHash,
    avatar: null,
    email_verified_at: new Date(),
  }))
  const tokenId = randomUUID()
  const tokenSecret = 'reset-route-secret'
  const timestamp = new Date().toISOString()
  await DB.table('password_reset_tokens').insert({
    id: tokenId,
    provider: 'users',
    email,
    token_hash: authRuntimeInternals.hashTokenSecret(tokenSecret),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    created_at: timestamp,
    updated_at: timestamp,
  })

  const reset = await readJsonResponse(await resetPasswordPost({
    request: createApiRequest('/api/reset-password', {
      token: `${tokenId}.${tokenSecret}`,
      password: nextPassword,
      passwordConfirmation: nextPassword,
    }),
  }))
  assert.equal(reset.status, 200)
  assert.equal(reset.body.ok, true)
  assert.equal(reset.body.data?.message, 'Password reset successfully. You can sign in with your new password.')
  assert.equal(reset.body.data?.redirectTo, '/login')

  const refreshedUser = await User.findOrFail(user.id)
  assert.equal(await verifyPassword(nextPassword, refreshedUser.password), true)
}

async function assertSuperAdminLoginVerificationRedirects() {
  const verified = await readJsonResponse(await superAdminLoginPost({
    request: createApiRequest('/api/super-admin/login', {
      email: 'super-admin@example.com',
      password: 'admin-secret',
    }),
  }))
  assert.equal(verified.status, 200)
  assert.equal(verified.body.ok, true)
  assert.equal(verified.body.data?.message, 'Signed in as super admin.')
  assert.equal(verified.body.data?.redirectTo, '/super-admin')

  const email = `unverified-admin-${Date.now()}@app.test`
  const passwordHash = await hashPassword('admin-secret')
  await Admin.unguarded(() => Admin.create({
    name: 'Unverified Super Admin',
    email,
    password: passwordHash,
    avatar: null,
    email_verified_at: null,
  }))

  const unverified = await readJsonResponse(await superAdminLoginPost({
    request: createApiRequest('/api/super-admin/login', {
      email,
      password: 'admin-secret',
    }),
  }))
  assert.equal(unverified.status, 200)
  assert.equal(unverified.body.ok, true)
  assert.equal(unverified.body.data?.message, 'Signed in. Verify your email address to continue.')
  assert.equal(unverified.body.data?.redirectTo, `/verify-email?email=${encodeURIComponent(email)}`)
}

try {
  const verifyEmailRouteSource = await readFile(new URL('../src/routes/verify-email/+page.server.ts', import.meta.url), 'utf8')
  assert.ok(
    verifyEmailRouteSource.includes('verifyEmail(token)'),
    'Expected the verify-email page load to consume verification tokens server-side.',
  )
  assert.ok(
    !verifyEmailRouteSource.includes('token:'),
    'Expected the verify-email page data to avoid returning raw verification tokens.',
  )
  await assertResetPasswordApiRoute()
  await assertSuperAdminLoginVerificationRedirects()

  assert.deepEqual(parseTagIds('1, 2, 2, nope, 0, -1, 3'), [1, 2, 3])

  const home = await getHomePageData()
  assert.equal(home.posts.length, 2)
  assert.equal(home.featured?.slug, 'shipping-a-real-holo-blog-on-sveltekit')
  assert.equal(home.categories.length, 2)
  assert.equal(home.tags.length, 3)

  const firstUser = await User.with('posts').first()
  assert.ok(firstUser)
  assert.ok(Array.isArray(firstUser.posts))

  const featuredPost = await Post.with('user').where('slug', home.featured?.slug ?? '').first()
  assert.ok(featuredPost?.user)

  const dashboard = await getAdminDashboardData()
  assert.equal(dashboard.postCount, 2)
  assert.equal(dashboard.publishedCount, 2)
  assert.equal(dashboard.categoryCount, 2)
  assert.equal(dashboard.tagCount, 3)

  const engineeringArchive = await getCategoryArchive('engineering')
  assert.ok(engineeringArchive)
  assert.equal(engineeringArchive.posts.length, 1)
  assert.equal(engineeringArchive.posts[0]?.slug, 'shipping-a-real-holo-blog-on-sveltekit')

  const frameworkArchive = await getTagArchive('framework')
  assert.ok(frameworkArchive)
  assert.equal(frameworkArchive.posts.length, 2)

  await createCategory({
    name: 'Platform Ops',
    description: 'Infrastructure notes',
  })
  const createdCategory = await Category.where('slug', 'platform-ops').first()
  assert.ok(createdCategory)

  await updateCategory(createdCategory.id, {
    name: 'Platform Systems',
    description: 'Updated infrastructure notes',
  })
  const updatedCategory = await Category.findOrFail(createdCategory.id)
  assert.equal(updatedCategory.slug, 'platform-systems')
  assert.equal(updatedCategory.description, 'Updated infrastructure notes')

  await Promise.all([
    createCategory({ name: 'Concurrent Category' }),
    createCategory({ name: 'Concurrent Category' }),
  ])
  const concurrentCategories = await Category.whereLike('slug', 'concurrent-category%').orderBy('slug').get()
  assert.deepEqual(concurrentCategories.map(category => category.slug), ['concurrent-category', 'concurrent-category-2'])

  await createTag({ name: 'Guides' })
  const createdTag = await Tag.where('slug', 'guides').first()
  assert.ok(createdTag)

  await updateTag(createdTag.id, { name: 'Deep Guides' })
  const updatedTag = await Tag.findOrFail(createdTag.id)
  assert.equal(updatedTag.slug, 'deep-guides')

  const frameworkTag = await Tag.where('slug', 'framework').first()
  const releaseTag = await Tag.where('slug', 'release').first()
  assert.ok(frameworkTag)
  assert.ok(releaseTag)

  assertInvalidPostStatusFailure(await createPostPageActions.create({
    request: createActionRequest({
      title: 'Missing Route Status Post',
      body: 'Missing status body',
    }),
  }))
  assert.equal(await Post.where('slug', 'missing-route-status-post').first(), undefined)

  assertInvalidPostStatusFailure(await createPostPageActions.create({
    request: createActionRequest({
      title: 'Unknown Route Status Post',
      body: 'Unknown status body',
      status: 'archived',
    }),
  }))
  assert.equal(await Post.where('slug', 'unknown-route-status-post').first(), undefined)

  await createPost({
    title: 'Logic Coverage Post',
    excerpt: 'Logic excerpt',
    body: 'Logic body',
    status: 'published',
    categoryId: String(updatedCategory.id),
    tagIds: [frameworkTag.id],
  })

  let logicPost = await Post.with('category', 'tags').where('slug', 'logic-coverage-post').first()
  assert.ok(logicPost)
  assert.equal(logicPost.category?.id, updatedCategory.id)
  assert.equal(logicPost.tags.length, 1)
  assert.equal(logicPost.tags[0]?.id, frameworkTag.id)
  assert.ok(logicPost.published_at)

  const originalPublishedAt = logicPost.published_at

  await updatePost(logicPost.id, {
    title: 'Logic Coverage Post',
    excerpt: 'Still published',
    body: 'Still published body',
    status: 'published',
    categoryId: String(updatedCategory.id),
    tagIds: [frameworkTag.id],
  })

  logicPost = await Post.with('category', 'tags').where('id', logicPost.id).first()
  assert.ok(logicPost)
  assert.equal(logicPost.published_at?.getTime(), originalPublishedAt.getTime())

  await createPost({
    title: 'Route Status Draft',
    body: 'Draft body',
    status: 'draft',
  })
  let routeStatusPost = await Post.where('slug', 'route-status-draft').first()
  assert.ok(routeStatusPost)

  assertInvalidPostStatusFailure(await updatePostPageActions.update({
    params: { id: String(routeStatusPost.id) },
    request: createActionRequest({
      title: 'Route Status Published',
      body: 'Published body',
    }),
  }))
  routeStatusPost = await Post.findOrFail(routeStatusPost.id)
  assert.equal(routeStatusPost.status, 'draft')
  assert.equal(routeStatusPost.title, 'Route Status Draft')

  assertInvalidPostStatusFailure(await updatePostPageActions.update({
    params: { id: String(routeStatusPost.id) },
    request: createActionRequest({
      title: 'Route Status Published',
      body: 'Published body',
      status: 'archived',
    }),
  }))
  routeStatusPost = await Post.findOrFail(routeStatusPost.id)
  assert.equal(routeStatusPost.status, 'draft')
  assert.equal(routeStatusPost.title, 'Route Status Draft')

  await updatePost(logicPost.id, {
    title: 'Logic Coverage Post Revised',
    excerpt: 'Changed excerpt',
    body: 'Changed body',
    status: 'draft',
    categoryId: '',
    tagIds: [releaseTag.id],
  })

  logicPost = await Post.with('category', 'tags').where('id', logicPost.id).first()
  assert.ok(logicPost)
  assert.equal(logicPost.slug, 'logic-coverage-post-revised')
  assert.equal(logicPost.status, 'draft')
  assert.equal(logicPost.category, null)
  assert.equal(logicPost.tags.length, 1)
  assert.equal(logicPost.tags[0]?.id, releaseTag.id)
  assert.equal(logicPost.published_at, null)
  assert.equal(await getPublishedPostBySlug('logic-coverage-post-revised'), undefined)

  await Promise.all([
    createPost({
      title: 'Concurrent Slug Post',
      body: 'Concurrent body',
      status: 'draft',
    }),
    createPost({
      title: 'Concurrent Slug Post',
      body: 'Concurrent body',
      status: 'draft',
    }),
  ])
  const concurrentPosts = await Post.whereLike('slug', 'concurrent-slug-post%').orderBy('slug').get()
  assert.deepEqual(concurrentPosts.map(post => post.slug), ['concurrent-slug-post', 'concurrent-slug-post-2'])

  await createPost({
    title: 'Category Cleanup Post',
    body: 'Category cleanup body',
    status: 'published',
    categoryId: String(updatedCategory.id),
    tagIds: [frameworkTag.id],
  })

  const cleanupPost = await Post.where('slug', 'category-cleanup-post').first()
  assert.ok(cleanupPost)

  await createCategory({
    name: 'Rollback Category',
    description: 'Category deletion rollback fixture',
  })
  const rollbackCategory = await Category.where('slug', 'rollback-category').first()
  assert.ok(rollbackCategory)
  await createPost({
    title: 'Category Rollback Post',
    body: 'Category rollback body',
    status: 'draft',
    categoryId: String(rollbackCategory.id),
  })
  const rollbackPost = await Post.where('slug', 'category-rollback-post').first()
  assert.ok(rollbackPost)
  const repositoryPrototype = Object.getPrototypeOf(Category.getRepository())
  const deleteCategoryRecord = repositoryPrototype.delete
  repositoryPrototype.delete = async function deleteWithForcedCategoryFailure() {
    throw new Error('forced category delete failure')
  }
  try {
    await assert.rejects(deleteCategory(rollbackCategory.id), /forced category delete failure/)
  } finally {
    repositoryPrototype.delete = deleteCategoryRecord
  }
  const retainedRollbackPost = await Post.findOrFail(rollbackPost.id)
  assert.equal(retainedRollbackPost.category_id, rollbackCategory.id)
  await deleteCategory(rollbackCategory.id)
  await deletePost(rollbackPost.id)

  await createPost({
    title: 'Tag Cleanup Post',
    body: 'Tag cleanup body',
    status: 'draft',
    tagIds: [updatedTag.id],
  })
  const tagCleanupPost = await Post.with('tags').where('slug', 'tag-cleanup-post').first()
  assert.ok(tagCleanupPost)
  assert.equal(tagCleanupPost.tags[0]?.id, updatedTag.id)

  await deleteCategory(updatedCategory.id)
  const uncategorizedPost = await Post.findOrFail(cleanupPost.id)
  assert.equal(uncategorizedPost.category_id, null)
  assert.equal(await Category.find(updatedCategory.id), undefined)

  await deletePost(logicPost.id)
  await deletePost(cleanupPost.id)
  await deletePost(routeStatusPost.id)
  for (const post of concurrentPosts) {
    await deletePost(post.id)
  }
  assert.equal(await Post.find(logicPost.id), undefined)
  assert.equal(await Post.find(cleanupPost.id), undefined)
  assert.equal(await Post.find(routeStatusPost.id), undefined)
  assert.equal(await DB.table('post_tags').where('post_id', logicPost.id).count(), 0)
  assert.equal(await DB.table('post_tags').where('post_id', cleanupPost.id).count(), 0)

  await deleteTag(updatedTag.id)
  const tagCleanupPostWithoutTags = await Post.with('tags').findOrFail(tagCleanupPost.id)
  assert.equal(tagCleanupPostWithoutTags.tags.length, 0)
  assert.equal(await DB.table('post_tags').where('tag_id', updatedTag.id).count(), 0)
  assert.equal(await Tag.find(updatedTag.id), undefined)
  await deletePost(tagCleanupPost.id)

  for (const category of concurrentCategories) {
    await deleteCategory(category.id)
  }

  const categories = await getAdminCategoriesData()
  const tags = await getAdminTagsData()
  const posts = await getAdminPostsData()
  assert.equal(categories.categories.length, 2)
  assert.equal(tags.tags.length, 3)
  assert.equal(posts.posts.length, 2)
} finally {
  await project.runtime.shutdown()
}
