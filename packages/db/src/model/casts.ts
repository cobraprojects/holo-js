import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { EnumCastDefinition } from './types'

export function enumCast<TEnum extends Record<string, string | number>>(
  enumObject: TEnum,
): EnumCastDefinition {
  const values = Object.entries(enumObject)
    .filter(([key]) => !/^\d+$/.test(key))
    .map(([, value]) => value)
    .filter((value, index, items) => items.indexOf(value) === index)

  return Object.freeze({
    kind: 'enum',
    enumObject: Object.freeze({ ...enumObject }),
    values: Object.freeze(values),
  })
}

export function binaryCast() {
  return Object.freeze({
    get(value: unknown): Uint8Array | null | undefined {
      if (value == null) {
        return value as null | undefined
      }

      if (value instanceof Uint8Array) {
        return value
      }

      if (typeof value === 'string') {
        return Uint8Array.from(Buffer.from(value, 'base64'))
      }

      return Uint8Array.from(Buffer.from(String(value)))
    },
    set(value: unknown): Uint8Array | null | undefined {
      if (value == null) {
        return value as null | undefined
      }

      if (value instanceof Uint8Array) {
        return value
      }

      if (typeof value === 'string') {
        return Uint8Array.from(Buffer.from(value))
      }

      return Uint8Array.from(Buffer.from(String(value)))
    },
  })
}

export function encryptedCast(secret: string) {
  const key = createHash('sha256').update(secret).digest()

  return Object.freeze({
    get(value: unknown): unknown {
      if (value == null) {
        return value
      }

      if (typeof value !== 'string' || !value.startsWith('enc:')) {
        throw new Error('Encrypted cast expected an encrypted string payload.')
      }

      const [ivBase64, tagBase64, payloadBase64] = value.slice(4).split('.')
      if (!ivBase64 || !tagBase64 || !payloadBase64) {
        throw new Error('Encrypted cast received a malformed payload.')
      }

      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivBase64, 'base64url'))
      decipher.setAuthTag(Buffer.from(tagBase64, 'base64url'))
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(payloadBase64, 'base64url')),
        decipher.final(),
      ]).toString('utf8')

      const envelope = JSON.parse(decrypted) as { type: 'json' | 'string', value: unknown }
      return envelope.type === 'json' ? envelope.value : String(envelope.value)
    },
    set(value: unknown): string | null | undefined {
      if (value == null) {
        return value as null | undefined
      }

      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const envelope = typeof value === 'string'
        ? { type: 'string' as const, value }
        : { type: 'json' as const, value }
      const serialized = JSON.stringify(envelope)
      const payload = Buffer.concat([
        cipher.update(serialized, 'utf8'),
        cipher.final(),
      ])
      const tag = cipher.getAuthTag()

      return `enc:${iv.toString('base64url')}.${tag.toString('base64url')}.${payload.toString('base64url')}`
    },
  })
}
