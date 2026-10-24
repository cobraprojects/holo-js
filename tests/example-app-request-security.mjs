import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newExampleAppContext, observeExampleAppPage } from './example-app-browser.mjs'

const pngPixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const disguisedScript = '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><script>alert("holo-xss")</script></body></html>'

async function assertPublicStorageServesPassiveFilesOnly(baseUrl, publicRoot) {
  const directory = join(publicRoot, 'request-security')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'pixel.png'), pngPixel)
  await writeFile(join(directory, 'avatar.png'), disguisedScript)
  const context = await newExampleAppContext({ baseURL: baseUrl, acceptDownloads: true })
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

async function clientAddress(baseUrl, headers = {}) {
  const response = await fetch(`${baseUrl}/api/framework/client-address`, { headers })
  const body = await response.json().catch(() => undefined)
  return { status: response.status, address: body?.address }
}

const spoofedHeaders = { 'x-forwarded-for': '203.0.113.66', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'attacker.test' }

async function waitForStableClientAddress(baseUrl, predicate, message) {
  const deadline = Date.now() + 60000
  const stableFor = 5000
  let observed
  let stableSince
  while (Date.now() < deadline) {
    observed = await clientAddress(baseUrl, spoofedHeaders).catch(() => undefined)
    if (observed && predicate(observed)) {
      stableSince ??= Date.now()
      if (Date.now() - stableSince >= stableFor) return
    } else {
      stableSince = undefined
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.fail(`${message} Last response: ${JSON.stringify(observed)}`)
}

async function assertTrustedProxyHeaders(baseUrl, guestPath) {
  assert.ok(['127.0.0.1', '::1'].includes((await clientAddress(baseUrl)).address), 'Expected a direct visitor to be identified by its connection address.')
  assert.deepEqual(
    await clientAddress(baseUrl, { 'x-forwarded-for': '203.0.113.66, 192.0.2.10' }),
    { status: 200, address: '192.0.2.10' },
    'Expected the client address appended by the trusted proxy, not the one the visitor supplied.',
  )
  assert.deepEqual(
    await clientAddress(baseUrl, { 'x-forwarded-for': '192.0.2.10', forwarded: 'for=203.0.113.66' }),
    { status: 200, address: '192.0.2.10' },
    'Expected the Forwarded header to be ignored, as Laravel does.',
  )

  for (const headers of [{ 'x-forwarded-host': 'bad host' }, { 'x-forwarded-port': 'abc' }]) {
    const response = await fetch(`${baseUrl}${guestPath}`, { headers, redirect: 'manual' })
    assert.equal(response.status, 400, `Expected malformed trusted proxy headers ${JSON.stringify(headers)} to be rejected as a bad request.`)
  }

  const secure = await fetch(`${baseUrl}${guestPath}`, { headers: { 'x-forwarded-proto': 'https' }, redirect: 'manual' })
  assert.equal(secure.status, 200)
  assert.match(csrfCookie(secure) ?? '', /;\s*Secure/i)
}

async function assertUntrustedPeerHeadersIgnored(baseUrl, cwd, guestPath, exposesConnectionAddress, getOutput) {
  const configPath = join(cwd, 'config/security.ts')
  const originalConfig = await readFile(configPath, 'utf8')
  const untrustedConfig = originalConfig.replace(/trustedProxies: [^\n]+,/u, "trustedProxies: ['192.0.2.1'],")
  assert.notEqual(untrustedConfig, originalConfig, 'Expected the example app to configure trustedProxies.')
  try {
    await writeFile(configPath, untrustedConfig)
    await waitForStableClientAddress(
      baseUrl,
      ({ address }) => address !== spoofedHeaders['x-forwarded-for'],
      'Expected the development app to reload its trusted proxies.',
    )
    const spoofed = await clientAddress(baseUrl, spoofedHeaders)
    if (exposesConnectionAddress) {
      assert.equal(spoofed.status, 200)
      assert.ok(['127.0.0.1', '::1'].includes(spoofed.address), `Expected X-Forwarded-For from an untrusted peer to be ignored, received ${JSON.stringify(spoofed)}.`)
    } else {
      assert.deepEqual(spoofed, { status: 503, address: null }, 'Expected the client address to be reported as unavailable instead of read from an untrusted peer.')
    }
    const page = await fetch(`${baseUrl}${guestPath}`, { headers: { ...spoofedHeaders, 'x-forwarded-host': 'bad host', 'x-forwarded-port': 'abc' }, redirect: 'manual' })
    assert.equal(page.status, 200, 'Expected X-Forwarded-Host and X-Forwarded-Port from an untrusted peer to be ignored instead of validated.')
    if (exposesConnectionAddress) {
      assert.doesNotMatch(csrfCookie(page) ?? '', /;\s*Secure/i, 'Expected X-Forwarded-Proto from an untrusted peer to be ignored.')
    }
    if (getOutput) {
      assert.doesNotMatch(getOutput(), /SecurityClientAddressUnavailableError/, 'Expected the unavailable client address to be handled by the route instead of logged as an error.')
    }
  } finally {
    await writeFile(configPath, originalConfig)
    await waitForStableClientAddress(
      baseUrl,
      ({ address }) => address === spoofedHeaders['x-forwarded-for'],
      'Expected the development app to restore its trusted proxies.',
    )
  }
}

export async function assertExampleAppRequestSecurity({ baseUrl, cwd, guestPath = '/login', exposesConnectionAddress = true, getOutput }) {
  await assertPublicStorageServesPassiveFilesOnly(baseUrl, join(cwd, 'storage/app/public'))
  await assertTrustedProxyHeaders(baseUrl, guestPath)
  await assertUntrustedPeerHeadersIgnored(baseUrl, cwd, guestPath, exposesConnectionAddress, getOutput)
}
