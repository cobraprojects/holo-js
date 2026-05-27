import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { get } from 'node:http'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_SESSION_COOKIE_NAME } from '@holo-js/config'
import Database from 'better-sqlite3'
import { assertExampleAppAuthFlow } from '../../../tests/example-app-auth-flow.mjs'
import { assertExampleAppTokenAuthFlow } from '../../../tests/example-app-token-auth-flow.mjs'

const cwd = process.cwd()
const configPath = join(cwd, 'config/app.ts')
const configCachePath = join(cwd, '.holo-js/generated/config-cache.json')
const databasePath = join(cwd, 'storage/database.sqlite')
const originalConfig = await readFile(configPath, 'utf8')
const runtimeSchemaPath = join(cwd, '.holo-js/generated/schema.mjs')
const escapeCharacter = String.fromCharCode(27)
const ansiEscapePattern = new RegExp(`${escapeCharacter}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])`, 'g')
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
let capturedOutput = ''

function createChildEnv(overrides = {}) {
  const env = {
    ...process.env,
    APP_NAME: '',
    HOLO_SECURITY_TRUST_PROXY: 'true',
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

async function waitForJson(url, predicate, timeoutMs = 30000) {
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

            try {
              resolve(JSON.parse(body))
            } catch (error) {
              reject(error)
            }
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
    const remainingMs = timeoutMs - (Date.now() - startedAt)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.max(100, Math.min(remainingMs, 5000)))
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: controller.signal,
      })
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
    } finally {
      clearTimeout(timeout)
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

async function assertAdminEditEndpointRendersImage({ baseUrl, fetchText, jar, postId, title, imageUrl }) {
  const editPage = await fetchText(`/admin/posts/${postId}/edit`, { jar })
  assert.ok(editPage.text.includes(title), 'Expected the edit endpoint to render the uploaded post.')
  assert.ok(editPage.text.includes(imageUrl), 'Expected the edit endpoint to render the uploaded image URL.')
  await assertPublicImageUrlResponds(baseUrl, imageUrl)
}

async function assertConfigCacheCommands() {
  await run('bun', ['run', 'config:cache'])
  assert.equal(existsSync(configCachePath), true)
  assert.ok((await readFile(configCachePath, 'utf8')).includes('blog-sveltekit'))

  await run('bun', ['run', 'config:clear'])
  assert.equal(existsSync(configCachePath), false)
}

async function assertCacheBackedHttpBehavior(baseUrl) {
  await run('bun', ['x', 'holo', 'cache:clear'])
  assert.equal(countCacheRows(), 0)

  await waitForText(`${baseUrl}/`, payload => payload.includes('Shipping a Real Holo Blog on SvelteKit'))
  const homeCacheRows = countCacheRows()
  assert.ok(homeCacheRows >= 1, 'Expected the home page request to store query cache rows.')

  await waitForText(`${baseUrl}/posts`, payload => payload.includes('Shipping a Real Holo Blog on SvelteKit'))
  assert.ok(countCacheRows() >= homeCacheRows, 'Expected the posts page request to reuse existing query cache rows.')

  await run('bun', ['x', 'holo', 'cache:clear'])
  assert.equal(countCacheRows(), 0)

  await waitForText(`${baseUrl}/`, payload => payload.includes('Shipping a Real Holo Blog on SvelteKit'))
  assert.ok(countCacheRows() >= 1, 'Expected cache rows to be recreated after cache clear.')
}

async function fetchJson(url, options = {}) {
  const headers = new Headers(options.headers ?? {})
  let body = options.body

  if (options.fields) {
    const payload = new FormData()
    for (const [key, value] of Object.entries(options.fields)) {
      if (typeof value === 'undefined' || value === null) {
        continue
      }

      payload.set(key, String(value))
    }

    body = payload
  }

  const response = await fetch(url, {
    method: options.method ?? (options.fields ? 'POST' : 'GET'),
    headers,
    body,
    redirect: 'manual',
  })
  const text = await response.text()
  if ((response.status < 200 || response.status >= 300) && options.allowFailure !== true) {
    throw new Error(`Unexpected status ${response.status} for ${url}: ${text}`)
  }

  try {
    return {
      response,
      json: JSON.parse(text),
    }
  } catch (error) {
    throw new Error(`Expected JSON from ${url}: ${error instanceof Error ? error.message : String(error)}\n${text}`)
  }
}

async function fetchCsrfField(baseUrl, path = '/login') {
  const response = await fetch(`${baseUrl}${path}`)
  const html = await response.text()
  const setCookie = response.headers.get('set-cookie') ?? ''
  const csrfCookie = setCookie.split(';', 1)[0]
  const csrfName = html.match(/<input[^>]+name="([^"]+)"[^>]+value="([^"]+)"/)?.[1]
  const csrfValue = html.match(/<input[^>]+name="([^"]+)"[^>]+value="([^"]+)"/)?.[2]

  assert.ok(csrfCookie, 'Expected CSRF middleware to issue a cookie.')
  assert.ok(csrfName, 'Expected CSRF input name to be rendered.')
  assert.ok(csrfValue, 'Expected CSRF input value to be rendered.')

  return {
    cookie: csrfCookie,
    name: csrfName,
    value: csrfValue,
  }
}

function findCsrfInput(pageHtml) {
  const match = pageHtml.match(/<input[^>]+name="_token"[^>]+value="([^"]+)"/)
    ?? pageHtml.match(/<input[^>]+value="([^"]+)"[^>]+name="_token"/)
  const value = match?.[1]
  assert.ok(value, 'Expected the page to render a CSRF input.')
  return value
}

function assertFieldFailure(result, fields) {
  assert.equal(result.json.ok, false)
  assert.equal(result.json.valid, false)
  for (const field of fields) {
    assert.ok(
      Array.isArray(result.json.errors?.[field]),
      `Expected ${field} validation errors.`,
    )
  }
}

function assertResponseRedirectsTo(result, expectedPath) {
  assert.equal(result.response.status, 303, result.text)
  assert.equal(new URL(result.response.headers.get('location'), result.response.url).pathname, expectedPath)
}

async function assertResetPasswordApiValidation(devUrl) {
  const csrfField = await fetchCsrfField(devUrl)
  const invalidSubmission = await fetchJson(`${devUrl}/api/reset-password`, {
    fields: {
      [csrfField.name]: csrfField.value,
    },
    headers: {
      cookie: csrfField.cookie,
    },
    allowFailure: true,
  })
  assert.equal(invalidSubmission.response.status, 422)
  assertFieldFailure(invalidSubmission, ['token', 'password', 'passwordConfirmation'])
}

async function assertAuthenticatedUserCannotDeletePost({ baseUrl, jar, fetchText }) {
  const postsPage = await fetchText('/admin/posts', { jar })
  const postId = postsPage.text.match(/name="id" value="(\d+)"/)?.[1]
  assert.ok(postId, 'Expected the admin posts page to render a delete form with a post id.')

  const body = new FormData()
  body.set('_token', findCsrfInput(postsPage.text))
  body.set('id', postId)

  const denied = await fetchText('/admin/posts?/delete', {
    method: 'POST',
    body,
    headers: {
      origin: baseUrl,
    },
    jar,
    allowFailure: true,
  })
  assert.equal(denied.response.status, 403)
}

async function assertAuthenticatedUserCanCreateAndUpdatePostImage({ baseUrl, jar, fetchText, fetchJson }) {
  const newPostPage = await fetchText('/admin/posts/new', { jar })
  const csrfToken = findCsrfInput(newPostPage.text)

  const noImageTitle = `User flow no image ${Date.now()}`
  const noImageFormData = new FormData()
  noImageFormData.set('_token', csrfToken)
  noImageFormData.set('title', noImageTitle)
  noImageFormData.set('excerpt', 'Created without selecting an image.')
  noImageFormData.set('body', 'This post exercises optional file validation through the real SvelteKit action flow.')
  noImageFormData.set('status', 'draft')
  noImageFormData.set('categoryId', '')
  noImageFormData.set('image', new Blob([], { type: 'application/octet-stream' }), '')

  const createdWithoutImage = await fetchText('/admin/posts/new?/create', {
    method: 'POST',
    body: noImageFormData,
    headers: {
      accept: 'text/html',
      origin: baseUrl,
    },
    jar,
    allowFailure: true,
  })
  assert.notEqual(createdWithoutImage.response.status, 422, createdWithoutImage.text)
  assertResponseRedirectsTo(createdWithoutImage, '/admin/posts')

  const postWithoutImage = getPostByTitle(noImageTitle)
  assert.equal(countPostImages(postWithoutImage.id), 0, 'Expected creating without selecting an image to skip media records.')

  const oversizedFormData = new FormData()
  oversizedFormData.set('_token', csrfToken)
  oversizedFormData.set('title', `Oversized image ${Date.now()}`)
  oversizedFormData.set('excerpt', 'Created through the real SvelteKit action flow.')
  oversizedFormData.set('body', 'This post should return a media validation failure.')
  oversizedFormData.set('status', 'draft')
  oversizedFormData.set('categoryId', '')
  oversizedFormData.set('image', new Blob([oversizedImage], { type: 'image/png' }), 'too-large.png')

  const oversized = await fetchText('/admin/posts/new?/create', {
    method: 'POST',
    body: oversizedFormData,
    headers: {
      accept: 'text/html',
      origin: baseUrl,
    },
    jar,
    allowFailure: true,
  })
  assert.notEqual(oversized.response.status, 500, oversized.text)
  assert.notEqual(
    oversized.response.headers.get('content-type')?.toLowerCase().includes('application/json'),
    true,
    `Expected browser form validation failures to avoid raw JSON responses, received ${oversized.text}.`,
  )
  assert.equal(oversized.response.status, 303, oversized.text)
  assert.equal(new URL(oversized.response.headers.get('location'), baseUrl).pathname, '/admin/posts/new')
  assert.ok(
    oversized.response.headers.get('set-cookie')?.includes('HOLO-SVELTEKIT-VALIDATION='),
    'Expected oversized upload response to flash the validation failure for the redirected form.',
  )
  const oversizedRedirectPage = await fetchText('/admin/posts/new', { jar })
  assert.ok(
    oversizedRedirectPage.text.includes('The selected file must be 2 MB or smaller.'),
    'Expected the redirected form page to render the flashed validation error.',
  )

  const title = `User flow image ${Date.now()}`
  const formData = new FormData()
  formData.set('_token', csrfToken)
  formData.set('title', title)
  formData.set('excerpt', 'Created through the real SvelteKit action flow.')
  formData.set('body', 'This post exercises image upload through the real SvelteKit action flow.')
  formData.set('status', 'draft')
  formData.set('categoryId', '')
  formData.set('image', new Blob([pngPixel], { type: 'image/png' }), 'draft.png')

  const created = await fetchText('/admin/posts/new?/create', {
    method: 'POST',
    body: formData,
    headers: {
      accept: 'text/html',
      origin: baseUrl,
    },
    jar,
    allowFailure: true,
  })
  assertResponseRedirectsTo(created, '/admin/posts')

  const postsPage = await fetchText('/admin/posts', { jar })
  assert.ok(postsPage.text.includes(title), 'Expected the admin posts page to show the created post.')

  const uploaded = getUploadedPostImage(title)
  await assertAdminEditEndpointRendersImage({
    baseUrl,
    fetchText,
    jar,
    postId: uploaded.id,
    title,
    imageUrl: uploaded.thumbUrl,
  })

  const currentUser = await fetchJson('/api/auth/user', { jar })
  assert.ok(currentUser.json.user?.id, 'Expected the authenticated user endpoint to return a user id.')
  assignPostAuthor(uploaded.id, currentUser.json.user.id)

  const editPage = await fetchText(`/admin/posts/${uploaded.id}/edit`, { jar })
  const editCsrfToken = findCsrfInput(editPage.text)
  const updateWithoutImageFormData = new FormData()
  updateWithoutImageFormData.set('_token', editCsrfToken)
  updateWithoutImageFormData.set('title', title)
  updateWithoutImageFormData.set('excerpt', 'Updated without selecting a replacement image.')
  updateWithoutImageFormData.set('body', 'This post exercises optional file validation during update through the real SvelteKit action flow.')
  updateWithoutImageFormData.set('status', 'draft')
  updateWithoutImageFormData.set('categoryId', '')
  updateWithoutImageFormData.set('image', new Blob([], { type: 'application/octet-stream' }), '')

  const updatedWithoutImage = await fetchText(`/admin/posts/${uploaded.id}/edit?/update`, {
    method: 'POST',
    body: updateWithoutImageFormData,
    headers: {
      accept: 'text/html',
      origin: baseUrl,
    },
    jar,
    allowFailure: true,
  })
  assert.notEqual(updatedWithoutImage.response.status, 422, updatedWithoutImage.text)
  assertResponseRedirectsTo(updatedWithoutImage, '/admin/posts')
  assert.equal(countPostImages(uploaded.id), 1, 'Expected updating without a replacement image to keep the existing image.')
}

async function assertAuthenticatedAdminPostFlows(context) {
  await assertAuthenticatedUserCanCreateAndUpdatePostImage(context)
  await assertAuthenticatedUserCannotDeletePost(context)
}

async function assertSuperAdminLogoutUsesServerActionForm() {
  const source = await readFile(join(cwd, 'src/routes/super-admin/+page.svelte'), 'utf8')

  assert.ok(
    source.includes('<form method="post">'),
    'Expected super-admin logout to use the page action form.',
  )
  assert.ok(
    source.includes('<button type="submit">Sign out of super admin</button>'),
    'Expected super-admin logout to submit through the server action.',
  )
}

async function assertHeaderLogoutUsesServerRedirectForm() {
  const source = await readFile(join(cwd, 'src/routes/+layout.svelte'), 'utf8')

  assert.ok(
    source.includes('<form action="/logout" method="post" class="logout-form">'),
    'Expected header logout to post to the server redirect route.',
  )
  assert.ok(
    source.includes('<button type="submit" class="logout-button">Logout</button>'),
    'Expected header logout to submit through a native form.',
  )
}

function pipeOutput(stream, target, onLine) {
  if (!stream) {
    return
  }

  let buffered = ''
  stream.on('data', chunk => {
    const text = chunk.toString()
    capturedOutput += text
    buffered += text
    const lines = buffered.split(/\r?\n/)
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      onLine?.(line)
      target.write(`${line}\n`)
    }
  })

  stream.on('end', () => {
    if (buffered.length === 0) {
      return
    }

    onLine?.(buffered)
    target.write(buffered)
  })
}

function waitForDevUrl(child, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let settled = false
    let localUrl

    const finish = (callback) => (value) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timeout)
      child.off('close', onClose)
      callback(value)
    }

    const succeed = finish(resolve)
    const fail = finish(reject)

    const onLine = (line) => {
      const readableLine = line.replace(ansiEscapePattern, '')
      const match = readableLine.match(/Local:\s+(https?:\/\/[^\s/]+(?::\d+)?)/)
      if (match) {
        localUrl = match[1]
        succeed(localUrl)
      }
    }

    const onClose = (code, signal) => {
      fail(new Error(`Dev server exited before reporting a local URL (${code ?? signal ?? 'unknown'})`))
    }

    const timeout = setTimeout(() => {
      fail(new Error('Timed out waiting for the dev server URL'))
    }, timeoutMs)

    pipeOutput(child.stdout, process.stdout, onLine)
    pipeOutput(child.stderr, process.stderr, onLine)
    child.once('close', onClose)
  })
}

let child = null

function killChildTree() {
  if (!child || child.exitCode !== null) {
    return
  }

  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      // Already exited.
    }
  }
}

try {
  await rm(join(cwd, '.svelte-kit'), { recursive: true, force: true })
  await rm(join(cwd, 'build'), { recursive: true, force: true })
  await assertSuperAdminLogoutUsesServerActionForm()
  await assertHeaderLogoutUsesServerRedirectForm()
  await run('npx', ['vitest', '--run', 'tests/auth-page-actions.test.mjs', '--reporter=json'])
  await run('bun', ['run', 'prepare'])
  await assertConfigCacheCommands()
  await run('bun', ['x', 'holo', 'migrate:fresh', '--seed'])
  await run('npx', ['tsx', 'tests/blog-logic.mjs'])

  child = spawn('bun', ['x', 'vite', 'dev', '--host', 'localhost', '--port', port], {
    cwd,
    detached: true,
    env: createChildEnv({
      APP_URL: `http://localhost:${port}`,
      MAIL_MAILER: 'log',
      MAIL_LOG_BODIES: 'true',
    }),
    stdio: ['inherit', 'pipe', 'pipe'],
  })

  const devUrl = await waitForDevUrl(child)
  const healthUrl = `${devUrl}/api/holo`
  const initial = await waitForJson(healthUrl, payload => payload.ok === true)
  assert.equal(initial.app, 'blog-sveltekit')
  await waitForText(`${devUrl}/`, payload => payload.includes('Shipping a Real Holo Blog on SvelteKit'))
  await assertCacheBackedHttpBehavior(devUrl)
  await waitForRedirect(`${devUrl}/admin/posts`, '/login')
  await assertResetPasswordApiValidation(devUrl)
  await assertExampleAppAuthFlow({
    baseUrl: devUrl,
    getOutput: () => capturedOutput,
    appName: 'blog-sveltekit',
    sessionCookieName: DEFAULT_SESSION_COOKIE_NAME,
    authSubmissionMode: 'sveltekit-actions',
    loginRequiresCsrf: true,
    afterAuthenticated: assertAuthenticatedAdminPostFlows,
  })
  await assertExampleAppTokenAuthFlow({
    baseUrl: devUrl,
    expectedTitle: 'Shipping a Real Holo Blog on SvelteKit',
  })

  await writeFile(configPath, originalConfig.replace("name: env('APP_NAME', 'blog-sveltekit')", "name: env('APP_NAME', 'blog-sveltekit-updated')"))
  await new Promise(resolve => setTimeout(resolve, 3000))
  const updated = await waitForJson(healthUrl, payload => payload.app === 'blog-sveltekit-updated')
  assert.equal(updated.app, 'blog-sveltekit-updated')

  killChildTree()
  await new Promise(resolve => child.once('close', resolve))
  child = null

  await run('bun', ['run', 'lint'])
  await run('bun', ['run', 'typecheck'])
  await run('bun', ['run', 'build'])
} finally {
  await writeFile(configPath, originalConfig)
  killChildTree()
  if (child && child.exitCode === null) {
    await new Promise(resolve => child.once('close', resolve))
  }
}
