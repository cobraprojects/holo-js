import { chromium } from 'playwright'

let browserPromise

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
