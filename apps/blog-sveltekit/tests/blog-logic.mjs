import assert from 'node:assert/strict'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { authRuntimeInternals, hashPassword, verifyPassword } from '@holo-js/auth'
import authorization, { AuthorizationError, authorizationInternals } from '@holo-js/authorization'
import cache, { configureCacheRuntime, getCacheRuntimeBindings } from '@holo-js/cache'
import { initializeHoloAdapterProject } from '@holo-js/core'
import { DB } from '@holo-js/db'
import { isValidationException } from '@holo-js/forms'

import Category from '../server/models/Category.ts'
import Admin from '../server/models/Admin.ts'
import Comment from '../server/models/Comment.ts'
import Post from '../server/models/Post.ts'
import Tag from '../server/models/Tag.ts'
import User from '../server/models/User.ts'
import { actions as updateTagPageActions } from '../src/routes/admin/tags/[id]/edit/+page.server.ts'
import { actions as createTagPageActions } from '../src/routes/admin/tags/+page.server.ts'
import { actions as updatePostPageActions } from '../src/routes/admin/posts/[id]/edit/+page.server.ts'
import { actions as createPostPageActions } from '../src/routes/admin/posts/new/+page.server.ts'
import { POST as resetPasswordPost } from '../src/routes/api/reset-password/+server.ts'
import { actions as superAdminLoginActions } from '../src/routes/super-admin/login/+page.server.ts'
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
  getNavigationCategories,
  getPublishedPosts,
  getPublishedPostBySlug,
  getTagArchive,
  parseTagIds,
  updateCategory,
  updateTag,
} from '../src/lib/server/blog.ts'

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

let csrfSigningKey = null

async function loadCsrfSigningKey() {
  if (csrfSigningKey) {
    return csrfSigningKey
  }

  if (process.env.APP_KEY?.trim()) {
    csrfSigningKey = process.env.APP_KEY.trim()
    return csrfSigningKey
  }

  const envSource = await readFile(`${process.cwd()}/.env`, 'utf8')
  const appKey = envSource.match(/^APP_KEY=(.*)$/m)?.[1]?.trim()
  if (!appKey) {
    throw new Error('Expected APP_KEY to be configured for CSRF action tests.')
  }

  csrfSigningKey = appKey.replace(/^['"]|['"]$/g, '')
  return csrfSigningKey
}

async function createCsrfToken() {
  const nonce = randomBytes(32).toString('base64url')
  const signature = createHmac('sha256', await loadCsrfSigningKey())
    .update(nonce)
    .digest('base64url')

  return `${nonce}.${signature}`
}

function createActionRequest(fields) {
  const formData = new FormData()
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === 'undefined') {
      continue
    }

    if (value instanceof Blob) {
      formData.set(name, value, 'upload.png')
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

async function createCsrfActionRequest(path, fields) {
  const csrfToken = await createCsrfToken()
  const request = createApiRequest(path, {
    ...fields,
    _token: csrfToken,
  })
  request.headers.set('cookie', `XSRF-TOKEN=${encodeURIComponent(csrfToken)}`)

  return request
}

function assertInvalidPostStatusFailure(error) {
  assert.equal(isValidationException(error), true)
  assert.deepEqual(error.errors.flatten().status, ['Select a valid post status.'])
  return true
}

function assertInvalidTagNameFailure(error) {
  assert.equal(isValidationException(error), true)
  assert.deepEqual(error.errors.flatten().name, ['Tag name is required.'])
  return true
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

async function signInEditor() {
  const editor = await User.where('email', 'editor@example.com').firstOrFail()
  const adminActor = { id: 'admin-guard-1', email: 'admin-guard@example.com', role: 'admin' }
  authorizationInternals.configureAuthorizationAuthIntegration({
    hasGuard: guardName => ['admin', 'api', 'web'].includes(guardName),
    resolveDefaultActor: () => editor,
    resolveGuardActor: (guardName) => {
      if (guardName === 'web') return editor
      if (guardName === 'admin') return adminActor
      return null
    },
  })
}

async function createPost(fields) {
  await signInEditor()
  await expectRedirect(() => createPostPageActions.create({
    request: createActionRequest(fields),
  }))
}

async function updatePost(id, fields) {
  await signInEditor()
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
  await assert.rejects(async () => await resetPasswordPost({
    request: createApiRequest('/api/reset-password', {}),
  }), (error) => {
    assert.equal(isValidationException(error), true)
    assertFieldFailure({ body: error.toJSON() }, ['token', 'password', 'passwordConfirmation'])
    return true
  })

  await assert.rejects(async () => await resetPasswordPost({
    request: createApiRequest('/api/reset-password', {
      token: 'bad-token',
      password: 'secret-secret-2',
      passwordConfirmation: 'secret-secret-2',
    }),
  }), (error) => {
    assert.equal(isValidationException(error), true)
    assertFieldFailure({ body: error.toJSON() }, ['token'])
    return true
  })

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
  try {
    const result = await superAdminLoginActions.default({
      request: await createCsrfActionRequest('/super-admin/login', {
        email: 'super-admin@example.com',
        password: 'admin-secret',
      }),
    })
    assert.ok([422, 429].includes(result.status))
  } catch (error) {
    assert.deepEqual({
      status: error.status,
      location: error.location,
    }, {
      status: 303,
      location: '/super-admin',
    })
  }

  const email = `unverified-admin-${Date.now()}@app.test`
  const passwordHash = await hashPassword('admin-secret')
  await Admin.unguarded(() => Admin.create({
    name: 'Unverified Super Admin',
    email,
    password: passwordHash,
    avatar: null,
    email_verified_at: null,
  }))

  try {
    const result = await superAdminLoginActions.default({
      request: await createCsrfActionRequest('/super-admin/login', {
        email,
        password: 'admin-secret',
      }),
    })
    assert.ok([422, 429].includes(result.status))
  } catch (error) {
    assert.deepEqual({
      status: error.status,
      location: error.location,
    }, {
      status: 303,
      location: `/verify-email?email=${encodeURIComponent(email)}`,
    })
  }
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
  await assert.rejects(
    () => authorization.guard('admin').authorize('delete', featuredPost),
    AuthorizationError,
  )
  await signInEditor()
  await authorization.guard('admin').authorize('delete', featuredPost)

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

  await signInEditor()
  await assert.rejects(async () => await createTagPageActions.create({
    request: createActionRequest({
      name: '',
    }),
  }), assertInvalidTagNameFailure)
  assert.equal(await Tag.where('slug', '').first(), undefined)

  await signInEditor()
  await assert.rejects(async () => await updateTagPageActions.update({
    params: { id: String(updatedTag.id) },
    request: createActionRequest({
      name: '',
    }),
  }), assertInvalidTagNameFailure)
  const retainedTag = await Tag.findOrFail(updatedTag.id)
  assert.equal(retainedTag.slug, 'deep-guides')

  const frameworkTag = await Tag.where('slug', 'framework').first()
  const releaseTag = await Tag.where('slug', 'release').first()
  assert.ok(frameworkTag)
  assert.ok(releaseTag)

  await signInEditor()
  await assert.rejects(async () => await createPostPageActions.create({
    request: createActionRequest({
      title: 'Missing Route Status Post',
      body: 'Missing status body',
    }),
  }), assertInvalidPostStatusFailure)
  assert.equal(await Post.where('slug', 'missing-route-status-post').first(), undefined)

  await signInEditor()
  await assert.rejects(async () => await createPostPageActions.create({
    request: createActionRequest({
      title: 'Unknown Route Status Post',
      body: 'Unknown status body',
      status: 'archived',
    }),
  }), assertInvalidPostStatusFailure)
  assert.equal(await Post.where('slug', 'unknown-route-status-post').first(), undefined)

  await createPost({
    title: 'Logic Coverage Post',
    excerpt: 'Logic excerpt',
    body: 'Logic body',
    status: 'published',
    categoryId: String(updatedCategory.id),
    tagIds: [frameworkTag.id],
  })
  assert.equal(await countRegisteredCacheKeys(), 0)
  await getPublishedPosts()
  assert.equal(await countRegisteredCacheKeys(), 1)

  let logicPost = await Post.with('category', 'tags').where('slug', 'logic-coverage-post').first()
  assert.ok(logicPost)
  assert.equal(logicPost.category?.id, updatedCategory.id)
  assert.equal(logicPost.tags.length, 1)
  assert.equal(logicPost.tags[0]?.id, frameworkTag.id)
  assert.ok(logicPost.published_at)

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
    await signInEditor()
    await assert.rejects(async () => await createPostPageActions.create({
      request: createActionRequest({
        title: 'Media Side Effect Post',
        excerpt: 'Media side effect excerpt',
        body: 'Media side effect body',
        status: 'published',
        categoryId: String(updatedCategory.id),
        tagIds: [frameworkTag.id],
        image: new Blob(['image'], { type: 'image/png' }),
      }),
    }), (error) => {
      assert.equal(isValidationException(error), true)
      assert.deepEqual(error.errors.flatten().image, [imageUploadFailureMessage])
      return true
    })

    mediaFailurePost = await Post.with('category', 'tags').where('slug', 'media-side-effect-post').first()
    assert.ok(mediaFailurePost)
    assert.equal(mediaFailurePost.category?.id, updatedCategory.id)
    assert.equal(mediaFailurePost.tags[0]?.id, frameworkTag.id)

    await signInEditor()
    await assert.rejects(async () => await updatePostPageActions.update({
      params: { id: String(mediaFailurePost.id) },
      request: createActionRequest({
        title: 'Media Side Effect Post Revised',
        excerpt: 'Updated media side effect excerpt',
        body: 'Updated media side effect body',
        status: 'draft',
        categoryId: '',
        tagIds: [releaseTag.id],
        image: new Blob(['image'], { type: 'image/png' }),
      }),
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

  const originalPublishedAt = logicPost.published_at

  await updatePost(logicPost.id, {
    title: 'Logic Coverage Post',
    excerpt: 'Still published',
    body: 'Still published body',
    status: 'published',
    categoryId: String(updatedCategory.id),
    tagIds: [frameworkTag.id],
  })
  assert.equal(await countRegisteredCacheKeys(), 0)
  await getPublishedPosts()
  assert.equal(await countRegisteredCacheKeys(), 1)

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

  await signInEditor()
  await assert.rejects(async () => await updatePostPageActions.update({
    params: { id: String(routeStatusPost.id) },
    request: createActionRequest({
      title: 'Route Status Published',
      body: 'Published body',
    }),
  }), assertInvalidPostStatusFailure)
  routeStatusPost = await Post.findOrFail(routeStatusPost.id)
  assert.equal(routeStatusPost.status, 'draft')
  assert.equal(routeStatusPost.title, 'Route Status Draft')

  await signInEditor()
  await assert.rejects(async () => await updatePostPageActions.update({
    params: { id: String(routeStatusPost.id) },
    request: createActionRequest({
      title: 'Route Status Published',
      body: 'Published body',
      status: 'archived',
    }),
  }), assertInvalidPostStatusFailure)
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
  assert.equal(await countRegisteredCacheKeys(), 0)

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
  if (mediaFailurePost) {
    await deletePost(mediaFailurePost.id)
  }
  for (const post of concurrentPosts) {
    await deletePost(post.id)
  }
  assert.equal(await Post.find(logicPost.id), undefined)
  assert.equal(await Post.find(cleanupPost.id), undefined)
  assert.equal(await Post.find(routeStatusPost.id), undefined)
  if (mediaFailurePost) {
    assert.equal(await Post.find(mediaFailurePost.id), undefined)
  }
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
