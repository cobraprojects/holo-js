import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { assertExampleAppAuthFlow } from './example-app-auth-flow.mjs'
import { getExampleAppBrowser, observeExampleAppPage } from './example-app-browser.mjs'
import { assertExampleAppTokenAuthFlow } from './example-app-token-auth-flow.mjs'

async function waitForProductionApp(baseUrl, expectedTitle, child, output) {
  const deadline = Date.now() + 45000
  let lastError
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Production server exited with code ${child.exitCode}.\n${output()}`)
    }

    try {
      const response = await fetch(baseUrl)
      const body = await response.text()
      assert.equal(response.status, 200, body)
      assert.match(body, new RegExp(expectedTitle))
      return
    } catch (error) {
      lastError = error
    }

    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }

  throw new Error(`Timed out waiting for ${baseUrl}: ${lastError instanceof Error ? lastError.message : String(lastError)}\n${output()}`)
}

async function stopProductionServer(child) {
  if (child.exitCode !== null) return

  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
  await Promise.race([
    new Promise(resolvePromise => child.once('close', resolvePromise)),
    new Promise(resolvePromise => setTimeout(resolvePromise, 5000)),
  ])
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

async function assertBrowserNavigation(baseUrl, expectedTitle) {
  const browser = await getExampleAppBrowser()
  const context = await browser.newContext({ baseURL: baseUrl })
  try {
    const page = await context.newPage()
    const observed = observeExampleAppPage(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    await expectPageText(page, expectedTitle)
    await page.goto('/login', { waitUntil: 'networkidle' })
    assert.equal(new URL(page.url()).pathname, '/login')
    await page.goto('/register', { waitUntil: 'networkidle' })
    assert.equal(new URL(page.url()).pathname, '/register')
    await page.goto('/admin', { waitUntil: 'networkidle' })
    assert.equal(new URL(page.url()).pathname, '/login')
    assert.deepEqual(observed.failures, [])
  } finally {
    await context.close()
  }
}

async function expectPageText(page, expectedText) {
  const body = await page.locator('body').innerText()
  assert.match(body, new RegExp(expectedText))
}

export async function assertExampleAppProductionFlow({
  cwd,
  baseUrl,
  env,
  expectedTitle,
  auth,
}) {
  let output = ''
  const child = spawn('bun', ['run', 'start'], {
    cwd,
    detached: true,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', chunk => output += String(chunk))
  child.stderr?.on('data', chunk => output += String(chunk))

  try {
    await waitForProductionApp(baseUrl, expectedTitle, child, () => output)
    await assertBrowserNavigation(baseUrl, expectedTitle)
    await assertExampleAppAuthFlow({
      baseUrl,
      getOutput: () => output,
      ...auth,
    })
    await assertExampleAppTokenAuthFlow({ baseUrl, expectedTitle })
    assert.doesNotMatch(
      output,
      /UnhandledPromiseRejection|uncaughtException|ReferenceError|TypeError:/,
    )
  } finally {
    await stopProductionServer(child)
  }
}
