import { afterEach, describe, expect, it } from 'vitest'
import {
  configureSessionRuntime,
  cookie,
  cookies,
  getSessionRuntime,
  normalizeSessionConfig,
  parseCookieHeader,
  rememberMeCookie,
  resetSessionRuntime,
  sessionCookie,
} from '../src'

afterEach(() => {
  resetSessionRuntime()
})

function configure(appKey?: string): void {
  configureSessionRuntime({
    config: normalizeSessionConfig({ driver: 'file', stores: { file: { driver: 'file', path: './storage/sessions' } } }),
    stores: {},
    ...(appKey ? { appKey } : {}),
  })
}

function cookieValue(setCookie: string, name: string): string {
  const value = parseCookieHeader(setCookie.split(';', 1)[0])[name]
  if (typeof value !== 'string') throw new Error(`Expected a ${name} cookie.`)
  return value
}

describe('Holo-owned session cookies', () => {
  it('encrypts the session and remember cookies so only the runtime can read them back', () => {
    configure('session-cookie-test-key')
    const runtime = getSessionRuntime()

    const sessionValue = cookieValue(sessionCookie('session-id'), 'holo_session')
    const rememberValue = cookieValue(rememberMeCookie('session-id|remember-secret'), 'holo_session_remember')

    expect(sessionValue).not.toContain('session-id')
    expect(rememberValue).not.toContain('remember-secret')
    expect(runtime.decryptCookie('holo_session', sessionValue)).toBe('session-id')
    expect(runtime.decryptCookie('holo_session_remember', rememberValue)).toBe('session-id|remember-secret')
    expect(cookieValue(runtime.sessionCookie('session-id'), 'holo_session')).not.toBe('session-id')
  })

  it('rejects tampered, swapped, and plaintext cookie values', () => {
    configure('session-cookie-test-key')
    const runtime = getSessionRuntime()
    const sessionValue = cookieValue(sessionCookie('session-id'), 'holo_session')

    expect(runtime.decryptCookie('holo_session', `${sessionValue.slice(0, -2)}xx`)).toBeUndefined()
    expect(runtime.decryptCookie('holo_session_remember', sessionValue)).toBeUndefined()
    expect(runtime.decryptCookie('holo_session', 'session-id')).toBeUndefined()

    configure('rotated-application-key')
    expect(getSessionRuntime().decryptCookie('holo_session', sessionValue)).toBeUndefined()
  })

  it('leaves application cookies and cookie removal untouched', () => {
    configure('session-cookie-test-key')

    expect(cookie('theme', 'dark')).toContain('theme=dark')
    expect(cookies.make('theme', 'dark')).toContain('theme=dark')
    expect(sessionCookie('')).toContain('holo_session=;')
    expect(rememberMeCookie('', { maxAge: 0 })).toContain('holo_session_remember=;')
  })

  it('refuses to write or read Holo cookies without the application key', () => {
    configure()

    expect(() => sessionCookie('session-id')).toThrow('APP_KEY')
    expect(() => rememberMeCookie('remember-token')).toThrow('APP_KEY')
    expect(() => getSessionRuntime().decryptCookie('holo_session', 'value')).toThrow('APP_KEY')
  })
})
