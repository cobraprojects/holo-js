import { afterEach, describe, expect, it } from 'vitest'
import { configureSecurityRuntime, csrf, csrfInternals, defineSecurityConfig, resetSecurityRuntime, SecurityCsrfError } from '../src'
import { memoryCsrfSessions } from './support/csrf-session'

const sessionToken = 'session-token'

afterEach(() => {
  resetSecurityRuntime()
})

function configure(appKey?: string): void {
  configureSecurityRuntime({
    config: defineSecurityConfig({ csrf: { enabled: true } }),
    csrfSession: memoryCsrfSessions({ 'browser-a': sessionToken }),
    ...(appKey ? { csrfSigningKey: appKey } : {}),
  })
}

function cookieValue(setCookie: string): string {
  return decodeURIComponent(setCookie.split(';', 1)[0]!.slice('XSRF-TOKEN='.length))
}

function page(): Request {
  return new Request('https://app.test/profile', { headers: { cookie: 'browser=browser-a' } })
}

function post(options: {
  readonly browser?: string
  readonly cookie?: string
  readonly header?: string
  readonly xsrfHeader?: string
  readonly field?: string
} = {}): Request {
  const cookies = [
    ...(options.browser === '' ? [] : [`browser=${options.browser ?? 'browser-a'}`]),
    ...(options.cookie ? [`XSRF-TOKEN=${encodeURIComponent(options.cookie)}`] : []),
  ]
  return new Request('https://app.test/profile', {
    method: 'POST',
    headers: {
      cookie: cookies.join('; '),
      ...(options.header ? { 'X-CSRF-TOKEN': options.header } : {}),
      ...(options.xsrfHeader ? { 'X-XSRF-TOKEN': options.xsrfHeader } : {}),
    },
    ...(options.field ? { body: new URLSearchParams({ _token: options.field }) } : {}),
  })
}

describe('encrypted XSRF-TOKEN cookie', () => {
  it('stores the session CSRF token encrypted and accepts it back on the next request', async () => {
    configure('csrf-cookie-encryption-key')
    const encrypted = cookieValue(await csrf.cookie(page()))

    expect(encrypted).not.toContain(sessionToken)
    expect(csrfInternals.decryptCsrfToken(encrypted)).toBe(sessionToken)
    await expect(csrf.verify(post({ cookie: encrypted, xsrfHeader: encrypted }))).resolves.toBeUndefined()
  })

  it('accepts the plain token from forms and the encrypted cookie value from JavaScript clients', async () => {
    configure('csrf-cookie-encryption-key')
    const encrypted = cookieValue(await csrf.cookie(page()))

    await expect(csrf.verify(post({ cookie: encrypted, field: sessionToken }))).resolves.toBeUndefined()
    await expect(csrf.verify(post({ cookie: encrypted, field: encrypted }))).resolves.toBeUndefined()
    await expect(csrf.verify(post({ cookie: encrypted, header: sessionToken }))).resolves.toBeUndefined()
    await expect(csrf.verify(post({ cookie: encrypted, header: encrypted }))).resolves.toBeUndefined()
    await expect(csrf.verify(post({ cookie: encrypted, xsrfHeader: encrypted }))).resolves.toBeUndefined()
  })

  it('rejects tampered, plaintext, and foreign-key cookies', async () => {
    configure('csrf-cookie-encryption-key')
    const encrypted = cookieValue(await csrf.cookie(page()))
    const tampered = `${encrypted.slice(0, -2)}xx`

    await expect(csrf.verify(post({ cookie: tampered, xsrfHeader: tampered }))).rejects.toBeInstanceOf(SecurityCsrfError)
    await expect(csrf.verify(post({ cookie: tampered, field: tampered }))).rejects.toBeInstanceOf(SecurityCsrfError)
    await expect(csrf.verify(post({ cookie: sessionToken, xsrfHeader: sessionToken }))).rejects.toBeInstanceOf(SecurityCsrfError)
    await expect(csrf.verify(post({ cookie: encrypted, field: `${sessionToken}x` }))).rejects.toBeInstanceOf(SecurityCsrfError)
    await expect(csrf.verify(post({ browser: '', cookie: encrypted, xsrfHeader: encrypted }))).rejects.toBeInstanceOf(SecurityCsrfError)

    configure('another-application-key')
    await expect(csrf.verify(post({ cookie: encrypted, xsrfHeader: encrypted }))).rejects.toBeInstanceOf(SecurityCsrfError)
    await expect(csrf.verify(post({ cookie: encrypted, field: encrypted }))).rejects.toBeInstanceOf(SecurityCsrfError)
    await expect(csrf.verify(post({ cookie: encrypted, header: encrypted }))).rejects.toBeInstanceOf(SecurityCsrfError)
  })

  it('refuses to issue the CSRF cookie without the application key', async () => {
    configure()

    await expect(csrf.cookie(page())).rejects.toThrow('APP_KEY')
  })
})
