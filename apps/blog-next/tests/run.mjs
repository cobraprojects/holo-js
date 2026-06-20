import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { get } from 'node:http'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_SESSION_COOKIE_NAME } from '@holo-js/config'
import Database from 'better-sqlite3'
import ts from 'typescript'
import { assertExampleAppAuthFlow } from '../../../tests/example-app-auth-flow.mjs'
import { closeExampleAppBrowser } from '../../../tests/example-app-browser.mjs'
import { assertExampleAppBroadcastBrowserFlow } from '../../../tests/example-app-broadcast-browser-flow.mjs'
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
const runtimeSchemaPath = join(cwd, '.holo-js/generated/schema.mjs')
const require = createRequire(import.meta.url)
const { encodeReply } = require('next/dist/compiled/react-server-dom-webpack/client.node.js')
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

function getJsxTagName(tagName) {
  if (ts.isIdentifier(tagName)) {
    return tagName.text
  }

  if (ts.isPropertyAccessExpression(tagName)) {
    return tagName.name.text
  }

  return tagName.getText()
}

function isJsxNodeNamed(node, tagName) {
  if (ts.isJsxElement(node)) {
    return getJsxTagName(node.openingElement.tagName) === tagName
  }

  return ts.isJsxSelfClosingElement(node) && getJsxTagName(node.tagName) === tagName
}

function findJsxElement(node, tagName) {
  if (ts.isJsxElement(node) && getJsxTagName(node.openingElement.tagName) === tagName) {
    return node
  }

  return ts.forEachChild(node, child => findJsxElement(child, tagName))
}

function containsJsxNode(node, tagName) {
  if (isJsxNodeNamed(node, tagName)) {
    return true
  }

  return ts.forEachChild(node, child => containsJsxNode(child, tagName)) === true
}

function containsLogoutActionForm(node) {
  if (
    ts.isJsxSelfClosingElement(node)
    && getJsxTagName(node.tagName) === 'form'
    && node.attributes.properties.some(attribute => (
      ts.isJsxAttribute(attribute)
      && attribute.name.text === 'action'
      && attribute.initializer
      && ts.isJsxExpression(attribute.initializer)
      && attribute.initializer.expression
      && ts.isIdentifier(attribute.initializer.expression)
      && attribute.initializer.expression.text === 'logoutAction'
    ))
  ) {
    return true
  }

  if (
    ts.isJsxElement(node)
    && getJsxTagName(node.openingElement.tagName) === 'form'
    && node.openingElement.attributes.properties.some(attribute => (
      ts.isJsxAttribute(attribute)
      && attribute.name.text === 'action'
      && attribute.initializer
      && ts.isJsxExpression(attribute.initializer)
      && attribute.initializer.expression
      && ts.isIdentifier(attribute.initializer.expression)
      && attribute.initializer.expression.text === 'logoutAction'
    ))
  ) {
    return true
  }

  return ts.forEachChild(node, containsLogoutActionForm) === true
}

async function assertRootLayoutSharesAuthProviderState() {
  const layoutSource = await readFile(join(cwd, 'app/layout.tsx'), 'utf8')
  const sourceFile = ts.createSourceFile('layout.tsx', layoutSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const authProvider = findJsxElement(sourceFile, 'AuthProvider')

  assert.ok(authProvider, 'Expected app/layout.tsx to render AuthProvider.')
  assert.ok(
    containsJsxNode(authProvider, 'AuthNav'),
    'Expected AuthProvider to contain AuthNav.',
  )
  assert.ok(
    containsJsxNode(authProvider, 'main'),
    'Expected AuthProvider to wrap the routed page content so login refreshes update the header.',
  )
}

async function assertHeaderLogoutRedirectsHome() {
  const authNavSource = await readFile(join(cwd, 'app/auth-nav.tsx'), 'utf8')
  const sourceFile = ts.createSourceFile('auth-nav.tsx', authNavSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  assert.ok(
    containsLogoutActionForm(sourceFile),
    'Expected header logout to use the logout server action form.',
  )
}

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

async function findServerActionId(exportedName, manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const [id, action] of Object.entries(manifest.node ?? {})) {
    if (action.exportedName === exportedName) {
      return id
    }
  }

  throw new Error(`Expected ${exportedName} in ${manifestPath}.`)
}

async function assertConfigCacheCommands() {
  await run('bun', ['run', 'config:cache'])
  assert.equal(existsSync(configCachePath), true)
  assert.ok((await readFile(configCachePath, 'utf8')).includes('blog-next'))

  await run('bun', ['run', 'config:clear'])
  assert.equal(existsSync(configCachePath), false)
}

async function assertCacheBackedHttpBehavior(baseUrl) {
  await run('bun', ['x', 'holo', 'cache:clear'])
  assert.equal(countCacheRows(), 0)

  await waitForText(`${baseUrl}/`, payload => payload.includes('Shipping a Real Holo Blog on Next'))
  const homeCacheRows = countCacheRows()
  assert.ok(homeCacheRows >= 1, 'Expected the home page request to store query cache rows.')

  await waitForText(`${baseUrl}/posts`, payload => payload.includes('Shipping a Real Holo Blog on Next'))
  assert.ok(countCacheRows() >= homeCacheRows, 'Expected the posts page request to reuse existing query cache rows.')

  await run('bun', ['x', 'holo', 'cache:clear'])
  assert.equal(countCacheRows(), 0)

  await waitForText(`${baseUrl}/`, payload => payload.includes('Shipping a Real Holo Blog on Next'))
  assert.ok(countCacheRows() >= 1, 'Expected cache rows to be recreated after cache clear.')
}

function collectHiddenInputs(formHtml) {
  const fields = new Map()
  const inputPattern = /<input\b[^>]*>/gi
  for (const [input] of formHtml.matchAll(inputPattern)) {
    const type = input.match(/\btype=(["'])hidden\1/i)
    if (!type) {
      continue
    }

    const name = input.match(/\bname=(["'])(.*?)\1/i)?.[2]
    const value = input.match(/\bvalue=(["'])(.*?)\1/i)?.[2] ?? ''
    if (name) {
      fields.set(decodeHtmlAttribute(name), decodeHtmlAttribute(value))
    }
  }

  return fields
}

function findFormByButtonText(pageHtml, buttonText) {
  const formPattern = /<form\b[\s\S]*?<\/form>/gi
  const escapedButtonText = escapeRegExp(buttonText)
  const buttonPattern = new RegExp(
    `<button\\b[^>]*\\btype\\s*=\\s*["']?submit["']?[^>]*>\\s*${escapedButtonText}\\s*<\\/button>`,
    'i',
  )

  for (const [form] of pageHtml.matchAll(formPattern)) {
    if (buttonPattern.test(form)) {
      return form
    }
  }

  return undefined
}

function collectFormData(formHtml) {
  const fields = collectHiddenInputs(formHtml)
  const formData = new FormData()
  for (const [name, value] of fields) {
    formData.set(name, value)
  }

  return formData
}

function readCookieValue(header, name) {
  for (const segment of header.split(';')) {
    const [cookieName, cookieValue] = segment.trim().split('=', 2)
    if (cookieName === name && cookieValue) {
      return decodeURIComponent(cookieValue)
    }
  }

  return undefined
}

function applyCsrfToken(formData, token) {
  assert.ok(token, 'Expected the browser flow to have a CSRF token.')
  formData.set('_token', token)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function decodeHtmlAttribute(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#34;', '"')
    .replaceAll('&#x22;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

async function assertAuthenticatedUserCanCreateDraftPost({ baseUrl, jar, fetchText, fetchJson }) {
  const newPostPage = await fetchText('/admin/posts/new', { jar })
  const createForm = findFormByButtonText(newPostPage.text, 'Create post')
  assert.ok(createForm, 'Expected the new post page to render a create form.')
  const csrfToken = readCookieValue(newPostPage.response.headers.get('set-cookie') ?? '', 'XSRF-TOKEN')
    ?? readCookieValue(jar.header(), 'XSRF-TOKEN')
  assert.ok(csrfToken, 'Expected the new post page request to issue a CSRF token.')

  const createActionId = await findServerActionId(
    'createPostAction',
    join(cwd, '.next/dev/server/app/admin/posts/new/page/server-reference-manifest.json'),
  )

  const noImageTitle = `User flow no image ${Date.now()}`
  const noImageFormData = collectFormData(createForm)
  noImageFormData.set('title', noImageTitle)
  noImageFormData.set('excerpt', 'Created without selecting an image.')
  noImageFormData.set('body', 'This post exercises optional file validation through the real Next server action flow.')
  noImageFormData.set('status', 'draft')
  noImageFormData.set('categoryId', '')
  noImageFormData.set('image', new Blob([], { type: 'application/octet-stream' }), '')
  applyCsrfToken(noImageFormData, csrfToken)

  const createdWithoutImage = await fetchText('/admin/posts/new', {
    method: 'POST',
    body: await encodeReply([noImageFormData]),
    headers: {
      accept: 'text/x-component',
      'next-action': createActionId,
      'X-CSRF-TOKEN': csrfToken,
      origin: baseUrl,
      referer: `${baseUrl}/admin/posts/new`,
    },
    jar,
    allowFailure: true,
  })
  assert.notEqual(createdWithoutImage.response.status, 500, createdWithoutImage.text)
  assert.equal(createdWithoutImage.response.status, 303, createdWithoutImage.text)
  assert.match(createdWithoutImage.response.headers.get('x-action-redirect') ?? '', /^\/admin\/posts;/)

  const postWithoutImage = getPostByTitle(noImageTitle)
  assert.equal(countPostImages(postWithoutImage.id), 0, 'Expected creating without selecting an image to skip media records.')

  const oversizedFormData = collectFormData(createForm)
  oversizedFormData.set('title', `Oversized image ${Date.now()}`)
  oversizedFormData.set('excerpt', 'Created through the real Next server action flow.')
  oversizedFormData.set('body', 'This post should return a media validation failure.')
  oversizedFormData.set('status', 'draft')
  oversizedFormData.set('categoryId', '')
  oversizedFormData.set('image', new Blob([oversizedImage], { type: 'image/png' }), 'too-large.png')
  applyCsrfToken(oversizedFormData, csrfToken)

  const oversized = await fetchText('/admin/posts/new', {
    method: 'POST',
    body: await encodeReply([oversizedFormData]),
    headers: {
      accept: 'text/x-component',
      'next-action': createActionId,
      'X-CSRF-TOKEN': csrfToken,
      origin: baseUrl,
      referer: `${baseUrl}/admin/posts/new`,
    },
    jar,
    allowFailure: true,
  })
  assert.notEqual(oversized.response.status, 500, oversized.text)
  assert.ok(
    oversized.text.includes('The selected file must be 2 MB or smaller.'),
    `Expected oversized upload response to include image error, received ${oversized.text}.`,
  )

  const title = `User flow image ${Date.now()}`
  const formData = collectFormData(createForm)
  formData.set('title', title)
  formData.set('excerpt', 'Created through the real Next server action flow.')
  formData.set('body', 'This post exercises image upload through the real Next server action flow.')
  formData.set('status', 'draft')
  formData.set('categoryId', '')
  formData.set('image', new Blob([pngPixel], { type: 'image/png' }), 'draft.png')
  applyCsrfToken(formData, csrfToken)

  const created = await fetchText('/admin/posts/new', {
    method: 'POST',
    body: await encodeReply([formData]),
    headers: {
      accept: 'text/x-component',
      'next-action': createActionId,
      'X-CSRF-TOKEN': csrfToken,
      origin: baseUrl,
      referer: `${baseUrl}/admin/posts/new`,
    },
    jar,
    allowFailure: true,
  })

  assert.notEqual(created.response.status, 500, created.text)
  assert.equal(created.response.status, 303, created.text)
  assert.match(created.response.headers.get('x-action-redirect') ?? '', /^\/admin\/posts;/)
  assert.doesNotMatch(created.text, /database is locked|Runtime DatabaseError/i)

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
  const editForm = findFormByButtonText(editPage.text, 'Save post')
  assert.ok(editForm, 'Expected the edit post page to render an update form.')
  const updateActionId = await findServerActionId(
    'updatePostAction',
    join(cwd, '.next/dev/server/app/admin/posts/[id]/edit/page/server-reference-manifest.json'),
  )
  const updateWithoutImageFormData = collectFormData(editForm)
  updateWithoutImageFormData.set('title', title)
  updateWithoutImageFormData.set('excerpt', 'Updated without selecting a replacement image.')
  updateWithoutImageFormData.set('body', 'This post exercises optional file validation during update through the real Next server action flow.')
  updateWithoutImageFormData.set('status', 'draft')
  updateWithoutImageFormData.set('categoryId', '')
  updateWithoutImageFormData.set('image', new Blob([], { type: 'application/octet-stream' }), '')
  applyCsrfToken(updateWithoutImageFormData, csrfToken)

  const updatedWithoutImage = await fetchText(`/admin/posts/${uploaded.id}/edit`, {
    method: 'POST',
    body: await encodeReply([uploaded.id, updateWithoutImageFormData]),
    headers: {
      accept: 'text/x-component',
      'next-action': updateActionId,
      'X-CSRF-TOKEN': csrfToken,
      origin: baseUrl,
      referer: `${baseUrl}/admin/posts/${uploaded.id}/edit`,
    },
    jar,
    allowFailure: true,
  })
  assert.notEqual(updatedWithoutImage.response.status, 500, updatedWithoutImage.text)
  assert.equal(updatedWithoutImage.response.status, 303, updatedWithoutImage.text)
  assert.match(updatedWithoutImage.response.headers.get('x-action-redirect') ?? '', /^\/admin\/posts;/)
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
    appName: 'blog-next',
    cookieHeader: context.jar.header(),
  })
  await assertAuthenticatedUserCanCreateDraftPost(context)
  await assertExampleAppRealtimeBrowserFlow({
    baseUrl: context.baseUrl,
    appName: 'blog-next',
    cookieHeader: context.jar.header(),
  })
}

function pipeOutput(stream, target) {
  if (!stream) {
    return
  }

  stream.on('data', chunk => {
    const text = chunk.toString()
    capturedOutput += text
    target.write(text)
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
  await rm(join(cwd, '.next'), { recursive: true, force: true })
  await assertRootLayoutSharesAuthProviderState()
  await assertHeaderLogoutRedirectsHome()
  await run('npx', ['vitest', '--run', 'tests/admin-categories-page.test.mjs', 'tests/admin-posts-page.test.mjs', 'tests/admin-tags-page.test.mjs', 'tests/api-v1-routes.test.mjs', 'tests/auth-nav.test.mjs', 'tests/broadcast-auth-route.test.mjs', 'tests/current-auth-route.test.mjs', 'tests/edit-category-page.test.mjs', 'tests/edit-tag-page.test.mjs', 'tests/forgot-password-route.test.mjs', 'tests/health-route.test.mjs', 'tests/hosted-callback-routes.test.mjs', 'tests/hosted-login-routes.test.mjs', 'tests/hosted-logout-routes.test.mjs', 'tests/hosted-register-routes.test.mjs', 'tests/home-page.test.mjs', 'tests/login-page.test.mjs', 'tests/login-route.test.mjs', 'tests/logout-actions.test.mjs', 'tests/new-post-page.test.mjs', 'tests/package-checks.test.mjs', 'tests/post-detail-page.test.mjs', 'tests/admin-dashboard-page.test.mjs', 'tests/edit-post-page.test.mjs', 'tests/register-page.test.mjs', 'tests/reset-password-page.test.mjs', 'tests/reset-password-route.test.mjs', 'tests/social-auth-routes.test.mjs', 'tests/super-admin-logout-button.test.mjs', 'tests/super-admin-login-page.test.mjs', 'tests/super-admin-login-route.test.mjs', 'tests/super-admin-page.test.mjs', 'tests/super-admin-logout-route.test.mjs', 'tests/verify-email-page.test.mjs', 'tests/verify-email-resend-route.test.mjs', 'tests/verify-email-route.test.mjs', '--reporter=json'])
  await run('bun', ['run', 'prepare'])
  await assertConfigCacheCommands()
  await run('bun', ['x', 'holo', 'migrate:fresh', '--seed'])
  await startBroadcastWorker(`http://localhost:${port}`)
  await run('npx', ['tsx', 'tests/blog-logic.mjs'])

  child = spawn('bun', ['run', 'dev'], {
    cwd,
    detached: true,
    env: createChildEnv({
      PORT: port,
      HOST: 'localhost',
      APP_URL: `http://localhost:${port}`,
      MAIL_MAILER: 'log',
      MAIL_LOG_BODIES: 'true',
    }),
    stdio: ['inherit', 'pipe', 'pipe'],
  })
  pipeOutput(child.stdout, process.stdout)
  pipeOutput(child.stderr, process.stderr)

  await waitForText(`http://localhost:${port}/`, payload => payload.includes('Shipping a Real Holo Blog on Next'))
  await startBroadcastWorker(`http://localhost:${port}`)
  await assertCacheBackedHttpBehavior(`http://localhost:${port}`)
  await waitForRedirect(`http://localhost:${port}/admin`, '/login')
  await waitForRedirect(`http://localhost:${port}/admin/posts`, '/login')
  await assertExampleAppAuthFlow({
    baseUrl: `http://localhost:${port}`,
    getOutput: () => capturedOutput,
    appName: 'blog-next',
    sessionCookieName: DEFAULT_SESSION_COOKIE_NAME,
    loginRequiresCsrf: true,
    afterAuthenticated: assertAuthenticatedAdminPostFlows,
  })
  await assertExampleAppTokenAuthFlow({
    baseUrl: `http://localhost:${port}`,
    expectedTitle: 'Shipping a Real Holo Blog on Next',
  })

  await writeFile(configPath, originalConfig.replace("name: env('APP_NAME', 'blog-next')", "name: env('APP_NAME', 'blog-next-updated')"))
  await waitForText(`http://localhost:${port}/`, payload => payload.includes('Shipping a Real Holo Blog on Next'))

  await stopProcessTree(child)
  child = null
  await stopProcessTree(broadcastChild)
  broadcastChild = null

  await run('bun', ['run', 'lint'])
  await run('bun', ['run', 'typecheck'])
  await run('bun', ['run', 'build'])
} finally {
  await closeExampleAppBrowser()
  await writeFile(configPath, originalConfig)
  await stopProcessTree(child)
  await stopProcessTree(broadcastChild)
}
