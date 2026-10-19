import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { createNativeAuthPersistence } from '../../auth/tests/support/native-persistence'
import { createNativeSessionStore } from '../../auth/tests/support/native-session'
import { authRuntimeInternals, configureAuthRuntime, defineAuthConfig, resetAuthRuntime, type AuthProviderAdapter, type AuthUserLike } from '../../auth/src'
import { configureSocialAuthRuntime, resetSocialAuthRuntime, socialAuth, type SocialPendingStateRecord } from '../../auth-social/src'
import { configureSessionRuntime, getSessionRuntime, resetSessionRuntime } from '../../session/src/runtime'
import appleSocialProvider from '../src'

const certificateDirectory = mkdtempSync(join(tmpdir(), 'holo-apple-form-post-'))
const keyPath = join(certificateDirectory, 'key.pem')
const certPath = join(certificateDirectory, 'cert.pem')
const exchangedCodes: string[] = []

function createStateStore() {
  const records = new Map<string, SocialPendingStateRecord>()
  return {
    async create(record: SocialPendingStateRecord) {
      records.set(`${record.provider}:${record.state}`, record)
    },
    async read(provider: string, state: string) {
      return records.get(`${provider}:${state}`) ?? null
    },
    async delete(provider: string, state: string) {
      records.delete(`${provider}:${state}`)
    },
  }
}

function createIdentityStore() {
  return {
    async findByProviderUserId() {
      return null
    },
    async save() {},
  }
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function toWebRequest(request: IncomingMessage, body: Buffer): Request {
  const headers = new Headers()
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!)
  }

  return new Request(new URL(request.url ?? '/', `https://${request.headers.host}`), {
    method: request.method,
    headers,
    body: body.length > 0 ? new Uint8Array(body) : undefined,
  })
}

async function sendWebResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  webResponse.headers.forEach((value, name) => {
    if (name !== 'set-cookie') {
      headers[name] = value
    }
  })
  const cookies = webResponse.headers.getSetCookie()
  if (cookies.length > 0) {
    headers['set-cookie'] = cookies
  }

  response.writeHead(webResponse.status, headers)
  response.end(Buffer.from(await webResponse.arrayBuffer()))
}

function renderAppleFormPage(callbackUrl: string, parameters: URLSearchParams): string {
  const fields = [...parameters.entries()]
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${value}">`)
    .join('')
  return `<!doctype html><form method="post" action="${callbackUrl}">${fields}</form><script>document.forms[0].submit()</script>`
}

async function handleFixtureRequest(
  port: number,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', `https://${request.headers.host}`)
  const body = await readBody(request)

  if (request.method === 'GET' && url.pathname === '/auth/apple') {
    await sendWebResponse(response, await socialAuth.redirect('apple', toWebRequest(request, body)))
    return
  }

  if (request.method === 'GET' && url.pathname === '/apple-form') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(renderAppleFormPage(`https://localhost:${port}/auth/apple/callback`, url.searchParams))
    return
  }

  if (request.method === 'POST' && url.pathname === '/auth/apple/callback') {
    try {
      const result = await socialAuth.callback('apple', toWebRequest(request, body))
      response.writeHead(result.ok ? 200 : result.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(result.ok ? { ok: true } : { ok: false, message: result.message }))
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }))
    }
    return
  }

  response.writeHead(404)
  response.end()
}

async function startAppleFixture(): Promise<{ readonly port: number }> {
  exchangedCodes.length = 0
  const sessionStore = createNativeSessionStore()
  configureSessionRuntime({
    appKey: 'holo-test-app-key',
    config: {
      driver: 'file',
      stores: {
        file: {
          name: 'file',
          driver: 'file',
          path: sessionStore.path,
        },
      },
      cookie: {
        name: 'holo_session',
        path: '/',
        secure: false,
        httpOnly: true,
        sameSite: 'lax',
        partitioned: false,
        maxAge: 120,
      },
      idleTimeout: 120,
      absoluteLifetime: 120,
      rememberMeLifetime: 43200,
    },
    stores: {
      file: sessionStore,
    },
  })
  const persistence = await createNativeAuthPersistence()
  const server: Server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (request, response) => {
    void handleFixtureRequest(port, request, response)
  })
  await new Promise<void>(resolve => server.listen(0, () => resolve()))
  const port = (server.address() as { port: number }).port
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    resetSocialAuthRuntime()
    resetAuthRuntime()
    resetSessionRuntime()
  })

  configureAuthRuntime({
    config: defineAuthConfig({
      defaults: {
        guard: 'web',
        passwords: 'users',
      },
      guards: {
        web: { driver: 'session', provider: 'users' },
      },
      providers: {
        users: { model: 'User' },
      },
      social: {
        apple: {
          clientId: 'app.holo.example',
          clientSecret: 'apple-client-secret',
          redirectUri: `https://localhost:${port}/auth/apple/callback`,
          scopes: ['name', 'email'],
        },
      },
    }),
    session: getSessionRuntime(),
    providers: {
      users: persistence.providers.users as AuthProviderAdapter<AuthUserLike>,
    },
    tokens: persistence.tokens,
    context: authRuntimeInternals.createMemoryAuthContext(),
  })

  configureSocialAuthRuntime({
    providers: {
      apple: {
        ...appleSocialProvider,
        async exchangeCode(context) {
          exchangedCodes.push(context.code)
          throw new Error('Apple token exchange reached.')
        },
      },
    },
    stateStore: createStateStore(),
    identityStore: createIdentityStore(),
  })

  return { port }
}

let browser: Browser

beforeAll(async () => {
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-noenc',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' })
  browser = await chromium.launch({ headless: true })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await rm(certificateDirectory, { recursive: true, force: true })
})

async function newBrowserContext(): Promise<BrowserContext> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  onTestFinished(() => context.close())
  return context
}

async function startAuthorization(context: BrowserContext, port: number): Promise<string> {
  const page = await context.newPage()
  await page.route('https://appleid.apple.com/**', route => route.fulfill({ status: 200, contentType: 'text/plain', body: 'apple' }))
  await page.goto(`https://localhost:${port}/auth/apple`)
  const state = new URL(page.url()).searchParams.get('state')
  await page.close()
  if (!state) {
    throw new Error('Apple authorization did not carry a state parameter.')
  }

  return state
}

async function postAppleCallback(
  context: BrowserContext,
  port: number,
  parameters: Record<string, string>,
): Promise<{ readonly ok: boolean, readonly message?: string }> {
  const page = await context.newPage()
  await page.goto(`https://127.0.0.1:${port}/apple-form?${new URLSearchParams(parameters).toString()}`)
  await page.waitForURL(`https://localhost:${port}/auth/apple/callback`)
  const text = await page.innerText('body')
  await page.close()
  return JSON.parse(text) as { ok: boolean, message?: string }
}

describe('Sign in with Apple form-post callback in a browser', { timeout: 30_000 }, () => {
  it('accepts the cross-site form POST when the state cookie carries the matching state', async () => {
    const { port } = await startAppleFixture()
    const context = await newBrowserContext()

    const state = await startAuthorization(context, port)
    const result = await postAppleCallback(context, port, { state, code: 'apple-code' })

    expect(result).toEqual({ ok: false, message: 'Apple token exchange reached.' })
    expect(exchangedCodes).toEqual(['apple-code'])
  })

  it('rejects a cross-site form POST that arrives without the state cookie', async () => {
    const { port } = await startAppleFixture()
    const authorizing = await newBrowserContext()
    const posting = await newBrowserContext()

    const state = await startAuthorization(authorizing, port)
    const result = await postAppleCallback(posting, port, { state, code: 'apple-code' })

    expect(result).toEqual({ ok: false, message: 'Invalid or expired OAuth state.' })
    expect(exchangedCodes).toEqual([])
  })

  it('rejects a cross-site form POST whose state does not match the state cookie', async () => {
    const { port } = await startAppleFixture()
    const context = await newBrowserContext()

    const firstState = await startAuthorization(context, port)
    await startAuthorization(context, port)
    const result = await postAppleCallback(context, port, { state: firstState, code: 'apple-code' })

    expect(result).toEqual({ ok: false, message: 'Invalid or expired OAuth state.' })
    expect(exchangedCodes).toEqual([])
  })

  it('rejects a cross-site form POST that omits the state', async () => {
    const { port } = await startAppleFixture()
    const context = await newBrowserContext()

    await startAuthorization(context, port)
    const result = await postAppleCallback(context, port, { code: 'apple-code' })

    expect(result).toEqual({ ok: false, message: 'Missing OAuth state or code.' })
    expect(exchangedCodes).toEqual([])
  })
})
