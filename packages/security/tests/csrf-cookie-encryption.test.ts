import { afterEach, describe, expect, it } from 'vitest'
import { configureSecurityRuntime, csrf, defineSecurityConfig, resetSecurityRuntime, SecurityCsrfError } from '../src'

afterEach(() => {
  resetSecurityRuntime()
})

function configure(appKey = 'csrf-cookie-encryption-key'): void {
  configureSecurityRuntime({ config: defineSecurityConfig({ csrf: { enabled: true } }), csrfSigningKey: appKey })
}

function cookieValue(setCookie: string): string {
  return decodeURIComponent(setCookie.split(';', 1)[0]!.slice('XSRF-TOKEN='.length))
}

function post(cookie: string, options: { readonly header?: string, readonly field?: string } = {}): Request {
  return new Request('https://app.test/profile', {
    method: 'POST',
    headers: {
      cookie: `XSRF-TOKEN=${cookie}`,
      ...(options.header ? { 'X-CSRF-TOKEN': options.header } : {}),
    },
    ...(options.field ? { body: new URLSearchParams({ _token: options.field }) } : {}),
  })
}

describe('encrypted XSRF-TOKEN cookie', () => {
  it('stores the CSRF token encrypted and reads it back on the next request', async () => {
    configure()
    const token = await csrf.token(new Request('https://app.test/profile'))
    const encrypted = cookieValue(await csrf.cookie(new Request('https://app.test/profile'), token))

    expect(encrypted).not.toContain(token)
    await expect(csrf.token(new Request('https://app.test/profile', { headers: { cookie: `XSRF-TOKEN=${encrypted}` } }))).resolves.toBe(token)
  })

  it('accepts the plain token from forms and the encrypted cookie value from JavaScript clients', async () => {
    configure()
    const token = await csrf.token(new Request('https://app.test/profile'))
    const encrypted = cookieValue(await csrf.cookie(new Request('https://app.test/profile'), token))

    await expect(csrf.verify(post(encrypted, { field: token }))).resolves.toBeUndefined()
    await expect(csrf.verify(post(encrypted, { field: encrypted }))).resolves.toBeUndefined()
    await expect(csrf.verify(post(encrypted, { header: token }))).resolves.toBeUndefined()
    await expect(csrf.verify(post(encrypted, { header: encrypted }))).resolves.toBeUndefined()
  })

  it('rejects tampered, plaintext, and foreign-key cookies', async () => {
    configure()
    const token = await csrf.token(new Request('https://app.test/profile'))
    const encrypted = cookieValue(await csrf.cookie(new Request('https://app.test/profile'), token))
    const tampered = `${encrypted.slice(0, -2)}xx`

    await expect(csrf.verify(post(tampered, { field: token }))).rejects.toBeInstanceOf(SecurityCsrfError)
    await expect(csrf.verify(post(token, { field: token }))).rejects.toBeInstanceOf(SecurityCsrfError)
    await expect(csrf.verify(post(encrypted, { field: `${token}x` }))).rejects.toBeInstanceOf(SecurityCsrfError)

    configure('another-application-key')
    await expect(csrf.verify(post(encrypted, { field: token }))).rejects.toBeInstanceOf(SecurityCsrfError)
    await expect(csrf.token(new Request('https://app.test/profile', { headers: { cookie: `XSRF-TOKEN=${encrypted}` } }))).resolves.not.toBe(token)
  })

  it('refuses to issue the CSRF cookie without the application key', async () => {
    configureSecurityRuntime({ config: defineSecurityConfig({ csrf: { enabled: true } }) })

    await expect(csrf.cookie(new Request('https://app.test/profile'))).rejects.toThrow('APP_KEY')
  })
})
