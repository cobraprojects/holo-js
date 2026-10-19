import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

const IV_BYTES = 12
const TAG_BYTES = 16

function cookieEncryptionKey(appKey: string | undefined): Buffer {
  const key = appKey?.trim()
  if (!key) {
    throw new Error('[@holo-js/kernel] Holo cookies are encrypted with the application key. Set APP_KEY or run "holo key:generate".')
  }

  return createHmac('sha256', key).update('holo-js:cookie-encryption').digest()
}

export function encryptCookieValue(name: string, value: string, appKey: string | undefined): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', cookieEncryptionKey(appKey), iv)
  cipher.setAAD(Buffer.from(name, 'utf8'))
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url')
}

export function decryptCookieValue(name: string, value: string, appKey: string | undefined): string | undefined {
  const key = cookieEncryptionKey(appKey)
  const payload = Buffer.from(value, 'base64url')
  if (payload.length < IV_BYTES + TAG_BYTES) return undefined

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, IV_BYTES))
    decipher.setAAD(Buffer.from(name, 'utf8'))
    decipher.setAuthTag(payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
    return Buffer.concat([decipher.update(payload.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}
