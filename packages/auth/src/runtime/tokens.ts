import type { PersonalAccessTokenRecord } from '../contracts'

export function normalizeTokenRecord(record: PersonalAccessTokenRecord): PersonalAccessTokenRecord {
  return Object.freeze({
    ...record,
    abilities: Object.freeze([...record.abilities]),
    createdAt: new Date(record.createdAt.getTime()),
    lastUsedAt: record.lastUsedAt ? new Date(record.lastUsedAt.getTime()) : undefined,
    expiresAt: record.expiresAt ? new Date(record.expiresAt.getTime()) : record.expiresAt,
  })
}

export function isTokenExpired(record: PersonalAccessTokenRecord): boolean {
  return record.expiresAt instanceof Date && record.expiresAt.getTime() <= Date.now()
}

export function parsePlainTextToken(token: string): { id: string, secret: string } | null {
  const separatorIndex = token.indexOf('.')
  if (separatorIndex <= 0) return null
  const id = token.slice(0, separatorIndex).trim()
  const secret = token.slice(separatorIndex + 1).trim()
  return id && secret ? { id, secret } : null
}

function tokenAbilityMatches(grantedAbility: string, requestedAbility: string): boolean {
  const granted = grantedAbility.trim()
  const requested = requestedAbility.trim()
  if (!granted || !requested) return false
  if (granted === '*') return true
  if (granted.endsWith('.*')) {
    const prefix = granted.slice(0, -1)
    return requested.startsWith(prefix) && requested.length > prefix.length
  }
  return granted === requested
}

export function tokenHasAbility(record: PersonalAccessTokenRecord, ability: string): boolean {
  return record.abilities.some(grantedAbility => tokenAbilityMatches(grantedAbility, ability))
}
