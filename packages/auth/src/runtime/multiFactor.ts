import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { hashTokenSecret } from './secrets'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const TOTP_PERIOD_SECONDS = 30
const TOTP_DIGITS = 6

function encryptionKey(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

export function encryptMultiFactorValue(value: string, key: string): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(key), nonce)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [nonce, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.')
}

export function decryptMultiFactorValue(value: string, key: string): string {
  const parts = value.split('.')
  if (parts.length !== 3) throw new Error('Invalid encrypted multi-factor value.')
  const nonce = Buffer.from(parts[0]!, 'base64url')
  const tag = Buffer.from(parts[1]!, 'base64url')
  const encrypted = Buffer.from(parts[2]!, 'base64url')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(key), nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

function encodeBase32(value: Uint8Array): string {
  let bits = 0
  let buffer = 0
  let encoded = ''
  for (const byte of value) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      encoded += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) encoded += BASE32_ALPHABET[(buffer << (5 - bits)) & 31]
  return encoded
}

function decodeBase32(value: string): Buffer {
  let bits = 0
  let buffer = 0
  const decoded: number[] = []
  for (const character of value.toUpperCase().replaceAll('=', '')) {
    const index = BASE32_ALPHABET.indexOf(character)
    if (index < 0) throw new Error('Invalid multi-factor secret.')
    buffer = (buffer << 5) | index
    bits += 5
    if (bits >= 8) {
      decoded.push((buffer >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(decoded)
}

function counterBuffer(counter: number): Buffer {
  const value = Buffer.alloc(8)
  value.writeBigUInt64BE(BigInt(counter))
  return value
}

function totpAtCounter(secret: string, counter: number): string {
  const digest = createHmac('sha1', decodeBase32(secret)).update(counterBuffer(counter)).digest()
  const offset = digest[digest.length - 1]! & 15
  const binary = ((digest[offset]! & 127) << 24)
    | (digest[offset + 1]! << 16)
    | (digest[offset + 2]! << 8)
    | digest[offset + 3]!
  return String(binary % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0')
}

function codesEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export function matchingTotpCounters(
  secret: string,
  code: string,
  allowedDriftSteps: number,
  now = Date.now(),
): readonly number[] {
  if (!/^\d{6}$/u.test(code)) return Object.freeze([])
  const currentCounter = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS)
  const counters: number[] = []
  for (let drift = -allowedDriftSteps; drift <= allowedDriftSteps; drift += 1) {
    const counter = currentCounter + drift
    if (counter >= 0 && codesEqual(totpAtCounter(secret, counter), code)) counters.push(counter)
  }
  return Object.freeze(counters.sort((left, right) => right - left))
}

export function createMultiFactorSecret(): string {
  return encodeBase32(randomBytes(20))
}

export function createMultiFactorRecoveryCodes(count: number): readonly string[] {
  return Object.freeze(Array.from({ length: count }, () => {
    const value = randomBytes(10).toString('hex').toUpperCase()
    return `${value.slice(0, 5)}-${value.slice(5, 10)}-${value.slice(10, 15)}-${value.slice(15)}`
  }))
}

export function hashMultiFactorRecoveryCode(code: string): string {
  return hashTokenSecret(code.trim().toUpperCase())
}

export function multiFactorOtpAuthUri(issuer: string, account: string, secret: string): string {
  const label = `${issuer}:${account}`
  const query = new URLSearchParams({ issuer, secret, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SECONDS) })
  return `otpauth://totp/${encodeURIComponent(label)}?${query.toString()}`
}

export const multiFactorInternals = {
  decodeBase32,
  encodeBase32,
  totpAtCounter,
}
