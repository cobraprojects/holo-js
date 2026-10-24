import { chromium } from 'playwright'

let browserPromise
const nextPageUpdates = new Set(['addedPage', 'removedPage', 'reloadPage', 'serverComponentChanges', 'staticParamsChanged', 'turbopack-message'])

export function observeExampleAppPage(page, options = {}) {
  const failures = []
  const warnings = []

  page.on('console', (message) => {
    const text = message.text()
    if (message.type() === 'warning') {
      warnings.push(text)
    }
    if (message.type() === 'error' && !options.allowConsoleError?.(text)) {
      failures.push(`console.error: ${text}`)
    }
  })
  page.on('pageerror', error => failures.push(`pageerror: ${error.message}`))
  page.on('crash', () => failures.push('page crashed'))
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'unknown request failure'
    if (failure === 'net::ERR_ABORTED') {
      return
    }
    if (!options.allowRequestFailure?.(request.url(), failure)) {
      failures.push(`requestfailed: ${request.method()} ${request.url()} ${failure}`)
    }
  })
  page.on('response', (response) => {
    if (response.status() >= 500) {
      failures.push(`${response.status()} ${response.url()}`)
    }
  })

  return { failures, warnings }
}

export async function signInAsExampleAppEditor(page) {
  await page.goto('/login', { waitUntil: 'networkidle' })
  await page.locator('[name="email"]').fill('editor@example.com')
  await page.locator('[name="password"]').fill('secret-secret')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.waitForURL(url => url.pathname === '/admin', { timeout: 20000 })
}

async function getExampleAppBrowser() {
  browserPromise ??= chromium.launch({ headless: true }).catch((error) => {
    browserPromise = undefined
    throw error
  })

  return await browserPromise
}

function isNextPageUpdate(message) {
  try {
    return nextPageUpdates.has(JSON.parse(message)?.type)
  } catch {
    return false
  }
}

export async function newExampleAppContext(options) {
  const browser = await getExampleAppBrowser()
  const context = await browser.newContext(options)
  await context.routeWebSocket(/\/_next\/hmr(?:\?|$)/, (page) => {
    const server = page.connectToServer()
    server.onMessage((message) => {
      if (!isNextPageUpdate(message)) page.send(message)
    })
    server.onClose(() => {})
  })
  return context
}

export async function closeExampleAppBrowser() {
  if (!browserPromise) {
    return
  }

  const browser = await browserPromise
  browserPromise = undefined
  await browser.close()
}

async function closeBrowserOnExit() {
  try {
    await closeExampleAppBrowser()
  } catch {
    browserPromise = undefined
  }
}

process.once('beforeExit', () => {
  void closeBrowserOnExit()
})
