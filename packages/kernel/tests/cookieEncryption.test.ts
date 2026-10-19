import { describe, expect, it } from 'vitest'
import { decryptCookieValue, encryptCookieValue } from '../src/index'

const appKey = 'base64-application-key-for-cookie-tests'

function flipLastCharacter(value: string): string {
  return `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`
}

describe('Holo-owned cookie encryption', () => {
  it('round-trips a value bound to its cookie name without exposing the plaintext', () => {
    const encrypted = encryptCookieValue('holo_session', 'session-id', appKey)

    expect(encrypted).not.toContain('session-id')
    expect(encrypted).toMatch(/^[\w-]+$/)
    expect(encryptCookieValue('holo_session', 'session-id', appKey)).not.toBe(encrypted)
    expect(decryptCookieValue('holo_session', encrypted, appKey)).toBe('session-id')
  })

  it('rejects tampered values, other cookie names, other keys, and plaintext', () => {
    const encrypted = encryptCookieValue('holo_session', 'session-id', appKey)

    expect(decryptCookieValue('holo_session', flipLastCharacter(encrypted), appKey)).toBeUndefined()
    expect(decryptCookieValue('holo_session_remember', encrypted, appKey)).toBeUndefined()
    expect(decryptCookieValue('holo_session', encrypted, 'another-application-key')).toBeUndefined()
    expect(decryptCookieValue('holo_session', 'session-id', appKey)).toBeUndefined()
    expect(decryptCookieValue('holo_session', '', appKey)).toBeUndefined()
    expect(decryptCookieValue('holo_session', '%%%', appKey)).toBeUndefined()
  })

  it('requires the application key', () => {
    expect(() => encryptCookieValue('holo_session', 'session-id', undefined)).toThrow('APP_KEY')
    expect(() => encryptCookieValue('holo_session', 'session-id', '  ')).toThrow('APP_KEY')
    expect(() => decryptCookieValue('holo_session', 'value', undefined)).toThrow('APP_KEY')
  })
})
