import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { AuthPasswordHasher } from '../contracts'
import { createScryptPasswordHasher } from './scryptPasswordHasher'

const TOKEN_HASH_PREFIX = 'sha256'

export function createDefaultPasswordHasher(): AuthPasswordHasher {
  return createScryptPasswordHasher()
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
