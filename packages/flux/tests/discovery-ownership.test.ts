import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { defineChannel, renderBroadcastAuthResponse } from '@holo-js/broadcast'
import { expect, it, onTestFinished } from 'vitest'
import { startNativeTransport } from './support/native-transport'

const execFileAsync = promisify(execFile)

it('keeps native private authorization on the active configuration after an older browser discovery completes', async () => {
  const directory = await mkdtemp(join(import.meta.dirname, '../.tmp-discovery-browser-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const entry = join(directory, 'entry.js')
  const bundle = join(directory, 'client.js')
  await writeFile(entry, `
    import { createFluxClient, fluxInternals } from ${JSON.stringify(resolve(import.meta.dirname, '../src/index.ts'))}
    globalThis.nativeFlux = createFluxClient({ connector: fluxInternals.createHoloWebSocketConnector({ configEndpoint: '/config' }) })
    globalThis.firstConnectionRejected = false
    globalThis.connectCancelled = () => { globalThis.nativeFlux.connect().catch(() => { globalThis.firstConnectionRejected = true }) }
    globalThis.connectCurrent = () => { globalThis.nativeFlux.connect().then(() => { globalThis.currentConnected = true }) }
    globalThis.subscribeNative = () => { globalThis.nativeFlux.private('App.Models.User.1') }
  `)
  await execFileAsync('bun', ['build', entry, '--target=browser', '--outfile', bundle])
  const javascript = await readFile(bundle)
  const discoveries: ServerResponse[] = []
  const authRequests: string[] = []
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.url === '/config') {
      outgoing.setHeader('content-type', 'application/json')
      outgoing.setHeader('cache-control', 'no-store')
      outgoing.flushHeaders()
      discoveries.push(outgoing)
      return
    }
    if (incoming.url === '/client.js') {
      outgoing.setHeader('content-type', 'text/javascript')
      outgoing.end(javascript)
      return
    }
    if (incoming.url?.endsWith('-auth')) {
      authRequests.push(incoming.url)
      const chunks: Buffer[] = []
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
      const response = await renderBroadcastAuthResponse(new Request('http://app.test/auth', {
        method: 'POST', headers: { 'content-type': incoming.headers['content-type'] ?? '' }, body: Buffer.concat(chunks),
      }), {
        appKey: 'key', appSecret: 'secret', user: { id: 1 },
        channelAuth: { definitions: [defineChannel('App.Models.User.{userId}', { type: 'private', authorize: () => true })] },
      })
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.end(await response.text())
      return
    }
    outgoing.setHeader('content-type', 'text/html')
    outgoing.end('<!doctype html><title>Native Flux</title><script src="/client.js"></script>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  onTestFinished(async () => {
    for (const discovery of discoveries) discovery.end()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Native discovery port unavailable')
  const transport = await startNativeTransport({ allowedOrigins: [`http://127.0.0.1:${address.port}`] })
  const browser = await chromium.launch({ headless: true })
  onTestFinished(() => browser.close())
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${address.port}`)
  await page.waitForFunction('typeof globalThis.connectCancelled === "function"')
  await page.evaluate('globalThis.connectCancelled()')
  await expect.poll(() => discoveries.length).toBe(1)
  await page.evaluate('globalThis.nativeFlux.disconnect()')
  await page.waitForFunction('globalThis.firstConnectionRejected === true')
  await page.evaluate('globalThis.connectCurrent()')
  await expect.poll(() => discoveries.length).toBe(2)
  const configuration = (authEndpoint: string) => JSON.stringify({ ...transport.connection, path: '/app', authEndpoint })
  discoveries[1]!.end(configuration('/new-auth'))
  await page.waitForFunction('globalThis.currentConnected === true')
  discoveries[0]!.end(configuration('/stale-auth'))
  await page.evaluate('globalThis.subscribeNative()')
  await expect.poll(() => transport.subscriptions()).toBe(1)
  expect(authRequests).toEqual(['/new-auth'])
  await page.evaluate('globalThis.nativeFlux.disconnect()')
  await expect.poll(() => transport.subscriptions()).toBe(0)
}, 20_000)
