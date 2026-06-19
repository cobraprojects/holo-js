import assert from 'node:assert/strict'

import authorization, { AuthorizationError } from '@holo-js/authorization'
import cache, { configureCacheRuntime, getCacheRuntimeBindings } from '@holo-js/cache'
import { initializeHoloAdapterProject } from '@holo-js/core'
import { DB } from '@holo-js/db'
import { isValidationException } from '@holo-js/forms'

import Category from '../server/models/Category.ts'
import Comment from '../server/models/Comment.ts'
import Post from '../server/models/Post.ts'
import Tag from '../server/models/Tag.ts'
import User from '../server/models/User.ts'
import {
  createCategory,
  createPost,
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
  getNavigationCategories,
  getPublishedPosts,
  getPublishedPostBySlug,
  getTagArchive,
  parseTagIds,
  updateCategory,
  updatePost,
  updateTag,
} from '../server/lib/blog.ts'

const project = await initializeHoloAdapterProject(process.cwd())
const blogCache = cache.driver('memory')
const imageUploadFailureMessage = 'The selected file must be 2 MB or smaller.'
const cacheBindings = getCacheRuntimeBindings()
if (!cacheBindings) {
  throw new Error('Expected cache runtime bindings to be configured.')
}
configureCacheRuntime({
  config: {
    ...cacheBindings.config,
    default: 'memory',
  },
  databaseConfig: cacheBindings.databaseConfig,
  redisConfig: cacheBindings.redisConfig,
  drivers: cacheBindings.drivers,
  dependencyIndex: cacheBindings.dependencyIndex,
  queryBridge: cacheBindings.queryBridge,
})

async function countRegisteredCacheKeys() {
  return (await getCacheRuntimeBindings()?.dependencyIndex?.listRegisteredKeys() ?? []).length
}

async function getRegisteredCacheKeys() {
  return [...(await getCacheRuntimeBindings()?.dependencyIndex?.listRegisteredKeys() ?? [])]
}

async function countQueuedBlogIndexJobs() {
  return await DB.table('jobs').where('job', 'blog.index-post').count()
}

function resolveDriverCacheKey(indexedKey) {
  const delimiterIndex = indexedKey.indexOf('\u0000')
  return delimiterIndex === -1 ? indexedKey : indexedKey.slice(delimiterIndex + 1)
}

async function countTableSelectQueryExecutions(tableName, callback) {
  const connection = DB.connection()
  const originalQueryCompiled = connection.queryCompiled.bind(connection)
  let queryCount = 0
  connection.queryCompiled = async (statement, ...parameters) => {
    if (statement.sql.includes(`"${tableName}"`) && statement.sql.toLowerCase().startsWith('select')) {
      queryCount += 1
    }

    return await originalQueryCompiled(statement, ...parameters)
  }

  try {
    await callback()
    await new Promise(resolve => setTimeout(resolve, 0))
  } finally {
    connection.queryCompiled = originalQueryCompiled
  }

  return queryCount
}

async function withMockedNow(timestamp, callback) {
  const originalNow = Date.now
  Date.now = () => timestamp
  try {
    return await callback()
  } finally {
    Date.now = originalNow
  }
}

function createDeferred() {
  let resolveDeferred = () => {}
  const promise = new Promise(resolve => {
    resolveDeferred = resolve
  })

  return {
    promise,
    resolve: resolveDeferred,
  }
}

async function waitForCondition(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 0))
  }

  assert.fail(message)
}

async function assertFlexibleStaleRefreshDoesNotBlock(timestamp) {
  const connection = DB.connection()
  const originalQueryCompiled = connection.queryCompiled.bind(connection)
  const refreshGate = createDeferred()
  let refreshStarted = false
  let refreshFinished = false

  connection.queryCompiled = async (statement, ...parameters) => {
    if (statement.sql.includes('"categories"') && statement.sql.toLowerCase().startsWith('select')) {
      refreshStarted = true
      await refreshGate.promise
      const result = await originalQueryCompiled(statement, ...parameters)
      refreshFinished = true

      return result
    }

    return await originalQueryCompiled(statement, ...parameters)
  }

  try {
    const staleRead = await withMockedNow(timestamp, async () => await getNavigationCategories())
    assert.equal(staleRead.length, 2)
    await waitForCondition(() => refreshStarted, 'Expected flexible stale refresh query to start.')
    assert.equal(refreshFinished, false)

    refreshGate.resolve()
    await waitForCondition(() => refreshFinished, 'Expected flexible stale refresh query to finish.')
  } finally {
    refreshGate.resolve()
    connection.queryCompiled = originalQueryCompiled
  }
}

try {
  assert.deepEqual(parseTagIds('1, 2, 2, nope, 0, -1, 3'), [1, 2, 3])

  const home = await getHomePageData()
  assert.equal(home.posts.length, 2)
  assert.equal(home.featured?.slug, 'shipping-a-real-holo-blog-on-nuxt')
  assert.equal(home.categories.length, 2)
  assert.equal(home.tags.length, 3)

  const firstUser = await User.with('posts').first()
  assert.ok(firstUser)
  assert.ok(Array.isArray(firstUser.posts))

  const featuredPost = await Post.with('user').where('slug', home.featured?.slug ?? '').first()
  assert.ok(featuredPost?.user)

  const authorActor = { id: featuredPost.user_id, email: 'author@example.com', role: 'author' }
  const editorActor = { id: 'editor-1', email: 'editor@example.com', role: 'editor' }
  const adminActor = { id: 'admin-1', email: 'super-admin@example.com', role: 'admin' }
  const postPolicy = authorization.forUser(authorActor).policy('posts')
  assert.equal(await postPolicy.can('view', featuredPost), true)
  await assert.rejects(
    () => postPolicy.authorize('publish', featuredPost),
    AuthorizationError,
  )
  await authorization.forUser(editorActor).policy('posts').authorize('publish', featuredPost)
  await authorization.forUser(editorActor).authorize('update', featuredPost)
  await authorization.forUser(editorActor).authorize('publish', featuredPost)
  await assert.rejects(
    () => authorization.forUser(editorActor).authorize('delete', featuredPost),
    AuthorizationError,
  )
  await authorization.forUser(adminActor).authorize('delete', featuredPost)
  await assert.rejects(
    () => authorization.guard('admin').authorize('delete', featuredPost),
    AuthorizationError,
  )
  await assert.rejects(
    () => authorization.forUser(authorActor).authorize('manage', Category),
    AuthorizationError,
  )
  await authorization.forUser(editorActor).authorize('manage', Category)
  await authorization.forUser(adminActor).authorize('delete', Category)
  await authorization.forUser(editorActor).authorize('manage', Tag)
  await assert.rejects(
    () => authorization.forUser(authorActor).authorize('moderate', Comment),
    AuthorizationError,
  )
  await authorization.forUser(editorActor).authorize('moderate', Comment)
  await authorization.forUser(adminActor).authorize('moderate', Comment)

  const dashboard = await getAdminDashboardData()
  assert.equal(dashboard.postCount, 2)
  assert.equal(dashboard.publishedCount, 2)
  assert.equal(dashboard.categoryCount, 2)
  assert.equal(dashboard.tagCount, 3)

  const engineeringArchive = await getCategoryArchive('engineering')
  assert.ok(engineeringArchive)
  assert.equal(engineeringArchive.posts.length, 1)
  assert.equal(engineeringArchive.posts[0]?.slug, 'shipping-a-real-holo-blog-on-nuxt')

  const frameworkArchive = await getTagArchive('framework')
  assert.ok(frameworkArchive)
  assert.equal(frameworkArchive.posts.length, 2)

  await blogCache.flush()
  await getCacheRuntimeBindings()?.dependencyIndex?.clear()
  const cachedPublishedPosts = await getPublishedPosts()
  assert.equal(cachedPublishedPosts.length, 2)
  const registeredCacheKeys = await getRegisteredCacheKeys()
  assert.equal(registeredCacheKeys.length, 1)
  assert.equal(await blogCache.has(resolveDriverCacheKey(registeredCacheKeys[0])), true)
  const cachedQueryCount = await countTableSelectQueryExecutions('posts', async () => {
    assert.equal((await getPublishedPosts()).length, 2)
  })
  assert.equal(cachedQueryCount, 0)
  assert.equal(await countRegisteredCacheKeys(), 1)

  await blogCache.flush()
  await getCacheRuntimeBindings()?.dependencyIndex?.clear()
  const flexibleMissQueryCount = await countTableSelectQueryExecutions('categories', async () => {
    assert.equal((await getNavigationCategories()).length, 2)
  })
  assert.equal(flexibleMissQueryCount, 1)
  const registeredFlexibleCacheKeys = await getRegisteredCacheKeys()
  assert.equal(registeredFlexibleCacheKeys.length, 1)
  assert.equal(await blogCache.has(resolveDriverCacheKey(registeredFlexibleCacheKeys[0])), true)
  const flexibleHitQueryCount = await countTableSelectQueryExecutions('categories', async () => {
    assert.equal((await getNavigationCategories()).length, 2)
  })
  assert.equal(flexibleHitQueryCount, 0)
  assert.equal(await countRegisteredCacheKeys(), 1)
  const flexibleCachedAt = Date.now()
  await assertFlexibleStaleRefreshDoesNotBlock(flexibleCachedAt + 61_000)
  const flexibleExpiredQueryCount = await withMockedNow(flexibleCachedAt + 362_000, async () =>
    await countTableSelectQueryExecutions('categories', async () => {
      assert.equal((await getNavigationCategories()).length, 2)
    }),
  )
  assert.equal(flexibleExpiredQueryCount, 1)

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

  const queuedJobsBeforePostLifecycle = await countQueuedBlogIndexJobs()

  await createPost({
    title: 'Logic Coverage Post',
    excerpt: 'Logic excerpt',
    body: 'Logic body',
    status: 'published',
    categoryId: String(updatedCategory.id),
    tagIds: String(frameworkTag.id),
  })
  assert.equal(await countQueuedBlogIndexJobs(), queuedJobsBeforePostLifecycle + 1)
  assert.equal(await countRegisteredCacheKeys(), 0)
  assert.ok((await getPublishedPosts()).some(post => post.slug === 'logic-coverage-post'))

  let logicPost = await Post.with('category', 'tags').where('slug', 'logic-coverage-post').first()
  assert.ok(logicPost)
  assert.equal(logicPost.category?.id, updatedCategory.id)
  assert.equal(logicPost.tags.length, 1)
  assert.equal(logicPost.tags[0]?.id, frameworkTag.id)

  let mediaFailurePost = null
  const entityPrototype = Object.getPrototypeOf(logicPost)
  const originalAddMedia = entityPrototype.addMedia
  entityPrototype.addMedia = function addMediaWithForcedFailure() {
    return {
      toMediaCollection: async () => {
        return {
          error: {
            message: imageUploadFailureMessage,
          },
        }
      },
    }
  }
  try {
    await assert.rejects(async () => await createPost({
      title: 'Media Side Effect Post',
      excerpt: 'Media side effect excerpt',
      body: 'Media side effect body',
      status: 'published',
      categoryId: String(updatedCategory.id),
      tagIds: String(frameworkTag.id),
      image: new Blob(['image'], { type: 'image/png' }),
    }), (error) => {
      assert.equal(isValidationException(error), true)
      assert.deepEqual(error.errors.flatten().image, [imageUploadFailureMessage])
      return true
    })

    mediaFailurePost = await Post.with('category', 'tags').where('slug', 'media-side-effect-post').first()
    assert.ok(mediaFailurePost)
    assert.equal(mediaFailurePost.category?.id, updatedCategory.id)
    assert.equal(mediaFailurePost.tags[0]?.id, frameworkTag.id)

    await assert.rejects(async () => await updatePost(mediaFailurePost.id, {
      title: 'Media Side Effect Post Revised',
      excerpt: 'Updated media side effect excerpt',
      body: 'Updated media side effect body',
      status: 'draft',
      categoryId: '',
      tagIds: String(releaseTag.id),
      image: new Blob(['image'], { type: 'image/png' }),
    }), (error) => {
      assert.equal(isValidationException(error), true)
      assert.deepEqual(error.errors.flatten().image, [imageUploadFailureMessage])
      return true
    })

    mediaFailurePost = await Post.with('category', 'tags').where('id', mediaFailurePost.id).first()
    assert.ok(mediaFailurePost)
    assert.equal(mediaFailurePost.slug, 'media-side-effect-post-revised')
    assert.equal(mediaFailurePost.status, 'draft')
    assert.equal(mediaFailurePost.category, null)
    assert.equal(mediaFailurePost.tags[0]?.id, releaseTag.id)
  } finally {
    entityPrototype.addMedia = originalAddMedia
  }

  await updatePost(logicPost.id, {
    title: 'Logic Coverage Post Revised',
    excerpt: 'Changed excerpt',
    body: 'Changed body',
    status: 'draft',
    categoryId: '',
    tagIds: String(releaseTag.id),
  })
  assert.equal(await countQueuedBlogIndexJobs(), queuedJobsBeforePostLifecycle + 2)
  assert.equal(await countRegisteredCacheKeys(), 0)

  logicPost = await Post.with('category', 'tags').where('id', logicPost.id).first()
  assert.ok(logicPost)
  assert.equal(logicPost.slug, 'logic-coverage-post-revised')
  assert.equal(logicPost.status, 'draft')
  assert.equal(logicPost.category, null)
  assert.equal(logicPost.tags.length, 1)
  assert.equal(logicPost.tags[0]?.id, releaseTag.id)
  assert.equal(await getPublishedPostBySlug('logic-coverage-post-revised'), undefined)

  await createPost({
    title: 'Category Cleanup Post',
    body: 'Category cleanup body',
    status: 'published',
    categoryId: String(updatedCategory.id),
    tagIds: String(frameworkTag.id),
  })

  const cleanupPost = await Post.where('slug', 'category-cleanup-post').first()
  assert.ok(cleanupPost)

  await deleteCategory(updatedCategory.id)
  const uncategorizedPost = await Post.findOrFail(cleanupPost.id)
  assert.equal(uncategorizedPost.category_id, null)
  assert.equal(await Category.find(updatedCategory.id), undefined)

  await deletePost(logicPost.id)
  assert.equal(await countQueuedBlogIndexJobs(), queuedJobsBeforePostLifecycle + 4)
  await deletePost(cleanupPost.id)
  if (mediaFailurePost) {
    await deletePost(mediaFailurePost.id)
  }
  assert.equal(await Post.find(logicPost.id), undefined)
  assert.equal(await Post.find(cleanupPost.id), undefined)
  if (mediaFailurePost) {
    assert.equal(await Post.find(mediaFailurePost.id), undefined)
  }

  await deleteTag(updatedTag.id)
  assert.equal(await Tag.find(updatedTag.id), undefined)

  const categories = await getAdminCategoriesData()
  const tags = await getAdminTagsData()
  const posts = await getAdminPostsData()
  assert.equal(categories.categories.length, 2)
  assert.equal(tags.tags.length, 3)
  assert.equal(posts.posts.length, 2)
} finally {
  await project.runtime.shutdown()
}
