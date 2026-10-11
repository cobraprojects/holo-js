import { stopExampleAppProcess as stopProductionServer } from './example-app-process.mjs'
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

async function assertBrowserAuth(baseUrl, framework) {
  const browser = await getExampleAppBrowser()
  for (const account of [
    { path: '/login', email: 'editor@example.com', password: 'secret-secret', destination: '/admin', logout: 'Logout', signedOut: '/' },
    { path: '/super-admin/login', email: 'super-admin@example.com', password: 'admin-secret', destination: '/super-admin', logout: 'Sign out of super admin', signedOut: '/super-admin/login' },
  ]) {
    const context = await browser.newContext({ baseURL: baseUrl })
    try {
      const page = await context.newPage()
      const observed = observeExampleAppPage(page, {
        allowConsoleError: text => framework === 'nuxt' && text.includes('ERR_BLOCKED_BY_CLIENT'),
        allowRequestFailure: (url, error) => framework === 'nuxt' && url.includes('/api/auth/user') && (error === 'net::ERR_BLOCKED_BY_CLIENT' || error === 'inspector'),
      })
      await page.goto(account.path, { waitUntil: 'networkidle' })
      await page.locator('input[name="email"]').fill(account.email)
      await page.locator('input[name="password"]').fill(account.password)
      await Promise.all([
        page.waitForURL(url => url.pathname === account.destination),
        page.getByRole('button', { name: /^Sign in/i }).click(),
      ])
      await page.waitForLoadState('networkidle')
      let blocked = false
      if (framework === 'nuxt') {
        const session = await context.newCDPSession(page)
        await session.send('Network.enable')
        await session.send('Network.setBlockedURLs', { urls: ['*/api/auth/user*'] })
        session.on('Network.loadingFailed', event => {
          if (event.blockedReason === 'inspector') blocked = true
        })
      }
      const submissions = []
      page.on('response', response => {
        if (response.request().method() === 'POST') submissions.push(`${response.status()} ${response.url()}`)
      })
      try {
        await Promise.all([
          page.waitForURL(url => url.pathname === account.signedOut),
          page.getByRole('button', { name: account.logout, exact: true }).click(),
        ])
      } catch (error) {
        throw new Error(`Logout failed at ${page.url()}: ${submissions.join(', ')}. ${(await page.locator('body').innerText())}. ${observed.failures.join(', ')}`, { cause: error })
      }
      if (framework === 'nuxt') {
        assert.equal(blocked, true, 'Expected logout auth refresh to encounter the real blocked network request')
      }
      await page.goto(account.destination, { waitUntil: 'networkidle' })
      assert.equal(new URL(page.url()).pathname, account.path)
      assert.deepEqual(observed.failures, [])
    } finally {
      await context.close()
    }
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
    await assertBrowserAuth(baseUrl, cwd.split('/').at(-1)?.replace('blog-', ''))
    assert.doesNotMatch(
      output,
      /UnhandledPromiseRejection|uncaughtException|ReferenceError|TypeError:/,
    )
  } finally {
    await stopProductionServer(child)
  }
}
