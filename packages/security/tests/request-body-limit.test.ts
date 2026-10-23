import { createServer } from 'node:http'
import { once } from 'node:events'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_MAX_REQUEST_BODY_BYTES, HoloRequestBodyTooLargeError } from '@holo-js/kernel'
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
})
