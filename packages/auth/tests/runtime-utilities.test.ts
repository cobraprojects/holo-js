import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authJwtInternals } from '../src/runtime/jwt'
import { authClientInternals } from '../src/client-runtime'
import { AuthError, isAuthError } from '../src/contracts'
import { loadOptionalSecurityModule, optionalSecurityInternals } from '../src/runtime/optionalSecurity'
import {
  appendResponseCookies,
  AuthResponseInterrupt,
  isAuthResponseInterrupt,
  parseBearerToken,
  redirectResponse,
  resolveRequestCookie,
  resolveRequestHeader,
} from '../src/runtime/requestAccess'
import { normalizeRequestInput } from '../src/runtime/requestNormalization'
import { buildLogoutCookies, forgetDefaultRememberCookie } from '../src/runtime/responseCookies'
import { createScryptPasswordHasher, scryptPasswordHasherInternals } from '../src/runtime/scryptPasswordHasher'
import { createEmailVerificationConsumeFailure } from '../src/runtime/lifecycleFailures'
import { createPasswordConfirmationMismatchFailure } from '../src/runtime/failureFields'
import {
  readSessionPayload,
  readSessionPayloads,
  resolveSessionPayloadProvider,
  toSessionPayload,
  writeSessionPayloads,
} from '../src/runtime/sessionPayloads'
import { parseSetCookieDefinition } from '../src/runtime/setCookieParser'

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function createToken(payload: Readonly<Record<string, unknown>>, algorithm = 'RS256'): string {
  return `${encode({ alg: algorithm })}.${encode(payload)}.signature`
}

afterEach(() => {
  optionalSecurityInternals.resetImporter()
  scryptPasswordHasherInternals.resetScrypt()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('auth runtime utilities', () => {
  it('normalizes every supported request input and header shape', () => {
    const request = new Request('https://app.test/direct')
    expect(normalizeRequestInput(request)).toBe(request)
    expect(normalizeRequestInput({ request })).toBe(request)
    expect(normalizeRequestInput({ web: { request } })).toBe(request)
    expect(normalizeRequestInput({ req: request })).toBe(request)

    const tuples = normalizeRequestInput({
      method: 'POST',
      url: '/tuples',
      headers: [['host', 'app.test'], ['authorization', 'Bearer token']],
    })
    expect(tuples.url).toBe('http://app.test/tuples')
    expect(tuples.method).toBe('POST')
    expect(tuples.headers.get('authorization')).toBe('Bearer token')

    const forEachHeaders = {
      forEach(callback: (value: string, key: string) => void) {
        callback('app.test', 'host')
        callback('value', 'x-custom')
      },
    }
    expect(normalizeRequestInput({ path: '/foreach', headers: forEachHeaders }).headers.get('x-custom')).toBe('value')

    const entriesHeaders = {
      entries: () => [['host', 'app.test'], ['x-entry', 'value']] as const,
    }
    expect(normalizeRequestInput({ path: '/entries', headers: entriesHeaders }).headers.get('x-entry')).toBe('value')

    const getHeaders = {
      get(name: string) {
        return name === 'host' ? 'app.test' : name === 'cookie' ? 'one=1' : null
      },
    }
    expect(normalizeRequestInput({ path: '/get', headers: getHeaders }).headers.get('cookie')).toBe('one=1')

    const record = normalizeRequestInput({
      path: '/record',
      headers: {
        host: 'app.test',
        cookie: ['one=1', 'two=2'],
        'x-values': ['one', 'two'],
        ignored: undefined,
      },
    })
    expect(record.headers.get('cookie')).toBe('one=1; two=2')
    expect(record.headers.get('x-values')).toBe('one,two')

    const nestedReq = normalizeRequestInput({
      req: { method: 'PATCH', url: '/nested', headers: { host: 'app.test' } },
    })
    expect(nestedReq.method).toBe('PATCH')
    expect(nestedReq.url).toBe('http://app.test/nested')

    const nodeReq = normalizeRequestInput({
      node: { req: { method: 'DELETE', url: '/node', headers: { host: 'app.test' } } },
    })
    expect(nodeReq.method).toBe('DELETE')
    expect(nodeReq.url).toBe('http://app.test/node')

    const forwarded = normalizeRequestInput({
      url: new URL('https://absolute.test/value'),
      headers: { host: 'ignored.test' },
    })
    expect(forwarded.url).toBe('https://absolute.test/value')

    const customBase = normalizeRequestInput({ path: '/custom' }, {
      createRelativeRequestBaseUrl: () => 'https://custom.test',
    })
    expect(customBase.url).toBe('https://custom.test/custom')

    const defaults = normalizeRequestInput({})
    expect(defaults.url).toBe('http://localhost/')
    expect(defaults.method).toBe('GET')
  })

  it('only reconstructs relative request URLs from trusted proxy headers', () => {
    vi.stubGlobal('process', undefined)
    expect(normalizeRequestInput({ path: '/serverless' }).url).toBe('http://localhost/serverless')
    vi.unstubAllGlobals()

    vi.stubEnv('HOLO_SECURITY_TRUST_PROXY', '')
    const direct = normalizeRequestInput({
      path: '/auth',
      headers: {
        host: 'app.test',
        'x-forwarded-host': 'attacker.test',
        'x-forwarded-proto': 'https',
      },
    })
    expect(direct.url).toBe('http://app.test/auth')

    vi.stubEnv('HOLO_SECURITY_TRUST_PROXY', 'true')
    const proxied = normalizeRequestInput({
      path: '/auth',
      headers: {
        host: 'internal.test',
        'x-forwarded-host': 'app.test',
        'x-forwarded-proto': 'https',
      },
    })
    expect(proxied.url).toBe('https://app.test/auth')
    expect(() => normalizeRequestInput({
      path: '/auth',
      headers: {
        host: 'internal.test',
        'x-forwarded-proto': 'javascript',
      },
    })).toThrow('protocols must be http or https')
  })

  it('parses, validates, verifies, caches, refreshes, and retries JWT data', async () => {
    const options = { errorPrefix: 'Token', malformedMessage: 'Malformed token' }
    const token = createToken({ sub: ' user ' })
    expect(authJwtInternals.parseJwt(token, options).payload.sub).toBe(' user ')
    expect(authJwtInternals.getJwtStringClaim(token, 'sub', options)).toBe(' user ')
    expect(authJwtInternals.getJwtStringClaim(token, 'missing', options)).toBeUndefined()
    expect(authJwtInternals.getJwtStringClaim('invalid', 'sub', options)).toBeUndefined()
    expect(() => authJwtInternals.parseJwt('invalid', options)).toThrow('Malformed token')
    expect(() => authJwtInternals.parseJwt(`${Buffer.from('bad').toString('base64url')}.${encode({})}.x`, options)).toThrow('header')

    const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const publicKey = keyPair.publicKey.export({ format: 'jwk' })
    for (const [algorithm, signer] of [
      ['RS256', 'RSA-SHA256'],
      ['RS384', 'RSA-SHA384'],
      ['RS512', 'RSA-SHA512'],
    ] as const) {
      const header = encode({ alg: algorithm })
      const payload = encode({ sub: 'user' })
      const signingInput = `${header}.${payload}`
      const signature = sign(signer, Buffer.from(signingInput), keyPair.privateKey).toString('base64url')
      const parsed = authJwtInternals.parseJwt(`${signingInput}.${signature}`, options)
      expect(authJwtInternals.verifyJwtSignatureWithJwk(parsed, publicKey, {
        unsupportedAlgorithmMessage: value => `Unsupported ${value}`,
      })).toBe(true)
    }
    const unsupported = authJwtInternals.parseJwt(createToken({}, 'none'), options)
    expect(() => authJwtInternals.verifyJwtSignatureWithJwk(unsupported, publicKey, {
      unsupportedAlgorithmMessage: value => `Unsupported ${value}`,
    })).toThrow('Unsupported none')
    const unknown = authJwtInternals.parseJwt(`${encode({})}.${encode({})}.signature`, options)
    expect(() => authJwtInternals.verifyJwtSignatureWithJwk(unknown, publicKey, {
      unsupportedAlgorithmMessage: value => `Unsupported ${value}`,
    })).toThrow('Unsupported unknown')

    const cache = new Map()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [{ kid: 'one' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ keys: [{ kid: 'retry' }] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const fetchOptions = { cache, requestUrl: 'https://keys.test/jwks', errorMessage: 'JWKS failed' }
    await expect(authJwtInternals.fetchCachedJwks('key', fetchOptions)).resolves.toEqual([{ kid: 'one' }])
    await expect(authJwtInternals.fetchCachedJwks('key', fetchOptions)).resolves.toEqual([{ kid: 'one' }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(authJwtInternals.fetchCachedJwks('key', { ...fetchOptions, refresh: true })).resolves.toEqual([])
    await expect(authJwtInternals.fetchCachedJwks('failure', fetchOptions)).rejects.toThrow('JWKS failed')
    await expect(authJwtInternals.fetchCachedJwks('failure', fetchOptions)).resolves.toEqual([{ kid: 'retry' }])
  })

  it('recognizes response interrupts and delegates request response access', async () => {
    expect(isAuthResponseInterrupt(null)).toBe(false)
    expect(isAuthResponseInterrupt(new AuthResponseInterrupt())).toBe(true)
    expect(isAuthResponseInterrupt({ digest: 'NEXT_REDIRECT;replace;/login' })).toBe(true)
    expect(isAuthResponseInterrupt({ status: 302, location: '/login' })).toBe(true)
    expect(isAuthResponseInterrupt({ status: 200, location: '/login' })).toBe(false)

    const cookies: string[] = []
    const redirects: Array<[string, number | undefined]> = []
    const bindings: Parameters<typeof resolveRequestCookie>[0] = {
      context: {
        getRequestCookie: (name: string) => name === 'session' ? 'cookie-value' : undefined,
        getRequestHeader: (name: string) => name === 'authorization' ? 'Bearer token' : '',
        appendResponseCookie: (cookie: string) => { cookies.push(cookie) },
        redirectResponse: (url: string, status?: number) => { redirects.push([url, status]) },
      },
    }
    await expect(resolveRequestCookie(bindings, 'session')).resolves.toBe('cookie-value')
    await expect(resolveRequestHeader(bindings, 'authorization')).resolves.toBe('Bearer token')
    await expect(resolveRequestHeader(bindings, 'missing')).resolves.toBeUndefined()
    await appendResponseCookies(bindings, ['one=1', 'two=2'])
    expect(cookies).toEqual(['one=1', 'two=2'])
    await expect(redirectResponse(bindings, '/login', 303)).rejects.toBeInstanceOf(AuthResponseInterrupt)
    expect(redirects).toEqual([['/login', 303]])
    await expect(redirectResponse({ context: {} }, '/login')).rejects.toThrow('cannot redirect')
    await expect(appendResponseCookies({ context: {} }, ['ignored=1'])).resolves.toBeUndefined()

    expect(parseBearerToken('Bearer token')).toBe('token')
    expect(parseBearerToken('bearer   spaced ')).toBe('spaced')
    expect(parseBearerToken('Basic token')).toBeUndefined()
    expect(parseBearerToken(undefined)).toBeUndefined()
    const noHeaderProtocol = Object.create(null) as { readonly get?: undefined }
    expect([...normalizeRequestInput({ headers: noHeaderProtocol }).headers]).toHaveLength(0)
    expect(normalizeRequestInput({ headers: { host: 'app.test', 'x-empty': [] } }).headers.has('x-empty')).toBe(false)
  })

  it('serializes client cache headers and recognizes structural auth errors', () => {
    expect(authClientInternals.serializeHeadersForCache({
      'x-z': 'last',
      'x-a': 'first',
    })).toBe('x-a:first\nx-z:last')
    const cause = new Error('cause')
    const error = new AuthError('invalid_credentials', 'Invalid', { cause, details: { email: true } })
    expect(error.cause).toBe(cause)
    expect(isAuthError(error)).toBe(true)
    expect(isAuthError({ name: 'AuthError', code: 'invalid_credentials', message: 'Invalid' })).toBe(true)
    expect(isAuthError({ name: 'AuthError', code: 'invalid', message: 'Invalid' })).toBe(false)
    expect(isAuthError(null)).toBe(false)
  })

  it('loads the optional security package when installed', async () => {
    await expect(loadOptionalSecurityModule()).resolves.toMatchObject({
      getSecurityRuntimeBindings: expect.any(Function),
    })
  })

  it('distinguishes missing optional security packages from runtime failures', async () => {
    const missingVariants = [
      Object.assign(new Error("Cannot find package '@holo-js/security'"), { code: 'ERR_MODULE_NOT_FOUND' }),
      Object.assign(new Error("Cannot find module '@holo-js/security'"), { code: 'MODULE_NOT_FOUND' }),
      new Error("Failed to resolve module specifier '@holo-js/security'"),
      new Error("Could not resolve '@holo-js/security'"),
      new Error('Failed to load url @holo-js/security/runtime'),
    ]
    for (const error of missingVariants) {
      expect(optionalSecurityInternals.isMissingOptionalPackageError(error)).toBe(true)
      optionalSecurityInternals.setImporter(async () => { throw error })
      await expect(loadOptionalSecurityModule()).resolves.toBeUndefined()
    }
    expect(optionalSecurityInternals.isMissingOptionalPackageError('missing')).toBe(false)
    expect(optionalSecurityInternals.isMissingOptionalPackageError(new Error('application failure'))).toBe(false)
    optionalSecurityInternals.setImporter(async () => { throw new Error('application failure') })
    await expect(loadOptionalSecurityModule()).rejects.toThrow('application failure')
  })

  it('builds logout cookies across hosted providers and serialization fallbacks', () => {
    const bindings: Parameters<typeof buildLogoutCookies>[0] = {
      config: {
        defaults: { guard: 'web' },
        workos: {
          provider: 'dashboard',
          dashboard: { name: 'dashboard', guard: 'web', sessionCookie: 'workos_session' },
          admin: { name: 'admin', guard: 'admin', sessionCookie: 'workos_admin' },
        },
        clerk: {
          provider: 'app',
          app: { name: 'app', guard: 'web', sessionCookie: 'clerk_session', authorizedParties: [] },
          duplicate: { name: 'duplicate', guard: 'web', sessionCookie: 'clerk_session', authorizedParties: [] },
        },
      },
      session: {
        sessionCookie: () => 'holo_session=; Path=/; HttpOnly',
        rememberMeCookie: () => 'holo_remember=; Path=/; SameSite=Lax',
      },
    }
    const cookies = buildLogoutCookies(bindings, 'web', { clearSessionCookies: true })
    expect(cookies).toHaveLength(4)
    expect(cookies).toContainEqual(expect.stringContaining('workos_session='))
    expect(cookies).toContainEqual(expect.stringContaining('clerk_session='))
    expect(forgetDefaultRememberCookie(bindings)).toContain('holo_remember=')

    const invalid = {
      ...bindings,
      session: {
        sessionCookie: () => 'invalid',
        rememberMeCookie: () => 'invalid',
      },
    }
    expect(buildLogoutCookies(invalid, 'web', { clearSessionCookies: true })).toHaveLength(2)
    expect(forgetDefaultRememberCookie(invalid)).toBeUndefined()
  })

  it('parses cookie definitions and session payload edge cases', () => {
    expect(parseSetCookieDefinition('')).toBeNull()
    expect(parseSetCookieDefinition('%E0%A4%A=value')).toBeNull()
    expect(parseSetCookieDefinition('session=value; ; SameSite=invalid; Unknown=value')).toEqual({
      name: 'session',
      options: {},
    })
    expect(parseSetCookieDefinition('session=value; Path=/; Domain=app.test; Secure; HttpOnly; SameSite=None; Partitioned')).toEqual({
      name: 'session',
      options: {
        domain: 'app.test',
        httpOnly: true,
        partitioned: true,
        path: '/',
        sameSite: 'none',
        secure: true,
      },
    })

    const user = { id: 1, can: async () => false }
    const payload = toSessionPayload('web', 'users', user)
    const record = {
      id: 'session',
      store: 'database',
      data: { auth: payload },
      createdAt: new Date(),
      lastActivityAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
    }
    expect(readSessionPayload(record)).toBe(payload)
    expect(readSessionPayload(record, 'missing')).toBeNull()
    expect(readSessionPayloads({ ...record, data: { auth: { invalid: true } } })).toBeNull()
    expect(readSessionPayloads({ ...record, data: { auth: { web: payload, invalid: true } } })).toEqual({ web: payload })
    expect(writeSessionPayloads({ auth: payload, preserved: true }, {})).toEqual({ preserved: true })
    expect(resolveSessionPayloadProvider({ ...payload, provider: 'workos' })).toBe('workos')
    expect(resolveSessionPayloadProvider({ ...payload, provider: 'clerk' })).toBe('clerk')
    const workosPayload = { ...payload, workos: {} }
    const clerkPayload = { ...payload, clerk: {} }
    const nonObjectWorkosPayload = { ...payload, workos: 'external', clerk: {} }
    expect(resolveSessionPayloadProvider(workosPayload)).toBe('workos')
    expect(resolveSessionPayloadProvider(clerkPayload)).toBe('clerk')
    expect(resolveSessionPayloadProvider(nonObjectWorkosPayload)).toBe('clerk')
    expect(resolveSessionPayloadProvider(payload)).toBe('users')
  })

  it('hashes, verifies, and rejects malformed scrypt digests', async () => {
    const hasher = createScryptPasswordHasher()
    const digest = await hasher.hash('password')
    await expect(hasher.verify('password', digest)).resolves.toBe(true)
    await expect(hasher.verify('wrong', digest)).resolves.toBe(false)
    for (const invalid of [
      '',
      'other$00$00',
      'scrypt$bad$00',
      'scrypt$N=x,r=8,p=1$00$00',
      'scrypt$N=0,r=8,p=1$00$00',
      'scrypt$N=9007199254740992,r=8,p=1$00$00',
    ]) {
      await expect(hasher.verify('password', invalid)).resolves.toBe(false)
      expect(hasher.needsRehash?.(invalid)).toBe(true)
    }
    expect(hasher.needsRehash?.(digest)).toBe(false)
    expect(hasher.needsRehash?.(digest.replace('N=16384,r=8,p=1', 'x=1,N=16384,r=8,p=1'))).toBe(false)

    const invalidParams = Object.assign(new Error('invalid params'), { code: 'ERR_CRYPTO_INVALID_SCRYPT_PARAMS' })
    scryptPasswordHasherInternals.setScrypt((_password, _salt, _length, _options, callback) => {
      callback(invalidParams, Buffer.alloc(0))
    })
    await expect(hasher.verify('password', digest)).resolves.toBe(false)
    scryptPasswordHasherInternals.setScrypt((_password, _salt, _length, _options, callback) => {
      callback(new Error('scrypt failure'), Buffer.alloc(0))
    })
    await expect(hasher.verify('password', digest)).rejects.toThrow('scrypt failure')
  })

  it('maps missing users during email-verification consumption', () => {
    expect(createEmailVerificationConsumeFailure(
      new AuthError('auth_user_missing', 'User missing'),
    )).toMatchObject({ code: 'auth_user_missing', status: 422 })
    expect(createPasswordConfirmationMismatchFailure(
      'password_confirmation_mismatch',
      'Passwords differ',
      {},
    )).toMatchObject({ fields: {} })
  })
})
