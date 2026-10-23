import { request as httpRequest } from 'node:http'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createApp, defineEventHandler } from 'h3'
import { requestUrlInternals, resolveRequestUrl } from '@holo-js/kernel'
import { createWebRequest } from '../src/runtime/server/route-request'
import { serve } from './support/http'
import { configureSecurityRuntime, resetSecurityRuntime } from '../../security/src'

function trustProxies(trustedProxies: string[], peer: string): void {
  requestUrlInternals.provideConnectionAddress(() => peer)
  configureSecurityRuntime({ config: { trustedProxies } })
  onTestFinished(() => {
    resetSecurityRuntime()
    requestUrlInternals.provideConnectionAddress(undefined)
  })
}

function probeApp() {
  const app = createApp()
  app.use(defineEventHandler(async (event) => {
    const request = await createWebRequest(event)
    return {
      scheme: resolveRequestUrl(request).protocol,
      body: request.method === 'POST' ? await request.text() : undefined,
    }
  }))
  return app
}

function postRaw(base: string, headers: Record<string, string>, body: string): Promise<{ scheme: string, body: string }> {
  const { hostname, port } = new URL(base)
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path: '/probe', method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('Nuxt route request', () => {
  it('honors X-Forwarded-Proto from a trusted proxy through the shared resolver', async () => {
    const base = await serve(probeApp())

    trustProxies(['127.0.0.1'], '127.0.0.1')
    const response = await postRaw(base, { host: 'app.test', 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, '{}')
    expect(response.scheme).toBe('https:')
  })

  it('ignores X-Forwarded-Proto from a peer that is not a trusted proxy', async () => {
    const base = await serve(probeApp())

    trustProxies(['10.0.0.1'], '127.0.0.1')
    const response = await postRaw(base, { host: 'app.test', 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, '{}')
    expect(response.scheme).toBe('http:')
  })

  it('passes the raw body through to the route handler', async () => {
    const base = await serve(probeApp())

    const response = await postRaw(base, { host: 'app.test', 'content-type': 'application/json' }, '{"name":"query"}')
    expect(response.body).toBe('{"name":"query"}')
  })

  it('answers 413 for a request body above the default limit before buffering it', async () => {
    const base = await serve(probeApp())
    const { hostname, port } = new URL(base)
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        hostname,
        port,
        path: '/probe',
        method: 'POST',
        headers: { host: 'app.test', 'content-type': 'application/json', 'content-length': String(1024 * 1024 + 1) },
      }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      req.on('error', reject)
      req.end(Buffer.alloc(1024 * 1024 + 1, 'x'))
    })

    expect(status).toBe(413)
  })

  it('reuses a request body that the CSRF handler already buffered on the event', async () => {
    const app = createApp()
    app.use(defineEventHandler(async (event) => {
      event._requestBody = new TextEncoder().encode('{"name":"buffered"}')
      const request = await createWebRequest(event)
      return { body: await request.text() }
    }))
    const base = await serve(app)
    const response = await postRaw(base, { host: 'app.test', 'content-type': 'application/json' }, '{"name":"stream"}')

    expect(response.body).toBe('{"name":"buffered"}')
  })

  it('answers 413 when a body an earlier middleware buffered is over the limit', async () => {
    const app = createApp()
    app.use(defineEventHandler(async (event) => {
      event._requestBody = new Uint8Array(1024 * 1024 + 1)
      await createWebRequest(event)
      return { ok: true }
    }))
    const response = await fetch(await serve(app), { method: 'POST' })

    expect(response.status).toBe(413)
  })

  it('reads a body the serverless runtime already parsed onto the node request instead of the stream', async () => {
    const app = createApp()
    app.use(defineEventHandler(async (event) => {
      Object.assign(event.node.req, { body: { name: 'parsed' } })
      const request = await createWebRequest(event)
      return { body: await request.text() }
    }))
    const response = await postRaw(await serve(app), { host: 'app.test', 'content-type': 'application/json' }, '{"name":"stream"}')

    expect(response.body).toBe('{"name":"parsed"}')
  })

  it('answers 413 when a body parsed onto the node request is over the limit', async () => {
    const app = createApp()
    app.use(defineEventHandler(async (event) => {
      Object.assign(event.node.req, { body: { padding: 'x'.repeat(1024 * 1024 + 1) } })
      await createWebRequest(event)
      return { ok: true }
    }))
    const response = await fetch(await serve(app), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })

    expect(response.status).toBe(413)
  })

  it('re-encodes a pre-parsed multipart body under the boundary it sends, so it parses again', async () => {
    const app = createApp()
    app.use(defineEventHandler(async (event) => {
      const parsed = new FormData()
      parsed.set('title', 'Guide')
      parsed.set('image', new File(['pixels'], 'cover.png', { type: 'image/png' }))
      Object.assign(event.node.req, { body: parsed })
      const request = await createWebRequest(event)
      const form = await request.formData()
      return { title: form.get('title'), file: (form.get('image') as File).name }
    }))
    const response = await fetch(await serve(app), {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=client-boundary' },
      body: 'ignored',
    })

    expect(await response.json()).toEqual({ title: 'Guide', file: 'cover.png' })
  })
})
