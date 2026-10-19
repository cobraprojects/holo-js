import { describe, expect, it } from 'vitest'
import { decryptCookieValue, encryptCookieValue } from '../src/index'

const appKey = 'base64-application-key-for-cookie-tests'

function tamperPayload(value: string): string {
  const payload = Buffer.from(value, 'base64url')
  payload[payload.length - 1] = payload[payload.length - 1]! ^ 1
  return payload.toString('base64url')
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

    expect(decryptCookieValue('holo_session', tamperPayload(encrypted), appKey)).toBeUndefined()
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
