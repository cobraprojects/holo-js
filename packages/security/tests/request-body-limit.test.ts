import { createServer } from 'node:http'
import { once } from 'node:events'
import { createApp, defineEventHandler, readRawBody, toNodeListener } from 'h3'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_MAX_REQUEST_BODY_BYTES, HoloRequestBodyTooLargeError, readBoundedRequestBody } from '@holo-js/kernel'
import { configureSecurityRuntime, csrf, defineSecurityConfig, normalizeSecurityConfig, resetSecurityRuntime } from '../src'
import { csrfProtection as nuxtCsrfProtection } from '../src/nuxt/server'
import { memoryCsrfSessions, TEST_SESSION_COOKIE } from './support/csrf-session'

function configure(maxBodyBytes?: number | string): void {
  configureSecurityRuntime({
    config: defineSecurityConfig({ csrf: { enabled: true }, maxBodyBytes }),
    csrfSigningKey: 'request-body-limit-test-key',
    csrfSession: memoryCsrfSessions({ 'browser-a': 'session-token' }),
  })
}

afterEach(() => {
  resetSecurityRuntime()
})

describe('security request body limit', () => {
  it('defaults to one mebibyte and accepts a configured integer or numeric string', () => {
    expect(normalizeSecurityConfig({}).maxBodyBytes).toBe(DEFAULT_MAX_REQUEST_BODY_BYTES)
    expect(normalizeSecurityConfig({ maxBodyBytes: '2048' }).maxBodyBytes).toBe(2048)
  })

  it('defaults the multipart upload limit to eight mebibytes and rejects a non-positive value', () => {
    expect(normalizeSecurityConfig({}).maxUploadBodyBytes).toBe(8 * 1024 * 1024)
    expect(normalizeSecurityConfig({ maxUploadBodyBytes: '16777216' }).maxUploadBodyBytes).toBe(16777216)
    expect(() => normalizeSecurityConfig({ maxUploadBodyBytes: 0 })).toThrow('maxUploadBodyBytes must be greater than or equal to 1.')
  })

  it('rejects a non-positive limit', () => {
    expect(() => normalizeSecurityConfig({ maxBodyBytes: 0 })).toThrow('maxBodyBytes must be greater than or equal to 1.')
  })

  it('rejects an oversized form body with 413 before the CSRF token is compared', async () => {
    configure(16)
    const body = new URLSearchParams({ _token: 'session-token', note: 'x'.repeat(64) }).toString()
    const request = new Request('http://localhost/submit', {
      method: 'POST',
      body,
      headers: {
        cookie: `browser=browser-a`,
        'content-type': 'application/x-www-form-urlencoded',
      },
    })

    const error = await csrf.verify(request).catch(caught => caught)

    expect(error).toBeInstanceOf(HoloRequestBodyTooLargeError)
    expect(error).toMatchObject({ status: 413 })
  })

  it('answers 413 to a Nuxt node request whose body exceeds the limit and skips the handler', async () => {
    configure(16)
    let handled = false
    const app = createApp()
    app.use(nuxtCsrfProtection())
    app.use(defineEventHandler(() => {
      handled = true
      return { ok: true }
    }))
    const server = createServer(toNodeListener(app))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing test server address')
      const response = await fetch(`http://127.0.0.1:${address.port}/submit`, {
        method: 'POST',
        headers: {
          cookie: `browser=browser-a; ${TEST_SESSION_COOKIE}=browser-a`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ padding: 'x'.repeat(64) }),
      })

      expect(response.status).toBe(413)
      expect(handled).toBe(false)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('shares the buffered Nuxt body through the H3 raw-body symbol that form validation reads', async () => {
    configure(1024)
    let shared: unknown
    const app = createApp()
    app.use(nuxtCsrfProtection())
    app.use(defineEventHandler((event) => {
      shared = (event.node.req as unknown as Record<symbol, unknown>)[Symbol.for('h3RawBody')]
      return { ok: true }
    }))
    const server = createServer(toNodeListener(app))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing test server address')
      const source = new Request('http://localhost/page', { headers: { cookie: 'browser=browser-a' } })
      const token = await csrf.token(source)
      const xsrfCookie = (await csrf.cookie(source, token)).split(';', 1)[0]
      const response = await fetch(`http://127.0.0.1:${address.port}/submit`, {
        method: 'POST',
        headers: {
          cookie: `browser=browser-a; ${xsrfCookie}`,
          'content-type': 'application/json',
          'x-csrf-token': token,
        },
        body: JSON.stringify({ email: 'ava@example.com' }),
      })

      expect(response.status).toBe(200)
      expect(Buffer.from(shared as Uint8Array).toString('utf8')).toBe(JSON.stringify({ email: 'ava@example.com' }))
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('restores the default body limit when the security runtime is reset', async () => {
    configure(16)
    resetSecurityRuntime()

    await expect(readBoundedRequestBody(new Request('https://app.test/submit', {
      method: 'POST',
      body: 'x'.repeat(64),
    }))).resolves.toHaveProperty('byteLength', 64)
  })

  it('keeps a body that an earlier Nuxt middleware already read available to CSRF and later handlers', async () => {
    configure(1024)
    let seen: string | undefined
    const app = createApp()
    app.use(defineEventHandler(async (event) => {
      await readRawBody(event)
    }))
    app.use(nuxtCsrfProtection())
    app.use(defineEventHandler(async (event) => {
      seen = await readRawBody(event, 'utf8')
      return { ok: true }
    }))
    const server = createServer(toNodeListener(app))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing test server address')
      const source = new Request('http://localhost/page', { headers: { cookie: 'browser=browser-a' } })
      const token = await csrf.token(source)
      const xsrfCookie = (await csrf.cookie(source, token)).split(';', 1)[0]
      const body = JSON.stringify({ email: 'ava@example.com' })
      const response = await fetch(`http://127.0.0.1:${address.port}/submit`, {
        method: 'POST',
        headers: {
          cookie: `browser=browser-a; ${xsrfCookie}`,
          'content-type': 'application/json',
          'x-csrf-token': token,
        },
        body,
      })

      expect(response.status).toBe(200)
      expect(seen).toBe(body)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('still enforces the body limit when an earlier Nuxt middleware already read an oversized body', async () => {
    configure(16)
    let handled = false
    const app = createApp()
    app.use(defineEventHandler(async (event) => {
      await readRawBody(event)
    }))
    app.use(nuxtCsrfProtection())
    app.use(defineEventHandler(() => {
      handled = true
      return { ok: true }
    }))
    const server = createServer(toNodeListener(app))
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Missing test server address')
      const source = new Request('http://localhost/page', { headers: { cookie: 'browser=browser-a' } })
      const token = await csrf.token(source)
      const xsrfCookie = (await csrf.cookie(source, token)).split(';', 1)[0]
      const chunk = new TextEncoder().encode(JSON.stringify({ padding: 'x'.repeat(64) }))
      const response = await fetch(`http://127.0.0.1:${address.port}/submit`, {
        method: 'POST',
        headers: {
          cookie: `browser=browser-a; ${xsrfCookie}`,
          'content-type': 'application/json',
          'x-csrf-token': token,
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk)
            controller.close()
          },
        }),
        duplex: 'half',
      } as RequestInit)

      expect(response.status).toBe(413)
      expect(handled).toBe(false)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
