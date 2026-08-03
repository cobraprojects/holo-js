import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { get } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_SESSION_COOKIE_NAME } from '@holo-js/session'
import Database from 'better-sqlite3'
import { assertExampleAppAuthFlow } from '../../../tests/example-app-auth-flow.mjs'
import { closeExampleAppBrowser } from '../../../tests/example-app-browser.mjs'
import { assertExampleAppBroadcastBrowserFlow } from '../../../tests/example-app-broadcast-browser-flow.mjs'
import { assertExampleAppProductionFlow } from '../../../tests/example-app-production-flow.mjs'
import { clearExampleAppRateLimitBuckets } from '../../../tests/example-app-rate-limit.mjs'
import { assertExampleAppRealtimeBrowserFlow, assertExampleAppRealtimeUnavailableBrowserFlow } from '../../../tests/example-app-realtime-browser-flow.mjs'
import { assertExampleAppTokenAuthFlow } from '../../../tests/example-app-token-auth-flow.mjs'

const cwd = process.cwd()
const configPath = join(cwd, 'config/app.ts')
const configCachePath = join(cwd, '.holo-js/generated/config-cache.json')
const databasePath = join(cwd, 'storage/database.sqlite')
const port = await new Promise((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') {
      reject(new Error('Could not determine an available port.'))
      return
    }

    const selected = String(address.port)
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve(selected)
    })
  })
})
async function getAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Could not determine an available port.'))
        return
      }

      const selected = String(address.port)
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }

        resolve(selected)
      })
    })
  })
}
const broadcastPort = await getAvailablePort()
const originalConfig = await readFile(configPath, 'utf8')
const mirrorCapturedOutput = process.env.MAIL_LOG_VERBOSE === 'true'
  || process.argv.includes('--mail-log-verbose')
const runtimeSchemaPath = join(cwd, '.holo-js/generated/schema.mjs')
const pngPixel = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])
const oversizedImage = new Uint8Array((2 * 1024 * 1024) + 1)
let capturedOutput = ''

function createChildEnv(overrides = {}) {
  const env = {
    ...process.env,
    APP_NAME: '',
    HOLO_SECURITY_TRUST_PROXY: 'true',
    BROADCAST_HOST: '127.0.0.1',
    BROADCAST_PORT: broadcastPort,
    ...overrides,
  }

  if (existsSync(runtimeSchemaPath)) {
    const preload = `--import=${pathToFileURL(runtimeSchemaPath).href}`
    env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${preload}` : preload
  }

  return env
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: createChildEnv(),
      stdio: 'inherit',
    })

    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(`Command failed: ${command} ${args.join(' ')} (${code})`))
    })
  })
}

async function waitForText(url, predicate, timeoutMs = 30000) {
  const startedAt = Date.now()
  let lastError = null

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = await new Promise((resolve, reject) => {
        const request = get(url, (response) => {
          let body = ''
          response.setEncoding('utf8')
          response.on('data', chunk => {
            body += chunk
          })
          response.on('end', () => {
            if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
              reject(new Error(`Unexpected status ${response.statusCode ?? 'unknown'}`))
              return
            }

            resolve(body)
          })
        })

        request.on('error', reject)
      })

      if (predicate(payload)) {
        return payload
      }
    } catch (error) {
      lastError = error
    }

    await new Promise(resolve => setTimeout(resolve, 250))
  }

  throw new Error(`Timed out waiting for ${url}${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

async function waitForRedirect(url, expectedPath, timeoutMs = 30000) {
  const startedAt = Date.now()
  let lastError = null

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: 'manual' })
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location) {
        const locationPath = new URL(location, url).pathname
        if (locationPath === expectedPath) {
          return
        }

        lastError = new Error(`Unexpected redirect ${response.status} to ${locationPath}`)
      } else {
        lastError = new Error(`Unexpected status ${response.status}`)
      }
    } catch (error) {
      lastError = error
    }

    await new Promise(resolve => setTimeout(resolve, 250))
  }

  throw new Error(`Timed out waiting for ${url} to redirect to ${expectedPath}${lastError instanceof Error ? `: ${lastError.message}` : ''}`)
}

function countCacheRows() {
  const database = new Database(databasePath, { readonly: true })
  try {
    return database.prepare('select count(*) as count from cache').get().count
  } finally {
    database.close()
  }
}

function getUploadedPostImage(title) {
  const database = new Database(databasePath, { readonly: true })
  try {
    const post = database.prepare('select id, slug from posts where title = ?').get(title)
    assert.ok(post, 'Expected the uploaded-image post to exist.')

    const mediaRows = database.prepare('select path, generated_conversions from media where model_id = ? and collection_name = ?').all(String(post.id), 'images')
    assert.equal(mediaRows.length, 1, 'Expected the post image collection to keep exactly one image.')
    const media = mediaRows[0]
    assert.ok(media, 'Expected the uploaded post image to create a media record.')
    assert.ok(existsSync(join(cwd, 'storage/app/public', media.path)), 'Expected the original image to be stored on the public disk.')

    const conversions = typeof media.generated_conversions === 'string'
      ? JSON.parse(media.generated_conversions)
      : media.generated_conversions
    const thumb = conversions.thumb
    assert.ok(thumb?.path, 'Expected the image thumbnail conversion to be recorded.')
    assert.ok(existsSync(join(cwd, 'storage/app/public', thumb.path)), 'Expected the image thumbnail conversion to be stored on the public disk.')

    return {
      id: post.id,
      slug: post.slug,
      thumbUrl: `/storage/${thumb.path}`,
    }
  } finally {
    database.close()
  }
}

function getPostByTitle(title) {
  const database = new Database(databasePath, { readonly: true })
  try {
    const post = database.prepare('select id, slug from posts where title = ?').get(title)
    assert.ok(post, `Expected post "${title}" to exist.`)
    return post
  } finally {
    database.close()
  }
}

function countPostImages(postId) {
  const database = new Database(databasePath, { readonly: true })
  try {
    return database.prepare('select count(*) as count from media where model_id = ? and collection_name = ?').get(String(postId), 'images').count
  } finally {
    database.close()
  }
}

function assignPostAuthor(postId, userId) {
  const database = new Database(databasePath)
  try {
    database.prepare('update posts set user_id = ? where id = ?').run(userId, postId)
  } finally {
    database.close()
  }
}

async function assertPublicImageUrlResponds(baseUrl, imageUrl) {
  const response = await fetch(new URL(imageUrl, baseUrl))
  assert.equal(response.status, 200)
  const body = await response.arrayBuffer()
  assert.ok(body.byteLength > 0, 'Expected the public image endpoint to return image bytes.')
}

async function assertAdminPostEndpointReturnsImage({ baseUrl, fetchJson, jar, postId, title, imageUrl }) {
  const result = await fetchJson(`/api/admin/posts/${postId}`, { jar })
  assert.equal(result.json.post.title, title)
  assert.equal(new URL(result.json.imageUrl, baseUrl).pathname, new URL(imageUrl, baseUrl).pathname)
  await assertPublicImageUrlResponds(baseUrl, imageUrl)
}

async function assertAdminApiRequiresAuthentication(baseUrl) {
  const response = await fetch(`${baseUrl}/api/admin/dashboard`)
  assert.equal(response.status, 403)
}

async function assertConfigCacheCommands() {
  await run('bun', ['run', 'config:cache'])
  assert.equal(existsSync(configCachePath), true)
  assert.ok((await readFile(configCachePath, 'utf8')).includes('blog-nuxt'))

  await run('bun', ['run', 'config:clear'])
  assert.equal(existsSync(configCachePath), false)
}

async function assertCacheBackedHttpBehavior(baseUrl) {
  await run('bun', ['x', 'holo', 'cache:clear'])
  assert.equal(countCacheRows(), 0)

  await waitForText(`${baseUrl}/`, payload => payload.includes('Shipping a Real Holo Blog on Nuxt'))
  const homeCacheRows = countCacheRows()
  assert.ok(homeCacheRows >= 1, 'Expected the home page request to store query cache rows.')

  await waitForText(`${baseUrl}/posts`, payload => payload.includes('Shipping a Real Holo Blog on Nuxt'))
  assert.ok(countCacheRows() >= homeCacheRows, 'Expected the posts page request to reuse existing query cache rows.')

  await run('bun', ['x', 'holo', 'cache:clear'])
  assert.equal(countCacheRows(), 0)

  await waitForText(`${baseUrl}/`, payload => payload.includes('Shipping a Real Holo Blog on Nuxt'))
  assert.ok(countCacheRows() >= 1, 'Expected cache rows to be recreated after cache clear.')
}

async function assertSuperAdminLogoutStillNavigatesAfterRefreshFailure() {
  const source = await readFile(join(cwd, 'app/pages/super-admin/index.vue'), 'utf8')
  const refreshWarning = "console.warn('Super admin auth refresh failed after logout.', error)"
  const navigation = "await navigateTo('/super-admin/login')"

  assert.ok(
    source.includes(refreshWarning),
    'Expected super-admin logout to treat post-logout auth refresh failures as non-blocking.',
  )
  assert.ok(
    source.indexOf(navigation) > source.indexOf(refreshWarning),
    'Expected super-admin logout to navigate after the best-effort auth refresh.',
  )
}

async function assertHeaderLogoutStillNavigatesAfterRefreshFailure() {
  const source = await readFile(join(cwd, 'app/app.vue'), 'utf8')
  const refreshWarning = "console.warn('Auth refresh failed after logout.', error)"
  const navigation = "await navigateTo('/')"

  assert.ok(
    source.includes(refreshWarning),
    'Expected header logout to treat post-logout auth refresh failures as non-blocking.',
  )
  assert.ok(
    source.indexOf(navigation) > source.indexOf(refreshWarning),
    'Expected header logout to navigate after the best-effort auth refresh.',
  )
}

async function assertSuperAdminLoginUsesVerificationRedirect() {
  const source = await readFile(join(cwd, 'server/api/super-admin/login.post.ts'), 'utf8')
  assert.ok(
    source.includes('session.emailVerificationRequired'),
    'Expected super-admin login to branch on email verification state.',
  )
  assert.ok(
    source.includes("session.emailVerificationRoute ?? '/verify-email'"),
    'Expected unverified super-admin login to redirect to the email verification route.',
  )
  assert.ok(
    source.includes(": '/super-admin'"),
    'Expected verified super-admin login to keep the dashboard redirect.',
  )
}

async function assertAuthenticatedUserCannotDeletePost({ baseUrl, jar, fetchText }) {
  const postsPage = await fetchText('/admin/posts', { jar })
  const postId = postsPage.text.match(/\/admin\/posts\/(\d+)\/delete/)?.[1]
  assert.ok(postId, 'Expected the admin posts page to render a delete form with a post id.')

  const denied = await fetchText(`/admin/posts/${postId}/delete`, {
    method: 'POST',
    headers: {
      origin: baseUrl,
    },
    jar,
    allowFailure: true,
  })
  assert.equal(denied.response.status, 403, denied.text)
}

async function assertAuthenticatedUserCanCreateAndUpdatePostImage({ baseUrl, jar, fetchText, fetchJson }) {
  const noImageTitle = `User flow no image ${Date.now()}`
  const noImageFormData = new FormData()
  noImageFormData.set('title', noImageTitle)
  noImageFormData.set('excerpt', 'Created without selecting an image.')
  noImageFormData.set('body', 'This post exercises optional file validation through the real Nuxt route flow.')
  noImageFormData.set('status', 'draft')
  noImageFormData.set('categoryId', '')
  noImageFormData.set('image', new Blob([], { type: 'application/octet-stream' }), '')

  const createdWithoutImage = await fetchText('/admin/posts/create', {
    method: 'POST',
    body: noImageFormData,
    headers: {
      origin: baseUrl,
    },
    jar,
    allowFailure: true,
  })
  assert.equal(createdWithoutImage.response.status, 303, createdWithoutImage.text)
  assert.equal(new URL(createdWithoutImage.response.headers.get('location'), baseUrl).pathname, '/admin/posts')

  const postWithoutImage = getPostByTitle(noImageTitle)
  assert.equal(countPostImages(postWithoutImage.id), 0, 'Expected creating without selecting an image to skip media records.')

  const oversizedFormData = new FormData()
  oversizedFormData.set('title', `Oversized image ${Date.now()}`)
  oversizedFormData.set('excerpt', 'Created through the real Nuxt route flow.')
  oversizedFormData.set('body', 'This post should return a media validation failure.')
  oversizedFormData.set('status', 'draft')
  oversizedFormData.set('categoryId', '')
  oversizedFormData.set('image', new Blob([oversizedImage], { type: 'image/png' }), 'too-large.png')

  const oversized = await fetchJson('/admin/posts/create', {
    method: 'POST',
    body: oversizedFormData,
    headers: { origin: baseUrl },
    jar,
    allowFailure: true,
  })
  assert.equal(oversized.response.status, 422)
  assert.equal(oversized.json.ok, false)
  assert.equal(oversized.json.valid, false)
  assert.deepEqual(
    oversized.json.errors?.image,
    ['The selected file must be 2 MB or smaller.'],
    'Expected the useForm submission path to return the oversized image validation error.',
  )

  const title = `User flow image ${Date.now()}`
  const formData = new FormData()
  formData.set('title', title)
  formData.set('excerpt', 'Created through the real Nuxt route flow.')
  formData.set('body', 'This post exercises image upload through the real Nuxt route flow.')
  formData.set('status', 'draft')
  formData.set('categoryId', '')
  formData.set('image', new Blob([pngPixel], { type: 'image/png' }), 'draft.png')

  const created = await fetchText('/admin/posts/create', {
    method: 'POST',
    body: formData,
    headers: {
      origin: baseUrl,
    },
    jar,
    allowFailure: true,
  })
  assert.equal(created.response.status, 303, created.text)
  assert.equal(new URL(created.response.headers.get('location'), baseUrl).pathname, '/admin/posts')

  const postsPage = await fetchText('/admin/posts', { jar })
  assert.ok(postsPage.text.includes(title), 'Expected the admin posts page to show the created post.')

  const uploaded = getUploadedPostImage(title)
  await assertAdminPostEndpointReturnsImage({
    baseUrl,
    fetchJson,
    jar,
    postId: uploaded.id,
    title,
    imageUrl: uploaded.thumbUrl,
  })

  const editPage = await fetchText(`/admin/posts/${uploaded.id}/edit`, { jar })
  assert.ok(editPage.text.includes(uploaded.thumbUrl), 'Expected the edit endpoint to render the current post image.')

  const currentUser = await fetchJson('/api/auth/user', { jar })
  assert.ok(currentUser.json.user?.id, 'Expected the authenticated user endpoint to return a user id.')
  assignPostAuthor(uploaded.id, currentUser.json.user.id)

  const updateWithoutImageFormData = new FormData()
  updateWithoutImageFormData.set('title', title)
  updateWithoutImageFormData.set('excerpt', 'Updated without selecting a replacement image.')
  updateWithoutImageFormData.set('body', 'This post exercises optional file validation during update through the real Nuxt route flow.')
  updateWithoutImageFormData.set('status', 'draft')
  updateWithoutImageFormData.set('categoryId', '')
  updateWithoutImageFormData.set('image', new Blob([], { type: 'application/octet-stream' }), '')

  const updatedWithoutImage = await fetchText(`/admin/posts/${uploaded.id}/update`, {
    method: 'POST',
    body: updateWithoutImageFormData,
    headers: {
      origin: baseUrl,
      referer: `${baseUrl}/admin/posts/${uploaded.id}/edit`,
    },
    jar,
    allowFailure: true,
  })
  assert.equal(updatedWithoutImage.response.status, 303, updatedWithoutImage.text)
  assert.equal(new URL(updatedWithoutImage.response.headers.get('location'), baseUrl).pathname, '/admin/posts')
  assert.equal(countPostImages(uploaded.id), 1, 'Expected updating without a replacement image to keep the existing image.')
}

async function assertAuthenticatedAdminPostFlows(context) {
  await stopProcessTree(broadcastChild)
  broadcastChild = null
  await assertExampleAppRealtimeUnavailableBrowserFlow({
    baseUrl: context.baseUrl,
    cookieHeader: context.jar.header(),
  })
  await startBroadcastWorker(context.baseUrl)
  await assertExampleAppBroadcastBrowserFlow({
    baseUrl: context.baseUrl,
    appName: 'blog-nuxt',
    cookieHeader: context.jar.header(),
  })
  await assertAuthenticatedUserCanCreateAndUpdatePostImage(context)
  await assertExampleAppRealtimeBrowserFlow({
    baseUrl: context.baseUrl,
    appName: 'blog-nuxt',
    cookieHeader: context.jar.header(),
  })
  await assertAuthenticatedUserCannotDeletePost(context)
}

function pipeOutput(stream, target) {
  if (!stream) {
    return
  }

  stream.on('data', chunk => {
    const text = chunk.toString()
    capturedOutput += text
    if (mirrorCapturedOutput) {
      target.write(text)
    }
  })
}

let child = null
let broadcastChild = null

function killProcessTree(target) {
  if (!target || target.exitCode !== null) {
    return
  }

  try {
    process.kill(-target.pid, 'SIGTERM')
  } catch {
    try {
      target.kill('SIGTERM')
    } catch {
      return
    }
  }
}

async function stopProcessTree(target) {
  if (!target || target.exitCode !== null) {
    return
  }

  const closed = new Promise(resolve => target.once('close', resolve))
  killProcessTree(target)
  await closed
}

async function startBroadcastWorker(appUrl) {
  if (broadcastChild) {
    return
  }

  broadcastChild = spawn('bun', ['x', 'holo', 'broadcast:work'], {
    cwd,
    detached: true,
    env: createChildEnv({
      APP_URL: appUrl,
    }),
    stdio: ['inherit', 'pipe', 'pipe'],
  })
  pipeOutput(broadcastChild.stdout, process.stdout)
  pipeOutput(broadcastChild.stderr, process.stderr)
  await waitForText(`http://127.0.0.1:${broadcastPort}/health`, payload => payload.includes('"ok":true'))
}

try {
  await assertSuperAdminLogoutStillNavigatesAfterRefreshFailure()
  await assertHeaderLogoutStillNavigatesAfterRefreshFailure()
  await assertSuperAdminLoginUsesVerificationRedirect()
  await run('bun', ['run', 'prepare'])
  await assertConfigCacheCommands()
  await run('bun', ['x', 'holo', 'migrate:fresh', '--seed'])
  await clearExampleAppRateLimitBuckets(cwd)
  await startBroadcastWorker(`http://localhost:${port}`)
  await run('npx', ['tsx', 'tests/blog-logic.mjs'])

  child = spawn('bun', ['run', 'dev'], {
    cwd,
    detached: true,
    env: createChildEnv({
      PORT: port,
      HOST: 'localhost',
      NITRO_HOST: 'localhost',
      APP_URL: `http://localhost:${port}`,
      MAIL_MAILER: 'log',
      MAIL_LOG_BODIES: 'true',
    }),
    stdio: ['inherit', 'pipe', 'pipe'],
  })
  pipeOutput(child.stdout, process.stdout)
  pipeOutput(child.stderr, process.stderr)

  await waitForText(`http://localhost:${port}/`, payload => payload.includes('Shipping a Real Holo Blog on Nuxt'))
  await startBroadcastWorker(`http://localhost:${port}`)
  await assertCacheBackedHttpBehavior(`http://localhost:${port}`)
  await waitForRedirect(`http://localhost:${port}/admin/posts`, '/login')
  await assertAdminApiRequiresAuthentication(`http://localhost:${port}`)
  await assertExampleAppAuthFlow({
    baseUrl: `http://localhost:${port}`,
    getOutput: () => capturedOutput,
    appName: 'blog-nuxt',
    sessionCookieName: DEFAULT_SESSION_COOKIE_NAME,
    loginRequiresCsrf: true,
    afterAuthenticated: assertAuthenticatedAdminPostFlows,
  })
  await assertExampleAppTokenAuthFlow({
    baseUrl: `http://localhost:${port}`,
    expectedTitle: 'Shipping a Real Holo Blog on Nuxt',
  })

  await writeFile(configPath, originalConfig.replace("name: env('APP_NAME', 'blog-nuxt')", "name: env('APP_NAME', 'blog-nuxt-updated')"))
  await waitForText(`http://localhost:${port}/`, payload => payload.includes('Shipping a Real Holo Blog on Nuxt'))

  await stopProcessTree(child)
  child = null
  await stopProcessTree(broadcastChild)
  broadcastChild = null
  await closeExampleAppBrowser()

  await run('bun', ['run', 'lint'])
  await run('bun', ['run', 'typecheck'])
  await run('bun', ['run', 'build'])
  await assertExampleAppProductionFlow({
    cwd,
    baseUrl: `http://localhost:${port}`,
    env: createChildEnv({
      PORT: port,
      HOST: 'localhost',
      NITRO_HOST: 'localhost',
      APP_URL: `http://localhost:${port}`,
      MAIL_MAILER: 'log',
      MAIL_LOG_BODIES: 'true',
    }),
    expectedTitle: 'Shipping a Real Holo Blog on Nuxt',
    auth: {
      appName: 'blog-nuxt-production',
      sessionCookieName: DEFAULT_SESSION_COOKIE_NAME,
      loginRequiresCsrf: true,
    },
  })
} finally {
  await closeExampleAppBrowser()
  await writeFile(configPath, originalConfig)
  await stopProcessTree(child)
  await stopProcessTree(broadcastChild)
}
