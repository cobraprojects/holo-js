import { stopExampleAppProcess as stopProductionServer } from './example-app-process.mjs'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { assertExampleAppAuthFlow } from './example-app-auth-flow.mjs'
import { getExampleAppBrowser, observeExampleAppPage } from './example-app-browser.mjs'
import { assertExampleAppFormsBrowserFlow } from './example-app-forms-browser-flow.mjs'
import { clearExampleAppRateLimitBuckets } from './example-app-rate-limit.mjs'
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

async function assertBrowserNavigation(baseUrl, expectedTitle, framework) {
  const browser = await getExampleAppBrowser()
  const context = await browser.newContext({ baseURL: baseUrl })
  try {
    const page = await context.newPage()
    const observed = observeExampleAppPage(page)
    await page.goto('/', { waitUntil: 'networkidle' })
    await expectPageText(page, expectedTitle)
    const detail = await page.goto(`/posts/shipping-a-real-holo-blog-on-${framework}`, { waitUntil: 'networkidle' })
    assert.equal(detail?.status(), 200)
    await expectPageText(page, 'Primary topic')
    assert.ok(await page.locator('time[datetime]').count() > 0)
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
      const guard = account.destination === '/admin' ? 'web' : 'admin'
      const otherGuard = guard === 'web' ? 'admin' : 'web'
      const current = await context.request.get(`/api/auth/user?guard=${guard}`)
      assert.equal(current.status(), 200)
      assert.equal((await current.json()).authenticated, true)
      const other = await context.request.get(`/api/auth/user?guard=${otherGuard}`)
      assert.equal(other.status(), 200)
      assert.equal((await other.json()).authenticated, false)
      await page.goto(account.path, { waitUntil: 'networkidle' })
      assert.equal(new URL(page.url()).pathname, account.destination)
      if (framework === 'nuxt') {
        for (const mode of ['guest-regex', 'guest-function', 'guest-wildcard']) {
          const response = await context.request.get(`/framework/auth?mode=${mode}&guard=${guard}`, { maxRedirects: 0 })
          assert.equal(response.status(), 302, `${guard} ${mode}`)
          assert.equal(response.headers().location, account.destination)
        }
        for (const mode of ['guest-self', 'guest-unmatched', 'auth-wildcard']) {
          const response = await context.request.get(`/framework/auth?mode=${mode}&guard=${guard}`, { maxRedirects: 0 })
          assert.equal(response.status(), 200, await response.text())
        }
        await page.goto(`/framework/auth?guard=${guard}`, { waitUntil: 'networkidle' })
        assert.equal(await page.getByTestId('authenticated').innerText(), 'true')
        assert.equal(await page.getByTestId('user').innerText(), account.email)
        await page.goto(`/framework/auth?guard=${guard}&absolute=1`, { waitUntil: 'networkidle' })
        await page.getByRole('button', { name: 'Refresh authentication', exact: true }).click()
        await page.getByTestId('authenticated').filter({ hasText: 'true' }).waitFor()
        assert.equal(await page.getByTestId('user').innerText(), account.email)
        const invalidGuard = await context.request.get('/api/auth/user?guard=missing')
        assert.equal(invalidGuard.status(), 400)
        await page.goto('/framework/auth?guard=missing', { waitUntil: 'networkidle' })
        assert.equal(await page.getByTestId('authenticated').innerText(), 'false')
        assert.equal(await page.getByTestId('provider').innerText(), 'none')
        assert.equal(await page.getByTestId('user').innerText(), 'none')
        await page.goto(`/framework/auth?guard=${otherGuard}`, { waitUntil: 'networkidle' })
        assert.equal(await page.getByTestId('authenticated').innerText(), 'false')
        assert.equal(await page.getByTestId('user').innerText(), 'none')
        await page.goto(`/framework/auth?guard=${guard}`, { waitUntil: 'networkidle' })
        const csrfCookie = (await context.cookies()).find(cookie => cookie.name === 'XSRF-TOKEN')
        assert.ok(csrfCookie)
        const headers = { origin: baseUrl, 'x-csrf-token': decodeURIComponent(csrfCookie.value) }
        const endpoint = guard === 'admin' ? '/api/super-admin' : '/api'
        const logout = await context.request.post(`${endpoint}/logout`, { headers })
        assert.equal(logout.status(), 200, await logout.text())
        await page.getByRole('button', { name: 'Refresh authentication', exact: true }).click()
        await page.getByTestId('authenticated').filter({ hasText: 'false' }).waitFor()
        assert.equal(await page.getByTestId('user').innerText(), 'none')
        await page.goto(`/framework/auth?guard=${guard}`, { waitUntil: 'networkidle' })
        const refreshedCsrfCookie = (await context.cookies()).find(cookie => cookie.name === 'XSRF-TOKEN')
        assert.ok(refreshedCsrfCookie)
        const loginHeaders = { origin: baseUrl, 'x-csrf-token': decodeURIComponent(refreshedCsrfCookie.value) }
        const login = await context.request.post(`${endpoint}/login`, {
          headers: loginHeaders, form: { email: account.email, password: account.password },
        })
        assert.equal(login.status(), 200, await login.text())
        await page.getByRole('button', { name: 'Refresh authentication', exact: true }).click()
        await page.getByTestId('authenticated').filter({ hasText: 'true' }).waitFor()
        assert.equal(await page.getByTestId('user').innerText(), account.email)
        await page.goto(account.destination, { waitUntil: 'networkidle' })
      }
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
      if (framework === 'nuxt') {
        for (const mode of ['auth-regex', 'auth-function', 'auth-wildcard']) {
          const response = await context.request.get(`/framework/auth?mode=${mode}&guard=${guard}`, { maxRedirects: 0 })
          assert.equal(response.status(), 302, `${guard} ${mode}`)
          assert.equal(response.headers().location, account.path)
        }
        const response = await context.request.get(`/framework/auth?mode=auth-self&guard=${guard}`, { maxRedirects: 0 })
        assert.equal(response.status(), 200, await response.text())
      }
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

async function assertFailedProductionInitialization(cwd, baseUrl, env, portArguments) {
  await clearExampleAppRateLimitBuckets(cwd)
  let output = ''
  const child = spawn('bun', ['run', 'start', ...portArguments], {
    cwd,
    detached: true,
    env: { ...process.env, ...env, DB_DRIVER: 'invalid' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => output += String(chunk))
  child.stderr.on('data', chunk => output += String(chunk))
  try {
    const deadline = Date.now() + 20000
    let failed = false
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        assert.notEqual(child.exitCode, 0, output)
        failed = true
        break
      }
      const response = await fetch(`${baseUrl}/api/auth/user`).catch(() => undefined)
      if (response) {
        const body = await response.text()
        assert.equal(response.status, 500, body)
        const payload = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(body) : undefined
        output += typeof payload?.message === 'string' ? payload.message : body
        failed = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(failed, `The production app must reject requests when database initialization fails.\n${output}`)
    assert.match(output, /Unsupported Holo database driver "invalid"/)
  } finally {
    await stopProductionServer(child, 'SIGINT')
  }
}

export async function assertExampleAppProductionFlow({
  cwd,
  baseUrl,
  env,
  expectedTitle,
  auth,
}) {
  const framework = cwd.split('/').at(-1)?.replace('blog-', '')
  for (const argument of ['--port=433434', '--port=abc', '--port=', '--port']) {
    const invalidPort = spawnSync('bun', ['run', 'start', argument], {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 10000,
    })
    assert.equal(invalidPort.error, undefined)
    assert.notEqual(invalidPort.status, 0)
    assert.match(invalidPort.stderr, /--port must be an integer between 0 and 65535/)
  }
  const port = new URL(baseUrl).port
  const portArguments = env.DB_DRIVER === 'postgres' ? [`--port=${port}`] : env.DB_DRIVER === 'mysql' ? ['--port', port] : []
  const serverEnv = portArguments.length > 0 ? { ...env, PORT: '1', NITRO_PORT: '1' } : env
  await assertFailedProductionInitialization(cwd, baseUrl, serverEnv, portArguments)
  await clearExampleAppRateLimitBuckets(cwd)
  let output = ''
  const child = spawn('bun', ['run', 'start', ...portArguments], {
    cwd,
    detached: true,
    env: { ...process.env, ...serverEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', chunk => output += String(chunk))
  child.stderr?.on('data', chunk => output += String(chunk))

  try {
    await waitForProductionApp(baseUrl, expectedTitle, child, () => output)
    await assertBrowserNavigation(baseUrl, expectedTitle, framework)
    if (framework === 'nuxt' || framework === 'sveltekit') await assertExampleAppFormsBrowserFlow({ baseUrl, framework })
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
    await stopProductionServer(child, 'SIGINT')
  }
}
