import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const { chromium } = createRequire(join(root, 'package.json'))('playwright')
const cliPath = join(root, 'packages/cli/dist/bin/holo.mjs')
const browser = await chromium.launch({ headless: true })
const apps = process.argv.slice(2)

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return

  server.kill('SIGTERM')
  await Promise.race([
    new Promise(resolvePromise => server.once('exit', resolvePromise)),
    new Promise(resolvePromise => setTimeout(resolvePromise, 5000)),
  ])
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL')
  }
}

try {
  for (const [index, app] of (apps.length ? apps : ['blog-next', 'blog-nuxt', 'blog-sveltekit']).entries()) {
    const port = 3520 + index
    const origin = `http://localhost:${port}`
    let output = ''
    const server = spawn(process.execPath, [cliPath, 'start'], { cwd: join(root, 'apps', app), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: String(port), NITRO_PORT: String(port), APP_URL: origin, ORIGIN: origin } })
    server.stdout.on('data', data => { output += data })
    server.stderr.on('data', data => { output += data })
    const context = await browser.newContext()
    try {
      let ready = false
      for (let attempt = 0; attempt < 120; attempt++) {
        if (server.exitCode !== null) break
        try { ready = (await fetch(`${origin}/login`)).ok } catch { ready = false }
        if (ready) break
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      assert.ok(ready, `${app}: ${output}`)
      const page = await context.newPage()
      const exceptions = []
      const posts = []
      page.on('pageerror', error => exceptions.push(error.message))
      page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()) })
      await page.goto(`${origin}/login`, { waitUntil: 'networkidle' })
      const email = page.locator('input[name="email"]')
      await email.fill('invalid')
      assert.equal(await page.getByText('Enter a valid email address.', { exact: true }).count(), 0)
      await email.press('Tab')
      await page.getByText('Enter a valid email address.', { exact: true }).waitFor()
      await email.fill('reader@example.com')
      await email.press('Tab')
      await page.getByText('Enter a valid email address.', { exact: true }).waitFor({ state: 'detached' })
      await email.fill('')
      await email.press('Tab')
      await page.getByText('Email is required.', { exact: true }).waitFor()
      const password = page.locator('input[name="password"]')
      await password.fill('short')
      await password.press('Tab')
      await page.getByText('Password must be at least 8 characters.', { exact: true }).waitFor()
      await password.fill('valid-password')
      await password.press('Tab')
      await page.getByText('Password must be at least 8 characters.', { exact: true }).waitFor({ state: 'detached' })
      await page.goto(`${origin}/register`, { waitUntil: 'networkidle' })
      await page.locator('input[name="name"]').fill('ab')
      await page.locator('input[name="name"]').press('Tab')
      await page.getByText('Name must be at least 3 characters.', { exact: true }).waitFor()
      await page.locator('input[name="name"]').fill('Alice')
      await page.locator('input[name="name"]').press('Tab')
      await page.getByText('Name must be at least 3 characters.', { exact: true }).waitFor({ state: 'detached' })
      assert.deepEqual(posts, [], `${app}: blur must validate locally`)
      assert.deepEqual(exceptions, [], `${app}: browser exceptions`)
      process.stdout.write(`${app}: production login/register blur validation passed; no validation requests or browser exceptions\n`)
    } finally {
      await context.close()
      await stopServer(server)
    }
  }
} finally {
  await browser.close()
}
