import { assertExampleAppPivotBehavior } from '../../../tests/example-app-pivot.mjs'
import { broadcastRaw } from '@holo-js/broadcast'
import { assertExampleAppQueueMaintenance } from '../../../tests/example-app-maintenance.mjs'
import assert from 'node:assert/strict'

import authorization, { AuthorizationError } from '@holo-js/authorization'
import cache from '@holo-js/cache'
import { assertExampleAppCacheBehavior } from '../../../tests/example-app-cache.mjs'
import { initializeHoloAdapterProject } from '@holo-js/core'
import { DB, createSchemaService } from '@holo-js/db'
import IndexBlogPost from '../server/jobs/blog/index-post.ts'

import Category from '../server/models/Category.ts'
import Comment from '../server/models/Comment.ts'
import Post from '../server/models/Post.ts'
import Tag from '../server/models/Tag.ts'
import User from '../server/models/User.ts'
import {
  createCategory,
  createTag,
  deleteCategory,
  deleteTag,
  getAdminCategoriesData,
  getAdminDashboardData,
  getAdminPostsData,
  getAdminTagsData,
  getCategoryArchive,
  getHomePageData,
  getNavigationCategories,
  getPublishedPosts,
  getTagArchive,
  parseTagIds,
  updateCategory,
  updateTag,
} from '../src/lib/server/blog.ts'

const project = await initializeHoloAdapterProject(process.cwd())
try {
  await assertExampleAppPivotBehavior(Post, Tag, DB)
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
  assert.equal(engineeringArchive.posts[0]?.slug, 'shipping-a-real-holo-blog-on-sveltekit')

  const frameworkArchive = await getTagArchive('framework')
  assert.ok(frameworkArchive)
  assert.equal(frameworkArchive.posts.length, 2)

  await assertExampleAppCacheBehavior(cache, Category)
  assert.equal((await getPublishedPosts()).length, 2)
  assert.equal((await getNavigationCategories()).length, 2)

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

  assert.ok((await getNavigationCategories()).some(category => category.slug === 'platform-systems'))
  await deleteCategory(updatedCategory.id)
  await deleteTag(updatedTag.id)
  assert.equal(await Category.find(updatedCategory.id), undefined)
  assert.equal(await Tag.find(updatedTag.id), undefined)
  assert.equal((await getAdminCategoriesData()).categories.length, 2)
  assert.equal((await getAdminTagsData()).tags.length, 3)
  assert.equal((await getAdminPostsData()).posts.length, 2)
  await IndexBlogPost.dispatch({ action: 'updated', postId: featuredPost.id })
  await assertExampleAppQueueMaintenance(DB, IndexBlogPost, featuredPost, broadcastRaw, createSchemaService)
} finally {
  await project.runtime.shutdown()
}
