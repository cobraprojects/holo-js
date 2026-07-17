import { chromium } from 'playwright'

let browserPromise

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

export async function getExampleAppBrowser() {
  browserPromise ??= chromium.launch({ headless: true }).catch((error) => {
    browserPromise = undefined
    throw error
  })

  return await browserPromise
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
