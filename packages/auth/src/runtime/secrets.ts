import { createHash, randomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { AuthPasswordHasher } from '../contracts'

const scrypt = promisify(nodeScrypt)
const SCRYPT_PREFIX = 'scrypt'
const TOKEN_HASH_PREFIX = 'sha256'

export function createDefaultPasswordHasher(): AuthPasswordHasher {
  return {
    async hash(password: string): Promise<string> {
      const salt = randomBytes(16)
      const derived = await scrypt(password, salt, 64) as Buffer
      return `${SCRYPT_PREFIX}$${salt.toString('hex')}$${derived.toString('hex')}`
    },
    async verify(password: string, digest: string): Promise<boolean> {
      const [prefix, saltHex, hashHex] = digest.split('$')
      if (prefix !== SCRYPT_PREFIX || !saltHex || !hashHex) {
        return false
      }

      const salt = Buffer.from(saltHex, 'hex')
      const expected = Buffer.from(hashHex, 'hex')
      const derived = await scrypt(password, salt, expected.length) as Buffer
      return derived.length === expected.length && timingSafeEqual(derived, expected)
    },
    needsRehash() {
      return false
    },
  }
}

export async function resolveNeedsPasswordRehash(
  hasher: AuthPasswordHasher,
  digest: string,
): Promise<boolean> {
  if (!hasher.needsRehash) {
    return false
  }

  return await hasher.needsRehash(digest)
}

export function hashTokenSecret(secret: string): string {
  return `${TOKEN_HASH_PREFIX}$${createHash('sha256').update(secret).digest('hex')}`
}

export function verifyTokenSecret(secret: string, digest: string): boolean {
  const [prefix, hashHex] = digest.split('$')
  if (prefix !== TOKEN_HASH_PREFIX || !hashHex) {
    return false
  }

  const expected = Buffer.from(hashHex, 'hex')
  const actual = createHash('sha256').update(secret).digest()
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function createPersonalAccessTokenId(): string {
  return randomUUID()
}

export function createPersonalAccessTokenSecret(): string {
  return randomBytes(24).toString('base64url')
}
