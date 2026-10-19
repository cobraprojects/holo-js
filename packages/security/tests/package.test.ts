import { access, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeRedisConfig, requestUrlInternals } from '@holo-js/kernel'
import { composeRegisteredConfig } from '@holo-js/config/registry'
import * as securityExports from '../src'
import security, {
  clearRateLimit,
  configureSecurityRuntime,
  cors,
  createCorsHeaders,
  createCorsPreflightResponse,
  createFileRateLimitStore,
  createFileRateLimitStoreConfig,
  createMemoryRateLimitStore,
  createMemoryRateLimitStoreConfig,
  createRateLimitStoreFromConfig,
  createSignedToken,
  createRedisRateLimitStore,
  createRedisRateLimitStoreConfig,
  csrf,
  corsInternals,
  defaultRateLimitKey,
  defineCorsConfig,
  defineRateLimiter,
  defineSecurityConfig,
  defineSecurityRuntimeBindings,
  fileRateLimitDriverInternals,
  getSecurityRuntimeBindings,
  getSecurityRuntime,
  ip,
  isSecureRequest,
  limit,
  memoryRateLimitDriverInternals,
  normalizeCorsConfig,
  normalizeSecurityConfig,
  protect,
  rateLimit,
  redisRateLimitDriverInternals,
  resetSecurityRuntime,
  SecurityCsrfError,
  SecurityRateLimitError,
  SecurityRuntimeNotConfiguredError,
  securityStoreInternals,
  type SecurityRateLimitRedisDriverAdapter,
  type SecurityRateLimitStore,
  type SecuritySignedTokenValue,
  verifySignedToken,
} from '../src'
import { memoryCsrfSessions } from './support/csrf-session'
import { runRateLimitDriverContractSuite } from './support/driver-contract'

const tempDirs: string[] = []

function createMockRateLimitStore(now = new Date('2026-04-16T12:00:00.000Z')): SecurityRateLimitStore {
  const entries = new Map<string, { attempts: number, expiresAt: Date }>()

  return {
    async hit(key, options) {
      const existing = entries.get(key)
      if (existing && existing.expiresAt.getTime() <= now.getTime()) {
        entries.delete(key)
      }

      const entry = entries.get(key)
      if (!entry) {
        const created = {
          attempts: 1,
          expiresAt: new Date(now.getTime() + options.decaySeconds * 1000),
        }
        entries.set(key, created)

        return {
          limited: false,
          snapshot: {
            limiter: 'store',
            key,
            attempts: created.attempts,
            maxAttempts: options.maxAttempts,
            remainingAttempts: Math.max(0, options.maxAttempts - created.attempts),
            expiresAt: created.expiresAt,
          },
          retryAfterSeconds: options.decaySeconds,
        }
      }

      entry.attempts += 1
      return {
        limited: entry.attempts > options.maxAttempts,
        snapshot: {
          limiter: 'store',
          key,
          attempts: entry.attempts,
          maxAttempts: options.maxAttempts,
          remainingAttempts: Math.max(0, options.maxAttempts - entry.attempts),
          expiresAt: entry.expiresAt,
        },
        retryAfterSeconds: Math.max(0, Math.ceil((entry.expiresAt.getTime() - now.getTime()) / 1000)),
      }
    },
    async clear(key) {
      return entries.delete(key)
    },
    async clearByPrefix(prefix) {
      let cleared = 0

      for (const key of entries.keys()) {
        if (!key.startsWith(prefix)) {
          continue
        }

        entries.delete(key)
        cleared += 1
      }

      return cleared
    },
    async clearAll() {
      const size = entries.size
      entries.clear()
      return size
    },
  }
}

const connectionAddress = '198.51.100.20'

beforeEach(() => {
  requestUrlInternals.provideConnectionAddress(() => connectionAddress)
})

afterEach(() => {
  vi.unstubAllEnvs()
  resetSecurityRuntime()
  requestUrlInternals.provideConnectionAddress(undefined)
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('@holo-js/security package surface', () => {
  it('composes security configuration with optional Redis values', () => {
    const redis = normalizeRedisConfig()

    expect(composeRegisteredConfig({ security: {} }, { redis }).security).toEqual(normalizeSecurityConfig({}, undefined))
    expect(composeRegisteredConfig({ security: {}, redis: {} }, { redis }).security).toEqual(normalizeSecurityConfig({}, redis))
  })
  it('keeps redis as an optional peer for non-redis installs', async () => {
    const packageJson = JSON.parse(await readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    )) as {
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }

    expect(packageJson.peerDependencies?.ioredis).toBe('catalog:')
    expect(packageJson.peerDependenciesMeta?.ioredis?.optional).toBe(true)
  })

  it('ships built artifacts for every published export target', async () => {
    const packageJson = JSON.parse(await readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    )) as {
      exports?: Record<string, string | {
        types?: string
        import?: string
        default?: string
      }>
    }

    const exportTargets = Object.values(packageJson.exports ?? {})
      .flatMap((entry) => {
        if (typeof entry === 'string') {
          return [entry]
        }

        return [
          entry.types,
          entry.import,
          entry.default,
        ].filter((value): value is string => typeof value === 'string')
      })

    await Promise.all(exportTargets.map(async (target) => {
      await expect(access(new URL(`..${target.slice(1)}`, import.meta.url))).resolves.toBeUndefined()
    }))
  })

  it('exports the package helpers and runtime seam', async () => {
    const limiter = limit.perMinute(5).by(({ request, values }) => {
      return `${ip(request)}:${String(values?.email ?? 'guest')}`
    })
    const config = defineSecurityConfig({
      csrf: {
        enabled: true,
      },
      rateLimit: {
        driver: 'file',
        limiters: {
          login: limiter,
        },
      },
    })

    expect(config.csrf?.enabled).toBe(true)
    expect(Object.isFrozen(config)).toBe(true)
    expect(createMemoryRateLimitStoreConfig()).toEqual({})
    expect(createFileRateLimitStoreConfig({ path: './tmp/rate-limits' })).toEqual({
      path: './tmp/rate-limits',
    })
    expect(createRedisRateLimitStoreConfig({ connection: 'cache', prefix: 'holo:' })).toEqual({
      connection: 'cache',
      prefix: 'holo:',
    })
    expect(defineRateLimiter(limiter)).toEqual(limiter)
    expect(() => defineRateLimiter({
      maxAttempts: 0,
      decaySeconds: 60,
    } as never)).toThrow('Rate limiter maxAttempts must be an integer greater than or equal to 1.')
    expect(() => defineRateLimiter({
      maxAttempts: 1,
      decaySeconds: '60',
      key: 'ip' as never,
    } as never)).toThrow('Rate limiter key resolvers must be functions.')
    expect(typeof security.configureSecurityRuntime).toBe('function')
    expect(typeof security.getSecurityRuntime).toBe('function')
    expect(typeof security.csrf.token).toBe('function')
    expect(typeof security.cors.apply).toBe('function')
    expect(typeof security.protect).toBe('function')
    expect(typeof security.rateLimit).toBe('function')
    expect(typeof security.clearRateLimit).toBe('function')
    expect(typeof createMemoryRateLimitStore).toBe('function')
    expect(typeof createFileRateLimitStore).toBe('function')
    expect(typeof createRedisRateLimitStore).toBe('function')
    expect(() => getSecurityRuntime()).toThrow(SecurityRuntimeNotConfiguredError)

    const store = createMockRateLimitStore()
    configureSecurityRuntime({
      config,
      cors: {
        paths: ['/api/*'],
        origins: ['https://app.test'],
        credentials: true,
        statefulDomains: ['app.test'],
      },
      rateLimitStore: store,
      csrfSigningKey: 'test-signing-key',
      csrfSession: memoryCsrfSessions(),
    })

    const request = new Request('https://app.test/form')
    const token = await csrf.token(request)
    expect(getSecurityRuntime().config.rateLimit.driver).toBe('file')
    expect(getSecurityRuntime().cors.origins).toEqual(['https://app.test'])
    expect(getSecurityRuntime().config.rateLimit.limiters.login?.maxAttempts).toBe(5)
    expect(getSecurityRuntime().rateLimitStore).toBe(store)
    expect(token.length).toBeGreaterThan(10)
    expect(new SecurityCsrfError().status).toBe(419)
    const rateLimitError = new SecurityRateLimitError(undefined, {
      retryAfterSeconds: 42,
      snapshot: {
        limiter: 'login',
        key: '203.0.113.7:ava@example.com',
        attempts: 6,
        maxAttempts: 5,
        remainingAttempts: 0,
        expiresAt: new Date('2026-04-16T12:01:00.000Z'),
      },
    })
    expect(rateLimitError.retryAfterSeconds).toBe(42)
    expect(rateLimitError.snapshot?.limiter).toBe('login')
    expect('normalizeSecurityConfig' in securityExports).toBe(true)
    expect('createSecurityRedisAdapter' in securityExports).toBe(false)
  })

  it('creates purpose-bound expiring signed tokens with tamper detection', () => {
    configureSecurityRuntime({
      config: {},
      csrfSigningKey: 'signed-token-test-key',
    })
    const expiresAt = new Date('2030-04-16T12:05:00.000Z')
    const token = createSignedToken({
      exportId: 'export-1',
      nested: { allowed: true },
    }, {
      expiresAt,
      purpose: 'panels-export-download',
    })

    expect(verifySignedToken<{ readonly exportId: string }>(token, {
      now: new Date('2030-04-16T12:04:59.000Z'),
      purpose: 'panels-export-download',
    })).toMatchObject({ exportId: 'export-1' })
    expect(verifySignedToken(token, {
      now: new Date('2030-04-16T12:04:59.000Z'),
      purpose: 'another-purpose',
    })).toBeNull()
    const separator = token.lastIndexOf('.')
    const tamperedSignature = Buffer.from(token.slice(separator + 1), 'base64url')
    tamperedSignature[tamperedSignature.length - 1] = tamperedSignature[tamperedSignature.length - 1]! ^ 1
    expect(verifySignedToken(`${token.slice(0, separator + 1)}${tamperedSignature.toString('base64url')}`, {
      now: new Date('2030-04-16T12:04:59.000Z'),
      purpose: 'panels-export-download',
    })).toBeNull()
    expect(verifySignedToken(`${token}!`, {
      now: new Date('2030-04-16T12:04:59.000Z'),
      purpose: 'panels-export-download',
    })).toBeNull()
    expect(verifySignedToken(`${token}=`, {
      now: new Date('2030-04-16T12:04:59.000Z'),
      purpose: 'panels-export-download',
    })).toBeNull()
    const base64UrlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const signatureLastCharacterIndex = base64UrlAlphabet.indexOf(token.at(-1)!)
    const nonCanonicalToken = `${token.slice(0, -1)}${base64UrlAlphabet[signatureLastCharacterIndex ^ 1]}`
    expect(nonCanonicalToken).not.toBe(token)
    expect(Buffer.from(nonCanonicalToken.slice(separator + 1), 'base64url'))
      .toEqual(Buffer.from(token.slice(separator + 1), 'base64url'))
    expect(verifySignedToken(nonCanonicalToken, {
      now: new Date('2030-04-16T12:04:59.000Z'),
      purpose: 'panels-export-download',
    })).toBeNull()
    expect(verifySignedToken(token, {
      now: expiresAt,
      purpose: 'panels-export-download',
    })).toBeNull()
  })

  it('rejects unsafe signed token inputs and missing signing configuration', () => {
    configureSecurityRuntime({ config: {} })
    expect(() => createSignedToken({ value: 'safe' }, {
      expiresAt: new Date(Date.now() + 1000),
      purpose: 'download',
    })).toThrow('application signing key')

    configureSecurityRuntime({ config: {}, csrfSigningKey: 'signed-token-test-key' })
    expect(() => createSignedToken({ value: Number.NaN }, {
      expiresAt: new Date(Date.now() + 1000),
      purpose: 'download',
    })).toThrow('JSON-safe values')
    expect(() => createSignedToken({ value: 'safe' }, {
      expiresAt: new Date(Date.now() - 1000),
      purpose: 'download',
    })).toThrow('valid future date')

    const circular: Record<string, SecuritySignedTokenValue> = {}
    circular.self = circular
    expect(() => createSignedToken(circular, {
      expiresAt: new Date(Date.now() + 1000),
      purpose: 'download',
    })).toThrow('JSON-safe values')

    let nested: SecuritySignedTokenValue = 'value'
    for (let depth = 0; depth < 33; depth += 1) nested = { nested }
    expect(() => createSignedToken({ nested }, {
      expiresAt: new Date(Date.now() + 1000),
      purpose: 'download',
    })).toThrow('JSON-safe values')

    expect(() => createSignedToken({ value: 'x'.repeat(65_536) }, {
      expiresAt: new Date(Date.now() + 1000),
      purpose: 'download',
    })).toThrow('exceeds 64 KiB')
    expect(verifySignedToken(`${'x'.repeat(100_000)}.signature`, {
      purpose: 'download',
    })).toBeNull()
  })

  it('normalizes and validates feature-owned security configuration', () => {
    expect(normalizeCorsConfig().maxAge).toBe(7200)
    expect(Object.isFrozen(defineCorsConfig({ methods: ['get'] }))).toBe(true)
    expect(normalizeCorsConfig({ origins: [' https://app.test '], methods: ['post'], maxAge: '0' })).toMatchObject({
      origins: ['https://app.test'],
      methods: ['POST'],
      maxAge: 0,
    })
    expect(() => normalizeCorsConfig({ paths: [' '] })).toThrow('paths entry at index 0 must be a non-empty string')
    expect(() => normalizeCorsConfig({ maxAge: 'invalid' })).toThrow('cors maxAge must be an integer')
    expect(() => normalizeCorsConfig({ maxAge: ' ' })).toThrow('cors maxAge must be an integer')
    expect(() => normalizeCorsConfig({ maxAge: -1 })).toThrow('cors maxAge must be greater than or equal to 0')

    const key = () => 'key'
    expect(normalizeSecurityConfig({
      csrf: true,
      rateLimit: {
        driver: 'file',
        file: { path: ' ./limits ' },
        limiters: { login: { maxAttempts: '5', decaySeconds: 60, key } },
      },
    })).toMatchObject({
      csrf: { enabled: true },
      rateLimit: { driver: 'file', file: { path: './limits' }, limiters: { login: { maxAttempts: 5, key } } },
    })
    expect(() => normalizeSecurityConfig({ csrf: { except: [' '] } })).toThrow('csrf except entry at index 0 must be a non-empty string')
    expect(() => normalizeSecurityConfig({ rateLimit: { driver: 'invalid' as never } })).toThrow('Unsupported rate limit driver "invalid"')
    expect(() => normalizeSecurityConfig({ rateLimit: { driver: 'redis' } })).toThrow('without top-level Redis config')
    expect(normalizeSecurityConfig({ rateLimit: { driver: 'redis' } }, normalizeRedisConfig()).rateLimit.redis).toMatchObject({
      connection: 'default',
      host: '127.0.0.1',
    })
    expect(normalizeSecurityConfig({ rateLimit: { driver: 'redis' } }, normalizeRedisConfig({
      connections: { default: { url: 'redis://localhost:6379' } },
    })).rateLimit.redis.url).toBe('redis://localhost:6379')
    expect(normalizeSecurityConfig({ rateLimit: { driver: 'redis' } }, normalizeRedisConfig({
      connections: { default: { clusters: [{ host: 'localhost' }] } },
    })).rateLimit.redis.clusters).toHaveLength(1)
    expect(() => normalizeSecurityConfig({ rateLimit: { limiters: { ' ': { maxAttempts: 1, decaySeconds: 1 } } } })).toThrow('Rate limiter name must be a non-empty string')
    expect(() => normalizeSecurityConfig({ rateLimit: { limiters: { login: { maxAttempts: 0, decaySeconds: 1 } } } })).toThrow('maxAttempts must be greater than or equal to 1')
    expect(() => normalizeSecurityConfig({ rateLimit: { limiters: { login: {} as never } } })).toThrow('maxAttempts must be greater than or equal to 1')
    expect(() => normalizeSecurityConfig({ rateLimit: { limiters: { login: { maxAttempts: 1, decaySeconds: 1, key: 'invalid' as never } } } })).toThrow('key resolver must be a function')
  })

  it('keeps the redis adapter on its dedicated subpath export', async () => {
    const redisAdapterModule = await import('../src/drivers/redis-adapter')

    expect('createSecurityRedisAdapter' in securityExports).toBe(false)
    expect(typeof redisAdapterModule.createSecurityRedisAdapter).toBe('function')
  })

  it('validates limiter builders', () => {
    expect(limit.perHour(10).define()).toEqual({
      maxAttempts: 10,
      decaySeconds: 3600,
    })
    expect(() => limit.perMinute(0)).toThrow('greater than or equal to 1')
  })

  it('normalizes numeric string limiter definitions before freezing them', () => {
    expect(defineRateLimiter({
      maxAttempts: '2',
      decaySeconds: '60',
    } as never)).toEqual({
      maxAttempts: 2,
      decaySeconds: 60,
    })
  })
})

describe('@holo-js/security cors', () => {
  it('matches cors path wildcards without regular expressions', () => {
    expect(corsInternals.matchesPathPattern('/api/posts', '/api/*')).toBe(true)
    expect(corsInternals.matchesPathPattern('/assets/app.css', '/assets/*.css')).toBe(true)
    expect(corsInternals.matchesPathPattern('/assets/app.js', '/assets/*.css')).toBe(false)
    expect(corsInternals.matchesPathPattern('/web/posts', '/api/*')).toBe(false)
    expect(corsInternals.matchesPathPattern('/broadcasting/auth', '/broadcasting/auth')).toBe(true)
    expect(corsInternals.matchesPathPattern('/broadcasting/other', '/broadcasting/auth')).toBe(false)
  })

  it('builds credentialed cors headers for configured origins and stateful domains', () => {
    configureSecurityRuntime({
      config: {},
      cors: {
        paths: ['/api/*'],
        origins: ['https://app.example.com'],
        methods: ['get', 'post', 'options'],
        headers: ['content-type', 'x-csrf-token'],
        credentials: true,
        maxAge: 600,
        statefulDomains: ['admin.example.com'],
      },
    })

    const preflight = new Request('https://api.example.com/api/posts', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example.com',
        'access-control-request-method': 'POST',
      },
    })
    const preflightResponse = createCorsPreflightResponse(preflight)

    expect(createCorsHeaders(preflight).get('access-control-allow-origin')).toBe('https://app.example.com')
    expect(preflightResponse?.status).toBe(204)
    expect(preflightResponse?.headers.get('access-control-allow-credentials')).toBe('true')
    expect(preflightResponse?.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS')
    expect(preflightResponse?.headers.get('access-control-allow-headers')).toBe('content-type, x-csrf-token')
    expect(preflightResponse?.headers.get('access-control-max-age')).toBe('600')
    expect(preflightResponse?.headers.get('vary')).toContain('Origin')

    const stateful = new Request('https://api.example.com/api/posts', {
      headers: {
        origin: 'https://admin.example.com',
      },
    })
    const response = cors.apply(stateful, Response.json({ ok: true }))

    expect(response.headers.get('access-control-allow-origin')).toBe('https://admin.example.com')
    expect(response.headers.get('access-control-allow-credentials')).toBe('true')

    const varied = cors.apply(preflight, Response.json({ ok: true }, {
      headers: {
        vary: 'Accept-Encoding, Accept-Language',
      },
    }))
    expect(varied.headers.get('vary')).toBe('Accept-Encoding, Accept-Language, Origin, Access-Control-Request-Method, Access-Control-Request-Headers')
  })

  it('rejects wildcard origins combined with credentials', () => {
    expect(() => normalizeCorsConfig({ origins: ['*'], credentials: true })).toThrow('[Holo CORS] Wildcard origins cannot be combined with credentials.')
    expect(() => configureSecurityRuntime({ config: {}, cors: { origins: ['https://app.example.com', '*'], credentials: true } }))
      .toThrow('[Holo CORS] Wildcard origins cannot be combined with credentials.')
    expect(normalizeCorsConfig({ origins: ['*'] }).origins).toEqual(['*'])
    expect(normalizeCorsConfig({ origins: ['https://app.example.com'], credentials: true }).credentials).toBe(true)
  })

  it('does not emit cors headers outside configured paths or origins', () => {
    configureSecurityRuntime({
      config: {},
      cors: {
        paths: ['/api/*'],
        origins: ['https://app.example.com'],
      },
    })

    expect(cors.headers(new Request('https://api.example.com/web/posts', {
      headers: {
        origin: 'https://app.example.com',
      },
    })).get('access-control-allow-origin')).toBeNull()

    const denied = cors.headers(new Request('https://api.example.com/api/posts', {
      headers: {
        origin: 'https://other.example.com',
      },
    }))
    expect(denied.get('access-control-allow-origin')).toBeNull()
    expect(denied.get('vary')).toBe('Origin')

    const deniedPreflight = cors.preflight(new Request('https://api.example.com/api/posts', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://other.example.com',
        'access-control-request-method': 'POST',
      },
    }))
    expect(deniedPreflight).toBeNull()
  })
})

describe('@holo-js/security csrf', () => {
  it('fails fast when the csrf cookie is used without a configured key', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
      }),
      csrfSession: memoryCsrfSessions({ 'browser-a': 'session-token' }),
    })

    await expect(csrf.cookie(new Request('https://app.test/register'))).rejects.toThrow('APP_KEY')
    await expect(csrf.verify(new Request('https://app.test/register', {
      method: 'POST',
      headers: {
        cookie: 'browser=browser-a',
        'X-XSRF-TOKEN': 'value',
      },
    }))).rejects.toThrow('APP_KEY')
  })

  it('reuses the session csrf token and builds field and cookie helpers', async () => {
    const sessions = memoryCsrfSessions({ 'browser-a': 'session-token' })
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
      }),
      csrfSigningKey: 'test-signing-key',
      csrfSession: sessions,
    })
    const staleCookie = securityExports.csrfInternals.encryptCsrfToken('stale-cookie-token')

    const request = new Request('https://app.test/register', {
      headers: {
        cookie: `browser=browser-a; XSRF-TOKEN=${staleCookie}`,
      },
    })

    await expect(csrf.token(request)).resolves.toBe('session-token')
    await expect(csrf.field(request)).resolves.toEqual({
      name: '_token',
      value: 'session-token',
    })
    await expect(csrf.input(request)).resolves.toEqual({
      type: 'hidden',
      name: '_token',
      value: 'session-token',
    })
    const reissued = await csrf.cookie(request)
    expect(reissued).toMatch(/^XSRF-TOKEN=[\w-]+; Path=\/; SameSite=Lax; Secure$/)
    expect(securityExports.csrfInternals.decryptCsrfToken(reissued.split(';', 1)[0]!.slice('XSRF-TOKEN='.length))).toBe('session-token')
    expect(sessions.writes).toEqual([])

    const proxiedRequest = new Request('http://app.test/register', {
      headers: {
        'x-forwarded-proto': 'https',
      },
    })
    expect(isSecureRequest(proxiedRequest)).toBe(false)
    configureSecurityRuntime({ config: defineSecurityConfig({ trustedProxies: [connectionAddress] }), csrfSigningKey: 'test-signing-key' })
    expect(isSecureRequest(proxiedRequest)).toBe(true)
    expect(isSecureRequest(new Request('http://app.test/register'))).toBe(false)
    await expect(csrf.cookie(proxiedRequest, 'cookie-token')).resolves.toMatch(/; Path=\/; SameSite=Lax; Secure$/)

    expect(isSecureRequest(new Request('http://app.test/register', {
      headers: {
        forwarded: 'for=203.0.113.10;proto="https";host=app.test',
      },
    }))).toBe(false)
  })

  it('generates request-scoped tokens when the session has none', async () => {
    const sessions = memoryCsrfSessions()
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
      }),
      csrfSigningKey: 'test-signing-key',
      csrfSession: sessions,
    })

    const request = new Request('http://app.test/register')
    const token = await csrf.token(request)

    expect(token.length).toBeGreaterThan(10)
    await expect(csrf.field(request)).resolves.toEqual({
      name: '_token',
      value: token,
    })
    await expect(csrf.input(request)).resolves.toEqual({
      type: 'hidden',
      name: '_token',
      value: token,
    })
    const issued = await csrf.cookie(request)
    expect(issued).toMatch(/^XSRF-TOKEN=[\w-]+; Path=\/; SameSite=Lax$/)
    expect(securityExports.csrfInternals.decryptCsrfToken(issued.split(';', 1)[0]!.slice('XSRF-TOKEN='.length))).toBe(token)
    expect(sessions.writes).toEqual([])
    await expect(csrf.token(new Request('http://app.test/register'))).resolves.not.toBe(token)
  })

  it('verifies csrf tokens from headers and form fields', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
      }),
      csrfSigningKey: 'test-signing-key',
      csrfSession: memoryCsrfSessions({ 'browser-a': 'session-token' }),
    })
    const encryptedToken = securityExports.csrfInternals.encryptCsrfToken('session-token')
    const cookie = `browser=browser-a; XSRF-TOKEN=${encryptedToken}`

    for (const headerToken of ['session-token', encryptedToken]) {
      await expect(csrf.verify(new Request('https://app.test/login', {
        method: 'POST',
        headers: {
          cookie,
          'X-CSRF-TOKEN': headerToken,
        },
      }))).resolves.toBeUndefined()
    }

    await expect(csrf.verify(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie,
        'X-XSRF-TOKEN': encryptedToken,
      },
    }))).resolves.toBeUndefined()

    const formData = new FormData()
    formData.set('_token', 'session-token')
    formData.set('email', 'ava@example.com')

    const formRequest = new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie,
      },
      body: formData,
    })
    await expect(csrf.verify(formRequest)).resolves.toBeUndefined()

    const fallbackFormData = new FormData()
    fallbackFormData.set('_token', encryptedToken)
    const blankHeaderRequest = new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie,
        'X-CSRF-TOKEN': '   ',
      },
      body: fallbackFormData,
    })
    await expect(csrf.verify(blankHeaderRequest)).resolves.toBeUndefined()

    const nativeFormRequest = new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://app.test',
      },
      body: new URLSearchParams({
        email: 'ava@example.com',
        _token: 'session-token',
      }),
    })
    await expect(csrf.verify(nativeFormRequest)).resolves.toBeUndefined()

    const fileTokenFormData = new FormData()
    fileTokenFormData.set('_token', new Blob(['not-a-string']))
    await expect(csrf.verify(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie,
      },
      body: fileTokenFormData,
    }))).rejects.toBeInstanceOf(SecurityCsrfError)
  })

  it.each(['origin', 'referer'])('rejects tokenless same-origin login with a signed cookie and %s', async (header) => {
    configureSecurityRuntime({
      config: defineSecurityConfig({ csrf: { enabled: true } }),
      csrfSigningKey: 'test-signing-key',
      csrfSession: memoryCsrfSessions({ 'browser-a': 'session-token' }),
    })
    const signedToken = securityExports.csrfInternals.encryptCsrfToken('session-token')
    await expect(csrf.verify(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: `browser=browser-a; XSRF-TOKEN=${signedToken}`,
        [header]: 'https://app.test',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'ava@example.com', password: 'secret-secret' }),
    }))).rejects.toMatchObject({ status: 419, name: 'SecurityCsrfError' })
  })

  it('rejects missing or mismatched csrf tokens with 419', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
      }),
      csrfSigningKey: 'test-signing-key',
      csrfSession: memoryCsrfSessions({ 'browser-a': 'same-origin-token' }),
    })

    await expect(csrf.verify(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: 'browser=browser-a',
        'X-CSRF-TOKEN': 'wrong',
      },
    }))).rejects.toMatchObject({
      status: 419,
      name: 'SecurityCsrfError',
    })

    const signedToken = securityExports.csrfInternals.encryptCsrfToken('same-origin-token')
    await expect(csrf.verify(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: `browser=browser-a; XSRF-TOKEN=${signedToken}`,
        'X-CSRF-TOKEN': securityExports.csrfInternals.encryptCsrfToken('wrong-token'),
      },
    }))).rejects.toBeInstanceOf(SecurityCsrfError)

    await expect(csrf.verify(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: `browser=browser-a; XSRF-TOKEN=${signedToken}`,
        origin: 'https://evil.test',
      },
      body: new URLSearchParams({
        email: 'ava@example.com',
      }),
    }))).rejects.toBeInstanceOf(SecurityCsrfError)

    await expect(csrf.verify(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: `browser=browser-a; XSRF-TOKEN=${signedToken}`,
        referer: 'not a url',
      },
      body: new URLSearchParams({
        email: 'ava@example.com',
      }),
    }))).rejects.toBeInstanceOf(SecurityCsrfError)

    await expect(csrf.verify(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: `XSRF-TOKEN=${signedToken}`,
        'X-CSRF-TOKEN': 'same-origin-token',
      },
    }))).rejects.toBeInstanceOf(SecurityCsrfError)

    await expect(csrf.verify(new Request('https://app.test/login', {
      method: 'POST',
    }))).rejects.toBeInstanceOf(SecurityCsrfError)
  })

  it('rejects forged csrf tokens that only mirror the cookie value', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
      }),
      csrfSigningKey: 'test-signing-key',
      csrfSession: memoryCsrfSessions({ 'browser-a': 'session-token' }),
    })
    const forgedCookie = securityExports.csrfInternals.encryptCsrfToken('forged-token')

    for (const cookie of ['XSRF-TOKEN=forged-token', 'browser=browser-a; XSRF-TOKEN=forged-token']) {
      await expect(csrf.verify(new Request('https://app.test/login', {
        method: 'POST',
        headers: {
          cookie,
          'X-CSRF-TOKEN': 'forged-token',
        },
      }))).rejects.toBeInstanceOf(SecurityCsrfError)
    }

    for (const cookie of [`XSRF-TOKEN=${forgedCookie}`, `browser=browser-a; XSRF-TOKEN=${forgedCookie}`]) {
      await expect(csrf.verify(new Request('https://app.test/login', {
        method: 'POST',
        headers: {
          cookie,
          'X-XSRF-TOKEN': forgedCookie,
        },
      }))).rejects.toBeInstanceOf(SecurityCsrfError)
    }

    await expect(csrf.token(new Request('https://app.test/login', {
      headers: {
        cookie: 'browser=browser-a; XSRF-TOKEN=forged-token',
      },
    }))).resolves.toBe('session-token')
    await expect(csrf.token(new Request('https://app.test/login', {
      headers: {
        cookie: `XSRF-TOKEN=${forgedCookie}`,
      },
    }))).resolves.not.toBe('forged-token')
  })

  it('rejects malformed encrypted tokens', () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
      }),
      csrfSigningKey: 'test-signing-key',
    })

    expect(securityExports.csrfInternals.decryptCsrfToken('missing-separator')).toBeUndefined()
    expect(securityExports.csrfInternals.decryptCsrfToken('nonce.short')).toBeUndefined()
  })

  it('encrypts explicit raw csrf cookie values and ignores malformed form payloads', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
      }),
      csrfSigningKey: 'test-signing-key',
      csrfSession: memoryCsrfSessions({ 'browser-a': 'raw.nonce', 'browser-b': 'body-token' }),
    })

    const cookie = await csrf.cookie(new Request('https://app.test/register'), 'raw-nonce')
    const encodedValue = cookie.split(';', 1)[0]?.slice('XSRF-TOKEN='.length)
    expect(encodedValue).toBeDefined()
    expect(securityExports.csrfInternals.decryptCsrfToken(decodeURIComponent(encodedValue ?? ''))).toBe('raw-nonce')

    const dottedCookie = await csrf.cookie(new Request('https://app.test/register'), 'raw.nonce')
    const dottedValue = dottedCookie.split(';', 1)[0]?.slice('XSRF-TOKEN='.length)
    expect(dottedValue).toBeDefined()
    const dottedToken = decodeURIComponent(dottedValue ?? '')
    expect(securityExports.csrfInternals.decryptCsrfToken(dottedToken)).toBe('raw.nonce')
    await expect(csrf.verify(new Request('https://app.test/register', {
      method: 'POST',
      headers: {
        cookie: `browser=browser-a; XSRF-TOKEN=${dottedValue}`,
        'X-CSRF-TOKEN': dottedToken,
      },
    }))).resolves.toBeUndefined()

    const token = securityExports.csrfInternals.encryptCsrfToken('body-token')
    await expect(csrf.verify(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: `browser=browser-b; XSRF-TOKEN=${token}`,
        'content-type': 'text/plain',
      },
      body: token,
    }))).rejects.toBeInstanceOf(SecurityCsrfError)
  })

  it('bypasses csrf verification for safe methods and excluded paths', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
          except: ['/webhooks/*'],
        },
      }),
      csrfSigningKey: 'test-signing-key',
    })

    await expect(csrf.verify(new Request('https://app.test/login', {
      method: 'GET',
    }))).resolves.toBeUndefined()

    await expect(csrf.verify(new Request('https://app.test/webhooks/stripe', {
      method: 'POST',
    }))).resolves.toBeUndefined()
    await expect(csrf.verify(new Request('https://app.test/broadcasting/auth', {
      method: 'POST',
    }))).resolves.toBeUndefined()
  })

  it('honors configured header field and cookie overrides', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
          field: '_csrf',
          header: 'X-XSRF-TOKEN',
          cookie: 'csrf-token',
        },
      }),
      csrfSigningKey: 'test-signing-key',
      csrfSession: memoryCsrfSessions({ 'browser-a': 'custom-token' }),
    })
    const customToken = securityExports.csrfInternals.encryptCsrfToken('custom-token')

    const request = new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: `browser=browser-a; csrf-token=${customToken}`,
        'X-XSRF-TOKEN': customToken,
      },
    })

    await expect(csrf.field(request)).resolves.toEqual({
      name: '_csrf',
      value: 'custom-token',
    })
    await expect(csrf.verify(request)).resolves.toBeUndefined()
    await expect(csrf.verify(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: 'browser=browser-a',
      },
      body: new URLSearchParams({ _csrf: 'custom-token' }),
    }))).resolves.toBeUndefined()
    const reissued = await csrf.cookie(request)
    expect(reissued).toMatch(/^csrf-token=[\w-]+; Path=\/; SameSite=Lax; Secure$/)
    expect(securityExports.csrfInternals.decryptCsrfToken(reissued.split(';', 1)[0]!.slice('csrf-token='.length))).toBe('custom-token')
  })

  it('protect uses route-level options against global defaults', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: false,
        },
      }),
      csrfSigningKey: 'test-signing-key',
      csrfSession: memoryCsrfSessions({ 'browser-a': 'forced-token' }),
    })

    const unprotected = new Request('https://app.test/login', {
      method: 'POST',
    })
    await expect(protect(unprotected)).resolves.toBeUndefined()

    const forced = new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: `browser=browser-a; XSRF-TOKEN=${securityExports.csrfInternals.encryptCsrfToken('forced-token')}`,
        'X-CSRF-TOKEN': securityExports.csrfInternals.encryptCsrfToken('forced-token'),
      },
    })
    await expect(protect(forced, { csrf: true })).resolves.toBeUndefined()
    await expect(protect(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: 'browser=browser-a',
      },
    }), { csrf: true })).rejects.toBeInstanceOf(SecurityCsrfError)

    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
      }),
    })

    const disabled = new Request('https://app.test/login', {
      method: 'POST',
    })
    await expect(protect(disabled, { csrf: false })).resolves.toBeUndefined()
  })

  it('lets route-level csrf opt-ins override excluded paths', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: false,
          except: ['/webhooks/*'],
        },
      }),
      csrfSigningKey: 'test-signing-key',
      csrfSession: memoryCsrfSessions({ 'browser-a': 'session-token' }),
    })

    await expect(protect(new Request('https://app.test/webhooks/stripe', {
      method: 'POST',
      headers: {
        cookie: 'browser=browser-a',
      },
    }), {
      csrf: true,
    })).rejects.toBeInstanceOf(SecurityCsrfError)
  })

  it('still skips safe methods and default excluded paths in protect()', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
          except: ['/webhooks/*'],
        },
      }),
      csrfSigningKey: 'test-signing-key',
    })

    await expect(protect(new Request('https://app.test/webhooks/stripe', {
      method: 'POST',
    }))).resolves.toBeUndefined()

    await expect(protect(new Request('https://app.test/webhooks/stripe', {
      method: 'GET',
    }), {
      csrf: true,
    })).resolves.toBeUndefined()
  })

  it('protect applies throttle before csrf verification when configured', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
        rateLimit: {
          limiters: {
            login: limit.perMinute(1).by(({ request }) => ip(request)),
          },
        },
      }),
      csrfSigningKey: 'test-signing-key',
      csrfSession: memoryCsrfSessions({ 'browser-a': 'throttle-token' }),
      rateLimitStore: createMockRateLimitStore(),
    })
    const throttleToken = securityExports.csrfInternals.encryptCsrfToken('throttle-token')

    await expect(protect(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: `browser=browser-a; XSRF-TOKEN=${throttleToken}`,
        'X-CSRF-TOKEN': throttleToken,
        'x-forwarded-for': '203.0.113.10',
      },
    }), {
      throttle: 'login',
    })).resolves.toBeUndefined()

    await expect(protect(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        'x-forwarded-for': '203.0.113.10',
      },
    }), {
      throttle: 'login',
    })).rejects.toBeInstanceOf(SecurityRateLimitError)
  })

  it('protect still applies throttle when csrf is skipped', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
        rateLimit: {
          limiters: {
            login: limit.perMinute(1).by(({ request }) => ip(request)),
          },
        },
      }),
      csrfSigningKey: 'test-signing-key',
      rateLimitStore: createMockRateLimitStore(),
    })

    await expect(protect(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        'x-real-ip': '203.0.113.15',
      },
    }), {
      csrf: false,
      throttle: 'login',
    })).resolves.toBeUndefined()

    await expect(protect(new Request('https://app.test/login', {
      method: 'GET',
      headers: {
        'x-real-ip': '203.0.113.15',
      },
    }), {
      throttle: 'login',
    })).rejects.toBeInstanceOf(SecurityRateLimitError)
  })
})

describe('@holo-js/security rate-limit drivers', () => {
  let memoryNow = new Date('2026-04-16T12:00:00.000Z')

  runRateLimitDriverContractSuite({
    label: 'memory',
    createStore() {
      return createMemoryRateLimitStore({
        now: () => memoryNow,
      })
    },
    advanceSeconds(seconds) {
      memoryNow = new Date(memoryNow.getTime() + seconds * 1000)
    },
    cleanup() {
      memoryNow = new Date('2026-04-16T12:00:00.000Z')
    },
  })

  it('keeps memory buckets process-local to the store instance', async () => {
    const firstStore = createMemoryRateLimitStore({
      now: () => new Date('2026-04-16T12:00:00.000Z'),
    })
    const secondStore = createMemoryRateLimitStore({
      now: () => new Date('2026-04-16T12:00:00.000Z'),
    })

    await firstStore.hit('limiter:login|user:process-local', {
      maxAttempts: 2,
      decaySeconds: 60,
    })

    const isolated = await secondStore.hit('limiter:login|user:process-local', {
      maxAttempts: 2,
      decaySeconds: 60,
    })
    expect(isolated.snapshot.attempts).toBe(1)
  })

  it('clones snapshot expiry dates, fails closed when full, and closes the pruning timer', async () => {
    const now = new Date('2026-04-16T12:00:00.000Z')
    const store = createMemoryRateLimitStore({
      now: () => now,
      maxBuckets: 2,
      pruneIntervalMs: 10_000,
    })

    const first = await store.hit('limiter:login|user:first', {
      maxAttempts: 2,
      decaySeconds: 60,
    })
    first.snapshot.expiresAt.setFullYear(2000)

    await store.hit('limiter:login|user:second', {
      maxAttempts: 2,
      decaySeconds: 60,
    })
    await expect(store.hit('limiter:login|user:third', {
      maxAttempts: 2,
      decaySeconds: 60,
    })).resolves.toMatchObject({ limited: true })

    const repeated = await store.hit('limiter:login|user:first', {
      maxAttempts: 2,
      decaySeconds: 60,
    })

    expect(repeated.snapshot.attempts).toBe(2)
    expect(first.snapshot.expiresAt.getFullYear()).toBe(2000)
    await store.close?.()
  })

  it('does not evict active buckets from the default memory store', async () => {
    const store = createMemoryRateLimitStore()

    for (let index = 0; index <= 1000; index += 1) {
      await store.hit(`limiter:login|user:${index}`, {
        maxAttempts: 2,
        decaySeconds: 60,
      })
    }

    const repeated = await store.hit('limiter:login|user:0', {
      maxAttempts: 2,
      decaySeconds: 60,
    })

    expect(repeated.snapshot.attempts).toBe(2)
    await store.close?.()
  })

  it('keeps a live victim counter when distinct keys fill the default memory store', async () => {
    let now = new Date('2026-04-16T12:00:00.000Z')
    const store = createMemoryRateLimitStore({
      now: () => now,
    })
    const victim = 'limiter:login|user:victim'

    await store.hit(victim, {
      maxAttempts: 2,
      decaySeconds: 60,
    })
    await store.hit(victim, {
      maxAttempts: 2,
      decaySeconds: 60,
    })
    for (let index = 0; index < 9_999; index += 1) {
      await store.hit(`limiter:login|user:${index}`, {
        maxAttempts: 2,
        decaySeconds: 60,
      })
    }

    await expect(store.hit('limiter:login|user:newcomer', {
      maxAttempts: 2,
      decaySeconds: 60,
    })).resolves.toMatchObject({ limited: true })
    await expect(store.hit(victim, {
      maxAttempts: 2,
      decaySeconds: 60,
    })).resolves.toMatchObject({
      limited: true,
      snapshot: { attempts: 3 },
    })

    now = new Date(now.getTime() + 61_000)
    await expect(store.hit('limiter:login|user:newcomer', {
      maxAttempts: 2,
      decaySeconds: 60,
    })).resolves.toMatchObject({
      limited: false,
      snapshot: { attempts: 1 },
    })
    await store.close?.()
  })

  it('derives Retry-After at capacity from when the soonest live bucket frees a slot', async () => {
    const now = new Date('2026-04-16T12:00:00.000Z')
    const store = createMemoryRateLimitStore({
      now: () => now,
      maxBuckets: 1,
    })
    await store.hit('limiter:login|user:held', {
      maxAttempts: 2,
      decaySeconds: 3_600,
    })

    await expect(store.hit('limiter:login|user:newcomer', {
      maxAttempts: 2,
      decaySeconds: 1,
    })).resolves.toMatchObject({
      limited: true,
      retryAfterSeconds: 3_600,
      snapshot: { expiresAt: new Date(now.getTime() + 3_600_000) },
    })
    await store.close?.()
  })

  it('derives a short Retry-After at capacity when the soonest live bucket expires soon', async () => {
    const now = new Date('2026-04-16T12:00:00.000Z')
    const store = createMemoryRateLimitStore({
      now: () => now,
      maxBuckets: 1,
    })
    await store.hit('limiter:login|user:held', {
      maxAttempts: 2,
      decaySeconds: 1,
    })

    await expect(store.hit('limiter:login|user:newcomer', {
      maxAttempts: 2,
      decaySeconds: 3_600,
    })).resolves.toMatchObject({
      limited: true,
      retryAfterSeconds: 1,
      snapshot: { expiresAt: new Date(now.getTime() + 1_000) },
    })
    await store.close?.()
  })

  it('reports a full memory store once until a slot frees, whatever the rejected window is', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      let now = new Date('2026-04-16T12:00:00.000Z')
      const store = createMemoryRateLimitStore({
        now: () => now,
        maxBuckets: 2,
      })
      await store.hit('limiter:login|user:held-a', {
        maxAttempts: 2,
        decaySeconds: 3_600,
      })
      await store.hit('limiter:login|user:held-b', {
        maxAttempts: 2,
        decaySeconds: 3_600,
      })

      for (let second = 0; second < 10; second += 1) {
        now = new Date(new Date('2026-04-16T12:00:00.000Z').getTime() + second * 1_000)
        await expect(store.hit('limiter:ping|user:fast', {
          maxAttempts: 1,
          decaySeconds: 1,
        })).resolves.toMatchObject({ limited: true })
      }

      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(consoleError.mock.calls[0]?.[0]).toContain('rate-limit memory store at capacity')
      await store.close?.()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('reports a full memory store again after a slot frees and the store fills once more', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      let now = new Date('2026-04-16T12:00:00.000Z')
      const store = createMemoryRateLimitStore({
        now: () => now,
        maxBuckets: 1,
      })
      await store.hit('limiter:login|user:held', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      await store.hit('limiter:login|user:first-rejected', { maxAttempts: 2, decaySeconds: 60 })
      expect(consoleError).toHaveBeenCalledTimes(1)

      now = new Date(now.getTime() + 61_000)
      await store.hit('limiter:login|user:admitted', { maxAttempts: 2, decaySeconds: 3_600 })
      await store.hit('limiter:login|user:second-rejected', { maxAttempts: 2, decaySeconds: 60 })
      expect(consoleError).toHaveBeenCalledTimes(2)
      await store.close?.()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('reports a full memory store once per window', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      let now = new Date('2026-04-16T12:00:00.000Z')
      const store = createMemoryRateLimitStore({
        now: () => now,
        maxBuckets: 1,
      })
      await store.hit('limiter:login|user:held', {
        maxAttempts: 2,
        decaySeconds: 600,
      })

      await store.hit('limiter:login|user:a', { maxAttempts: 2, decaySeconds: 60 })
      await store.hit('limiter:login|user:b', { maxAttempts: 2, decaySeconds: 60 })
      expect(consoleError).toHaveBeenCalledTimes(1)
      expect(consoleError.mock.calls[0]?.[0]).toContain('rate-limit memory store at capacity')

      now = new Date(now.getTime() + 61_000)
      await store.hit('limiter:login|user:c', { maxAttempts: 2, decaySeconds: 600 })
      await store.hit('limiter:login|user:d', { maxAttempts: 2, decaySeconds: 600 })
      expect(consoleError).toHaveBeenCalledTimes(1)
      await store.close?.()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('evicts expired memory buckets before evicting active ones when full', async () => {
    let now = new Date('2026-04-16T12:00:00.000Z')
    const store = createMemoryRateLimitStore({
      now: () => now,
      maxBuckets: 2,
      pruneIntervalMs: 60_000,
    })

    await store.hit('limiter:login|user:active', {
      maxAttempts: 2,
      decaySeconds: 600,
    })
    await store.hit('limiter:login|user:short', {
      maxAttempts: 2,
      decaySeconds: 10,
    })
    now = new Date('2026-04-16T12:00:20.000Z')

    await store.hit('limiter:login|user:newcomer', {
      maxAttempts: 2,
      decaySeconds: 600,
    })

    await expect(store.clear('limiter:login|user:active')).resolves.toBe(true)
    await expect(store.clear('limiter:login|user:short')).resolves.toBe(false)
    await store.close?.()
  })

  it('preserves live memory limits when another bucket expires between capacity sweeps', async () => {
    let now = new Date('2026-04-16T12:00:00.000Z')
    const store = createMemoryRateLimitStore({ now: () => now, maxBuckets: 2 })
    try {
      await store.hit('short', { maxAttempts: 1, decaySeconds: 1 })
      await store.hit('live', { maxAttempts: 1, decaySeconds: 600 })
      now = new Date('2026-04-16T12:00:02.000Z')
      await store.hit('next-short', { maxAttempts: 1, decaySeconds: 1 })
      now = new Date('2026-04-16T12:00:04.000Z')
      await store.hit('new', { maxAttempts: 1, decaySeconds: 60 })
      await expect(store.hit('live', { maxAttempts: 1, decaySeconds: 600 })).resolves.toMatchObject({
        limited: true,
        snapshot: { attempts: 2 },
      })
    } finally {
      await store.close?.()
    }
  })

  it('prunes expired memory buckets on a timer', async () => {
    vi.useFakeTimers()

    try {
      let now = new Date('2026-04-16T12:00:00.000Z')
      const store = createMemoryRateLimitStore({
        now: () => now,
        maxBuckets: 4,
        pruneIntervalMs: 10,
      })

      await store.hit('limiter:login|user:pruned', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      now = new Date('2026-04-16T12:02:00.000Z')

      await vi.advanceTimersByTimeAsync(10)

      await expect(store.clear('limiter:login|user:pruned')).resolves.toBe(false)
      await store.close?.()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves active memory buckets alone during timer pruning', async () => {
    vi.useFakeTimers()

    try {
      const store = createMemoryRateLimitStore({
        now: () => new Date('2026-04-16T12:00:00.000Z'),
        maxBuckets: 1,
        pruneIntervalMs: 10,
      })

      await store.hit('limiter:login|user:active', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      await vi.advanceTimersByTimeAsync(10)

      const repeated = await store.hit('limiter:login|user:active', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      expect(repeated.snapshot.attempts).toBe(2)
      await store.close?.()
    } finally {
      vi.useRealTimers()
    }
  })

  describe('file rate-limit driver contract', () => {
    let harness:
      | {
          root: string
          setNow(value: Date): void
          advanceSeconds(seconds: number): void
          createStore(): SecurityRateLimitStore
        }
      | undefined

    async function createHarness() {
      const root = await mkdtemp(join(tmpdir(), 'holo-security-file-'))
      tempDirs.push(root)
      let now = new Date('2026-04-16T12:00:00.000Z')

      return {
        root,
        setNow(value: Date) {
          now = value
        },
        advanceSeconds(seconds: number) {
          now = new Date(now.getTime() + seconds * 1000)
        },
        createStore() {
          return createFileRateLimitStore(root, {
            now: () => now,
          })
        },
      }
    }

    runRateLimitDriverContractSuite({
      label: 'file',
      async createStore() {
        harness = await createHarness()
        return harness.createStore()
      },
      advanceSeconds(seconds) {
        harness?.advanceSeconds(seconds)
      },
      supportsPersistence: true,
      recreateStore() {
        if (!harness) {
          throw new Error('file test harness is not initialized')
        }

        return harness.createStore()
      },
    })

    it('cleans up expired buckets while scanning and resets expired buckets on hit', async () => {
      const harness = await createHarness()
      const store = harness.createStore()

      await store.hit('limiter:login|user:expired', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      harness.setNow(new Date('2026-04-16T12:02:00.000Z'))

      const reset = await store.hit('limiter:login|user:expired', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      expect(reset.snapshot.attempts).toBe(1)

      await store.hit('limiter:login|user:scan-expired', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      harness.setNow(new Date('2026-04-16T12:04:00.000Z'))
      await expect(store.clearByPrefix('limiter:login|')).resolves.toBe(0)
    })

    it('stores opaque file bucket metadata and still clears by prefix', async () => {
      const harness = await createHarness()
      const store = harness.createStore()
      const key = 'limiter:login|user:pii@example.com'
      const bucketPath = fileRateLimitDriverInternals.getBucketPath(harness.root, key)

      await store.hit(key, {
        maxAttempts: 2,
        decaySeconds: 60,
      })

      const serialized = await readFile(bucketPath, 'utf8')
      expect(serialized).not.toContain('pii@example.com')
      expect(serialized).not.toContain('limiter:login|')
      expect(serialized).toContain('"namespaceHash":"')
      expect(serialized).toContain('"keyHash":"')
      expect(serialized).toContain('"prefixHashes":[')
      await expect(store.clearByPrefix('limiter:login|')).resolves.toBe(1)
    })

    it('keeps direct file bucket keys opaque while preserving prefix clearing', async () => {
      const harness = await createHarness()
      const store = harness.createStore()
      const key = 'user:pii@example.com'
      const bucketPath = fileRateLimitDriverInternals.getBucketPath(harness.root, key)

      await store.hit(key, {
        maxAttempts: 2,
        decaySeconds: 60,
      })

      const serialized = await readFile(bucketPath, 'utf8')
      expect(serialized).not.toContain(key)
      expect(serialized).not.toContain('pii@example.com')
      expect(serialized).toContain('"namespaceHash":"')
      expect(serialized).toContain('"keyHash":"')
      expect(serialized).toContain('"prefixHashes":[')
      await expect(store.clearByPrefix('user:')).resolves.toBe(1)
    })

    it('does not leak raw limiter keys when file bucket hashes collide', async () => {
      const harness = await createHarness()
      const store = harness.createStore()
      const key = 'limiter:login|user:pii@example.com'
      const bucketPath = fileRateLimitDriverInternals.getBucketPath(harness.root, key)

      await mkdir(dirname(bucketPath), { recursive: true })
      await writeFile(bucketPath, JSON.stringify({
        namespace: 'limiter:login|',
        keyHash: 'different-hash',
        prefixHashes: ['different-prefix-hash'],
        attempts: 1,
        expiresAt: '2026-04-16T12:01:00.000Z',
      }), 'utf8')

      await expect(store.hit(key, {
        maxAttempts: 2,
        decaySeconds: 60,
      })).rejects.toThrow('bucket hash collision')
      await expect(store.hit(key, {
        maxAttempts: 2,
        decaySeconds: 60,
      })).rejects.not.toThrow('pii@example.com')
    })

    it('clears file buckets with prefixes narrower than the limiter namespace', async () => {
      const harness = await createHarness()
      const store = harness.createStore()

      await store.hit('limiter:login|user:alpha@example.com', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      await store.hit('limiter:login|user:beta@example.com', {
        maxAttempts: 2,
        decaySeconds: 60,
      })

      await expect(store.clearByPrefix('limiter:login|user:alpha')).resolves.toBe(1)

      const alpha = await store.hit('limiter:login|user:alpha@example.com', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      const beta = await store.hit('limiter:login|user:beta@example.com', {
        maxAttempts: 2,
        decaySeconds: 60,
      })

      expect(alpha.snapshot.attempts).toBe(1)
      expect(beta.snapshot.attempts).toBe(2)
    })

    it('keeps hitting healthy keys when the sweep meets an unreadable bucket file', async () => {
      const harness = await createHarness()
      const store = harness.createStore()
      const brokenPath = join(harness.root, 'buckets', 'aa', 'bb', 'broken.json')
      await mkdir(dirname(brokenPath), { recursive: true })
      await writeFile(brokenPath, '{bad json', 'utf8')

      await expect(store.hit('limiter:login|user:healthy', {
        maxAttempts: 2,
        decaySeconds: 60,
      })).resolves.toMatchObject({
        limited: false,
        snapshot: { attempts: 1 },
      })
    })

    it('starts a file window after waiting for its bucket lock', async () => {
      const harness = await createHarness()
      let now = new Date('2026-04-16T12:00:00.000Z')
      let signalStarted!: () => void
      const started = new Promise<void>((resolve) => { signalStarted = resolve })
      const store = createFileRateLimitStore(harness.root, {
        now: () => { signalStarted(); return now },
        lockTimeoutMs: 2000,
      })
      const path = fileRateLimitDriverInternals.getBucketPath(harness.root, 'waiting')
      const lockPath = fileRateLimitDriverInternals.getBucketLockPath(path)
      await mkdir(lockPath, { recursive: true })
      const hit = store.hit('waiting', { maxAttempts: 1, decaySeconds: 60 })
      await started
      now = new Date('2026-04-16T12:02:00.000Z')
      await rm(lockPath, { recursive: true })
      const result = await hit
      expect(result.snapshot.expiresAt).toEqual(new Date('2026-04-16T12:03:00.000Z'))
      await expect(store.hit('waiting', { maxAttempts: 1, decaySeconds: 60 })).resolves.toMatchObject({ limited: true })
    })

    it('removes expired bucket files on a sweep even when their keys are never hit again', async () => {
      const root = await mkdtemp(join(tmpdir(), 'holo-security-file-'))
      tempDirs.push(root)
      let now = new Date('2026-04-16T12:00:00.000Z')
      const store = createFileRateLimitStore(root, {
        now: () => now,
      })

      await store.hit('limiter:login|user:abandoned', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      const abandonedPath = fileRateLimitDriverInternals.getBucketPath(root, 'limiter:login|user:abandoned')

      now = new Date('2026-04-16T12:02:00.000Z')
      await store.hit('limiter:login|user:fresh', {
        maxAttempts: 2,
        decaySeconds: 60,
      })

      await vi.waitFor(async () => {
        await expect(readFile(abandonedPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      }, { timeout: 15_000, interval: 10 })
      await expect(store.clear('limiter:login|user:fresh')).resolves.toBe(true)
    })

    describe('background expiry sweep', () => {
      const sweepStart = new Date('2026-04-16T12:00:00.000Z')

      async function createSweepRoot() {
        const root = await mkdtemp(join(tmpdir(), 'holo-security-file-'))
        tempDirs.push(root)
        return root
      }

      async function writeExpiredBucket(root: string, key: string) {
        const path = fileRateLimitDriverInternals.getBucketPath(root, key)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, JSON.stringify({
          namespaceHash: 'namespace',
          keyHash: fileRateLimitDriverInternals.createBucketHash(key),
          prefixHashes: ['prefix'],
          attempts: 1,
          expiresAt: '2026-04-16T11:59:00.000Z',
        }), 'utf8')
      }

      async function writeExpiredBuckets(root: string, count: number, prefix: string) {
        for (let index = 0; index < count; index += 1) {
          await writeExpiredBucket(root, `limiter:login|${prefix}:${index}`)
        }
      }

      async function bucketFileCount(root: string) {
        return (await fileRateLimitDriverInternals.listBucketPaths(join(root, 'buckets'))).length
      }

      async function waitUntil(predicate: () => Promise<boolean>) {
        const deadline = Date.now() + 60_000
        while (!(await predicate())) {
          if (Date.now() > deadline) {
            throw new Error('Timed out waiting for the background sweep.')
          }
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }

      it('returns from hit promptly while the sweep meets a locked expired bucket', async () => {
        const root = await createSweepRoot()
        let now = sweepStart
        const store = createFileRateLimitStore(root, {
          now: () => now,
          lockTimeoutMs: 5_000,
        })
        const heldKey = 'limiter:login|user:held'
        await writeExpiredBucket(root, heldKey)
        const heldKeyPath = fileRateLimitDriverInternals.getBucketPath(root, heldKey)
        const heldLockPath = fileRateLimitDriverInternals.getBucketLockPath(heldKeyPath)
        await mkdir(heldLockPath)

        const startedAt = performance.now()
        await store.hit('limiter:login|user:other', {
          maxAttempts: 2,
          decaySeconds: 60,
        })
        expect(performance.now() - startedAt).toBeLessThan(1_000)

        await store.close?.()
        await rm(heldLockPath, { recursive: true, force: true })
        await rm(heldKeyPath, { force: true })
      }, 30_000)

      it('starts at most one sweep while one is in flight', async () => {
        const root = await createSweepRoot()
        let now = sweepStart
        const store = createFileRateLimitStore(root, {
          now: () => now,
        })
        await writeExpiredBuckets(root, 1_500, 'flight')

        await store.hit('limiter:login|user:first', {
          maxAttempts: 2,
          decaySeconds: 60,
        })
        now = new Date(now.getTime() + 61_000)
        await store.hit('limiter:login|user:second', {
          maxAttempts: 2,
          decaySeconds: 60,
        })

        expect(fileRateLimitDriverInternals.sweepInFlight(store)).toBe(true)
        expect(fileRateLimitDriverInternals.sweepRunsStarted(store)).toBe(1)
        await store.close?.()
      }, 30_000)

      it('removes abandoned buckets across batches and later sweep cycles', async () => {
        const root = await createSweepRoot()
        let now = sweepStart
        const store = createFileRateLimitStore(root, {
          now: () => now,
        })
        await writeExpiredBuckets(root, 1_500, 'first')

        await waitUntil(async () => {
          await store.hit('limiter:login|user:kicker', {
            maxAttempts: 2,
            decaySeconds: 60,
          })
          return await bucketFileCount(root) === 1
        })

        await writeExpiredBuckets(root, 1_200, 'second')
        now = new Date(now.getTime() + 61_000)
        await waitUntil(async () => {
          await store.hit('limiter:login|user:kicker', {
            maxAttempts: 2,
            decaySeconds: 60,
          })
          return await bucketFileCount(root) === 1
        })

        await expect(store.clear('limiter:login|user:kicker')).resolves.toBe(true)
        await store.close?.()
      }, 60_000)

      it('holds at most one batch of sweep entries per run across several thousand buckets', async () => {
        const root = await createSweepRoot()
        let now = sweepStart
        const store = createFileRateLimitStore(root, {
          now: () => now,
        })
        await writeExpiredBuckets(root, 3_000, 'bounded')

        await waitUntil(async () => {
          await store.hit('limiter:login|user:kicker', {
            maxAttempts: 2,
            decaySeconds: 60,
          })
          return await bucketFileCount(root) === 1
        })

        expect(fileRateLimitDriverInternals.sweepMaxEntriesPerRun(store)).toBeLessThanOrEqual(1_000)
        expect(fileRateLimitDriverInternals.sweepPeakHeldNames(store)).toBeLessThanOrEqual(1_000)
        expect(fileRateLimitDriverInternals.sweepRunsStarted(store)).toBeGreaterThanOrEqual(3)
        await store.close?.()
      }, 120_000)

      it('streams a single shard holding several thousand files without holding it in memory', async () => {
        const root = await createSweepRoot()
        const now = sweepStart
        const store = createFileRateLimitStore(root, {
          now: () => now,
        })
        const seedKey = 'limiter:login|user:shard-seed'
        await writeExpiredBucket(root, seedKey)
        const shard = dirname(fileRateLimitDriverInternals.getBucketPath(root, seedKey))
        for (let index = 0; index < 3_000; index += 1) {
          await writeFile(join(shard, `stale-${index}.json`), JSON.stringify({
            namespaceHash: 'namespace',
            keyHash: 'stale',
            prefixHashes: ['prefix'],
            attempts: 1,
            expiresAt: '2026-04-16T11:59:00.000Z',
          }), 'utf8')
        }

        await waitUntil(async () => {
          await store.hit('limiter:login|user:kicker', {
            maxAttempts: 2,
            decaySeconds: 60,
          })
          return await bucketFileCount(root) === 1
        })

        expect(fileRateLimitDriverInternals.sweepMaxEntriesPerRun(store)).toBeLessThanOrEqual(1_000)
        expect(fileRateLimitDriverInternals.sweepPeakHeldNames(store)).toBeLessThanOrEqual(1_000)
        expect(fileRateLimitDriverInternals.sweepRunsStarted(store)).toBeGreaterThanOrEqual(3)
        await store.close?.()
      }, 120_000)

      it('keeps one shard handle open between runs and releases it on close', async () => {
        const root = await createSweepRoot()
        const now = sweepStart
        const store = createFileRateLimitStore(root, {
          now: () => now,
        })
        const seedKey = 'limiter:login|user:handle-seed'
        await writeExpiredBucket(root, seedKey)
        const shard = dirname(fileRateLimitDriverInternals.getBucketPath(root, seedKey))
        for (let index = 0; index < 2_500; index += 1) {
          await writeFile(join(shard, `handle-${index}.json`), JSON.stringify({
            namespaceHash: 'namespace',
            keyHash: 'handle',
            prefixHashes: ['prefix'],
            attempts: 1,
            expiresAt: '2026-04-16T11:59:00.000Z',
          }), 'utf8')
        }

        await store.hit('limiter:login|user:first-run', {
          maxAttempts: 2,
          decaySeconds: 60,
        })
        await waitUntil(async () => !fileRateLimitDriverInternals.sweepInFlight(store))
        expect(fileRateLimitDriverInternals.sweepOpenHandles(store)).toBe(1)

        await store.close?.()
        expect(fileRateLimitDriverInternals.sweepOpenHandles(store)).toBe(0)
      }, 120_000)

      it('finishes an in-flight sweep on close and starts no more after it', async () => {
        const root = await createSweepRoot()
        let now = sweepStart
        const store = createFileRateLimitStore(root, {
          now: () => now,
        })
        await writeExpiredBuckets(root, 1_500, 'closing')

        await store.hit('limiter:login|user:before-close', {
          maxAttempts: 2,
          decaySeconds: 60,
        })
        await store.close?.()
        expect(fileRateLimitDriverInternals.sweepInFlight(store)).toBe(false)

        now = new Date(now.getTime() + 61_000)
        await store.hit('limiter:login|user:after-close', {
          maxAttempts: 2,
          decaySeconds: 60,
        })
        expect(fileRateLimitDriverInternals.sweepRunsStarted(store)).toBe(1)
      }, 30_000)
    })

    it('leaves unrelated JSON files under the root alone during the sweep and clearAll', async () => {
      const root = await mkdtemp(join(tmpdir(), 'holo-security-file-'))
      tempDirs.push(root)
      let now = new Date('2026-04-16T12:00:00.000Z')
      const store = createFileRateLimitStore(root, {
        now: () => now,
      })
      const unrelatedPath = join(root, 'app-state.json')
      await writeFile(unrelatedPath, JSON.stringify({
        namespaceHash: 'app-namespace',
        keyHash: 'app-key',
        prefixHashes: ['app-prefix'],
        attempts: 1,
        expiresAt: '2026-04-16T12:00:30.000Z',
      }), 'utf8')

      now = new Date('2026-04-16T12:02:00.000Z')
      await store.hit('limiter:login|user:fresh', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      await expect(access(unrelatedPath)).resolves.toBeUndefined()

      await expect(store.clearAll()).resolves.toBe(1)
      await expect(access(unrelatedPath)).resolves.toBeUndefined()
    })

    it('serializes concurrent hits on the same bucket so attempts are not lost', async () => {
      const harness = await createHarness()
      const store = harness.createStore()

      const [first, second] = await Promise.all([
        store.hit('limiter:login|user:concurrent', {
          maxAttempts: 3,
          decaySeconds: 60,
        }),
        store.hit('limiter:login|user:concurrent', {
          maxAttempts: 3,
          decaySeconds: 60,
        }),
      ])

      expect([first.snapshot.attempts, second.snapshot.attempts].sort((left, right) => left - right)).toEqual([1, 2])

      const persisted = await harness.createStore().hit('limiter:login|user:concurrent', {
        maxAttempts: 3,
        decaySeconds: 60,
      })

      expect(persisted.snapshot.attempts).toBe(3)
    })

    it('reclaims stale bucket locks before timing out', async () => {
      const harness = await createHarness()
      const staleStore = createFileRateLimitStore(harness.root, {
        now: () => new Date('2026-04-16T12:00:00.000Z'),
        lockRetryDelayMs: 1,
        lockTimeoutMs: 20,
      })
      const bucketPath = fileRateLimitDriverInternals.getBucketPath(harness.root, 'limiter:login|user:stale-lock')
      const lockPath = fileRateLimitDriverInternals.getBucketLockPath(bucketPath)

      await mkdir(lockPath, { recursive: true })
      await utimes(lockPath, new Date('2026-04-16T11:59:00.000Z'), new Date('2026-04-16T11:59:00.000Z'))
      await expect(staleStore.hit('limiter:login|user:stale-lock', {
        maxAttempts: 2,
        decaySeconds: 60,
      })).resolves.toEqual(expect.objectContaining({
        limited: false,
        snapshot: expect.objectContaining({
          attempts: 1,
        }),
      }))
    })

    it('serializes concurrent waiters reclaiming the same stale bucket lock', async () => {
      const harness = await createHarness()
      const store = createFileRateLimitStore(harness.root, {
        now: () => new Date('2026-04-16T12:00:00.000Z'),
        lockRetryDelayMs: 1,
        lockTimeoutMs: 200,
      })
      const key = 'limiter:login|user:stale-lock-contended'
      const bucketPath = fileRateLimitDriverInternals.getBucketPath(harness.root, key)
      const lockPath = fileRateLimitDriverInternals.getBucketLockPath(bucketPath)

      await mkdir(lockPath, { recursive: true })
      await utimes(lockPath, new Date('2026-04-16T11:59:00.000Z'), new Date('2026-04-16T11:59:00.000Z'))

      const hits = await Promise.all(Array.from({ length: 6 }, () => store.hit(key, {
        maxAttempts: 10,
        decaySeconds: 60,
      })))

      expect(hits.map(hit => hit.snapshot.attempts).sort((left, right) => left - right)).toEqual([1, 2, 3, 4, 5, 6])

      const persisted = await store.hit(key, {
        maxAttempts: 10,
        decaySeconds: 60,
      })
      expect(persisted.snapshot.attempts).toBe(7)
    })

    it('does not delete a newer bucket lock when an older owner finishes', async () => {
      const harness = await createHarness()
      const bucketPath = fileRateLimitDriverInternals.getBucketPath(harness.root, 'limiter:login|user:replaced-lock')
      const lockPath = fileRateLimitDriverInternals.getBucketLockPath(bucketPath)
      const ownerPath = join(lockPath, 'owner')
      let releaseLock!: () => void
      let replacedLock!: () => void
      const releaseRequested = new Promise<void>((resolve) => {
        releaseLock = resolve
      })
      const lockReplaced = new Promise<void>((resolve) => {
        replacedLock = resolve
      })

      const holdingLock = fileRateLimitDriverInternals.withBucketLock(bucketPath, {
        retryDelayMs: 1,
        timeoutMs: 20,
      }, async () => {
        await rm(lockPath, { recursive: true, force: true })
        await mkdir(lockPath)
        await writeFile(ownerPath, 'new-owner', 'utf8')
        replacedLock()
        await releaseRequested
      })

      await lockReplaced
      releaseLock()
      await holdingLock

      await expect(readFile(ownerPath, 'utf8')).resolves.toBe('new-owner')
      await rm(lockPath, { recursive: true, force: true })
    })

    it('ignores heartbeat failures when a lock disappears during the protected operation', async () => {
      const harness = await createHarness()
      const bucketPath = fileRateLimitDriverInternals.getBucketPath(harness.root, 'limiter:login|user:heartbeat-missing-lock')
      const lockPath = fileRateLimitDriverInternals.getBucketLockPath(bucketPath)

      await expect(fileRateLimitDriverInternals.withBucketLock(bucketPath, {
        retryDelayMs: 1,
        timeoutMs: 4,
      }, async () => {
        await rm(lockPath, { recursive: true, force: true })
        await fileRateLimitDriverInternals.sleep(10)
      })).resolves.toBeUndefined()
    })

    it('does not reclaim live bucket locks while another operation is still running', async () => {
      const harness = await createHarness()
      const bucketPath = fileRateLimitDriverInternals.getBucketPath(harness.root, 'limiter:login|user:live-lock')
      let releaseLock!: () => void
      let signalAcquired!: () => void
      const releaseRequested = new Promise<void>((resolve) => { releaseLock = resolve })
      const lockAcquired = new Promise<void>((resolve) => { signalAcquired = resolve })
      const holdingLock = fileRateLimitDriverInternals.withBucketLock(bucketPath, {
        retryDelayMs: 1,
        timeoutMs: 100,
      }, async () => {
        signalAcquired()
        await releaseRequested
      })

      await lockAcquired
      try {
        await expect(fileRateLimitDriverInternals.withBucketLock(bucketPath, {
          retryDelayMs: 1,
          timeoutMs: 300,
        }, async () => 'reclaimed')).rejects.toThrow(`Timed out waiting for file rate-limit lock "${fileRateLimitDriverInternals.getBucketLockPath(bucketPath)}"`)
      } finally {
        releaseLock()
        await holdingLock
      }
    })

    it('waits for active bucket locks before clearing all persisted buckets', async () => {
      const harness = await createHarness()
      const store = createFileRateLimitStore(harness.root, {
        now: () => new Date('2026-04-16T12:00:00.000Z'),
        lockRetryDelayMs: 1,
        lockTimeoutMs: 100,
      })
      const key = 'limiter:login|user:clear-all-lock'
      const bucketPath = fileRateLimitDriverInternals.getBucketPath(harness.root, key)
      let releaseLock!: () => void

      await store.hit(key, {
        maxAttempts: 2,
        decaySeconds: 60,
      })

      const lockHeld = new Promise<void>((resolve) => {
        releaseLock = resolve
      })

      const holdingLock = fileRateLimitDriverInternals.withBucketLock(bucketPath, {
        retryDelayMs: 1,
        timeoutMs: 100,
      }, async () => {
        await lockHeld
      })

      await fileRateLimitDriverInternals.sleep(5)

      let clearResolved = false
      const clearAll = store.clearAll().then((cleared) => {
        clearResolved = true
        return cleared
      })

      await fileRateLimitDriverInternals.sleep(10)
      expect(clearResolved).toBe(false)

      releaseLock()
      await holdingLock
      await expect(clearAll).resolves.toBe(1)
      await expect(store.hit(key, {
        maxAttempts: 2,
        decaySeconds: 60,
      })).resolves.toEqual(expect.objectContaining({
        snapshot: expect.objectContaining({
          attempts: 1,
        }),
      }))
    })

    async function withDisappearingLockedBucket(
      callback: (store: SecurityRateLimitStore, key: string) => Promise<void>,
    ): Promise<void> {
      const harness = await createHarness()
      const store = createFileRateLimitStore(harness.root, {
        now: () => new Date('2026-04-16T12:00:00.000Z'),
        lockRetryDelayMs: 1,
        lockTimeoutMs: 100,
      })
      const key = 'limiter:login|user:disappearing-lock'
      const bucketPath = fileRateLimitDriverInternals.getBucketPath(harness.root, key)
      let releaseLock!: () => void

      await store.hit(key, {
        maxAttempts: 2,
        decaySeconds: 60,
      })

      let requestDelete!: () => void
      const deleteRequested = new Promise<void>((resolve) => {
        requestDelete = resolve
      })
      const bucketDeleted = new Promise<void>((resolve) => {
        releaseLock = resolve
      })

      const holdingLock = fileRateLimitDriverInternals.withBucketLock(bucketPath, {
        retryDelayMs: 1,
        timeoutMs: 100,
      }, async () => {
        await deleteRequested
        await fileRateLimitDriverInternals.deleteBucket(bucketPath)
        releaseLock()
      })

      await fileRateLimitDriverInternals.sleep(5)
      const pendingClear = callback(store, key)
      await fileRateLimitDriverInternals.sleep(5)
      requestDelete()
      await bucketDeleted
      await pendingClear

      await holdingLock
    }

    it('skips buckets deleted before clearByPrefix acquires their lock', async () => {
      await withDisappearingLockedBucket(async (store) => {
        await expect(store.clearByPrefix('limiter:login|')).resolves.toBe(0)
      })
    })

    it('skips buckets deleted before clearAll acquires their lock', async () => {
      await withDisappearingLockedBucket(async (store) => {
        await expect(store.clearAll()).resolves.toBe(0)
      })
    })

    it('uses sharded per-bucket file paths and rejects malformed bucket files', async () => {
      const harness = await createHarness()
      const bucketPath = fileRateLimitDriverInternals.getBucketPath(harness.root, 'limiter:login|user:bad')

      expect(bucketPath.startsWith(harness.root)).toBe(true)
      expect(bucketPath.startsWith(join(harness.root, 'buckets'))).toBe(true)
      expect(bucketPath.endsWith('.json')).toBe(true)

      await mkdir(join(harness.root, 'aa', 'bb'), { recursive: true })
      await writeFile(join(harness.root, 'aa', 'bb', 'broken.json'), '{bad json', 'utf8')
      await expect(fileRateLimitDriverInternals.readBucket(join(harness.root, 'aa', 'bb', 'broken.json'))).rejects.toThrow()
    })
  })

  describe('redis rate-limit driver contract', () => {
    let currentNow = new Date('2026-04-16T12:00:00.000Z')

    function createAdapter(now: Date): {
      adapter: SecurityRateLimitRedisDriverAdapter
      setNow(value: Date): void
    } {
      const buckets = new Map<string, { attempts: number, expiresAt: Date }>()
      let currentNow = now

      return {
        setNow(value) {
          currentNow = value
        },
        adapter: {
          async increment(key, options) {
            const existing = buckets.get(key)
            if (existing && existing.expiresAt.getTime() <= currentNow.getTime()) {
              buckets.delete(key)
            }

            const active = buckets.get(key)
            const bucket = active
              ? {
                  ...active,
                  attempts: active.attempts + 1,
                }
              : {
                  attempts: 1,
                  expiresAt: new Date(currentNow.getTime() + options.decaySeconds * 1000),
                }

            buckets.set(key, bucket)
            return {
              attempts: bucket.attempts,
              ttlSeconds: Math.max(0, Math.ceil((bucket.expiresAt.getTime() - currentNow.getTime()) / 1000)),
            }
          },
          async del(key) {
            const existed = buckets.delete(key)
            return existed ? 1 : 0
          },
          async clearByPrefix(prefix) {
            let cleared = 0

            for (const key of buckets.keys()) {
              if (!key.startsWith(prefix)) {
                continue
              }

              buckets.delete(key)
              cleared += 1
            }

            return cleared
          },
          async clearAll() {
            const cleared = buckets.size
            buckets.clear()
            return cleared
          },
        },
      }
    }

    let currentAdapter: ReturnType<typeof createAdapter> | undefined

    runRateLimitDriverContractSuite({
      label: 'redis',
      createStore() {
        currentAdapter = createAdapter(currentNow)
        return createRedisRateLimitStore(currentAdapter.adapter, {
          now: () => currentNow,
        })
      },
      advanceSeconds(seconds) {
        currentNow = new Date(currentNow.getTime() + seconds * 1000)
        currentAdapter?.setNow(currentNow)
      },
      cleanup() {
        currentNow = new Date('2026-04-16T12:00:00.000Z')
        currentAdapter = undefined
      },
    })

    it('validates malformed adapter results and falls back when clear helpers are unavailable', async () => {
      const storeWithoutClear = createRedisRateLimitStore({
        async increment() {
          return {
            attempts: 1,
            ttlSeconds: 60,
          }
        },
        async del() {
          return 1
        },
      })

      await expect(storeWithoutClear.clearByPrefix('limiter:login|')).resolves.toBe(0)
      await expect(storeWithoutClear.clearAll()).resolves.toBe(0)
      await expect(storeWithoutClear.hit('limiter:login|user:default-now', {
        maxAttempts: 2,
        decaySeconds: 60,
      })).resolves.toMatchObject({
        limited: false,
        snapshot: {
          attempts: 1,
        },
      })

      const malformedStore = createRedisRateLimitStore({
        async increment() {
          return {
            attempts: -1,
            ttlSeconds: -1,
          }
        },
        async del() {
          return -1
        },
        async clearByPrefix() {
          return -1
        },
        async clearAll() {
          return -1
        },
      })

      await expect(malformedStore.hit('limiter:login|user:1', {
        maxAttempts: 2,
        decaySeconds: 60,
      })).rejects.toThrow('attempts must be a non-negative integer')

      const malformedTtlStore = createRedisRateLimitStore({
        async increment() {
          return {
            attempts: 1,
            ttlSeconds: -1,
          }
        },
        async del() {
          return 1
        },
      })

      await expect(malformedTtlStore.hit('limiter:login|user:1', {
        maxAttempts: 2,
        decaySeconds: 60,
      })).rejects.toThrow('ttlSeconds must be a non-negative integer')

      const malformedClearStore = createRedisRateLimitStore({
        async increment() {
          return {
            attempts: 1,
            ttlSeconds: 60,
          }
        },
        async del() {
          return -1
        },
        async clearByPrefix() {
          return -1
        },
        async clearAll() {
          return -1
        },
      })

      await expect(malformedClearStore.clear('limiter:login|user:1')).rejects.toThrow('del() result must be a non-negative integer')
      await expect(malformedClearStore.clearByPrefix('limiter:login|')).rejects.toThrow('clearByPrefix() result must be a non-negative integer')
      await expect(malformedClearStore.clearAll()).rejects.toThrow('clearAll() result must be a non-negative integer')

      const close = vi.fn(async () => {})
      const closableStore = createRedisRateLimitStore({
        async increment() {
          return {
            attempts: 1,
            ttlSeconds: 60,
          }
        },
        async del() {
          return 1
        },
        close,
      })
      await closableStore.close?.()
      expect(close).toHaveBeenCalledOnce()
    })

    it('exposes the standalone contract suite-compatible driver behavior', () => {
      expect(typeof redisRateLimitDriverInternals.assertNonNegativeInteger).toBe('function')
      expect(typeof memoryRateLimitDriverInternals.isExpired).toBe('function')
    })
  })
})

describe('@holo-js/security rate limiting', () => {
  it('derives limiter keys from the request context', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        trustedProxies: [connectionAddress],
        rateLimit: {
          limiters: {
            login: limit.perMinute(2).by(({ request, values }) => {
              return `${ip(request)}:${String(values?.email ?? 'guest')}`
            }),
          },
        },
      }),
      rateLimitStore: createMockRateLimitStore(),
    })

    const result = await rateLimit('login', {
      request: new Request('https://app.test/login', {
        headers: {
          'x-forwarded-for': '203.0.113.7',
        },
      }),
      values: {
        email: 'ava@example.com',
      },
    })

    expect(result).toEqual({
      limited: false,
      snapshot: {
        limiter: 'login',
        key: '203.0.113.7:ava@example.com',
        attempts: 1,
        maxAttempts: 2,
        remainingAttempts: 1,
        expiresAt: new Date('2026-04-16T12:01:00.000Z'),
      },
      retryAfterSeconds: 60,
    })
  })

  it('supports direct key usage without a request', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        rateLimit: {
          limiters: {
            invites: limit.perHour(3).define(),
          },
        },
      }),
      rateLimitStore: createMockRateLimitStore(),
    })

    const result = await rateLimit('invites', {
      key: 'team:42:user:7',
    })

    expect(result.snapshot).toMatchObject({
      limiter: 'invites',
      key: 'team:42:user:7',
      attempts: 1,
      maxAttempts: 3,
      remainingAttempts: 2,
    })
    expect(result.retryAfterSeconds).toBe(3600)
  })

  it('uses the default guest request key when no limiter resolver is configured', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        rateLimit: {
          limiters: {
            invites: limit.perHour(3).define(),
          },
        },
      }),
      rateLimitStore: createMockRateLimitStore(),
    })

    const result = await rateLimit('invites', {
      request: new Request('https://app.test/invites', {
        headers: {
          'x-forwarded-for': '203.0.113.11',
        },
      }),
    })

    expect(result.snapshot).toMatchObject({
      limiter: 'invites',
      key: `ip:${connectionAddress}`,
      attempts: 1,
      maxAttempts: 3,
      remainingAttempts: 2,
    })
  })

  it('prefers the configured runtime default key resolver for authenticated requests', async () => {
    const defaultKeyResolver = vi.fn(async () => 'user:42')

    configureSecurityRuntime({
      config: defineSecurityConfig({
        rateLimit: {
          limiters: {
            invites: limit.perHour(3).define(),
          },
        },
      }),
      rateLimitStore: createMockRateLimitStore(),
      defaultKeyResolver,
    })

    const request = new Request('https://app.test/invites')
    const result = await rateLimit('invites', { request })

    expect(result.snapshot.key).toBe('user:42')
    expect(defaultKeyResolver).toHaveBeenCalledWith(request)
  })

  it('accepts numeric default keys and rejects configured resolvers without requests', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        rateLimit: {
          limiters: {
            invites: limit.perHour(3).define(),
            login: limit.perMinute(2).by(({ request }) => ip(request)),
          },
        },
      }),
      rateLimitStore: createMockRateLimitStore(),
      defaultKeyResolver: async () => 42,
    })

    const result = await rateLimit('invites', {
      request: new Request('https://app.test/invites'),
    })
    expect(result.snapshot.key).toBe('42')

    await expect(rateLimit('login', {})).rejects.toThrow('requires a request when using its configured key resolver')
  })

  it('supports async limiter key resolvers that compose with the default helper', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        rateLimit: {
          limiters: {
            login: limit.perMinute(2).by(async ({ request, values }) => {
              const email = String(values?.email ?? 'guest').toLowerCase()
              return `${await defaultRateLimitKey(request)}:email:${email}`
            }),
          },
        },
      }),
      rateLimitStore: createMockRateLimitStore(),
      defaultKeyResolver: async () => 'user:7',
    })

    const result = await rateLimit('login', {
      request: new Request('https://app.test/login'),
      values: {
        email: 'Ava@Example.com',
      },
    })

    expect(result.snapshot.key).toBe('user:7:email:ava@example.com')
  })

  it('throws stable rate-limit metadata after the bucket exceeds its limit', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        trustedProxies: [connectionAddress],
        rateLimit: {
          limiters: {
            login: limit.perMinute(2).by(({ request }) => ip(request)),
          },
        },
      }),
      rateLimitStore: createMockRateLimitStore(),
    })

    const request = new Request('https://app.test/login', {
      headers: {
        'x-forwarded-for': '203.0.113.9',
      },
    })

    await rateLimit('login', { request })
    await rateLimit('login', { request })

    await expect(rateLimit('login', { request })).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 60,
      snapshot: {
        limiter: 'login',
        key: '203.0.113.9',
        attempts: 3,
        maxAttempts: 2,
        remainingAttempts: 0,
      },
    })
  })

  it('clears exact keys, namespaces, and all buckets', async () => {
    const store = createMockRateLimitStore()

    configureSecurityRuntime({
      config: defineSecurityConfig({
        rateLimit: {
          limiters: {
            login: limit.perMinute(3).define(),
            invites: limit.perMinute(3).define(),
          },
        },
      }),
      rateLimitStore: store,
    })

    await rateLimit('login', { key: 'team:42:user:1' })
    await rateLimit('login', { key: 'team:42:user:2' })
    await rateLimit('invites', { key: 'team:42:user:3' })

    await expect(clearRateLimit({
      limiter: 'login',
      key: 'team:42:user:1',
    })).resolves.toBe(true)

    await expect(clearRateLimit({
      limiter: 'login',
    })).resolves.toBe(1)

    await expect(clearRateLimit({
      all: true,
    })).resolves.toBe(1)
    await expect(clearRateLimit({
      all: true,
      limiter: 'login',
    })).rejects.toThrow('must use either { all: true } or a scoped limiter/key pair, not both')
  })

  it('rejects invalid limiter usage and missing runtime store wiring', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        rateLimit: {
          limiters: {
            login: limit.perMinute(2).by(() => ''),
          },
        },
      }),
    })

    await expect(rateLimit('login', {
      request: new Request('https://app.test/login'),
    })).rejects.toThrow('Rate limiter "login" must resolve a non-empty string key.')

    await expect(clearRateLimit({
      limiter: 'login',
    })).rejects.toThrow('Rate-limit store is not configured yet.')

    configureSecurityRuntime({
      config: defineSecurityConfig({
        rateLimit: {
          limiters: {
            invites: limit.perMinute(2).define(),
          },
        },
      }),
      rateLimitStore: createMockRateLimitStore(),
    })

    await expect(rateLimit('missing', {
      key: 'abc',
    })).rejects.toThrow('Rate limiter "missing" is not defined')

    await expect(rateLimit('invites', {})).rejects.toThrow('requires either an explicit key or a request for the default key resolver')

    await expect(clearRateLimit({
      key: 'abc',
    })).rejects.toThrow('requires a limiter name unless { all: true } is used')
  })
})
