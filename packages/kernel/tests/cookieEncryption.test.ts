import { describe, expect, it } from 'vitest'
import { decryptCookieValue, encryptCookieValue } from '../src/index'

const appKey = 'base64-application-key-for-cookie-tests'

const base64UrlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function flipCiphertextBit(value: string): string {
  const payload = Buffer.from(value, 'base64url')
  payload[payload.length - 1] = payload[payload.length - 1]! ^ 1
  return payload.toString('base64url')
}

function changeUnusedFinalBits(value: string): string {
  const index = base64UrlAlphabet.indexOf(value.at(-1)!)
  return `${value.slice(0, -1)}${base64UrlAlphabet[index ^ 1]}`
}

describe('Holo-owned cookie encryption', () => {
  it('round-trips a value bound to its cookie name without exposing the plaintext', () => {
    const encrypted = encryptCookieValue('holo_session', 'session-id', appKey)

    expect(encrypted).not.toContain('session-id')
    expect(encrypted).toMatch(/^[\w-]+$/)
    expect(encryptCookieValue('holo_session', 'session-id', appKey)).not.toBe(encrypted)
    expect(decryptCookieValue('holo_session', encrypted, appKey)).toBe('session-id')
  })

  it('accepts only the canonical base64url encoding of a cookie value', () => {
    const encrypted = encryptCookieValue('holo_session', 'session-id', appKey)
    const nonCanonical = changeUnusedFinalBits(encrypted)

    expect(nonCanonical).not.toBe(encrypted)
    expect(Buffer.from(nonCanonical, 'base64url')).toEqual(Buffer.from(encrypted, 'base64url'))
    expect(decryptCookieValue('holo_session', nonCanonical, appKey)).toBeUndefined()
    expect(decryptCookieValue('holo_session', `${encrypted}=`, appKey)).toBeUndefined()
    expect(decryptCookieValue('holo_session', `${encrypted}!`, appKey)).toBeUndefined()
    expect(decryptCookieValue('holo_session', encrypted, appKey)).toBe('session-id')
  })

  it('rejects tampered values, other cookie names, other keys, and plaintext', () => {
    const encrypted = encryptCookieValue('holo_session', 'session-id', appKey)

    expect(decryptCookieValue('holo_session', flipCiphertextBit(encrypted), appKey)).toBeUndefined()
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
