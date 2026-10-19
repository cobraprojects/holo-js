import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export type RememberRecaller = readonly [userId: string | number, token: string, passwordHashDigest: string, expiresAt: number]

export function createRememberToken(): string {
  return randomBytes(45).toString('base64url')
}

export function hashPasswordForRemember(passwordHash: string | null | undefined): string {
  return createHash('sha256').update(passwordHash ?? '').digest('hex')
}

export function rememberSecretsMatch(expected: string, actual: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(expected).digest(),
    createHash('sha256').update(actual).digest(),
  )
}

function isRememberRecaller(value: unknown): value is RememberRecaller {
  return Array.isArray(value)
    && value.length === 4
    && ((typeof value[0] === 'string' && value[0].length > 0) || (typeof value[0] === 'number' && Number.isSafeInteger(value[0])))
    && typeof value[1] === 'string'
    && value[1].length > 0
    && typeof value[2] === 'string'
    && value[2].length > 0
    && typeof value[3] === 'number'
    && Number.isSafeInteger(value[3])
    && value[3] > 0
}

export function encodeRememberRecaller(recaller: RememberRecaller): string {
  return JSON.stringify(recaller)
}

export function decodeRememberRecaller(value: string): RememberRecaller | null {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRememberRecaller(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function parseRememberCookie(value: string | undefined): Map<string, string> {
  const entries = new Map<string, string>()
  if (!value) return entries
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return entries
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return entries
  for (const [guard, recaller] of Object.entries(parsed)) {
    if (isRememberRecaller(recaller)) entries.set(guard, encodeRememberRecaller(recaller))
  }
  return entries
}

export function serializeRememberCookie(entries: ReadonlyMap<string, string>): string | undefined {
  const recallers = [...entries]
    .map(([guard, encoded]) => [guard, decodeRememberRecaller(encoded)] as const)
    .filter((entry): entry is readonly [string, RememberRecaller] => entry[1] !== null)
  return recallers.length > 0 ? JSON.stringify(Object.fromEntries(recallers)) : undefined
}
