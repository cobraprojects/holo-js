import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function startExampleAppHostedAuthService() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const key = { ...publicKey.export({ format: 'jwk' }), kid: 'hosted-test-key', alg: 'RS256', use: 'sig' }
  const requests = []
  const profiles = new Map()
  const failures = new Map()
  const server = createServer((request, response) => {
    requests.push({ path: request.url, method: request.method, authorization: request.headers.authorization })
    response.setHeader('content-type', 'application/json')
    if (failures.has(request.url)) {
      response.writeHead(failures.get(request.url))
      response.end(JSON.stringify({ error: 'provider_failure' }))
      return
    }
    if (request.url === '/.well-known/jwks.json' || request.url === '/v1/jwks' || request.url === '/sso/jwks/holo-test-client') {
      response.end(JSON.stringify({ keys: [key] }))
      return
    }
    if (request.headers.authorization !== 'Bearer holo-test-secret') {
      response.writeHead(401)
      response.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    if (request.method === 'POST' && /^\/v1\/sessions\/[^/]+\/revoke$/.test(request.url)) {
      response.end(JSON.stringify({ status: 'revoked' }))
      return
    }
    const userId = request.url?.match(/^\/(?:v1|user_management)\/users\/([^/]+)$/)?.[1]
    const profile = userId && profiles.get(decodeURIComponent(userId))
    response.writeHead(profile ? 200 : 404)
    response.end(JSON.stringify(profile ?? { error: 'not_found' }))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}`
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const target = new URL(request.url)
    if (target.hostname !== 'api.workos.com') return originalFetch(input, init)
    return originalFetch(`${url}${target.pathname}${target.search}`, {
      method: request.method,
      headers: request.headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: 'error',
      signal: request.signal,
    })
  }
  return {
    processEnv: {
      APP_URL: 'http://localhost',
      WORKOS_CLIENT_ID: 'holo-test-client',
      WORKOS_API_KEY: 'holo-test-secret',
      WORKOS_REDIRECT_URI: 'http://localhost/auth/workos/callback',
      CLERK_PUBLISHABLE_KEY: 'pk_test',
      CLERK_SECRET_KEY: 'holo-test-secret',
      CLERK_API_URL: url,
      CLERK_FRONTEND_API: url,
      CLERK_REDIRECT_URI: 'http://localhost/auth/clerk/callback',
    },
    profiles,
    failures,
    requests,
    token(claims) {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: key.kid, typ: 'JWT' })).toString('base64url')
      const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60, aud: 'holo-test-client', azp: 'http://localhost', ...claims })).toString('base64url')
      const input = `${header}.${payload}`
      return `${input}.${sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`
    },
    async close() {
      globalThis.fetch = originalFetch
      server.closeAllConnections()
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

export async function assertExampleAppHostedAuthBehavior(projectRoot, DB, service) {
  const require = createRequire(join(projectRoot, 'package.json'))
  const load = async name => import(pathToFileURL(require.resolve(name)).href)
  const { authRuntimeInternals } = await load('@holo-js/auth')
  const { getSessionRuntime } = await load('@holo-js/session')
  const context = authRuntimeInternals.getRuntimeBindings().context
  assert.equal(typeof context.run, 'function', 'native app must install an isolated auth request context')
  for (const provider of ['workos', 'clerk']) {
    const hosted = await load(`@holo-js/auth-${provider}`)
    const id = `${provider}_${randomUUID()}`
    const email = `${id}@app.test`
    service.profiles.set(id, { id, email, email_verified: true, first_name: 'Hosted', last_name: 'User', name: 'Hosted User' })
    const token = service.token({ sub: id, sid: `session_${id}` })
    const request = new Request('http://localhost/me', { headers: { authorization: `Bearer ${token}` } })
    let sessionId
    const sessionIds = []
    try {
      const results = await Promise.all(Array.from({ length: 4 }, () => context.run(async () => {
        const result = await hosted.authenticate(new Request(request))
        assert.equal(result.user.email, email)
        assert.ok(result.user.id)
        sessionIds.push(result.authSession.sessionId)
        assert.ok(await getSessionRuntime().read(result.authSession.sessionId), `${provider}: login must persist a real session`)
        return result
      })))
      assert.equal(results.filter(result => result.status === 'created').length, 1, `${provider}: concurrent first login must create one local user`)
      assert.equal(new Set(results.map(result => result.user.id)).size, 1, `${provider}: concurrent logins must share one linked identity`)
      assert.equal(new Set(sessionIds).size, 4, `${provider}: separate requests must receive isolated sessions`)
      sessionId = sessionIds[0]
      assert.ok(sessionId)
      await context.run(async () => {
        const result = await hosted.authenticate(new Request(request, { headers: { authorization: `Bearer ${token}`, cookie: `holo_session=${sessionId}` } }))
        assert.equal(result.status, 'linked', `${provider}: repeated login must reuse the existing identity`)
        assert.equal(result.authSession.sessionId, sessionId)
      })
      assert.equal(await DB.table('users').where('email', email).count(), 1)
      assert.equal(await DB.table('auth_identities').where('provider_user_id', id).count(), 1)
      for (const claims of [{ exp: Math.floor(Date.now() / 1000) - 1 }, { sub: '' }, { sid: '' }]) {
        await assert.rejects(hosted.verifySession(service.token({ sub: id, sid: `session_${id}`, ...claims })))
      }
      const tampered = `${token.split('.').slice(0, 2).join('.')}.${Buffer.alloc(256).toString('base64url')}`
      await assert.rejects(hosted.verifySession(tampered), /signature/i)
      const profilePath = provider === 'clerk' ? `/v1/users/${id}` : `/user_management/users/${id}`
      service.failures.set(profilePath, 503)
      await assert.rejects(hosted.verifySession(token), /Failed to load/)
      service.failures.delete(profilePath)
      assert.equal(await DB.table('users').where('email', email).count(), 1)
      assert.ok(await getSessionRuntime().read(sessionId))
      const unverifiedId = `${id}_unverified`
      service.profiles.set(unverifiedId, { id: unverifiedId, email: `${unverifiedId}@app.test`, email_verified: false, name: 'Pending User' })
      await context.run(async () => {
        await assert.rejects(hosted.authenticate(new Request('http://localhost/me', { headers: { authorization: `Bearer ${service.token({ sub: unverifiedId, sid: 'unverified' })}` } })), /verified email/i)
      })
      assert.equal(await DB.table('users').where('email', `${unverifiedId}@app.test`).count(), 0)
      if (provider === 'workos') {
        await assert.rejects(hosted.verifySession(service.token({ sub: id, sid: `session_${id}`, aud: 'another-client' })), /audience/i)
      } else {
        await context.run(async () => {
          const response = await hosted.logoutWithClerk(new Request('http://localhost/logout', { method: 'POST', headers: { cookie: `holo_session=${sessionId}` } }))
          assert.equal(response.status, 303)
        })
        assert.ok(service.requests.some(request => request.path === `/v1/sessions/session_${id}/revoke` && request.method === 'POST' && request.authorization === 'Bearer holo-test-secret'))
        assert.equal(await getSessionRuntime().read(sessionId), null)
      }
    } finally {
      for (const id of sessionIds) await getSessionRuntime().invalidate(id)
      await DB.table('auth_identities').where('provider_user_id', id).delete()
      await DB.table('users').where('email', email).delete()
    }
  }
}
