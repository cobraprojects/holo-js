import type * as AuthFeature from '@holo-js/auth'
import { column, normalizeDialectWriteValue } from '@holo-js/db'

const authTimestampColumn = column.timestamp().toDefinition({ name: 'timestamp' })

export function serializeAuthTimestamp(value: Date, driver: string): string {
  return driver === 'mysql'
    ? String(normalizeDialectWriteValue('mysql', authTimestampColumn, value.toISOString()))
    : value.toISOString()
}

export function normalizeDateValue(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value))
}

export function normalizeJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

export function normalizeStoredUserId(value: unknown): string | number {
  return typeof value === 'number' ? value : String(value)
}

export type AccessTokenRecord = AuthFeature.PersonalAccessTokenRecord

export function normalizeAccessTokenRecord(row: Record<string, unknown>): AccessTokenRecord {
  const abilities = normalizeJsonValue(row.abilities)
  return Object.freeze({
    id: String(row.id),
    provider: String(row.provider),
    userId: normalizeStoredUserId(row.user_id),
    name: String(row.name),
    abilities: Array.isArray(abilities) ? Object.freeze([...abilities]) as readonly string[] : Object.freeze([]),
    tokenHash: String(row.token_hash),
    createdAt: normalizeDateValue(row.created_at),
    lastUsedAt: row.last_used_at ? normalizeDateValue(row.last_used_at) : undefined,
    expiresAt: row.expires_at ? normalizeDateValue(row.expires_at) : null,
  })
}

export function serializeAccessTokenRecord(record: AccessTokenRecord, driver = 'sqlite'): Record<string, unknown> {
  return {
    id: record.id,
    provider: record.provider,
    user_id: String(record.userId),
    name: record.name,
    abilities: JSON.stringify(record.abilities),
    token_hash: record.tokenHash,
    created_at: serializeAuthTimestamp(record.createdAt, driver),
    last_used_at: record.lastUsedAt ? serializeAuthTimestamp(record.lastUsedAt, driver) : null,
    expires_at: record.expiresAt ? serializeAuthTimestamp(record.expiresAt, driver) : null,
    updated_at: serializeAuthTimestamp(new Date(), driver),
  }
}

export type EmailVerificationTokenRecord = AuthFeature.EmailVerificationTokenRecord

export function normalizeEmailVerificationTokenRecord(row: Record<string, unknown>): EmailVerificationTokenRecord {
  return Object.freeze({
    id: String(row.id),
    provider: String(row.provider),
    userId: normalizeStoredUserId(row.user_id),
    email: String(row.email),
    tokenHash: String(row.token_hash),
    createdAt: normalizeDateValue(row.created_at),
    expiresAt: normalizeDateValue(row.expires_at),
  })
}

export function serializeEmailVerificationTokenRecord(record: EmailVerificationTokenRecord, driver = 'sqlite'): Record<string, unknown> {
  return {
    id: record.id,
    provider: record.provider,
    user_id: String(record.userId),
    email: record.email,
    token_hash: record.tokenHash,
    created_at: serializeAuthTimestamp(record.createdAt, driver),
    expires_at: serializeAuthTimestamp(record.expiresAt, driver),
    used_at: null,
    updated_at: serializeAuthTimestamp(new Date(), driver),
  }
}

export type PasswordResetTokenRecord = AuthFeature.PasswordResetTokenRecord

export function normalizePasswordResetTokenRecord(row: Record<string, unknown>): PasswordResetTokenRecord {
  return Object.freeze({
    id: String(row.id),
    provider: typeof row.provider === 'string' ? row.provider : 'users',
    email: String(row.email),
    table: typeof row.__holo_table === 'string' ? row.__holo_table : undefined,
    tokenHash: String(row.token_hash),
    createdAt: normalizeDateValue(row.created_at),
    expiresAt: normalizeDateValue(row.expires_at),
  })
}

export function serializePasswordResetTokenRecord(record: PasswordResetTokenRecord, driver = 'sqlite'): Record<string, unknown> {
  return {
    id: record.id,
    provider: record.provider,
    email: record.email,
    token_hash: record.tokenHash,
    created_at: serializeAuthTimestamp(record.createdAt, driver),
    expires_at: serializeAuthTimestamp(record.expiresAt, driver),
    used_at: null,
    updated_at: serializeAuthTimestamp(new Date(), driver),
  }
}

export type MultiFactorCredentialRecord = AuthFeature.AuthMultiFactorCredentialRecord

export function normalizeMultiFactorCredentialRecord(row: Record<string, unknown>): MultiFactorCredentialRecord {
  const recoveryCodeHashes = normalizeJsonValue(row.recovery_code_hashes)
  return Object.freeze({
    provider: String(row.provider),
    userId: normalizeStoredUserId(row.user_id),
    encryptedSecret: String(row.encrypted_secret),
    recoveryCodeHashes: Array.isArray(recoveryCodeHashes)
      ? Object.freeze(recoveryCodeHashes.filter((value): value is string => typeof value === 'string'))
      : Object.freeze([]),
    lastUsedCounter: row.last_used_counter === null || typeof row.last_used_counter === 'undefined'
      ? null
      : Number(row.last_used_counter),
    enabledAt: normalizeDateValue(row.enabled_at),
    updatedAt: normalizeDateValue(row.updated_at),
  })
}

export function serializeMultiFactorCredentialRecord(record: MultiFactorCredentialRecord, driver = 'sqlite'): Record<string, unknown> {
  return {
    provider: record.provider,
    user_id: String(record.userId),
    encrypted_secret: record.encryptedSecret,
    recovery_code_hashes: JSON.stringify(record.recoveryCodeHashes),
    last_used_counter: record.lastUsedCounter,
    enabled_at: serializeAuthTimestamp(record.enabledAt, driver),
    updated_at: serializeAuthTimestamp(record.updatedAt, driver),
  }
}
