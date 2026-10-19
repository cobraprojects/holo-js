import 'next/dist/server/node-environment'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adapter } from 'next/dist/server/web/adapter'
import { NextRequest } from 'next/server'
import { resolveRequestUrl } from '@holo-js/kernel'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import * as sessionModule from '../../session/src'
import { createCsrfSessionAccessor } from '../../core/src/portable/csrfSession'
import { configureSecurityRuntime, defineSecurityConfig, resetSecurityRuntime } from '../../security/src'
import { csrfProtection } from '../../security/src/next/server'
import { createNextRequestContext } from '../src/runtime'

afterEach(() => {
  resetSecurityRuntime()
  sessionModule.configureSessionRuntime(undefined)
})

describe('Next request URL resolution', () => {
  it.each([false, true])('resolves native requests and contexts with a trusted proxy %s without consuming bodies', async (trustProxy) => {
    if (trustProxy) configureSecurityRuntime({ config: defineSecurityConfig({ trustedProxies: '*' }) })
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
    const root = await mkdtemp(join(tmpdir(), 'holo-next-csrf-'))
    onTestFinished(() => rm(root, { force: true, recursive: true }))
    sessionModule.configureSessionRuntime({
      config: sessionModule.normalizeSessionConfig({ driver: 'file', stores: { file: { driver: 'file', path: root } } }),
      stores: { file: sessionModule.createFileSessionStore(root) },
      appKey: 'native-request-url-test-key',
    })
    configureSecurityRuntime({
      config: defineSecurityConfig({ csrf: { enabled: true } }),
      csrfSigningKey: 'native-request-url-test-key',
      csrfSession: createCsrfSessionAccessor(sessionModule, () => 'holo_session'),
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
        expect(response?.headers.getSetCookie()).toHaveLength(3)
        expect(response?.headers.getSetCookie().every(cookie => !cookie.includes('Secure'))).toBe(true)
        return new Response(resolveRequestUrl(request).href)
      },
    })
    expect(result.response.status).toBe(200)
    expect(await result.response.text()).toBe('http://127.0.0.1:43201/auth/presentation?theme=light')
  })
})
