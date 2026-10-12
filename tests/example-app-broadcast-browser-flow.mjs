import assert from 'node:assert/strict'
import { getExampleAppBrowser, observeExampleAppPage } from './example-app-browser.mjs'

const adminPath = '/admin'
const createPostPath = '/admin/posts/new'
const activitySelector = '[data-testid="broadcast-post-activity"]'

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

function formatBroadcastFailure(message, sockets, failures) {
  return [
    message,
    `WebSocket URLs: ${JSON.stringify(sockets.urls)}`,
    `Sent frames: ${JSON.stringify(sockets.sentFrames)}`,
    `Received frames: ${JSON.stringify(sockets.receivedFrames)}`,
    `Page failures: ${JSON.stringify(failures)}`,
  ].join('\n')
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

function observeWebSockets(page) {
  const urls = []
  const sentFrames = []
  const receivedFrames = []

  page.on('websocket', (socket) => {
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

async function openSubscribedDashboard(page, failures) {
  const sockets = observeWebSockets(page)
  await page.goto(adminPath, { waitUntil: 'domcontentloaded' })
  assert.equal(new URL(page.url()).pathname, adminPath)

  const activity = page.locator(activitySelector)
  await activity.waitFor({ timeout: 20000 })
  await waitFor(
    () => sockets.urls.some(url => url.includes('/app/')),
    formatBroadcastFailure('Expected the admin dashboard to open a broadcast WebSocket.', sockets, failures),
  )
  await waitFor(
    () => sockets.sentFrames.some(frame => frame.includes('pusher:subscribe') && frame.includes('private-blog.admin')),
    formatBroadcastFailure('Expected the browser to subscribe to the private blog.admin broadcast channel.', sockets, failures),
  )
  await waitFor(
    () => sockets.receivedFrames.some(frame => frame.includes('subscription_succeeded') && frame.includes('private-blog.admin')),
    formatBroadcastFailure('Expected the browser broadcast subscription to be authorized.', sockets, failures),
  )

  return { activity, sockets }
}

async function createPostThroughBrowser(page, title) {
  await page.goto(createPostPath, { waitUntil: 'networkidle' })
  await page.locator('input[name="title"]').fill(title)
  await page.locator('textarea[name="excerpt"]').fill('Created by the real browser broadcast flow.')
  await page.locator('textarea[name="body"]').fill('This post verifies that Flux receives a broadcast event in a real browser session.')
  await page.locator('select[name="status"]').selectOption('draft')
  await page.locator('select[name="categoryId"]').selectOption({ index: 1 })

  const [response] = await Promise.all([
    page.waitForResponse(
      candidate => candidate.url().includes('/admin/posts') && candidate.request().method() === 'POST',
      { timeout: 20000 },
    ),
    page.getByRole('button', { name: /create post/i }).click(),
  ])
  const responseText = await response.text().catch(() => '')
  assert.ok(
    (response.status() >= 200 && response.status() < 400),
    `Expected creating a post to return a successful response, received ${response.status()} ${response.statusText()} ${responseText}`,
  )
  await waitFor(
    () => new URL(page.url()).pathname === '/admin/posts',
    `Expected creating a post to navigate to /admin/posts, received ${page.url()}.`,
  )
}

export async function assertExampleAppBroadcastBrowserFlow({ baseUrl, appName, cookieHeader }) {
  const browser = await getExampleAppBrowser()
  const context = await browser.newContext({ baseURL: baseUrl })

  try {
    await context.addCookies(cookieHeaderToBrowserCookies(baseUrl, cookieHeader))
    const dashboardPage = await context.newPage()
    const createPage = await context.newPage()
    const dashboardFailures = observeExampleAppPage(dashboardPage).failures
    const createFailures = observeExampleAppPage(createPage).failures

    const { activity, sockets } = await openSubscribedDashboard(dashboardPage, dashboardFailures)
    const authentication = await context.request.get('/api/auth/user')
    assert.equal(authentication.status(), 200)
    const { user, authenticated } = await authentication.json()
    assert.equal(authenticated, true)
    assert.ok(user?.email)
    const configuration = await context.request.get('/broadcasting/config')
    assert.equal(configuration.status(), 200)
    assert.equal(configuration.headers()['cache-control'], 'no-store')
    const clientConfiguration = await configuration.json()
    assert.equal(clientConfiguration.authEndpoint, '/broadcasting/auth')
    assert.equal(Object.hasOwn(clientConfiguration, 'secret'), false)
    const csrfCookie = (await context.cookies()).find(cookie => cookie.name === 'XSRF-TOKEN')
    assert.ok(csrfCookie)
    const headers = { Origin: baseUrl, 'X-CSRF-TOKEN': decodeURIComponent(csrfCookie.value) }
    const authorize = channel => context.request.post('/broadcasting/auth', { headers, form: { channel_name: channel, socket_id: 'native.http' } })
    const privateAuthorization = await authorize('private-blog.admin')
    assert.equal(privateAuthorization.status(), 200)
    const privatePayload = await privateAuthorization.json()
    assert.deepEqual({ ok: privatePayload.ok, channel: privatePayload.channel, type: privatePayload.type, params: privatePayload.params, whispers: privatePayload.whispers }, {
      ok: true, channel: 'private-blog.admin', type: 'private', params: {}, whispers: [],
    })
    assert.equal(privatePayload.auth.split(':')[0], clientConfiguration.key)
    assert.match(privatePayload.auth.split(':')[1], /^[a-f0-9]{64}$/)
    const presenceAuthorization = await authorize('presence-blog.admin.presence')
    assert.equal(presenceAuthorization.status(), 200)
    const presencePayload = await presenceAuthorization.json()
    assert.deepEqual(presencePayload.member, { id: String(user.id), email: user.email })
    assert.deepEqual(JSON.parse(presencePayload.channel_data), { member: presencePayload.member, whispers: [] })
    const unknown = await authorize('private-unregistered.channel')
    assert.equal(unknown.status(), 404)
    assert.equal((await unknown.json()).error, 'not-found')
    const malformed = await context.request.post('/broadcasting/auth', { headers, form: { socket_id: 'native.http' } })
    assert.equal(malformed.status(), 400)
    const visitor = await browser.newContext({ baseURL: baseUrl })
    try {
      assert.equal((await visitor.request.get('/login')).status(), 200)
      const cookie = (await visitor.cookies()).find(cookie => cookie.name === 'XSRF-TOKEN')
      assert.ok(cookie)
      const rejected = await visitor.request.post('/broadcasting/auth', {
        headers: { Origin: baseUrl, 'X-CSRF-TOKEN': decodeURIComponent(cookie.value) },
        form: { channel_name: 'private-blog.admin', socket_id: 'native.http' },
      })
      assert.equal(rejected.status(), 401)
      assert.equal((await rejected.json()).error, 'unauthenticated')
    } finally {
      await visitor.close()
    }
    const members = async page => JSON.parse(await page.getByTestId('broadcast-presence').textContent())
    await waitFor(async () => (await members(dashboardPage)).some(member => member.email === user.email && member.id === String(user.id)), 'Expected the authenticated user to appear in native presence.').catch(async error => {
      throw new Error(formatBroadcastFailure(`${error.message} Expected ${JSON.stringify(user)}; rendered ${JSON.stringify(await members(dashboardPage))}.`, sockets, dashboardFailures))
    })
    assert.equal((await members(dashboardPage)).length, 1)
    const secondDashboard = await context.newPage()
    const secondFailures = observeExampleAppPage(secondDashboard).failures
    await openSubscribedDashboard(secondDashboard, secondFailures)
    await waitFor(async () => (await members(secondDashboard)).some(member => member.email === user.email && member.id === String(user.id)), 'Expected a second tab to join native presence.')
    assert.equal((await members(secondDashboard)).length, 1)
    await secondDashboard.close()
    assert.equal((await members(dashboardPage)).length, 1)
    const title = `Browser broadcast ${appName} ${Date.now()}`

    await createPostThroughBrowser(createPage, title)
    await waitFor(
      async () => (await activity.textContent())?.trim() === `created: ${title}`,
      `Expected the dashboard broadcast activity to show created: ${title}.`,
    )

    const channels = ['private-blog.admin', 'presence-blog.admin.presence']
    const unsubscribes = channel => sockets.sentFrames.filter(frame => frame.includes('pusher:unsubscribe') && frame.includes(channel)).length
    const previousUnsubscribes = new Map(channels.map(channel => [channel, unsubscribes(channel)]))
    await dashboardPage.getByRole('link', { name: 'Manage posts', exact: true }).click()
    await dashboardPage.waitForURL(url => url.pathname === '/admin/posts')
    for (const channel of channels) {
      await waitFor(
        () => unsubscribes(channel) > previousUnsubscribes.get(channel),
        formatBroadcastFailure(`Expected leaving the dashboard to unsubscribe ${channel}.`, sockets, dashboardFailures),
      )
    }

    assert.deepEqual([...dashboardFailures, ...createFailures, ...secondFailures], [])
  } finally {
    await context.close()
  }
}
