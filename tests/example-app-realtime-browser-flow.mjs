import assert from 'node:assert/strict'
import { getExampleAppBrowser, observeExampleAppPage, signInAsExampleAppEditor } from './example-app-browser.mjs'

const realtimePath = '/admin/posts/realtime'
const postSelector = '[data-post-id]'
const unavailableWorkerWarning = 'Realtime live updates are unavailable because the broadcast worker is not reachable.'

async function waitFor(predicate, message, timeoutMs = 20000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return
    }

    await new Promise(resolve => setTimeout(resolve, 100))
  }

  throw new Error(message)
}

function formatRealtimeFailure(message, sockets, failures) {
  return [
    message,
    `WebSocket URLs: ${JSON.stringify(sockets.urls)}`,
    `Sent frames: ${JSON.stringify(sockets.sentFrames)}`,
    `Received frames: ${JSON.stringify(sockets.receivedFrames)}`,
    `Page failures: ${JSON.stringify(failures)}`,
  ].join('\n')
}

function collectPageFailures(page, options = {}) {
  const result = observeExampleAppPage(page, {
    allowConsoleError: text => options.allowWebSocketConnectionErrors
      && text.includes('WebSocket')
      && text.includes('/app/'),
    allowRequestFailure: (url) => options.allowWebSocketConnectionErrors
      && url.includes('/app/'),
  })
  return result
}

function cookieHeaderToBrowserCookies(baseUrl, cookieHeader) {
  const url = new URL(baseUrl)

  return cookieHeader
    .split(';')
    .map(cookie => cookie.trim())
    .filter(Boolean)
    .map((cookie) => {
      const separator = cookie.indexOf('=')
      assert.ok(separator > 0, `Expected a valid cookie segment, received ${cookie}.`)

      return {
        name: cookie.slice(0, separator),
        value: cookie.slice(separator + 1),
        domain: url.hostname,
        path: '/',
        sameSite: 'Lax',
      }
    })
}

async function waitForAppHydration(page) {
  await page.waitForSelector('html[data-hydrated="true"]', { state: 'attached' })
}

function observeWebSockets(page) {
  const urls = []
  const sentFrames = []
  const receivedFrames = []

  page.on('websocket', (socket) => {
    if (!socket.url().includes('/app/')) return
    urls.push(socket.url())
    socket.on('framesent', (frame) => {
      sentFrames.push(String(frame.payload))
    })
    socket.on('framereceived', (frame) => {
      receivedFrames.push(String(frame.payload))
    })
  })

  return {
    urls,
    sentFrames,
    receivedFrames,
  }
}

async function openRealtimePage(page, failures) {
  const sockets = observeWebSockets(page)
  await page.goto(realtimePath, { waitUntil: 'domcontentloaded' })
  assert.equal(new URL(page.url()).pathname, realtimePath)
  await page.locator(postSelector).first().waitFor({ timeout: 20000 })
  await waitFor(
    () => sockets.urls.some(url => url.includes('/app/')),
    formatRealtimeFailure('Expected the realtime page to open a broadcast WebSocket.', sockets, failures),
  )
  await waitFor(
    () => sockets.sentFrames.some(frame => frame.includes('holo:realtime') && frame.includes('"action":"subscribe"')),
    formatRealtimeFailure('Expected the realtime page to subscribe through the websocket runtime.', sockets, failures),
  )
  await waitFor(
    () => sockets.receivedFrames.some(frame => JSON.parse(frame).event === 'holo:realtime:snapshot'),
    formatRealtimeFailure('Expected the worker to deliver the initial authenticated subscription snapshot.', sockets, failures),
  )

  return sockets
}

async function assertNextRealtimeQueryAfterLogout(baseUrl) {
  const browser = await getExampleAppBrowser()
  const context = await browser.newContext({ baseURL: baseUrl })
  try {
    assert.equal((await context.request.get('/login')).status(), 200)
    const token = (await context.cookies()).find(cookie => cookie.name === 'XSRF-TOKEN')?.value
    assert.ok(token, 'The native app must issue a CSRF token before login.')
    const headers = { 'X-CSRF-TOKEN': decodeURIComponent(token) }
    const login = await context.request.post('/api/login', { headers, data: { email: 'editor@example.com', password: 'secret-secret' } })
    assert.equal(login.status(), 200, await login.text())
    assert.equal((await login.json()).data.user.email, 'editor@example.com')
    const page = await context.newPage()
    await page.goto('/admin/posts', { waitUntil: 'domcontentloaded' })
    await page.getByRole('link', { name: /realtime demo/i }).waitFor()
    await waitForAppHydration(page)
    await page.route('**/holo/realtime/query', async route => {
      const logout = await context.request.post('/api/logout', { headers })
      assert.equal(logout.status(), 200, await logout.text())
      assert.equal((await logout.json()).authenticated, false)
      await route.continue()
    })
    const queryResponse = page.waitForResponse(response => response.url().includes('/holo/realtime/query') && response.request().method() === 'POST')
    await page.getByRole('link', { name: /realtime demo/i }).click()
    assert.equal((await queryResponse).status(), 401, 'A query in flight after real logout must fail authentication.')
    await page.locator('#__holo_next_client_http_error__').getByRole('heading', { name: '401', exact: true }).waitFor()
  } finally {
    await context.close()
  }
}

async function assertRealtimeMutationAfterLogout(baseUrl, appName, postId) {
  const browser = await getExampleAppBrowser()
  const context = await browser.newContext({ baseURL: baseUrl })
  try {
    assert.equal((await context.request.get('/login')).status(), 200)
    const token = (await context.cookies()).find(cookie => cookie.name === 'XSRF-TOKEN')?.value
    assert.ok(token)
    const headers = { 'X-CSRF-TOKEN': decodeURIComponent(token) }
    if (appName === 'blog-sveltekit') {
      const login = await context.request.post('/login', { headers: { ...headers, Accept: 'text/html' }, form: { email: 'editor@example.com', password: 'secret-secret', _token: decodeURIComponent(token) }, maxRedirects: 0 })
      assert.equal(login.status(), 303, await login.text())
      assert.equal(login.headers().location, '/admin')
    } else {
      const login = await context.request.post('/api/login', { headers, data: { email: 'editor@example.com', password: 'secret-secret' } })
      assert.equal(login.status(), 200, await login.text())
      assert.equal((await login.json()).data.user.email, 'editor@example.com')
    }
    const page = await context.newPage()
    const sockets = await openRealtimePage(page, [])
    const post = page.locator(`[data-post-id="${postId}"]`)
    await post.getByRole('button', { name: /edit title/i }).click()
    await page.getByLabel('Realtime post title').fill('Unauthorized realtime update')
    const logout = await context.request.post('/api/logout', { headers })
    assert.equal(logout.status(), 200, await logout.text())
    assert.equal((await logout.json()).authenticated, false)
    await page.getByRole('button', { name: /save realtime title/i }).click()
    await waitFor(() => sockets.receivedFrames.some(frame => {
      const packet = JSON.parse(frame)
      const data = typeof packet.data === 'string' ? JSON.parse(packet.data) : packet.data
      return packet.event === 'holo:realtime:error' && data.status === 401
    }), formatRealtimeFailure('A real logout must revoke mutation access on the existing WebSocket.', sockets, []))
    await page.getByRole('heading', { name: '401', exact: true }).waitFor()

  } finally {
    await context.close()
  }
}

export async function assertExampleAppRealtimeBrowserFlow({ baseUrl, appName, cookieHeader, postId }) {
  const browser = await getExampleAppBrowser()
  const context = await browser.newContext({ baseURL: baseUrl })

  try {
    await context.addCookies(cookieHeaderToBrowserCookies(baseUrl, cookieHeader))
    const observerPage = await context.newPage()
    const editorPage = await context.newPage()
    const observerResult = collectPageFailures(observerPage)
    const editorResult = collectPageFailures(editorPage)
    const observerSockets = await openRealtimePage(observerPage, observerResult.failures)
    const editorSockets = await openRealtimePage(editorPage, editorResult.failures)
    const firstPost = editorPage.locator(`[data-post-id="${postId}"]`)
    assert.ok(postId, 'Expected the realtime page to render post ids.')

    const subscriptionFrames = editorSockets.sentFrames.filter(frame => frame.includes('"action":"subscribe"')).length
    const title = `Realtime ${appName} ${Date.now()}`
    await firstPost.getByRole('button', { name: /edit title/i }).click()
    await editorPage.getByLabel('Realtime post title').fill(title)
    assert.equal(editorSockets.sentFrames.filter(frame => frame.includes('"action":"subscribe"')).length, subscriptionFrames, 'Editing local form state must preserve the existing realtime subscription.')
    await editorPage.getByRole('button', { name: /save realtime title/i }).click()
    try {
      await waitFor(
        async () => (await observerPage.locator(`[data-post-id="${postId}"] h2`).textContent()) === title,
        `Expected realtime subscriber to show updated title "${title}".`,
      )
    } catch (error) {
      throw new Error([
        formatRealtimeFailure('Observer failed to receive the mutation.', observerSockets, observerResult.failures),
        formatRealtimeFailure('Editor failed to publish the mutation.', editorSockets, editorResult.failures),
      ].join('\n'), { cause: error })
    }

    assert.deepEqual([...observerResult.failures, ...editorResult.failures], [])
    const unsubscribed = observerSockets.sentFrames.filter(frame => frame.includes('"action":"unsubscribe"')).length
    await observerPage.locator('a[href="/admin/posts"]').first().click()
    await observerPage.waitForURL('**/admin/posts')
    await waitFor(
      () => observerSockets.sentFrames.filter(frame => frame.includes('"action":"unsubscribe"')).length > unsubscribed,
      formatRealtimeFailure('Leaving the page must release its live subscription.', observerSockets, observerResult.failures),
    )
    await observerPage.getByRole('link', { name: /realtime demo/i }).click()
    await observerPage.locator(`[data-post-id="${postId}"] h2`).waitFor()
    await waitFor(
      async () => (await observerPage.locator(`[data-post-id="${postId}"] h2`).textContent()) === title,
      'Returning to the page must restore its live data.',
    )
    assert.equal(await observerPage.locator(`[data-post-id="${postId}"] h2`).textContent(), title)
    await assertRealtimeMutationAfterLogout(baseUrl, appName, postId)
    await observerPage.reload({ waitUntil: 'domcontentloaded' })
    await observerPage.locator(`[data-post-id="${postId}"] h2`).waitFor()
    assert.equal(await observerPage.locator(`[data-post-id="${postId}"] h2`).textContent(), title, 'Rejected mutations must preserve the persisted title.')

  } finally {
    await context.close()
  }
}

async function assertPostCreationSavesNothingWithoutWorker(baseUrl) {
  const browser = await getExampleAppBrowser()
  const context = await browser.newContext({ baseURL: baseUrl })
  const title = `Unsaved while worker is unreachable ${Date.now()}`
  try {
    const page = await context.newPage()
    await signInAsExampleAppEditor(page)

    await page.goto('/admin/posts/new', { waitUntil: 'networkidle' })
    await page.locator('[name="title"]').fill(title)
    await page.locator('[name="excerpt"]').fill('Post creation must fail as a whole when realtime delivery is unavailable.')
    await page.locator('[name="body"]').fill('This post must not be stored, because its change notification cannot reach the broadcast worker.')
    const submission = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.startsWith('/admin/posts'))
    await page.getByRole('button', { name: 'Create post', exact: true }).click()
    assert.equal((await submission).status(), 500, 'Expected post creation to fail because the broadcast worker is unreachable.')

    await page.goto('/admin/posts', { waitUntil: 'networkidle' })
    assert.equal(await page.getByText(title).count(), 0, 'Expected a failed post creation to leave no saved post behind.')
  } finally {
    await context.close()
  }
}

export async function assertExampleAppRealtimeUnavailableBrowserFlow({ baseUrl, cookieHeader, appName }) {
  const browser = await getExampleAppBrowser()
  const context = await browser.newContext({ baseURL: baseUrl })

  try {
    await context.addCookies(cookieHeaderToBrowserCookies(baseUrl, cookieHeader))
    const page = await context.newPage()
    const result = collectPageFailures(page, { allowWebSocketConnectionErrors: true })

    await page.goto(realtimePath, { waitUntil: 'domcontentloaded' })
    assert.equal(new URL(page.url()).pathname, realtimePath)
    await page.getByRole('heading', { name: /realtime posts/i }).waitFor({ timeout: 20000 })
    await page.locator(postSelector).first().waitFor({ timeout: 20000 })
    await waitFor(
      () => result.warnings.some(warning => warning.includes(unavailableWorkerWarning)),
      `Expected the realtime page to warn when the broadcast worker is unreachable. Warnings: ${JSON.stringify(result.warnings)}`,
    )

    const firstPost = page.locator(postSelector).first()
    const postId = await firstPost.getAttribute('data-post-id')
    assert.ok(postId, 'Expected the realtime query to return posts without a broadcast worker.')

    await page.goto('/admin/posts', { waitUntil: 'domcontentloaded' })
    if (appName === 'blog-next') await waitForAppHydration(page)
    const navigationQueryResponsePromise = page.waitForResponse(response => (
      response.url().includes('/holo/realtime/query')
      && response.request().method() === 'POST'
    ))
    await page.getByRole('link', { name: /realtime demo/i }).click()
    const navigationQueryResponse = await navigationQueryResponsePromise
    assert.equal(navigationQueryResponse.status(), 200, 'Expected the realtime query to succeed after client navigation.')
    await page.locator(postSelector).first().waitFor({ timeout: 20000 })

    assert.deepEqual(result.failures, [])
    await assertPostCreationSavesNothingWithoutWorker(baseUrl)
    if (appName === 'blog-next') await assertNextRealtimeQueryAfterLogout(baseUrl)
  } finally {
    await context.close()
  }
}
