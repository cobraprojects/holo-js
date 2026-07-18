import assert from 'node:assert/strict'
import { getExampleAppBrowser, observeExampleAppPage } from './example-app-browser.mjs'

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

  return sockets
}

export async function assertExampleAppRealtimeBrowserFlow({ baseUrl, appName, cookieHeader }) {
  const browser = await getExampleAppBrowser()
  const context = await browser.newContext({ baseURL: baseUrl })

  try {
    await context.addCookies(cookieHeaderToBrowserCookies(baseUrl, cookieHeader))
    const observerPage = await context.newPage()
    const editorPage = await context.newPage()
    const observerResult = collectPageFailures(observerPage)
    const editorResult = collectPageFailures(editorPage)
    await openRealtimePage(observerPage, observerResult.failures)
    await openRealtimePage(editorPage, editorResult.failures)
    const firstPost = editorPage.locator(postSelector).first()
    const postId = await firstPost.getAttribute('data-post-id')
    assert.ok(postId, 'Expected the realtime page to render post ids.')

    const title = `Realtime ${appName} ${Date.now()}`
    await firstPost.getByRole('button', { name: /edit title/i }).click()
    await editorPage.getByLabel('Realtime post title').fill(title)
    await editorPage.getByRole('button', { name: /save realtime title/i }).click()
    await waitFor(
      async () => (await observerPage.locator(`[data-post-id="${postId}"] h2`).textContent()) === title,
      `Expected realtime subscriber to show updated title "${title}".`,
    )

    assert.deepEqual([...observerResult.failures, ...editorResult.failures], [])
  } finally {
    await context.close()
  }
}

export async function assertExampleAppRealtimeUnavailableBrowserFlow({ baseUrl, cookieHeader }) {
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
    const navigationQueryResponsePromise = page.waitForResponse(response => (
      response.url().includes('/holo/realtime/query')
      && response.request().method() === 'POST'
    ))
    await page.getByRole('link', { name: /realtime demo/i }).click()
    const navigationQueryResponse = await navigationQueryResponsePromise
    assert.equal(navigationQueryResponse.status(), 200, 'Expected the realtime query to succeed after client navigation.')
    await page.locator(postSelector).first().waitFor({ timeout: 20000 })

    assert.deepEqual(result.failures, [])
  } finally {
    await context.close()
  }
}
