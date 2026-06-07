import assert from 'node:assert/strict'
import { chromium } from 'playwright'

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

function collectPageFailures(page) {
  const failures = []

  page.on('console', (message) => {
    if (message.type() === 'error') {
      failures.push(message.text())
    }
  })
  page.on('pageerror', (error) => {
    failures.push(error.message)
  })
  page.on('response', (response) => {
    if (response.status() >= 500) {
      failures.push(`${response.status()} ${response.url()}`)
    }
  })

  return failures
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

  return activity
}

async function createPostThroughBrowser(page, title) {
  await page.goto(createPostPath, { waitUntil: 'networkidle' })
  await page.locator('input[name="title"]').fill(title)
  await page.locator('textarea[name="excerpt"]').fill('Created by the real browser broadcast flow.')
  await page.locator('textarea[name="body"]').fill('This post verifies that Flux receives a broadcast event in a real browser session.')
  await page.locator('select[name="status"]').selectOption('draft')
  await page.locator('select[name="categoryId"]').selectOption('')

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
  const browser = await chromium.launch({ headless: true })

  try {
    const context = await browser.newContext({ baseURL: baseUrl })
    await context.addCookies(cookieHeaderToBrowserCookies(baseUrl, cookieHeader))
    const dashboardPage = await context.newPage()
    const createPage = await context.newPage()
    const dashboardFailures = collectPageFailures(dashboardPage)
    const createFailures = collectPageFailures(createPage)

    const activity = await openSubscribedDashboard(dashboardPage, dashboardFailures)
    const title = `Browser broadcast ${appName} ${Date.now()}`

    await createPostThroughBrowser(createPage, title)
    await waitFor(
      async () => (await activity.textContent())?.trim() === `created: ${title}`,
      `Expected the dashboard broadcast activity to show created: ${title}.`,
    )

    assert.deepEqual([...dashboardFailures, ...createFailures], [])
    await context.close()
  } finally {
    await browser.close()
  }
}
