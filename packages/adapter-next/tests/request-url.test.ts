import 'next/dist/server/node-environment'
import { adapter } from 'next/dist/server/web/adapter'
import { NextRequest } from 'next/server'
import { resolveRequestUrl } from '@holo-js/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureSecurityRuntime, defineSecurityConfig, resetSecurityRuntime } from '../../security/src'
import { csrfProtection } from '../../security/src/next/server'
import { createNextRequestContext } from '../src/runtime'

afterEach(() => {
  vi.unstubAllEnvs()
  resetSecurityRuntime()
})

describe('Next request URL resolution', () => {
  it.each([false, true])('resolves native requests and contexts with proxy trust %s without consuming bodies', async (trustProxy) => {
    vi.stubEnv('HOLO_SECURITY_TRUST_PROXY', String(trustProxy))
    const request = new NextRequest('http://localhost:43201/login?next=%2Fadmin', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:43201',
        'x-forwarded-host': 'public.example:8443',
        'x-forwarded-proto': 'https',
      },
      body: 'email=ava',
    })
    const origin = trustProxy ? 'https://public.example:8443' : 'http://127.0.0.1:43201'
    for (const input of [request, createNextRequestContext(request), { request }]) {
      expect(resolveRequestUrl(input).href).toBe(`${origin}/login?next=%2Fadmin`)
    }
    expect(request.bodyUsed).toBe(false)
    expect(await request.text()).toBe('email=ava')
  })

  it('issues CSRF cookies and resolves the route URL through native Next middleware', async () => {
    vi.stubEnv('HOLO_SECURITY_TRUST_PROXY', 'false')
    configureSecurityRuntime({
      config: defineSecurityConfig({ csrf: { enabled: true } }),
      csrfSigningKey: 'native-request-url-test-key',
    })
    const middleware = csrfProtection()
    const result = await adapter({
      page: '/proxy',
      request: {
        url: 'http://localhost:43201/auth/presentation?theme=light',
        method: 'GET',
        headers: { host: '127.0.0.1:43201' },
        signal: new AbortController().signal,
      },
      handler: async (request: NextRequest) => {
        const response = await middleware(request)
        expect(response?.headers.get('x-middleware-next')).toBe('1')
        expect(response?.headers.getSetCookie()).toHaveLength(2)
        expect(response?.headers.getSetCookie().every(cookie => !cookie.includes('Secure'))).toBe(true)
        return new Response(resolveRequestUrl(request).href)
      },
    })
    expect(result.response.status).toBe(200)
    expect(await result.response.text()).toBe('http://127.0.0.1:43201/auth/presentation?theme=light')
  })
})
