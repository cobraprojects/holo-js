import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getExampleAppBrowser, observeExampleAppPage } from './example-app-browser.mjs'

const pngPixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const disguisedScript = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><script>alert("holo-xss")</script></body></html>'

async function assertPublicStorageServesPassiveFilesOnly(baseUrl, publicRoot) {
  const directory = join(publicRoot, 'request-security')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'pixel.png'), pngPixel)
  await writeFile(join(directory, 'avatar.png'), disguisedScript)
  const browser = await getExampleAppBrowser()
  const context = await browser.newContext({ baseURL: baseUrl, acceptDownloads: true })
  try {
    const page = await context.newPage()
    const observed = observeExampleAppPage(page)
    const dialogs = []
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.message())
      await dialog.dismiss()
    })

    await page.goto('/login', { waitUntil: 'networkidle' })
    const naturalWidth = await page.evaluate(async () => {
      const image = new globalThis.Image()
      image.src = '/storage/request-security/pixel.png'
      await image.decode()
      return image.naturalWidth
    })
    assert.equal(naturalWidth, 1, 'Expected public storage images to render inline in the browser.')

    const download = page.waitForEvent('download')
    await page.goto('/storage/request-security/avatar.png').catch(() => undefined)
    assert.equal((await download).suggestedFilename(), 'avatar.png')
    assert.deepEqual(dialogs, [], 'Expected script-capable uploads to download instead of executing.')
    assert.deepEqual(observed.failures, [])
  } finally {
    await context.close()
  }

  const disguised = await fetch(`${baseUrl}/storage/request-security/avatar.png`)
  assert.equal(disguised.status, 200)
  assert.equal(disguised.headers.get('content-type'), 'application/octet-stream')
  assert.equal(disguised.headers.get('content-disposition'), 'attachment')
  assert.equal(disguised.headers.get('x-content-type-options'), 'nosniff')

  const range = await fetch(`${baseUrl}/storage/request-security/pixel.png`, { headers: { range: 'bytes=0-7' } })
  assert.equal(range.status, 206)
  assert.equal(range.headers.get('content-type'), 'image/png')
  assert.equal(range.headers.get('content-range'), `bytes 0-7/${pngPixel.length}`)
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), pngPixel.subarray(0, 8))
  await rm(directory, { recursive: true, force: true })
}

function csrfCookie(response) {
  return response.headers.getSetCookie().find(cookie => cookie.startsWith('XSRF-TOKEN='))
}

async function assertTrustedProxyHeaders(baseUrl, guestPath) {
  for (const headers of [{ 'x-forwarded-proto': 'wss' }, { 'x-forwarded-host': 'bad host' }]) {
    const response = await fetch(`${baseUrl}${guestPath}`, { headers, redirect: 'manual' })
    assert.equal(response.status, 400, `Expected malformed trusted proxy headers ${JSON.stringify(headers)} to be rejected as a bad request.`)
  }

  const secure = await fetch(`${baseUrl}${guestPath}`, { headers: { 'x-forwarded-proto': 'https' }, redirect: 'manual' })
  assert.equal(secure.status, 200)
  assert.match(csrfCookie(secure) ?? '', /;\s*Secure/i)

  const injected = await fetch(`${baseUrl}${guestPath}`, { headers: { forwarded: 'proto=https;host=attacker.example' }, redirect: 'manual' })
  assert.equal(injected.status, 200)
  assert.ok(csrfCookie(injected), 'Expected a CSRF cookie for a guest page.')
  assert.doesNotMatch(csrfCookie(injected), /;\s*Secure/i, 'Expected the X-Forwarded trust mode to ignore client Forwarded headers.')
  assert.doesNotMatch(await injected.text(), /attacker\.example/)
}

export async function assertExampleAppRequestSecurity({ baseUrl, cwd, guestPath = '/login' }) {
  await assertPublicStorageServesPassiveFilesOnly(baseUrl, join(cwd, 'storage/app/public'))
  await assertTrustedProxyHeaders(baseUrl, guestPath)
}
